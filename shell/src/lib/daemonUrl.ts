// Where the daemon is, and nothing else.
//
// Split out of lib/daemon.ts for DRY-27 to break a cycle rather than for tidiness:
// every request now carries a credential, so lib/daemon.ts imports lib/auth.ts —
// and lib/auth.ts needs this URL at module scope to key the stored token by
// daemon (one browser, several daemons: dev :4317, prod :4318, a throwaway on
// :4399, and a token from one is not a token for another). A cycle whose binding
// is read during module init doesn't merely warn, it evaluates to undefined.
//
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
