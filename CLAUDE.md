# CLAUDE.md

Drydock is a per-host daemon that owns AI-CLI PTYs (`claude`, plain shells) plus a
Vue 3 + xterm.js web shell that attaches to them. Sessions survive disconnects
because the daemon — not any client — holds the PTY master. See README.md for
architecture and features; docs/deploy.md for prod.

## Build & run

```sh
bun install        # installs both workspaces; postinstall builds node-pty under REAL node-gyp
bun run up         # daemon + shell together (+ Postgres when DRYDOCK_DB_LOCAL=1)
bun run daemon     # dev daemon  → :4317 (node --import tsx --watch)
bun run shell      # dev shell   → :5320 (Vite)
```

- **The daemon runs on Node, never Bun.** node-pty's addon uses the V8 C++ API;
  under Bun it loads and then segfaults on the first PTY spawn. The scripts
  already invoke `node` explicitly — don't "simplify" them to `bun`.
- Likewise node-pty must be compiled by **Node's** node-gyp; `postinstall` runs
  `node scripts/build-native.mjs` to do this. If PTY spawns crash after a
  dependency change, rebuild with that script — not `bun x node-gyp`.
- Typecheck: `bun run --filter '@drydock/daemon' typecheck` (and the shell build
  runs `vue-tsc`).
- `daemon/src/protocol.ts` is duplicated **verbatim** in
  `shell/src/lib/protocol.ts`. If you touch one, mirror the other.

## Sessions survive a daemon restart (DRY-57)

**This used to be the loudest warning in this file**, and it no longer is: a
save under `daemon/src/` restarts the `--watch` daemon, and the agents keep
running. Each PTY is held by its own detached supervisor process
(`daemon/src/supervisor/`), so the daemon is a client of its own sessions
rather than their parent. On boot it reconciles them from an index of small
files (`daemon/src/sessions-dir.ts`, `~/.drydock/sessions-<port>/`) and
reattaches, scrollback included.

What that changes in practice:

1. Editing `daemon/src/` in a checkout with live sessions is survivable. The
   daemon restarts; the agents don't notice; panes reconnect on their own.
2. `DRYDOCK_EXIT_ON_UNCAUGHT` now defaults to ON — a wedged daemon is pure
   cost when a restart is cheap. `=0` restores the old posture.
3. **Still don't restart prod (`:4318`) casually.** Reattach is very good, not
   free: an in-flight gate is re-raised (the hook curl retries), but the rail's
   action line resets, and a session whose supervisor is SIGKILLed alongside
   the daemon is still gone.

The rules that survive intact:

- **Never bump `PROTOCOL_VERSION` in `supervisor/wire.ts` casually.** A daemon
  refuses to drive a supervisor from a different build rather than misparse it,
  which strands live sessions until that supervisor's agent finishes. If you
  change a frame type or the meaning of a `SessionMeta` field, bump it and
  expect running sessions to become undrivable.
- **Test daemon changes on a second instance**, not by restarting :4317/:4318
  (next section). Reattach makes a restart recoverable, not free.
- The sessions dir is **per-port on purpose**: a throwaway daemon on :4399
  sharing it would adopt the dev daemon's live agents and reparent them to a
  process you're about to Ctrl-C.

## Verifying daemon changes: second-instance pattern

Run your changed code as a throwaway daemon on a spare port, with config passed
as env vars (real env always wins over `.env`; a fresh worktree has no `.env`):

```sh
cd <your-worktree>
bun install                       # worktree needs its own node_modules + node-pty build
cd daemon
DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts
```

Since DRY-57 a throwaway daemon leaves **detached supervisor processes** behind
if you Ctrl-C it — that is the feature working, and it means cleaning up after a
test run is now a real step. Kill by executable, not by pattern: `pkill -f
supervisor/main` also matches the shell command containing that string and will
kill your own session.

```sh
for p in $(pgrep -f "supervisor/main"); do
  case "$(readlink /proc/$p/exe)" in *node*) kill -9 "$p";; esac
done
```

**In that order — supervisors first, then the directory.** `rm -rf` on a
sessions dir with live supervisors in it doesn't stop them; it deletes the
socket and metadata that were the only handle on them, leaving processes that
no daemon can ever find. (Done it. The symptom is a supervisor whose `/proc/<pid>/fd`
shows its log as `(deleted)`.)

Smoke-test against it (`curl` from another terminal):

```sh
curl -s localhost:4399/healthz                 # {ok:true, sessions:N}
curl -s localhost:4399/api/sessions            # list; POST spawns (see server.ts)
curl -s localhost:4399/api/tracker/info        # active tracker provider
```

## Verifying workspace state (DRY-28)

Workspace state has two backends behind one interface (`daemon/src/state/`),
picked solely by whether `DRYDOCK_DATABASE_URL` is set. **Verify both** — the
file store is what a fresh clone and the single-host profile run, and it's the
one that gets forgotten:

```sh
# file store (the default)
DRYDOCK_PORT=4399 DRYDOCK_STATE_FILE=/tmp/state.json node --import tsx src/index.ts
# postgres — same code path a central database uses. db:up generates a password
# into .env on first run and writes DRYDOCK_DATABASE_URL beside it, which the
# daemon reads on its own (env.ts walks up), so no credential is typed here.
bun run db:up      # loopback :5433, deploy/compose.db.yml
DRYDOCK_PORT=4399 node --import tsx src/index.ts
```

```sh
curl -s localhost:4399/healthz                       # store: {kind, ok}
curl -s localhost:4399/api/workspace                 # {workspace: null} when unsaved
curl -s -X PUT localhost:4399/api/workspace -H 'Content-Type: application/json' \
     -d '{"version":2,"layout":"tile","windows":[]}'
curl -s -X DELETE localhost:4399/api/workspace
```

Non-negotiable properties, all of them regressions waiting to happen:

1. **A dead database never costs a PTY.** Stop the container mid-session: the
   daemon stays up, sessions stay running, `/healthz` reports `store.ok:false`,
   `/api/workspace` answers 503. Start it again and the store heals *without a
   daemon restart* — a restart is precisely what kills every live agent.
   `PostgresStore` migrates lazily for this reason; nothing connects at boot.
2. **`docker stop` is NOT a sufficient outage test.** It frees the port, so
   every connect fails instantly with ECONNREFUSED and any latency bug hides.
   A real partition — host up, packets dropped — costs `connectionTimeoutMillis`
   per attempt instead. That distinction concealed a live bug: the store's retry
   cooldown keyed off "have we migrated yet", so once the first migration
   succeeded it never engaged again and every request re-dialled a dead
   database for 5s, with the shell's restore blocking on one before it could
   draw. Test with a proxy that accepts and then goes silent, and assert on
   *timings*, not just status codes. The cooldown must be driven by the last
   failure of ANY operation.

   Two more bugs of that exact shape surfaced in DRY-58, both invisible to
   `docker stop`. **The proxy must also freeze connections it has already
   established**, not just refuse new ones — the pool keeps clients idle for
   30s, so a partition that only blocks new connects never happens at all.
   And once it does: `connectionTimeoutMillis` bounds *acquiring* a connection,
   not a query issued on one the pool already holds. Without `query_timeout` the
   daemon waits on TCP retransmits for minutes, `/api/workspace` never returns,
   and the route can't 503 what never resolves — so the cooldown never engages
   and every later request queues behind it. Same class on the shell side:
   `putWorkspace` needs its own budget, because a push that never settles neither
   succeeds nor throws, and the retry loop that awaits it goes quiet forever.
3. **The `pool.on("error")` listener is load-bearing** (DRY-45's bug class): an
   idle client dying emits `error`, and an unhandled `error` event throws. Delete
   that line and stopping Postgres kills the daemon.
4. **The daemon never parses `windows`.** That shape is the shell's (`Win`), and
   mirroring it here would be the protocol.ts tax on a payload we hand back
   unread. Validation is structural only.
5. **Prove it at the surface, not with curl.** The claim is "the desk follows the
   person", so the tests that matter are: wipe `localStorage` → reload → desk
   intact; and a browser profile that has never seen the desk → same desk. Both
   pass under the old localStorage design only by accident. Use the `verify`
   skill.
6. **An outage has to END on its own** (DRY-58). The shell re-reads on a backoff
   and flushes what you arranged during the outage — no reload, no restart. Test
   both halves separately, because they are different code paths: an outage that
   starts *after* a good read (the push failed, `mayPush` is open) and one that
   starts *before* it (`mayPush` never latched, so the client doesn't know what
   it would be overwriting).
7. **Test the conflict rule as a PAIR, or it proves nothing.** When the outage
   predates the first read and the daemon turns out to hold a desk: a client
   that arranged nothing must ADOPT the daemon's desk live, and a client that
   dragged a window must KEEP its own. Check only the first and you can't tell
   the rule from "remote always wins"; check only the second and you've deleted
   the data-loss guard `mayPush` exists for. A window appearing because the
   session poll found a PTY is not arranging — that's the from-scratch cascade
   desk, and treating it as intent is the bug.
8. **The notice is a condition, not an event.** One line while it holds, cleared
   by whoever raised it, never dismissible, never stealing focus
   (`composables/notices.ts`). Assert it appears exactly once across repeated
   failures — and measure focus across the notice APPEARING, not across the drag
   that caused it, or you're only proving that clicking a title bar moves focus.
9. **Migration drift is an error, and only ever costs the desk.** Editing an
   applied `.sql` must 503 with the file named while live sessions keep running;
   reverting the file must clear it with no ledger surgery; and a ledger row
   with a null checksum (written before DRY-58) must be adopted and logged, not
   reported as drift.

Properties 6-9 have harnesses — `scripts/verify/` (see its README), which is
where the partition proxies live. Run them against **both** tiers. They aren't
wired into anything and never run on install; they exist because the claims are
about latency and recovery, which curl can't express. Before trusting a green
run, confirm the harness still discriminates by pointing it at the unpatched
file (the README shows how) — a harness that passes either way is worse than no
harness.

## Verifying autonomous runs (DRY-49)

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
   transcripts (below). Note the strip covers PTYs the SUPERVISOR spawns, so a
   `claude` you run by hand from inside a session still inherits everything:
   the re-measurement below, and anything under `scripts/verify/`, are outside
   it.

Verify the tracker comment against **both** providers — it is the first thing
to exercise `comment()` on either. Switchyard against a throwaway ticket; Jira
against a stub asserting `POST /rest/api/2/issue/<KEY>/comment` with a plain
string `{body}` (v2 is chosen precisely so no ADF document is needed), plus the
fixture provider (`comment: false`) to prove the rail stands alone without one.

## What a spawned agent inherits (DRY-59)

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

## Verifying session durability (DRY-57)

The whole feature is a negative claim — "killing this does not kill that" — so
every test is: break something, then prove an agent didn't notice.

```sh
# short path: these are unix sockets, and the ABSOLUTE path must fit in ~100 bytes
DRYDOCK_PORT=4391 DRYDOCK_SESSIONS_DIR=/tmp/d57 node --import tsx src/index.ts
```

`kill -9` the daemon (not SIGTERM — SIGKILL is the case with no cleanup path),
then restart and watch for `session adopted after a daemon restart`. The
supervisor's `sid == pid` (`ps -o sid,pid`) is the proof it detached.

The traps, all found the hard way:

1. **A socket file outlives the process that bound it.** `fs.exists` cannot tell
   a live supervisor from a corpse; the only honest probe is to connect and
   treat ECONNREFUSED/ENOENT as stale. Getting this wrong either abandons a
   running agent or unlinks the one handle anything has on it.
2. **A liveness probe must cost nothing.** The supervisor stays silent until the
   client sends `Attach`; before that it greeted every connection, so each probe
   serialized the whole scrollback to a socket about to be dropped — paid twice
   per session on every boot, and logged as EPIPE.
3. **Reconcile BEFORE binding the port.** Otherwise the first `/api/sessions`
   of a restart honestly reports zero sessions, the shell reconciles away the
   windows for agents that are alive, and every retrying hook gets a 404.
4. **A replay is the WHOLE buffer**, so the pane must `term.reset()` before
   writing one or a reconnect prints the session's history twice. Assert on the
   count of a marker, not its presence.
5. **`--retry-connrefused` does not cover a held gate.** That connection is
   established, so a killed daemon RESETS it (curl exit 56), which plain
   `--retry` ignores. `--retry-all-errors` does cover it and also retries the
   `-m 590` timeout — which an autonomous gate is *supposed* to outlive, so it
   would raise a second gate for one tool call. Hence the hand-rolled loop over
   7|52|55|56 in hooks.ts. Test it with a server that accepts, holds, then
   closes with SO_LINGER 0.
6. **Buffer the hook body before retrying.** `--data-binary @-` reads stdin, and
   stdin is a pipe that can only be consumed once.
7. **A signalled child reports exitCode 0** with the signal alongside, so
   passing the raw code on tells the daemon a killed run finished cleanly — and
   for an autonomous run that is the difference between silence and a handoff.
8. **`pkill -f supervisor/main` kills your own shell**, because the command
   string contains the pattern. Filter on `/proc/<pid>/exe`.
9. **A killed session whose child ignores the signal is the resurrection case.**
   `/kill` drops it from the registry immediately and depends on the child
   dying for the index to be cleaned; a child that traps SIGHUP breaks that
   chain, and the next boot would adopt it back. `meta.killedAt` is written
   BEFORE the signal so reconciliation finishes the job, and the supervisor
   escalates to SIGKILL after a grace period so "kill" can't leave an
   unreachable orphan. Reproduce with
   `{"command":"/bin/sh","args":["-c","trap \"\" HUP TERM INT; while :; do sleep 1; done"]}`.
10. **A close with no preceding `error` is a different path from a reset.** A
   `destroy()`ed peer EPIPEs the outgoing write first, and that error disposes
   the link before `close` fires — so a test built on `destroy()` passes even
   against a link that mishandles `close`. Use a clean `end()` to exercise it.

## Resource cost, so nobody discovers it from `top`

One Node process per session (with the tsx loader) replaces N PTYs in a single
process — tens of MB RSS each — and scrollback is now double-buffered, once in
the supervisor's ring and once in the daemon's, each capped by
`DRYDOCK_SCROLLBACK_BYTES` (~1 MiB default). Both are the right trade for
sessions that survive a restart, but a host running twenty agents is running
twenty extra Node processes.

The reconciliation branch that is easy to forget: a run that ENDS while the
daemon is down. Kill the daemon, then `kill -9` the agent, then restart — the
supervisor flushed its transcript and exit record on the way out, so boot must
write DRY-49's handoff from them and then clean up. `meta.handoff` being set is
what stops the next boot writing a second one; the invariant is that an exit
record still on disk at boot means, and only means, that nobody was home.

## Verifying session history (DRY-56)

Database tier only, so **both backends have to be run** — the file store's
expected result is legible degradation, not parity.

```sh
docker run -d --name dry56-db -e POSTGRES_PASSWORD=… -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55440:5432 postgres:16-alpine
DRYDOCK_PORT=4392 DRYDOCK_DATABASE_URL=postgres://…@127.0.0.1:55440/drydock \
  node --import tsx src/index.ts
curl -s localhost:4392/healthz          # store.capabilities.sessionHistory
curl -s localhost:4392/api/sessions/history
```

Do NOT point a test daemon at the central Postgres on :5432 — provisioning a
role there is a construct-server change, deliberately out of scope (DRY-28/58).

1. **A tombstone needs the daemon to have FORGOTTEN the session, not just for
   it to have exited.** Killing a supervisor leaves the session listed with
   `status: exited`, and that pane is DRY-41's — its scrollback is still
   readable and a tombstone would hide it. The sequence is: kill the
   supervisor, *then* restart the daemon, which doesn't re-adopt a dead
   session. Getting this wrong renders a card over a live transcript.
2. **The inverse is the new regression.** Restart the daemon under a LIVE
   session: DRY-57 reattaches it, and it must not tombstone. A history row
   exists the moment a session ends, so any check that reads history without
   consulting the live session list will draw one.
3. **`exit_code` cannot say why.** A deliberate stop and a crash are both
   non-zero (129/137/143); `end_reason` is written while the daemon still
   knows. A tombstone reading "failed" for a window you closed is DRY-49's
   trap 2 in a new surface. Assert `stopped` from `/kill` and `failed` from a
   killed supervisor.
4. **The file tier must SAY so, and only when it costs something.** The notice
   is raised when a window is dropped for want of a record — not at startup,
   or a fresh no-database install carries a permanent line about a feature it
   never asked for. Check both: a fresh desk shows nothing; losing a session
   shows the line.
5. `agent_session_id` comes from the hook payload — verify against a real
   `claude` rather than assuming the field is there. It is captured before the
   ticket early-return in `/hook/sessionstart`, so a ticketless session records
   one too.
6. **An id is not a transcript** (DRY-62). That hook fires whether or not the
   CLI is persisting anything, so `agentSessionId` being set says only that a
   session started — every session a pre-DRY-59 daemon spawned recorded one
   against a transcript that was never written, and the card offered to reopen
   a conversation that doesn't exist. `/api/sessions/history` marks those
   `transcriptMissing` by looking (`daemon/src/transcripts.ts`), and the gate
   is one predicate in `lib/daemon.ts` because the card and the spawn both ask
   and had drifted apart once already.
   - **Scan for the id; do not derive the path from the record.** Claude Code
     names its project directories by escaping the cwd, and the record's `cwd`
     is not where a ticket session ran anyway — `worktree` is. Get either wrong
     and the flag is set for sessions that DO have a transcript, which takes
     Resume away instead of the reverse. Session ids are UUIDs; a flat index of
     them can't collide.
   - **"Couldn't look" is a third state, not a "no".** An unreadable transcript
     directory must leave the flag unset, or one bad permission strips Resume
     from every card on the desk. Test it by taking the directory away, not by
     reasoning about it.
   - Harness: `scripts/verify/tombstone.mjs`, rig in its README. Assert the
     label AND the args the click sends — they're computed in different files,
     and a card that says "Start again" while still passing `--resume` is the
     same bug in better copy.

## Clearing finished sessions (DRY-60)

A session that ends stays in the registry — a terminal state has to survive
until somebody sees it — and seeing it used to be the only thing that cleared
it, one window and one card at a time. Two dozen autonomous runs finishing is
two dozen dismissals over overlapping windows. So a run that ended **cleanly**
now clears itself, and the header grows a `Clear finished` button that does the
lot at once.

**The daemon does none of this.** `DRYDOCK_CLEAR_FINISHED_AFTER_MS` is served
over `/api/config` and applied by the shell, because a sweep has to know what is
on screen, which window has focus, and whether anybody is looking at the tab.
The daemon goes on listing every exited session, so a browser that wasn't open
still finds them.

```sh
DRYDOCK_PORT=4360 DRYDOCK_CLEAR_FINISHED_AFTER_MS=8000 \
  DRYDOCK_STATE_FILE=/tmp/dry60-state.json node --import tsx src/index.ts
# then: sleep 1 finishes, exit 3 fails, `while :; do sleep 1; done` never ends
curl -s -X POST localhost:4360/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"/bin/sh","args":["-c","sleep 1"],"autonomous":true,"title":"ok"}'
```

Five minutes is the right default and a terrible test — the same trap DRY-49's
timeout has. Harness: `scripts/verify/sweep.mjs`, rig in its README, and it
refuses to run against a delay over 30s rather than pass by waiting.

The traps:

1. **The clock must measure time IN FRONT OF SOMEBODY, not time since the run
   ended.** Otherwise a desk opened in the morning sweeps everything that
   finished overnight on its first poll, and the runs are gone before the
   countdown rendered once — deleting the notification instead of the clutter.
   Stamps are taken only while `document.visibilityState === "visible"` and
   dropped when it isn't. Test it by faking the property and firing the event;
   actually backgrounding a headless tab throttles the 3s poll to once a minute
   and you end up testing Chromium.
2. **The focused window gets NO clock, not a restarting one.** Refreshing its
   stamp every tick also works, and renders a window that sits there saying
   "clears in 1m" forever while never clearing. Deleting the stamp is what makes
   the countdown absent, which is the honest signal that it isn't going anywhere.
3. **Whatever sweeps must remove the window CLIENT-SIDE.** Kill the session and
   let `reconcile` notice, and on a history tier every swept window comes back as
   a DRY-56 tombstone — the "third dismissal" — while on the file tier each one
   raises "a window that closes can't be resumed" for a removal that was
   deliberate. There is a poll between the kill landing and the window going, so
   reconcile also has to skip ids that are mid-clear; it is not enough to remove
   the window afterwards.
4. **A workspace's agent exiting does not finish the workspace.** It binds a
   second PTY with no window of its own, and clearing the window kills both — so
   a finished agent beside a live zsh must be left alone, and the zsh must never
   be swept on its own account either (it has no window to remove). This is the
   "bulk clear that takes a running agent with it" the ticket warns about, and
   it is the one exemption a mixed desk is needed to catch.
5. **A run somebody STOPPED never reaches this code**, which is why `isFinished`
   only has to tell finished from failed: `/kill` removes it from the registry
   synchronously, so the only exited sessions a client ever sees are the two.
   Deriving "stopped" from the exit code here would be DRY-49's trap 2 again.
6. **`num()` in config.ts rejects 0**, deliberately — for a cap it's a typo. For
   a delay whose 0 means "never sweep" that silently restores the default and the
   off switch does nothing, hence `msOrOff` beside it.
7. The notice belongs to the AUTOMATIC path only. The ✕ and the button are
   somebody choosing to discard something; a line explaining what they just chose
   is noise. And it has to *ask* the tier rather than assume — `historyKept` is
   demand-driven, so on a desk that has never lost a window it is still null at
   the first sweep, and a bare `=== false` stays quiet on exactly the tier the
   notice exists for.

## Verifying the ticket brief (DRY-53)

What a spawned agent is told about its ticket: `tracker/context.ts` turns a
`TicketDetail` into the `additionalContext` the SessionStart hook returns. It
carries the description, the comment thread, and the nearest epic's key.

**Claude Code truncates `additionalContext` past 10000 characters and says
nothing about it.** Measured against v2.1.220 — 10000 arrives whole, 10001 does
not — and what survives is the FRONT. This is the single fact the feature is
designed around, so re-measure it before assuming a brief arrives:

```sh
# hook that emits N chars with a marker at the very end
claude -p --settings <hook.json> "Answer in one word: is TAILTOKEN present in \
  your session-start context?"
```

The traps:

1. **Appending is the bug.** Comments after a description put the newest
   information past the cut, so the feature ships delivering exactly none of
   what it was built for. It presents as total success: the daemon sends the
   whole brief, the hook returns 200, and only the agent knows. Caught by
   asking a spawned agent to quote its newest comment — it answered "zero
   comments shown" while the daemon had sent four. Hence the budget, the
   thread's reserved slice, and the announced truncations.
2. **Note this predates DRY-53**: a >10 KB description was already being cut
   mid-sentence with nothing said. Any change that grows the brief inherits
   this.
3. **A brief-shaped test is not an agent-shaped test.** curl against
   `/hook/sessionstart` shows a perfect payload at any size. The only honest
   probe is a real `claude` that has to answer *from* the brief — spawn one and
   ask for the epic key, the comment count, and a verbatim quote of the newest
   comment.
4. **Comment bodies carry their own markdown headings**, several of which
   outrank any byline you could give them (`## What the design adds` is a real
   one here). They're wrapped in `<comment author=… at=…>` tags for that reason;
   a `###` byline reads as a new section of the brief instead of as somebody
   talking.
5. **Switchyard's single-ticket GET does not hydrate `parent`** — it returns
   `parent_id` as a bare UUID with `parent: null` beside it, while the LIST
   endpoint inlines the whole thing. So the one path that feeds an agent is the
   one that has to resolve the chain itself, one GET per rung.
6. **Jira pages the `comment` field oldest-first.** A deployment that returns a
   short page hands back the wrong end of the thread — worse than none, because
   it looks complete. The provider detects it via `total` and re-fetches from
   `startAt = total - N` rather than using `orderBy=-created`, which Cloud
   supports and older DC does not.

Both halves have harnesses (`scripts/verify/ticket-brief.mts`,
`tracker-getticket.mts`, in-process and seconds), because the failure is silent
by construction and curl can't see it. Neither replaces trap 3.

## Verifying the tracker sidebar (DRY-55)

The quietest failure the desk has. `/api/tracker/tickets` 502s when the daemon
can't reach the tracker, `loadTickets` keeps the last-good list — right on a
refresh — but on a FIRST load there is no last-good list, so the sidebar used
to render its ordinary "No tickets match.", which is also exactly what a
healthy tracker with nothing in scope says. Harness:
`scripts/verify/sidebar.mjs`, rig in its README.

1. **The two halves are separate tests.** An outage that starts before the
   first pull and one that starts after a good pull are different paths through
   the same `catch`, and only the first was ever silent. The second must KEEP
   its rows and merely mark them stale: replacing a working list with an error
   panel is a worse bug than the one being fixed, and a list that quietly stops
   updating is how somebody spawns an agent against a ticket that closed an
   hour ago.
2. **`.row` is not a DOM assertion you can use here.** Repo groups render
   collapsed, so a full sidebar and an empty one both report zero rows — a
   check built on it passes against the bug. Assert on `.grp` or the header
   count.
3. The line above the desk is DRY-58's notice, so its rules hold: raised once
   however many polls fail, cleared by whoever raised it, never dismissible.
   A tracker outage must NOT reach the red banner — that one belongs to the
   session poll, and the daemon is fine.

## Verifying a tracker provider (Switchyard / Jira)

The tracker is host config; the browser only ever sees `/api/tracker/*`.
Checklist, using the second-instance pattern above with the provider's env:

```sh
# Jira Cloud: email + API token → Basic auth
DRYDOCK_PORT=4399 DRYDOCK_TRACKER=jira \
  DRYDOCK_JIRA_URL=https://yourco.atlassian.net \
  DRYDOCK_JIRA_EMAIL=you@yourco.com DRYDOCK_JIRA_TOKEN=... \
  DRYDOCK_TRACKER_PROJECTS=SRE,SREREV,SREDESK \
  node --import tsx src/index.ts

# Jira Server/DC: personal access token ALONE (Bearer) — no email
```

Always set `DRYDOCK_TRACKER_PROJECTS` against a corporate tracker (DRY-30) —
unscoped, the sidebar query pulls every open ticket in the instance. Note the
boolean params are literal `true`, not `1`.

1. `curl -s localhost:4399/api/tracker/info` — provider id/name/capabilities +
   the configured default `projects`.
2. `curl -s "localhost:4399/api/tracker/tickets?open=true"` — the sidebar
   query: scoped to the default projects, backlog excluded; exercises search
   pagination (Cloud `/search/jql` + nextPageToken vs DC `/search` + startAt —
   the probe/fallback and every other Cloud/DC divergence is documented in
   `daemon/src/tracker/jira.ts`'s comments; read them before debugging).
3. `curl -s "localhost:4399/api/tracker/tickets?open=true&backlog=true"` — now
   backlog-bucket tickets appear too (the sidebar's `backlog` toggle).
4. `curl -s "localhost:4399/api/tracker/tickets?open=true&projects=SRE,FOO"` —
   explicit scope overrides the env default (the sidebar's added chips).
5. `curl -s "localhost:4399/api/tracker/search?q=<text>"` — palette/search
   query; project-scoped, but spans all statuses.
6. `curl -s "localhost:4399/api/tracker/tickets?project=<KEY>&open=true"` —
   single-project JQL clause.
7. `curl -s "localhost:4399/api/tracker/ticket/<KEY>"` for a ticket that HAS a
   component — `repo` must be the component slug (lowercase, spaces→dashes,
   DRY-31), not the project key; a component-less ticket falls back to the
   lowercased project key.
8. Epics (DRY-13), on the query from step 2 — the one WITHOUT `backlog=true`:
   every `type: epic` in scope must still come back, and each must carry
   `childStats` counting **all** its children by category. Both are easy to
   regress into something that looks fine:
   - Epics are exempted from the backlog exclusion, so a provider that folds
     the exemption into the wrong clause silently drops exactly the epics whose
     work hasn't started — the ones a child is left orphaned under. Assert an
     epic you know is in the backlog appears with `backlog=false`.
   - `childStats` must NOT come from the loaded tickets. Counting those is free
     and always wrong: the pull excludes done, so every epic reads 0-done. The
     numbers must move when the tracker moves and not when the toggle does.
   - Non-epics must have no `childStats`, and the palette (`/search`) must issue
     no child query at all — it has no `open` flag, so the pass must not fire.
   - Jira answers every epic in one `parent in (…)` search; Switchyard has no OR
     in its list filter, so it's one request per epic, through a small pool
     (`CHILD_STATS_POOL`). Bounding the epic *count* does not bound concurrency:
     each one is a cursor chain, so an unpooled fan-out opens dozens of them per
     sidebar refresh, per browser.
   - **A capped count must be abandoned, not truncated.** The child query spans
     every status, so `MAX_TICKETS` is reachable on an ordinary corporate Jira
     (20 epics × 100 children). Truncating leaves `childStats` present and
     wrong, and the shell renders it as authoritative — "13/40 done" when the
     truth is 13/78. Both providers bail instead. Drive it with a stub that
     always returns another page and assert `childStats` comes back UNSET.
   - Two queries here are allowed to fail and must stay harmless: `parent` isn't
     queryable on older Jira DC (child stats 400 — swallowed), and
     `issuetype = "Epic"` doesn't validate on an instance with no type named
     that, localized or renamed. The second is the dangerous one because it sits
     in the sidebar's *critical path*: unhandled it means an empty sidebar where
     one previously worked. It downgrades to the plain clause on a first-page
     400 and latches (`epicClauseUsable`), so the probe is paid once.
9. End-to-end: point a browser at the dev shell, switch it to the throwaway
   daemon port, open a ticket, **Send to agent** — verifies repo→cwd resolution
   (`DRYDOCK_REPOS_ROOT` / `DRYDOCK_REPO_PATHS`, keyed by component slug for
   Jira) and the SessionStart context injection.

There are no automated tests yet — these curls plus a ticket-spawn are the
regression suite. Don't claim a provider works until they all pass against a
real instance.

## Config

All host config is env vars, optionally via a gitignored `.env` at the checkout
root (`daemon/src/env.ts` walks up from cwd; real env wins). `.env.example`
documents every knob; `daemon/src/config.ts` is the source of truth. Secrets
never go in the repo or an image.

## Prod

`deploy/install-prod.sh` maintains a pinned checkout at `~/.drydock/prod` and a
systemd **user** unit `drydock-daemon` on `:4318`; the shell is an nginx
container from GHCR on `:5321`. Deploy = rerun the script with a ref. Details in
docs/deploy.md. Treat the prod daemon like dev: it owns live PTYs, so don't
restart it to test things.

## Conventions

- Branch `dry-NN-short-slug` off `main`; PR to `main` on
  `Einlanzerous/drydock` (public).
- **Conventional Commits** (DRY-38): release-please computes versions from
  them, so commit subjects must be `feat:` / `fix:` / `docs:` / `chore:` /
  `refactor:` (optionally scoped: `feat(daemon): …`) with the ticket in the
  subject tail — e.g. `feat(daemon): resolve repo from Jira component (DRY-31)`.
  Breaking change → `feat!:` or a `BREAKING CHANGE:` footer. Non-CC subjects
  are invisible to release math.
- Tickets live in the DRY project (Switchyard at home; fixture data otherwise).
  When the tracker is reachable, attach the PR URL to its DRY ticket on open —
  the poller auto-closes the ticket on merge, so don't close it by hand.
- **CI on a PR is a compile gate only** (DRY-52, `.github/workflows/pr-checks.yml`):
  the daemon typecheck, the shell's `vue-tsc -b && vite build`, and a check that
  the two `protocol.ts` copies haven't drifted. There are no automated tests, so
  green means "it compiles" — everything above in this file is still verified by
  hand. CI installs with `--ignore-scripts` (no node-pty native build) because
  nothing there spawns a PTY. Both checks are **required** on `main` (ruleset
  "main: compile gate"), with admin bypass — so a red PR is merged on purpose,
  not by inattention. The workflow has no path filters on purpose: a required
  check that never reports on a docs-only PR would leave it unmergeable.
- Comment style: explain *why* and the non-obvious constraint (see
  `daemon/src/tracker/jira.ts` for the house style); reference the DRY-NN
  ticket that introduced a behavior.
