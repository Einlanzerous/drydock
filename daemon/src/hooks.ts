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

const gate = {
  matcher: GATED_TOOLS,
  hooks: [
    {
      type: "command",
      timeout: 600,
      command:
        'curl -s -m 590 -X POST "$DRYDOCK_DAEMON_URL/hook/pretooluse" -H "Content-Type: application/json" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID" --data-binary @-',
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
          timeout: 10,
          command:
            'curl -s -m 8 -X POST "$DRYDOCK_DAEMON_URL/hook/stop" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID" >/dev/null 2>&1 || true',
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
