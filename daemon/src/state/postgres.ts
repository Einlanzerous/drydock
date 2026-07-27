// Postgres workspace store (DRY-28), used when DRYDOCK_DATABASE_URL is set.
//
// The URL is the ONLY difference between "central Postgres on my server" and "a
// container on this laptop" — there is deliberately no second code path for the
// two, because a mode that only gets exercised in one deployment is a mode that
// breaks in the other.
//
// Posture, in the spirit of DRY-45: a database this daemon can't reach must
// never cost anyone a PTY. Nothing here runs at boot — the first request
// connects and migrates — and every failure surfaces as a rejected promise the
// routes turn into a 503, leaving the shell on its local cache. A daemon with a
// dead database still spawns agents, still attaches, still replays scrollback.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { log } from "../log.js";
import type { StateStore, StoreHealth, WorkspaceState, WorkspaceWrite } from "./types.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Key for the advisory lock held while migrating. Dev (:4317), prod (:4318) and
 * a throwaway verification instance can all point at one database, and they
 * start at whatever moment you restart them — concurrent `create table` from
 * two of them is a real race, not a theoretical one. Arbitrary constant; it only
 * has to be the same in every Drydock.
 */
const MIGRATION_LOCK = 0x11ff_28;

/** Don't hammer an unreachable database on every keystroke-debounced save. */
const RETRY_COOLDOWN_MS = 10_000;

export class PostgresStore implements StateStore {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;
  private lastFailureAt = 0;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      // Fail a request rather than hanging a browser save forever on a database
      // that's up but not listening (wrong host, dropped packets).
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // Load-bearing, not decoration — this is DRY-45's bug class exactly. An
    // idle pooled client that dies (database restarted, network dropped)
    // makes the Pool emit 'error', and in Node an 'error' event with no
    // listener THROWS. Without this line, restarting the Postgres container
    // would take down the daemon and every live agent PTY with it.
    this.pool.on("error", (err) => {
      log.warn("postgres pool error — dropping that client", { err: err.message });
    });
  }

  /**
   * Connect + migrate, once. A failure is remembered rather than cached
   * forever: the next call after the cooldown retries, so a database that comes
   * up later heals without a daemon restart (which would cost every session).
   */
  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const attempt = this.migrate().catch((err) => {
      this.lastFailureAt = Date.now();
      // Let the next caller past the cooldown try again.
      this.ready = null;
      throw err;
    });
    this.ready = attempt;
    return attempt;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.ready && Date.now() - this.lastFailureAt < RETRY_COOLDOWN_MS) {
      throw new Error("postgres unavailable (retrying shortly)");
    }
    await this.ensureReady();
    return fn();
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        create table if not exists drydock_schema_migrations (
          name       text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      // Serialize against other daemons pointed at this database. Session-level
      // (not xact) so it spans the per-file transactions below; released in
      // `finally` and, failing that, by the connection closing.
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      try {
        const applied = new Set(
          (await client.query<{ name: string }>("select name from drydock_schema_migrations")).rows.map(
            (r) => r.name,
          ),
        );
        const files = fs
          .readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith(".sql"))
          .sort(); // lexical order IS the migration order — hence the 001_ prefix
        for (const file of files) {
          if (applied.has(file)) continue;
          const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
          // Each migration lands whole or not at all, so a failure halfway
          // through leaves nothing half-created for the next attempt to trip on.
          await client.query("begin");
          try {
            await client.query(sql);
            await client.query("insert into drydock_schema_migrations (name) values ($1)", [file]);
            await client.query("commit");
            log.info("applied state migration", { file });
          } catch (err) {
            await client.query("rollback").catch(() => {});
            throw err;
          }
        }
      } finally {
        await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  async load(owner: string, name: string): Promise<WorkspaceState | null> {
    return this.guard(async () => {
      const { rows } = await this.pool.query<{
        version: number;
        layout: string;
        windows: unknown[];
        updated_at: Date;
      }>(
        "select version, layout, windows, updated_at from workspaces where owner_id = $1 and name = $2",
        [owner, name],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        version: row.version,
        layout: row.layout,
        windows: row.windows,
        updatedAt: row.updated_at.getTime(),
      };
    });
  }

  async save(owner: string, name: string, state: WorkspaceWrite): Promise<WorkspaceState> {
    return this.guard(async () => {
      const { rows } = await this.pool.query<{ updated_at: Date }>(
        `insert into workspaces (owner_id, name, version, layout, windows)
              values ($1, $2, $3, $4, $5::jsonb)
         on conflict (owner_id, name) do update
                set version    = excluded.version,
                    layout     = excluded.layout,
                    windows    = excluded.windows,
                    updated_at = now()
           returning updated_at`,
        [
          owner,
          name,
          state.version,
          state.layout,
          // JSON.stringify is REQUIRED, not stylistic: node-postgres serializes a
          // JS array as a Postgres ARRAY literal ({a,b}), which a jsonb column
          // rejects. Passing the text and casting ($5::jsonb) is the reliable form.
          JSON.stringify(state.windows),
        ],
      );
      return { ...state, updatedAt: rows[0].updated_at.getTime() };
    });
  }

  async clear(owner: string, name: string): Promise<void> {
    await this.guard(async () => {
      await this.pool.query("delete from workspaces where owner_id = $1 and name = $2", [
        owner,
        name,
      ]);
    });
  }

  async health(): Promise<StoreHealth> {
    try {
      await this.guard(() => this.pool.query("select 1"));
      return { kind: this.kind, ok: true };
    } catch (err) {
      return { kind: this.kind, ok: false, error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
