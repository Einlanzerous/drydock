# A spawn adds a window; it does not arrange the desk (DRY-93)

Three spawn paths called `wm.setLayout("float")` before doing anything else —
`spawnFresh` (the palette's pinned `claude` / `shell` rows), `spawnWorkspace`
(the ticket panel's *Spawn Agent*, and the palette's `workspace` row) and
`watchRun` (promoting a rail card to a window). Picking **Tile** or **Focus** in
the header and then spawning anything snapped the whole desk back to Float,
re-scattering every window that had been tiled. All three calls are gone; the
guard in `setLayout` stays, and is now the whole of the "not arranging" rule
there.

1. **The stated reason was "make sure the new window is visible", and that is
   the adder's job, not a mode's.** `computeRects` re-grids tile on the window
   count, so a new window tiles in for free; focus promotes whatever `add()`
   focused, and `add()` claims `focusedId` for every window it appends. Each of
   the three paths already calls `focusWindow` afterwards. Nothing needed
   telling — the call was doing a job that was already done, in the most
   destructive available way.
2. **The second-order half is why this was not cosmetic.** `setLayout` sets
   `arranged`, the flag DRY-28's conflict rule reads as *a human shaped this
   desk*; it decides whether a client keeps its own layout or adopts the
   daemon's after an outage (DRY-28 property 7). So a spawn from tile latched
   "arranged" in the one code path that had just thrown the arrangement away.
   Whatever the fix, it must not make a spawn set that flag — which is why the
   three calls were DELETED rather than made conditional. A conditional call
   still calls `setLayout`, and `setLayout` is what sets the flag.
3. **The guard is why nobody noticed for so long, and it is the trap in
   verifying this.** `setLayout` returns early when the mode is unchanged, so in
   Float — the default, and what everything comes up in — the call was a no-op.
   That makes a float-mode test worthless in both directions: the layout
   assertions pass against the bug, and so does any check on `arranged`. The
   first cut of the harness's flag section did exactly this and reported four
   green checks that could not fail.
4. **Getting a test desk into tile WITHOUT arranging it is the whole difficulty
   of that section.** Clicking the switcher sets the flag by definition, so the
   mode has to arrive some other way — and it does, from the persisted desk:
   `apply()` assigns `layout.value` directly and deliberately (*applying
   somebody else's desk is not this client arranging one*). `spawn-layout.mts`
   therefore reuses one browser context so the localStorage mirror survives
   between pages, seeds three different answers — mirror `tile`, daemon `focus`,
   and a click on `float` for the control — and reads the flag through the only
   thing it does: whose desk wins when the store heals.
5. **The control is not optional.** "The daemon's desk won after a spawn" is
   equally true of a build where `arranged` is never set at all, including one
   that deleted the flag. The paired check — a switcher click during the same
   outage, where THIS client must win — is what makes the first one mean
   anything.
6. **Assert the mode on the daemon, not only on the header.** The layout is
   persisted, so a desk that snapped to float wrote `"float"` to
   `/api/workspace`; reading it back is what catches a spawn that changes the
   mode and puts it back, which the header alone cannot see. And assert the new
   window's GEOMETRY, per mode: "the layout didn't change" is satisfied by a
   spawn that produced no window at all, and — in focus — by one filed in the
   210px thumbnail strip, which is a mode that didn't change and a window you
   cannot see.
7. **Three call sites, three UI gestures, and they must each be driven.** They
   are one function apart in the source and a whole feature apart on screen: the
   palette row, the ticket panel's button and the rail's *Watch* chooser. A fix
   covering only `spawnFresh` looks identical from the ticket panel.
8. **`userFocusedId` was checked and deliberately not touched** (DRY-60 trap 3).
   All three paths still call `focusWindow`, which sets it — correct, because a
   window you just asked for IS a window you are in, and the sweep's exemption
   is reading intent that genuinely exists. Only the layout call was removed.

Verified by [`scripts/verify/spawn-layout.mts`](../../scripts/verify/spawn-layout.mts)
— all three paths in all three modes, plus the flag and its control. Against the
pre-fix tree it fails 26 of 80; the rig and the discrimination recipe are in
[scripts/verify/README.md](../../scripts/verify/README.md#where-a-spawned-window-lands-dry-93).
