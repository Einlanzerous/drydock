# Per-spawn environment variables (DRY-66)

`POST /api/sessions` forwards `body.env` to the PTY. The sink and the plumbing
were always there — `SpawnOptions.env` declared it and `session.ts` spread it —
and only the HTTP handler never read the field, so a caller with a per-spawn
value (a subtask key, a subpath scoping an agent to one subtree) had to compose
a file per run and smuggle its path through `args`.

Validated in `daemon/src/spawn-env.ts`, which is where the actual work is.

1. **Refused, not filtered.** The house pattern one field over is to ignore an
   unrecognised value (`permissionMode`), and that reasoning is explicitly "it
   can only ever loosen or tighten a run". This is the opposite: a value dropped
   in transit is a run that proceeds without the thing that was supposed to
   scope it — an agent on the whole repo because its subpath went missing
   between the POST and the PTY. Being inspectable is the entire reason to
   prefer this to the temp-file workaround, so silence is the one failure mode
   it cannot have. 400, with the key named.
2. **The deny set is not a security boundary and must not be sold as one.** The
   same body carries `command` and `args`; this port has always been remote code
   execution by design. What the list can hold is narrower: a caller may not
   reach the machinery the DAEMON runs the session with. `resolveSpawn` returns
   a BARE `claude`/`$SHELL`, and the DRY-27 hooks shell out to a bare `curl` —
   so `PATH` doesn't let a caller run something new, it changes what the
   daemon's own recorded command MEANS and what answers that session's
   permission gates. A run started under `manual` with a shimmed `curl` reports
   approvals nobody gave. `LD_*`/`DYLD_*` reach the same two binaries by another
   door; `NODE_OPTIONS`, `BASH_ENV`/`ENV`, `SHELLOPTS`/`PS4` and `IFS` the same
   for what the session then spawns. A longer list aimed at "dangerous" could
   only ever be the variables somebody remembered — every interpreter ships one.

   **The line is the test, and review found four keys on the wrong side of it
   that the first pass let through** — which is the argument for keeping the
   line sharp rather than the list long, since each was found by asking "does
   the daemon read this?" and not by brainstorming hazards:
   - `ALL_PROXY`. The hooks reach the daemon through a bare `curl`, so a proxy
     answers a session's own PreToolUse gate — the PATH harm without needing to
     replace a binary. Measured on curl 8.5.0: the UPPERCASE spelling is
     honoured (`HTTP_PROXY` is the odd one out, ignored by design because CGI
     turns a `Proxy:` header into it), and the key pattern admits exactly the
     spelling that works. The whole family is denied rather than the one key.
   - `HOME`. `resolveSpawn` runs a `shell` session as `$SHELL -l` — a LOGIN
     shell, which sources `$HOME`'s startup files, the same door `BASH_ENV` is
     denied for. It also moves `~/.claude/settings.json`, which claude merges
     on top of the `--settings` file that installs the gate hook.
   - `CLAUDE_CONFIG_DIR`. DRY-59 passes it through as host config, and
     `transcripts.ts` reads the DAEMON's copy under a comment stating that the
     two always agree and that this lookup answers for the wrong directory if
     they ever stop. Accepting it per spawn IS that divergence: the run comes
     back `transcriptMissing` and DRY-62 offers "Start again" over a
     conversation that exists — the direction that section calls worse.
   - `TERM`. Set by the daemon AFTER the caller's map is spread, so it was
     accepted, 201'd, and then overruled in silence. See trap 4: that is the
     one thing this channel may not do, and it was the last key that could.
3. **The other half is accident, and it is the case that will actually
   happen:** a consumer forwarding its own `process.env` wholesale to add one
   variable. Refusing turns "the agent ran with the caller's PATH and behaved
   strangely" into a 400 naming the key.
4. **Order is the safety property, in both places, and both were already
   right.** The daemon's own four keys are spread AFTER the caller's map
   (`session.ts`), so `DRYDOCK_SESSION_KEY` can't be reassigned by the thing it
   authenticates; DRY-59's strip runs last of all, over the merged result
   (`supervisor/main.ts`). `DRYDOCK_*` is refused anyway, because a key that is
   silently overridden is worse than one that is refused — and `TERM`, which
   review found still doing exactly that, is refused for the same reason. The
   harness's `TERM` case is the only route-visible test of this ordering: every
   other key it protects is one the route refuses before the spread is reached.
5. **Validate BEFORE the worktree block.** It is the only side-effectful step in
   the route — it creates a branch and checks out a worktree — so a guard below
   it leaves that work on disk for a spawn that never happened. Verified rather
   than asserted: against the unpatched route the harness's refusal case creates
   `agent/DRY-66` every time.
6. **A key DRY-59 strips is refused here too, with its own message.** It would
   otherwise be accepted, written to the sessions-dir index, and deleted three
   hops later without a word — the ticket flagged this as a documentation
   footnote, and refusing it is the version that doesn't need one. Hence the
   list moving to `supervisor/markers.ts`: two readers, one definition, and a
   marker added there is refused by the route automatically.
7. **Caps, because this is the first field on the route that invites a blob**,
   and there are two of them because they bound different things. The
   sanitizer's (64 keys / 4 KiB a value / 16 KiB total, counting the `=` and the
   NUL each `environ` entry costs) bound what is STORED — written to the index
   file, handed to `execve`. They cannot bound what was ALLOCATED to reach them,
   because the parse has already happened: that is the route's reader, which was
   the uncapped `readJson` until review pointed out this was a choice rather
   than a constraint. It now takes `readJsonCapped` at a deliberately generous
   1 MiB — generous because DRY-49's `input` prompt has no small bound, and
   trading a silent failure for a loud one nobody asked for is not an
   improvement. On the default `off` posture that allocation needs no
   credential, and since DRY-57 inverted the crash posture an OOM here takes the
   desk down rather than being ridden out.

Harness: `scripts/verify/spawn-env.mts`, rig in its README — no browser, no
database, seconds. It asserts on the PTY's own `env` output read back through
`/api/sessions/:id/file`, never on the 201: the daemon answered 201 to a body
carrying `env` for the whole time the field was being dropped, which is the bug.

