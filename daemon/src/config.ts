import * as os from "node:os";

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

/**
 * Numeric knob with a NaN-safe fallback. `Number("8mb")` is NaN, and NaN loses
 * every comparison — so an unparseable value doesn't fall back, it silently
 * switches the feature OFF (no rotation, no scrollback trimming) and the failure
 * only shows up as a disk or heap that won't stop growing. `port` deliberately
 * isn't routed through here: a bad port should fail loudly at bind rather than
 * quietly serve on a different one.
 */
function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read once: the default log path is per-port so concurrent daemons don't share a file. */
const PORT = Number(process.env.DRYDOCK_PORT ?? 4317);

export const CONFIG = {
  /**
   * Bind address. Defaults to 0.0.0.0 so the daemon is reachable over the
   * LAN/Tailscale (PoC posture — matches the shell's `host: true`). It's
   * UNAUTHENTICATED: anyone who can reach the port can spawn/attach to shells.
   * Fine for a trusted LAN + Tailscale; set DRYDOCK_HOST=127.0.0.1 to lock it
   * back to localhost. Real auth is the first thing to add past PoC.
   */
  host: process.env.DRYDOCK_HOST ?? "0.0.0.0",
  port: PORT,

  /** Scrollback ring-buffer cap per session, in bytes (~1 MiB). */
  scrollbackBytes: num(process.env.DRYDOCK_SCROLLBACK_BYTES, 1_048_576),

  /**
   * Daemon log (DRY-45). Session/client lifecycle and crash traces go here as
   * well as to stdout, because stdout is the terminal that started the daemon —
   * which is exactly what nobody still has open when they come asking why their
   * agents vanished. Rotates one generation at maxBytes. Set DRYDOCK_LOG_FILE=
   * (empty) to disable the file sink.
   *
   * The default path carries the PORT because the documented workflow runs a
   * second (and third) daemon on a spare port — CLAUDE.md's whole verification
   * story — and a shared file would interleave their lines and race their
   * rotations. Point DRYDOCK_LOG_FILE at one path deliberately if you'd rather
   * have them merged.
   */
  log: {
    file: process.env.DRYDOCK_LOG_FILE ?? `~/.drydock/daemon-${PORT}.log`,
    maxBytes: num(process.env.DRYDOCK_LOG_MAX_BYTES, 8_388_608),
    /**
     * An uncaught exception normally kills Node — and here that means killing
     * every live agent PTY, unrecoverably, because a session's lifetime IS the
     * process's. Since sessions can't survive a restart at all, staying up in a
     * questionable state strictly beats exiting cleanly: the other N agents stay
     * reachable. We log loudly and carry on. Set DRYDOCK_EXIT_ON_UNCAUGHT=1 to
     * restore Node's default (e.g. under a supervisor, once sessions are durable).
     *
     * PROD IS THE SAME BY DEFAULT, and that is a decision, not an oversight: the
     * systemd unit is Restart=always, so exiting there would mean a restarted
     * daemon with zero sessions, every agent gone. Wedged-but-attached beats
     * restarted-and-empty while sessions can't outlive the process. Flip it in
     * prod's .env (the unit deliberately sets no DRYDOCK_* vars) once they can.
     */
    exitOnUncaught: process.env.DRYDOCK_EXIT_ON_UNCAUGHT === "1",
  },

  /**
   * Workspace state (DRY-28). The daemon owns the desktop arrangement so it
   * follows the person rather than the browser profile that happened to draw it.
   *
   * `databaseUrl` picks the backend and nothing else does: set it and state
   * lives in Postgres (your server, or a container on this host — same code
   * path), leave it unset and state is a JSON file. Unset is the default on
   * purpose: a fresh clone, and the isolated single-host profile (DRY-25), must
   * work with no database to install.
   */
  state: {
    /** postgres://<user>:<password>@<host>:<port>/db — unset selects the file store. */
    databaseUrl: process.env.DRYDOCK_DATABASE_URL || undefined,
    /**
     * Per-port like the log file, and for the same reason: the documented way
     * to verify a change is a second daemon on a spare port (CLAUDE.md), and
     * two daemons sharing one state file would overwrite each other's
     * workspace on every save.
     */
    file: process.env.DRYDOCK_STATE_FILE ?? `~/.drydock/state-${PORT}.json`,
    /**
     * Who saved state belongs to. A constant until DRY-27 brings accounts.
     *
     * It is read from host config and NEVER from the request — a client can't
     * name an owner — but that still doesn't make it a security boundary: the
     * daemon has no authentication, so anyone who can reach the port reads and
     * writes this owner's workspace. It exists so the schema doesn't have to
     * change when real identities arrive, and so two people sharing one host
     * daemon can at least keep separate desks.
     */
    owner: process.env.DRYDOCK_OWNER ?? "local",
    /**
     * Which saved desk this daemon owns, defaulting to something unique per
     * daemon instance.
     *
     * A desk is a set of window ids belonging to THIS daemon's sessions, so
     * two daemons sharing one row is not sharing, it's a fight: each reconciles
     * away the other's windows (their sessions don't exist here) and saves the
     * result. A plain "default" made that the out-of-the-box behaviour for the
     * arrangement this ticket is actually aimed at — a desktop and a work
     * laptop pointed at one central Postgres — where both are :4317 on
     * different hosts, so the port alone wouldn't separate them either.
     *
     * The file store got this right by accident (its default path carries the
     * port); this is the same rule made explicit and host-aware. Set it to the
     * same value on two daemons to deliberately share a desk.
     */
    workspace: process.env.DRYDOCK_WORKSPACE ?? `${os.hostname()}-${PORT}`,
    /**
     * Cap on a single saved workspace, bytes. The daemon is unauthenticated
     * (see `host`), so an unbounded PUT is an unbounded write to whatever is
     * backing it. A real arrangement is a few KB; 1 MiB is four orders of
     * magnitude of headroom and still bounded.
     */
    maxBytes: num(process.env.DRYDOCK_STATE_MAX_BYTES, 1_048_576),
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
