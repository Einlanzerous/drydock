# The tracker pull is cached and coalesced (DRY-72)

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

