import type { PermissionMode, SessionInfo } from "./protocol.js";

// The daemon runs on the same host that served this shell, on the fixed daemon
// port — so the shell works whether it's loaded from localhost or over the
// LAN/Tailscale, with no hardcoded IP. Set VITE_DAEMON_URL to override (e.g. to
// point at a different host's daemon; a per-host switcher belongs here later).
//
// Prod (DRY-19): /config.js sets window.__DRYDOCK__ before this bundle loads,
// so one GHCR image can target any daemon at container start. daemonUrl (full
// URL) beats daemonPort (same host as the page, non-dev port) beats build-time
// VITE_DAEMON_URL beats the dev default :4317.
interface RuntimeConfig {
  daemonUrl?: string;
  daemonPort?: string | number;
}
const runtime: RuntimeConfig =
  (typeof window !== "undefined" &&
    (window as unknown as { __DRYDOCK__?: RuntimeConfig }).__DRYDOCK__) ||
  {};
const DAEMON_PORT = Number(runtime.daemonPort ?? 4317);
const override = runtime.daemonUrl ?? (import.meta.env.VITE_DAEMON_URL as string | undefined);
const host =
  typeof window !== "undefined" ? window.location.hostname || "127.0.0.1" : "127.0.0.1";
const wsProto =
  typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";

export const DAEMON_HTTP = override ?? `http://${host}:${DAEMON_PORT}`;
export const DAEMON_WS = override
  ? override.replace(/^http/, "ws")
  : `${wsProto}://${host}:${DAEMON_PORT}`;

/**
 * Every daemon response the shell parses goes through here, because the failure
 * this guards is not a request that fails — it's one that SUCCEEDS with a
 * failure (DRY-51). A
 * 404's `{"error":"not found"}` parses as JSON perfectly well, so a bare
 * `res.json()` hands the caller an error object typed as data. The caller's
 * `catch` never runs, the missing field travels three layers, and it finally
 * throws inside a render — where it takes Vue's patcher down with it and the
 * whole desk stops updating, not just the feature that asked.
 *
 * A shell newer than its daemon is the routine case here, not a hypothetical:
 * the shell ships as its own GHCR image against a pinned daemon checkout
 * (docs/deploy.md), so anything added since that ref 404s for the length of a
 * partial deploy. The tracker being unreachable does it too — that route
 * answers 502 with an error body.
 */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  // Parsed BEFORE the status check so a daemon that explains itself in `error`
  // gets to. A body that isn't JSON at all (nginx's HTML 502, a wrong port
  // serving an SPA's index.html with a cheerful 200) leaves it undefined.
  let body: any;
  try {
    body = await res.json();
  } catch (err) {
    // An abort is the CALLER's timeout firing mid-body, not a malformed
    // response — fetchWorkspace's 3s budget is load-bearing (a partitioned
    // Postgres costs the daemon 5s), and reporting it as bad JSON would send
    // the next person reading this banner after the wrong problem entirely.
    if ((err as Error | undefined)?.name === "AbortError") throw err;
    if (res.ok) throw new Error(`daemon returned a non-JSON body (${res.status})`);
  }
  // The status is ALWAYS in the message. `error` alone reads "not found", which
  // is exactly what the daemon's unknown-route fallthrough says — so the one
  // case this helper exists for, a shell newer than its daemon, would produce a
  // banner with nothing in it to distinguish a missing route from a 500.
  if (!res.ok) throw new Error(`daemon returned ${res.status}${suffix(body)}`);
  // `null` is valid JSON, so without this it comes back typed as a T and the
  // crash simply moves to the caller's first property read.
  if (body === null || body === undefined) throw new Error("daemon returned an empty body");
  return body as T;
}

function suffix(body: any): string {
  return typeof body?.error === "string" && body.error ? `: ${body.error}` : "";
}

/**
 * Unwrap a list out of its envelope. A 200 carrying the wrong shape is the same
 * bug with a longer fuse: `undefined` assigned to a `Ticket[]` doesn't throw
 * here, it throws in the render that maps it — the desk-down failure again. So
 * the envelope is checked at the point it's opened.
 */
export function expectList<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`daemon returned no ${what}`);
  return value as T[];
}

export async function listSessions(): Promise<SessionInfo[]> {
  const body = await getJson<{ sessions?: SessionInfo[] }>(`${DAEMON_HTTP}/api/sessions`);
  return expectList(body.sessions, "sessions");
}

export async function createSession(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  /** Ticket repo name; the daemon resolves it to a real cwd host-side. */
  repo?: string;
  /** Ticket key; the daemon binds it to the session for the SessionStart hook. */
  ticket?: string;
  /**
   * DRY-15 worktree isolation. Omit to let a ticket spawn default to an isolated
   * `agent/<TICKET>` worktree; pass an explicit path to override where it lives;
   * pass `false` to opt out and run directly in the working dir.
   */
  worktree?: string | false;
  /** Override the branch checked out in the worktree (default `agent/<TICKET>`). */
  branch?: string;
  title?: string;
  /** Run unattended: a rail card instead of a window, hour-long gates (DRY-49). */
  autonomous?: boolean;
  /** Who started it. Only the browser sends spawns today, so only "you". */
  origin?: "you" | "agent";
  /**
   * How much this run may do without asking. Omit to take the host's policy —
   * which for an autonomous run is DRYDOCK_AUTONOMOUS_PERMISSION_MODE, not
   * necessarily `manual`.
   */
  permissionMode?: PermissionMode;
  /**
   * First prompt, typed AND submitted by the daemon once the CLI settles.
   * Autonomous runs must use this rather than `initialInput` on a pane: there
   * is no pane, so nothing else would ever type it.
   */
  input?: string;
}): Promise<SessionInfo> {
  const body = await getJson<{ session?: SessionInfo }>(`${DAEMON_HTTP}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  // Callers reach straight for `.id` and `.cwd` to place a window and co-locate
  // a shell, so an envelope without a session has to fail here rather than as
  // "cannot read properties of undefined" two frames later (DRY-51).
  if (!body.session) throw new Error("daemon returned no session");
  return body.session;
}

/**
 * Stop a session. The status is checked (DRY-51) because the alternative is a
 * Stop button that reports success for a kill that never happened — every
 * caller here already surfaces the throw, and a run that keeps going after you
 * stopped it is precisely the state an unattended run must never be left in.
 */
export async function killSession(id: string): Promise<void> {
  await getJson(`${DAEMON_HTTP}/api/sessions/${encodeURIComponent(id)}/kill`, { method: "POST" });
}

export function attachUrl(id: string): string {
  return `${DAEMON_WS}/api/sessions/${id}/attach`;
}

// --- Permission gates, independent of any pane (DRY-50) ---

/** Host policy the launch panel needs to describe what a run will start as. */
export interface DaemonConfig {
  autonomous: { permissionMode: PermissionMode; permissionTimeoutMs: number };
}

/**
 * Read the host's autonomous-run policy. Best-effort by design: a daemon older
 * than this shell 404s here, and the panel simply falls back to naming `manual`
 * — it must never stop you launching a run.
 */
export async function fetchConfig(): Promise<DaemonConfig | null> {
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/config`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.autonomous?.permissionMode ? (body as DaemonConfig) : null;
  } catch {
    return null;
  }
}

/** The shell-wide event stream. One per tab, not one per session. */
export function eventsUrl(): string {
  return `${DAEMON_HTTP}/api/events`;
}

/**
 * Answer a gate over HTTP rather than that session's attach socket, which is
 * the whole point: a minimized window has no socket, so the WebSocket path
 * cannot answer for it.
 *
 * 409 (gate already resolved) and 404 (session already gone) both mean the same
 * thing to a caller: there is nothing left to answer. Neither is a failure to
 * retry or restore from. 404 is routinely reachable — the kill route calls
 * manager.remove(), which drops the session from the registry synchronously,
 * before the PTY's onExit has announced its dangling gates — so treating it as
 * an error puts back a row that can never be answered and re-fails on every
 * subsequent click.
 */
export async function answerGate(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  reason?: string,
  /** Stop gating this tool for the rest of the run ("Always allow Bash", DRY-49). */
  always?: boolean,
): Promise<void> {
  const res = await fetch(
    `${DAEMON_HTTP}/api/sessions/${encodeURIComponent(sessionId)}/permission`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision, reason, always }),
    },
  );
  if (!res.ok && res.status !== 409 && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `daemon returned ${res.status}`);
  }
}

/**
 * Take over an autonomous run: it becomes an ordinary supervised session and
 * leaves the rail (DRY-49). One-way — the daemon refuses the reverse, so
 * there's no parameter to get wrong here.
 */
export async function takeOverRun(sessionId: string): Promise<void> {
  const res = await fetch(
    `${DAEMON_HTTP}/api/sessions/${encodeURIComponent(sessionId)}/autonomy`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomous: false }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `daemon returned ${res.status}`);
  }
}

// --- Workspace state (DRY-28) ---
// The saved desk. `windows` stays `unknown[]` at this layer for the same reason
// the daemon keeps it opaque: the Win shape belongs to the window manager, and
// this module has no business knowing it. composables/layoutStore.ts owns
// validation and the localStorage mirror; this owns the wire.

export interface WorkspaceEnvelope {
  version: number;
  layout: string;
  windows: unknown[];
  /** Server clock at write; absent on the way up. */
  updatedAt?: number;
}

/**
 * Fetch the saved desk, or null when this owner has never saved one.
 *
 * The timeout is load-bearing, not hygiene: the desktop can't render until
 * this resolves, and the daemon's own Postgres connect timeout is 5s — so a
 * partitioned database (as opposed to a refused connection, which fails
 * instantly) would otherwise mean five seconds of blank page before the local
 * mirror gets its turn. Bail early and let the mirror answer.
 */
export async function fetchWorkspace(): Promise<WorkspaceEnvelope | null> {
  const body = await getJson<{ workspace?: WorkspaceEnvelope | null }>(
    `${DAEMON_HTTP}/api/workspace`,
    { signal: AbortSignal.timeout(3000) },
  );
  return body.workspace ?? null;
}

export async function putWorkspace(data: WorkspaceEnvelope): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
}

export async function deleteWorkspace(): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP}/api/workspace`, { method: "DELETE" });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
}

/** Where a ticket's spawn will land (host-side preview). */
export interface RepoResolution {
  cwd: string;
  /** Repo dir found; false means it fell back to $HOME — the panel lets you override. */
  matched: boolean;
  /** cwd is a git work tree, so DRY-15 worktree isolation is available. */
  git?: boolean;
  /** Planned isolated worktree path (git repos only). */
  worktree?: string;
  /** Planned branch (default `agent/<TICKET>`). */
  branch?: string;
  /** A worktree already exists here from a prior spawn → it'll be reused. */
  worktreeExists?: boolean;
}

/** Preview the cwd + worktree/branch a ticket's repo resolves to (host-side).
 *  Pass the ticket key to also preview the DRY-15 worktree it would isolate into. */
export async function resolveRepoCwd(repo: string, ticket?: string): Promise<RepoResolution> {
  const q = new URLSearchParams({ repo });
  if (ticket) q.set("ticket", ticket);
  const body = await getJson<RepoResolution>(`${DAEMON_HTTP}/api/repos/resolve?${q.toString()}`);
  // Without this the panel would preview an undefined cwd as a blank line, and
  // the caller's catch — whose comment promises to keep the last-good preview —
  // would never fire (DRY-51).
  if (typeof body.cwd !== "string") throw new Error("daemon returned no cwd");
  return body;
}

/** Prune a ticket's worktree on demand (DRY-15). Kept on close, removed here. */
export async function removeWorktree(opts: { repo: string; worktree: string }): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP}/api/worktrees/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to remove worktree");
  }
}

/**
 * Read a text/markdown file relative to a session's cwd (DRY-35 doc viewer).
 * The daemon confines the read to the session's working tree; `path` in the
 * result is the resolved absolute path (for the viewer's title + relative-link
 * navigation).
 */
export async function sessionFile(
  id: string,
  path: string,
): Promise<{ path: string; content: string }> {
  const body = await getJson<{ path: string; content: string }>(
    `${DAEMON_HTTP}/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  );
  if (typeof body.content !== "string") throw new Error("file not readable");
  return body;
}
