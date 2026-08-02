<script setup lang="ts">
// The rail (DRY-49) — one component that owns the bottom edge.
//
// It replaces BOTH the dock and DRY-50's gate tray, which is the point rather
// than a convenience. Those were two floating elements competing for the same
// strip and the same glance (and stacked at z 9000/9001, the tray deliberately
// hopping over the dock); a third for autonomous runs would have been worse
// than either. So: one rail, two lanes built from different materials.
//
//   UNDERWAY  left, raised, agent-owned. Nobody asked for these to be here;
//             they're here because work is happening. They change on their own.
//   DOCKED    right, recessed, you-owned. You put them here and you're coming
//             back. No progress, and they never change unless you touch them.
//
// The separation is DEPTH, NOT HUE — underway is raised out of the rail, docked
// is lowered into it — so the lanes read differently in a greyscale screenshot,
// at a squint, and from across the room. That also means a run can't be in both
// lanes: minimizing a watched run returns it to UNDERWAY, and the DOCKED lane
// filters autonomous sessions out (see App.vue's dockItems).
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import GatePanel from "./GatePanel.vue";
import {
  gatesConnected,
  heldMs,
  isAnswering,
  openGates,
  orphanGates,
  resolveGate,
  type OpenGate,
} from "../composables/gateStore.js";
import { RUN_STATE_META, clockMs, runState, type RunState } from "../composables/runState.js";
import type { SessionInfo } from "../lib/protocol.js";
import { RAIL_HEIGHT, type Win } from "../composables/useWindowManager.js";

const props = defineProps<{
  /** Autonomous sessions — the UNDERWAY lane, derived from /api/sessions. */
  runs: SessionInfo[];
  /**
   * EVERY session, for naming a gate.
   *
   * Not the same list as `runs`, and conflating them was DRY-50's own case
   * regressing: the rail also answers gates from *minimized ordinary windows*,
   * whose sessions are not autonomous. Looked up in `runs`, those rendered a
   * panel with no ticket and a blank working directory — on the only surface
   * able to answer them.
   */
  sessions: SessionInfo[];
  /** Minimized ordinary windows — the DOCKED lane. */
  docked: {
    win: Win;
    statusColor: string;
    statusGlow: string;
    attention: boolean;
    sub: string;
  }[];
  /** Windows currently on the desk, so a watched run can be marked as such. */
  watchedIds: string[];
  /**
   * When a finished run's card will clear itself, epoch ms, keyed by session id
   * (DRY-60). An absolute deadline rather than a duration, because it is
   * refreshed on the 3s session poll and rendered against this component's own
   * 1s clock — a remaining-time number would stall and then jump.
   *
   * Absent for anything not on its way out: every failure, and every finished
   * run on a host with the sweep turned off.
   */
  sweepAt: Record<string, number>;
  /** The host's full sweep delay, so the hairline can drain as a proportion. */
  sweepAfterMs: number;
}>();

const emit = defineEmits<{
  (e: "watch", sessionId: string): void;
  (e: "take-over", sessionId: string): void;
  (e: "dismiss", sessionId: string): void;
  (e: "restore", winId: string): void;
  (e: "focus", sessionId: string): void;
}>();

// --- clock ------------------------------------------------------------------
// Elapsed and held-time both have to keep moving: a run that has been waiting
// eleven minutes must not look like one that has been waiting four seconds.
// Only ticks while something is on the rail, which is most of the time nothing.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
watch(
  // Orphan gates count too, and not just for tidiness: this clock feeds the
  // panel's held-time. Keyed on `runs` alone, a gate from a minimized ordinary
  // window — no autonomous run in sight — read "held 0:00" forever, which is
  // precisely the number a wedge is supposed to be legible as.
  () => props.runs.length > 0 || orphanGates.value.length > 0,
  (showing) => {
    if (showing && !clock) {
      now.value = Date.now();
      clock = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!showing && clock) {
      clearInterval(clock);
      clock = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => clock && clearInterval(clock));

// --- gates ------------------------------------------------------------------
// Two different questions, two different sources, and conflating them is a bug:
//
//   "does this run need a human?"   → openGates. True even when a watched
//                                     window is showing the prompt, because the
//                                     rail's count has to be honest.
//   "can it be answered HERE?"      → orphanGates, i.e. gates no mounted pane is
//                                     rendering. Answering in the rail while a
//                                     pane shows the same prompt would put two
//                                     decision surfaces for one decision on
//                                     screen, which the design forbids outright.
const gatedSessions = computed(() => new Set(openGates.value.map((g) => g.sessionId)));

/** The one gate the rail is currently offering to answer. */
const panelIndex = ref(0);
const panelGates = computed(() => orphanGates.value);
const activeGate = computed<OpenGate | null>(
  () => panelGates.value[Math.min(panelIndex.value, panelGates.value.length - 1)] ?? null,
);
// Answering the last of N leaves the index past the end; clamp rather than
// reset to 0, so working through a queue doesn't bounce back to the start.
watch(panelGates, (list) => {
  if (panelIndex.value >= list.length) panelIndex.value = Math.max(0, list.length - 1);
});

const answerError = ref<string | null>(null);

// A failure belongs to the gate it happened on. Without this, a failed answer's
// red banner followed the queue onto the NEXT gate that advanced into the panel
// — telling you something was still waiting about a decision you hadn't made.
watch(
  () => activeGate.value?.requestId,
  () => (answerError.value = null),
);

/** The session behind a gate, whether or not it is an autonomous run. */
function gateSession(gate: OpenGate | null): SessionInfo | undefined {
  return gate ? props.sessions.find((s) => s.id === gate.sessionId) : undefined;
}

/** Same fallback chain the tray had: ticket, then title, then a short id. */
function gateLabel(gate: OpenGate | null): string {
  const s = gateSession(gate);
  return s?.ticket || s?.title || gate?.sessionId.slice(0, 8) || "";
}

async function onResolve(decision: "allow" | "deny", reason?: string, always?: boolean) {
  const gate = activeGate.value;
  if (!gate) return;
  try {
    await resolveGate(gate, decision, reason, always);
    answerError.value = null;
  } catch (err) {
    // The gate is still open daemon-side and whatever was typed is still on
    // screen. Say so next to the decision — a console line is not feedback for
    // a choice somebody believes they made.
    answerError.value = `Couldn't answer: ${
      err instanceof Error ? err.message : String(err)
    }. It's still waiting — try again.`;
  }
}

// --- runs -------------------------------------------------------------------
interface Card {
  session: SessionInfo;
  state: RunState;
  glyph: string;
  word: string;
  loud: boolean;
  terminal: boolean;
  label: string;
  repo: string;
  elapsed: string;
  held: string | null;
  detail: string;
  watched: boolean;
  /** mm:ss until this card clears itself, or null if it isn't going to. */
  clearsIn: string | null;
  /** How much of that countdown is left, 0..1 — the hairline drains on it. */
  clearsFraction: number | null;
  /**
   * The one numeric column's text, and whether it is currently the countdown.
   *
   * Resolved once here rather than as a ternary in the template beside a
   * separate `:class` test, because the two disagreed: the class was bound to
   * "has a deadline" while the text preferred `held`, so a card could be styled
   * as counting down while displaying something else.
   */
  meta: string;
  metaClearing: boolean;
}

/**
 * The repo a run belongs to. An isolated run's cwd is its worktree
 * (`…/worktrees/drydock-DRY-49`), so the ticket suffix comes back off — the
 * segment header is meant to say which project you're looking at, and
 * "drydock-DRY-49" next to "drydock-DRY-51" says nothing.
 */
function repoOf(s: SessionInfo): string {
  const base = s.cwd.split("/").filter(Boolean).pop() ?? "~";
  return s.ticket && base.endsWith(`-${s.ticket}`)
    ? base.slice(0, -(s.ticket.length + 1))
    : base;
}

const cards = computed<Card[]>(() =>
  props.runs.map((session) => {
    const gating = gatedSessions.value.has(session.id);
    const state = runState(session, gating);
    const meta = RUN_STATE_META[state];
    const gate = openGates.value.find((g) => g.sessionId === session.id);
    // Clamped at zero: the deadline can pass a tick or two before the sweep's
    // kill round-trips, and a card counting into negative time on its way out
    // is the sort of thing that gets screenshotted.
    const due = props.sweepAt[session.id];
    const left = due !== undefined ? Math.max(0, due - now.value) : null;
    const held = gate ? clockMs(heldMs(gate, now.value)) : null;
    // Held time first — a gate is the one thing that outranks everything, and
    // it is the only case where both numbers could exist at once.
    const clearsIn = left === null ? null : clockMs(left);
    const metaClearing = !held && clearsIn !== null;
    return {
      session,
      state,
      ...meta,
      label: session.ticket || session.title,
      repo: repoOf(session),
      elapsed: clockMs(now.value - session.createdAt),
      held,
      detail: detailFor(session, state, gate),
      watched: props.watchedIds.includes(session.id),
      clearsIn,
      clearsFraction:
        left === null || props.sweepAfterMs <= 0 ? null : Math.min(1, left / props.sweepAfterMs),
      meta: held ? `held ${held}` : metaClearing ? `clears ${clearsIn}` : clockMs(now.value - session.createdAt),
      metaClearing,
    };
  }),
);

/**
 * Hover text. Carries the HANDOFF PATH, which is otherwise unreachable: the
 * daemon ships it on SessionInfo, and for a run launched without a ticket
 * there is no comment either — so without this the durable artefact the whole
 * feature is built around could only be found by reading a daemon log line.
 * (A click-through would need a new endpoint; /api/sessions/:id/file is
 * confined to the session's own working tree and the document lives outside it.)
 */
function cardTitle(card: Card): string {
  const started = new Date(card.session.createdAt).toLocaleTimeString();
  const lines = [`${card.label} · ${card.state} · started ${started}`];
  // Worth saying plainly: in a hands-off mode this run will never ask you
  // anything, so a rail that only ever shows it working is the whole truth
  // rather than a gate you haven't noticed.
  lines.push(
    card.session.permissionMode === "manual"
      ? "asks about everything"
      : card.session.permissionMode === "acceptEdits"
        ? "edits freely, asks before running commands"
        : `never asks (${card.session.permissionMode})`,
  );
  if (card.session.worktree) lines.push(`worktree ${card.session.worktree}`);
  if (card.session.failure?.reason) lines.push(`failed: ${card.session.failure.reason}`);
  if (card.session.handoff) lines.push(`handoff ${card.session.handoff}`);
  return lines.join("\n");
}

/** The card's one line of prose. Truncates in CSS; never wraps. */
function detailFor(s: SessionInfo, state: RunState, gate?: OpenGate): string {
  switch (state) {
    case "gating":
      return gate ? `${gate.tool} in ${s.worktree ? "the worktree" : "the working dir"}` : "";
    case "failed":
      return s.failure?.lastLine || s.failure?.reason || "";
    case "finished":
      // NOT "logged to <TICKET>". The tracker comment is capability-gated and
      // best-effort — the fixture provider can't comment at all and any provider
      // can be unreachable — so a card that asserted it had been logged was
      // claiming something that frequently never happened. The handoff is the
      // artefact we actually know exists, because the daemon only reports it
      // after writing it.
      return s.handoff ? "handoff saved" : "";
    case "ended-turn":
      return "may want a reply";
    case "starting":
      return s.branch ? `worktree ${s.branch}` : s.cwd;
    default:
      return s.activity ?? "";
  }
}

/**
 * Runs grouped by repo, loud segments first.
 *
 * "Loud sorts left" is the rule that stops crowding from hiding the only thing
 * that needs a person: with twelve runs the rail scrolls, and a gate must never
 * be the item that scrolled off.
 */
const segments = computed(() => {
  const by = new Map<string, Card[]>();
  for (const card of cards.value) {
    const list = by.get(card.repo) ?? [];
    list.push(card);
    by.set(card.repo, list);
  }
  return [...by.entries()]
    .map(([repo, items]) => ({
      repo,
      items: [...items].sort((a, b) => Number(b.loud) - Number(a.loud)),
      loud: items.some((i) => i.loud),
    }))
    .sort((a, b) => Number(b.loud) - Number(a.loud));
});

/**
 * Crowding costs the QUIET items detail, in three tiers — the action line
 * first, then the counters. Anything waiting on a human is exempt and keeps its
 * full card, because the whole point of dropping detail is to protect the item
 * that still needs reading.
 */
const tier = computed<"full" | "compact" | "tile">(() =>
  cards.value.length <= 3 ? "full" : cards.value.length <= 8 ? "compact" : "tile",
);

function densityFor(card: Card): "full" | "compact" | "tile" {
  if (card.loud) return "full";
  return tier.value;
}

// --- the chooser ------------------------------------------------------------
// Clicking a run that isn't gating opens a two-option chooser rather than
// jumping straight into a window: "open it" would hide a state change you
// should make on purpose, since one of the two options ends autonomy for good.
const chooser = ref<string | null>(null);

/**
 * The panel's width, in px (DRY-73). The single source of truth: it is written
 * onto the element's style rather than declared in `.chooser`, because the
 * anchor arithmetic needs the width BEFORE layout — the first measurement runs
 * synchronously on the click that opens it, when the element does not yet exist.
 * A CSS declaration beside this constant would be a second copy free to drift.
 */
const CHOOSER_W = 320;

/**
 * Enough of a gap above the desk that a lifted panel is never flush with the
 * viewport edge. `.desk` is `overflow: hidden`, so anything past this is CLIPPED,
 * not merely ugly — see the lift fallback in measure().
 */
const LIFT_MARGIN = 8;

const railEl = ref<HTMLElement | null>(null);
const laneEl = ref<HTMLElement | null>(null);
const chooserEl = ref<HTMLElement | null>(null);
/** GatePanel's instance: its root element for the collision test, and the
 *  denial-cancel it exposes for the Escape chain. */
const gateEl = ref<{ $el?: unknown; cancelDenialIfOpen?: () => boolean } | null>(null);
const cardEls = new Map<string, HTMLElement>();

/** Template ref per card, so the chooser can be anchored over one. */
function setCardEl(id: string, el: unknown): void {
  if (el instanceof HTMLElement) cardEls.set(id, el);
  else cardEls.delete(id); // Vue calls back with null on unmount
}

/** Where the chooser sits: offsets in px from the rail's own box (DRY-73). */
const anchor = ref<{ left: number; lift: number; arrow: boolean } | null>(null);

/** Fallback geometry when a measurement can't be taken. See `chooserStyle`. */
const FALLBACK_LEFT = 12;

/**
 * Put the panel above the card it belongs to (DRY-73).
 *
 * It used to live in the rail's bottom-right corner regardless of which run you
 * clicked, which on a rail wide enough to scroll meant a question about one card
 * appearing several hundred pixels from it.
 *
 * Measured rather than laid out because the panel CANNOT be a child of the lane
 * — see the template for the clipping that costs — so "above the card" has to be
 * expressed in the rail's coordinates.
 */
function measure(): void {
  const id = chooser.value;
  const rail = railEl.value;
  const card = id ? cardEls.get(id) : undefined;
  if (!id || !rail || !card) {
    anchor.value = null;
    return;
  }
  const railRect = rail.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const center = cardRect.left + cardRect.width / 2;

  // A card scrolled out of the lane takes the chooser with it. Dropping only the
  // arrow — the first version — left the panel clamped inside the rail directly
  // above whatever card had taken that slot, so its two buttons acted on a
  // session it no longer appeared to be about. There is no honest way to point
  // at something that isn't on screen, so it closes instead.
  const lane = laneEl.value;
  if (lane) {
    const laneRect = lane.getBoundingClientRect();
    if (center < laneRect.left + 4 || center > laneRect.right - 4) {
      chooser.value = null; // re-enters here via the watch and takes the branch above
      return;
    }
  }

  // Clamped into the rail: the first and last cards would otherwise hang the
  // panel off the edge of the desk, and the whole point is that it's readable.
  const min = 12;
  const max = Math.max(min, railRect.width - CHOOSER_W - 12);
  let left = Math.min(max, Math.max(min, center - railRect.left - CHOOSER_W / 2));

  // The gate panel shares this strip and both can legitimately be open at once —
  // a gate pending on one run while you decide how to open another. The chooser
  // used to dodge that by living at the opposite edge; anchored to a card it can
  // land anywhere, so it has to get out of the way itself.
  //
  // Reached through the component rather than by querying `.panel`, so renaming
  // a class inside GatePanel can't silently disable the collision arithmetic.
  const panelRoot = gateEl.value?.$el;
  const panel = panelRoot instanceof HTMLElement ? panelRoot : null;
  let lift = 0;
  let arrow = true;
  if (panel) {
    const p = panel.getBoundingClientRect();
    const overlaps = (l: number) => l < p.right + 8 && l + CHOOSER_W > p.left - 8;
    if (overlaps(railRect.left + left)) {
      // Prefer stepping OVER it: that keeps the panel above its own card.
      const wanted = p.height + 8;
      // `.desk` is `overflow: hidden`, so a lift that doesn't fit is not a
      // cosmetic problem — the panel is clipped off the top and its buttons
      // become unreachable. Measure the real height once it exists; before that
      // (the synchronous first measurement) fall back to the card-relative top,
      // which is the same figure within a few px.
      const h = chooserEl.value?.getBoundingClientRect().height ?? 200;
      const top = cardRect.top - 8 - wanted - h;
      if (top >= LIFT_MARGIN) {
        lift = wanted;
        // Pointing DOWN from a lifted panel aims at the gate panel's top edge,
        // hundreds of px from the card. Nothing to point at, so nothing drawn.
        arrow = false;
      } else {
        // Not enough headroom. Slide clear horizontally instead — what the old
        // right-corner position did by construction — and keep the arrow, which
        // is now the only thing tying the panel to its card.
        left = Math.min(max, Math.max(left, p.right + 8 - railRect.left));
        if (overlaps(railRect.left + left)) lift = 0;
      }
    }
  }

  // Tracks the card even after clamping has stopped the panel moving, so it is
  // the thing that still identifies which run this is about.
  arrowOffset.value = Math.min(CHOOSER_W - 14, Math.max(14, center - railRect.left - left));
  anchor.value = { left, lift, arrow };
}

const arrowOffset = ref(CHOOSER_W / 2);

/**
 * The panel's geometry, width included — so `CHOOSER_W` is the only place the
 * number lives and the measurement can never disagree with the layout.
 * `left`/`bottom` fall back to a fixed corner when no measurement was taken; see
 * the template for why that beats not rendering.
 */
const chooserStyle = computed(() => ({
  width: `${CHOOSER_W}px`,
  left: `${anchor.value?.left ?? FALLBACK_LEFT}px`,
  bottom: `calc(100% + ${8 + (anchor.value?.lift ?? 0)}px)`,
}));

/**
 * What actually moves a card under an open panel.
 *
 * Deliberately NOT keyed on `cards`. That computed reads the 1s clock, so it
 * takes a new array identity every second: a watch on it re-measures once a
 * second forever and papers over triggers nobody registered — which is not a
 * trigger list, it's a poll wearing one. The signature below changes only when
 * something that moves a card changes: which cards exist, their order after the
 * loud-first sort, and each one's density (a card going loud widens it alone).
 */
const cardLayoutKey = computed(() =>
  cards.value.map((c) => `${c.session.id}:${densityFor(c)}`).join(),
);
watch(() => [chooser.value, cardLayoutKey.value, tier.value], () => measure(), {
  flush: "post",
});

/**
 * Everything else that moves the lane rather than the cards in it: the docked
 * lane mounting and shrinking `.underway`, the window resizing, the sidebar
 * collapsing. An observer covers the whole class, where enumerating props means
 * discovering the next one from a bug report — `props.docked` was already
 * missing from the first version's list.
 */
let laneObs: ResizeObserver | null = null;
watch(laneEl, (el) => {
  laneObs?.disconnect();
  laneObs = null;
  if (!el) return;
  laneObs = new ResizeObserver(() => measure());
  laneObs.observe(el);
});

/**
 * How much room the gate panel has above the rail (DRY-78).
 *
 * It grows UPWARD out of the rail into `.desk`, which is `overflow: hidden`, so
 * height it cannot afford is CLIPPED off its top edge — taking the header and
 * the argument being decided, with no scrollbar anywhere to bring them back.
 * That is a worse loss than the one this ticket is about: an unreachable button
 * is visibly missing, whereas a clipped panel looks whole and is simply missing
 * the command you are approving.
 *
 * Measured rather than declared because both CSS expressions of it are wrong.
 * `100%` resolves against the panel's containing block, which is the 98px rail.
 * A `100vh` calc has to subtract the topbar AND whichever of App.vue's notices
 * are in the flex column above the desk at the time — they are in the flow and
 * push it down, so the figure changes with a tracker outage. Same error the
 * panel's own `max-width: calc(100vw - 40px)` made on the other axis.
 */
const gateRoom = ref<number | null>(null);
function measureGateRoom(): void {
  const rail = railEl.value;
  const desk = rail?.parentElement;
  // Keep the last good figure rather than dropping the cap: unsetting it while
  // the panel is up would let it grow into the clip this exists to prevent.
  if (!rail || !desk) return;
  const railTop = rail.getBoundingClientRect().top;
  const deskTop = desk.getBoundingClientRect().top;
  // 8px is the panel's own gap above the rail (its `bottom: calc(100% + 8px)`);
  // LIFT_MARGIN keeps it off the desk's top edge, as it does for the chooser.
  // The floor means a desk too short for the panel yields a scrollable argument
  // rather than a max-height of zero.
  gateRoom.value = Math.max(160, railTop - deskTop - 8 - LIFT_MARGIN);
}

/**
 * The desk, not the window: `resize` misses the two things that most often
 * change the desk's height — a notice appearing above it, and the rail's own
 * height changing when the docked lane mounts.
 */
let deskObs: ResizeObserver | null = null;
watch(
  railEl,
  (el) => {
    deskObs?.disconnect();
    deskObs = null;
    const desk = el?.parentElement;
    if (!desk) return;
    deskObs = new ResizeObserver(() => measureGateRoom());
    deskObs.observe(desk);
    measureGateRoom();
  },
  { immediate: true },
);

/**
 * A chooser must not outlive the card it points at.
 *
 * `v-if="chooser"` only ever tested that the ref was SET, so every way a run
 * leaves the rail — DRY-60's sweep, the card's ✕, a kill, a take-over — left
 * the panel floating above an empty rail with no way to put it down but to
 * answer it, and both answers then emitted for a session the daemon has already
 * forgotten. The sweep makes this routine rather than a corner case: it removes
 * cards on a timer, with nobody touching anything.
 */
watch(cards, (list) => {
  if (chooser.value && !list.some((c) => c.session.id === chooser.value)) chooser.value = null;
});

/**
 * Dismissal, which the chooser had none of (DRY-73): it closed by being answered,
 * or by a second click on the exact card that opened it. Anything that asks a question
 * and takes no for an answer is a modal, and this one isn't allowed to be —
 * it sits over a desk whose windows stay live behind it.
 */
function onDocClick(e: MouseEvent): void {
  if (!chooser.value) return;
  const t = e.target;
  // A click on a card belongs to the toggle in onCardClick. This listener is on
  // the bubble phase, so it runs AFTER that handler: closing here unconditionally
  // would undo the open that just happened and make it impossible to move the
  // chooser from one card to another.
  if (t instanceof Element && t.closest(".card, .chooser")) return;
  chooser.value = null;
}

/**
 * Escape, called by App.vue — NOT by a listener of our own (DRY-73).
 *
 * A window/capture listener here could neither win nor lose cleanly. Both it and
 * App.vue's are on the same target in the same phase, so `stopPropagation` is a
 * no-op between them (it stops the event descending, not the sibling listener) —
 * the guard it claimed to be was never one. `stopImmediatePropagation` would
 * work, but only by making the rail beat a modal that sits above it: the palette
 * would stop closing on Escape whenever a chooser happened to be open.
 *
 * So precedence lives in one place, with the component that knows every layer.
 * Returns whether it consumed the key.
 */
function handleEscape(): boolean {
  if (chooser.value) {
    chooser.value = null;
    return true;
  }
  // Only ever reached with the chooser shut, since opening the reason field
  // means clicking outside the chooser, which closes it.
  return gateEl.value?.cancelDenialIfOpen?.() ?? false;
}
defineExpose({ handleEscape });

onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  laneObs?.disconnect();
  deskObs?.disconnect();
});

function onCardClick(card: Card): void {
  if (card.state === "gating") {
    // Deciding is likelier than spectating, so a gating card skips the chooser.
    // Closed FIRST, for both branches (DRY-73): the focus branch used to return
    // with an open chooser still anchored over the previously-clicked card, and
    // onDocClick deliberately ignores clicks on `.card` — so nothing else was
    // going to close it. Answering it then acted on the wrong session, which is
    // exactly what the `cards` watch exists to prevent, reached by a click
    // rather than by a card disappearing.
    chooser.value = null;
    // If a pane is already showing this prompt the rail must not offer a second
    // one — focus the window that has it instead.
    const i = panelGates.value.findIndex((g) => g.sessionId === card.session.id);
    if (i >= 0) panelIndex.value = i;
    else emit("focus", card.session.id);
    return;
  }
  chooser.value = chooser.value === card.session.id ? null : card.session.id;
  // Synchronously, not via the watch above: the card element already exists, so
  // measuring here means the panel's first paint is at the right place. Left to
  // the post-flush watch it renders once unanchored and jumps a frame later.
  measure();
}
</script>

<template>
  <div ref="railEl" class="rail" :style="{ height: `${RAIL_HEIGHT}px` }">
    <!-- The panel rises out of the rail, anchored above it. One at a time, with
         a counter, so answering advances rather than stacking prompts. -->
    <GatePanel
      v-if="activeGate"
      ref="gateEl"
      :style="gateRoom ? { '--gate-room': `${gateRoom}px` } : undefined"
      :gate="activeGate"
      :index="panelIndex"
      :total="panelGates.length"
      :busy="isAnswering(activeGate.requestId)"
      :label="gateLabel(activeGate)"
      :cwd="gateSession(activeGate)?.cwd ?? ''"
      :held="clockMs(heldMs(activeGate, now))"
      :error="answerError"
      @resolve="onResolve"
      @terminal="emit('take-over', activeGate!.sessionId)"
    />

    <!-- Watch / Take over. Take-over is the one legal crossing between the
         lanes and it only goes one way, so it says so.
         A CHILD OF THE RAIL, not of the lane it points at: the UNDERWAY lane
         scrolls horizontally, and `overflow-x: auto` makes the browser clip the
         other axis too — so anchored inside the lane this rendered above the
         rail, looked perfectly fine, and swallowed every click into the desk
         behind it. That constraint is why it POINTS at its card from out here
         (measure()) rather than simply being positioned next to it. -->
    <!-- Rendered on `chooser` alone, never on `anchor` (DRY-73). Gating the
         render on a successful measurement turns a failed one into a control
         that isn't there at all: the click registers, nothing appears, and the
         second click toggles the state back off — a two-click no-op with no
         way to tell it from a dead button. A panel in the wrong place is a far
         better failure than a panel that doesn't exist, so a missed measurement
         falls back to a fixed corner and stays usable. -->
    <div
      v-if="chooser"
      ref="chooserEl"
      class="chooser"
      :style="chooserStyle"
      @click.stop
    >
      <span class="chooser-title">open as…</span>
      <button @click="emit('watch', chooser!), (chooser = null)">
        <strong>Watch</strong>
        <span>Opens a window. Keeps running autonomously and stays in the rail.</span>
      </button>
      <button @click="emit('take-over', chooser!), (chooser = null)">
        <strong>Take over</strong>
        <span>Ends autonomy. Becomes a normal supervised session and leaves the rail.</span>
      </button>
      <!-- Escape and a click anywhere else also close it; this is the one that
           says so, since neither of those is discoverable. -->
      <button class="chooser-cancel" @click="chooser = null">Cancel</button>
      <span
        v-if="anchor?.arrow"
        class="chooser-arrow"
        :style="{ left: `${arrowOffset}px` }"
      ></span>
    </div>

    <!-- The stream is how a gate arrives at all; while it's down, what's on
         screen is a snapshot of the past and no new gate will appear (DRY-50). -->
    <p v-if="!gatesConnected && (runs.length || docked.length)" class="offline">
      Disconnected from the daemon — reconnecting. The rail may be out of date.
    </p>

    <!-- Lanes render only when they hold something. The rail's RESERVE is
         constant either way (computeRects, RAIL_HEIGHT) — that promise is about
         layout, not about painting furniture over an empty desk. -->
    <div v-if="cards.length || docked.length" class="lanes">
      <!-- UNDERWAY: raised out of the rail. -->
      <div v-if="cards.length" ref="laneEl" class="lane underway" @scroll="measure">
        <span class="caption">UNDERWAY</span>
        <span class="count">{{ cards.length }} run{{ cards.length === 1 ? "" : "s" }}</span>
        <div class="segments">
          <div v-for="seg in segments" :key="seg.repo" class="segment">
            <span class="seg-label">{{ seg.repo }}</span>
            <div class="cards">
              <div
                v-for="card in seg.items"
                :key="card.session.id"
                :ref="(el) => setCardEl(card.session.id, el)"
                class="card"
                :class="[
                  card.state,
                  densityFor(card),
                  { watched: card.watched, clearing: card.metaClearing },
                ]"
                :title="cardTitle(card)"
                @click="onCardClick(card)"
              >
                <span class="glyph">{{ card.glyph }}</span>
                <span class="id">{{ card.label }}</span>
                <span class="origin">{{ card.session.origin.toUpperCase() }}</span>
                <!-- The countdown displaces the elapsed clock rather than
                     joining it: a finished run's runtime stops being the
                     interesting number the moment the card is on its way out,
                     and the column is one card-width wide (DRY-60). -->
                <!-- Below full density the countdown moves to the SECOND ROW
                     rather than competing with the id for row 1 (DRY-60). That
                     row holds the action line, which crowding has already
                     hidden, so it is empty and full-width exactly when the
                     countdown needs somewhere to go — and the card keeps its
                     tile width. Widening the card to fit the clock on row 1
                     was the first attempt and it traded `display:none` for
                     something no better: at 176px a ten-card rail needs
                     2023px of lane and only has 1208, so five cards went off
                     the right edge (measured, 1500px viewport). -->
                <span class="meta" :class="{ clearing: card.metaClearing }">{{ card.meta }}</span>
                <!-- The one control any card ever shows, and only on the two
                     states that persist until acknowledged. -->
                <button
                  v-if="card.terminal"
                  class="clear"
                  title="Clear this run"
                  @click.stop="emit('dismiss', card.session.id)"
                >
                  ✕
                </button>
                <div class="line">
                  <span v-if="card.word" class="word">{{ card.word }}</span>
                  <span class="detail">{{ card.detail }}</span>
                </div>
                <!-- The only motion in the quiet state: a 2px hairline, marching
                     while the run is moving and frozen when it isn't. It carries
                     no fraction — step-against-plan has no signal reaching the
                     daemon, and a bar that invented one would be a lie. -->
                <!-- On a finished card it doubles as the countdown, draining
                     left-to-right over the sweep delay (DRY-60) — the same
                     2px strip, so nothing on the card moves or resizes as a
                     run goes from finished to gone. -->
                <span
                  class="hairline"
                  :class="card.state"
                  :style="
                    card.clearsFraction === null
                      ? undefined
                      : { transform: `scaleX(${card.clearsFraction})`, transformOrigin: 'left' }
                  "
                ></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="cards.length && docked.length" class="divider"></div>

      <!-- DOCKED: lowered into the rail. -->
      <div v-if="docked.length" class="lane docked">
        <span class="caption">DOCKED</span>
        <div class="dock-items">
          <div
            v-for="it in docked"
            :key="it.win.id"
            class="dock-item"
            @click="emit('restore', it.win.id)"
          >
            <span
              class="dot"
              :class="{ pulse: it.attention }"
              :style="{ background: it.statusColor, boxShadow: `0 0 7px ${it.statusGlow}` }"
            ></span>
            <div class="dock-text">
              <span class="dock-id" :style="{ color: it.win.ticket ? '#5b9bd5' : '#b9c3cf' }">
                {{ it.win.ticket || it.win.title }}
              </span>
              <span class="dock-sub">{{ it.sub }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* The rail spans the full width at z 9000 and is ALWAYS mounted, so without
     this it swallowed every click in the bottom 98px of the desk — including
     into a floating window, since float deliberately doesn't clamp rects out of
     the reserve. Its children take pointer events back individually. */
  pointer-events: none;
  /* Above the windows' band. Window z is not a fixed ceiling to clear —
     computeRects gives the focused window 50 in tile/focus, and in float w.z
     climbs on every spawn and survives reloads — so this sits deliberately far
     above rather than "just above". */
  z-index: 9000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  background: linear-gradient(180deg, #0a0c0f00 0%, #0a0c0fdd 34%, #0b0e13 100%);
  border-top: 1px solid #ffffff10;
  padding: 0 12px 8px;
}
.offline {
  position: absolute;
  left: 12px;
  bottom: 100%;
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: #3a2a1acc;
  border: 1px solid #6b4a2a;
  color: #e0c08a;
  font-size: 11.5px;
}
.lanes {
  display: flex;
  align-items: stretch;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.lane {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 12px;
  pointer-events: auto; /* the rail itself is click-through; see .rail */
}
.offline,
.chooser {
  pointer-events: auto;
}
/* Raised OUT of the rail. */
.underway {
  flex: 1 1 auto;
  overflow-x: auto;
  overflow-y: hidden;
  background: #12161ce0;
  border: 1px solid #ffffff14;
  box-shadow: 0 6px 20px #00000077;
}
/* Lowered INTO it — an inset well, the same object seen from the other side. */
.docked {
  flex: 0 1 auto;
  max-width: 42%;
  overflow-x: auto;
  overflow-y: hidden;
  background: #070a0d;
  border: 1px solid #00000060;
  box-shadow: inset 0 2px 7px #00000099;
}
.divider {
  width: 1px;
  align-self: center;
  height: 56%;
  background: #ffffff12;
}
.caption {
  flex: 0 0 auto;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  color: #5a636f;
}
.count {
  flex: 0 0 auto;
  font-size: 10px;
  color: #46505c;
  font-family: "JetBrains Mono", monospace;
}
.lane-empty {
  font-size: 11px;
  color: #39414b;
}
.segments {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.segment {
  display: flex;
  align-items: center;
  gap: 8px;
}
.seg-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #46505c;
  text-transform: uppercase;
  writing-mode: horizontal-tb;
  white-space: nowrap;
}
.cards {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* One card size in every state — nothing grows, nothing sprouts a button, so a
   state change never reflows the rail or slides a neighbour out from under the
   cursor. The whole card is the click target. */
.card {
  position: relative;
  display: grid;
  grid-template-columns: 14px auto auto 1fr auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 2px 7px;
  width: 268px;
  height: 62px;
  padding: 8px 10px 10px;
  border-radius: 9px;
  background: #171d25;
  border: 1px solid #ffffff12;
  cursor: pointer;
  overflow: hidden;
}
.card:hover {
  background: #1c242e;
  border-color: #2c3742;
}
.card.compact {
  width: 176px;
}
.card.tile {
  width: 112px;
}
.card.watched {
  border-color: #2a557d;
}
.glyph {
  font-size: 12px;
  line-height: 1;
  color: #7c8693;
  text-align: center;
}
.card.running .glyph {
  color: #5fb98a;
}
.card.gating .glyph {
  color: #e0a33c;
}
.card.failed .glyph {
  color: #d5695c;
}
.card.finished .glyph {
  color: #5fb98a;
}
.card.starting .glyph {
  animation: ddpulse 1.4s ease-in-out infinite;
}
.id {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 600;
  color: #5b9bd5;
  white-space: nowrap;
}
.origin {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #4d5763;
  border: 1px solid #ffffff10;
  border-radius: 3px;
  padding: 0 3px;
}
.meta {
  grid-column: 4 / 6;
  justify-self: end;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #6b7684;
  white-space: nowrap;
}
.card.gating .meta {
  color: #e0a33c;
}
/* Dimmer than the elapsed clock it replaces. A card telling you it is about to
   remove itself is information, not an alarm — the loud states are the ones
   that want a person, and this one has stopped wanting anything. */
.meta.clearing {
  color: #55606d;
}
.card.tile .origin,
.card.tile .meta,
.card.compact .meta {
  display: none;
}
/* …except a countdown, which is a WARNING rather than a stat and is the one
   number that must never be the thing crowding takes away (DRY-60). Placed
   after the rule above deliberately: same specificity, later wins. */
.card.clearing .meta {
  display: block;
}
/* And it takes the action line's row, which these densities have already
   emptied. Row 1 is the crowded one — the id, the badge and the ✕ are all
   there — while row 2 is the full width of the card and holds nothing, so the
   clock keeps the word "clears" even at 112px and never has to be measured
   against an 8-character ticket key. The card's WIDTH is the thing that must
   not move: the lane is one non-wrapping scrolling row, so every px added here
   pushes a card at the other end out of sight. */
.card.compact.clearing .meta,
.card.tile.clearing .meta {
  grid-column: 1 / 6;
  grid-row: 2;
  justify-self: start;
  margin-right: 0;
}
/* Keep the clock clear of the ✕, which is absolutely positioned in the same
   top-right corner and only exists on these two states. Overlapping, a click
   aimed at a failed card's elapsed time landed on "clear this run" instead. */
.card.finished .meta,
.card.failed .meta {
  margin-right: 17px;
}
.line {
  grid-column: 1 / 6;
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.card.compact .line,
.card.tile .line {
  display: none;
}
.word {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: #7c8693;
}
.card.gating .word {
  color: #e0a33c;
}
.card.failed .word {
  color: #d5695c;
}
.detail {
  min-width: 0;
  font-size: 10.5px;
  color: #7c8693;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clear {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: #ffffff0d;
  color: #7c8693;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
}
.clear:hover {
  background: #ffffff1a;
  color: #d5dde6;
}

/* Weight for the two states that want a person: a 3px edge and a halo. Failure
   pulses more slowly than a live gate, so a gate still wins the eye. */
.card.gating {
  border-left: 3px solid #e0a33c;
  animation: needsyou 1.7s ease-in-out infinite;
}
.card.failed {
  border-left: 3px solid #d5695c;
  animation: failpulse 2.4s ease-in-out infinite;
}

.hairline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: #ffffff10;
}
/* Marching stripes while the run is moving; frozen the moment it isn't —
   a stopped run must not animate as though it were still working. */
.hairline.running {
  background: repeating-linear-gradient(90deg, #3f7fb8 0 11px, #16222e 11px 22px);
  background-size: 22px 100%;
  animation: flow 0.9s linear infinite;
}
.hairline.starting {
  background: linear-gradient(90deg, #3f7fb8 0 18%, #ffffff10 18%);
}
.hairline.gating {
  background: linear-gradient(90deg, #e0a33c 0 45%, #ffffff10 45%);
}
.hairline.ended-turn {
  background: linear-gradient(90deg, #6b7684 0 70%, #ffffff10 70%);
}
.hairline.finished {
  background: #5fb98a;
}
.hairline.failed {
  background: linear-gradient(90deg, #d5695c 0 60%, #ffffff10 60%);
}

.chooser {
  position: absolute;
  /* `left` and `bottom` are both written by measure(), which puts the panel over
     the card it belongs to and steps it above the gate panel when the two would
     collide. It used to be pinned to the rail's right corner — clear of the
     left-anchored gate panel, but also several hundred pixels from whichever
     card you actually clicked once the rail was wide enough to scroll.
     Width is duplicated in CHOOSER_W; the anchor arithmetic needs it up front. */
  bottom: calc(100% + 8px);
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: 11px;
  background: #141b22f8;
  border: 1px solid #33506e;
  box-shadow: 0 14px 34px #000000aa;
}
.chooser-title {
  font-size: 10px;
  letter-spacing: 0.07em;
  color: #5a636f;
  text-transform: uppercase;
}
.chooser button {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  text-align: left;
  border-radius: 8px;
  border: 1px solid #ffffff12;
  background: #10151b;
  color: #d5dde6;
  cursor: pointer;
}
.chooser button:hover {
  background: #182029;
  border-color: #2c3742;
}
.chooser button strong {
  font-size: 12.5px;
}
.chooser button span {
  font-size: 10.5px;
  color: #7c8693;
}
/* The Cancel affordance (DRY-73).
   Not one of the two answers, so it doesn't look like one: no title/description
   pair, and it sits apart from them.
   Selector is `.chooser button.chooser-cancel`, not `.chooser-cancel`, and that
   is load-bearing rather than stylistic: `.chooser button` above is (0,1,1) and
   a bare class is (0,1,0), so every declaration these two share — padding,
   background, border, color — lost, and Cancel rendered filled and bordered
   exactly like Watch and Take over. The opposite of what this rule says. */
.chooser button.chooser-cancel {
  align-self: flex-start;
  padding: 3px 8px;
  margin-top: 1px;
  font-size: 10.5px;
  color: #7c8693;
  background: none;
  border: none;
}
.chooser button.chooser-cancel:hover {
  color: #c3ccd6;
  background: none;
  border: none;
}
/* Points at the card the panel belongs to (DRY-73). Hidden by measure() when that card
   has scrolled out of the lane, rather than left aiming at its neighbour. */
.chooser-arrow {
  position: absolute;
  bottom: -5px;
  width: 9px;
  height: 9px;
  transform: translateX(-50%) rotate(45deg);
  background: #141b22f8;
  border-right: 1px solid #33506e;
  border-bottom: 1px solid #33506e;
}

.dock-items {
  display: flex;
  align-items: center;
  gap: 7px;
}
.dock-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 9px;
  background: #10151b;
  border: 1px solid #ffffff0d;
  cursor: pointer;
}
.dock-item:hover {
  background: #171d25;
  border-color: #2c3742;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.pulse {
  animation: ddpulse 1.2s ease-in-out infinite;
}
.dock-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dock-id {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.dock-sub {
  font-size: 10px;
  color: #6b7684;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes needsyou {
  0%,
  100% {
    box-shadow: 0 0 0 0 #e0a33c00, 0 6px 20px #00000077;
  }
  50% {
    box-shadow: 0 0 0 5px #e0a33c1f, 0 6px 20px #00000077;
  }
}
@keyframes failpulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 #d5695c00, 0 6px 20px #00000077;
  }
  50% {
    box-shadow: 0 0 0 5px #d5695c1f, 0 6px 20px #00000077;
  }
}
@keyframes flow {
  from {
    background-position: 0 0;
  }
  to {
    background-position: 22px 0;
  }
}
@keyframes ddpulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}
</style>
