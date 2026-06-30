import type { SessionInfo } from "./protocol.js";

// The daemon runs on the same host that served this shell, on the fixed daemon
// port — so the shell works whether it's loaded from localhost or over the
// LAN/Tailscale, with no hardcoded IP. Set VITE_DAEMON_URL to override (e.g. to
// point at a different host's daemon; a per-host switcher belongs here later).
const DAEMON_PORT = 4317;
const override = import.meta.env.VITE_DAEMON_URL as string | undefined;
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

/** Preview the cwd a ticket's repo resolves to (host-side). matched=false means
 *  no repo dir was found and it fell back to $HOME — the panel lets you override. */
export async function resolveRepoCwd(repo: string): Promise<{ cwd: string; matched: boolean }> {
  const res = await fetch(`${DAEMON_HTTP}/api/repos/resolve?repo=${encodeURIComponent(repo)}`);
  return res.json();
}
