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
  close(): Promise<void>;
}
