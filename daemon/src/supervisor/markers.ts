// Which environment variables never reach a spawned PTY (DRY-59).
//
// Split out of supervisor/main.ts by DRY-66 so there is ONE list. The strip
// itself still happens in the supervisor, last and after everything else, which
// is the safe order — but once `POST /api/sessions` began forwarding a caller's
// `env`, the route needed the same list in order to REFUSE a key it would
// otherwise accept and silently drop three hops later. Two copies would drift
// into exactly that: a route accepting what the supervisor deletes, presenting
// as a variable that arrives nowhere.
//
// Deliberately dependency-free. main.ts is kept small on purpose — it owns the
// PTY master and should have the fewest reasons to fail — so what it imports
// has to stay cheap.

/**
 * Markers that say "a claude session started this process" (DRY-59).
 *
 * A daemon launched from inside a `claude` session inherits these, and they
 * reach the PTY down three hops of ordinary inheritance — nothing does it on
 * purpose. The spawned agent then believes it is its launcher's child process
 * rather than a session of its own, and quietly changes behaviour: with
 * `CLAUDE_CODE_CHILD_SESSION` set, transcript persistence is OFF.
 *
 * Nothing about a LIVE session notices — durability, scrollback and reattach
 * (DRY-57) don't go through transcripts. What breaks is everything after the
 * PTY dies: `claude --resume` on the agent, which is the whole point of
 * DRY-49's "nobody was watching, please pick it up" handoff and of the
 * `agent_session_id` DRY-56 records against a run. Measured: an agent spawned
 * by a leaking daemon wrote no transcript at all, and the same spawn with
 * these keys deleted wrote one that `--resume` reopens.
 *
 * Stripping rather than setting `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`,
 * which would buy back the transcript and leave the agent still claiming to be
 * a child of a session that has nothing to do with it — one symptom treated,
 * with the next one to hang off the same marker arriving silently. It also
 * makes a dev daemon behave like a prod one, where the systemd unit inherits
 * no interactive shell and none of this was ever set. (The leak was ALSO
 * believed to suppress claude's trust dialog — DRY-49's trap 6. It doesn't, on
 * v2.1.220: an untrusted cwd prompts identically with the marker and without.)
 *
 * The list is targeted, not `CLAUDE_CODE_*`-prefixed, because that prefix is
 * also how the CLI takes host config a spawned agent legitimately needs
 * (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, …). `ANTHROPIC_*`
 * and `CLAUDE_CONFIG_DIR` are host config for the same reason and stay.
 *
 * Read off v2.1.220, and grouped below by WHERE, because "what was set in the
 * shell I happened to test from" is not a method that can find these: an
 * interactive terminal cannot contain the variables only an IDE terminal sets,
 * so an env-dump census comes up short by exactly the cases it can't observe.
 * Re-derive from the binary, not from `env`, if a CLI upgrade moves things.
 */
export const INHERITED_SESSION_MARKERS = [
  // What the CLI injects into every child process it spawns.
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
  // What its own "build a clean env and spawn a fresh claude" helper deletes.
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  // Set by the launching session, and per-session by nature.
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  // The IDE extension's port for its MCP/SSE server, exported into the
  // integrated terminal. Inherited, it is an address: `autoConnectIde` turns on
  // when it is merely SET, so every agent a daemon launched from an IDE
  // terminal spawns would dial back to the launcher's editor. Not observable
  // from a plain shell, which is why it was missed on the first pass.
  "CLAUDE_CODE_SSE_PORT",
  // NB not `ENABLE_IDE_INTEGRATION`, though the extension exports it too: the
  // string does not occur anywhere in the v2.1.220 binary, so a spawned claude
  // cannot act on it. Stripping it would be decoration in a list whose whole
  // claim is that every entry was checked against the CLI that reads it.
];
