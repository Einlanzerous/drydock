# Desk chrome: one spawn button, a fixed centre, pills (DRY-82)

Three unrelated nits on the surrounding chrome, in `App.vue`,
`QuickLaunch.vue` and `TrackerSidebar.vue`. Only the third has design in it.

**One spawn control.** `+ claude` and `+ workspace` left the header, which is
the third pass at the same cleanup — DRY-36 folded the workspace button off the
ticket panel, DRY-39 removed the plain-shell button. They could not simply be
deleted: the palette had exactly one pinned row and its own comment said so
("blank claude agents live on the header's `+ claude`, not here"), so the
capability moved first. Three pinned rows now, and they are **filtered by the
query like the tickets are** — which is what replaces `⇧↵`, and what makes a
fourth cost nothing.

1. **The pinned-row count stopped being a constant, and that was the whole
   indexing bug waiting to happen.** `idx` opened at 1 to land on the first
   ticket, hard-coded to "one pinned row". Everything reads `pinned.length` now,
   including the opening index, because the query can leave two of them on
   screen or none.
2. **`⇧↵` is swallowed, not repurposed.** Three pinned rows want one rule and a
   chord for one of them is the worst of both, so there is no chord — but
   letting the old one fall through to the plain `Enter` branch turns a reflex
   for "give me a shell" into "spawn an agent on whatever ticket is selected".
   A stale gesture doing nothing is the only safe way to retire it.
3. **Assert on the request BODIES, not on a window.** A workspace is two POSTs
   — the agent and the co-located zsh sharing its resolved cwd — and a pinned
   row that issued only the first looks identical on screen for as long as
   anyone would watch. The harness intercepts `POST /api/sessions` for the same
   reason: otherwise it starts a real `claude` per check.
4. **`prefill.mts` clicked `+ workspace`.** Deleting a control means finding the
   harnesses that drive it; that one is DRY-88's, and it now goes through the
   palette.

**A centre that is a centre.** The Float/Tile/Focus switcher sat between two
`flex:1` spacers, which hand each side equal *slack* rather than equal *width* —
so its position was a function of how wide `.controls` happened to be, and a
control on the left moved when something on the right resized. Five things do
that: the folder chip follows focus, `Clear finished` appears and vanishes
entirely, its badge is one or two digits, and the account name / `Sign out` pair
arrives with auth. Now `grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)`.

1. **Pinning the repo chip would have fixed one of five** and truncated repo
   names for the trouble. The fix has to stop deriving the centre from sibling
   widths at all, or the next thing added to `.controls` puts the drift back.
2. **`minmax(0, 1fr)`, not a bare `1fr`.** A bare one refuses to shrink below
   its content, so at a laptop width the whole header overflows instead. The
   give is taken by the repo chip, which ellipsises, and by the tagline, which
   is dropped under 1180px; everything else in `.controls` is `flex: 0 0 auto`,
   because a squeezed "New session" is a worse answer to a narrow window than a
   truncated directory name.
3. **Grid rather than `left:50%; transform:translateX(-50%)`** — the switcher
   stays in flow, so it cannot end up painted over the controls. **That is the
   ticket's own reason for preferring grid, and the first cut shipped without
   it holding.** `justify-self: end` pins `.controls` to the end of a `1fr`
   track while `flex: 0 0 auto` stops its children shrinking, so a cluster too
   wide for its track grows LEFTWARDS across the middle one: 25px of overlap at
   1100 and 95px at 960, and `Sign out` spilling past the header's own padding.
4. **The cause is DISTRIBUTION, not content, and that decides the fix.** At 960
   the three clusters and their gaps want ~810px of a 960px header — it all
   fits. What doesn't fit is the controls into a track sized as though the brand
   needed the same room, which it never does. So below 1300px the header packs
   (`auto auto minmax(0,1fr)`) instead of centring. Note what packing KEEPS: the
   switcher then sits after the brand, whose width never changes, so its
   position still cannot be moved by anything on the right — it simply isn't
   centred, which is the honest trade at a width where centring would mean
   painting one control over another. Dropping controls to preserve the centre
   would have been paying for the wrong thing.
5. **The breakpoint is a constant derived from today's `.controls`, which is
   this ticket's own anti-pattern — kept because the alternatives are worse, and
   made to fail loudly instead.** Sizing track 3 `minmax(min-content, 1fr)`
   removes the constant and degrades at exactly the right width, but then track 1
   absorbs the difference and the switcher moves when `Clear finished` appears —
   the original bug confined to narrow windows rather than fixed. So the number
   stays and the HARNESS watches the slack it spends: the folder chip is the only
   child of `.controls` that can give, so a chip squeezed to its own floor means
   the centred layout has none left. Two cuts of this sat 2px and 1px above their
   cliff and looked perfect by every overlap test, because the chip absorbs until
   it can't and the clearance reads a healthy 16px right up to the edge.
6. **Measure the FULLEST `.controls`, or the check cannot fail.** Signed out
   with nothing to clear is the narrowest that cluster ever gets, and it is what
   a throwaway daemon with no password and intercepted spawns renders — so the
   harness measured the one posture in which an overlap is impossible, at the
   two widths where it doesn't happen anyway. The rig now SETS
   `DRYDOCK_AUTH_PASSWORD` (the only tracker-adjacent rig here that does) and
   injects a finished session into the poll, and the sweep runs 1360/1300/1240/
   1100/960. Assert the cluster is actually there first, or the whole sweep
   quietly measures the easy case again. `DRYDOCK_AUTH_USER` is the second half
   of that: the default `owner` is five characters against a 90px cap, so the
   rig sets a cap-length name and the harness asserts it reached it.

**The sidebar's filters are `key=value` pills.** Four selects (Project, Status,
Assignee, and Epic on a row of its own, because epic titles are sentences) were
five permanent controls in a 266px column before anything was typed — which is
what made "add another filter" expensive, and the ask on this surface is for
more of them. A pill costs a key name and nothing on screen.

1. **Scope did NOT become a pill, and that is the seam.** The four selects are
   VIEW filters — instant, local, over what is already loaded. The project chips
   and the backlog switch are PULL SCOPE: a tracker round trip measured at
   5.7-6s against a corporate Jira, a new cache key, and a fresh child-stats
   fan-out (DRY-72). Two controls that look identical and cost 6000x differently
   is how an app comes to read as randomly slow. Chips stayed exactly where they
   were, wearing a `pull` label now that the shape of the control no longer
   carries the distinction on its own.
2. **A filter can only match what was pulled, so a free-hand pill can name
   something that does not exist here.** `assignee=Ashley Dodson` is a perfectly
   valid pill matching nothing, because her tickets are in a project the daemon
   isn't pulling or in the backlog bucket — and an empty sidebar looks exactly
   like a healthy tracker with nothing in scope, which is the silence DRY-55
   exists to break. Completions come from the loaded set so the ordinary path
   can't produce one; free text is still accepted and wears an amber state, and
   the empty list names the pill. **Refusing the pill would be its own lie**
   about what the tracker holds.
3. **`isKnown` is derived, never stored on the pill.** Widening the pull is
   exactly what turns an unknown pill into a known one — a flag written when the
   pill was made would still be accusing it an hour later.
4. **Two pills of one key are an OR, different keys an AND.** The selects held
   one value each and could not express it, and it is what makes a bad guess
   survivable: a wrong `assignee=` beside a right one narrows rather than
   emptying the sidebar.
5. **`term` is empty while a `key=` draft is in progress.** One box does both
   jobs, so without this every keystroke of "assignee=Ash" is also applied as a
   literal search for that string — which empties the sidebar on the way, and
   force-opens every epic on the desk (DRY-83's fan-out state) while doing it.
6. **The completion list opens with NOTHING highlighted.** Auto-highlighting the
   first row makes `↵` mean "take the suggestion" from the first keystroke, so
   typing "as" to search for a ticket and pressing ↵ silently becomes
   `assignee=`.

**And a term the pull cannot contain now reaches the daemon.** The sidebar's
search was a filter over `props.tickets`, so a key for a closed ticket, or one
in a project outside the scope, returned "No tickets match." —
`searchTickets()` has wrapped `/api/tracker/search` since it was built for the
palette and **nothing in the shell called it**. It spans every status inside the
project scope, and it answers the question the filters cannot: no tickets, or no
tickets *here*?

7. **Beside the local filter, not instead of it.** Replacing the filter trades
   an instant local answer for a debounced round trip on the common case. This
   only ever ADDS rows the pull doesn't have, in a block of its own — merging
   them into the repo groups (which is right for DRY-83's epic children, because
   those are in-scope work) would present out-of-scope, mostly-closed tickets as
   part of this pull.
8. **DRY-72's rule is honoured, its letter deliberately isn't.** "Go through the
   single entry point the poll and Refresh use" is there because overlapping
   pulls are how an epoch guard turns into a silence. `runTicketPull` serialises
   the LIST pull, whose fan-out is those 5.7-6s; queueing a one-shot lookup
   behind it would make the fast path wait on the slow one for nothing, since
   they are different routes with different cache keys. So: one search at a
   time, newest wins, every outcome epoch-guarded — and debounced, or this is a
   tracker query per keystroke, which is the pathology that ticket removed.
9. **The rows are DROPPED when the term changes, unlike everything else here.**
   Keeping the last list is right when a re-pull may fail (`loadChildren`); here
   the previous rows are the answer to a different question, and leaving them
   under a term they don't match is a wrong answer rather than a stale one.
10. **A miss is a real answer and has to read as one.** The route is
   project-scoped, so a key from a project the host doesn't pull legitimately
   isn't there — it says which projects it searched rather than showing an empty
   list.
10a. **`/api/tracker/search` is the one tracker route with no DRY-72 cache, and
   this is its first caller.** It goes straight at the provider: no
   `ticketCache`, no single-flight, no `stale`. Deliberate rather than
   overlooked, and it is worth checking against that ticket's rules before
   assuming it's a hole. What DRY-72 removed was an unbounded fan-out on a
   fixed 20s timer per browser tab; this is one page (`limit: 50` in both
   providers), no child-stats pass (both gate that on `q.open`), fired only by a
   settled keystroke, debounced at 400ms, one at a time per tab. And leaving it
   uncached keeps the 502-on-outage path honest — a cached one would need
   `stale` plumbed through it to avoid DRY-72's trap 2. What it is NOT is
   deduped across tabs or across the same term typed twice, so if this ever
   becomes a poll rather than a gesture, it needs the cache first.
11. **The stub tracker ignored `text`.** It now honours it and counts search
   queries in their own bucket. A stub that hands back every ticket passes the
   "found it" assertion for the wrong reason and can never fail the
   "legitimately not here" one.

The last three are review's, and all three are in the new request path — which
is the argument for reading a deviation closely rather than for refusing it:

12. **`searchTickets` was the only tracker call in the shell with no deadline,
   and here that is worse than a latched spinner.** Searches queue behind one
   handle, so a fetch that never settles never clears it and **no search runs
   again for the life of the page** — the list recovers on its own budget, this
   could not. `AbortSignal.timeout(LIST_TIMEOUT_MS)`, like its two neighbours.
13. **Replace the whole result state per outcome; never patch fields onto it.**
   Setting `rows` and `done` on success while leaving `error` standing renders
   "couldn't search — retry" forever over rows that were fetched perfectly well,
   and the retry control can then never visibly succeed. `loadChildren` gets
   this right by replacing `childLoads[key]`; `found` is a `ref` holding an
   object for the same reason, so patching isn't available. The retry also has
   to raise `loading` itself — it is the one caller that doesn't come through
   `watch(term)`, so without it the click changes nothing on screen.
14. **The highlight after a keystroke must read whether a PINNED row matched,
   not only whether a ticket did.** Asking only about tickets sends the
   selection to the first ticket the moment a query matches both — which is most
   queries against a real tracker, where "wo" is in 18 of this project's 91
   titles — so the pinned row sits above it greyed and `↵` opens a ticket panel.
   That is the gesture `⇧↵` was removed in favour of, and README, CLAUDE.md and
   the component comment all asserted it worked. A query that NARROWED the
   pinned set is aimed at one of them; anything else keeps "Ctrl+K, ↵ on a
   ticket".
15. **A pinned row's `terms` may only NAME the thing — and its KEY is a known
exception, kept on purpose.** The rule above treats a
   narrowed pinned set as a query aimed at a pinned row, so a generic word there
   doesn't merely add a row — it takes the `↵` away from the tickets. `agent`
   was on two of the three, in a repo where every ticket is about agents, so
   `Ctrl K`, `agent`, `↵` spawned a bare claude instead of opening the ticket
   somebody was looking for. `zsh` and `bash` stay (they are what a shell is
   CALLED, and nothing else here is one); `agent`, `drawer`, `split` and
   `terminal` are gone, and the harness asserts none of them claims a row so
   re-adding one fails rather than being noticed.
   - **The KEYS break that rule and are kept anyway, which is a decision rather
     than an oversight.** Measured against the live DRY project, `workspace` is
     in 7 open titles, `shell` in 6, `claude` in 6 — so `Ctrl K`, `workspace`,
     `↵` does spawn a workspace while seven tickets sit under it. The key IS the
     row's name and "type `wo`, `↵` reaches the workspace row" is the advertised
     feature, so there is nothing to remove; what makes it survivable is that the
     pinned row is the HIGHLIGHTED one, wearing its `↵ spawn` badge, with the
     matching tickets visible beneath — the state is legible before the keypress
     rather than after it. That is not true of a `terms` collision, which is why
     one is a latch in the harness and the other is this paragraph.
16. **"The tracker has nothing for X" is a different claim from "`elsewhere` is
   empty".** `elsewhere` is deliberately what the pull does NOT already hold, so
   a match the pull DOES hold drops out of it — and a known pill emptying the
   list then had the sidebar deny a loaded, open ticket exists. Gate that
   sentence on the search's own `rows`.
17. **"Is a pill being typed" is a question about the KEY, not about `=`.**
   Gating `term` on the character disabled the box for any term containing one
   — a title with `=` in it, a mistyped `proj=` — and disabled it invisibly: no
   local filter, no lookup, `filtering` false so no ✕, and `parsePill` returning
   null so ↵ commits nothing either. The full unfiltered list renders as though
   the box were empty.

Harness: `scripts/verify/desk-chrome.mts`, rig in its README — the stub
tracker's rig, a browser, about ninety seconds. Confirm it discriminates:
against the unpatched shell it fails **44 of 72**. Run `epic-children.mts`,
`sidebar.mts` and `backlog-toggle.mts` beside it — they drive
`.sidebar .searchbox input` and the scope row this ticket rebuilt around them.

**Two review rounds found four bugs by READING, in code that was green at the
time — and each was invisible to the harness for a reason worth keeping.** The
search path had never been run failing (hence section (f)). And the palette's
selection rule could not collide in this fixture: none of the five stub titles
contains `shell`, `claude`, `workspace` or `wo`, so the obvious query proved
nothing, and the one check that typed a pinned row's name then CLICKED it —
the one gesture not under discussion. `de` is the only string here inside both
a pinned row's terms and a loaded ticket's title, which is why an odd-looking
two-letter query is the one that check uses.

**Twenty-eight of the 72 checks pass against `main` too, and they are two kinds —
don't read the second as slack.** Some guard things that must not change (the
scope chips, the backlog switch, bare text still filtering). The rest guard a
review finding in a feature `main` does not have at all, so they structurally
cannot discriminate against the pre-ticket tree and were each confirmed against
their own bug by reinstating it. That is the only honest way to check a fix to a
fix, and it is why the count of failures is not the whole story.

**Section (f) exists because review found two of those bugs by reading, in a
path 35 green checks had never once run.** A search that is only ever tested
when it succeeds is a search whose recovery has never been executed. Two things
about that round are worth keeping, because the first cut of each passed against
the bug it was written for:

- **Do not heal the stub before probing the wedge.** Healing releases the held
  response, which lets the hung promise settle and unlatches the handle for
  free. Break to `502` instead: the old request stays held, a new one fails
  fast, so "the note changed" can only mean a request went out.
- **Every daemon-side tracker deadline has to outlast the whole round.**
  Shorter than the shell's budget (the defaults are) and a silent stub arrives
  as a prompt 502, so the shell's own deadline is never exercised. Longer but
  still inside the round — 30s, measured — and the daemon gives up partway
  through and unwedges the shell for you. There are now TWO of them:
  `DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS` (DRY-72) and, since DRY-61,
  `DRYDOCK_TRACKER_LIST_TIMEOUT_MS`, which bounds the whole pull and defaults to
  10s — inside this round, so a rig that sets only the first one silently goes
  back to passing against the bug.

