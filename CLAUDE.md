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

## ⚠️ The dev daemon kills sessions on edit

`bun run daemon` runs `--watch`: **any save under `daemon/src/` restarts the
daemon and destroys every live agent PTY it owns** — including the session you
may be running in. Rules:

1. Never edit `daemon/src/` in a checkout whose daemon has live sessions. Work
   in a git worktree (ticket-spawned agents get one automatically, branch
   `agent/<TICKET>`).
2. Never test daemon changes by restarting a daemon that has live sessions —
   dev (`:4317`) or prod (`:4318`, systemd unit `drydock-daemon`). Spin up a
   second instance instead (next section).

## Verifying daemon changes: second-instance pattern

Run your changed code as a throwaway daemon on a spare port, with config passed
as env vars (real env always wins over `.env`; a fresh worktree has no `.env`):

```sh
cd <your-worktree>
bun install                       # worktree needs its own node_modules + node-pty build
cd daemon
DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts
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
6. **The claude trust dialog does not fire** in a fresh worktree as of Claude
   Code v2.1.220 — verified deliberately, since it would wedge an unattended run
   at a prompt nobody can answer. If a future version brings it back, that is
   where to look first. NB testing from inside a claude session leaks
   `CLAUDE_CODE_CHILD_SESSION` into the daemon's env and suppresses it anyway,
   which makes for a convincing false negative: `env -u` the `CLAUDE_*` vars.

Verify the tracker comment against **both** providers — it is the first thing
to exercise `comment()` on either. Switchyard against a throwaway ticket; Jira
against a stub asserting `POST /rest/api/2/issue/<KEY>/comment` with a plain
string `{body}` (v2 is chosen precisely so no ADF document is needed), plus the
fixture provider (`comment: false`) to prove the rail stands alone without one.

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
8. End-to-end: point a browser at the dev shell, switch it to the throwaway
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
- Comment style: explain *why* and the non-obvious constraint (see
  `daemon/src/tracker/jira.ts` for the house style); reference the DRY-NN
  ticket that introduced a behavior.
