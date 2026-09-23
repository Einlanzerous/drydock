// The toast stack's DOM, as the harnesses select it (DRY-100).
//
// One place, because nine harnesses used to select on the banners' old classes
// (`.notice`, `.error`, `p.note`, `.banner-x`) and moving the markup broke all
// of them at once. The next move IS a one-file change: `sidebar`, `tracker-cache`,
// `roam`, `surface`, `hang`, `spawn-layout`, `worktree-reap-ui`, `race` and
// `sweep` all import this. (`gate-actions` doesn't — it used a notice as a
// LEVER, not a selector; see its own header and the DRY-78 section of
// README.md for what replaced it.)
//
// It matters more than a tidy import does. Several of those harnesses assert a
// COUNT of zero — "the notice cleared itself", "no red banner", "a desk that has
// swept nothing says nothing about history" — and a selector that silently
// matches nothing passes every one of those for the wrong reason (CLAUDE.md
// trap 5). `race.mts` and `sweep.mts` ran on the OLD `.notice` class for a
// while after the other seven were migrated, undetected, because `ToastStack`
// also happens to put `t.kind` on the element as a class — so `.notice` kept
// matching by coincidence, not by contract. Each zero-count assertion has to be
// paired with a positive one that proves the selector can see a toast at all;
// `toast-stack.mts` proves that for all three kinds and is the harness to run
// first after touching this.
//
// `data-toast` rather than the classes, deliberately: a class is a styling
// decision, and `.notice` / `.error` / `.note` are also names other components
// use for unrelated things (GatePanel's `p.error`, SessionTombstone's `.note`),
// so a bare `.error` has always matched more than the header's banner did.

export const TOAST = {
  /** Any toast, of any kind. */
  any: "[data-toast]",
  /** Red, `role="alert"`: the poll's error and a failed action. */
  error: '[data-toast="error"]',
  /** Green, `role="status"`: a non-failure outcome (DRY-90). */
  note: '[data-toast="note"]',
  /** Amber, `role="status"`: a continuing condition (DRY-58). */
  notice: '[data-toast="notice"]',
  /** The ✕ inside one toast. */
  dismiss: ".toast-x",
} as const;
