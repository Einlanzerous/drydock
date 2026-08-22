# A tracker pull has a deadline, not just its requests (DRY-61)

Split out of DRY-55. That ticket gave the *shell* a budget, so the sidebar
reports an outage instead of latching its spinner; DRY-72 then gave every
tracker *request* a backstop. Neither bounds the thing a caller actually waits
for. One `listTickets` is many requests — a cursor chain for the list, a second
for the epic exemption, then the child-stats pass, which on Switchyard is one
chain per epic through `CHILD_STATS_POOL` and on Jira can be twenty more pages —
so against a tracker that ACCEPTS connections and then goes silent (the
partition shape, not a refusal) each request died at its own 20s deadline and the
provider started the next one. `/api/tracker/tickets` held its response open the
whole time.

Now `daemon/src/tracker/deadline.ts` carries one budget for the whole operation,
both providers wrap `listTickets` in it, and `DRYDOCK_TRACKER_LIST_TIMEOUT_MS`
(10s) sits deliberately *under* the shell's `LIST_TIMEOUT_MS` (raised 12s → 15s
in the same change).

Harness: `scripts/verify/tracker-deadline.mts` + `stub-tracker.mts`, rig in its
README. The traps:

1. **A per-request timeout is not an operation timeout, and it looks like one
   until you count the requests.** The knob DRY-72 added is real and still
   wanted; it just bounds the wrong noun. The case that proves the difference
   isn't a hang at all — it's a tracker that is merely SLOW, where every request
   succeeds well inside its own backstop and the pull still runs `requests ×
   latency` with nothing able to stop it. A hang and a slow tracker take the
   same path here; only the second one distinguishes the two deadlines.
2. **The daemon's budget must be SHORTER than the shell's, and it is a three-way
   ordering.** `listTimeoutMs (10s) < LIST_TIMEOUT_MS (15s) < TICKET_POLL_MS
   (20s)`. Inverted at the bottom end, the browser gives up first, the daemon's
   deadline is never observed by anyone, and the sidebar renders "signal timed
   out" — which names neither the tracker nor anything actionable — where the
   daemon was about to say *which* tracker stopped answering and after how long.
   Inverted at the top end you get DRY-55's original bug back (a budget equal to
   the poll interval means each hung pull aborts exactly as the next tick
   supersedes it, so the epoch guard discards the failure and nothing ever
   reports). Which is why 12s couldn't simply stay: it had only a ceiling before,
   and squeezing the daemon under it would have cut honest pulls — a corporate
   Jira measured 5.7-6s in DRY-72.
3. **Nesting must not restart the clock.** Both providers reach `listTickets`
   from `searchTickets`, and the Switchyard one calls itself once per project in
   scope (DRY-30) to fan a multi-project pull out. A nested wrap that minted a
   fresh budget would hand an N-project pull N times the budget it advertises
   while still printing the advertised number in the error. `withDeadline` is a
   passthrough when one is already running.
4. **The signal is ambient (`AsyncLocalStorage`), not a parameter, and that was
   a decision rather than a shortcut.** Threading it means five signatures per
   provider plus a standing rule that every future request remembers to carry
   the budget — a rule nothing enforces, whose failure is silent (that one
   request runs unbounded) and which is invisible in review because the call
   reads perfectly well. This repo's recurring finding is that the forgotten
   call site is always the one that matters. Ambient inverts it: `req()` is the
   single chokepoint both providers already funnel through, and it propagates
   across `await`, `Promise.all` and the child-stats pool for free. The cost is
   the honest one — a call made outside `withDeadline` is bounded only by its
   per-request backstop.
5. **Detect a blown deadline with `signal.aborted`, never the error's name.**
   By the time a rejection surfaces it may have been rewritten: a provider's
   `catch` around a swallowed decoration can rethrow something else entirely,
   and `fetch` rejects an aborted request with a DOMException whose name differs
   between "aborted" and "timed out". If the budget is gone the operation is
   over, whatever the error says it is. (CLAUDE.md's trap 2, one surface along:
   the *reason* is the verdict, never the label the runtime happened to use.)
6. **Wrap at the PROVIDER, not at the route.** The pull that accumulates is the
   one the cache runs behind a response — it has nobody waiting on it, which is
   precisely why nothing was ever going to end it. A route-level deadline bounds
   only the pulls somebody is already watching.
7. **`getTicket` is deliberately left out**, and the reason is that a brief is
   not a poll. The SessionStart path (DRY-53) already carries tighter budgets
   for its optional decorations that degrade a line rather than the brief, and
   the caller waiting on it is a `curl -s -m 25` with no retry. Sizing it
   against a 20s sidebar poll would cut briefs a slow tracker is still
   delivering, to fix an accumulation one spawn doesn't have.
8. **A blown deadline must cost the refresh, not the sidebar.** With a list in
   hand the cache keeps it and marks it `stale` (200, DRY-72 trap 4 / DRY-55's
   rule); only a COLD key 502s. A deadline that blanked a working sidebar would
   be a worse bug than the one being fixed — and it is easy to ship, because
   both paths run the same provider call and only the cache tells them apart.
   Related: a deadline that blows inside the child-stats pass is SWALLOWED by
   the existing decoration catch, so the pull returns a real list with no
   progress bars rather than failing. That is the right outcome, and it means
   "the deadline fired" and "the pull failed" are not the same event.
9. **The deadline is now the effective page cap on a slow Jira**, ahead of
   `MAX_TICKETS`, and that is a consequence rather than a bug (review). That
   backstop allows twenty sequential pages, which at 10s for the whole pull is
   unreachable on any instance slower than ~500ms a page — so what bounds a big
   pull is the clock, not the count. It is the better of the two bounds for a
   sidebar (a person is waiting, and a truncated list is still a list), but a
   host that genuinely needs twenty pages has to raise the knob rather than
   wonder why `MAX_TICKETS` never fires. Note what is NOT affected: the
   child-stats pass, which is where the twenty-page walk actually happens, comes
   after the list and is swallowed — so a deadline that blows there costs the
   progress bars, not the rows.
10. **The knob goes through `msOrOff`, not `num()`** — DRY-60's trap 9 again. 0
   means "no operation deadline", which is the pre-DRY-61 behaviour and a real
   posture to want back while chasing a tracker that is merely very slow.
11. **The existing hang case structurally could not have caught this**, and it
    passes against the bug. `tracker-cache.mts` (h) runs with the per-request
    deadline at 3s and a pull that is ONE request long, so the pull ends at 3s in
    both worlds. Two deadlines are only distinguishable when the rig separates
    them: this one runs 3s operation against an 8s request backstop, and every
    assertion is a TIMING or an upstream socket count. Never a status code — 502
    is the answer before and after on the cases that answer at all (CLAUDE.md
    trap 3).
12. **A new error class has to answer to `/healthz` too (DRY-48, merged while
    this was in flight).** `TrackerWatch.failed` reports the error's NAME and
    never its message — upstream text must not reach the one route that answers
    an anonymous caller on a daemon with auth on — so an error that leaves
    `name` alone makes the health endpoint say "the tracker call failed
    (Error)". `TrackerTimeoutError` therefore SETS `name`, which is the opposite
    of what its sibling `TrackerHttpError` does for a reason that is written
    down in both places: nothing reads that one's name, and its `String(err)`
    reaches a person. The two deadlines this daemon can blow also have different
    fixes — one knob each — so the health endpoint has to tell them apart. And
    the caller-fault exemption still works: a 404 on a keyed pull propagates
    unconverted, because the deadline only rewrites an error when the budget is
    actually gone.
13. **Be accurate about how much accumulation was left.** DRY-72's single-flight
    means N polls of the SAME query already share one upstream fan-out, so the
    per-tab pile-up the ticket describes is bounded per cache KEY, not per poll.
    What still accumulated is one hung pull per distinct key — a second browser
    with its own scope chips (DRY-30), an epic expansion, a search — plus the
    unbounded operation itself. The harness therefore mints a fresh scope per
    pull; written against one key it would have measured single-flight working
    and called it the fix.
