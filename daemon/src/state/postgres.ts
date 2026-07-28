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
import * as crypto from "node:crypto";
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

/**
 * Don't hammer an unreachable database on every keystroke-debounced save.
 *
 * Doubling, not the flat 10s DRY-28 shipped (DRY-58). The flat window bounded a
 * partition to one 5s connect timeout per 10s, which is the right shape for a
 * blip and the wrong one for an outage measured in hours — 360 pointless dials
 * an hour, each holding a pool slot for five seconds. The floor stays at 10s so
 * this is never MORE eager than what it replaces, and the ceiling stays low
 * enough that a database coming back is noticed within half a minute: the
 * shell's own recovery loop is waiting on exactly this to reopen.
 */
const RETRY_COOLDOWN_MS = [10_000, 20_000, 30_000];

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
  /** Consecutive failures, indexing RETRY_COOLDOWN_MS. Reset by any success. */
  private failures = 0;
  /** Why we last failed, so `health()` can answer without dialling. */
  private lastError = "";

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
   * How long the current cooldown still has to run, 0 when a probe is due (or
   * the store isn't known to be down). Read by `guard` to fast-fail and by
   * `health` to report without dialling — one source, so the two can't disagree
   * about whether the database is being given a rest.
   */
  private cooldownRemaining(): number {
    if (!this.downSince) return 0;
    const window = RETRY_COOLDOWN_MS[Math.min(this.failures - 1, RETRY_COOLDOWN_MS.length - 1)];
    return Math.max(0, this.downSince + window - Date.now());
  }

  /**
   * Run a store operation, fast-failing while the database is known to be
   * down. The cooldown doesn't make an outage cheap, it makes it BOUNDED: one
   * request per window pays the connect timeout and the rest return
   * immediately, instead of every request paying it.
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.cooldownRemaining() > 0) {
      throw new Error("postgres unavailable (retrying shortly)");
    }
    try {
      await this.ensureReady();
      const result = await fn();
      this.downSince = 0;
      this.failures = 0;
      return result;
    } catch (err) {
      this.downSince = Date.now();
      this.failures += 1;
      this.lastError = (err as Error).message;
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
        // Added separately rather than in the create above, because the ledger
        // predates it: a database migrated by an older Drydock already has the
        // table, so `create table if not exists` would silently leave it without
        // the column and every checksum read would come back undefined.
        await client.query(
          "alter table drydock_schema_migrations add column if not exists checksum text",
        );
        const applied = new Map(
          (
            await client.query<{ name: string; checksum: string | null }>(
              "select name, checksum from drydock_schema_migrations",
            )
          ).rows.map((r) => [r.name, r.checksum] as const),
        );
        const files = fs
          .readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith(".sql"))
          .sort(); // lexical order IS the migration order — hence the 001_ prefix
        for (const file of files) {
          const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
          const checksum = crypto.createHash("sha256").update(sql).digest("hex");
          if (applied.has(file)) {
            await this.checkDrift(client, file, checksum, applied.get(file) ?? null);
            continue;
          }
          // Each migration lands whole or not at all, so a failure halfway
          // through leaves nothing half-created for the next attempt to trip on.
          await client.query("begin");
          try {
            await client.query(sql);
            await client.query(
              "insert into drydock_schema_migrations (name, checksum) values ($1, $2)",
              [file, checksum],
            );
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

  /**
   * Has an already-applied migration changed on disk since it ran? (DRY-58)
   *
   * Recording filenames alone made this invisible, and CLAUDE.md actively
   * encourages the setup where it bites: dev on :4317, prod on :4318 and a
   * throwaway verification instance can all point at one database. Edit an
   * applied `001_workspace.sql` and every one of them skips it — the schema
   * each daemon *believes* it has and the schema that's actually there diverge
   * silently, and the symptom surfaces later as a query against a column that
   * was never added.
   *
   * A null checksum is a row from before this existed. Its original bytes are
   * unknowable, so adopting the current file is the only non-fabricating
   * option; drift is caught from the next run on. Said out loud because it
   * means the FIRST run after upgrading can't detect an edit made before it.
   *
   * The hash is over raw file bytes, so reformatting an applied migration trips
   * this too. That's the intent, not a rough edge: the ledger's claim is "these
   * exact bytes ran here", and a daemon can't tell a whitespace change from a
   * semantic one without parsing SQL it has no business parsing.
   */
  private async checkDrift(
    client: pg.PoolClient,
    file: string,
    checksum: string,
    stored: string | null,
  ): Promise<void> {
    if (stored === checksum) return;
    if (stored === null) {
      await client.query("update drydock_schema_migrations set checksum = $2 where name = $1", [
        file,
        checksum,
      ]);
      log.info("adopted checksum for a migration applied before checksums existed", { file });
      return;
    }
    // Thrown, not logged-and-continued: the two schemas are already different
    // and every further write is guesswork. It travels the ordinary store
    // failure path (guard → 503 → the shell keeps its mirror), so a drifted
    // migration costs the workspace store and never a live PTY. Unlike an
    // outage it won't heal on its own — which is correct. This is an error
    // about the repo, not a condition of the network.
    throw new Error(
      `migration ${file} changed after it was applied (ledger ${stored.slice(0, 12)}, ` +
        `file ${checksum.slice(0, 12)}). An applied migration is history: add a new ` +
        `numbered file instead of editing this one.`,
    );
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

  /**
   * Cheap liveness probe, and cheap is the operative word (DRY-58).
   *
   * It used to go through `guard()` like any other operation, which made it
   * honest about availability and dishonest as a health signal: inside the
   * cooldown `guard` throws without dialling, so `/healthz` reported `ok:false`
   * on the strength of something that happened up to a window ago. A monitor
   * couldn't tell a dead database from one nobody had asked about recently.
   *
   * Now the cooldown is reported as itself. Outside it, this probes for real —
   * and pays the connect timeout for real, which is why the answer is worth
   * something. Still never rejects: a store failure is not a daemon failure.
   */
  async health(): Promise<StoreHealth> {
    const retryInMs = this.cooldownRemaining();
    if (retryInMs > 0) {
      return { kind: this.kind, ok: false, error: this.lastError, cooling: true, retryInMs };
    }
    try {
      await this.guard(() => this.pool.query("select 1"));
      return { kind: this.kind, ok: true };
    } catch (err) {
      return { kind: this.kind, ok: false, error: (err as Error).message };
    }
  }
}
