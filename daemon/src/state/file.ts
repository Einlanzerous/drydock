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

  private read(): FileShape {
    try {
      const raw = fs.readFileSync(this.path, "utf8");
      const data = JSON.parse(raw) as FileShape;
      // An unreadable/foreign shape is discarded rather than migrated — same
      // rule the shell applies to a stale layout blob. Losing a window
      // arrangement is a nuisance; refusing to boot over one is not.
      if (!data || data.version !== FILE_VERSION || typeof data.owners !== "object") {
        log.warn("state file has an unknown shape — starting fresh", { file: this.path });
        return { version: FILE_VERSION, owners: {} };
      }
      return data;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        log.warn("state file unreadable — starting fresh", { file: this.path, err: e.message });
      }
      return { version: FILE_VERSION, owners: {} };
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
      (data.owners[owner] ??= {})[name] = saved;
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

  async health(): Promise<StoreHealth> {
    // The file legitimately doesn't exist until the first save, so "can I write
    // where it would go" is the real question — an unwritable directory is the
    // failure worth reporting (read-only $HOME, wrong owner after a sudo run).
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.accessSync(path.dirname(this.path), fs.constants.W_OK);
      return { kind: this.kind, ok: true };
    } catch (err) {
      return { kind: this.kind, ok: false, error: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    // Let a save that's mid-flight finish rather than leaving a .tmp behind.
    await this.queue.catch(() => {});
  }
}
