# Verifying autonomous runs (DRY-49)

An autonomous run's premise is that nobody is watching, so every failure mode
here is silent by construction. Use a throwaway daemon with the timeout turned
down — an hour is the right default and a terrible test:

```sh
DRYDOCK_PORT=4399 DRYDOCK_AUTONOMOUS_PERMISSION_TIMEOUT_MS=25000 \
  DRYDOCK_RUNS_ROOT=/tmp/runs DRYDOCK_TRACKER=fixture \
  node --import tsx src/index.ts

curl -s -X POST localhost:4399/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"claude","repo":"drydock","ticket":"DRY-1","autonomous":true,
       "input":"Run this exact bash command and nothing else: echo hi"}'
```

Then watch `/api/sessions`: `activity` fills in, `pendingPermissions` goes to 1,
and 25s later `failure` appears and `handoff` names a file.

**Verify all three permission postures**, because each one changes which tools
reach the gate at all (`DRYDOCK_AUTONOMOUS_PERMISSION_MODE`, or the launch
panel's picker):

| mode | Bash / WebFetch | Edit / Write |
|---|---|---|
| `manual` (default) | Drydock gate | Drydock gate |
| `acceptEdits` | Drydock gate | passes silently |
| `auto` / `bypassPermissions` / `dontAsk` | passes | passes |

`acceptEdits` needs the daemon's own check (`EDIT_TOOLS` in server.ts), not just
the flag: `PreToolUse` fires in *every* mode, so without it Drydock would raise
its own gate for exactly the edits the mode says to stop asking about — moving
the interruption rather than removing it.

**Then do it again with a prompt that WRITES a file, not one that runs Bash.**
A Bash-only probe cannot catch the worst failure this feature has: any tool the
`PreToolUse` matcher misses gets Claude Code's own TUI prompt drawn inside a PTY
with no window — no gate, no `pendingPermissions`, no timeout, no handoff, and a
card that reads "writing foo.ts" with the hairline marching forever. `hooks.ts`
gates every tool that prompts in `default` mode (`GATED_TOOLS`); if that list
ever drifts from Claude Code's, this is how it will present. It shipped that way
once and a Bash-only test passed cleanly over it.

The traps, all of them found the hard way:

1. **The prompt's RETURN must be a separate write.** Appending `\r` to the text
   puts it in the same read() and Claude Code's TUI treats the burst as pasted
   content: the prompt appears in the composer and the agent never starts. The
   card sits on "starting" forever and nothing errors.
2. **A run you stop on purpose is not a failure.** Signalling a process exits it
   129/143, so inferring failure from the exit code made every deliberate stop
   post *"failed — exited 129 … nobody was watching, please pick it up"* to the
   ticket. `failure` being SET is the only thing that means failed; `kill()`
   records `stoppedByRequest` instead.
3. **Kill removes the session from the registry synchronously**, so after
   `POST /kill` there is no `SessionInfo` left to read `handoff` off. Assert on
   the file, not the field.
4. **A failed run reaches two terminal states**, because denying the gate makes
   the CLI end its turn. The handoff is named for the run's START time so the
   second ending rewrites one document instead of leaving a trail.
5. **Don't test the tab title with one sample.** It alternates every 2s with the
   plain title on purpose (so it reads in a truncated tab), so a single read
   returns "Drydock" half the time.
6. **The claude trust dialog does not fire in a fresh WORKTREE** as of Claude
   Code v2.1.220 — verified deliberately, since it would wedge an unattended run
   at a prompt nobody can answer. That is narrower than "does not fire": a cwd
   claude has never seen (a scratch dir, a repo cloned somewhere new) *does*
   prompt, and the failure is worse than a wedge — the daemon's typed prompt
   lands in the dialog and its RETURN answers it, so the run starts with an
   empty composer and the card reads "starting" forever. A worktree of an
   already-trusted repo inherits the trust, which is why the normal path is
   clean. Test in one; if you use a scratch cwd, expect to answer it once.
   This note used to add that a daemon started from inside a claude session
   leaks `CLAUDE_CODE_CHILD_SESSION` and suppresses the dialog, so `env -u` the
   `CLAUDE_*` vars. **The dialog half is simply wrong** (DRY-59): re-measured
   against v2.1.220, an untrusted cwd prompted identically with the marker set
   and with it stripped, so that `env -u` was never buying a trust dialog. The
   leak itself is real, and costs a false negative for a different reason —
   transcripts (see [dry-59-inherited-markers.md](dry-59-inherited-markers.md)).
   Note the strip covers PTYs the SUPERVISOR spawns, so a `claude` you run by
   hand from inside a session still inherits everything: that re-measurement,
   and anything under `scripts/verify/`, are outside it.

Verify the tracker comment against **both** providers — it is the first thing
to exercise `comment()` on either. Switchyard against a throwaway ticket; Jira
against a stub asserting `POST /rest/api/2/issue/<KEY>/comment` with a plain
string `{body}` (v2 is chosen precisely so no ADF document is needed), plus the
fixture provider (`comment: false`) to prove the rail stands alone without one.

