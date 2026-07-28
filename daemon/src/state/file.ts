// Zero-infra workspace store: one JSON file on disk (DRY-28).
//
// This is what runs when DRYDOCK_DATABASE_URL is unset, and it is the DEFAULT —
// `bun run daemon` on a fresh clone must work with nothing else installed, and
// the isolated work-laptop profile (DRY-25) shouldn't have to bring a database
// along to remember where you left your windows.
//
// Why a JSON file and not SQLite: SQLite means another native module built by
// node-gyp, and this repo already pays that tax once for node-pty — including
// the rule that it must be Node's node-gyp, never Bun's (CLAUDE.md). A second
// native dependency doubles the ways a fresh install can fail to boot, to store
// one small blob per owner written by a single process. A file with an atomic
// replace is the entire requirement.
import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "../repos.js";
import { log } from "../log.js";
import type { StateStore, StoreHealth, WorkspaceState, WorkspaceWrite } from "./types.js";

/** On-disk shape. Nested by owner so a human opening the file can read it. */
interface FileShape {
  version: number;
  owners: Record<string, Record<string, WorkspaceState>>;
}

const FILE_VERSION = 1;

export class FileStore implements StateStore {
  readonly kind = "file" as const;
  /**
   * No `history` property, and its ABSENCE is the feature (DRY-56).
   *
   * Session history is retained, growing, queryable state — the one access
   * pattern a whole-file read-modify-write genuinely serves badly rather than
   * merely differently, and the line Drydock's two tiers are drawn on. It could
   * be bolted on here; it shouldn't be, because a half-working version is worse
   * than an honest absence. A missing tombstone has to read as "this tier
   * doesn't record sessions", never as "your session was lost" — which is the
   * confusion `001_workspace.sql` was already written to pre-empt.
   *
   * Leaving the property off rather than stubbing it means callers write
   * `store.history?.…` and the compiler enforces the check, so no code path can
   * quietly assume a record that was never kept. `/healthz` reports the
   * capability and the shell says so where the tombstone would be.
   */
  private readonly path: string;
  /**
   * Writes are serialized through this chain. Every save is
   * read-modify-write on the whole file, so two overlapping saves (two browsers,
   * or a save racing a clear) would each read the pre-state and the loser's
   * change would vanish. Chaining costs nothing at this write rate.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.path = expandHome(file);
  }

  /** A fresh, prototype-free document. See `plain()` for why. */
  private empty(): FileShape {
    return { version: FILE_VERSION, owners: Object.create(null) };
  }

  /**
   * Re-key a parsed object onto a null prototype.
   *
   * `?name=` reaches these maps as a key, and on an ordinary object a lookup of
   * `__proto__` / `constructor` / `toString` hits Object.prototype instead of
   * missing. That produced two real faults, both silent: reading
   * `?name=constructor` returned a phantom "workspace", and writing
   * `?name=__proto__` reported 200 while storing nothing (assigning
   * `__proto__` sets the prototype rather than creating an own property, so
   * JSON.stringify dropped it). The route now rejects such names outright —
   * this is the second line, so the store is not one careless caller away from
   * the same behaviour.
   */
  private plain<T>(obj: Record<string, T>): Record<string, T> {
    return Object.assign(Object.create(null), obj);
  }

  /**
   * Is this a document we can work with?
   *
   * The null and array cases are explicit because `typeof` reports "object"
   * for both, and letting `owners: null` through did not fail loudly — it
   * wedged every subsequent read AND write with a TypeError, permanently,
   * while health() went on reporting the store green. Shared with health() so
   * the check that decides "this file gets replaced" is the same one that
   * decides "say so out loud".
   */
  private static isValidShape(data: unknown): data is FileShape {
    const d = data as FileShape | null;
    return !!(
      d &&
      d.version === FILE_VERSION &&
      d.owners &&
      typeof d.owners === "object" &&
      !Array.isArray(d.owners)
    );
  }

  private read(): FileShape {
    try {
      const raw = fs.readFileSync(this.path, "utf8");
      const data = JSON.parse(raw) as FileShape;
      // An unreadable/foreign shape is discarded rather than migrated — same
      // rule the shell applies to a stale layout blob. Losing a window
      // arrangement is a nuisance; refusing to boot over one is not.
      if (!FileStore.isValidShape(data)) {
        log.warn("state file has an unknown shape — starting fresh", { file: this.path });
        return this.empty();
      }
      const owners = Object.create(null) as FileShape["owners"];
      for (const [owner, spaces] of Object.entries(data.owners)) {
        if (spaces && typeof spaces === "object" && !Array.isArray(spaces)) {
          owners[owner] = this.plain(spaces);
        }
      }
      return { version: FILE_VERSION, owners };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn("state file unreadable — starting fresh", { file: this.path, err: e.message });
      }
      return this.empty();
    }
  }

  /**
   * Replace the file atomically: a torn write here is a workspace that can't be
   * parsed on next boot. Same-directory temp + rename keeps it on one
   * filesystem, which is what makes the rename atomic.
   */
  private write(data: FileShape): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, this.path);
  }

  /** Run `fn` after every previously queued mutation, whatever their outcome. */
  private enqueue<T>(fn: () => T): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Swallow on the CHAIN only: the returned promise still rejects to the
    // caller, but an unhandled rejection here would be logged against the
    // daemon (and with DRY-45's handler, against every session's log line).
    this.queue = next.catch(() => {});
    return next;
  }

  async load(owner: string, name: string): Promise<WorkspaceState | null> {
    return this.enqueue(() => this.read().owners[owner]?.[name] ?? null);
  }

  async save(owner: string, name: string, state: WorkspaceWrite): Promise<WorkspaceState> {
    return this.enqueue(() => {
      const data = this.read();
      const saved: WorkspaceState = { ...state, updatedAt: Date.now() };
      (data.owners[owner] ??= Object.create(null))[name] = saved;
      this.write(data);
      return saved;
    });
  }

  async clear(owner: string, name: string): Promise<void> {
    return this.enqueue(() => {
      const data = this.read();
      const forOwner = data.owners[owner];
      if (!forOwner || !(name in forOwner)) return;
      delete forOwner[name];
      if (Object.keys(forOwner).length === 0) delete data.owners[owner];
      this.write(data);
    });
  }

  /**
   * Answer about the file we'd actually use, not a proxy for it.
   *
   * Checking only that the DIRECTORY was writable was worse than checking
   * nothing: a state file that wedged every load and save still reported
   * `ok: true`, so the one signal meant to make degradation visible was the
   * thing hiding it. Reading a few KB is not a cost worth being wrong over.
   */
  async health(): Promise<StoreHealth> {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.accessSync(path.dirname(this.path), fs.constants.W_OK);
      // No file until the first save — a healthy empty store, not a fault.
      if (fs.existsSync(this.path)) {
        fs.accessSync(this.path, fs.constants.R_OK | fs.constants.W_OK);
        if (!FileStore.isValidShape(JSON.parse(fs.readFileSync(this.path, "utf8")))) {
          // Recoverable (the next save replaces it) but not silent: this is
          // someone's saved desk about to be discarded.
          return {
            kind: this.kind,
            ok: false,
            error: "state file has an unreadable shape; it will be replaced on the next save",
          };
        }
      }
      return { kind: this.kind, ok: true };
    } catch (err) {
      return { kind: this.kind, ok: false, error: (err as Error).message };
    }
  }
}
