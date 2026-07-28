// Continuing conditions the desk should mention but not interrupt for (DRY-58).
//
// This is the third kind of message the shell has, and the distinction is the
// reason it exists rather than a fourth `error` ref in App.vue:
//
//   `error`        a condition owned by the 3s session poll — set while the
//                  daemon won't answer, cleared the moment it does.
//   `actionError`  a past EVENT that nothing will re-raise (a kill that didn't
//                  take, a spawn that failed), so it's sticky and dismissible
//                  and the poll's next success must not wipe it (DRY-51).
//   a notice       a condition owned by whoever raised it. Something is still
//                  working, just not the way you'd assume, and the thing that
//                  noticed will notice again when it stops being true.
//
// Which makes the behaviour fall out: notices are NOT dismissible — there is
// nothing to acknowledge, the condition either holds or it doesn't — and they
// never steal focus. The failure they exist for is the quiet one. The layout
// store degrading used to be a `console.warn` and nothing else, which is how
// you discover at the worst possible moment that your desk stopped roaming;
// DRY-55's tracker outage is the same shape (an empty sidebar that says nothing
// is wrong) and is meant to land here too rather than invent a second surface.
import { computed, reactive } from "vue";

export interface Notice {
  /** One line, present tense — the condition, not the event that caused it. */
  text: string;
  /** The underlying error, shown smaller. Optional; often unreadable prose. */
  detail?: string;
}

const byKey = reactive<Record<string, Notice>>({});

/**
 * Raise (or update) the condition under `key`. Idempotent by design: the caller
 * is usually a retry loop, and re-reporting the same outage must not stack.
 */
export function setNotice(key: string, text: string, detail?: string): void {
  byKey[key] = { text, detail };
}

/** The condition no longer holds. Safe to call when it never did. */
export function clearNotice(key: string): void {
  delete byKey[key];
}

/** Stable render order: insertion, which is the order things went wrong. */
export const noticeList = computed(() =>
  Object.entries(byKey).map(([key, notice]) => ({ key, ...notice })),
);
