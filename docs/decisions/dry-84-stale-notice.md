# The stale notice measures watched time (DRY-84)

The notice above the desk — "Tickets aren't refreshing from Jira — no successful
refresh in 74s, the list on screen is 74s old" — appeared frequently against a
corporate Jira with no outage behind it, and never against Switchyard. It was a
condition raised by nothing: the tracker had not failed, and for most of those
74 seconds it had not been ASKED.

Two mechanisms, each correct on its own, combined into it. DRY-72's trap 9 stops
a hidden tab polling, deliberately — the tab that isn't in front of anybody must
not be a refresh against a corporate Jira every 20s until morning. DRY-72's trap
3a reports staleness by AGE as well as by failure, also deliberately — the cache
answers instantly from last-good, so a tracker that is slow rather than broken
trips nobody's budget and an arbitrarily old list would otherwise present as
live. Put together, the first manufactures exactly the aging the second reads as
trouble: the entry rots because the only thing that could refresh it stopped
asking, and the first pull on coming back reports an outage that never happened.
The notice then cleared on the next poll, which is why it read as "pops up
frequently" rather than "is stuck on".

**The age clock now only runs while somebody is asking.** `Entry.watchedSince`
(`daemon/src/tracker/cache.ts`) is reset by a successful refresh, and also by any
read that arrives more than `watchedGapMs` after the previous one — a hole in the
read stream means nobody was there, and time nobody asked about is not time the
list was allowed to rot. Trap 3a is untouched by this: a client that IS polling
holds the clock running, so a slow tracker still reports, `staleAfterMs` after
somebody starts watching again.

1. **This started as instrumentation and the instrument is the deliverable.**
   Two causes were possible — a tab that had stopped polling, or refreshes
   genuinely failing or timing out — they present identically in the browser,
   and the fixes have nothing in common (a clock, versus the deadline and the
   fan-out). The daemon knew which and did not say: `stale.error` was a sentence
   built at read time, so "no successful refresh in 74s" was printed both for a
   refresh that had really been running 74s and for an entry nobody had touched.
   `stale.reason` (`failed` | `stalled`) now separates the two that remain, the
   stalled wording quotes the REFRESH rather than the list ("a refresh has been
   running 74s without landing"), and `onDiagnose` logs the numbers behind both
   once per onset — plus an `unwatched` line for the case that no longer raises
   anything, which is the only trace cause (a) leaves. If the notice reappears
   in prod, `journalctl --user -u drydock-daemon | grep "tracker list"` says
   which cause it is, with `runningSec` and `lastRefreshSec` next to it:
   ```
   WARN [drydock] tracker list is no longer current event=stalled ageSec=5 \
     watchedSec=5 runningSec=1 lastRefreshSec=0 refreshes=9 failures=0 query="…"
   INFO [drydock] tracker list aged with nobody polling it event=unwatched \
     ageSec=9 watchedSec=0 unwatchedSec=9 refreshes=7 failures=0 query="…"
   ```
   All three are once per onset, and `unwatched` needs its own latch
   (`noticedUnwatched`) rather than riding `reported`, because it isn't a state
   the entry is in — it's an observation about one read. Where the watch gap is
   tuned under the client's cadence (a harness, or a host that has set the knob
   there) EVERY read is a hole, so without the latch the line meant to be the
   rare trace of a tab that stopped polling prints once per poll.
2. **The gap threshold cannot come from the TTL, cannot be the window, and
   cannot be half the window either — a floor is what makes the property
   true.** It has to sit above the client's poll interval (or an ordinary tab
   looks like a hole every single poll, and age-staleness quietly stops working)
   and below the staleness window (or a tab hidden for 45s comes back, has its
   gap counted as attention, and trips the notice — the bug, at a shorter
   duration). Deriving it from `ttlMs` fails the first test the moment a rig
   turns the TTL down. Half the window looks right and is the same bug one step
   further out: it clears the shell's 20s poll at the shipping numbers only
   because 60s / 2 = 30s, so `DRYDOCK_TRACKER_STALE_AFTER_MS=30000` — "tell me
   sooner", the obvious reason to touch that knob — derives 15s, every poll of a
   live tab reads as a hole, and the age test can never fire again. Asking for
   the notice EARLIER would have switched it off, with only `0` documented as
   the off switch. Hence `WATCH_GAP_FLOOR_MS` (30s) under the derivation, an
   explicit `DRYDOCK_TRACKER_WATCH_GAP_MS` for the harnesses that legitimately
   need to go below it, and section (m) of the in-process suite asserting the
   arithmetic — the property is thirty seconds of polling to observe
   behaviourally and one `Math.max` to check. **Caught in review, not by me:
   the trap list said the requirement and the code didn't hold it.**
3. **A read-stream hole RESTARTS the clock; it does not subtract from it.**
   Accumulating watched time and discounting the holes is the more precise
   model and the wrong one: a tab hidden for ten minutes would come back with
   whatever it had banked before it went, which is enough to trip the notice on
   the wake if it had been aging beforehand. Restarting is conservative in the
   direction the constraint points — a notice that flickers is worse than none.
4. **The failure path is deliberately not gated on any of this.** A refresh that
   threw before the tab was hidden is still reported on the wake, ten minutes
   stale, while a fresh refresh is already in flight behind it. It reads like
   the same flicker and isn't: the last thing the daemon actually knows is that
   the tracker failed, and suppressing that to wait out one refresh is DRY-55's
   worse bug (a list presented as current when nobody has any reason to believe
   it is). It clears when the refresh lands.
5. **`DRYDOCK_TRACKER_STALE_AFTER_MS=0` means off, and `msOrOff` is what makes
   that true.** Zero is a posture — a tracker known to be slow, where the only
   thing worth a notice is a refresh that actually threw — so it must not land
   on the derived default (DRY-60's trap 9, the fourth time). Inside the cache
   the same distinction is `?? ` on undefined rather than `||` on 0: undefined
   derives, 0 disables. Section (m) of the in-process suite holds down the half
   that matters, that switching the age test off doesn't take DRY-55 with it.
6. **The two halves of the claim have to be tested together or neither means
   anything.** The same nine seconds of a list not refreshing must be silence
   with nobody asking and a notice with somebody asking; a cache that never
   reports passes the first, and the shipped bug passed the second. They are
   sections (g) and (l) of `tracker-cache-unit.mts` and the two halves of
   section (j) of `tracker-cache.mts`, and the READMEs say to read each pair as
   one test.
7. **The surface section is not redundant with the HTTP one.** The daemon no
   longer SAYS stale; the desk not RAISING anything is a separate claim, because
   the notice is a condition (DRY-51/58) — raised by one pull and cleared by
   another, never rendered from the last response. A daemon-side fix with the
   shell reporting from somewhere else passes (j) and fails (l).
8. **Don't hide the tab by backgrounding a headless one.** Chromium throttles a
   background tab's timers to about once a minute, so the real thing measures
   the browser's throttler rather than the poll (DRY-60 trap 1). Section (l)
   shadows `document.visibilityState` with a data property — not a getter, which
   would put a function inside a `page.evaluate` body and into tsx's `__name`
   trap (DRY-80) — and fires `visibilitychange`. It then asserts the premise
   rather than assuming it: zero upstream requests while hidden, which is also
   what keeps DRY-72's trap 9 from being "fixed" by making a hidden tab poll
   again.
9. **DRY-61 landed while this was open, and it narrows `stalled` rather than
   colliding with it.** That ticket bounds a whole pull at 10s, so the
   slow-tracker shape trap 3a was written for now ends as a FAILED refresh long
   before a 60s window can close — `reason` says `failed` and quotes the
   deadline. `stalled` is what remains: a refresh still running when the window
   shuts, which needs `DRYDOCK_TRACKER_LIST_TIMEOUT_MS` off (a posture
   `.env.example` documents) or set above the window, and it is what the rig
   runs. None of it reaches the case this ticket is about — a notice raised with
   nothing failing and nothing even asked is not something a deadline can bound.
   `tracker-deadline.mts` passes unchanged against this.
10. **The sidebar's stale marker had to stop saying "Last pull failed".** With a
   `stalled` reason, nothing failed, and the tooltip contradicted the sentence
   printed right after its own dash. `sidebar.mts` asserts the marker "explains
   itself" by matching `out of date`, which is the half of the wording that was
   always true.
