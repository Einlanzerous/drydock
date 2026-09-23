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
// Which makes the behaviour fall out: they never steal focus, and whoever
// raised one is the one who ends it. The failure they exist for is the quiet
// one. The layout store degrading used to be a `console.warn` and nothing else,
// which is how you discover at the worst possible moment that your desk stopped
// roaming; DRY-55's tracker outage is the same shape (an empty sidebar that says
// nothing is wrong) and is meant to land here too rather than invent a second
// surface.
//
// They were NOT dismissible until DRY-100 — a ✕ would only hide a fact that is
// still true — and they are now, deliberately: a toast that only its owner may
// remove is one you can't get out of the way of the window under it. The hide is
// remembered until `clearNotice`, not merely until the next `setNotice`, because
// `setNotice` is idempotent and retry loops re-call it; forgetting on the re-call
// would resurrect the toast a moment after it was closed. That memory lives in
// `toasts.ts` — this module still knows nothing about being seen.
import { computed, reactive } from "vue";

export interface Notice {
  /** One line, present tense — the condition, not the event that caused it. */
  text: string;
  /** The underlying error, shown smaller. Optional; often unreadable prose. */
  detail?: string;
}

const byKey = reactive<Record<string, Notice>>({});

/**
 * Longest `detail` worth showing inline. A notice is a quiet aside, and
 * `String(err)` is not always a sentence: a 503 carrying the migration-drift
 * message (`state store: Error: migration 001_workspace.sql changed after it
 * was applied (ledger …, file …). An applied migration is history: …`) is a
 * paragraph, and a paragraph in a toast covers the desk and reads as an alarm.
 * A toast can wrap since DRY-100 — it no longer pushes anything down — but the
 * cap stands for the second reason alone. The console line keeps the whole
 * thing.
 */
const DETAIL_MAX = 140;

/**
 * Raise (or update) the condition under `key`. Idempotent by design: the caller
 * is usually a retry loop, and re-reporting the same outage must not stack.
 */
export function setNotice(key: string, text: string, detail?: string): void {
  byKey[key] = { text, detail: detail && truncate(detail) };
}

function truncate(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
}

/** The condition no longer holds. Safe to call when it never did. */
export function clearNotice(key: string): void {
  delete byKey[key];
}

/** Stable render order: insertion, which is the order things went wrong. */
export const noticeList = computed(() =>
  Object.entries(byKey).map(([key, notice]) => ({ key, ...notice })),
);
