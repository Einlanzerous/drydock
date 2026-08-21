# CLAUDE.md

Drydock is a per-host daemon that owns AI-CLI PTYs (`claude`, plain shells) plus a
Vue 3 + xterm.js web shell that attaches to them. Sessions survive disconnects
because the daemon — not any client — holds the PTY master. See README.md for
architecture and features; docs/deploy.md for prod.

This file holds what you need **before** touching code: how to build it, the
invariants that bite, the traps that recur, and the conventions. The hard-won
per-ticket detail lives one Read away in [docs/decisions/](docs/decisions/) —
indexed at the bottom. That split is deliberate: this file is loaded into every
session, and it had grown to 2,300 lines by appending a post-mortem per ticket.
**When you finish a ticket, add a doc there and link it — don't grow this file.**

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

## The load-bearing invariants

Read these before touching `daemon/src/`. Everything else is in
[docs/decisions/](docs/decisions/), indexed at the bottom of this file.

**Sessions survive a daemon restart (DRY-57).** Each PTY is held by its own
detached supervisor process (`daemon/src/supervisor/`), so the daemon is a client
of its own sessions rather than their parent. A save under `daemon/src/` restarts
the `--watch` daemon and the agents keep running; on boot it reconciles them from
a per-port index of small files (`daemon/src/sessions-dir.ts`,
`~/.drydock/sessions-<port>/`) and reattaches, scrollback included.
`DRYDOCK_EXIT_ON_UNCAUGHT` defaults ON because a restart is now cheap — and
since DRY-48 it takes a third value, `idle`, which stays up while the daemon
still holds sessions and exits once it doesn't. What made that expressible is
that `/healthz` now says whether this process has taken a fault.

- **Never bump `PROTOCOL_VERSION` in `supervisor/wire.ts` casually.** A daemon
  refuses to drive a supervisor from a different build rather than misparse it,
  which strands live sessions until that supervisor's agent finishes. Change a
  frame type or the meaning of a `SessionMeta` field and you must bump it — and
  expect running sessions to become undrivable.
- **The sessions dir is per-port on purpose.** A throwaway daemon on :4399
  sharing it would adopt the dev daemon's live agents and reparent them to a
  process you're about to Ctrl-C.
- **Still don't restart prod (`:4318`) casually**, even though a deploy no longer
  kills the agents (DRY-87). Reattach is very good, not free: an in-flight gate is
  re-raised and the rail's action line resets.
- **Test daemon changes on a second instance**, never by restarting :4317/:4318.

## Verifying daemon changes: second-instance pattern

Run your changed code as a throwaway daemon on a spare port, config passed as env
vars (real env always wins over `.env`; a fresh worktree has no `.env`):

```sh
cd <your-worktree>
bun install                       # worktree needs its own node_modules + node-pty build
cd daemon
DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts
```

**"Real env wins" bites when the tester is an agent Drydock itself spawned.** The
session inherits the daemon that started it, so a "throwaway" started from inside
one runs with the **prod** `DRYDOCK_DATABASE_URL`, `DRYDOCK_AUTH_PASSWORD` and
tracker token — and a fresh worktree having no `.env` says nothing about it. The
tell is `/healthz` answering `store.kind: "postgres"` when you passed a state
file, or an anonymous request 401ing. Strip them rather than overriding one at a
time; the set is not fixed:

```sh
env $(env | grep -o '^DRYDOCK_[A-Z_0-9]*' | sed 's/^/-u /' | tr '\n' ' ') \
  DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
  DRYDOCK_STATE_FILE=/tmp/s.json node --import tsx src/index.ts
```

Cleaning up is a real step since DRY-57: Ctrl-C leaves the **detached
supervisors** behind. Both filters below are load-bearing, and neither works
alone. `pkill -f supervisor/main` matches the shell command containing that
string and kills your own session. But `/proc/<pid>/exe` alone is not enough
either — every supervisor on the host is the same `node` binary, so an exe-only
loop kills live agents belonging to daemons you are not testing, including the
one holding the terminal you are typing in. (Done it, mid-ticket, from inside a
Drydock session: the cleanup ended the session running the cleanup.) The
throwaway `DRYDOCK_SESSIONS_DIR` is unique to your daemon and is in every
supervisor's argv; the exe test is what excludes the shell running the loop,
which matches both literals because they appear in its own command line.

```sh
# supervisors FIRST, then the directory — rm -rf on a sessions dir with live
# supervisors deletes the only handle anything has on them, leaving processes
# no daemon can ever find. (Done it. The tell is a supervisor whose log fd
# reads `(deleted)`.)
for p in $(pgrep -f "supervisor/main"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    tr '\0' ' ' < /proc/$p/cmdline | grep -q "/tmp/d79/" && kill -9 "$p";;
  esac
done
```

Stopping the throwaway **daemon** needs one filter more, because `pgrep -f
"src/index.ts"` matches the shell wrapper running your own cleanup — and on a
host where several worktrees each run a daemon, exe alone can't tell yours from
another agent's. Match on exe AND cwd:

```sh
for p in $(pgrep -f "src/index.ts"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    case "$(readlink /proc/$p/cwd)" in *<your-worktree>*) kill "$p";; esac;;
  esac
done
```

Smoke-test against it (`curl` from another terminal):

```sh
curl -s localhost:4399/healthz                 # {status, ok, sessions, faults, …}
curl -s localhost:4399/api/sessions            # list; POST spawns (see server.ts)
curl -s localhost:4399/api/tracker/info        # active tracker provider
```

## Recurring traps

Stated once here because they were each learned separately on five different
tickets. The per-ticket detail is in the linked docs.

1. **The right default is a terrible test.** An hour's autonomous timeout, a
   five-minute sweep delay, a 20s cache TTL — every one of them is correct in
   prod and useless in a harness. Turn the knob down, and make the harness
   *refuse* to run above a threshold rather than pass by waiting.
   (DRY-49, DRY-60, DRY-72, DRY-90)
2. **An exit code is not a verdict.** Signalling a process exits it 129/137/143,
   so inferring failure from the number reports every deliberate stop as a crash.
   `failure` being SET, or `endReason`, is the only thing that means failed —
   never the code. This has now been rediscovered on five surfaces.
   (DRY-49 t2, DRY-56 t3, DRY-60 t8, DRY-64 t4, DRY-79 t7)
3. **Assert on what ARRIVED, never on what rendered — or on a status code.** The
   route answered 201 for the whole time `env` was being dropped; 201 was never
   evidence a spawn's replay survived; a harness that asserted `exit 0` passed by
   finding somebody else's daemon. Assert on bytes only the thing under test
   could have produced. (DRY-27, DRY-66, DRY-79, DRY-81, DRY-82)
4. **A knob whose `0` means "off" goes through `msOrOff`, not `num()`.** `num()`
   rejects 0 deliberately — for a cap it's a typo — so a deliberate 0 silently
   restores the default and the off switch does nothing. Worst on a knob that
   guards deletion. (DRY-60 t9, DRY-72 t6, DRY-90 t13)
5. **Confirm a harness discriminates before trusting a green run.** Point it at
   the unpatched file (each README says how, and records the expected failure
   count). A harness that passes either way is worse than no harness — several
   here shipped vacuous and were caught only by re-running them against the bug.
6. **Run every tier and every posture, not the one you have configured.** Both
   state backends (DRY-28), all three auth modes (DRY-27), all three permission
   modes (DRY-49), both tracker providers. They are different code paths, not
   settings of one, and the forgotten one is always the default.
7. **A comment saying why something is safe is only true of the code it was
   written against.** DRY-81's `-f` was genuinely harmless until the same commit
   started reading the body; the note survived the change that falsified it.
   Re-read the justification when you touch the thing it justifies.

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
  everything in this file and in `docs/decisions/` is still verified by hand. CI installs with
  `--ignore-scripts` (no node-pty native build, no Playwright browser download)
  because nothing there spawns a PTY or opens a page. Both checks are
  **required** on `main` (ruleset "main: compile gate"), with admin bypass — so
  a red PR is merged on purpose, not by inattention. The workflow has no path
  filters on purpose: a required check that never reports on a docs-only PR
  would leave it unmergeable.
- **A second check reads the change** (DRY-92, `.github/workflows/pr-review.yml`):
  a ~30-line caller of construct-server's shared PR reviewer (SERV-92), the same
  one switchyard, argosy and signet run. Judgement lives in `REVIEW.md`,
  generated artifacts in `.github/review-ignore`, and the procedure is fetched
  from construct-server at run time — don't copy it here, and don't add a
  `concurrency:` key, which the shared workflow owns. `sensitive_paths` in the
  caller is the one input that needed thought; it names the daemon's auth,
  spawn-env, supervisor, sessions-dir, worktree, state and deploy paths, and it
  was replayed against the last 16 merged PRs (6 escalate, 10 don't) rather than
  guessed. It runs on a self-hosted runner because the reviewer reads the ticket
  off Switchyard on loopback. Three things about the colours, because they are
  not the usual ones: **grey means triage declined** and is the common case on a
  `synchronize` — push a fix and the check goes grey unless the PR carries the
  `review:always` label, or you comment `@claude review`; green means a reviewer
  actually ran; red means it didn't finish, or it found something blocking. It
  is deliberately **not** a required check — an advisory reviewer that can block
  a merge is a reviewer nobody can route around at 2am.
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

## Where the detail lives

One file per ticket in [docs/decisions/](docs/decisions/), each the full trap
list as it was written. **Read the matching one before changing that surface** —
they are post-mortems, so nearly every numbered item is a bug that shipped.

Sessions, spawning and the supervisor:

| doc | what it holds |
|---|---|
| [dry-57-session-durability](docs/decisions/dry-57-session-durability.md) | how "killing this doesn't kill that" is tested, and the resource cost per session |
| [dry-79-first-output](docs/decisions/dry-79-first-output.md) | the window between a PTY starting and its pane attaching, and the exit code that went missing in it |
| [dry-88-initial-prompt](docs/decisions/dry-88-initial-prompt.md) | who types a spawned agent's first prompt, and why a fixed delay can't be the rule |
| [dry-49-autonomous-runs](docs/decisions/dry-49-autonomous-runs.md) | unattended runs: the three permission postures, handoffs, and why a stop is not a failure |
| [dry-66-spawn-env](docs/decisions/dry-66-spawn-env.md) | per-spawn env vars — what's refused and where the line actually is |
| [dry-59-inherited-markers](docs/decisions/dry-59-inherited-markers.md) | what a spawned agent inherits from the session that launched the daemon |
| [dry-56-session-history](docs/decisions/dry-56-session-history.md) | tombstones, and telling a dead session from a reattached one |
| [dry-60-clearing-finished](docs/decisions/dry-60-clearing-finished.md) | the sweep — why the clock measures time in front of somebody |
| [dry-64-exit-events](docs/decisions/dry-64-exit-events.md) | `session-exit` on the event stream, and why it isn't wired to `onRunEnd` |
| [dry-90-worktree-reaper](docs/decisions/dry-90-worktree-reaper.md) | when a worktree may be deleted; liveness is read from every daemon's index, not this one's |
| [dry-48-health](docs/decisions/dry-48-health.md) | `/healthz` and `/readyz` — what makes a daemon suspect, and why `degraded` must never read as `down` |

Identity, state and deploy:

| doc | what it holds |
|---|---|
| [dry-27-auth-tiers](docs/decisions/dry-27-auth-tiers.md) | the three auth postures, and the fifteen ways this breaks |
| [dry-28-workspace-state](docs/decisions/dry-28-workspace-state.md) | both state backends; a dead database must never cost a PTY |
| [dry-87-deploy-keeps-agents](docs/decisions/dry-87-deploy-keeps-agents.md) | `KillMode=process` — `setsid` does not leave a cgroup |
| [dry-81-deploy-probe](docs/decisions/dry-81-deploy-probe.md) | why a deploy that worked used to say it failed |
| [dry-91-image-labels](docs/decisions/dry-91-image-labels.md) | OCI revision/source on the shell image, and why `version` is deliberately empty |

Desk and shell:

| doc | what it holds |
|---|---|
| [dry-82-desk-chrome](docs/decisions/dry-82-desk-chrome.md) | one spawn button, a centre that is a centre, `key=value` pills, daemon-side search |
| [dry-83-epic-children](docs/decisions/dry-83-epic-children.md) | expanding an epic that has nothing under it |
| [dry-71-clipboard-keys](docs/decisions/dry-71-clipboard-keys.md) | `Ctrl+Shift+C/V`; `navigator.clipboard` is unavailable where this runs |

Tracker:

| doc | what it holds |
|---|---|
| [tracker-provider-checklist](docs/decisions/tracker-provider-checklist.md) | the nine curls that qualify a Switchyard or Jira provider |
| [dry-72-tracker-cache](docs/decisions/dry-72-tracker-cache.md) | stale-while-revalidate, deadlines, and the unbounded child-stats query |
| [dry-53-ticket-brief](docs/decisions/dry-53-ticket-brief.md) | the 10000-character cut, and why appending is the bug |
| [dry-55-tracker-sidebar](docs/decisions/dry-55-tracker-sidebar.md) | the quietest failure the desk has |

Harness rigs are in [scripts/verify/README.md](scripts/verify/README.md); prod
operations in [docs/deploy.md](docs/deploy.md).
