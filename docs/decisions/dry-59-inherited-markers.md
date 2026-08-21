# What a spawned agent inherits (DRY-59)

A daemon started from inside a `claude` session inherits that session's
`CLAUDE_CODE_*` markers, and they used to reach every PTY it spawned down three
hops of plain inheritance. `supervisor/main.ts` deletes them when it builds the
PTY env (`INHERITED_SESSION_MARKERS`); everything else, `ANTHROPIC_*` and
`CLAUDE_CONFIG_DIR` included, is host config and passes through.

1. **The bug cannot reproduce from a bare terminal**, which is where anyone
   would naturally test it — there is nothing to inherit, so the leaking build
   and the fixed one behave identically. Start the throwaway daemon from
   *inside* a claude session or the test proves nothing.
2. **It costs nothing you can see while the session is alive.** `CLAUDE_CODE_
   CHILD_SESSION` turns transcript persistence off, and DRY-57's durability,
   scrollback and reattach don't go through transcripts. The damage is entirely
   after the PTY dies: DRY-49 hands you a document saying "please pick it up"
   for a conversation `claude --resume` can no longer open, and DRY-56 files an
   `agent_session_id` pointing at nothing. So assert on the transcript
   (`<agent session id>.jsonl` appearing at all under
   `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<escaped-cwd>/` — that variable is
   deliberately NOT stripped, so on a host that sets it the file is not under
   `~/.claude` and a tester looking there concludes the strip is broken when it
   is working) and then on `claude --resume <id>` — not on anything the pane
   shows.
3. **`meta.env` cannot express this.** It overlays keys onto `process.env` and
   has no way to remove one; setting a marker to `""` guesses at how the CLI
   tests it. Hence the strip in the supervisor rather than a new entry there.
4. The list is targeted rather than a `CLAUDE_CODE_*` prefix sweep, because the
   CLI takes real host config under that prefix too (`CLAUDE_CODE_USE_BEDROCK`,
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`). Re-read it off the CLI binary if an upgrade
   changes behaviour — **and not off `env` in the shell you are testing from**,
   which is the mistake the first version of this list made. A plain terminal
   cannot contain the variables only an IDE integrated terminal exports, so a
   census of your own environment silently omits exactly the launch contexts you
   didn't happen to be in. `CLAUDE_CODE_SSE_PORT` was found that way, one review
   later: inherited, it points every spawned agent at the launching editor's MCP
   server, because `autoConnectIde` turns on when it is merely set.

