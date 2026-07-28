// What a run is doing, as one word (DRY-49).
//
// Six states, derived — never stored. Every one of them is a function of facts
// the daemon already publishes (`/api/sessions` plus the gate stream), which is
// what lets a card survive a reload without the browser having remembered
// anything: the run is failed because the daemon says it failed.
//
// The order below IS the precedence, and it isn't arbitrary:
//   failed/finished first  — a dead process can still carry a stale `idle`
//   gating next            — a blocked tool outranks anything else that's true
//   ended-turn             — the agent handed back; NOT a claim of completion
//   starting               — running, but no tool call has been seen yet
//   running                — the quiet, overwhelmingly common case
import type { SessionInfo } from "../lib/protocol.js";

export type RunState =
  | "starting"
  | "running"
  | "gating"
  | "ended-turn"
  | "finished"
  | "failed";

export function runState(session: SessionInfo, gating: boolean): RunState {
  // `failure` is the ONLY thing that means failed — never the exit code. The
  // daemon records a failure for every genuine one (including a run it killed
  // after an unanswered gate, which can exit 0 while having plainly failed),
  // and deliberately records none when a person stopped the run themselves.
  // Reading the exit code here instead put "FAILED" on the card of every run
  // anybody chose to stop, because a signalled process exits 129.
  if (session.failure) return "failed";
  if (session.status === "exited") return "finished";
  if (gating) return "gating";
  if (session.idle) return "ended-turn";
  if (!session.activity) return "starting";
  return "running";
}

/**
 * Per-state presentation. The glyph is a SHAPE, not a dot, so the whole
 * grammar survives greyscale; the word is absent for the quiet states, which
 * is what makes them quiet. Colour is the fifth signal and never load-bearing.
 */
export const RUN_STATE_META: Record<
  RunState,
  { glyph: string; word: string; loud: boolean; terminal: boolean }
> = {
  starting: { glyph: "◌", word: "STARTING", loud: false, terminal: false },
  running: { glyph: "▸", word: "", loud: false, terminal: false },
  gating: { glyph: "!", word: "NEEDS YOU", loud: true, terminal: false },
  // A pause bar, never a checkmark. The Stop hook means the turn ended, which
  // is "done OR waiting for a reply" — the UI must never spend the word "done"
  // on a guess (DRY-18).
  "ended-turn": { glyph: "‖", word: "ENDED TURN", loud: false, terminal: true },
  finished: { glyph: "✓", word: "FINISHED", loud: false, terminal: true },
  failed: { glyph: "✕", word: "FAILED", loud: true, terminal: true },
};

/** mm:ss, or h:mm:ss past an hour — the rail's only numeric column. */
export function clockMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const h = Math.floor(s / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
