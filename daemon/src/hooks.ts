// Drydock hooks, injected into every spawned `claude` via `--settings <file>`
// (DRY-12). This is how the approval (PreToolUse) and ticket-context
// (SessionStart) hooks reach the agent without each target repo having to add
// them to its own .claude/settings.json — they now work in *any* cwd, including
// repo-less projects that fall back to $HOME.
//
// `$DRYDOCK_DAEMON_URL` / `$DRYDOCK_SESSION_ID` stay as literal text in the
// command strings; they're expanded by the shell when the hook runs, from the
// session env the daemon injects (session.ts). We write the files once at
// startup and hand claude the path that matches the kind of session.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every tool that asks for approval in Claude Code's `default` permission mode.
 *
 * This list is load-bearing, not a convenience (DRY-49). Anything that prompts
 * and ISN'T here gets Claude Code's own TUI prompt instead of a Drydock gate —
 * which for an autonomous run means a question drawn inside a PTY that has no
 * window, no rail card, no timeout and no handoff. Verified: with only `Bash`
 * matched, "create a file" printed *"Do you want to create probe-note.txt?"*
 * into a terminal nobody could see and the run sat there indefinitely, its card
 * cheerfully reading "writing probe-note.txt" with the hairline marching.
 *
 * Read/Glob/Grep/Task are deliberately absent: they don't prompt, so gating
 * them would invent an approval the CLI never wanted, on the highest-frequency
 * tools an agent uses.
 */
const GATED_TOOLS = "Bash|Edit|MultiEdit|Write|NotebookEdit|WebFetch";

/**
 * Tools worth a caption on the rail that the gate above never sees. The gated
 * ones already record their activity daemon-side in `requestPermission()`, so
 * this covers only what's left — and only autonomous sessions load it (see
 * below), because a supervised session pays a subprocess per tool call for a
 * caption that has nowhere to render.
 */
const REPORTED_TOOLS = "Read|Glob|Grep|Task|WebSearch";

/**
 * curl exit codes that mean "the daemon went away", and nothing else.
 *
 *   7  couldn't connect          — daemon down when the hook fired
 *   52 empty reply from server   — died mid-request
 *   55 send failure              — died while we were writing
 *   56 recv failure (reset)      — died while we waited on the answer
 *
 * 28 (operation timed out) is deliberately ABSENT, and that omission is the
 * whole reason this is a hand-rolled loop instead of curl's own `--retry`.
 * curl's retry vocabulary is too coarse: `--retry-connrefused` covers only 7,
 * which is the one case that DOESN'T happen when a daemon is killed mid-gate
 * (the connection is established, so it resets — 56 — and plain --retry ignores
 * that), while `--retry-all-errors` sweeps up 28 as well. Retrying a timeout is
 * actively wrong here: an autonomous gate is SUPPOSED to outlive curl's -m 590
 * (CONFIG.autonomous.permissionTimeoutMs is an hour), so treating that as a
 * failure would POST again and raise a second gate on the daemon for one tool
 * call — a duplicate on the rail that nobody can meaningfully answer.
 */
const RETRY_CODES = "7|52|55|56";
const RETRY_DELAY_S = 2;
/** Gate: ~30s of absence, comfortably inside the hook's own 600s timeout. */
const RETRY_ATTEMPTS = 15;
/**
 * Stop: fewer, because its budget is much tighter. Claude Code kills the hook
 * at `timeout`, and the worst case per attempt is the full `-m` plus the delay
 * (a daemon that ACCEPTS and then hangs, rather than refusing). 4 × (8+2) = 40s
 * fits under 45; the 15 above would be killed mid-retry, which is the one
 * outcome worse than giving up — the agent waits and the hook still loses.
 */
const RETRY_ATTEMPTS_QUIET = 4;

/**
 * Wrap a hook's curl so it rides out a daemon restart (DRY-57).
 *
 * A session now outlives its daemon; a gate held open across one did not. The
 * curl is a live connection to the daemon, so a restart killed it, the hook
 * returned nothing, and Claude Code fell back to its own TUI prompt — drawn
 * inside a PTY with no window, which for an unattended run is the exact wedge
 * DRY-49 exists to prevent.
 *
 * The body is buffered BEFORE the loop because `--data-binary @-` reads stdin,
 * and stdin is a pipe that can only be consumed once — a second attempt would
 * otherwise POST nothing and the daemon would raise a gate for an unknown tool.
 *
 * Retrying is only meaningful because a reattached session keeps its id, and
 * because the daemon reconciles its sessions BEFORE it binds the port: anything
 * that gets a connection at all finds this session already adopted, rather than
 * a 404 that would end the run.
 *
 * NOTE ON EXIT STATUS: every path here ends 0, where the bare curl propagated
 * its own failure. That is deliberate — the CLI reads this hook's STDOUT, and
 * an empty body already means "no decision, use your own prompt", so a non-zero
 * status only adds noise to the agent's transcript. The cost is that a
 * genuinely broken hook is indistinguishable from a declined one; the daemon
 * log is where that distinction lives.
 */
function withRetry(
  curl: string,
  opts: { body?: boolean; quiet?: boolean } = {},
): string {
  const attempts = opts.quiet ? RETRY_ATTEMPTS_QUIET : RETRY_ATTEMPTS;
  // The replay of the body has to be INSIDE the command substitution:
  // `printf … | out=$(curl …)` pipes into the assignment, not into curl, and
  // leaves curl reading the hook's already-consumed stdin instead.
  const piped = opts.body ? `printf %s "$body" | ${curl}` : curl;
  const attempt = opts.quiet ? `${piped} >/dev/null 2>&1` : `out=$(${piped})`;
  const success = opts.quiet ? "break" : 'printf %s "$out"; break';
  return (
    (opts.body ? "body=$(cat); " : "") +
    "i=0; while :; do " +
    `${attempt}; rc=$?; ` +
    `[ $rc -eq 0 ] && { ${success}; }; ` +
    `i=$((i+1)); [ $i -ge ${attempts} ] && break; ` +
    `case $rc in ${RETRY_CODES}) sleep ${RETRY_DELAY_S};; *) break;; esac; ` +
    "done"
  );
}

const GATE_CURL =
  'curl -s -m 590 -X POST "$DRYDOCK_DAEMON_URL/hook/pretooluse" ' +
  '-H "Content-Type: application/json" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID" --data-binary @-';

const gate = {
  matcher: GATED_TOOLS,
  hooks: [
    {
      type: "command",
      timeout: 600,
      command: withRetry(GATE_CURL, { body: true }),
    },
  ],
};

// Report-only (DRY-49): tells the daemon what the agent is doing so the rail
// card can say "reading src/foo.ts" instead of showing a bare clock. It NEVER
// gates — it prints nothing, so the CLI reads no decision from it.
//
// Its matcher and the gate's must stay DISJOINT. Claude Code runs every
// matching hook for an event, and two hooks answering one PreToolUse is a race
// over whose decision wins.
const report = {
  matcher: REPORTED_TOOLS,
  hooks: [
    {
      type: "command",
      timeout: 5,
      command:
        'curl -s -m 3 -X POST "$DRYDOCK_DAEMON_URL/hook/activity" -H "Content-Type: application/json" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID" --data-binary @- >/dev/null 2>&1 || true',
    },
  ],
};

const common = {
  // When the agent ends its turn, tell the daemon so the pane shows "Your turn"
  // (DRY-18). Fire-and-forget: never block the agent from stopping. No matcher
  // — Stop has no tool to match on.
  Stop: [
    {
      hooks: [
        {
          type: "command",
          // Retries too (DRY-57). For an autonomous run this hook IS the ending
          // in practice — an interactive `claude` doesn't exit when it's done,
          // it hands the turn back — so a restart landing on it costs the run
          // its handoff document. Still fire-and-forget: it never blocks the
          // agent from stopping, and gives up quietly if the daemon stays away.
          timeout: 45,
          command: `${withRetry('curl -s -m 8 -X POST "$DRYDOCK_DAEMON_URL/hook/stop" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID"', { quiet: true })}; true`,
        },
      ],
    },
  ],
  // On startup, pull this session's ticket body (if any) as additionalContext.
  SessionStart: [
    {
      matcher: "startup",
      hooks: [
        {
          type: "command",
          timeout: 30,
          command:
            'curl -s -m 25 "$DRYDOCK_DAEMON_URL/hook/sessionstart" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID"',
        },
      ],
    },
  ],
};

/** Path passed to `claude --settings` for an ordinary supervised session. */
export const CLAUDE_SETTINGS_PATH = path.join(os.tmpdir(), "drydock-claude-settings.json");

/**
 * Same, plus the activity reporting hook, for autonomous runs.
 *
 * Two files rather than one because the reporting hook is not free: it spawns a
 * curl and makes a round trip before every Read, Glob and Grep an agent
 * performs, which is the most frequent thing it does. A supervised session
 * renders no rail card, so it would be paying that on every tool call to feed a
 * caption nothing displays.
 */
export const CLAUDE_SETTINGS_PATH_AUTONOMOUS = path.join(
  os.tmpdir(),
  "drydock-claude-settings-autonomous.json",
);

fs.writeFileSync(
  CLAUDE_SETTINGS_PATH,
  JSON.stringify({ hooks: { PreToolUse: [gate], ...common } }, null, 2),
);
fs.writeFileSync(
  CLAUDE_SETTINGS_PATH_AUTONOMOUS,
  JSON.stringify({ hooks: { PreToolUse: [gate, report], ...common } }, null, 2),
);
