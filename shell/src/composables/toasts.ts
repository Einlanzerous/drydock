// The desk's status messages as one overlay stack (DRY-100).
//
// Four surfaces used to render as full-width rows in App.vue's flex column,
// between the header and `.body`. Every one that appeared or cleared changed
// the height of `.body`, so the sidebar and every window jumped under the
// cursor, and `TerminalPane`'s ResizeObserver refitted every terminal for it.
// They are toasts now: out of the flow, so raising or clearing one moves
// nothing.
//
// This is deliberately a VIEW of the four owners' state, not a store they push
// into. The poll's `error`, the two action refs and `noticeList` stay exactly
// where they were, and the stack is derived from them. That is what makes
// "the toast leaves when its owner does" structural rather than something a
// bridge has to keep in sync — a copy would be a second answer free to
// disagree with the first, and the disagreement would be a toast that outlives
// the condition it reports.
//
// Two lifecycles, and the difference is who is able to end the toast:
//
//   a CONDITION   the poll `error` and every notice. Something owns it and will
//                 clear it when it stops being true. ✕ hides it, and the hide
//                 lasts exactly until the owner clears — see `hidden` below.
//   an EVENT      `actionError` and `actionNote`. Nothing will ever resolve a
//                 kill that didn't take, so ✕ is the only way out, and it has
//                 to clear the OWNER's ref: remembering a hide instead would
//                 swallow the next event raised under the same key.
//
// Why not a toast library: the ones that exist are built around a TIMER and
// around the newest toast displacing the older ones. Neither is wanted. Nothing
// here expires on a clock (a failed action you didn't read is still the case
// when you come back), and an arrival that shifts what's already on screen is
// the bounce this ticket exists to remove, only smaller.
import { computed, reactive, ref, watch } from "vue";

export type ToastKind = "error" | "note" | "notice";

export interface Toast {
  /** Unique across the four owners; also the arrival-order and hide key. */
  key: string;
  kind: ToastKind;
  /** One clause of prose. May wrap; is not a paragraph. */
  text: string;
  /** The underlying error, shown smaller. Already capped by `notices.ts`. */
  detail?: string;
  /**
   * Present for an EVENT: clears the owner's state, which is what removes the
   * toast. Absent for a CONDITION, whose ✕ is remembered by the stack instead.
   */
  onDismiss?: () => void;
}

/**
 * `sources` is read reactively, so it may be a plain function over the owners'
 * refs — it is re-run whenever any of them changes.
 */
export function useToastStack(sources: () => Toast[]) {
  const live = computed(sources);

  // Arrival order, oldest first, and what makes the stack safe to have under a
  // cursor: it is appended to at the BOTTOM, so a new toast never moves one
  // that's already on screen. A fixed slot per owner (error, then action, then
  // notices) would be simpler and wrong — a poll error raised after a notice
  // would sort above it and push it down, the bounce in miniature.
  const order = ref<string[]>([]);

  // Conditions the person has dismissed and that are still true. A notice is
  // raised by a retry loop that calls `setNotice` again on every attempt, so
  // forgetting a dismissal on the next call would resurrect the toast a moment
  // after it was closed. It lasts until the owner clears the condition, at
  // which point the next occurrence is a new event and shows.
  const hidden = reactive(new Set<string>());

  // `flush: "sync"` because the prune has to run between an owner's clear and
  // its re-raise, which can be the same task (a retry loop's clear-then-set):
  // a queued flush would see the key present on both sides and keep the hide.
  watch(
    live,
    (list) => {
      const present = new Set(list.map((t) => t.key));
      for (const k of [...hidden]) if (!present.has(k)) hidden.delete(k);
      const kept = order.value.filter((k) => present.has(k));
      const fresh = list.map((t) => t.key).filter((k) => !kept.includes(k));
      order.value = [...kept, ...fresh];
    },
    { immediate: true, flush: "sync" },
  );

  const toasts = computed<Toast[]>(() => {
    const byKey = new Map(live.value.map((t) => [t.key, t]));
    return order.value.flatMap((k) => {
      const t = byKey.get(k);
      return t && !hidden.has(k) ? [t] : [];
    });
  });

  function dismiss(key: string): void {
    const t = live.value.find((x) => x.key === key);
    if (!t) return;
    if (t.onDismiss) t.onDismiss();
    else hidden.add(key);
  }

  return { toasts, dismiss };
}
