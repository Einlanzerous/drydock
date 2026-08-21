# Verification harnesses

There are no automated tests in this repo; the curls in `docs/decisions/` are
the regression
suite. These are the part of that suite the curls can't express.

None of these RUNS in CI or on install. Since DRY-80 they are all
**typechecked** there — see [Running these](#running-these) — which is a
different claim and a much weaker one: green means the harness compiles, never
that it still asserts anything.

Three groups:

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
  `loadTickets` in `App.vue`. The scope row's backlog control has
  [a harness of its own](#the-backlog-control-dry-85) on the same rig — run
  both when touching which pulls a control is allowed to notice.
- **The tracker cache (DRY-72)** —
  [its own section](#the-tracker-cache-dry-72), with its own rig again (a
  counting stub tracker, since the claims are about upstream requests that
  didn't happen). A browser, about a minute. Run it when touching
  `daemon/src/tracker/cache.ts`, either provider's `attachChildStats`, or the
  ticket poll's scheduling in `App.vue`. **Run `sidebar.mts` too** — the two
  overlap on who reports a tracker outage, and DRY-72 moved that decision from
  the browser to the daemon. There is also an
  [in-process suite](#the-caches-own-semantics-in-process) for the cache's
  ordering and timing, which needs neither daemon nor browser and takes a second.
- **Expanding an epic (DRY-83)** —
  [its own section](#expanding-an-epic-to-its-children-dry-83). Reuses DRY-72's
  counting stub with `STUB_DORMANT_EPIC=1`. A browser, well under a minute. Run
  it when touching the sidebar's epic rows, `listEpicChildren`, `TicketQuery.parent`,
  or either provider's handling of it. **Run `tracker-cache.mts` too** — the
  stub is shared, and an epic added to it changes the child-stats counts that
  harness pins exactly.
- **Per-spawn env (DRY-66)** —
  [its own section](#per-spawn-env-on-post-apisessions-dry-66). A throwaway
  daemon, no browser, seconds. Run it when touching `daemon/src/spawn-env.ts`,
  the spawn route's body handling, or `INHERITED_SESSION_MARKERS` — the last of
  which now has two readers, since the route refuses what the supervisor strips.
- **A prod deploy keeps the sessions (DRY-87)** —
  [its own section](#a-prod-deploy-keeps-the-sessions-dry-87). Owns its own
  systemd unit; no browser, about thirty seconds. Run it when touching
  `deploy/drydock-daemon.service` or `deploy/install-prod.sh`.
- **The deploy's health check (DRY-81)** —
  [its own section](#the-deploys-health-check-dry-81). Two throwaway daemons it
  starts itself; no browser, no systemd, about a minute. Run it when touching
  the tail of `deploy/install-prod.sh`, and **whenever `/api/sessions` changes
  what it answers an anonymous caller** — that status code is the whole premise,
  and this file asserts it directly rather than assuming it.
- **A session's first output (DRY-79)** —
  [its own section](#a-sessions-first-output-dry-79). A throwaway daemon, no
  browser, under a minute. Run it when touching `PtySession.spawn` / `adopt` /
  `seedScrollback`, `SupervisorLink`'s handshake, or the order in which
  `supervisor/main.ts` spawns its PTY and binds its socket.
- **Reaping finished worktrees (DRY-90)** —
  [its own section](#reaping-finished-worktrees-dry-90). Two harnesses on one
  fixture: `worktree-reap.mts` (a throwaway daemon and the DRY-72 stub tracker,
  no browser, fifteen seconds) for the policy, and `worktree-reap-ui.mts` (a
  browser too, about a minute) for which GESTURE is allowed to trigger it. Run
  both when touching `daemon/src/worktree.ts`, `daemon/src/worktree-reaper.ts`
  or either worktree route; run the second in particular when touching the close
  paths in `App.vue`, because the one thing that must never delete a worktree is
  DRY-60's automatic sweep and the only thing keeping it out is which function
  the call sits in.
- **The agent's pre-filled prompt (DRY-88)** —
  [its own section](#the-agents-pre-filled-prompt-dry-88). A browser, a
  throwaway daemon and a stub CLI on its PATH; about a minute. Run it when
  touching when a spawned CLI is judged ready to be typed at
  (`scheduleInitialInput` / `paintsSomething`), whether the prompt is submitted
  (`flushInitialInput`), or `spawnWorkspace` in `App.vue`.
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
- **Who may use the daemon (DRY-27)** —
  [its own section](#who-may-use-the-daemon-dry-27). Three daemons, three vite
  servers, a throwaway Postgres and a browser; about a minute. Run it when
  touching `daemon/src/auth/`, the route guard in `server.ts`, or
  `shell/src/lib/auth.ts`.
- **The permission gate's action row (DRY-78)** —
  [its own section](#the-permission-gates-action-row-dry-78). A browser, about a
  minute; no daemon config beyond a spare port. Run it when touching
  `GatePanel.vue`, or the rail's `measureGateRoom` / anything that changes the
  panel's width, height or anchoring.
- **The terminal's clipboard keys (DRY-71)** —
  [its own section](#the-terminals-clipboard-keys-dry-71). A browser, about
  30 seconds; no daemon config beyond a spare port. Run it when touching
  `attachClipboardKeys` in `TerminalPane.vue`, anything else that reaches
  `attachCustomKeyEventHandler`, or an xterm bump — the keymap this depends on
  is xterm's, and it is what decides whether paste reaches the browser at all.

## Running these

Everything in this directory is TypeScript run through `tsx`, and every
invocation below has the same shape:

```sh
(cd daemon && node --import tsx ../scripts/verify/<name>.mts)
```

The `cd daemon` is now convention rather than necessity. `tsx` used to be a
**daemon**-workspace dependency only, so `node --import tsx` did not resolve
from the repo root at all; DRY-80 made it a root devDependency too (the launcher
needs it — see the note in `scripts/up.mts`), so `node --import tsx
scripts/verify/<name>.mts` from the root works identically. The blocks below
keep the subshell form because every harness's own header comment gives it, and
because a subshell means the whole section still copy-pastes in sequence.

The browser harnesses need Playwright. The library itself is an ordinary
devDependency now (DRY-80) — `bun install` at the repo root is enough — but the
browser binary is not: Bun doesn't run untrusted packages' install scripts, so
nothing downloads ~150MB of Chromium behind your back. Once per machine:

```sh
bunx playwright install chromium
```

If a launch fails with "Executable doesn't exist", that is the line you missed.

**These are typechecked in CI, and that proves almost nothing.** `bun run
typecheck:scripts` (the `scripts typecheck` step in `pr-checks.yml`) runs two
projects — `scripts/tsconfig.json` for the Node half and
`scripts/tsconfig.browser.json` for the Playwright half, split so that daemon
source reached by the in-process harnesses is never checked under the DOM lib as
well as its own. **Both always run**, and the exit code is the worse of the two:
joining them with `&&` means a failure in the first hides the second entirely,
so you fix everything you were shown, push, and meet a second wave. That was a
real off-by-two while this was being written — seven errors reported where there
were nine. Between them they hold down what tsc can see: that a harness
compiles, that it agrees with the daemon's own `SessionInfo` / `SessionRecord` /
`Ticket` (imported through `api.mts` rather than re-declared) and with each
proxy's own `/__state` shape (imported from the proxy, likewise), and that the
DOM calls in a `page.evaluate` body are real. It cannot see a selector, or an
assertion that has quietly stopped discriminating. Everything in
[Making sure a harness still discriminates](#making-sure-a-harness-still-discriminates)
is still done by hand and still the part that matters.

**A `page.evaluate` body may not bind a NAME to a function.** `tsx`'s esbuild
transform wraps name-bound functions in a `__name(...)` helper (keepNames), and
Playwright ships an evaluate body to the browser as source, where that helper
doesn't exist — so `const q = (s) => …` inside a body fails as
`ReferenceError: __name is not defined` from inside the page, pointing at a line
that reads perfectly well. An anonymous inline arrow crosses intact, which is
what makes the rule look optional.

Passing the body as a STRING also dodges it, and `auth.mts`,
`backlog-toggle.mts` and `clipboard.mts` take that route — but a string is
opaque to tsc, so it buys the workaround by giving up exactly the checking this
directory was converted for. Prefer writing the helper out: `sidebar.mts` and
`epic-children.mts` spell `document.querySelector` in full for that reason, and
`surface.mts` swapped a `get:` accessor for a `value:`. Verbosity is the cheaper
price.

**So the gate's coverage is uneven, and worth knowing per file.** `clipboard.mts`
is the extreme: all six of its page bodies are template strings, ~69 of its 548
lines, so it compiles under either project without a single DOM reference for
tsc to check — it passes, and that fact says almost nothing. Converting those
bodies is a job for whoever next touches DRY-71's harness, since several of them
interpolate values (`${FRAME_JS(dir)}`) and would need to become functions
taking arguments rather than a mechanical unquoting.

`drift.sh` is the one file here that isn't TypeScript, and that is a decision
rather than an oversight (DRY-80, trap 5): it is `docker exec` and `psql` and
heredoc SQL end to end, so the parts a type system would check are the parts it
doesn't have. It stays shell.

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
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && DRYDOCK_PORT=4374 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_STATE_FILE=/tmp/dry55-state.json node --import tsx src/index.ts &)
(cd daemon && node --import tsx ../scripts/verify/proxy-tracker.mts &)   # :4375 → :4374
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4375 bunx vite --port 5375 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/sidebar.mts)
```

| harness | what it holds down |
|---|---|
| `sidebar.mts` | A tracker outage names itself. Before DRY-55 a first load with the tracker down rendered "No tickets match." — true of a healthy tracker with nothing in scope, and with the scope chips (DRY-30) in the same panel it reads as a filter you got wrong rather than an outage. Asserts the empty case, the **stale** case, the **hang** case and a shell newer than its daemon separately, plus that all of them end without a reload. |

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

Why a second proxy rather than a mode on `proxy-http.mts`: that one breaks the
state store, and the two outages are independent conditions — sharing it would
mean a path parameter on a harness three other scripts depend on.

### The backlog control (DRY-85)

Same rig — daemon, proxy and vite exactly as above — so run it beside
`sidebar.mts` rather than standing anything else up. Run from `daemon/`, which
is where `tsx` is installed:

```sh
(cd daemon && node --import tsx ../scripts/verify/backlog-toggle.mts)
```

| harness | what it holds down |
|---|---|
| `backlog-toggle.mts` | The scope row's backlog control is a switch, and it does not dim on a pull nobody asked for. `refreshingTickets` was set by every pull, so the control disabled and greyed on the 20s poll's cadence — announcing a fetch nobody started and nothing was waiting on. Asserts the background poll leaves it (and the header's spinner) alone, that a scope change still locks it, that the lock clears, and that the switch is still a real `<input type=checkbox>` underneath. |

Two things about it are deliberate and easy to undo.

**It waits for the real 20s poll.** Synthesising a background pull — firing a
visibility wake, say — exercises a different entry point into the same function
and leaves the reported symptom unobserved. The ticket's claim is about *every*
poll, so the poll is what it watches, and that is most of the run's ~45s.

**It parks the pull rather than sampling.** Against the fixture tracker a pull
settles in single-digit milliseconds, so "was the control disabled while it ran"
is a race the harness loses: it samples after the window shut, prints a clean
pass, and does so just as happily against the bug. `hang` gives that window a
beginning and an end, and every "during a pull" check asserts `held > 0` from
the proxy alongside, so a check cannot pass because nothing was in flight.

Confirm it discriminates by pointing it at the unpatched shell (stash the two
files and let vite reload) — it fails 5 of 19, including all three symptoms the
ticket names. It reports them rather than throwing: the toggle is clicked by its
**label**, which both builds have, because a harness that dies on a missing
selector half way through is one you cannot read the discrimination off.

## The tracker cache (DRY-72)

Also self-contained, and it needs a tracker the daemon can really talk to —
`stub-tracker.mts`, a Switchyard-shaped origin that **counts what arrives**.
That counter is the whole point: every claim here is about requests that didn't
happen, and `curl /api/tracker/tickets` returns the same 200 with the same body
whether the daemon answered from memory or spent six seconds re-walking a
corporate Jira. Which is the state the bug shipped in.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && node --import tsx ../scripts/verify/stub-tracker.mts &)    # :4386, counting
(cd daemon && DRYDOCK_PORT=4385 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4386 \
   DRYDOCK_TRACKER_PROJECTS=DRY \
   DRYDOCK_TRACKER_CACHE_MS=4000 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=60000 \
   DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=3000 \
   DRYDOCK_DATABASE_URL= DRYDOCK_STATE_FILE=/tmp/dry72-state.json \
   DRYDOCK_SESSIONS_DIR=/tmp/dry72-sessions node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4385 bunx vite --port 5385 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/tracker-cache.mts)
```

| harness | what it holds down |
|---|---|
| `tracker-cache.mts` | Six concurrent pulls cost ONE fan-out upstream, not six. The child-stats query — the unbounded half, since it spans every status — doesn't repeat with each list refresh. A 2500ms tracker doesn't make a 2500ms sidebar, while Refresh still overrules the cache and waits. A dead tracker leaves the daemon serving last-good with `stale` set (200, not 502) while a key it has never fetched still 502s. And the surface section re-proves DRY-55 end-to-end. |

**Turn the TTLs down, and the harness insists on it.** 20s is the right default
and a terrible test — the same trap DRY-49's timeout and DRY-60's sweep delay
have — so section (c) measures the TTL it actually observes and fails if it took
15s or more, rather than passing by waiting.

The rig deliberately does NOT reuse `proxy-tracker.mts`. That one sits between
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

## Expanding an epic to its children (DRY-83)

Same counting stub as DRY-72, with a second epic switched on: `DRY-10`, whose
children are all in the backlog bucket the sidebar's pull excludes. That is the
shape the whole ticket is about — the epic arrives (providers exempt epics from
the exclusion, DRY-13), the work under it does not, and before DRY-83 the row
went inert with "no children to expand here".

`STUB_DORMANT_EPIC=1` is **opt-in**, and must stay that way: every epic in the
set costs one more child-stats request, and `tracker-cache.mts` asserts
`children <= 1` exactly.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && STUB_PORT=4396 STUB_DORMANT_EPIC=1 node --import tsx ../scripts/verify/stub-tracker.mts &)
(cd daemon && DRYDOCK_PORT=4395 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4396 \
   DRYDOCK_TRACKER_PROJECTS=DRY \
   DRYDOCK_TRACKER_CACHE_MS=4000 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=60000 \
   DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=3000 \
   DRYDOCK_DATABASE_URL= DRYDOCK_AUTH_PASSWORD= DRYDOCK_MULTI_USER= \
   DRYDOCK_STATE_FILE=/tmp/dry83-state.json \
   DRYDOCK_SESSIONS_DIR=/tmp/dry83-sessions node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4395 bunx vite --port 5395 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/epic-children.mts)
```

**Clear `DRYDOCK_DATABASE_URL` and `DRYDOCK_AUTH_PASSWORD` explicitly**, as
above. `env.ts` walks up from cwd and a dev checkout's `.env` has both, so a
throwaway daemon otherwise answers 401 to the whole harness and writes workspace
rows into the database your real desk is using. Real env wins, and an exported
empty string counts as set.

| harness | what it holds down |
|---|---|
| `epic-children.mts` | An epic with no children in the pull can still be expanded, and expands to its OPEN children — not its closed ones, and not by touching the backlog toggle, which is the control that widens the pull. Fetched rows survive a filter that matches only them (they go through `groupTickets`, so anything filtering off the pull alone deletes them), and a filter must not fan out one child query per epic per keystroke — measured on UPSTREAM counts, because the daemon's cache hides it from the route. An epic the pull already covers issues no query at all. Refresh reaches the expanded epic (forced past that cache, or it re-reads the memory that made it stale) **and the rows never leave the screen while it does** — sampled across the refresh, since a check that reads once at the end lands after they are back. |

`DRY-13` in the stub is a closed child, deliberately: expandability is derived
from `childStats.total - done`, so an epic with a done child is what tells that
apart from a plain `total > 0`.

To see it discriminate, restore just the shell half — the daemon route stays, so
what's under test is the sidebar having no way to ask, which is the actual bug:

```sh
git show main:shell/src/components/TrackerSidebar.vue > shell/src/components/TrackerSidebar.vue
git show main:shell/src/lib/tracker.ts > shell/src/lib/tracker.ts
```

Expect **10 failures**, and expect the row's own tooltip to be one of them
(`DRY-10 — no children to expand here`). The backlog-toggle check passes either
way on purpose: it is a guard on something that must not change, not a
discriminator. Restore with `git checkout -- shell/` — note the redirect above
writes the worktree without staging, unlike `git checkout <ref> -- path`, which
stages the revert and will sweep it into the next commit.

**Section (d) was vacuous when first written, and it is worth knowing how.** It
typed a term matching only the fetched children — which, before the fix, emptied
the sidebar of epic rows entirely, because `groups` is built from the filtered
list. Nothing can fan out from rows that are not rendered, so the check passed
against a fan-out AND against the bug that deleted the rows it had just typed
for. Any assertion on this surface has to keep epic rows on screen first.

## Desk chrome (DRY-82)

The same counting stub as DRY-72 and DRY-83, with `STUB_DORMANT_EPIC` **off** —
this file wants the plain set, where `DRY-3` is a closed child. That is the
ticket the sidebar's pull structurally cannot contain (`open=true`), so it is
what proves the out-of-scope lookup reaches `/api/tracker/search` rather than
filtering the loaded list.

The TTLs are turned right UP here, which is the opposite of every other tracker
harness and deliberate: the claim is that a view filter costs the tracker
nothing, so the 20s poll must be answered from the daemon's memory or every
count is noise.

`DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=120000` is load-bearing in **both**
directions, and section (f) is wrong without it. Shorter than the shell's own
12s budget (the daemon's default is) and a silent stub reaches the browser as a
prompt 502, so the shell's deadline is never exercised at all. Longer, but still
inside the round, and the daemon gives up partway through — which unwedges the
shell for free and makes the wedge check pass against the bug it exists for.
Measured at 30s: it did.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && STUB_PORT=4383 node --import tsx ../scripts/verify/stub-tracker.mts &)
(cd daemon && DRYDOCK_PORT=4382 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4383 \
   DRYDOCK_TRACKER_PROJECTS=DRY \
   DRYDOCK_TRACKER_CACHE_MS=60000 DRYDOCK_TRACKER_CHILD_STATS_CACHE_MS=60000 \
   DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS=120000 \
   DRYDOCK_DATABASE_URL= DRYDOCK_MULTI_USER= \
   DRYDOCK_AUTH_PASSWORD=dry82-throwaway DRYDOCK_AUTH_USER=alexandra.dodson-admin \
   DRYDOCK_STATE_FILE=/tmp/dry82-state.json \
   DRYDOCK_SESSIONS_DIR=/tmp/dry82-sessions node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4382 bunx vite --port 5382 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/desk-chrome.mts)
```

**Clear `DRYDOCK_DATABASE_URL` explicitly**, and see the note under DRY-83's rig
for what happens if you don't. `DRYDOCK_AUTH_PASSWORD` is the exception here: it
is SET rather than cleared, and it is load-bearing. The header's account name /
`Sign out` pair only renders when there is an account to name, and that pair is
one of the five things the ticket lists as resizing `.controls` — measure the
signed-out desk and section (b) measures the narrowest that cluster ever gets,
which is the one posture where the overlap it checks for cannot happen. That is
exactly how the first cut passed against 25px of overlap at 1100 and 95px at
960. The harness signs in if it finds the door, so nothing else about the rig
changes; override with `DESK_PASSWORD` / `DESK_ACCOUNT` if you change them here.

**`DRYDOCK_AUTH_USER` is load-bearing for the same reason and was the second
half of the same mistake.** The daemon's default is `owner` — five characters,
about a third of the cap `.whoami` puts on that element — so a header measured
with it says nothing about the header anybody with a real account name sees.
Section (b) asserts the element has actually reached its cap before it measures
anything, alongside the `.whoami`/`Clear finished` check.

| harness | what it holds down |
|---|---|
| `desk-chrome.mts` | Runs against a daemon **with a password**, and injects a finished session into the session poll — both deliberate: the account name / `Sign out` pair and `Clear finished` are two of the five things that resize `.controls`, and without them section (b) measures the narrowest that cluster ever gets, which is the one posture where the overlap it checks for cannot happen. The header carries one spawn control, and the palette does what the two removed buttons did — asserted on the request BODIES, since a workspace is two POSTs and a pinned row issuing only the first looks identical on screen. The old `⇧↵` spawns nothing rather than being repurposed onto the selected ticket. The layout switcher is centred on the HEADER and stays there when the right-hand cluster changes width. Swept at 1600/1500/1441 (centred) and 1440/1240/1100/960 (packed — below the breakpoint the header stops centring rather than painting one control over another), against the FULLEST `.controls` this desk can carry: an account name at its cap, `Clear finished`, the folder chip. Plus a latch on the slack that breakpoint spends — the chip is the only child that can give, so a chip squeezed to its floor means the next control added to that cluster overlaps, which no `switcherRight <= controlsLeft` test can see. The four filter selects are `key=value` pills that cost the tracker no request, complete from the loaded set, and — typed free-hand — say when they name something this pull cannot contain. A closed ticket is found through `/api/tracker/search`, in a block of its own, debounced. And **(f)** the same path failing: a retry that succeeds shows the rows it fetched rather than the error it replaced, and a hung request gives up instead of wedging every later search for the life of the page. |

Spawns are **intercepted** (`page.route` on `POST /api/sessions`, answered with
a session-shaped 201). Letting them through would start a real `claude` per
check on whatever host this runs on, and the claim is what the palette ASKS the
daemon for.

To see it discriminate, restore the shell half — the daemon is untouched by this
ticket except for being asked a question it could already answer:

```sh
git show main:shell/src/App.vue > shell/src/App.vue
git show main:shell/src/components/QuickLaunch.vue > shell/src/components/QuickLaunch.vue
git show main:shell/src/components/TrackerSidebar.vue > shell/src/components/TrackerSidebar.vue
git show main:shell/src/lib/tracker.ts > shell/src/lib/tracker.ts
```

`tracker.ts` is in that list because the deadline on `searchTickets` lives there,
and it is one of the two things section (f) is for.

Expect **44 failures of 72**. Restore with `git checkout -- shell/` — the
redirects above write the worktree without staging, unlike
`git checkout <ref> -- path`, which stages the revert.

**Twenty-eight checks pass either way, and they are two different kinds — don't read
the second as slack.** Some are guards on things that must NOT change: the
switcher not overlapping the controls (true of the old layout too, which drifted
without colliding), bare text still filtering the loaded list, the scope chips
and the backlog switch surviving the redesign, and `no pill, and no keystroke,
re-pulled the list`. The rest guard a REVIEW FINDING in a feature `main` doesn't
have at all — `and the error note is gone with it`, `and the sidebar does NOT
claim the tracker has nothing for it` — so they cannot discriminate against the
pre-ticket tree and were each confirmed against the specific bug instead, by
reinstating it. That is the only honest way to check a fix to a fix.

**Six checks were vacuous when first written and had to be tightened**, which is
the failure mode this whole directory is about: "no pills afterwards" is
satisfied by a bar that never had one, "not merged into the repo groups" by
nothing having been found at all, "not seven queries" by a shell that never
searches, and the wedge probe by anything that rescues the hung request. The
pinned-row selection check is the sharpest example — see below.

Two of the twenty-two are the *other* direction of that rule and were added in the
same round it was fixed: a ticket-shaped query must still select a ticket, and a
generic word must claim no pinned row. Neither can fail against `main` (which
has no pinned rows to claim), but the second is a real latch — `agent` was on
two of the three rows, so `Ctrl K`, `agent`, `↵` spawned a bare claude in a repo
where every ticket is about agents. Re-adding any of `agent`, `drawer`, `split`
or `terminal` fails it.

**The palette's fixture cannot collide by accident, and that hid a real bug for
two rounds.** None of the five stub titles contains `shell`, `claude`,
`workspace` or `wo`, so a check typing a pinned row's name sees no ticket
matching the same query — and the selection rule reads BOTH. The original check
then also *clicked* the row rather than pressing `↵`, which is the one gesture
the `⇧↵` removal was justified by. `de` is the only string in this fixture
inside both a pinned row's terms ("claude") and a loaded ticket's title (DRY-5,
"…when hidden"), which is why that check uses a two-letter query that looks
arbitrary. Same shape as DRY-83's "keep epic rows on screen or it proves
nothing": the row you are NOT asserting on has to be there.

**Section (f) was added after review**, which found two bugs by reading a path
that 35 green checks had never once executed — a retry that could never visibly
succeed, and a hung request wedging the search path permanently. Both first cuts
of the new round passed against the bug they were for, and both fixes are worth
knowing:

- **Do not `__heal` before probing the wedge.** Healing releases the held
  response, so the hung promise settles and unlatches the handle on its own.
  `__break?mode=502` instead — the old request stays held, a new one fails fast,
  so "the note changed" can only mean a request went out.
- **Keep the wedge probe's own window short** (`WEDGE_PROBE_MS`). Under the fix
  the next search lands in about a second; the only thing a longer window buys
  is time for something else to rescue the hung request.

Run `epic-children.mts`, `sidebar.mts` and `backlog-toggle.mts` beside this one.
All three drive `.sidebar .searchbox input` or the scope row, which is what this
ticket rebuilt around them.

## The tombstone's resume button (DRY-62)

Needs a **database tier** — tombstones are drawn from session history, and only
Postgres retains it. Throwaway container, throwaway everything:

```sh
bunx playwright install chromium             # once per machine; see "Running these"

docker run -d --name dry62-db -e POSTGRES_PASSWORD=dry62pw -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55462:5432 postgres:16-alpine

(cd daemon && CLAUDE_CONFIG_DIR=/tmp/dry62-claude DRYDOCK_PORT=4392 \
   DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d62 DRYDOCK_TRACKER=fixture \
   DRYDOCK_DATABASE_URL='postgres://drydock:dry62pw@127.0.0.1:55462/drydock' \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4392 bunx vite --port 5392 --strictPort &)

(cd daemon && CLAUDE_CONFIG_DIR=/tmp/dry62-claude node --import tsx ../scripts/verify/tombstone.mts)
```

`CLAUDE_CONFIG_DIR` must be the same value in both places: the harness plants
and deletes a transcript under it, and the daemon resolves transcripts from its
own environment. Point it at a scratch directory rather than `~/.claude`, or
the harness will `chmod 000` your real one for six seconds.

| harness | what it holds down |
|---|---|
| `tombstone.mts` | A tombstone's button tells the truth about the conversation behind it. The gate was `command === "claude" && agentSessionId`, and an id is not a transcript: the SessionStart hook reports one whether or not the CLI is persisting anything, so every session a pre-DRY-59 daemon spawned recorded an id pointing at nothing. Asserts the label BOTH ways, that the click's args agree with the label, and that a daemon which cannot read the transcript directory says nothing rather than stripping Resume from every card on the desk. |

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
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && DRYDOCK_PORT=4360 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d60 \
   DRYDOCK_STATE_FILE=/tmp/dry60-state.json DRYDOCK_RUNS_ROOT=/tmp/dry60-runs \
   DRYDOCK_TRACKER=fixture DRYDOCK_CLEAR_FINISHED_AFTER_MS=8000 \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4360 bunx vite --port 5360 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/sweep.mts)

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
| `sweep.mts` | Finished sessions clear themselves and **nothing else does**. Four rounds: **A** the rail (a run that ended while you were in another tab is still there when you come back, never having counted down to nobody; the finished card announces itself before it goes; the failed one never does either; plus the tier's own line — raised on the file store once the sweep has actually cost something, absent before that and absent entirely on Postgres). **B** the desk (an unfocused finished window clears, the focused one doesn't, a running session and a workspace whose zsh is still alive are both left, `Clear finished` counts only what it would take and takes nothing that was running). **C** a crowded rail — ten runs, every countdown still rendered, still fitting its card, and still costing that card no width (the lane is one non-wrapping scrolling row, so a wider card is one pushed off the end). **D** the dock and synthetic focus: a docked window is never swept, and two windows nobody has clicked both clear. |

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

## Who may use the daemon (DRY-27)

Three postures are three code paths, not three settings, so the rig runs all of
them at once — one daemon each, one vite each (`VITE_DAEMON_URL` is baked in at
vite start, so a daemon needs its own server). The multi-user one needs a
database, because that is the whole point: no Postgres, no accounts.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

# The harness reads these two and has NO defaults, so the password a daemon is
# started with and the one the browser types cannot drift apart. Both 8+ chars —
# the daemon refuses a shorter one, including its own configured credential.
export DRYDOCK_TEST_PASSWORD=whatever-you-like-8-plus
export DRYDOCK_TEST_PASSWORD_B=something-else-8-plus

# A throwaway password for a throwaway container, generated rather than written
# down — a literal one in a checked-in file is a credential-shaped string that
# every scanner has to be told to ignore, forever, for no benefit.
export PGPASS=$(openssl rand -hex 12)
docker run -d --name dry27-db -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55441:5432 postgres:16-alpine

# off — what a fresh clone runs
(cd daemon && DRYDOCK_PORT=4392 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_STATE_FILE=/tmp/dry27-off.json DRYDOCK_SESSIONS_DIR=/tmp/dry27s-off \
   node --import tsx src/index.ts &)
# single — one account, no database
(cd daemon && DRYDOCK_PORT=4394 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_STATE_FILE=/tmp/dry27-single.json DRYDOCK_SESSIONS_DIR=/tmp/dry27s-single \
   DRYDOCK_AUTH_PASSWORD="$DRYDOCK_TEST_PASSWORD" node --import tsx src/index.ts &)
# multi — accounts in Postgres
(cd daemon && DRYDOCK_PORT=4393 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_SESSIONS_DIR=/tmp/dry27s-multi DRYDOCK_MULTI_USER=1 \
   DRYDOCK_DATABASE_URL="postgres://drydock:$PGPASS@127.0.0.1:55441/drydock" \
   DRYDOCK_AUTH_USER=magos DRYDOCK_AUTH_PASSWORD="$DRYDOCK_TEST_PASSWORD" \
   node --import tsx src/index.ts &)

(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4392 bunx vite --port 5392 --strictPort &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4394 bunx vite --port 5394 --strictPort &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4393 bunx vite --port 5393 --strictPort &)

# the second account the isolation scenario signs in as
TOK=$(curl -s -X POST localhost:4393/api/auth/login -H 'Content-Type: application/json' \
        -d "{\"name\":\"magos\",\"password\":\"$DRYDOCK_TEST_PASSWORD\"}" | jq -r .token)
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
     localhost:4393/api/users \
     -d "{\"name\":\"colleague\",\"password\":\"$DRYDOCK_TEST_PASSWORD_B\"}"

(cd daemon && node --import tsx ../scripts/verify/auth.mts)
```

| harness | what it holds down |
|---|---|
| `auth.mts` | The desk is behind the door: with a password set the shell renders a login view and NOT the desk, a wrong password says so, a right one opens it, a reload keeps it, a dead token returns to the door with an explanation, and signing out stops the polls. Plus the two transports that cannot carry a header (SSE and the terminal WebSocket, both on short-lived stream tokens), and multi-user isolation at the surface — B cannot see A's private run, sees A's shared one, is offered no way to clear it, and gets a read-only pane. |

Why a browser and not curl: `curl /api/sessions` returning 401 is *also* what a
shell that ignored auth entirely would be talking to. That shell would render
its desk, poll every three seconds, and put a banner about an unreachable daemon
on screen — the desk drawing anyway is the bug, and only a rendered page can see
it. The stream-token transports are worse than that: neither `EventSource` nor
the browser `WebSocket` constructor exists outside a browser, so there is no
curl equivalent of the path the shell actually takes.

**Confirm it still discriminates** before trusting a green run. Break exactly the
gate and re-run — the two checks in (b) must fail:

```sh
sed -i 's/v-else-if="!signedIn"/v-else-if="false"/' shell/src/App.vue
sed -i 's/if (signedIn.value) await startDesk();/await startDesk();/' shell/src/App.vue
(cd daemon && node --import tsx ../scripts/verify/auth.mts)   # expect: FAIL the login view replaces the desk
git checkout shell/src/App.vue
```

The one scenario that needs care when editing: **B's window count is a delta, not
an absolute**. By the time the desks are compared, B is watching A's shared run —
a window B opened on purpose — so `=== 0` would fail against correct behaviour,
and (worse) written before the watch step existed it would have passed
vacuously.

Teardown: kill the daemons by EXECUTABLE, never by pattern — `pgrep -f "tsx
src/index.ts"` also matches the shell whose command line contains that string,
which is CLAUDE.md's `pkill -f supervisor/main` footgun one pattern over.

```sh
for p in $(pgrep -f "tsx src/index.ts") $(pgrep -f "supervisor/main"); do
  case "$(readlink /proc/$p/exe)" in *node*) kill -9 "$p";; esac
done
docker rm -f dry27-db
```

## The permission gate's action row (DRY-78)

The gate BLOCKS — an autonomous run is parked on a `PreToolUse` hook waiting for
the answer — so a control that can't be reached is a run that can't proceed.
Needs no tracker, no database and no `claude`: the row is driven by posting a
hook payload with whatever `tool_name` you like.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

(cd daemon && DRYDOCK_PORT=4378 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/dry78 \
   DRYDOCK_STATE_FILE=/tmp/dry78-state.json DRYDOCK_TRACKER=fixture \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4378 bunx vite --port 5378 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/gate-actions.mts)
```

| harness | what it holds down |
|---|---|
| `gate-actions.mts` | Every control in the gate's action row is inside the panel on all four edges, inside the viewport, and lands its own hit test — across seven viewports, both modes (the answers and the deny row are different controls at different widths), and three arguments. Plus the two things the row's width and height cost elsewhere: the line naming the tool in full must not be cut, and the panel must not be pushed off the top of the desk. |

**Drive it with a long MCP tool name, not `Bash`.** One button's width is data —
`Always allow {{ gate.tool }}` — and an MCP name is a single unbreakable token
(`mcp__switchyard__transition_ticket_by_category`, 44 characters), so the row's
width depends on which tool the agent happened to call. Every gate you meet by
hand while testing is a short builtin, and those fit; that is how it shipped.
`Bash` is in the table as the control, not for coverage.

Three assertions per control, because each catches a different failure, and they
disagree about which viewports are interesting:

- **inside panel**, on all four edges. The horizontal pair: at 1600px the spill
  renders outside the panel but still inside the window, so this is the only one
  that sees it. The vertical pair: the panel is anchored by its BOTTOM and capped
  in height, so a cap with no `overflow` backstop doesn't clip the surplus — the
  action row renders past that edge and under the rail, unreachable again by a
  different route. The panel's own rect can't show that, because it stays the
  size of the cap while its content leaves; only the controls can.
- **inside viewport** — at 560px the panel itself was off-screen, so this is the
  only one that sees *that*.
- **hittable** — `elementFromPoint` at the rect's centre. A rect is healthy
  whether or not anything can reach it (DRY-74's lesson). Note the rail is
  `pointer-events: none` and draws a scrim over the desk's bottom 98px, so a
  hit-test failure here can be a missing `pointer-events: auto` rather than a
  layout overflow — and the offline banner shares this strip, so it can be
  something painting over the row rather than the row leaving.

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

**The two shortest viewports are not more of the same.** Above ~500px of height
the panel fits however the row is arranged, so every assertion passes with or
without the height cap's `overflow` backstop — 430px and 380px are where that
backstop is the only thing between the action row and the rail. The `notice-up`
round is the other half: it fails a tracker pull so App.vue raises a notice,
which is in the flex column ABOVE the desk and shortens it *without touching the
viewport*. That is the one case separating "reads the desk" from "reads the
window", and it asserts the desk really did shrink before trusting the round.

The sidebar is deliberately NOT varied, though it was the reason `100vw` was the
wrong reference: `sidebarOpen` is a `ref(true)` that nothing toggles, so the app
cannot vary it either — and the fix made the panel's width relative to the rail,
which is what stopped the sidebar mattering at all.

Two of the assertions do not discriminate against `main`, and that is
information rather than a defect — `main` had a *worse* bug masking each. The
panel's `max-width` was measured against `100vw` while the panel hangs off the
rail, which starts after the 266px sidebar, so on `main` the panel was 520px
wide and simply hung off the screen: its action row never overflowed it, and its
`.ask` line had width to spare. Point the harness at the tree with only
`overflow-wrap: anywhere` removed to see the tool-name check bite (82px), and at
`main` for the other 46.

Same technique for the vertical half, which `main` also can't discriminate for
the same reason: drop `overflow: hidden auto` and the sticky positioning from
`.actions`, and the four-edge check reports the row spilling 9-85px past the
panel's bottom at the short viewports.

## The terminal's clipboard keys (DRY-71)

Self-contained: a throwaway daemon, a vite, and a browser. No tracker, no
database, no `claude` — the panes are `/bin/sh`. About 30 seconds.

```sh
npm i playwright --prefix scripts/verify     # ad-hoc; not a repo dependency

(cd daemon && DRYDOCK_PORT=4379 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/dry71 \
   DRYDOCK_STATE_FILE=/tmp/dry71-state.json DRYDOCK_TRACKER=fixture \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4379 bunx vite --port 5379 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/clipboard.mts)
```

Panes are told apart by their working directory: a window's title comes from its
COMMAND, so five `/bin/sh` panes are identical in the bar, and the `~/<cwd>` chip
beside it is the only thing about a spawn the desk renders that the caller picks.
**The harness creates those directories itself**, deliberately — it used to ask
you to `mkdir` them, and a missing one is silent and looks exactly like a product
bug: the daemon records the cwd it was handed, so the frame still says `~/<dir>`
and the pane still attaches, while the PTY dies on the spot and every keystroke
after that vanishes into what looks like a working terminal. `attached()` now
also refuses DRY-41's exit banner for the same reason.

| harness | what it holds down |
|---|---|
| `clipboard.mts` | Copy and paste from the keyboard, in both directions and between two panes, plus the two keys that must NOT change: `Ctrl+C` still raises SIGINT and `Ctrl+V` still sends SYN. Also that the shell never reaches for `navigator.clipboard`, which is absent on the plain-HTTP origin prod is served from, and that `Ctrl+K` still opens the palette — DRY-71 moved that chord's letter-matching into a helper it now shares with the clipboard keys. |

Five things about it are deliberate.

**It presses the keys for real and asserts on the PTY's echo.** Dispatching a
`paste` ClipboardEvent from the harness proves xterm's listener works, which was
never in doubt — the bug is that the listener is *unreachable*. `page.keyboard`
goes through Chromium's input pipeline and therefore through its
editing-command table, which is the half under test, and characters appearing in
`.xterm-rows` are something only a real paste could have put there.

**The panes run `stty lnext undef`.** Without it a `^V` reaching the tty is
swallowed by the line discipline's literal-next and echoes nothing — so the SYN
this ticket is named for is invisible at the only surface the harness can see,
and the check that it is *deliberately still there* would pass against anything.

**It takes `navigator.clipboard` away from the page** (`addInitScript` stashes
the real object on `window.__clip` for the harness's own seeding and reading,
and leaves the page a throwing stub). 127.0.0.1 is a secure context, so that API
works here and does not exist in prod; without this, a fix written against it
passes every check and does nothing on the box it ships to.

**Section (f) runs the copy checks again with `navigator.platform` forced to
`Win32`.** This is the half a Linux box structurally cannot show you: xterm
mirrors a *mouse* selection into its helper textarea to feed X11's PRIMARY
selection, guarded by `Browser.isLinux`, so on Linux there is always a selection
lying about and `queryCommandEnabled("copy")` is true for reasons that have
nothing to do with the terminal. Two checks stand in front of the copy ones and
prove the override took: the mirror really is absent (`textarea.value` empty and
its selection range collapsed — the mirror IS those, so they are what gets read,
not `window.getSelection()`, whose treatment of a textarea selection is a
browser-version detail and could report "empty" for the wrong reason), and the
command really does report itself disabled. If either flips, everything under
them is vacuous.

**Section (g) is the fallback, and it is a stub browser built to order.** Every
browser measured returns true from `execCommand("copy")` — Chromium and Firefox,
Linux and forced-Win32 — so nothing else in the file ever reaches
`copySelection`'s second attempt, and an untested fallback for a *silent* failure
is worse than none. So `document.execCommand` is replaced with one that refuses
exactly the first `copy` per press, returning false without copying, which is
what a disabled command does. It refuses on a counter the harness arms rather
than by inspecting the selection: on this Linux host the mirror keeps handing the
bare attempt a selection, so a selection-sniffing stub never refuses and the
section passes having tested nothing. (Written down because that is the first
version this shipped as.)

Confirm it discriminates by swapping in `main`'s copy of the two shell files —
`git show origin/main:<path> > <path>`, let vite reload, then restore from a
backup copy. **Not `git stash`**: the fix is committed on this branch, so
stashing only removes uncommitted review edits and reports 1 failure instead of
5, which reads like the harness going soft. Against `main` it fails **5 of 25** —
both `Ctrl+Shift+C` checks, the round trip between panes, and both of (g)'s.
Removing *only* the fallback (drop the `if (…) return;` in `copySelection`) fails
exactly one, (g)'s last, which is how you know that branch isn't dead code.

Note what does *not* move, because it is the ticket's premise and it was wrong:
`Ctrl+Shift+V` and `Shift+Insert` already pasted before this change, and
`Ctrl+Insert` already copied — in both platform conditions. xterm's ctrl branch
requires `!shiftKey`, so it never claimed ctrl+shift+letter and `_keyDown`
returned before `cancel()`; the proposed fix of returning `false` for those two
would have been a no-op. Copy was the only gap, and only on `Ctrl+Shift+C`, which
no browser generates a `copy` event for.

## Per-spawn env on `POST /api/sessions` (DRY-66)

A throwaway daemon and nothing else — no browser, no vite, no database, no
tracker. A few seconds.

```sh
(cd daemon && DRYDOCK_PORT=4366 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d66 \
   DRYDOCK_STATE_FILE=/tmp/dry66-state.json DRYDOCK_TRACKER=fixture \
   DRYDOCK_WORKTREES_ROOT=/tmp/dry66-wt node --import tsx src/index.ts &)

(cd daemon && node --import tsx ../scripts/verify/spawn-env.mts)
```

`DRYDOCK_WORKTREES_ROOT` is not decoration: one refusal case spawns against a
throwaway git repo with a ticket, which is what puts the DRY-15 worktree block —
the side-effectful code upstream of the guard — in play. Point it somewhere
disposable, because that is precisely where a regression will write. Unset, it
falls back to `~/.drydock/worktrees`, which the dev and prod daemons share.
(The harness's own header block omitted this line until review; the in-file rig
is the copy anybody reading the harness will actually paste, so the two have to
agree.)

**Run it from a shell whose env still carries the prod daemon's config, and you
will test the prod daemon's config.** The `env -u` list CLAUDE.md gives for the
second-instance pattern applies here in full: a session spawned by Drydock
inherits `DRYDOCK_AUTH_PASSWORD` and `DRYDOCK_DATABASE_URL`, and every
unauthenticated `fetch` in this harness then 401s against a daemon it thinks is
open.

What it holds down:

- **A 201 is not evidence.** The daemon answered 201 to a body carrying `env`
  for the entire time the field was being dropped — that IS the ticket. So the
  session writes its own environment to a file and the harness reads it back
  through `/api/sessions/:id/file`: the only route those bytes can have taken is
  `execve`. Assert on what arrived, never on what was accepted.
- **A refusal must start nothing.** Every refusal is checked for its 400, for
  the key being NAMED in the message, and for the session count not moving. The
  count is the one that catches a guard placed after `manager.create`, where
  every message assertion still passes over a real PTY.
- **And it must not have DONE anything either.** The worktree block runs `git`;
  a guard below it leaves a branch and a checkout for a spawn that was refused.
  Asserted with `git branch --list` against the harness's own repo.
- **The two refusals with different messages are different claims.** A denied
  key is policy ("this is how the daemon runs the session"); a DRY-59 marker is
  physics ("the supervisor deletes it, so this could only ever look like it
  worked"). One message for both sends the caller hunting for a knob that
  doesn't exist.
- **Empty is not refusal.** Omitted, `null` and `{}` all spawn, so a client that
  always sends the field doesn't have to special-case having nothing to put in it.
- **The four keys review found reachable each have a case**, because each one
  crosses the line the deny set draws by a different door: `ALL_PROXY` (the
  hooks' `curl` obeys it, so a caller answers their own gate without replacing a
  binary), `TERM` (accepted, then silently overwritten by the daemon's own
  spread — the one thing this channel may not do), `CLAUDE_CONFIG_DIR` (the
  daemon reads its own copy to find transcripts, so a per-spawn one strips
  Resume), and `HOME` (the `-l` shell's startup files, and the
  `~/.claude/settings.json` that the gate hook is installed through). The `TERM`
  case doubles as the only route-visible test of the spread-order claim.

The `NOTE` line about claude markers is **reported, not counted**, and DRY-59
trap 1 is why: from a bare terminal there is nothing to inherit, so it would
pass just as cleanly against a deleted strip. It only means something when the
daemon under test was itself started from inside a `claude` session — which, if
you are reading this from an agent, it probably was.

Discrimination (see [the section below](#making-sure-a-harness-still-discriminates)):
against `main` it fails **41 of 47**. Six survive, and all six should:

- `spawn accepted`, `the daemon's own keys are intact` and `the session key is a
  uuid` — the arrival section's checks that don't depend on the field being
  read. A 201 arrives either way, and the daemon sets its own keys either way.
  They are context for the three beside them, not the claim.
- the three empty cases (omitted / `null` / `{}`), which assert the field is
  optional — and it was optional before, by being ignored.

Both numbers were wrong on the first pass (31 of 35, "the three that survive are
the empty cases") and review caught it. Worth stating why that matters more than
a typo: CLAUDE.md makes discrimination the precondition for trusting a green run,
so a reader who runs this and sees a different total cannot tell a stale doc from
a harness that has quietly gained or lost assertions. **Re-measure both numbers
when adding a case here** — do not count them by hand, which is how they were
wrong.

## Reaping finished worktrees (DRY-90)

A throwaway daemon plus the DRY-72 stub tracker — no browser, no database.
Fifteen seconds, four of which are waiting out a turned-down sweep interval.

```sh
(cd daemon && STUB_PORT=4396 node --import tsx ../scripts/verify/stub-tracker.mts &)

(cd daemon && DRYDOCK_PORT=4390 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d90 \
   DRYDOCK_STATE_FILE=/tmp/dry90-state.json \
   DRYDOCK_WORKTREES_ROOT=/tmp/dry90/wt DRYDOCK_REPO_PATHS=demo=/tmp/dry90/demo \
   DRYDOCK_WORKTREE_REAP_MS=4000 \
   DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4396 \
   DRYDOCK_SWITCHYARD_TOKEN=stub node --import tsx src/index.ts &)

(cd daemon && node --import tsx ../scripts/verify/worktree-reap.mts)
```

The harness builds its own bare-origin-plus-clone under `/tmp/dry90`, so nothing
here touches a real repo — but `DRYDOCK_WORKTREES_ROOT` is still the line that
matters most in that block. Unset, it is `~/.drydock/worktrees`, which the dev
and prod daemons share and which is full of real work; this harness deletes
worktrees for a living. So it **asks the daemon** where its root is
(`/api/repos/resolve`) and refuses to run if that isn't the fixture's. It used
to compare its own constant against a drydock-looking string, which is the same
string whatever the daemon is doing — a guard that could not fire, over the one
mistake worth guarding.

`DRYDOCK_SESSIONS_DIR` is nested one level (`…/sessions-4390`) on purpose: the
cross-daemon case writes a sibling `sessions-4999` beside it, which is how a
daemon finds out that ANOTHER daemon has a live agent in a worktree it can see.

`DRYDOCK_WORKTREE_REAP_MS` must match the harness's `REAP_MS` (default 4000).
Six hours is the right default and a terrible test — DRY-49's timeout and
DRY-60's sweep delay again — so it refuses anything over 30s rather than pass by
never reaching a sweep.

The stub tracker supplies the half git cannot answer: `DRY-2` is in progress and
`DRY-3` is closed, which is how the SQUASH-merge case is tested — a branch whose
commits are all on the remote but which no containment check will ever call
merged.

What it holds down:

- **Every case is a PAIR.** A reaper that deletes the four stale checkouts on a
  host is easy, and it is impossible to notice — until months later — that it
  also deleted the one holding two unpushed commits. So each removable worktree
  is asserted beside one that differs in exactly one respect and must survive:
  merged-and-clean against merged-but-modified, against merged-but-untracked,
  against clean-but-two-commits-unpushed, against never-pushed-at-all. And
  against merged-with-an-IGNORED-file, which must still go — counting build
  output would make every worktree of every real project unreapable.
- **Assert on the directory, never on the response.** The route can only report
  what it believes.
- **A live session outranks the entire policy, whoever's session it is.** The
  in-use worktree is created by the daemon's own spawn path and then genuinely
  merged, so every other check in the file says remove it and the session is the
  only thing in the way. It is re-checked after the scheduled sweep, because that
  is the trigger that runs with nobody present. A second case does the same with
  a session belonging to a DIFFERENT daemon — the registry is per-process while
  `~/.drydock/worktrees` is per host, so this daemon's own registry is a truthful
  answer to the wrong question.
- **A branch that has never committed anything is not "merged".** It sits
  exactly on `origin/main`, so containment says yes; reading that as finished
  reaps a freshly spawned agent's checkout without ever asking the tracker.
  Asserted as a pair — the same shape with an open ticket must be kept and with
  a closed one must go — because either alone reads as "never reap a fresh
  worktree", which would leave exactly the litter this ticket is about. This is
  also why the merged cases here do a real `--no-ff` merge rather than a bare
  `git worktree add`.
- **The branch survives, and the worktree can be re-added.** The second half is
  the `rm -rf` trap: deleting the directory leaves admin metadata behind, the
  branch stays "checked out somewhere", and the failure only shows up the next
  time somebody spawns that ticket. Proved by re-adding it.
- **The dependency gets its own pair.** `POST /api/worktrees/remove` on a dirty
  worktree must 409 with the safety report and leave it there; the same request
  with `force: true` must still discard it. Reset is a human pressing a button
  and has to keep working — what it must not do is what it did until DRY-90,
  which is delete uncommitted work without mentioning it.

Discrimination (see [the section below](#making-sure-a-harness-still-discriminates)),
and this one needs more than one mutation, because the predicate is enforced in
two places and the liveness/finished rules are a third:

- `removeWorktree` back to an unconditional `--force`: **3 of 31** fail, all in
  the `/api/worktrees/remove` section. The reaper's own cases survive, correctly
  — `consider` refuses before the primitive is reached.
- `WorktreeReaper.consider` with its safety check deleted (and the primitive
  forced, or the belt underneath hides it): **12 of 31**, including `the sweep
  … leaves the dirty one where it is`. That one is the failure that would cost
  somebody work.
- the three pre-review reaper behaviours restored at once — registry-only
  liveness, `merged` short-circuiting the tracker, and a detached HEAD measured
  rather than refused: **6 of 31**, a pair per behaviour. Worth running as one
  mutation, since the failing names map straight onto them.


### …and which gesture may trigger it

`worktree-reap-ui.mts` is the browser half, and it needs a vite server and two
more daemon settings — the rig is in its header. The claims are the ones the
daemon cannot distinguish, because the kill it receives is byte-identical
whoever sent it:

- **B**: closing a window reaps its worktree and the desk says so, naming the
  branch it kept.
- **C**: DRY-60's automatic sweep closes a window and reaps NOTHING — asserted
  against the very worktree B just proved reapable (same ticket, same branch,
  same predicate), so the only variable is who closed the window. Aim this at a
  worktree the policy would refuse anyway and it passes against the bug.
- **A**: the panel's Reset refuses a dirty worktree, says what is in it, and
  discards it on the second press.

`DRYDOCK_WORKTREE_REAP_MS=0` in that rig is not laziness — the scheduled reaper
has to be OFF or it removes C's worktree on its own and the sweep gets the
blame. Discrimination: move the `reapClosedWorktree` call out of `closeWindow`
and into `endWindow` (the shared path — exactly the mistake the ticket warns
about) and it fails **2 of 17**: `the worktree is STILL THERE` and `nothing
claimed otherwise`. Those two are the whole point of the file.

## A session's first output (DRY-79)

A throwaway daemon and nothing else — no browser, no database, no tracker. Under
a minute, most of it the bulk case.

```sh
(cd daemon && DRYDOCK_PORT=4379 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d79 \
   DRYDOCK_STATE_FILE=/tmp/dry79-state.json DRYDOCK_TRACKER=fixture \
   DRYDOCK_SCROLLBACK_BYTES=1048576 node --import tsx src/index.ts &)

(cd daemon && node --import tsx ../scripts/verify/spawn-replay.mts)
```

`DRYDOCK_SCROLLBACK_BYTES` is in that line for the same reason
`DRYDOCK_WORKTREES_ROOT` is in DRY-66's: the bulk case asserts an EXACT character
count over a ~300 KB payload, so a host whose `.env` turns the ring down fails
this file for a reason that isn't the ticket. It pins the default rather than
changing it, and a short count prints a NOTE naming the variable.

The same `env -u` sweep CLAUDE.md gives for the second-instance pattern applies
— run this from a shell inside a Drydock session and every unauthenticated
`fetch` here meets the prod daemon's auth.

What it holds down:

- **The bytes are on a WebSocket, so no curl can see them.** The replay is one
  `{"type":"replay","data":…}` frame on `/api/sessions/:id/attach`. `POST
  /api/sessions` answered 201 and `/api/sessions` listed a healthy session for
  the entire time every session's first output was being dropped — which is why
  this went unnoticed from DRY-57 to DRY-79.
- **The marker must be output that STOPS.** A command that keeps printing proves
  nothing: the socket catches it live and the check passes over a dropped
  replay. So the session prints `PRE` once, sleeps two seconds, then prints
  `POST` — and the harness asserts `PRE` is in the replay while `POST` is *not*,
  which is what makes the first assertion mean anything.
- **Once, not merely present.** The seed and the link's `pendingData` flush are
  two paths onto one buffer; DRY-57's trap 4 applies a layer down, so the count
  is asserted rather than the presence.
- **It has to be in the daemon's RING, not just handed to the pane that was
  open.** A second pane attaches and must replay the same marker — that is the
  form the loss actually took for a reattach, for a second browser and for
  DRY-49's handoff document.
- **The one-shot case is the sharpest.** `printf` and exit: everything the
  session will ever print falls inside the window, so the pane was empty and the
  run read as a command that did nothing.
- **And its exit CODE takes the same window.** The supervisor broadcast its Exit
  frame to an empty client set, so the socket the daemon then dialled closed with
  nothing left to say and the daemon synthesized `-1`: a `printf` that exited 0
  presented as a FAILED run, with DRY-49's handoff and a tracker comment behind
  it. Asserted as both the code and the consequence (`failure` unset), because
  the number on its own doesn't say what it costs.
- **The window is not "a few frames".** The bulk case prints 100k box-drawing
  characters (~300 KB) and the harness reports how much of it was already
  buffered when the pane attached. Runs here saw 110 KB, 114 KB — and, twice, the
  whole 302 KB, i.e. a session that printed 300 KB and then showed an empty pane
  forever. Five concurrent chatty spawns measured 57-193 KB each. The exact
  character count is asserted; the ~300 KB payload also crosses
  `REPLAY_CHUNK_BYTES` when the window is that large, exercising the
  concatenate-before-decode that keeps a 256 KiB cut from landing mid-character.

**What it deliberately does not check** is the half of `adopt` that must not be
copied into `spawn`: `hello.cols`/`hello.rows`. At spawn the supervisor's sizes
came from the meta the daemon just handed it, so its hello echoes the request
and copying them is a no-op — an assertion would pass against both spellings,
which is worse than none.

Discrimination (see [the section below](#making-sure-a-harness-still-discriminates)):
against `main` it fails **7 or 8 of 17**, and the variable one is honest rather
than flaky. `the bulk session finished writing` waits for an END marker: when the
unpatched daemon's window swallows the whole burst, nothing arrives at all and it
fails; when the attach lands mid-burst, END arrives live and it passes while the
count beside it reports something like `29088 of 100000`. Re-measure both numbers
when adding a case here — DRY-66's section explains why that matters more than a
typo, and the first version of this paragraph said 12 when the file emitted 11.

The nine that always survive should. Four are attach preconditions (`a later pane
attaches`, `a pane attaches to the exited session`, `the bulk pane attached`, and
`the one-shot session has exited`) — they exist so that a socket that never
opened reads as its own FAIL line instead of as the claim beneath it failing.
`the replay is a snapshot` and `nothing was decoded across a chunk boundary` are
vacuously true of an empty replay: both are shape checks on what arrived, guarded
by the count checks beside them. And `live output still arrives after it`, `and
the rest of the session with it, once` and the bulk case's byte total exercise
the live path, which was never broken — they are the context that makes the
failures beside them mean "the replay was dropped" rather than "the socket is
broken".

## A prod deploy keeps the sessions (DRY-87)

The only harness here that owns its own systemd unit, and the only one whose
subject is `deploy/`. It renders a throwaway unit from the REAL template through
the REAL renderer, runs a daemon under it, and deploys over the top of a live
session. No browser, no database, no second terminal, about thirty seconds.

```sh
(cd daemon && node --import tsx ../scripts/verify/prod-restart.mts)
```

Run it when touching `deploy/drydock-daemon.service` or `deploy/install-prod.sh`.
It needs a systemd **user** manager (`systemctl --user` must answer) and takes
`:4387` plus `/tmp/dry87*`; it cleans up its unit, its sessions dir and its
supervisors on the way out, including after a failure.

Two claims, neither of which a curl can see:

- **`KillMode=process` spares the supervisors.** Nothing in the API changes, so
  the only evidence is a pid still there afterwards and an agent that never
  noticed. Under the default `control-group` a `systemctl restart` SIGTERMs the
  whole cgroup — supervisors, `claude`, login shells, MCP servers — and
  `install-prod.sh` ends in exactly that command, so **every** deploy did it.
- **A changed `KillMode` applies to an already-RUNNING unit on `daemon-reload`.**
  The "the deploy that ships the fix is the first one to benefit" story rests on
  this entirely, and it is the kind of systemd detail that is easy to assert and
  wrong. So the file reproduces install-prod.sh's order — start under the OLD
  unit, spawn a session, render, `daemon-reload`, `restart` — rather than
  starting with the fix already in place, which would test a much weaker claim.

**Why it renders through `install-prod.sh` rather than substituting the template
itself:** the fragile values are resolved from the deploying shell's own
environment, so a copy of that logic here would verify the copy. Hence
`DRYDOCK_DEPLOY_PRINT_UNIT=1`, which is a mode of the installer — it prints the
unit this host would get and exits, touching nothing, and is worth knowing about
on its own the next time prod won't start.

### Making sure this one still discriminates

The control case at the end is the discrimination check, and it runs on every
invocation rather than being something to arrange: it installs the same unit with
the one line commented out and asserts the supervisors are **killed**. A run
where that case reports "survived" means this file has stopped testing anything.

To see the whole thing fail the way the bug did, comment out `KillMode=process`
in `deploy/drydock-daemon.service` and run it again: **8 of 40** fail, measured
rather than counted by hand. One is the renderer's own check that the line is
there at all; the other seven are the deploy section, out of its thirteen — the
reloaded KillMode, the supervisors, the re-adoption, the log line, the re-attach,
the scrollback and the driveable PTY. Everything else still passes, which is the
point: a deploy that has just destroyed every live agent leaves a daemon that is
up, healthy and answering — that is why this needed a harness and not a curl.

Two things this file does for its own safety, both worth keeping if it is
reworked. Its throwaway unit pins `DRYDOCK_DATABASE_URL`, `DRYDOCK_AUTH_PASSWORD`
`_HASH` and `DRYDOCK_MULTI_USER` **empty** — it starts its own daemon with
`WorkingDirectory=<repo>/daemon`, so `env.ts` walks up and loads the checkout's
`.env`, and on a host that has run `bun run db:up` the daemon would come up on
the Postgres tier and 401 every fetch here. That is CLAUDE.md's `env -u` sweep in
the only form available to a unit file. And the relaunch check runs the real
installer with a scratch `HOME` and a stub `systemctl` alongside the stub
`systemd-run`: it depends on the guard `exec`ing before anything else runs, which
is the very thing under test, so a guard that stops firing has to produce a
failed check rather than a real deploy over the host's prod unit.

One check **skips** rather than fails when this is run from a plain terminal —
the relaunch guard, whose predicate is "am I inside the drydock-daemon cgroup".
There is no honest way to fake that from inside the harness, so run this file
from a Drydock session (which is where somebody deploys from, and the entire
reason the guard exists) to see it.

## The deploy's health check (DRY-81)

`install-prod.sh` ends by polling the daemon it just restarted, and that poll
was `curl -fsS .../api/sessions`. `-f` exits non-zero on 4xx, so on a host with
`DRYDOCK_AUTH_PASSWORD` set the route's **correct** 401 to an anonymous caller
read as "daemon not answering": every deploy printed an error naming
`journalctl`, and exited 1, over a daemon that was up and serving. The first
install is clean because auth isn't configured yet — the bug arrives with the
second deploy.

```sh
node --import tsx scripts/verify/deploy-probe.mts
```

No browser, no database, no systemd, no second terminal: this file starts its
own daemons in both auth postures. It takes `:4381` (`PORT=` to move it), one
ephemeral port and `/tmp/dry81*`, and cleans up after a failure too. About a
minute, most of it the probes that are supposed to wait.

**What it drives:** `DRYDOCK_DEPLOY_PROBE=1 deploy/install-prod.sh`, a mode of
the real script that resolves the port from the prod `.env`, runs the real
probe, and exits having touched nothing. Same argument as DRY-87's
`DRYDOCK_DEPLOY_PRINT_UNIT`: a harness with its own copy of the curl would be
verifying the copy. It is worth knowing about on its own — "would this host's
deploy call its daemon healthy?" is now a question you can ask without deploying.

Five claims, and the middle ones are what a naive fix gets wrong:

- **A 401 means the daemon is up.** The posture is a real daemon with a real
  password, and its anonymous status code is asserted **before** the probe runs
  against it. The control beside it runs the literal old command (`curl -fsS`)
  against the same daemon and requires it to FAIL — without that, the check
  below it could pass because auth wasn't actually on. That posture is `single`;
  the claim that `multi` answers an anonymous caller identically is reasoned in
  a comment there rather than measured, because `multi` needs Postgres and this
  file deliberately takes none. Don't read it as covering all three postures.
- **Anything else on the port does not.** "Any HTTP response means it's up"
  cures the ticket and then reports a healthy deploy while prod is down behind a
  proxy — 502/503/504 is exactly what a reverse proxy with a dead upstream
  answers. And rejecting 5xx is not enough either: a stray web server's plain
  200 page cannot be told from the daemon by status code, so the probe requires
  `"sessions"` in a 200 body and `"authRequired"` in a 401 one. Squatters
  answering 404, 503 **and 200** must all fail, naming what they saw. This is a
  deploy-path case, not a lab one — if something is already holding `:4318` the
  daemon loses the bind and exits, and the squatter is what answers.
- **The probe cannot hang the deploy, and cannot give up on it either.** It had
  no timeout at all, so a listener that accepts and never answers waited forever
  with nothing on stdout; `-m 5` bounds an attempt, and a black-hole listener
  must give up, asserted on wall-clock. The budget for the whole poll went the
  other way — it was five one-second sleeps, and prod reconciles its sessions
  before it binds (DRY-57), so a host with enough live agents gets this ticket's
  sentence again through a slow boot. Sixty seconds now, with
  `DRYDOCK_DEPLOY_PROBE_BUDGET` for this harness's seven failing cases.
- **The probed path is the deploy's path.** Static reads of the script: one
  curl, no `-f`, and the deploy tail calling `probe_daemon`. They exist to catch
  a second, differently-spelled curl being added to the tail — which is the
  shape this bug had.
- **And it reads the `.env` the way the daemon does.** That file is hand-edited
  on a prod host, so `DRYDOCK_PORT="4318"` is an ordinary thing to find in it —
  and `cut` alone probes `:"4318"` while the daemon is on 4318, which is this
  ticket again in a different spelling. Appending a second `DRYDOCK_PORT` line
  is the same trap and worse, since neither port looks wrong in the file:
  `env.ts` takes the FIRST occurrence, so `tail -1` probes a port the daemon is
  not on. There are checks for both shapes.

The failure line is asserted on too, in three arms, because it decides where
somebody looks next. Nothing listening is a `journalctl`. A **5xx** is either a
proxy with a dead upstream or the daemon's own catch-all — `server.ts` turns any
unhandled throw into a 500 — so it is a journal too. Anything else means
somebody has the port and the journal will only say the daemon could not bind.
Both halves of that shipped wrong once, in opposite directions: one hint for
every failure, then a split that asserted the daemon could never be the
answerer.

### Making sure this one still discriminates

Thirteen mutations, all measured, each failing a different section:

| mutation | fails |
|---|---|
| accept only `200` (the ticket's bug) | **3 of 35**, all in "auth on" |
| accept any HTTP response (the overcorrection) | **8 of 35**, every squatter check |
| accept on the status code alone, body unread | **2 of 35**, the 200 squatter |
| drop `-m 5` from the curl (unbounded) | **2 of 35**, the black-hole pair |
| put `-f` back on the curl (either line) | **4 of 35**, "auth on" plus the static check |
| `prod_port` without its quote/space trim | **2 of 35**, the quoted and spaced `.env` |
| `prod_port` back to `tail -1` | **1 of 35**, the duplicate-key `.env` |
| `prod_port` back to a bare `^KEY=` anchor | **2 of 35**, the indented and spaced `.env` |
| drop `probe_failure`'s 5xx arm | **2 of 35**, the 503 and 500 squatters |
| a journal hint on every arm | **2 of 35**, the 404 and 200 squatters |
| the probe budget back to five seconds | **1 of 35**, the static budget check |
| the deploy tail with its own inline port lookup | **2 of 35**, two static checks |
| `prod_port` reading only `$PROD_DIR/.env` | **1 of 35**, the `daemon/.env` case |

The last two rows exist because everything else here drives
`DRYDOCK_DEPLOY_PROBE`, which calls `prod_port`, `probe_daemon` and
`probe_failure` directly — so a deploy tail that grew its own inline `grep …
| tail -1` would leave every behavioural check green. The static block binds all
three, and asserts the default budget rather than waiting it out, since the
failing probes here run at a turned-down one.

The journal pair is a **pair with disjoint failures** — the 5xx squatters assert
the hint is present, the 404 and 200 ones assert it is absent — so each mutation
leaves the other's checks green. Review caught this table naming the wrong pair,
which is worse than a missing row: the table is what the next person runs to
decide whether this file still works, and two unexpected failures read as the
mutation having hit something else.

The `^KEY=` row is the one to read if you are reworking the `.env` checks. It
failed **0 of 30** when those checks only asserted `exit 0`: `prod_port` falls
back to 4318, which on a developer's machine is the REAL prod daemon answering
401, so the probe exited 0 with a healthy verdict about somebody else's daemon —
against the exact bug the check was written for. They assert the reported port
now.

The `-f` row is worth its own note, because it changed hands during review.
While the probe read only the status code, `-f` was harmless — `-w
'%{http_code}'` still prints 401 and the flag only sets exit 22, which the
`|| true` swallows — so the static check on it was about idiom. Now that a 401
has to carry `"authRequired"`, `-f` discards the body on a 4xx and brings DRY-81
back in full. Run it with the flag on the curl's **second** line too: the static
check folds line continuations before matching, and did not before review.

Two notes for anyone reworking it. Its servers live in this process, so the
probe runs with `spawn` and not `spawnSync` — `spawnSync` blocks the event loop,
and under it every squatter accepted curl's connection into the kernel backlog
and answered nothing, so all four squatter checks passed while testing the
black-hole path a second time. And the free port for the "it reads the `.env`"
case is asked of the kernel rather than computed as `PORT + 1`: this host runs
several agents at once, each with a throwaway daemon in the 43xx range, and that
check first went green against somebody else's.

## The agent's pre-filled prompt (DRY-88)

A browser, a throwaway daemon, and a stub CLI on its PATH — about a minute.
Run it when touching `scheduleInitialInput` / `flushInitialInput` /
`paintsSomething` in `daemon/src/session.ts`, `spawnWorkspace` in `App.vue`, or
anything that decides when a spawned CLI is ready to be typed at.

The stub is the whole rig. `resolveSpawn` runs a bare `claude`, so a shim by
that name earlier on the daemon's PATH is how a test CLI gets in — and it has to
exist BEFORE the daemon starts, which is why it is a line here rather than
something the harness writes for itself:

```sh
bunx playwright install chromium             # once per machine; see "Running these"

mkdir -p /tmp/dry88-bin
printf '#!/bin/sh\nexec node --import %s/node_modules/tsx/dist/loader.mjs %s/scripts/verify/stub-cli.mts "$@"\n' \
  "$PWD" "$PWD" > /tmp/dry88-bin/claude && chmod +x /tmp/dry88-bin/claude

mkdir -p /tmp/dry88-repos/switchyard        # a NON-git dir, so the panel offers no worktree

(cd daemon && PATH="/tmp/dry88-bin:$PATH" \
   DRYDOCK_PORT=4388 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d88 \
   DRYDOCK_STATE_FILE=/tmp/dry88-state.json DRYDOCK_TRACKER=fixture \
   DRYDOCK_REPO_PATHS=switchyard=/tmp/dry88-repos/switchyard \
   node --import tsx src/index.ts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4388 bunx vite --port 5388 --strictPort &)

(cd daemon && node --import tsx ../scripts/verify/prefill.mts)
```

The absolute loader path in the shim is not decoration: the daemon spawns that
CLI with the SESSION's cwd, so a bare `--import tsx` resolves from a directory
with no `node_modules` and the "agent" dies with `ERR_MODULE_NOT_FOUND` — which
presents as a pane that draws nothing and a prompt that went nowhere, i.e. as
this ticket's bug.

What it holds down:

- **A prompt that was SENT is not a prompt that ARRIVED**, and only the CLI can
  tell the difference. The route answered 201 and the pane's `{type:"input"}`
  frame went out on the socket for the whole time this was broken. So every
  assertion is on bytes `stub-cli` echoed back, and the stub reports early input
  as `[dropped N chars typed before I was listening]` rather than leaving the
  harness to infer a loss from an absence.
- **`cat` would pass against the bug**, which is why the stub exists: it reads
  from its first instant, so a prompt typed at 700ms lands in it. The stub
  models the measured v2.1.238 startup — escape-only writes, a banner at 1200ms,
  input accepted at 1400ms — and drops what comes before that.
- **The stub goes raw at t=0** for the same class of reason. Left in canonical
  mode, the tty echoes what is typed at it, so a prompt that reached a CLI which
  was not listening still appeared in the pane's rows: `the prompt is in the
  composer` passed against the bug until this was fixed.
- **Once, not merely present.** The old design could type the seed again from a
  re-mounted pane, so the count is asserted.
- **The browser never types it.** The structural half — with the prompt on the
  daemon there is no copy for a poll, a re-mount or `forgetWindow` to lose. Note
  the check filters out escape-only payloads first: xterm answers the CLI's DA1
  and focus queries through the same frame type, so a bare "no input frames"
  test is never true and would pass against anything.
- **Pre-fill and submit are checked as a PAIR** (round 4, no browser). Checking
  only that a supervised spawn doesn't submit is passed by deleting the submit
  outright — at which point every autonomous run sits at a full composer nobody
  ever sends.

Discrimination (see [the section below](#making-sure-a-harness-still-discriminates),
which carries the recipe): against the pre-fix tree it fails **8 of 17**. Round
2's timing checks are not among them,
honestly: widening the gap between the two spawns — which is what provokes the
poll race it is testing — also pushes the old pane's 700ms write past the point
the CLI starts listening, so the old code passes them. `the browser still never
typed it` is that round's discriminating check, and it is there for that reason.

**The stub is a model, and models go stale.** When Claude Code is upgraded,
re-measure rather than trusting a green run: spawn a real one with `input` set
and read `paintedAfterMs` / `waitedMs` off the daemon's `typing initial prompt`
line against the table in `docs/decisions/dry-88-initial-prompt.md`. A stub whose numbers have drifted from the
CLI's is a harness asserting against last year's terminal.

## Is the daemon suspect? (DRY-48)

`/healthz` was `{ok:true, sessions:N}` from a handler that could not fail, so a
daemon that had taken an uncaught exception and stayed up looked exactly as
healthy as one that hadn't. It now reports a `status` over the faults this
process has taken, the session registry and its on-disk index, the log sink, the
tracker and the store; `/readyz` sits beside it as the thin signal.

```sh
(cd daemon && node --import tsx ../scripts/verify/health.mts)
```

No browser, no database, no second terminal: this file starts the six daemons it
needs, one posture at a time. It takes `:4348` (`PORT=` to move it, and it
refuses `:4317`/`:4318` outright) and `/tmp/dry48`. About ninety seconds.

**The fault it injects is a real one.** `fault-inject.mts` is preloaded into the
daemon under test (`--import tsx --import …/fault-inject.mts`) and throws from a
timer callback when the process gets SIGUSR2 — writing `exception` or `rejection`
into `$DRYDOCK_FAULT_FILE` picks which. Two things that rules out, both of them
deliberate: the product does not grow a "crash yourself" endpoint on the same
unauthenticated surface prod serves, and the throw does not happen inside an HTTP
handler, where `server.ts`'s catch-all would turn it into a 500 and no
`uncaughtException` would fire at all.

What it holds down:

- **`degraded` must never read as `down`.** A broken store, an unreachable
  tracker, an unwritable log file and a fault the process survived all leave
  `ok:true` and `/readyz` at 200. That is DRY-45's trade restated: the daemon is
  holding somebody's live agents, and restarting it for being suspect costs
  exactly the thing staying up was protecting. `ok:false` has one cause, and the
  file proves it by chmodding the sessions directory to 000 and then deleting it.
- **The legacy shape survives.** `ok`, `sessions` and `store` (with DRY-56's
  capabilities) are asserted where they always were — half a dozen files in this
  directory read them, and this ticket had every opportunity to move them.
- **The tracker is observed, not probed.** `unknown` before anything asks, `ok`
  after a call succeeds, and — the one worth having — still `ok` after a 404 for
  a key that doesn't exist. A health endpoint that called a mistyped ticket key
  an outage would accuse a perfectly reachable Jira and, with nothing else
  polling, go on accusing it.
- **The three postures of `DRYDOCK_EXIT_ON_UNCAUGHT`.** The default exits, and
  the section proves that costs a reattach and nothing else: a fresh daemon comes
  up and adopts the session the crash didn't kill (DRY-57). `0` stays up. `idle`
  is a PAIR — it must still be there a poll interval after the fault while a
  session runs, and gone within three once that session is killed. Either half
  alone passes against a policy that is simply wrong in one direction.
- **A probe must not repair.** The index check reads the configured path rather
  than calling `sessionsDir()`, which creates the directory. See the mutation
  table: that one is a latch, not a discriminator.

### Making sure this one still discriminates

Against `main` it fails **45 of 57**, and the twelve survivors are worth reading
rather than glossing. Four are the legacy-compatibility checks, which are
supposed to pass. Four are premises this ticket didn't change: `=0` stays up, the
default exits, and a store with no read permission already reported `ok:false`
(DRY-28). One is rig setup. The last three pass **vacuously** — including "and
exits once nothing is running", which `main` satisfies by having exited a minute
earlier, under a posture it read as `exit`. That one is exactly why `when-idle`
is checked as a pair.

| mutation | fails |
|---|---|
| `ok: status !== "down"` → `status === "ok"` | **3 of 57**, the degraded checks |
| `readiness()` refusing a degraded tracker | **1 of 57** |
| the uncaught handler not calling `faults.record` | **7 of 57** |
| `when-idle` ignoring whether anything is running | **4 of 57**, the first half of the pair |
| `when-idle` never arming | **3 of 57**, the second half |
| `TrackerWatch.failed` without its caller-fault arm | **1 of 57**, the 404 |
| `indexHealth` calling `sessionsDir()` | **0 of 57** — vacuous, and why is in [dry-48-health](../../docs/decisions/dry-48-health.md) |

**The rig's own trap, worth knowing before you edit this file.** Six postures
share one port, so a daemon that outlives its section answers for the next one —
and answers plausibly, being a real Drydock. The first run reported eighteen
failures that were all one leak. `startDaemon` refuses while anything is
listening, `stopDaemon` escalates to SIGKILL rather than giving up quietly, and
`process.on("exit")` kills the child however the file ends: a harness that
crashes halfway otherwise leaves a daemon holding the port and breaks the *next*
run instead of the one that made the mess.

## Workspace store: why a proxy and not `docker stop`

`docker stop` frees the port, so every connect fails instantly with
ECONNREFUSED and every latency bug hides. A real partition is host-up,
packets-dropped: the connect ACKs and nothing comes back. Three separate bugs
were only visible under the latter — see `docs/decisions/dry-28-workspace-state.md`.

`proxy-tcp.mts` also **freezes connections it has already established** rather
than only refusing new ones. The pool keeps clients idle for 30s, so a proxy
that blocks new connects alone never partitions anything at all.

## Setup

Every block below runs from the **repo root** and returns there — the `cd`s are
in subshells on purpose, so the whole section copy-pastes in sequence.

```sh
bunx playwright install chromium             # once per machine; see "Running these"

# Throwaway daemon — file store (the default tier, the one that gets forgotten)
(cd daemon && DRYDOCK_PORT=4370 DRYDOCK_HOST=127.0.0.1 \
   DRYDOCK_STATE_FILE=/tmp/dry58-state.json DRYDOCK_TRACKER=fixture \
   node --import tsx src/index.ts &)

# HTTP partition proxy in front of it, and the dev shell pointed at the PROXY.
# The two ports are PASSED, not implied: proxy-http defaults to :4398 → :4399,
# which is nothing this rig runs, while every harness here defaults to
# PROXY=:4371 and DAEMON=:4370. This block used to omit them and carry a
# `# :4371 → :4370` comment describing ports the proxy was not listening on, so
# it could not work as pasted — the harnesses reported a dead proxy.
(cd daemon && PROXY_PORT=4371 TARGET_PORT=4370 \
   node --import tsx ../scripts/verify/proxy-http.mts &)
(cd shell && VITE_DAEMON_URL=http://127.0.0.1:4371 bunx vite --port 5370 --strictPort &)
```

`proxy-tcp` and `proxy-tracker` need no such override — their defaults already
match the ports their rigs use.

For the Postgres tier, add a throwaway database behind the TCP proxy and a
second daemon in front of it:

```sh
docker run -d --name dry58-pg -e POSTGRES_PASSWORD=dry58 -e POSTGRES_DB=drydock \
  -p 127.0.0.1:5455:5432 postgres:16
(cd daemon && node --import tsx ../scripts/verify/proxy-tcp.mts &)   # :5456 → :5455, control :5457

(cd daemon && DRYDOCK_PORT=4372 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
   DRYDOCK_DATABASE_URL='postgres://postgres:dry58@127.0.0.1:5456/drydock' \
   node --import tsx src/index.ts &)
```

Then point `proxy-http.mts` at it (`TARGET_PORT=4372`) and pass
`DAEMON=http://127.0.0.1:4372` to the browser harnesses. **Run them against both
tiers** — the file store is what a fresh clone runs.

## The harnesses

| | asserts |
|---|---|
| `roam.mts` | Roaming resumes with no reload, for an outage starting before *and* after the first read. Includes the conflict rule as a pair: an untouched client adopts the daemon's desk live, a client that dragged keeps its own. |
| `hang.mts` | The accept-then-silence partition. A push that never settles must still raise the notice and leave recovery alive. |
| `surface.mts` | DRY-28's surface claims (wipe localStorage → reload → desk intact; a fresh profile gets the same desk) plus how the notice presents: once, no focus steal, self-clearing, and a hidden tab still recovers. |
| `timings.mts` | Postgres only. Timings, not status codes: one request per window pays the timeout, the rest return in ms, the window widens 10 → 20 → 30 and stops, `/healthz` answers instantly while cooling and resets after a heal. |
| `drift.sh` | Postgres only. An edited applied migration 503s naming the file while the live PTY keeps running; reverting clears it; a null checksum is adopted and backfilled. |
| `epic-children.mts` | DRY-83. An epic with nothing under it in the pull expands to its open children, without widening the pull, without fanning out under a filter, and without the rows blinking out when Refresh re-pulls them. |
| `health.mts` | DRY-48. `/healthz` has an opinion: a real uncaught exception is counted and reported as `degraded` without ever reading as `down`, a broken store or tracker or log sink never un-readies the daemon, and the three postures of `DRYDOCK_EXIT_ON_UNCAUGHT` do what they say — including `idle`, which must stay up while a session runs and exit once none does. |
| `desk-chrome.mts` | DRY-82. One spawn control on the header and a palette that carries what the two removed buttons did; a layout switcher centred on the window rather than on the slack its siblings leave; `key=value` filter pills that cost the tracker nothing and say when they name something this pull cannot contain; and a term the pull cannot contain found through `/api/tracker/search`, debounced. |

Each exits non-zero on failure and prints one line per check.

## Making sure a harness still discriminates

A green harness proves nothing if it would also be green against the bug. Check
it the way these were checked.

**`main` is no longer the pre-fix tree, and that silently defanged the three
recipes below** (found while re-running them for DRY-80). They were written
while their ticket was still a branch, so `main` really was the broken side;
every one of them has since merged, and `git checkout main -- <those files>` is
now a no-op that leaves the FIXED tree in place. The run that follows passes,
and reads as "still discriminates" when nothing was reverted at all — the exact
false green this section exists to prevent, one layer up.

So each recipe names the commit before **its own** merge. **They cannot share
one `PRE`**, which is the second half of the same trap: the merges are ordered
(DRY-58 → DRY-55 → DRY-83), so DRY-55's parent already contains DRY-58's fix and
reverting to it would leave `roam.mts` testing a tree that was never broken.
`git merge-base --is-ancestor 3f1e228 c760181` is what that looks like when you
check it rather than assume it.

**Confirm the revert landed before trusting the run.** `git diff --stat` against
the ref must be non-empty; a `checkout` that matched nothing is silent, and the
green that follows is just the harness passing.

```sh
# DRY-58 roaming — 3f1e228 is the merge, 4a6953b the commit before it
git checkout 3f1e228~1 -- shell/src/composables/layoutStore.ts \
  shell/src/composables/useWindowManager.ts shell/src/App.vue
(cd daemon && node --import tsx ../scripts/verify/roam.mts)        # expect 6 failures
git checkout HEAD -- shell/src/composables shell/src/App.vue

# DRY-55 the sidebar's outage copy — c760181 is the merge
git checkout c760181~1 -- shell/src/App.vue shell/src/components/TrackerSidebar.vue \
  shell/src/lib/tracker.ts
(cd daemon && node --import tsx ../scripts/verify/sidebar.mts)     # expect 19 failures, across (a), (c), (e), (f), (g)
git checkout HEAD -- shell/src/App.vue shell/src/components/TrackerSidebar.vue \
  shell/src/lib/tracker.ts

# DRY-83: revert only the SHELL half, so what's under test is the sidebar
# having no way to ask rather than the daemon having no way to answer.
# 8b79ceb is the merge.
git checkout 8b79ceb~1 -- shell/src/components/TrackerSidebar.vue shell/src/lib/tracker.ts
(cd daemon && node --import tsx ../scripts/verify/epic-children.mts)   # expect 10, incl. the row's own tooltip
git checkout HEAD -- shell/src/components/TrackerSidebar.vue shell/src/lib/tracker.ts

# DRY-88 the pre-filled prompt. Its merge has no number written down here on
# purpose — this ticket's own recipe would be the fourth to rot the way the
# three above did. Find it instead, from the file that arrived with it:
#   git log --diff-filter=A --format=%h -- scripts/verify/prefill.mts
git checkout <that commit>~1 -- daemon/src/session.ts shell/src/App.vue \
  shell/src/components/TerminalPane.vue shell/src/components/WorkspacePane.vue
(cd daemon && node --import tsx ../scripts/verify/prefill.mts)     # expect 8 failures of 17
git checkout HEAD -- daemon/src/session.ts shell/src/App.vue \
  shell/src/components/TerminalPane.vue shell/src/components/WorkspacePane.vue

# DRY-82 the desk chrome. Its merge is deliberately not written down either —
# find it from the file that arrived with it:
#   git log --diff-filter=A --format=%h -- scripts/verify/desk-chrome.mts
git checkout <that commit>~1 -- shell/src/App.vue shell/src/lib/tracker.ts \
  shell/src/components/QuickLaunch.vue shell/src/components/TrackerSidebar.vue
(cd daemon && node --import tsx ../scripts/verify/desk-chrome.mts)  # expect 44 failures of 72
git checkout HEAD -- shell/src/App.vue shell/src/lib/tracker.ts \
  shell/src/components/QuickLaunch.vue shell/src/components/TrackerSidebar.vue
```

The sidebar and epic-children counts are what DRY-80's re-run actually observed;
`roam`'s 6 is inherited and was not re-measured. Note the two halves of this
file disagreed about epic-children — 5 here, 10 in
[its own section](#expanding-an-epic-to-its-children-dry-83) — and 10 is the
right one. A count that drifts in the safe direction is how the next
re-validation gets read as a regression, which is the same warning the `perl`
recipes below carry.

`sweep.mts` has no pre-DRY-60 file to check out — there was no sweep to break —
so it was validated by breaking its load-bearing rules instead, a line each.
Worth re-checking after any change to `sweepFinished` or the rail's density:

```sh
# (1) the failure guard, and the "only while somebody is looking" gate
perl -0pi -e 's/return s\.status === "exited" && !s\.failure;/return s.status === "exited";/' \
  shell/src/composables/runState.ts
perl -0pi -e 's/if \(visible\) finishedSeenAt\[session\.id\] \?\?= at;/finishedSeenAt[session.id] ??= at;/' \
  shell/src/App.vue
(cd daemon && node --import tsx ../scripts/verify/sweep.mts)       # expect 4 failures, incl. the failed run being swept
git checkout HEAD -- shell/src/App.vue shell/src/composables/runState.ts

# (2) the countdown's row, and both of the sweep's own exemptions
perl -0pi -e 's/\.card\.compact\.clearing \.meta,\n\.card\.tile\.clearing \.meta \{[^}]*\}\n//' \
  shell/src/components/RunRail.vue
perl -0pi -e 's/if \(userFocusedId\.value === session\.id \|\| win\?\.minimized\) continue;/if (wm.focusedId.value === session.id) continue;/' \
  shell/src/App.vue
(cd daemon && node --import tsx ../scripts/verify/sweep.mts)       # expect 4: C's fit check, and 3 of D's
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
`TARGET_PORT` for `proxy-http.mts` and `proxy-tracker.mts` (`BREAK_PATH` too, if
some other route ever needs the same treatment); `PG_PROXY_PORT` / `PG_PORT` /
`CONTROL_PORT` for `proxy-tcp.mts`; `PG_URL` / `PG_CONTAINER` for `drift.sh`.

**`DAEMON` must point at whatever `proxy-http.mts` forwards to.** Getting that
wrong makes the harness assert against a different daemon than the browser is
driving, which looks exactly like a product failure and isn't one.
