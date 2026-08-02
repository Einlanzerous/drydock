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
- **The tracker cache (DRY-72)** —
  [its own section](#the-tracker-cache-dry-72), with its own rig again (a
  counting stub tracker, since the claims are about upstream requests that
  didn't happen). A browser, about a minute. Run it when touching
  `daemon/src/tracker/cache.ts`, either provider's `attachChildStats`, or the
  ticket poll's scheduling in `App.vue`. **Run `sidebar.mjs` too** — the two
  overlap on who reports a tracker outage, and DRY-72 moved that decision from
  the browser to the daemon. There is also an
  [in-process suite](#the-caches-own-semantics-in-process) for the cache's
  ordering and timing, which needs neither daemon nor browser and takes a second.
- **The tombstone's resume button (DRY-62)** —
  [its own section](#the-tombstones-resume-button-dry-62). A browser and a
  throwaway Postgres, about a minute. Run it when touching
  `daemon/src/transcripts.ts`, the history route, or either half of the resume
  gate.
- **Clearing finished sessions (DRY-60)** —
  [its own section](#clearing-finished-sessions-dry-60). A browser, about two
  minutes. Run it when touching `sweepFinished` / `mayClear` / `clearSession` in
  `App.vue`, `isFinished` in `runState.ts`, or anything that changes when a
  window is removed.
- **The permission gate's action row (DRY-78)** —
  [its own section](#the-permission-gates-action-row-dry-78). A browser, about a
  minute; no daemon config beyond a spare port. Run it when touching
  `GatePanel.vue`, or the rail's `measureGateRoom` / anything that changes the
  panel's width, height or anchoring.

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

## The tracker cache (DRY-72)

Also self-contained, and it needs a tracker the daemon can really talk to —
`stub-tracker.mjs`, a Switchyard-shaped origin that **counts what arrives**.
That counter is the whole point: every claim here is about requests that didn't
happen, and `curl /api/tracker/tickets` returns the same 200 with the same body
whether the daemon answered from memory or spent six seconds re-walking a
corporate Jira. Which is the state the bug shipped in.

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

node scripts/verify/stub-tracker.mjs &                    # :4386, counting
(cd daemon && DRYDOCK_PORT=4385 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4386 \
   DRYDOCK_TRACKER_PROJECTS=DRY \
   DRYDOCK_TRACKER_CACHE_MS=4000 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=60000 \
   DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=3000 \
   DRYDOCK_DATABASE_URL= DRYDOCK_STATE_FILE=/tmp/dry72-state.json \
   DRYDOCK_SESSIONS_DIR=/tmp/dry72-sessions node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4385 bunx vite --port 5385 --strictPort &)

node scripts/verify/tracker-cache.mjs
```

| harness | what it holds down |
|---|---|
| `tracker-cache.mjs` | Six concurrent pulls cost ONE fan-out upstream, not six. The child-stats query — the unbounded half, since it spans every status — doesn't repeat with each list refresh. A 2500ms tracker doesn't make a 2500ms sidebar, while Refresh still overrules the cache and waits. A dead tracker leaves the daemon serving last-good with `stale` set (200, not 502) while a key it has never fetched still 502s. And the surface section re-proves DRY-55 end-to-end. |

**Turn the TTLs down, and the harness insists on it.** 20s is the right default
and a terrible test — the same trap DRY-49's timeout and DRY-60's sweep delay
have — so section (c) measures the TTL it actually observes and fails if it took
15s or more, rather than passing by waiting.

The rig deliberately does NOT reuse `proxy-tracker.mjs`. That one sits between
the *browser* and the daemon, so it can break `/api/tracker/tickets` but can
never see what the daemon does upstream — which is the only place any of these
claims live. Different position, different question, different file.

Sections (e), (g) and (j) are **guards, not discriminators**: they pass against
an uncached daemon too, because the contract they check is supposed to hold in
both worlds. Don't read their green as evidence the cache works.

### The cache's own semantics (in-process)

```sh
(cd daemon && node --import tsx ../scripts/verify/tracker-cache-unit.mts)
```

No daemon, no browser, about a second. It covers what the end-to-end run is a
poor instrument for — ordering and timing inside one class: that a forced refresh
returns data taken *after* the call rather than joining a flight that predates
it, that an un-refreshed list is eventually called stale with nothing having
failed, that a flight throwing synchronously doesn't wedge its key forever.
Through HTTP those are minute-long waits and races; here they're a stub fetch and
TTLs in tens of milliseconds.

To confirm IT discriminates, revert a fix and watch the matching section fail:

| revert | expect |
|---|---|
| in `refresh`, replace the `e.refreshing` block with a bare `return e.refreshing` | (c) `calls=2`, (d) `+0` — Refresh silently returns a pre-click snapshot |
| in `start`, go back to `e.refreshing ??= (async () => { … finally { e.refreshing = undefined } })()` with `fetch()` called **directly inside** that IIFE | (h) `GEN-0` — the key never refreshes again |

**The second one has a trap in it, and it caught me.** Wrapping the *existing*
`this.run(...)` in a try/finally does NOT reproduce the bug and section (h) passes
cleanly against it: `run` is an `async` method, so calling it never throws
synchronously, and the `finally` therefore always lands in a microtask. The bug
needs `fetch()` invoked directly in the IIFE body, where a synchronous throw runs
the `catch` and `finally` before the caller has assigned the handle. A revert that
keeps the async indirection is a revert that isn't one.

### Making sure this one still discriminates

The config knob gives you the pre-DRY-72 daemon exactly — restart it with the
caches off and the deadline out of reach:

```sh
DRYDOCK_TRACKER_CACHE_MS=0 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=0 \
  DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=600000   # …rest of the env as above
```

Expect **15 failures**, and expect the numbers to be the diagnosis: six pulls
becoming `18 upstream requests`, one pull taking `7509ms against a 2500ms
tracker`, and the hang case never answering at all (`0 after 30001ms` — the
probe's own budget, which is why `pull()` carries one).

## The tombstone's resume button (DRY-62)

Needs a **database tier** — tombstones are drawn from session history, and only
Postgres retains it. Throwaway container, throwaway everything:

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

docker run -d --name dry62-db -e POSTGRES_PASSWORD=dry62pw -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55462:5432 postgres:16-alpine

(cd daemon && CLAUDE_CONFIG_DIR=/tmp/dry62-claude DRYDOCK_PORT=4392 \
   DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d62 DRYDOCK_TRACKER=fixture \
   DRYDOCK_DATABASE_URL='postgres://drydock:dry62pw@127.0.0.1:55462/drydock' \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4392 bunx vite --port 5392 --strictPort &)

CLAUDE_CONFIG_DIR=/tmp/dry62-claude node scripts/verify/tombstone.mjs   # from the repo root
```

`CLAUDE_CONFIG_DIR` must be the same value in both places: the harness plants
and deletes a transcript under it, and the daemon resolves transcripts from its
own environment. Point it at a scratch directory rather than `~/.claude`, or
the harness will `chmod 000` your real one for six seconds.

| harness | what it holds down |
|---|---|
| `tombstone.mjs` | A tombstone's button tells the truth about the conversation behind it. The gate was `command === "claude" && agentSessionId`, and an id is not a transcript: the SessionStart hook reports one whether or not the CLI is persisting anything, so every session a pre-DRY-59 daemon spawned recorded an id pointing at nothing. Asserts the label BOTH ways, that the click's args agree with the label, and that a daemon which cannot read the transcript directory says nothing rather than stripping Resume from every card on the desk. |

Why a browser and not curl: `/api/sessions/history` shows the flag either way.
The claim is which word the button shows and which args the click sends — and
those are computed in two different files (`SessionTombstone.vue` and
`App.vue`), which is why they now call one shared predicate and why the harness
checks the label and the spawn separately rather than trusting either.

No SQL and no API tokens, both on purpose: the agent session id is planted
through the daemon's own SessionStart hook exactly as an agent reports it, and
the `claude` it spawns is never prompted. Note the plant must come AFTER the
spawn's own hook — `agent_session_id` is written `where agent_session_id is
null`, so the first writer wins.

## Clearing finished sessions (DRY-60)

Runs against **either tier**, and should be run against both — the file store is
where a swept session's scrollback was the only copy there ever was. It reads
the tier from `/healthz` and flips the notice assertion accordingly.

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

(cd daemon && DRYDOCK_PORT=4360 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d60 \
   DRYDOCK_STATE_FILE=/tmp/dry60-state.json DRYDOCK_RUNS_ROOT=/tmp/dry60-runs \
   DRYDOCK_TRACKER=fixture DRYDOCK_CLEAR_FINISHED_AFTER_MS=8000 \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4360 bunx vite --port 5360 --strictPort &)

node scripts/verify/sweep.mjs                # from the repo root

# then again on the database tier — same shell, same harness
docker run -d --name dry60-db -e POSTGRES_PASSWORD=dry60pw -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55460:5432 postgres:16-alpine
# (restart the daemon on :4360 with DRYDOCK_DATABASE_URL instead of the state file)
```

**`DRYDOCK_CLEAR_FINISHED_AFTER_MS` is not optional here.** The default is five
minutes, which is right for a desk and useless for a test; the harness refuses
to run (exit 2) against anything over 30s rather than quietly waiting out the
real delay and calling it a pass.

| harness | what it holds down |
|---|---|
| `sweep.mjs` | Finished sessions clear themselves and **nothing else does**. Four rounds: **A** the rail (a run that ended while you were in another tab is still there when you come back, never having counted down to nobody; the finished card announces itself before it goes; the failed one never does either; plus the tier's own line — raised on the file store once the sweep has actually cost something, absent before that and absent entirely on Postgres). **B** the desk (an unfocused finished window clears, the focused one doesn't, a running session and a workspace whose zsh is still alive are both left, `Clear finished` counts only what it would take and takes nothing that was running). **C** a crowded rail — ten runs, every countdown still rendered, still fitting its card, and still costing that card no width (the lane is one non-wrapping scrolling row, so a wider card is one pushed off the end). **D** the dock and synthetic focus: a docked window is never swept, and two windows nobody has clicked both clear. |

Why a browser and not curl: at the API all four of round B's sessions look
identical — `status: "exited"`. Which one gets swept turns on what is on the
desk, which window has focus, and whether the tab is in front of anybody, and
none of those exist outside a page. The visibility half is faked by overriding
`document.visibilityState` and firing the event rather than actually
backgrounding the tab, which would also throttle the 3s poll to once a minute
and test Chromium instead of the rule.

**Rounds C and D exist because the first cut of this harness passed against two
real bugs.** It read the countdown with `textContent`, which is returned for a
`display:none` node, and it never put more than two cards on the rail — so it
never met the density rule that hid `.meta` from four cards up, i.e. the
countdown was absent in exactly the crowded case the feature is for. So: assert
`getComputedStyle().display` and the element's GEOMETRY, and put ten cards up
rather than two. Round D is the same lesson on the desk — `wm.focusedId` is
assigned synthetically in three places, so a harness that always clicks a window
before asserting can't tell the focus exemption from "whatever the window
manager last touched is immortal".

**And round C grew a WIDTH check because the second cut passed too.** Geometry
was measured against the card, and the question is the lane: `.underway` is a
non-wrapping `overflow-x: auto` row, `getClientRects()` is non-empty for an
element an ancestor clips, so a card entirely off the right-hand edge satisfied
both "is it displayed" and "does it fit its card". The fix that prompted this
widened a counting-down card from tile (112px) to compact (176px) to make room
for the clock — measured at a 1500px viewport, that took ten cards from 1383px
of lane to 2023px against 1208px available, so it went from two cards off the
edge to five, and the sort puts the quiet counting-down ones last. Rendered and
off-screen is not better than hidden. The countdown now takes the card's second
row (the action line's, which crowding has already emptied), so it costs no
width at all — which is what the check asserts, since "all ten are visible" is
not true at any density and never was.

Two sessions per shape, deliberately: `sleep 1` ends cleanly, `exit 3` ends with
a `failure` set, `while :; do sleep 1; done` never ends. No `claude`, no tokens,
no tracker — the sweep cannot tell what was running inside a PTY and shouldn't
be tested as though it could.

## The permission gate's action row (DRY-78)

The gate BLOCKS — an autonomous run is parked on a `PreToolUse` hook waiting for
the answer — so a control that can't be reached is a run that can't proceed.
Needs no tracker, no database and no `claude`: the row is driven by posting a
hook payload with whatever `tool_name` you like.

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

(cd daemon && DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/dry78 \
   DRYDOCK_STATE_FILE=/tmp/dry78-state.json DRYDOCK_TRACKER=fixture \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4399 bunx vite --port 5399 --strictPort &)

node scripts/verify/gate-actions.mjs         # from the repo root
```

| harness | what it holds down |
|---|---|
| `gate-actions.mjs` | Every control in the gate's action row is inside the panel, inside the viewport, and lands its own hit test — across five viewports, both modes (the answers and the deny row are different controls at different widths), and three arguments. Plus the two things the row's width and height cost elsewhere: the line naming the tool in full must not be cut, and the panel must not be pushed off the top of the desk. |

**Drive it with a long MCP tool name, not `Bash`.** One button's width is data —
`Always allow {{ gate.tool }}` — and an MCP name is a single unbreakable token
(`mcp__switchyard__transition_ticket_by_category`, 44 characters), so the row's
width depends on which tool the agent happened to call. Every gate you meet by
hand while testing is a short builtin, and those fit; that is how it shipped.
`Bash` is in the table as the control, not for coverage.

Three assertions per control, because each catches a different width, and the
first two disagree about which viewports are interesting:

- **inside panel** — at 1600px the spill renders outside the panel but still
  inside the window, so this is the only one that sees it.
- **inside viewport** — at 560px the panel itself was off-screen, so this is the
  only one that sees *that*.
- **hittable** — `elementFromPoint` at the rect's centre. A rect is healthy
  whether or not anything can reach it (DRY-74's lesson). Note the rail is
  `pointer-events: none` and draws a scrim over the desk's bottom 98px, so a
  hit-test failure here can be a missing `pointer-events: auto` rather than a
  layout overflow.

**Measuring against the panel is what makes the wide viewports worth running**,
and it is the same discipline as DRY-60's lane: `getClientRects()` is non-empty
for an element an ancestor clips, and a viewport bound is no bound at all when
the container is 604px inside a 1600px window.

The `mcp+blob` row is the vertical axis, and it exists because the fix for the
horizontal one created it. Wrapping the row buys reachability with height, and
this panel spends height UPWARD into a desk that is `overflow: hidden` — so a
wrapped row plus a fully expanded argument put the panel's top 10px past the
edge, cutting the header off a decision. It clicks **Show all** deliberately:
the clamped blob is 104px and never the problem.

Two of the assertions do not discriminate against `main`, and that is
information rather than a defect — `main` had a *worse* bug masking each. The
panel's `max-width` was measured against `100vw` while the panel hangs off the
rail, which starts after the 266px sidebar, so on `main` the panel was 520px
wide and simply hung off the screen: its action row never overflowed it, and its
`.ask` line had width to spare. Point the harness at the tree with only
`overflow-wrap: anywhere` removed to see the tool-name check bite (82px), and at
`main` for the other 46.

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

`sweep.mjs` has no pre-DRY-60 file to check out — there was no sweep to break —
so it was validated by breaking its load-bearing rules instead, a line each.
Worth re-checking after any change to `sweepFinished` or the rail's density:

```sh
# (1) the failure guard, and the "only while somebody is looking" gate
perl -0pi -e 's/return s\.status === "exited" && !s\.failure;/return s.status === "exited";/' \
  shell/src/composables/runState.ts
perl -0pi -e 's/if \(visible\) finishedSeenAt\[session\.id\] \?\?= at;/finishedSeenAt[session.id] ??= at;/' \
  shell/src/App.vue
node scripts/verify/sweep.mjs       # expect 4 failures, incl. the failed run being swept
git checkout HEAD -- shell/src/App.vue shell/src/composables/runState.ts

# (2) the countdown's row, and both of the sweep's own exemptions
perl -0pi -e 's/\.card\.compact\.clearing \.meta,\n\.card\.tile\.clearing \.meta \{[^}]*\}\n//' \
  shell/src/components/RunRail.vue
perl -0pi -e 's/if \(userFocusedId\.value === session\.id \|\| win\?\.minimized\) continue;/if (wm.focusedId.value === session.id) continue;/' \
  shell/src/App.vue
node scripts/verify/sweep.mjs       # expect 4: C's fit check, and 3 of D's
git checkout HEAD -- shell/src/App.vue shell/src/components/RunRail.vue
```

Vite hot-reloads, so no restart is needed between the two runs. Give it a
second or two to do so — a run started too soon tests the tree you just
replaced and reports the result you were hoping for.

**Check that each `perl` actually matched**, because a substitution that hits
nothing is silent and the run that follows is just the harness passing. Recipe
(1) shipped broken for exactly this reason: it patched `if (!visible) continue;`,
which was refactored into two guards one commit later, so the second break
became a no-op and "expect 4" quietly meant 2 — a documented expectation that is
wrong in the safe direction, which is how the next re-validation gets read as a
regression. `grep -c` the replacement before running.

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
