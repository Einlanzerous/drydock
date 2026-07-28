// Persisted workspace state (DRY-28).
//
// The desktop arrangement used to live in the browser's localStorage (DRY-14),
// which made it per-*browser* rather than per-person: the same human on a
// laptop and a desktop got two unrelated workspaces, and clearing site data
// lost the lot. The daemon already owns everything else durable about a
// session, so it owns this too — and because it does, the state follows you to
// whatever browser you point at that daemon.

export type StoreKind = "file" | "postgres";

/** A saved desktop arrangement, as handed back to a client on restore. */
export interface WorkspaceState {
  /**
   * The SHELL's schema version (layoutStore.LAYOUT_VERSION). Stored, never
   * interpreted: the daemon can't know which shapes this build of the UI can
   * read, so the shell keeps the discard-on-mismatch rule it already had.
   */
  version: number;
  /** Layout mode ("float" | "tile" | "focus") — again opaque, see `windows`. */
  layout: string;
  /**
   * The window array, verbatim from the shell. Deliberately `unknown[]`: `Win`
   * is UI model (geometry, z-order, drawer state, split ratios) that grows a
   * field or two per desktop feature. Mirroring it here would mean a daemon
   * change for every one of those, plus a second copy of the type to keep in
   * sync by hand — the protocol.ts tax, paid on a payload the daemon only ever
   * hands back unread. Validation is therefore structural (see MAX bytes in
   * config) rather than semantic.
   */
  windows: unknown[];
  /** Server clock at write, ms since epoch. */
  updatedAt: number;
}

/** What a client PUTs — same thing minus the server-assigned timestamp. */
export type WorkspaceWrite = Omit<WorkspaceState, "updatedAt">;

export interface StoreHealth {
  kind: StoreKind;
  /** False means reads/writes are currently failing — see `error`. */
  ok: boolean;
  error?: string;
  /**
   * The verdict above is CACHED, not measured: the store is inside its retry
   * cooldown and deliberately didn't dial (DRY-58). Worth distinguishing
   * because `ok:false` otherwise reads as "just probed, still dead" — a monitor
   * can't tell a database that's down from one nobody has asked about for eight
   * seconds, and the difference is the whole reason the cooldown exists.
   *
   * Absent on a store that has no such notion (the file store never has one).
   */
  cooling?: boolean;
  /** How long until the next probe is allowed, ms. Set with `cooling`. */
  retryInMs?: number;
}

/**
 * One session, as retained history (DRY-56).
 *
 * NOT the same record as DRY-57's rediscovery index, and the distinction is
 * load-bearing rather than pedantic. That index is a pidfile: it lives beside
 * the supervisor's socket, it exists so a restarted daemon can find a RUNNING
 * process, and it is deleted the moment a session ends. This is history — it
 * starts mattering at exactly the point the index stops existing. They overlap
 * on most fields and must never be made to share storage, because their
 * lifetimes are opposites.
 */
export interface SessionRecord {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  /** Tracker repo NAME (not the resolved path), for a tombstone to name. */
  repo?: string;
  ticket?: string;
  worktree?: string;
  branch?: string;
  title?: string;
  /** `claude --resume <id>` — the CLI's own id, null until a hook reports it. */
  agentSessionId?: string;
  createdAt: number;
  lastActiveAt?: number;
  endedAt?: number;
  exitCode?: number;
  /**
   * Why it ended, because `exit_code` cannot say.
   *
   * Signalling a process exits it non-zero, so a run somebody stopped on
   * purpose and a run that crashed are both "exit 129". DRY-49 already paid for
   * that confusion once — it reported deliberate stops as failures and posted
   * "nobody was watching, please pick it up" to their tickets — and a tombstone
   * reading "failed" for a window you closed by hand is the same bug in a new
   * surface. Recorded at the moment we still know.
   */
  endReason?: SessionEndReason;
}

/** Mirrors session.ts's RunEndReason plus the case history has that runs don't. */
export type SessionEndReason = "finished" | "failed" | "stopped" | "unknown";

/** What a spawn knows about itself. `id`/`createdAt` come from the session. */
export type SessionStart = Omit<
  SessionRecord,
  "lastActiveAt" | "endedAt" | "exitCode" | "endReason" | "agentSessionId"
>;

/**
 * Retained session history — the database tier's feature (DRY-56).
 *
 * A separate port rather than more methods on StateStore, so that the file
 * store doesn't have to carry five no-ops it might one day half-implement, and
 * so the capability is DERIVED from whether this exists rather than declared in a
 * boolean somebody has to remember to keep true. `store.history?.record(…)` is
 * unable to lie about what the backend can do.
 */
export interface SessionHistory {
  /** Record a session at spawn. */
  start(owner: string, session: SessionStart): Promise<void>;
  /** Stamp last_active_at. Callers debounce — this must not be a write per keystroke. */
  touch(owner: string, id: string): Promise<void>;
  /** Stamp the ending. Safe to call twice; the first ending wins. */
  end(
    owner: string,
    id: string,
    ending: { endedAt: number; exitCode?: number; endReason: SessionEndReason },
  ): Promise<void>;
  /** Learn the wrapped CLI's own session id, once a hook reports it. */
  noteAgentSessionId(owner: string, id: string, agentSessionId: string): Promise<void>;
  /** Most recent first. Includes sessions that are still running. */
  recent(owner: string, limit: number): Promise<SessionRecord[]>;
  /** Drop history past the retention policy. Returns how many rows went. */
  prune(owner: string): Promise<number>;
}

/**
 * Storage backend for workspace state. Two implementations, chosen by whether
 * DRYDOCK_DATABASE_URL is set — see ./index.ts. Every method may reject; no
 * caller is allowed to let that kill the daemon (workspace state is a
 * convenience, live PTYs are the product), so the routes translate a rejection
 * into a 503 and the shell falls back to its local cache.
 */
export interface StateStore {
  readonly kind: StoreKind;
  /** The saved workspace, or null when this owner has never saved one. */
  load(owner: string, name: string): Promise<WorkspaceState | null>;
  save(owner: string, name: string, state: WorkspaceWrite): Promise<WorkspaceState>;
  clear(owner: string, name: string): Promise<void>;
  /** Cheap liveness probe for /healthz. Never rejects — reports instead. */
  health(): Promise<StoreHealth>;
  /**
   * Retained session history, or ABSENT on a backend that can't keep it.
   *
   * Absent rather than empty on the file store, deliberately. The whole point
   * of DRY-56 is that a missing tombstone must be legible as "this tier doesn't
   * record sessions" and never as "your session was lost" — the same confusion
   * `001_workspace.sql` was already written to pre-empt. A backend that
   * silently accepted the writes and returned nothing would reproduce it.
   */
  readonly history?: SessionHistory;
}
