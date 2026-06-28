export const CONFIG = {
  /**
   * Bind address. Defaults to 0.0.0.0 so the daemon is reachable over the
   * LAN/Tailscale (PoC posture — matches the shell's `host: true`). It's
   * UNAUTHENTICATED: anyone who can reach the port can spawn/attach to shells.
   * Fine for a trusted LAN + Tailscale; set DRYDOCK_HOST=127.0.0.1 to lock it
   * back to localhost. Real auth is the first thing to add past PoC.
   */
  host: process.env.DRYDOCK_HOST ?? "0.0.0.0",
  port: Number(process.env.DRYDOCK_PORT ?? 4317),

  /** Scrollback ring-buffer cap per session, in bytes (~1 MiB). */
  scrollbackBytes: Number(process.env.DRYDOCK_SCROLLBACK_BYTES ?? 1_048_576),

  /**
   * How long the daemon holds a PreToolUse hook request open waiting for a
   * human decision before giving up. Claude Code's own hook timeout (default
   * ~600s) is the hard ceiling; we stay under it so we resolve first and the
   * CLI never silently falls back to its TUI prompt.
   */
  permissionTimeoutMs: Number(process.env.DRYDOCK_PERMISSION_TIMEOUT_MS ?? 300_000),

  /**
   * Issue-tracker backend for the sidebar + Ctrl+K palette (DRY-10). Defaults
   * to `fixture` so the shell works with no credentials. Set `switchyard` (or
   * `jira`, once built) plus the matching credentials to go live. Credentials
   * stay here on the host — they never reach the browser.
   */
  tracker: {
    kind: (process.env.DRYDOCK_TRACKER ?? "fixture") as "fixture" | "switchyard" | "jira",
    switchyard: {
      url: process.env.DRYDOCK_SWITCHYARD_URL,
      token: process.env.DRYDOCK_SWITCHYARD_TOKEN,
    },
  },
};
