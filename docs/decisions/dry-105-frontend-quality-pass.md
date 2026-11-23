# Frontend quality pass: Firefox floor, motion, dialogs, IME (DRY-105)

Firefox is the primary browser; the floor is **Firefox 160** (set 2026-11-22, raised by
the quarterly `frontend-audit`). It lives in `build.target` in `shell/vite.config.ts` and
in CLAUDE.md, "Browser target". Anything newer is progressive enhancement.

## Reduced motion is `animation: none`, not a short duration

One global `@media (prefers-reduced-motion: reduce)` in `style.css`. The obvious version
(`animation-duration: 0.01ms; animation-iteration-count: 1`) freezes an infinite pulse on
its FIRST keyframe, and `ddpulse` starts at 45% opacity, so a "needs you" marker would sit
dimmed. With `none` the element keeps its ordinary style. JS-driven motion is outside the
CSS gate: `scrollIntoView({ behavior: "smooth" })` in TicketDetail asks `matchMedia` itself.

## Which overlays are `<dialog>`

- **Palette (QuickLaunch) and accounts panel (UsersPanel): native modal `<dialog>` +
  `showModal()`.** The parent keeps `open` as the single source of truth and the dialog is
  driven from it, so App.vue's Ctrl+K toggle and `closePalette` focus hand-back are
  unchanged. `cancel` (Esc on the dialog) is prevented and routed to `close`, so the browser
  never closes it behind the parent's back. App.vue's capture-phase Escape handler bails
  while either is open. `closedby` is not used (Firefox support unverified).
- **After `close()` the palette blurs a non-text focus.** The browser restores focus to
  whatever opened the dialog; if that was a button, the next Enter is a second click, which
  is DRY-40's duplicate spawn. App.vue's restore is text-entry-only for the same reason.
- **TicketDetail stays non-modal.** It floats, drags and leaves the desk live (DRY-20);
  `showModal`/`aria-modal` would lock the terminals out and be untrue. It has `role="dialog"`,
  an `aria-label`, focus moved in on open, and focus handed back to text entry on close.
  After Send the old terminal briefly holds the keyboard until the spawned pane mounts and
  claims it (DRY-40).

## IME

`isPlainEnter` (`lib/keys.ts`): `key === "Enter" && !isComposing && keyCode !== 229`. Used by
the palette, both deny-reason fields, the sidebar project key and the sidebar search.
Handlers `preventDefault` only on the real Enter: swallowing the composition-ending one can
stop an IME committing its candidate. TicketDetail's ctrl/meta+Enter is a modified chord,
not an IME commit, and is left alone.

## Left out, on purpose

- `aria-live` on the run rail's status line: it changes every poll, so a live region would
  chatter. Decide what deserves announcing first.
- The `outline: none` inputs each have a visible `:focus` border; new ones are caught by the
  REVIEW.md Frontend block.
