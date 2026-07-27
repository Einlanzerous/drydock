/**
 * Parse DRYDOCK_REPO_PATHS ("name=path,other=~/other") into a name→path map.
 * Lets a host map repos that don't live under the common root to explicit
 * locations. Malformed entries (no `=`) are skipped rather than throwing.
 */
function parseRepoPaths(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!spec) return out;
  for (const pair of spec.split(",")) {
    const i = pair.indexOf("=");
    if (i === -1) continue;
    const name = pair.slice(0, i).trim();
    const p = pair.slice(i + 1).trim();
    if (name && p) out[name] = p;
  }
  return out;
}

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
   * Daemon log (DRY-45). Session/client lifecycle and crash traces go here as
   * well as to stdout, because stdout is the terminal that started the daemon —
   * which is exactly what nobody still has open when they come asking why their
   * agents vanished. Rotates one generation at maxBytes. Set DRYDOCK_LOG_FILE=
   * (empty) to disable the file sink.
   */
  log: {
    file: process.env.DRYDOCK_LOG_FILE ?? "~/.drydock/daemon.log",
    maxBytes: Number(process.env.DRYDOCK_LOG_MAX_BYTES ?? 8_388_608),
    /**
     * An uncaught exception normally kills Node — and here that means killing
     * every live agent PTY, unrecoverably, because a session's lifetime IS the
     * process's. Since sessions can't survive a restart at all, staying up in a
     * questionable state strictly beats exiting cleanly: the other N agents stay
     * reachable. We log loudly and carry on. Set DRYDOCK_EXIT_ON_UNCAUGHT=1 to
     * restore Node's default (e.g. under a supervisor, once sessions are durable).
     */
    exitOnUncaught: process.env.DRYDOCK_EXIT_ON_UNCAUGHT === "1",
  },

  /**
   * Login shell spawned for plain "shell" sessions. Defaults to the host
   * owner's own shell ($SHELL) so their real setup loads — zsh + oh-my-zsh,
   * prompt, aliases — instead of a hardcoded bash. Override with DRYDOCK_SHELL.
   */
  defaultShell: process.env.DRYDOCK_SHELL ?? process.env.SHELL ?? "bash",

  /**
   * Where a ticket's repo maps on disk (DRY-9 ticket-spawn). A tracker repo
   * name `argosy` becomes `${root}/argosy` as the spawn cwd. Most repos live
   * under one root (default ~/projects); repos that live elsewhere get an
   * explicit override via DRYDOCK_REPO_PATHS="name=path,other=~/other" — this
   * is host/profile-specific, since the layout differs per machine. A name that
   * resolves to no existing directory falls back to $HOME (see repos.ts).
   */
  repos: {
    root: process.env.DRYDOCK_REPOS_ROOT ?? "~/projects",
    overrides: parseRepoPaths(process.env.DRYDOCK_REPO_PATHS),
  },

  /**
   * Per-ticket git worktree isolation (DRY-15). When a ticket-spawned agent's
   * repo is a git work tree, it runs in its own worktree at
   * `${root}/<repo>-<TICKET>` on branch `agent/<TICKET>` instead of the human's
   * checkout, so concurrent agents don't clobber each other. Set DRYDOCK_WORKTREES=0
   * to disable (agents fall back to the plain repo cwd). Worktrees are kept on
   * close and pruned on demand — see worktree.ts.
   */
  worktrees: {
    enabled: process.env.DRYDOCK_WORKTREES !== "0",
    root: process.env.DRYDOCK_WORKTREES_ROOT ?? "~/.drydock/worktrees",
  },

  /**
   * How long the daemon holds a PreToolUse hook request open waiting for a
   * human decision before giving up. Claude Code's own hook timeout (default
   * ~600s) is the hard ceiling; we stay under it so we resolve first and the
   * CLI never silently falls back to its TUI prompt.
   */
  permissionTimeoutMs: Number(process.env.DRYDOCK_PERMISSION_TIMEOUT_MS ?? 300_000),

  /**
   * Issue-tracker backend for the sidebar + Ctrl+K palette (DRY-10). Defaults
   * to `fixture` so the shell works with no credentials. Set `switchyard` or
   * `jira` plus the matching credentials to go live. Credentials stay here on
   * the host — they never reach the browser.
   */
  tracker: {
    kind: (process.env.DRYDOCK_TRACKER ?? "fixture") as "fixture" | "switchyard" | "jira",
    /**
     * Default project scope for ticket list/search (DRY-30), comma-separated
     * keys (e.g. "SRE,SREREV,SREDESK"). Against a corporate tracker an
     * unscoped "all open tickets" pull is the whole instance — set this
     * wherever the tracker is bigger than yours. Empty = unscoped. The UI can
     * add keys per browser on top of these, but can't remove them.
     */
    projects: (process.env.DRYDOCK_TRACKER_PROJECTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    switchyard: {
      url: process.env.DRYDOCK_SWITCHYARD_URL,
      token: process.env.DRYDOCK_SWITCHYARD_TOKEN,
    },
    jira: {
      url: process.env.DRYDOCK_JIRA_URL,
      // Cloud: email + API token (Basic). Server/DC: token only (Bearer PAT).
      email: process.env.DRYDOCK_JIRA_EMAIL,
      token: process.env.DRYDOCK_JIRA_TOKEN,
    },
  },
};
