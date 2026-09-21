# Status messages are toasts (DRY-100)

Four surfaces used to render as full-width rows in `App.vue`'s flex column,
between the header and `.body`: the poll's `error`, `actionError` (DRY-51),
`actionNote` (DRY-90) and every notice from `composables/notices.ts` (DRY-58).
Every one that appeared or cleared changed the height of `.body`, so the sidebar
and every window jumped under the cursor — and in tile and focus layouts the
desk's height feeds the window rects, so every terminal was resized and
`TerminalPane`'s `ResizeObserver` refitted it. DRY-58 had already capped
`.notice` to one nowrap line for exactly this; that shrank the bounce, it never
removed it.

They are an overlay now — `components/ToastStack.vue`, absolutely positioned in
`.body`, so raising or clearing one moves nothing. `composables/toasts.ts` owns
what each one *means*.

1. **The stack is a VIEW of the four owners, not a store they push into.** The
   refs and `noticeList` stay where they were, and `useToastStack` derives the
   list from them. That is what makes "the toast leaves when its owner does"
   structural: a copy would be a second answer free to disagree with the first,
   and the disagreement is a toast that outlives the condition it reports. No
   call site that sets `actionError.value = …` changed.
2. **Two lifecycles, and the difference is who is able to end it.** A CONDITION
   (the poll error, every notice) has an owner that clears it, and the toast
   leaves with it. An EVENT (`actionError`, `actionNote`) has no owner — nothing
   resolves a kill that didn't take — so it waits for ✕, and the poll's next
   success must not wipe it (DRY-51 again; asserted). The two ✕ do different
   things: an event's clears the **owner's** ref, because remembering a hide
   instead would swallow the next event raised under the same key.
3. **Notices are dismissible now, and that reverses DRY-58 on purpose.** DRY-58
   argued a ✕ would hide a fact that is still true. The counter is that a toast
   only its owner may remove is one you cannot get out of the way of the window
   under it, and it is now over the desk rather than above it. The risk DRY-58
   named is real, so the dismissal is **remembered until the owner clears**, not
   until the next `setNotice`: `setNotice` is idempotent and retry loops re-call
   it, so forgetting on the re-call resurrects the toast a moment after it was
   closed. Once the owner clears, the next occurrence is a new toast and shows.
   The poll's `error` follows the same rule — it is the same shape. The memory
   is keyed by toast key only, so a condition whose *text* changes while
   dismissed (a different error string, same outage) stays dismissed; that is
   intended, and it is the trade this decision makes.
4. **The prune runs `flush: "sync"`, defensively.** It has to happen between an
   owner's clear and its re-raise. Nothing in the shell does both in one task
   today — the tracker's clear and re-raise are separate pulls — so this was not
   observed going wrong. But a queued flush would see the key present on both
   sides and keep the hide, and the failure would be a genuinely new outage
   suppressed by an old ✕, which nothing would ever report.
5. **Arrival order, not a slot per owner.** The stack is anchored at the top and
   appended at the bottom, so a new toast never moves one already on screen (item
   2 of the ticket). A fixed slot per owner (error, then action, then notices)
   is simpler and wrong: a poll error raised after a notice would sort above it
   and push it down — the bounce in miniature. What is NOT guaranteed is the
   reverse: when a toast above one leaves, the ones below snap up. The risk is a
   ✕ landing under a pointer that was aimed at the one above. Accepted, not
   solved — a slide would change how the shift looks, not where the ✕ ends up,
   and it would need a `<TransitionGroup>`, which item 14 is about.
6. **Placement is top-right of `.body`, and it covers something.** Bottom-right
   was the obvious anchor and is the wrong one: the rail owns the bottom edge
   (98px, DRY-49), a pending gate lifts above it, and the bottom rows of a
   terminal are where its prompt is. Top-right covers the top-right window's
   minimize/close instead — in focus layout that is the only window. Every toast
   is dismissible, so it is never permanent, and the stack is click-through
   (`pointer-events: none`, each toast opts back in) so it takes clicks only
   where a toast actually is. Top-*centre* would cover the status tag ("Your
   turn"), which is worse. If this turns out to bite, the fix is to inset the
   stack past the window controls, not to move it to the bottom.
7. **Never steal focus, and that includes the ✕.** Raising a toast leaves
   `document.activeElement` alone (DRY-58). A mouse click on ✕ would move focus
   onto the button, which is removed a moment later and drops focus to `<body>` —
   taking the terminal's keyboard with it — so the button is `@mousedown.prevent`.
   Keyboard activation is unaffected. The toast BODY is deliberately not
   prevented, so an error message can still be selected and copied.
8. **The glyph is drawn by CSS, not written into the DOM.** A toast's
   `textContent` is its message and nothing else: a screen reader hears
   "Dismiss", and no assertion on a toast's wording has to strip a trailing ✕.
9. **Roles carry the two meanings:** `alert` (assertive) on errors, `status`
   (polite) on notes and notices. The harness asserts the attributes, not what a
   screen reader does with them. Each toast is its own live region and is
   inserted dynamically; `alert` is generally announced on insertion while a
   `status` region is more dependable when it exists before its content
   changes, so a polite toast may be announced less reliably than an alert one.
   Nobody has listened to it.
10. **`DETAIL_MAX` stays at 140.** A toast can wrap — it no longer pushes
    anything — but a paragraph over the desk is still an alarm, so the cap in
    `notices.ts` stands for that reason alone. A long *action* error (`String(e)`
    of a daemon 500) is not capped; the toast body scrolls at 7.5em instead of
    growing down over the desk.
11. **Not a toast library.** Switchyard uses `vue-sonner`, and the ticket pointed
    at it. Its model — from its documented defaults, not from reading its source
    for this ticket — is a TIMER per toast and a stack where the newest displaces
    the older. Neither fits: nothing here expires on a clock (a failed action you
    didn't read is still the case when you come back), lifetime belongs to the
    owner, and an arrival that shifts what is already on screen is the bug. It
    would also have been a sixth runtime dependency for ~100 lines. Switchyard's
    `<Toaster position="bottom-right" rich-colors>` was the reference; the
    colour-by-kind idea carried over, and the position deliberately did not
    (item 6).

## What the verification taught

12. **`gate-actions.mts` was USING the banner as a lever.** Its last scenario
    raised a tracker-outage notice on purpose, to make the desk shorter than the
    window (a notice pushed the desk down) — the only case that separates "the
    gate panel's height cap reads the desk" from "reads `100vh`" (DRY-78). With
    toasts nothing the app does shortens the desk, so that check did not merely
    lose its selector, it lost its *premise*. The property still needs guarding,
    so the lever is now explicit — the harness grows `.topbar` by injected style —
    and says so. A selector migration that only swapped strings would have left a
    check that could never arm. **Read what a harness does with the thing you
    are moving, not just what it selects.**
13. **Float layout only MOVES a terminal; tile RESIZES it.** The first version
    of the geometry harness ran in float, where a window's rect is its own, and
    it failed against the in-flow version by showing a 35px *shift* — never a size
    change — while the ticket's complaint is the refit. Sizes only change in tile
    and focus, where the rects derive from the desk's height, so the harness has
    a tile section, and that is where the in-flow version's terminals go from
    750px to 735 / 701 / 715.
14. **A leave fade makes the DOM lie about the owner.** The first cut faded
    toasts out over 160ms with a `<TransitionGroup>`, and a cleared toast then
    outlived its owner by ~190ms. It bit three times: two of my own assertions
    (`count() === 0` straight after a ✕), and then `roam.mts` — an existing
    harness, migrated by a selector swap alone — whose sections B and C assert
    "notice cleared" the moment the store recovers and failed on every run. The
    old `.notice` was a `v-if` row and vanished synchronously; every harness that
    asserts a zero count was written against that. Making each of them wait, or
    hiding `.toast-leave-active` in the shared selector, would have taught the
    harnesses about an animation. Deleting just the leave CSS would not have been
    enough, judging from Vue's source (not tried): the leave hook waits a double
    `requestAnimationFrame` before it reads any styles, so a group holds a
    leaving node for at least two frames with or without a leave transition. The stack is a plain `v-for` now, the
    enter fade is a CSS keyframe, and removal is synchronous — what is in the DOM
    is exactly what the owners hold. **A zero-count assertion is only as good as
    the promise that removal is prompt; do not spend it on polish.**
15. **`.first()` on a stack is a guess about which toast.** After a fault is
    healed, its toast is still up until the next poll, so "dismiss the first
    error" dismissed the poll's (a condition, hidden) and left the action's. Wait
    for the one you don't mean to leave, then click.
16. **`.error`, `.note` and `.notice` are names other components use.**
    `GatePanel` has `p.error`, `SessionTombstone` has `p.note`, so a bare
    `.error` selector has always matched more than the header's banner did.
    The harnesses select `[data-toast]` now, from one module
    (`scripts/verify/toast-dom.mts`). Several assert a **zero** count ("the
    notice cleared itself", "no red banner"), and a selector that matches nothing
    passes all of those for the wrong reason — which is what `toast-stack.mts`
    exists to rule out: it proves each constant sees a real toast of its kind.

`scripts/verify/toast-stack.mts` is the harness; the rig, the mutation that
makes it fail, and the count are in
[scripts/verify/README.md](../../scripts/verify/README.md#status-toasts-dry-100).
