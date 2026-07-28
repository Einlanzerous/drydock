# Verification harnesses

There are no automated tests in this repo; CLAUDE.md's curls are the regression
suite. These are the part of that suite the curls can't express.

Nothing here runs in CI or on install. Three groups:

- **The workspace store's partition harnesses (DRY-58)** — everything from
  [Setup](#setup) down, because the claims are about **latency and recovery**,
  not status codes. They start throwaway daemons and take a few minutes. Run
  them when touching `daemon/src/state/` or
  `shell/src/composables/layoutStore.ts`.
- **The ticket brief (DRY-53)** — [next section](#the-ticket-brief-dry-53).
  In-process, no daemon, seconds. Run them when touching
  `daemon/src/tracker/`.
- **The tracker sidebar (DRY-55)** —
  [its own section](#the-tracker-sidebar-dry-55), with its own rig. A browser,
  about a minute. Run it when touching the sidebar's empty/outage states or
  `loadTickets` in `App.vue`.

## The ticket brief (DRY-53)

```sh
(cd daemon && node --import tsx ../scripts/verify/ticket-brief.mts)
(cd daemon && node --import tsx ../scripts/verify/tracker-getticket.mts)
```

Both run from `daemon/` because that's where `tsx` resolves from in this
workspace. They need no credentials and touch no network.

| harness | what it holds down |
|---|---|
| `ticket-brief.mts` | What a spawned agent actually receives. Claude Code truncates a SessionStart hook's `additionalContext` past **10000 characters** and says nothing about it (measured, v2.1.220), so the brief is budgeted rather than concatenated: the thread keeps a reserve a long description can't eat, the newest comment is never dropped, and every truncation is announced. |
| `tracker-getticket.mts` | Stub Jira and Switchyard instances, asserting on the requests each provider makes. Switchyard's single-ticket GET returns a bare `parent_id` where the list endpoint hydrates `parent`; Jira pages the `comment` field oldest-first, so a short page is the wrong end of the thread. Neither shape is reachable against the live tracker here. |

Why a harness and not curl: the failure is silent by construction. The daemon
sends a complete brief, the hook returns 200, and the agent quietly never sees
the part that fell off the end — which is exactly how the first cut of DRY-53
passed inspection while delivering none of its comments.

## The tracker sidebar (DRY-55)

Self-contained — its own daemon, proxy and vite, so touching the sidebar
doesn't mean standing up the workspace-store rig below. From the repo root:

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

(cd daemon && DRYDOCK_PORT=4374 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_STATE_FILE=/tmp/dry55-state.json node --import tsx src/index.ts &)
node scripts/verify/proxy-tracker.mjs &                   # :4375 → :4374
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4375 bunx vite --port 5375 --strictPort &)

node scripts/verify/sidebar.mjs
```

| harness | what it holds down |
|---|---|
| `sidebar.mjs` | A tracker outage names itself. Before DRY-55 a first load with the tracker down rendered "No tickets match." — true of a healthy tracker with nothing in scope, and with the scope chips (DRY-30) in the same panel it reads as a filter you got wrong rather than an outage. Asserts the empty case, the **stale** case, the **hang** case and a shell newer than its daemon separately, plus that all of them end without a reload. |

The hang case is the one worth explaining. A tracker that refuses connections
fails fast; a tracker that accepts and then goes silent doesn't fail at all —
and neither provider's `req()` carries a deadline, so the daemon's route never
answers either. Nothing rejects, so the catch that powers every other assertion
here never runs: the pull just never settles, the sidebar keeps saying "No
tickets match.", and its spinner stays latched because `finally` never runs
either. The pull's own budget (`LIST_TIMEOUT_MS`, `shell/src/lib/tracker.ts`) is
the only thing that ends it. Same lesson as the workspace store's, one surface
over — see the section below.

Why a browser and not curl: `curl /api/tracker/tickets` returns a 502 with a
perfectly clear error body, which is the exact state in which this shipped. The
claim is about what the sidebar SAYS, and only a rendered page can tell "we
couldn't ask" from "we asked and there are none".

Why a second proxy rather than a mode on `proxy-http.mjs`: that one breaks the
state store, and the two outages are independent conditions — sharing it would
mean a path parameter on a harness three other scripts depend on.

## Workspace store: why a proxy and not `docker stop`

`docker stop` frees the port, so every connect fails instantly with
ECONNREFUSED and every latency bug hides. A real partition is host-up,
packets-dropped: the connect ACKs and nothing comes back. Three separate bugs
were only visible under the latter — see CLAUDE.md, "Verifying workspace state".

`proxy-tcp.mjs` also **freezes connections it has already established** rather
than only refusing new ones. The pool keeps clients idle for 30s, so a proxy
that blocks new connects alone never partitions anything at all.

## Setup

Every block below runs from the **repo root** and returns there — the `cd`s are
in subshells on purpose, so the whole section copy-pastes in sequence.

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

# Throwaway daemon — file store (the default tier, the one that gets forgotten)
(cd daemon && DRYDOCK_PORT=4370 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_STATE_FILE=/tmp/dry58-state.json DRYDOCK_TRACKER=fixture \
   node --import tsx src/index.ts &)

# HTTP partition proxy in front of it, and the dev shell pointed at the PROXY
node scripts/verify/proxy-http.mjs &                      # :4371 → :4370
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4371 bunx vite --port 5370 --strictPort &)
```

For the Postgres tier, add a throwaway database behind the TCP proxy and a
second daemon in front of it:

```sh
docker run -d --name dry58-pg -e POSTGRES_PASSWORD=dry58 -e POSTGRES_DB=drydock \
  -p 127.0.0.1:5455:5432 postgres:16
node scripts/verify/proxy-tcp.mjs &                       # :5456 → :5455, control :5457

(cd daemon && DRYDOCK_PORT=4372 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_DATABASE_URL='postgres://postgres:dry58@127.0.0.1:5456/drydock' \
   node --import tsx src/index.ts &)
```

Then point `proxy-http.mjs` at it (`TARGET_PORT=4372`) and pass
`DAEMON=http://127.0.0.1:4372` to the browser harnesses. **Run them against both
tiers** — the file store is what a fresh clone runs.

## The harnesses

| | asserts |
|---|---|
| `roam.mjs` | Roaming resumes with no reload, for an outage starting before *and* after the first read. Includes the conflict rule as a pair: an untouched client adopts the daemon's desk live, a client that dragged keeps its own. |
| `hang.mjs` | The accept-then-silence partition. A push that never settles must still raise the notice and leave recovery alive. |
| `surface.mjs` | DRY-28's surface claims (wipe localStorage → reload → desk intact; a fresh profile gets the same desk) plus how the notice presents: once, no focus steal, self-clearing, and a hidden tab still recovers. |
| `timings.mjs` | Postgres only. Timings, not status codes: one request per window pays the timeout, the rest return in ms, the window widens 10 → 20 → 30 and stops, `/healthz` answers instantly while cooling and resets after a heal. |
| `drift.sh` | Postgres only. An edited applied migration 503s naming the file while the live PTY keeps running; reverting clears it; a null checksum is adopted and backfilled. |

Each exits non-zero on failure and prints one line per check.

## Making sure a harness still discriminates

A green harness proves nothing if it would also be green against the bug. Check
it the way these were checked:

```sh
git checkout main -- shell/src/composables/layoutStore.ts \
  shell/src/composables/useWindowManager.ts shell/src/App.vue
node scripts/verify/roam.mjs        # expect 6 failures
git checkout HEAD -- shell/src/composables shell/src/App.vue

git checkout main -- shell/src/App.vue shell/src/components/TrackerSidebar.vue \
  shell/src/lib/tracker.ts
node scripts/verify/sidebar.mjs     # expect failures across (a), (c), (e), (f), (g)
git checkout HEAD -- shell/src/App.vue shell/src/components/TrackerSidebar.vue \
  shell/src/lib/tracker.ts
```

Vite hot-reloads, so no restart is needed between the two runs. Give it a
second or two to do so — a run started too soon tests the tree you just
replaced and reports the result you were hoping for.

**Commit first.** `checkout main -- <paths>` overwrites the working tree, and
the `checkout HEAD --` that restores it only knows about the last COMMIT — so
any uncommitted edit in those paths is gone, silently, with no stash to recover
it from. (Written down because it happened: a round of review fixes, discarded
by the step meant to validate them.)

**Not `git stash push -- <paths>`** as the way around that. On a committed
branch the tree is clean, so it saves nothing, exits 0, and the run you thought
was testing `main` tests your own code and prints "all passed" — the exact false
green this section exists to prevent. The `checkout HEAD --` at the end is also
what puts the index back, so nothing is left staged.

## Overrides

`SHELL_URL`, `DAEMON`, `PROXY` for the browser harnesses; `PROXY_PORT` /
`TARGET_PORT` for `proxy-http.mjs` and `proxy-tracker.mjs` (`BREAK_PATH` too, if
some other route ever needs the same treatment); `PG_PROXY_PORT` / `PG_PORT` /
`CONTROL_PORT` for `proxy-tcp.mjs`; `PG_URL` / `PG_CONTAINER` for `drift.sh`.

**`DAEMON` must point at whatever `proxy-http.mjs` forwards to.** Getting that
wrong makes the harness assert against a different daemon than the browser is
driving, which looks exactly like a product failure and isn't one.
