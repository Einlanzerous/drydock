import type { SessionInfo } from "./protocol.js";

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

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${DAEMON_HTTP}/api/sessions`);
  const body = await res.json();
  return body.sessions;
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
}): Promise<SessionInfo> {
  const res = await fetch(`${DAEMON_HTTP}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "failed to create session");
  return body.session;
}

export async function killSession(id: string): Promise<void> {
  await fetch(`${DAEMON_HTTP}/api/sessions/${id}/kill`, { method: "POST" });
}

export function attachUrl(id: string): string {
  return `${DAEMON_WS}/api/sessions/${id}/attach`;
}

// --- Permission gates, independent of any pane (DRY-50) ---

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
): Promise<void> {
  const res = await fetch(
    `${DAEMON_HTTP}/api/sessions/${encodeURIComponent(sessionId)}/permission`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision, reason }),
    },
  );
  if (!res.ok && res.status !== 409 && res.status !== 404) {
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
  const res = await fetch(`${DAEMON_HTTP}/api/workspace`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
  const body = await res.json();
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
  const res = await fetch(`${DAEMON_HTTP}/api/repos/resolve?${q.toString()}`);
  return res.json();
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
  const res = await fetch(
    `${DAEMON_HTTP}/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "file not readable");
  return body;
}
