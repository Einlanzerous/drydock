// Drydock hooks, injected into every spawned `claude` via `--settings <file>`
// (DRY-12). This is how the approval (PreToolUse) and ticket-context
// (SessionStart) hooks reach the agent without each target repo having to add
// them to its own .claude/settings.json — they now work in *any* cwd, including
// repo-less projects that fall back to $HOME.
//
// `$DRYDOCK_DAEMON_URL` / `$DRYDOCK_SESSION_ID` stay as literal text in the
// command strings; they're expanded by the shell when the hook runs, from the
// session env the daemon injects (session.ts). We write the file once at
// startup and hand claude its path.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const SETTINGS = {
  hooks: {
    // Gate Bash through the daemon so a human approves in the UI. Widen the
    // matcher (e.g. "Bash|Write|Edit|WebFetch") to gate more tools.
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            timeout: 600,
            command:
              'curl -s -m 590 -X POST "$DRYDOCK_DAEMON_URL/hook/pretooluse" -H "Content-Type: application/json" -H "X-Drydock-Session: $DRYDOCK_SESSION_ID" --data-binary @-',
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
  },
};

/** Path to the generated settings file passed to `claude --settings`. */
export const CLAUDE_SETTINGS_PATH = path.join(os.tmpdir(), "drydock-claude-settings.json");

fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2));
