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

/**
 * Permission modes a spawn may ask for (DRY-49).
 *
 * `manual` is the CLI's own no-flag default — verified: a `claude` spawned with
 * no `--permission-mode` reports "manual mode on". It is represented here so a
 * host and a launch panel can *name* the safe posture, but it is passed by
 * OMITTING the flag rather than sending it, which keeps the common path
 * byte-identical to what shipped and can't break if the CLI renames it.
 *
 * The rest are passed through to `--permission-mode` verbatim. The list is a
 * whitelist, not documentation: an unrecognised value from a request must not
 * reach a spawn argument.
 */
export type PermissionMode =
  | "manual"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk";

export const PERMISSION_MODES = new Set<string>([
  "manual",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);

/**
 * Numeric knob where ZERO is a meaningful value rather than a typo.
 *
 * `num()` above rejects it, which is right for a cap or a budget — a scrollback
 * of 0 bytes is nobody's intent. For a delay that means "and then clear it",
 * 0 is the off switch and has to survive the parse.
 *
 * Which makes the empty string the hazard, because `Number("")` and
 * `Number("   ")` are both 0 — so `DRYDOCK_CLEAR_FINISHED_AFTER_MS=` (a knob
 * half-commented-out in a .env, the commonest way to write one) would read as a
 * deliberate "never sweep" and the feature would be silently off. Every other
 * knob here treats that as unset; so does this one, and only a written-out
 * number can turn it off.
 */
function msOrOff(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
     * An uncaught exception kills Node by default, and this daemon now lets it
     * — reversing the posture that stood until DRY-57.
     *
     * The old comment here ended "flip it once they can", and this is that
     * moment. While a session's lifetime WAS this process's, exiting cleanly
     * destroyed every live agent unrecoverably, so staying up in a questionable
     * state strictly beat it: the other N agents stayed reachable. That trade is
     * gone. Sessions are held by their own detached supervisors, a restart
     * reattaches to them (see sessions-dir.ts), and so a wedged daemon is now
     * pure cost — it serves the shell badly while the thing that made staying up
     * worthwhile is no longer at risk.
     *
     * PROD WANTS THIS TOO: the systemd unit is Restart=always, so a crash now
     * means a fresh daemon that reattaches, rather than one that comes back to
     * an empty desk. Set DRYDOCK_EXIT_ON_UNCAUGHT=0 to keep the old behaviour.
     */
    exitOnUncaught: process.env.DRYDOCK_EXIT_ON_UNCAUGHT !== "0",
  },

  /**
   * Where per-session supervisor sockets and the rediscovery index live
   * (DRY-57). Per-port for exactly the reason the log and state files are:
   * the documented way to verify a change is a second daemon on a spare port
   * (CLAUDE.md), and a shared directory would have that throwaway daemon adopt
   * the dev daemon's live agents. Set this explicitly to move a daemon's
   * sessions with it when its port changes.
   */
  sessionsDir: process.env.DRYDOCK_SESSIONS_DIR ?? `~/.drydock/sessions-${PORT}`,

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

    /**
     * Retention for session history (DRY-56) — the database tier's record of
     * what ran, which a tombstone is drawn from.
     *
     * Both bounds apply, because either alone has a bad case: a quiet month
     * under an age cap leaves nothing to resume from, and a busy afternoon of
     * ticket-spawned agents under a count cap buries the one you actually want.
     * A running session is never a prune candidate whatever these say.
     *
     * Nothing to do with DRY-57's `forget()`, which reaps the runtime index the
     * instant a session exits. That is a pidfile; this is history, and it only
     * starts mattering where the other stops existing.
     */
    history: {
      days: num(process.env.DRYDOCK_SESSION_HISTORY_DAYS, 30),
      max: num(process.env.DRYDOCK_SESSION_HISTORY_MAX, 500),
    },
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
   * Autonomous runs (DRY-49) — a session nobody is looking at.
   */
  autonomous: {
    /**
     * How much an unattended run is allowed to do without asking (DRY-49).
     *
     *   manual      every gated tool raises a Drydock gate. Safest, and the
     *               most interruptive: a run touching twelve files asks twelve
     *               times unless you use "Always allow <Tool>".
     *   acceptEdits file edits pass silently; Bash and WebFetch still gate.
     *               The middle: an isolated worktree makes edits cheap to
     *               review after the fact, while the tools that reach OUT of it
     *               still stop and ask.
     *   auto        nothing gates at all (likewise bypassPermissions/dontAsk).
     *               The rail becomes a progress display: it can still tell you
     *               a run failed, but it will never ask you anything.
     *
     * Ships as `manual` because that's the posture the rail was built for, and
     * a looser default should be a decision somebody made rather than one they
     * inherited. Flip it here once you trust your runs; the launch panel can
     * also override it per run.
     */
    permissionMode: PERMISSION_MODES.has(process.env.DRYDOCK_AUTONOMOUS_PERMISSION_MODE ?? "")
      ? (process.env.DRYDOCK_AUTONOMOUS_PERMISSION_MODE as PermissionMode)
      : ("manual" as PermissionMode),
    /**
     * How long an AUTONOMOUS run holds a gate. An hour, not the supervised
     * 300s, because the premise is that you walked away: five minutes is the
     * length of a coffee, and the point of the rail is that a gate can wait
     * out a meeting.
     *
     * This deliberately EXCEEDS Claude Code's own hook timeout (~600s), which
     * inverts the rule the supervised path lives by. That's safe only because
     * the autonomous timeout never resolves `"timeout"` — it denies with a
     * reason (see session.ts). The CLI's fallback is a TUI prompt inside a PTY
     * no human is watching, which is the exact wedge this ticket exists to
     * remove; if the hook gives up first, the run is already over and the deny
     * lands on a request nobody is waiting for.
     */
    permissionTimeoutMs: num(process.env.DRYDOCK_AUTONOMOUS_PERMISSION_TIMEOUT_MS, 3_600_000),
    /**
     * Where a finished run's handoff document is written. This has to outlive
     * the run: the tracker comment tells a human to continue from it, and the
     * alternative — a ~1 MiB scrollback ring buffer inside a dead session — is
     * gone the moment the daemon restarts.
     */
    runsRoot: process.env.DRYDOCK_RUNS_ROOT ?? "~/.drydock/runs",
    /**
     * Public URL of the shell, used only to add a "pick it up here" link to
     * the tracker comment. Unset by default and simply omitted when unset: the
     * daemon knows its own host and port but has no idea where the shell is
     * served from (dev :5320, prod :5321, possibly another host entirely), and
     * a guessed link in a permanent ticket comment is worse than no link.
     *
     * NB the design's `drydock://resume/<KEY>` is deliberately not used — no
     * handler for that scheme exists on any platform we run on.
     */
    shellUrl: process.env.DRYDOCK_SHELL_URL || undefined,
  },

  /**
   * The desk's own housekeeping (DRY-60).
   *
   * Host policy that THIS PROCESS NEVER ACTS ON, which is unusual enough to say
   * out loud: it is served over /api/config and enforced by the shell, like the
   * autonomous permission posture above. That isn't laziness — a sweep has to
   * know what is on screen, which window has focus, and whether anybody is
   * looking at the tab, and the daemon knows none of those. It deliberately goes
   * on keeping every exited session listed until a client says otherwise, so a
   * run that ended at 3am is still there at 9am for a browser that wasn't open.
   */
  desk: {
    /**
     * How long a cleanly-finished session stays on the desk before it clears
     * itself, in ms. Zero turns the sweep off and leaves every ending to be
     * dismissed by hand — the behaviour that shipped before DRY-60.
     *
     * Five minutes because the countdown only runs while the tab is in front of
     * you (see the shell's sweep): this is five minutes of somebody being in a
     * position to read the card, not five minutes of wall clock. A FAILED run is
     * never swept whatever this says, and neither is the window you have focused.
     */
    clearFinishedAfterMs: msOrOff(process.env.DRYDOCK_CLEAR_FINISHED_AFTER_MS, 300_000),
  },

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
    /**
     * How long a tracker answer may be reused before it's refreshed (DRY-72).
     *
     * The sidebar polls every 20s per browser tab and a corporate Jira pull
     * measures 5.7-6s, so uncached this was a permanent ~30% duty cycle against
     * the tracker per tab — enough that the browser's own 12s budget tripped on
     * ordinary load. See tracker/cache.ts for why this is stale-while-revalidate
     * rather than a plain TTL; nothing here makes a client wait longer, it only
     * bounds how old an answer can be.
     */
    cache: {
      /**
       * The sidebar's ticket list. Matched to the shell's own poll interval so
       * a single tab sees data no older than it did before, while N tabs (and
       * back-to-back polls) collapse onto one fan-out.
       *
       * Zero switches the cache OFF — a straight passthrough to the provider,
       * for reproducing a tracker bug the cache would otherwise mask. Hence
       * `msOrOff`: through `num()` a deliberate 0 would silently restore the
       * default, and the off switch would do nothing (DRY-60's trap 9).
       */
      ticketsMs: msOrOff(process.env.DRYDOCK_TRACKER_CACHE_MS, 20_000),
      /**
       * An epic's child counts (DRY-13), which are the unbounded half of a pull
       * — that query spans every status, so it grows with years of closed work
       * rather than with what's on screen. Five minutes because a completion
       * ratio moves over days; the list beside it still refreshes at the rate
       * above. Zero switches it off, as with the list.
       */
      childStatsMs: msOrOff(process.env.DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS, 300_000),
    },
    /**
     * Deadline on a single tracker HTTP request (DRY-72).
     *
     * The providers had none, and nothing propagates a client's abort, so when
     * the shell gave up at 12s the daemon kept walking pages for a browser that
     * had stopped listening — and 8s later the next poll started a second
     * fan-out on top of it. Generous rather than tight: since the cache moved
     * these off the request path, blowing this costs a background refresh, not a
     * sidebar. A caller with its own tighter budget (the SessionStart brief's
     * extras) keeps it.
     *
     * Through `msOrOff`, not `num()`: zero means "no deadline" — the behaviour
     * that shipped before DRY-72 — and that is a real posture somebody might
     * want back while chasing a tracker that is merely very slow. `num()`
     * rejects 0, so the off switch would silently restore the 20s default
     * instead: DRY-60's trap 9, which the sibling TTLs above already avoid.
     *
     * NB this bounds ONE request, not a whole pull. A page-walk of N pages can
     * still take N × this, bounded by MAX_TICKETS (~20 pages) rather than by a
     * clock. That is why the list cache reports staleness by AGE as well as by
     * failure — see `staleAfterMs` in tracker/cache.ts.
     */
    requestTimeoutMs: msOrOff(process.env.DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS, 20_000),
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
