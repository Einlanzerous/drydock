import type { PermissionMode, SessionInfo, SessionVisibility } from "./protocol.js";
import { authFetch, withStreamToken } from "./auth.js";

// Where the daemon is now lives in ./daemonUrl.ts — see the note there for why
// it had to move out (lib/auth.ts needs it at module scope, and this module
// needs lib/auth.ts). Re-exported so every existing importer is unaffected.
export { DAEMON_HTTP, DAEMON_WS } from "./daemonUrl.js";
import { DAEMON_HTTP, DAEMON_WS } from "./daemonUrl.js";

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
  return unwrap<T>(await authFetch(url, init));
}

/**
 * The body-parse-and-check half of `getJson`, so a caller that has to inspect
 * the status FIRST (see fetchSessionHistory's 501) doesn't have to reimplement
 * it — the copy that did dropped both guards below, which this module documents
 * as load-bearing.
 */
async function unwrap<T>(res: Response): Promise<T> {
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

/** One session as retained history (DRY-56). Mirrors the daemon's SessionRecord. */
export interface SessionRecord {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  repo?: string;
  ticket?: string;
  worktree?: string;
  branch?: string;
  title?: string;
  /** `claude --resume <id>`. Absent when the CLI never reported one. */
  agentSessionId?: string;
  /** The id is recorded but its transcript isn't on disk (DRY-62). */
  transcriptMissing?: boolean;
  createdAt: number;
  lastActiveAt?: number;
  endedAt?: number;
  exitCode?: number;
  endReason?: "finished" | "failed" | "stopped" | "unknown";
}

/**
 * Can this tombstone's button actually reopen the agent's conversation?
 *
 * Lives here because TWO places ask — the card, to choose its label, and the
 * spawn, to choose its args — and DRY-62 was the two of them agreeing on a
 * condition that had stopped being sufficient. One of them drifting from the
 * other is a button whose label and behaviour disagree.
 *
 * `transcriptMissing` is undefined when the daemon could not look, and that
 * case must stay resumable: refusing on "don't know" would take the button away
 * from every conversation on a host whose transcript directory is unreadable.
 */
export function canResumeConversation(record: SessionRecord): boolean {
  return record.command === "claude" && Boolean(record.agentSessionId) && !record.transcriptMissing;
}

/**
 * Recent sessions, live or dead — what tombstones are drawn from (DRY-56).
 *
 * `null` means this Drydock keeps no history (the file tier answers 501), which
 * is a DIFFERENT answer from an empty list and the caller has to say so
 * differently: an absent tombstone must read as "sessions aren't recorded here",
 * never as "your session was lost". Any other failure throws, so a store outage
 * degrades the desk rather than silently claiming nothing ever ran.
 */
export async function fetchSessionHistory(): Promise<SessionRecord[] | null> {
  // Budgeted, like fetchWorkspace's. This runs behind the session poll, and a
  // partitioned Postgres costs the daemon its full query deadline — without a
  // ceiling here that becomes the shell's deadline too (DRY-58).
  const res = await authFetch(`${DAEMON_HTTP}/api/sessions/history`, {
    signal: AbortSignal.timeout(5_000),
  });
  // 501 is the tier speaking, not a fault — checked before the body is read so
  // it can't be mistaken for one.
  if (res.status === 501) return null;
  const body = await unwrap<{ sessions?: SessionRecord[] }>(res);
  return expectList<SessionRecord>(body.sessions, "session history");
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
   * Who else may watch this run (DRY-27). Omit for `private`, which is every
   * run on a single-account daemon. `public` is the deliberate "start it where
   * the team can see it" case — they can watch and cannot type.
   */
  visibility?: SessionVisibility;
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

/**
 * Where to attach a pane's terminal.
 *
 * Async since DRY-27, and it has to be: a browser's `WebSocket` constructor
 * cannot set an Authorization header, so the credential goes in the query
 * string — and it is a freshly minted, one-minute `stream` token rather than
 * the real one, because a URL is the one place a credential reliably ends up in
 * somebody's proxy log. Minted per connection, so a reconnect gets its own.
 *
 * Returns the bare URL when auth is off, which is every existing deployment.
 */
export function attachUrl(id: string): Promise<string> {
  return withStreamToken(`${DAEMON_WS}/api/sessions/${id}/attach`);
}

// --- Permission gates, independent of any pane (DRY-50) ---

/** Host policy the launch panel needs to describe what a run will start as. */
export interface DaemonConfig {
  autonomous: { permissionMode: PermissionMode; permissionTimeoutMs: number };
  /**
   * How long a finished session sits on the desk before clearing itself
   * (DRY-60), 0 for never. Optional because a daemon older than this shell
   * doesn't send it, and the desk falls back to its own default rather than
   * treating a missing field as "off".
   */
  desk?: { clearFinishedAfterMs: number };
}

/**
 * Read the host's autonomous-run policy. Best-effort by design: a daemon older
 * than this shell 404s here, and the panel simply falls back to naming `manual`
 * — it must never stop you launching a run.
 */
export async function fetchConfig(): Promise<DaemonConfig | null> {
  try {
    const res = await authFetch(`${DAEMON_HTTP}/api/config`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.autonomous?.permissionMode ? (body as DaemonConfig) : null;
  } catch {
    return null;
  }
}

/**
 * The shell-wide event stream. One per tab, not one per session.
 *
 * Async for the same reason as `attachUrl` — `EventSource` has no API for a
 * header at all — and minting per connection matters more here, because this
 * stream reconnects on its own schedule after every daemon restart.
 */
export function eventsUrl(): Promise<string> {
  return withStreamToken(`${DAEMON_HTTP}/api/events`);
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
  const res = await authFetch(
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
  const res = await authFetch(
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

/**
 * Budget for a write. Longer than the read's 3s because there is no first paint
 * waiting on it, and it has to clear the daemon's own worst honest latency —
 * aborting a request that was about to explain itself trades a good error for
 * a vague one.
 *
 * That worst case is the daemon's `query_timeout` (10s, see state/postgres.ts),
 * not its 5s connect timeout: a write landing on a warm-but-partitioned pooled
 * client waits out the query, and a warm pool is the normal case since clients
 * stay idle for 30s. The two numbers have to be picked together — at 8s this
 * aborted two seconds before the daemon would have answered 503, which is
 * precisely the trade this comment claims to avoid.
 *
 * It exists at all because of DRY-58. While a failed push was fire-and-forget,
 * a request that hung forever cost nothing: the mirror had the desk and nobody
 * was waiting. Now a push failing is what ARMS the retry, and the retry loop
 * awaits this call — so a daemon that accepts the connection and then goes
 * silent (a real partition, as opposed to a refused connect) would leave the
 * recovery permanently in flight, having neither succeeded nor reported. No
 * notice, no retry, no roaming, and nothing in the console to say so. The one
 * failure mode this whole ticket is about, reintroduced by its own fix.
 */
const WRITE_TIMEOUT_MS = 12_000;

export async function putWorkspace(data: WorkspaceEnvelope): Promise<void> {
  const res = await authFetch(`${DAEMON_HTTP}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
}

export async function deleteWorkspace(): Promise<void> {
  const res = await authFetch(`${DAEMON_HTTP}/api/workspace`, {
    method: "DELETE",
    signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
  });
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
  const res = await authFetch(`${DAEMON_HTTP}/api/worktrees/remove`, {
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
