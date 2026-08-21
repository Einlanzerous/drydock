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
  runs `vue-tsc`). `scripts/` is checked separately — `bun run typecheck:scripts`
  (DRY-80) — and is itself TWO projects: `scripts/tsconfig.json` for the Node
  half and `scripts/tsconfig.browser.json` for the Playwright half. The split is
  load-bearing rather than tidy: the browser harnesses need the DOM lib, and the
  in-process ones import real daemon modules, so one combined project would
  check `tracker/cache.ts` against both the DOM's and `@types/node`'s `fetch`.
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
   action line resets. This used to end "and a session whose supervisor is
   SIGKILLed alongside the daemon is still gone", which sounded like a caveat
   about unlucky timing and was in fact a description of **every prod deploy**
   — see DRY-87 below.

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

"Real env wins" has a bite when the tester is an agent Drydock itself spawned:
the session inherits the daemon that started it, so a "throwaway" started from
inside one runs with the **prod** `DRYDOCK_DATABASE_URL`, `DRYDOCK_AUTH_PASSWORD`
and tracker token, and a fresh worktree having no `.env` says nothing about it.
The tell is `/healthz` answering `store.kind: "postgres"` when you passed a state
file, or an anonymous request 401ing. Strip them rather than overriding one at a
time — the set is not fixed:

```sh
env $(env | grep -o '^DRYDOCK_[A-Z_0-9]*' | sed 's/^/-u /' | tr '\n' ' ') \
  DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
  DRYDOCK_STATE_FILE=/tmp/s.json node --import tsx src/index.ts
```

Since DRY-57 a throwaway daemon leaves **detached supervisor processes** behind
if you Ctrl-C it — that is the feature working, and it means cleaning up after a
test run is now a real step. Kill by executable, not by pattern: `pkill -f
supervisor/main` also matches the shell command containing that string and will
kill your own session.

**And filtering on `/proc/<pid>/exe` alone is not enough either, because every
supervisor on the host passes it.** The dev and prod daemons' supervisors are
the same `node` binary as your throwaway's, so a loop that only checks the exe
kills live agents belonging to daemons you are not testing — including the one
holding the terminal you are typing in. (Done it, mid-ticket, from inside a
Drydock session: the cleanup ended the session running the cleanup.) Add the
throwaway `DRYDOCK_SESSIONS_DIR`, which is in every supervisor's argv because
that is where the metadata file it was started with lives, and is unique to your
daemon for the same reason that directory is per-port.

**Both filters, not one instead of the other.** The sessions-dir match on its own
puts the self-kill straight back: the shell running this loop has BOTH
`supervisor/main` and the directory in its own command line — they are literals
in the command — so it matches `pgrep` and then matches the grep. The exe test
is what excludes it, because that shell is `zsh` and a supervisor is `node`.

```sh
for p in $(pgrep -f "supervisor/main"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    tr '\0' ' ' < /proc/$p/cmdline | grep -q "/tmp/d79/" && kill -9 "$p";;
  esac
done
```

**In that order — supervisors first, then the directory.** `rm -rf` on a
sessions dir with live supervisors in it doesn't stop them; it deletes the
socket and metadata that were the only handle on them, leaving processes that
no daemon can ever find. (Done it. The symptom is a supervisor whose `/proc/<pid>/fd`
shows its log as `(deleted)`.)

Stopping the throwaway **daemon** needs one filter more than that, because its
pattern is not distinctive: `pgrep -f "src/index.ts"` matches the shell wrapper
running your own cleanup command — same class as `pkill -f supervisor/main`
above, and it kills the command midway, leaving the rest of the rig up — and on
a host where several worktrees each run a daemon, exe alone can't tell yours
from another agent's. Match on exe AND cwd:

```sh
for p in $(pgrep -f "src/index.ts"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    case "$(readlink /proc/$p/cwd)" in *<your-worktree>*) kill "$p";; esac;;
  esac
done
```

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

## Verifying who may use the daemon (DRY-27)

Three postures, and **all three have to be run** — they are different code
paths, not settings of one:

| `DRYDOCK_MULTI_USER` | `DRYDOCK_AUTH_PASSWORD` | `DRYDOCK_DATABASE_URL` | mode |
|---|---|---|---|
| unset | unset | either | `off` — every request is `DRYDOCK_OWNER`, what shipped before |
| unset | set | either | `single` — one account, no database needed |
| set | set | **required** | `multi` — accounts in Postgres, a desk each |

```sh
PW=whatever-you-like-8-plus       # a throwaway daemon, so any string will do
DRYDOCK_PORT=4394 DRYDOCK_HOST=127.0.0.1 DRYDOCK_AUTH_PASSWORD="$PW" \
  DRYDOCK_STATE_FILE=/tmp/s.json node --import tsx src/index.ts
curl -s localhost:4394/api/auth/info            # {mode, multiUser, needsSetup?}
curl -s localhost:4394/api/sessions              # 401 + authRequired
TOK=$(curl -s -X POST localhost:4394/api/auth/login -H 'Content-Type: application/json' \
        -d "{\"password\":\"$PW\"}" | jq -r .token)
curl -s -H "Authorization: Bearer $TOK" localhost:4394/api/sessions
```

The traps:

1. **`off` is the default and has to stay the default.** A fresh clone, `bun run
   up`, and the isolated single-host profile all run with no credential — so the
   first thing to check after touching this is that a daemon with nothing set
   still answers anonymously and the shell still draws its desk. A login form on
   a daemon that has no accounts is a prompt nobody can satisfy.
2. **No database means no multi-user, and asking anyway must FAIL THE BOOT.**
   Accounts live in `store.users`, which is undefined on the file tier — the
   same derived-capability trick as `SessionHistory` (DRY-56), so there is no
   branch anywhere that could grant a second account without Postgres. The
   check is in `index.ts` before `server.js` is even imported, because a static
   import is hoisted: the daemon would otherwise bind its port and adopt every
   live session before deciding it shouldn't have started. Degrading to
   single-user instead would be worse than the error — nobody re-reads a log
   line that says "ignoring DRYDOCK_MULTI_USER".
3. **A database outage may not sign anybody out.** This is DRY-28's
   non-negotiable property applied to identity: tokens are stateless HMAC
   (`auth/tokens.ts`), so nothing is read to verify one, and the multi-user
   epoch check falls back to a cached record rather than to a locked desk. Test
   it by stopping the container mid-session — `/api/sessions` keeps answering,
   spawns keep working, and only a NEW login 503s (with a message saying so, not
   "wrong password"). Note the store's retry cooldown means recovery takes up to
   30s after the database returns; that is DRY-58's, not this ticket's.
4. **Two transports cannot carry a header, and they are the two that matter.**
   `EventSource` has no API for one and the browser `WebSocket` constructor has
   none either, so both take a short-lived `stream` token in the query string.
   That audience is refused on every other route — check it, because the whole
   reason for the split is that a URL is where a credential ends up in a proxy
   log:
   ```sh
   ST=$(curl -s -X POST -H "Authorization: Bearer $TOK" localhost:4394/api/auth/stream-token | jq -r .token)
   curl -s -H "Authorization: Bearer $ST" localhost:4394/api/sessions   # must 401
   curl -s -m 1 "localhost:4394/api/events?token=$ST"                   # must stream
   ```
5. **The hooks are not the browser.** A spawned CLI curls back into a daemon
   that now refuses anonymous requests, so each session carries its own key
   (`DRYDOCK_SESSION_KEY`, injected into the PTY env and recorded in the
   sessions-dir metadata). It opens `/hook/*` and NOTHING else — deliberately,
   because the agent can read its own environment, and the one thing it would
   most like to do with a credential is answer its own permission gate. Verify
   both halves: a hook POST without the key 401s, and the key does not work on
   `/api/sessions/<id>/permission`. A session with NO key recorded is let
   through on purpose — that can only be one spawned by an older daemon, and
   refusing it would mean an upgrade silently breaks every live agent's gates.
6. **The failed-login delay is a DELAY, not a lockout.** A lockout on a daemon
   holding somebody's live agents is a denial of service anybody can trigger
   from outside — the owner is locked out of their own running work by a
   stranger typing the wrong password. Note also that the plaintext credential
   is hashed with scrypt at first use rather than compared as a digest: a
   `DRYDOCK_AUTH_PASSWORD` checked with two SHA-256s made the DEFAULT way of
   turning auth on the cheapest to brute-force, and made the concurrency cap on
   the route — justified out loud by scrypt's cost — guard a path that wasn't
   paying it.
7. **Rotating the credential must end the sessions it issued.** There is no
   users table on the single tier to hold a token epoch, so the CONFIGURED
   credential is its own epoch (`credentialEpoch`). Derive it from the env value
   and never from the scrypt hash computed at boot — that hash has a fresh salt
   each time, so it would sign everybody out on every `--watch` restart. Test
   both directions: same password across a restart keeps you in, a changed one
   does not.
8. **Ownership only applies under multi-user.** Both directions strand things
   otherwise, and only one of them is obvious. Turning it ON: every session
   spawned under `off`/`single` recorded `owner: DRYDOCK_OWNER` — a real value,
   so the "no owner means yours" heal doesn't cover it — and becomes invisible
   AND unkillable. Hence `adoptSessions`, the runtime twin of `adoptOwner`.
   Turning it OFF again: sessions carry uuid owners and the viewer is the
   constant, same result. Hence `ownershipApplies()`.
9. **Removing an account must not strand its agents.** An account id is the only
   handle anything has on its sessions, so deleting one mid-run leaves live
   agents nothing can list, attach to or kill. Refused with a count.
10. **Setting somebody else's password is takeover, not administration.** The
   flat model means anybody can add or remove an account — a removal is
   something you NOTICE. A password change is silent, and afterwards their desk,
   their history and their agents' transcripts are yours. Own account only, and
   the current password is required even then: a token in a browser somebody
   left open must not be enough to lock the owner out.
11. **An empty string is not an absent field.** The single-account login form
   doesn't show a name (it is host config), so the browser posts `name: ""` —
   and `body.name ?? CONFIG.auth.user` passes that straight through to a
   comparison that can only fail. It read as "wrong name or password" for the
   correct password. `||`, and only on the tier where defaulting makes sense.
12. **Turning multi-user on must not lose the desk you had.** Everything saved
   before accounts is owned by the constant `DRYDOCK_OWNER` ("local"), so the
   first account ADOPTS those rows (`adoptOwner`) at bootstrap. Skip it and the
   feature presents as "my workspace and all my session history are gone" — the
   rows are still there, just under a name nobody logs in as. Test the upgrade
   path specifically: save a desk with auth off, restart with multi-user on, log
   in, and the desk must be the same one.
13. **Seeding the owner from env, not from a first-run screen.** This port is
   reachable from the LAN by default, and a "claim this Drydock" form on an
   unclaimed instance is a race whoever finds it first wins.
14. **Public runs are watchable, not controllable.** They are also not
   BROWSABLE: `/api/sessions/:id/file` reads an arbitrary path under the
   session's working directory, which the agent need never have opened, so it is
   gated on ownership rather than visibility. `visibility: "public"` puts
   a session on everyone's rail; the attach socket opens for them and every
   frame that would CHANGE the session is dropped (`mayDrive` in server.ts).
   Gates are the exception that isn't: they go only to the owner, since a panel
   whose buttons 404 is worse than no panel, and the tool input rides along with
   them. Check that a spectator gets no ✕ on the card and a `read only` tag on
   the pane — a control that reports a failure every time it is pressed is how
   this feature would actually ship broken.
15. **`kill` stayed idempotent.** An unknown id still answers `{ok:true}`
   (DRY-60's sweep and the ✕ race each other by design); only a session that
   exists and isn't yours is refused, and it is refused as "unknown" so this
   doesn't become a way to enumerate other people's sessions.

**Assert on what ARRIVED, never on what rendered.** Both of this harness's
central claims shipped in a form that could not fail: the SSE check selected two
class names that exist nowhere in the shell (the real banner is `.offline`) and
ran before anything was on the rail, where that banner is suppressed anyway; and
the WebSocket check waited for an `.xterm` element, which `term.open()` creates
on mount whether or not a socket ever opened. Both now assert on bytes that only
the transport under test could have delivered — a gate raised through the hook
endpoint appearing as a panel, and a marker the PTY prints appearing in the
terminal's rows. (This used to add "use output that CONTINUES", because a
spawn's replay was always empty — the daemon's ring started when it bound the
supervisor and only an adopt pulled the earlier buffer across, so a one-shot
echo looked like a broken socket. **That was the bug, not a rule**: DRY-79 has
the spawn path take the replay too, and a marker printed once now arrives.
Output that continues is still the safer probe for a check about auth, since it
does not depend on this.)

Harness: `scripts/verify/auth.mts`, rig in its README — a browser, three
daemons, about a minute. Run it when touching `daemon/src/auth/`, the route
guard in `server.ts`, or `shell/src/lib/auth.ts`. The claims it holds down are
all about what the SHELL does with a 401, which curl cannot see: a shell that
ignored auth entirely would render its desk, poll every three seconds, and show
a banner about the daemon being unreachable.

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

## Per-spawn environment variables (DRY-66)

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

## A deploy keeps the agents (DRY-87)

Everything above about sessions surviving a restart was true of the daemon
PROCESS dying and false of the way prod is redeployed. `deploy/drydock-daemon.service`
set no `KillMode`, so systemd's default `control-group` applied: `systemctl --user
restart` — the last line of `install-prod.sh`, so this is what EVERY deploy did —
SIGTERMed every process in the unit's cgroup. Measured on the prod host
mid-deploy, that cgroup held the supervisors, their `zsh -l`s, a live `claude`,
its MCP server, and an `amber serve` from a worktree. `KillMode=process` in
`[Service]` is the fix.

1. **`setsid` does not leave a cgroup, and that is the one hole in DRY-57's
   design.** Detaching is about process trees — its own session, its own process
   group, `unref`ed — and cgroup membership is inherited across fork regardless.
   So every reassurance in the DRY-57 section is about the wrong axis from
   systemd's point of view: the daemon is not the supervisors' PARENT, and they
   are still in its cgroup. Anything else that reasons about "detached" as
   though it meant "out of reach" is worth re-checking against this.
2. **NOT `mixed`, which is the tempting middle.** It SIGTERMs the main process
   only but still SIGKILLs the whole cgroup once `TimeoutStopSec` expires — so
   it costs exactly the agent that is slow to exit, which is the one most likely
   to be mid-task.
3. **"The first deploy is already safe" is a systemd claim, so measure it.**
   `install-prod.sh` runs `daemon-reload` BEFORE `restart`, and the whole story
   depends on whether a changed `KillMode` reaches an ALREADY-RUNNING unit on
   reload or waits for the next start. Measured on systemd 255 with a transient
   unit that forks a detached child: the reload applies, the pre-reload child
   survives the restart, and subsequent restarts spare it too. Expect journal
   lines saying `Unit process N remains running after unit stopped` — those are
   the supervisors, and they are the point.
4. **`stop` is not `restart`.** Stopping the unit now leaves supervisors running
   with nothing to adopt them until it starts again. Right for a deploy, wrong
   for a host being shut down for real — stop the agents first.
5. **The unit pinned an ephemeral node path, and it is a divergence rather than
   a host-wide fact.** `install-prod.sh` rendered `$(command -v node)`, which
   under fnm is `/run/user/1000/fnm_multishells/<pid>_<ts>/bin/node` — a
   directory made for the shell that ran the deploy and reaped with it. The
   supervisors were never affected: `SupervisorLink.spawn` uses
   `process.execPath`, which is `/proc/self/exe` and so fully resolved. The unit
   now resolves the same way (`node -p process.execPath`) and REFUSES a `/run`,
   `/tmp` or `/dev/shm` result rather than rendering it. Prod was pinned to a
   shell that had exited days earlier and survived only because nothing had
   reaped the directory; the tell would have been a host that came back from a
   reboot with no daemon and a deploy log saying it was healthy.
6. **`Environment=PATH` is the same bug and worse in kind**, because every
   spawned agent and shell inherits it: a deploy from an odd shell quietly
   changes what `claude`, `git` or `bun` resolve to inside every session. An fnm
   directory there is MAPPED onto the resolved node's directory rather than
   dropped — that is where the toolchain lives, so dropping it would take
   `npm`/`corepack` with it — and anything else ephemeral is dropped with a line
   saying so.
   - **The loop that does it is fed `printf '%s\n'`, and the `\n` is the whole
     thing.** Without it `read` sets `entry` on the final field — which has no
     delimiter after it — and then returns non-zero, so the body never runs and
     the LAST directory on PATH is dropped. Silently, because the announcement
     lives in the body that was skipped. This shipped in the first version of
     the fix and review caught it: `~/.local/bin`, `~/.bun/bin` and `/snap/bin`
     are all common last entries, so it was this section's own bug, arriving
     through the change that adds this section. The harness now ends its
     doctored PATH with something distinctive and asserts it survives — and note
     WHY it missed the first time: that PATH ended in the duplicate `/usr/bin`,
     so the entry the bug ate was the one the dedupe check watched, and
     `duplicates collapse` passed whether or not any dedupe existed. **Two
     properties need two entries.**
7. **A deploy is run from inside the cgroup it restarts**, because a Drydock
   session is the obvious place to run one from. `install-prod.sh` re-execs
   itself under `systemd-run --user` when it finds `drydock-daemon.service` in
   its own `/proc/self/cgroup`. Note this does NOT become unnecessary once the
   fix is in: the unit installed is rendered from the ref being DEPLOYED, so
   `install-prod.sh v0.1.0` puts a pre-DRY-87 unit in place and then restarts
   under it. The forwarded PATH is deliberately verbatim — sanitising is the
   renderer's job, and a stripped PATH would take node and bun away from the
   deploy itself.
8. **A failed render must not truncate the unit it was refusing to replace.**
   `render_unit >"$UNIT_FILE"` truncates before the render can fail, so the
   guard added in trap 5 would leave a host holding a zero-byte unit — unable to
   start its daemon ever again, arrived at by a script declining to make things
   worse. Rendered to `.new` and moved into place; the harness asserts a refusal
   prints nothing on stdout, which is the property that makes the redirect
   dangerous in the first place.
9. **One renderer, called twice.** `DRYDOCK_DEPLOY_PRINT_UNIT=1
   deploy/install-prod.sh` prints the unit this host would get and exits,
   touching nothing — it exists because the fragile values come from the
   deploying shell's environment, so "what would this shell install?" is worth
   being able to ask before finding out at the next reboot, and because a
   harness that substituted the template itself would be verifying its own copy
   of the logic.

Harness: `scripts/verify/prod-restart.mts`, rig in its README — it owns a
throwaway systemd unit, needs no browser or database, and takes about thirty
seconds. Its control case runs every time and asserts the OLD behaviour still
kills supervisors; confirm it discriminates by commenting out `KillMode=process`
in the template, against which it fails 8 of 40. Note what still passes in that
run: the daemon is up, healthy and answering with every agent on the host
destroyed. That is why this needed a harness and not a curl, and why it hid
behind a "healthy on :4318" line for the whole of DRY-19 to DRY-87.

## A session's first output (DRY-79)

Everything a PTY printed between starting and its pane attaching used to be
lost — not in the pane, not in the daemon's scrollback, and so not in any later
reattach either. `PtySession.adopt` took the supervisor's buffered replay;
`PtySession.spawn` bound the link without reading it. The two paths had differed
since DRY-57, and `spawn` now seeds the same way.

The window is real and it is the daemon's, not the supervisor's. `pty.spawn`
runs before `listen()` in `supervisor/main.ts`, and the daemon then polls for
that socket every `SPAWN_POLL_MS` (25ms) before it can dial and send Attach.
Measured here: spawn→listen **1-2ms**, listen→attach **5-47ms**. So reordering
the supervisor to bind first — the obvious fix, and the one the ticket asked to
consider — would close about a twentieth of it. Left alone deliberately; the
daemon's poll is the term that dominates, and a socket bound before the PTY
exists gives `greet()` a `child` to report that isn't there yet.

1. **How much is in that window is not "a few frames".** A quiet session leaves
   11 bytes; five concurrent chatty spawns measured 57-193 KB each; a session
   printing 300 KB in a burst can finish entirely inside it, which presented as
   a pane that was empty and stayed empty. `session spawned` logs `replayBytes`
   now, so this is answerable from a log rather than by instrumenting.
2. **Take the replay, not the sizes.** `adopt` also takes `hello.cols`/`rows`
   because the last client negotiated them; at spawn the request's own
   dimensions are the newest thing anybody has said. Copying that half across is
   invisible today — the supervisor initialises its size from the meta the
   daemon just handed it, so the hello echoes the request back — which is
   exactly why it needs saying rather than testing.
3. **A 201 was never evidence, and neither is a busy session.** The route
   answered 201 and `/api/sessions` listed a healthy session throughout. A
   command that keeps printing also looks fine, because the socket catches it
   live; only output that STOPS distinguishes the two. That is why this survived
   DRY-57 to DRY-79 and why the DRY-27 harness note above worked around it
   instead of reporting it.
4. **Seed the ring in `bind`, not in its callers.** The bug WAS a caller that
   forgot — `adopt` seeded, `spawn` didn't — so the fix that only adds the line
   back leaves the same hole open for a third construction path. `bind` is the
   one thing both do.
5. **A seeded buffer has to be CHUNKED before it enters the ring.** `onData`'s
   trim is whole-chunk and guarded by `scrollback.length > 1`, so a seed
   installed as one buffer survives until the first live byte pushes the ring
   over cap and then goes entirely, in a single `shift()`. Measured on a 200 KB
   ring seeded to ~199 KB and then sent 50 KB: **51,010 bytes retained as one
   buffer against 186,006 chunked**. It bites hardest on an adopt, and the
   pre-attach block is always the oldest chunk there is.
6. **`replayBytes` is the SEEDED count, not `scrollbackBytes`.** `bind` flushes
   the link's `pendingData` on its way past — output that shared a TCP segment
   with Ready — so reading the ring after it reports the window plus some live
   output, on the log line the sizing decision above is made from.
7. **The exit CODE goes missing in the same window, and costs more.** A session
   that ends before the daemon dials broadcast its Exit frame to an empty client
   set; the socket the daemon then dialled closes 250ms later with nothing left
   to say, and the daemon concluded `-1`. So a `printf` that exited 0 was a
   FAILED run: a failure card, DRY-49's handoff, a tracker comment saying nobody
   was watching, and `endReason: failed` on DRY-64's stream. `SupervisorLink`
   now reads the exit record the supervisor flushes BEFORE it broadcasts, and
   keeps `-1` only for a supervisor that left nothing behind. Same misreading as
   DRY-49's trap 2 and DRY-56's trap 3, reached from the other side.
8. **DRY-49's settle timer can't see seeded output either.** It is driven from
   `onData`, which a seed never passes through, so a CLI whose banner finished
   inside the window and then went quiet waits out the 15s ceiling instead of
   the 1.2s settle. `scheduleInitialInput` arms it when the ring is already
   non-empty.

Harness: `scripts/verify/spawn-replay.mts`, rig in its README — a throwaway
daemon, no browser, under a minute. Confirm it discriminates: against the
unpatched `spawn` it fails 7 or 8 of 17, the variance being whether the attach
lands inside the bulk case's burst or after it.

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
   - Harness: `scripts/verify/tombstone.mts`, rig in its README. Assert the
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
timeout has. Harness: `scripts/verify/sweep.mts`, rig in its README, and it
refuses to run against a delay over 30s rather than pass by waiting.

Note the two surfaces render the same countdown at different resolutions on
purpose: the rail card counts seconds off its own 1s clock, the window frame
says whole minutes because it is driven by the 3s poll and a seconds display
there would visibly skip. Below a minute the frame says `<1m` rather than
rounding up — a frame reading "clears in 1m" beside a card reading "0:05" is two
surfaces contradicting each other, which is what any turned-down delay (every
harness run) would otherwise show.

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
3. **`wm.focusedId` is not "the window somebody is in", so the exemption can't
   read it.** It is assigned synthetically in three places: `remove()` hands it
   to the first non-minimized window in ARRAY order when the focused one goes,
   `add()` claims it for every window reconcile cascades in, and `minimize()`
   leaves it pointing into the dock. Any of those lands the exemption on a
   window nobody has ever clicked — and since the exemption is permanent, the
   desk then keeps one dead window forever and the pile starts growing again.
   `userFocusedId` tracks intent instead. Test it by seeding a desk and clicking
   NOTHING: `apply()` focuses the top-z window, and both finished windows must
   still clear.
4. **A docked window has no surface that could warn it.** `dockItems` carries no
   status tag and a non-autonomous session has no rail card, so sweeping one is
   the only removal on this desk that can happen with no countdown anywhere —
   and it contradicts the rail's stated contract for that lane ("you put them
   here and you're coming back; they never change unless you touch them"). The
   sweep skips minimized windows; `Clear finished` still counts and takes them.
5. **The rail HIDES the countdown by density, which is backwards — and the
   obvious fix trades it for something no better.** `.meta` is `display:none`
   from four cards up (`.card.compact .meta`) and `loud` is false for
   `finished`, so the number vanished at exactly the crowd the feature exists
   for. The first fix widened a counting-down card instead (tile 112px →
   compact 176px) so the clock had room on row 1 beside the id. That is
   **horizontal overflow wearing the same clothes**: `.underway` is a single
   non-wrapping `overflow-x: auto` row, so at a 1500px viewport ten cards went
   from wanting 1383px of a 1208px lane to wanting 2023px — two cards off the
   right-hand edge became five. And the sort is `loud`-first, so `finished`
   cards go LAST: the ones pushed past the clip are precisely the ones counting
   down. Rendered-and-off-screen is not an improvement on hidden. What works
   instead is that below full density the countdown takes the card's **second
   row** — the action line's, which crowding has already emptied — so it costs
   no width, keeps the word "clears" even at 112px, and cannot collide with the
   id because they are on different rows. Measure any change here against the
   LANE's rect, never the card's: `getClientRects()` is non-empty for an element
   an ancestor clips, so a card entirely off-screen looks fine from inside.
6. **Whatever sweeps must remove the window CLIENT-SIDE.** Kill the session and
   let `reconcile` notice, and on a history tier every swept window comes back as
   a DRY-56 tombstone — the "third dismissal" — while on the file tier each one
   raises "a window that closes can't be resumed" for a removal that was
   deliberate. There is a poll between the kill landing and the window going, so
   reconcile also has to skip ids that are mid-clear; it is not enough to remove
   the window afterwards. **And the mid-clear set is not sufficient on its own**,
   because it only covers the span from the kill being issued to the window being
   forgotten. A `listSessions()` issued BEFORE that span and landing after it
   sees neither end of it: the guard is already released and the session is still
   in the list it carries, so reconcile re-adds the window at a cascade position
   and gives it focus, for a PTY that is dead. Hence the epoch pair in `App.vue`
   — one retiring a superseded refresh, one retiring a list a teardown has
   invalidated. Narrow on loopback and ordinary against a remote daemon, and
   `clearFinished` calls `refresh` itself while the 3s poll may already have one
   in flight, so two are genuinely concurrent.
7. **A workspace's agent exiting does not finish the workspace.** It binds a
   second PTY with no window of its own, and clearing the window kills both — so
   a finished agent beside a live zsh must be left alone, and the zsh must never
   be swept on its own account either (it has no window to remove). This is the
   "bulk clear that takes a running agent with it" the ticket warns about, and
   it is the one exemption a mixed desk is needed to catch.
8. **A run somebody STOPPED never reaches this code**, which is why `isFinished`
   only has to tell finished from failed: `/kill` removes it from the registry
   synchronously, so the only exited sessions a client ever sees are the two.
   Deriving "stopped" from the exit code here would be DRY-49's trap 2 again.
9. **`num()` in config.ts rejects 0**, deliberately — for a cap it's a typo. For
   a delay whose 0 means "never sweep" that silently restores the default and the
   off switch does nothing, hence `msOrOff` beside it.
10. The notice belongs to the AUTOMATIC path only. The ✕ and the button are
   somebody choosing to discard something; a line explaining what they just chose
   is noise. And it has to *ask* the tier rather than assume — `historyKept` is
   demand-driven, so on a desk that has never lost a window it is still null at
   the first sweep, and a bare `=== false` stays quiet on exactly the tier the
   notice exists for.

## The event stream carries exits (DRY-64)

`GET /api/events` (DRY-50) carried gates and nothing else, so a session ending
was WebSocket-only — and anything that merely wanted to know a run had finished
either held a socket per session purely to hear it, or polled `/api/sessions` on
a timer and read one field off every record. It now also carries `session-exit`:
`sessionId`, `status`, `exitCode`, `endReason`.

```sh
curl -sN localhost:4399/api/events &          # leave it running
curl -s -X POST localhost:4399/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"/bin/sh","args":["-c","sleep 1; exit 3"]}'
# → data: {…,"status":"exited","exitCode":3,"endReason":"failed"}
```

1. **It hangs off `SessionEndNotifier`, never `onRunEnd`.** That one is gated on
   `autonomous` inside `announceRunEnd`, by design — DRY-49's artefacts are for
   the runs nobody watched — so an exit event wired there fires for a fraction of
   sessions and looks like it works. Exactly the trap DRY-56 named when history
   took this notifier instead.
2. **Don't look the session up in order to filter it.** `/kill` drops it from the
   registry the moment it signals (DRY-60 trap 8), so by the time the child
   actually goes, `manager.get(id)` is undefined — and that exit is precisely the
   one somebody is waiting on. The notifier hands the session over; ask it. The
   check is a killed session emitting at all (`exitCode: 129`), not a clean one.
3. **`visibleTo`, not `ownedBy`** — deliberately looser than the gate filter
   beside it. A gate is a question only its owner can answer and it carries the
   tool's input; an exit is three fields a spectator on a public run can already
   read off `/api/sessions`, and withholding it leaves their card marching
   forever. Test both halves under multi-user, since only one of them is a leak:
   a stranger's private run must stay silent, a public one must arrive.
4. **`endReason` rides along, because `exitCode` is not a verdict.** Signalling a
   process exits it 129/137/143, so a consumer inferring failure from the number
   reports every deliberate stop as a crash — DRY-49's trap 2 and DRY-56's trap
   3, which is now this surface's too and worse here: `/kill` has already
   dropped the session, so unlike a card or a tombstone there is no record left
   to correct the impression. It comes from `ending()`, the accessor that exists
   for exactly this, and the wire type is `SessionEndOutcome` — the persisted
   `SessionEndReason` minus `unknown`, which a live ending cannot be. One
   definition, in protocol.ts, with `state/types.ts` extending it.
5. **There is no catch-up frame, and the reason is not that nothing is missed.**
   `gate-snapshot` exists because a resolution that fires while the stream is
   down is gone; an ordinary exit leaves the session in the registry, so a
   consumer that missed the frame still finds it terminal in `/api/sessions`.
   The exception is worth saying out loud rather than papering over: a KILLED
   session is dropped synchronously, so that frame is everything the stream and
   the list will ever say — miss it and the session is merely absent next poll,
   with no code to be had. A database tier still files a history row; the file
   tier has no such surface, so don't lean on it. Tolerable only because a kill
   is something a client asked for.
6. **"Reconcile can't reach a stream" is true of one path, not of reconcile.**
   Boot records history directly for a session rebuilt by `adoptExited`, which
   is finished before the port binds. The `meta.killedAt` re-kill branch is the
   counterexample: it leaves its link OPEN by design, so its exit can land well
   after the port is up and does emit — for an id no client has ever listed.
   That frame is correct, not stray, and any similar claim here needs checking
   against that branch before it is written down.
7. `GET /api/sessions/{id}` was folded into this ticket and deliberately **not**
   built. The only reason anything polled it was to learn about exits, so the
   event retires the route with the loop; adding it would be a second surface
   answering a question that no longer needs asking. Note the stream carries no
   session-*start* either, and needn't: a consumer learns the id of the session
   it spawned from the 201, which is the wishlist's whole loop ("spawn an agent,
   wait for it to exit"). Watching for OTHER clients' spawns is still a poll —
   a different feature, and nobody has asked for it.

## The terminal's clipboard keys (DRY-71)

`Ctrl+Shift+C` copies, `Ctrl+Shift+V` pastes, and `Ctrl+C` is still SIGINT.
One `attachCustomKeyEventHandler` in `TerminalPane.vue`, which is the only
place a `Terminal` is constructed. Harness: `scripts/verify/clipboard.mts`,
rig in its README — a browser, about 30 seconds.

1. **`navigator.clipboard` is not available where this runs.** It needs a
   secure context; prod is `http://<host>:5321` (docs/deploy.md). Anything
   written against it works on a dev box at localhost and silently does nothing
   in prod, which is the worst split available. Use clipboard EVENTS —
   `document.execCommand("copy")` dispatches a real `copy` at the focused
   helper textarea and xterm's own listener answers it with the selection.
   The harness takes the API away from the page so this can't regress quietly.
2. **A Linux dev box hides the case that matters.** xterm mirrors a MOUSE
   selection into that textarea to feed X11's PRIMARY selection, guarded by
   `Browser.isLinux` (`SelectionService.refresh`), so on Linux there is always
   a selection lying about and `queryCommandEnabled("copy")` is true for
   reasons that have nothing to do with the terminal. On Windows there is none
   and it is false. Test it by forcing `navigator.platform` to `Win32` before
   the app loads — and assert the override TOOK, on the mirror itself
   (`textarea.value` empty, its selection range collapsed) rather than on
   `window.getSelection()`, whose treatment of a textarea selection is a
   browser-version detail that can read "empty" for the wrong reason. Measured
   on Chromium and Firefox: the `copy` event fires either way, so the bare
   `execCommand` is the primary path — but its boolean is READ, and a false
   answer retries through an off-screen textarea. A copy that silently does
   nothing has no surface to report on.
3. **Most of what the ticket described as broken already worked.** Measured
   against xterm 5.5.0: `Ctrl+Shift+V` and `Shift+Insert` pasted, `Ctrl+Insert`
   copied. xterm's ctrl branch requires `!ev.shiftKey` and the `ev.key &&
   ctrlKey` fallback maps only `_` and `@`, so ctrl+shift+letter produces no
   key and `_keyDown` returns before `cancel()` — the obvious fix of returning
   `false` for those two is a **no-op that reads like the fix**. Only
   `Ctrl+Shift+C` was ever broken, because no browser generates a `copy` event
   for it. Don't add a handler for a key without first pressing it.
4. **The handler runs for keyup and keypress too**, and `_keyUp` reads a
   `false` as "don't refocus" — so a handler that answers every phase copies
   three times and leaves the terminal blurred. Guard on `ev.type`, and on
   `ev.repeat` as well: the palette chord already had to (DRY-43).
5. **Match the letter with `chordLetter`** (`shell/src/lib/keys.ts`), shared
   with `isPaletteChord`. `ev.key` is what the LAYOUT produced, which is what a
   chord means; `ev.code` is the physical US-QWERTY position and belongs only
   in the `ev.key`-produced-no-Latin-letter fallback. OR-ing the two makes a
   Dvorak keyboard claim TWO chords — its own C and whatever now sits where
   QWERTY's C was, which there is `j`, i.e. the browser console.
6. `Ctrl+V` stays SYN and `Ctrl+C` stays SIGINT on purpose, so the harness
   asserts both POSITIVELY. Seeing the `^V` needs `stty lnext undef` in the
   probe shell, or the line discipline's literal-next eats it and the check
   passes against anything.
7. **Chrome's inspect-element accelerator is not reserved**, verified by hand on
   Chrome for Windows (headless cannot answer it, and the web is confidently
   wrong in both directions). `preventDefault` on `Ctrl+Shift+C` suppresses it
   while the keyboard is in a pane, and the same chord elsewhere on the desk
   still opens DevTools — which is why the pane claims it unconditionally
   rather than only when something is selected. Narrowing that puts the
   inspector back on exactly the empty-selection press somebody makes by
   mistake.
8. **A pane whose cwd does not exist is the cruellest false negative here.**
   The daemon records the cwd it was handed, so the frame renders `~/<dir>` and
   the pane attaches normally — the PTY dies immediately and every keystroke
   afterwards vanishes into what looks like a working terminal, which reads
   exactly like the clipboard being broken. The harness makes its own
   directories, and `attached()` refuses DRY-41's exit banner as well as the
   reconnect badge.

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

## Expanding an epic to its children (DRY-83)

The sidebar's pull excludes the backlog bucket (DRY-30) and exempts only the
**epics** in it (DRY-13), not their children. So an epic whose work hasn't
started arrives as a heading with nothing under it: the row went inert, tooltip
"no children to expand here", and the only way to reach the work was the backlog
toggle — which changes the pull for the whole sidebar, ~29 tickets to 250+, to
see inside one epic.

Expanding now issues its own query: `TicketQuery.parent` (a ticket KEY),
`/api/tracker/tickets?parent=KEY`, fetched once per epic on an explicit expand.

1. **Fetched children go THROUGH `groupTickets`, not around it.** They are
   merged into an `augmented` list that everything downstream reads instead of
   `props.tickets`. Splicing them in inside `rowsOf` — downstream of the
   grouping — cost two bugs with one cause, because anything bypassing the
   grouping bypasses every rule it enforces: a filter term matching only a
   fetched child DELETED it (the epic had no surviving row in the filtered set,
   so the node was dropped with the child inside it), and a child whose repo
   differs from its epic's rendered under the wrong repo heading, twice, instead
   of staying in its own group with a parent chip. `repo` is what resolves to a
   working directory, so that second one spawns an agent in the wrong checkout.
2. **The trigger is `toggleEpic`, never the render path.** A filter force-opens
   every epic (`isEpicOpen`), so a fetch driven off "is it open" fires one
   request per epic on every keystroke in the search box — DRY-72's per-poll
   fan-out, back one gesture at a time. `epicOpenCount` exists so the augmented
   list can be keyed by epic KEY without splitting `epicNodeId`'s composite id,
   and so `openEpicKeys` doesn't have to read `groups` — which is built from
   the augmented list, and would close the loop.
3. **Ask for OPEN children, not all of them.** It keeps the query bounded by
   live work rather than by years of closed tickets — the thing that makes the
   child-stats query cappable — and makes the row count equal the rollup's
   non-done segments, so the bar and the list can be checked against each other.
4. **Expandable and fetchable are different questions.** Expandable is "is there
   anything to show"; fetchable is "is there anything to go and GET", i.e.
   `childStats.total - done > node.children.length`. An epic whose open children
   are all in the pull is expandable and needs no request — firing one anyway is
   a tracker query per epic per click that can only return rows already on
   screen. Both derive from `childStats` and only when it's authoritative: the
   fallback rollup counts loaded children, so it would say nothing new.
5. **A re-pull must KEEP the rows it has.** Refresh forces past the cache
   (DRY-72 trap 3 — otherwise the one button somebody presses when they've
   stopped trusting the screen is answered from the memory that made it stale),
   and a forced pull waits. The fallback while it's in flight is the pull's own
   children, which for this epic is the empty set that made it inert — so
   dropping first empties the epic for a round trip and fills it again. The
   corollary is that "already loaded" cannot be the only guard on re-entry: kept
   rows must not make the error note's retry a dead control, and a force must
   not be swallowed by an in-flight ordinary pull, which is trap 3 inverted.
   Hence the error and force exemptions plus a per-key epoch.
6. **A fetch that succeeds with zero rows still needs a note.** `childStats` is
   on a 5-minute TTL, so it can promise children that have since closed; without
   one, that renders as an epic opening onto nothing — the exact state this
   ticket exists to remove, and indistinguishable from a broken fetch.
7. **`stale` has to ride this response too** (DRY-72 trap 2). The daemon answers
   from last-good during a tracker outage, so a fetch that "succeeded" says
   nothing about whether the rows are current, and the header's stale marker is
   about the LIST. Dropping the field makes an expansion — and a Refresh —
   during an outage look like a clean success.
8. **The daemon must not project-scope a parent query, or fan it out per
   project.** Switchyard's `listTickets` fans out one call per key in scope, so
   a parent query that reached it would issue the same query N times and
   concatenate the same rows; and scoping can only wrongly hide a child that
   lives in another project. Handled before both. Pass the query through whole
   otherwise — rebuilding it dropped `text`, which Jira honours, so one
   `TicketQuery` returned different sets per provider and the cache kept two
   entries for it.
9. **Switchyard costs an extra hop.** Its list filter is `parent_id`, a UUID,
   and the shell only ever has keys, so the provider resolves one first. Jira
   takes the key in JQL directly — and `parent` is unsupported on older DC,
   where `attachChildStats` swallows it; here it must NOT, or the expansion
   presents as an epic that opens onto nothing. Jira also has to SKIP the
   child-stats pass on a parent query: `parent` matches subtasks too, so a
   nested hierarchy would pay a second `parent in (…)` search per expansion for
   a rollup no child row draws.
10. **The header count reads the augmented set, both halves.** Against the pull
   it reads "0/5" while a fetched child sits on screen matching the filter — a
   header contradicting the rows beneath it. So expanding moves it, on purpose;
   the control that must not move is the backlog toggle, which is what widens
   the pull, and that is what to assert on.

Known limit, accepted rather than missed: an epic with more than `MAX_TICKETS`
OPEN children renders a truncated list, warned about in the daemon's log only.
Unlike a capped child-STATS count — which is abandoned, because a partial total
wearing an authoritative badge is a wrong number presented as a right one — a
partial list is still a usable list, and reaching 2000 open children under one
epic is not a shape worth threading a flag through the cache for.

Harness: `scripts/verify/epic-children.mts`, rig in its README — it needs
`STUB_DORMANT_EPIC=1`, which is off by default because every epic in the stub
costs another child-stats request and `tracker-cache.mts` asserts on those
counts exactly. Confirm it discriminates: against the unpatched shell it fails
10 of 21, including the row's real tooltip and the filter deleting the rows it
matched. Note the anti-fan-out section shipped VACUOUS in review: it typed a
term matching only the fetched children, which emptied the sidebar of epic rows
— and nothing can fan out from rows that aren't rendered, so it passed against
a fan-out and against the bug that deleted those rows. Any check on this surface
has to keep epic rows on screen to mean anything.

## Verifying the tracker sidebar (DRY-55)

The quietest failure the desk has. `/api/tracker/tickets` 502s when the daemon
can't reach the tracker, `loadTickets` keeps the last-good list — right on a
refresh — but on a FIRST load there is no last-good list, so the sidebar used
to render its ordinary "No tickets match.", which is also exactly what a
healthy tracker with nothing in scope says. Harness:
`scripts/verify/sidebar.mts`, rig in its README.

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

## The tracker pull is cached and coalesced (DRY-72)

Until this, nothing in the tracker path cached anything: `/api/tracker/tickets`
went straight at the provider, and the sidebar polls it every 20s **per browser
tab**. Measured against a corporate Jira (3 projects, ~225 open) one pull runs
**5.7-6s** — three cursor pages plus a `parent in (…)` child query — so the
browser's own 12s budget was tripping on ordinary load, and every abort left the
daemon still walking pages for a client that had stopped listening.

Now the daemon answers from memory and refreshes behind the response
(`daemon/src/tracker/cache.ts`), child stats sit on a much longer TTL, every
tracker request carries a deadline, and the shell's poll backs off and skips a
hidden tab. Knobs: `DRYDOCK_TRACKER_CACHE_MS`,
`DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS`, `DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS`.

Harness: `scripts/verify/tracker-cache.mts` + `stub-tracker.mts`, rig in its
README — and run `sidebar.mts` beside it, because this moved who reports an
outage. The traps:

1. **A plain TTL cannot work here.** The shell polls on a fixed interval, so a
   TTL shorter than it misses on every poll (one tab gets nothing) and a TTL
   longer than it just makes the sidebar staler without removing the wait.
   Stale-while-revalidate sidesteps the choice: the TTL sets how old data may
   be, not how long anybody waits. Only the first request after a daemon start
   still blocks.
2. **`stale` must ride the response, or DRY-55 dies silently.** Every one of
   that ticket's assertions hangs off the browser's `catch`, and a tracker
   outage no longer reaches it — the daemon answers 200 from last-good. Without
   the field the stale marker and the notice both stop appearing while every
   poll looks healthy. It is set only when a refresh FAILED, never merely
   because an entry aged out: an entry is stale by design for the fraction of a
   second between a poll noticing and the refresh landing, and a notice that
   flickers every 20s is worse than none.
3. **Refresh has to force past the cache** (`?fresh=true`), or the one button
   somebody presses when they've stopped trusting the screen is a no-op that
   still spins. A forced pull WAITS; a poll never forces, or the cache buys
   nothing. A forced refresh that fails still answers from last-good rather than
   throwing away a working list. **And forcing must not merely JOIN the flight
   already running** — that flight may have queried the tracker before the change
   you pressed Refresh to see, and at a ~6s fan-out against a 20s poll that's
   about a third of clicks. It queues one behind instead, at most one deep.
3a. **Staleness is reported by AGE as well as by failure**, because the cache
   removed a signal that used to be free. A tracker that is slow rather than
   broken — every request succeeding, the whole page-walk taking minutes — used
   to trip the browser's 12s budget and report. Now the browser is answered
   instantly and nothing fails, so without an age test the sidebar presents an
   arbitrarily old list as live. The per-request deadline does not help: it
   bounds one request, so N pages cost N × it.
3b. **Overlapping pulls in the SHELL are how the epoch guard becomes a silence.**
   A poll, a visibility wake and Refresh can all want one; two in flight means
   the older one's outcome is discarded on arrival, so if it was the one that
   failed, nothing reports. They queue through one entry point. Related: arm the
   next poll from a SETTLED pull, never alongside the pull it just started, or
   the delay reflects the failure count from before that pull landed — which
   shows up on recovery as a sidebar waiting out a two-minute interval it had
   just earned its way out of.
4. **Never cache a failure, and a cold key must still 502.** Serving last-good
   is right; inventing one is not. That's DRY-55's empty case one layer down.
5. **The child-stats query is the unbounded half.** It spans every status, so it
   grows with years of closed work rather than with what's on screen, and on an
   ordinary corporate Jira it can reach the 2000 cap (twenty sequential pages)
   only to be **abandoned** — maximum cost, zero value, every 20s, and until now
   silent. Both providers log it once per onset. The cache is shared rather than
   per-provider because the two ask differently (Jira: one query for every epic,
   so all-or-nothing; Switchyard: one per epic, so per-epic).
   - **Cache the "capped" verdict, not just the counts.** Skipping it leaves the
     most expensive query in the system running on every refresh — the pathology
     reduced in frequency rather than removed. It is not caching an error: it's a
     fact about the epic, and it expires like anything else.
   - **A boolean "already warned" latch is wrong in the Switchyard provider**,
     because `listTickets` fans out one nested call per project and each runs its
     own child-stats pass: a project with no capped epics clears the flag the
     previous project just set, and the once-per-onset line prints every refresh.
     Track the epic KEYS.
6. **The TTLs go through `msOrOff`, not `num()`** — DRY-60's trap 9. Zero means
   "no cache" for reproducing a tracker bug the cache would mask, and through
   `num()` a deliberate 0 silently restores the default.
7. **A caller's own deadline wins.** The brief's `extrasDeadline` is 6s and
   tighter for a reason; the new one is a backstop, not an override.
8. **Backoff may only ever LENGTHEN the poll interval**, or it breaks the
   `LIST_TIMEOUT_MS < TICKET_POLL_MS` pairing — which is load-bearing and fails
   invisibly (see the comment on the budget).
9. **A hidden tab must stop polling**, and not to save the browser a fetch —
   since the cache that fetch is a memory read. It's that a poll keeps the
   daemon's entry live, so a tab left open overnight is a background refresh
   against a corporate Jira every 20 seconds until morning.
10. **`proxy-tracker.mts` structurally cannot test any of this.** It sits between
   the browser and the daemon, so it never sees what the daemon does upstream —
   which is where every claim here lives. Hence a counting origin instead. And
   assert on request COUNTS and timings, never on the route's body: a 200 with
   the right tickets is exactly what the bug returned.
11. **Turn the TTLs down** — 20s is the right default and a terrible test, same
   as DRY-49's timeout and DRY-60's sweep delay. The harness measures the TTL it
   observes and refuses a run over 15s rather than passing by waiting. But note
   the child-stats TTL deliberately outlives a run, so its assertion is "at most
   one query", not "exactly one" — pinning it exact makes the file pass only on
   the first run after a daemon start.
12. **Clear the single-flight handle from a `.finally` attached by the CALLER, not
   from inside the flight.** A `finally` in the flight body runs synchronously
   when the body throws synchronously — before the caller has assigned the handle
   — which latches it on an already-settled promise: that key then never
   refreshes again AND is never evicted, since eviction skips anything in flight.
   Today the flight is an `async` method and cannot throw synchronously, so the
   obvious form is *accidentally* safe. Don't leave a correctness argument resting
   on that.
13. **The cache key must be exhaustive over `TicketQuery`, provably.** The route
   builds the query in a variable, so TypeScript's excess-property check cannot
   see a field left out — and a missing field doesn't degrade, it makes two
   genuinely different queries share one entry. It's typed as a total map over
   `keyof Required<TicketQuery>` so adding a field there fails the build in
   `ticketQueryKey`.
14. **A paging loop that can't make progress is now a wedged cache entry, not
   just a hot loop.** Jira Cloud's branch trusted `nextPageToken` while the DC
   branch stopped on an empty page, so a deployment returning an empty page WITH
   a token span forever — `out.length` never grows, so neither `MAX_TICKETS` nor
   the loop condition can end it. Before the cache each poll merely leaked
   another runaway loop; with it, the flight never settles, so the handle is never
   cleared and the entry is never reclaimed. Both branches guard on an empty page
   now. Any new paging loop needs the same.

## Verifying a tracker provider (Switchyard / Jira)

The tracker is host config; the browser only ever sees `/api/tracker/*`.
Checklist, using the second-instance pattern above with the provider's env.

**Turn the caches OFF for all of it** (DRY-72) — add
`DRYDOCK_TRACKER_CACHE_MS=0 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=0` to the env
below. This checklist tests the PROVIDER, and every curl in it now goes through
a cache that will happily answer the second one from the first. Steps 2-4 and 6
vary only the query params, so each is a distinct cache key and the first run of
each is honest — but re-run one inside the TTL and you are timing the cache.
Step 8 is the one that silently stops meaning anything: its whole assertion is
that `childStats` moves when the tracker moves, and against a five-minute child
TTL it won't for five minutes. That off switch exists for exactly this.

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
  the daemon typecheck, the shell's `vue-tsc -b && vite build`, the `scripts/`
  typecheck (DRY-80), and a check that the two `protocol.ts` copies haven't
  drifted. There are no automated tests, so green means "it compiles" —
  everything above in this file is still verified by hand. CI installs with
  `--ignore-scripts` (no node-pty native build, no Playwright browser download)
  because nothing there spawns a PTY or opens a page. Both checks are
  **required** on `main` (ruleset "main: compile gate"), with admin bypass — so
  a red PR is merged on purpose, not by inattention. The workflow has no path
  filters on purpose: a required check that never reports on a docs-only PR
  would leave it unmergeable.
- **Everything under `scripts/` is TypeScript** (DRY-80), with two recorded
  exceptions: `build-native.mjs` is the postinstall, which runs while the
  dependency tree is still being assembled and so cannot rely on a loader being
  installed, and `scripts/verify/drift.sh` orchestrates `docker` and `psql`.
  Copy the shape of the `.mts` neighbour with the same job. Two costs the
  conversion carries, both easy to trip over:
  - A Playwright `page.evaluate` body may not bind a **name** to a function.
    tsx's esbuild transform wraps those in a `__name(...)` helper that doesn't
    exist in the page, so a `const q = (s) => …` inside a body fails as
    `ReferenceError: __name is not defined` at a line that reads perfectly well.
    Anonymous inline arrows are fine, which is what makes the rule look
    optional. Write the helper out rather than passing the body as a string: a
    string dodges the transform but is opaque to tsc, which gives up the
    checking the conversion was for.
  - **`scripts/up.mts` runs on Node (`node --import tsx`), not Bun.** Bun
    auto-loads `.env` and `$`-expands the values, while this repo's own parsers
    (`daemon/src/env.ts`, and `loadEnv` in that file, which mirrors it) treat
    them literally. Since `loadEnv` skips keys already in `process.env`, under
    Bun the expanded value silently wins — `docker compose` then initdb's the
    database with one password while a daemon started any other way reads
    another.
- Comment style: explain *why* and the non-obvious constraint (see
  `daemon/src/tracker/jira.ts` for the house style); reference the DRY-NN
  ticket that introduced a behavior.
