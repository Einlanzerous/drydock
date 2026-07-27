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
  /**
   * When we last saw a failure, 0 while we believe the store is healthy.
   *
   * This tracks EVERY operation, not just migration, and that distinction is
   * the whole point. Keying the cooldown off "have we migrated yet" made it
   * dead code the moment the first migration succeeded: `ready` stayed
   * resolved forever, so a database that died later was re-dialled on every
   * single request. Measured against a partitioned (not refusing) database,
   * that is `connectionTimeoutMillis` — 5s — per request, indefinitely, and
   * the shell's restore blocks on one of them before it can draw the desktop.
   * A refused connection hides this: ECONNREFUSED returns instantly, which is
   * why `docker stop` looks fine and a network partition does not.
   */
  private downSince = 0;

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
   * Connect + migrate, once. A failure clears the cached attempt so the next
   * caller past the cooldown retries — a database that comes up later heals
   * without a daemon restart, which matters because a restart costs every
   * live session.
   */
  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const attempt = this.migrate().catch((err) => {
      this.ready = null;
      throw err;
    });
    this.ready = attempt;
    return attempt;
  }

  /**
   * Run a store operation, fast-failing while the database is known to be
   * down. The cooldown doesn't make an outage cheap, it makes it BOUNDED: one
   * request per 10s window pays the connect timeout and the rest return
   * immediately, instead of every request paying it.
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.downSince && Date.now() - this.downSince < RETRY_COOLDOWN_MS) {
      throw new Error("postgres unavailable (retrying shortly)");
    }
    try {
      await this.ensureReady();
      const result = await fn();
      this.downSince = 0;
      return result;
    } catch (err) {
      this.downSince = Date.now();
      throw err;
    }
  }

  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Lock FIRST, before any DDL. `create table if not exists` is not itself
      // concurrency-safe in Postgres — two sessions running it at once can
      // collide in the catalog and raise "duplicate key value violates unique
      // constraint pg_type_typname_nsp_index" or a bare "relation already
      // exists". Creating the ledger before taking the lock left the bootstrap
      // exposed to exactly the race the lock exists to prevent, which is the
      // realistic startup shape: `bun run up` and a prod daemon coming back at
      // the same time, both pointed at one database.
      //
      // Session-level (not xact) so the lock spans the per-file transactions
      // below; released in `finally`, and by the connection closing if not.
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
      try {
        await client.query(`
          create table if not exists drydock_schema_migrations (
            name       text primary key,
            applied_at timestamptz not null default now()
          )
        `);
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
}
