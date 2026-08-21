# Clearing finished sessions (DRY-60)

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

