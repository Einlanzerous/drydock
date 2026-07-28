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
import { computed, onBeforeUnmount, ref, watch } from "vue";
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
    return {
      session,
      state,
      ...meta,
      label: session.ticket || session.title,
      repo: repoOf(session),
      elapsed: clockMs(now.value - session.createdAt),
      held: gate ? clockMs(heldMs(gate, now.value)) : null,
      detail: detailFor(session, state, gate),
      watched: props.watchedIds.includes(session.id),
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
  return card.loud ? "full" : tier.value;
}

// --- the chooser ------------------------------------------------------------
// Clicking a run that isn't gating opens a two-option chooser rather than
// jumping straight into a window: "open it" would hide a state change you
// should make on purpose, since one of the two options ends autonomy for good.
const chooser = ref<string | null>(null);

function onCardClick(card: Card): void {
  if (card.state === "gating") {
    // Deciding is likelier than spectating, so a gating card skips the chooser.
    // If a pane is already showing this prompt the rail must not offer a second
    // one — focus the window that has it instead.
    const i = panelGates.value.findIndex((g) => g.sessionId === card.session.id);
    if (i >= 0) {
      panelIndex.value = i;
      chooser.value = null;
    } else {
      emit("focus", card.session.id);
    }
    return;
  }
  chooser.value = chooser.value === card.session.id ? null : card.session.id;
}
</script>

<template>
  <div class="rail" :style="{ height: `${RAIL_HEIGHT}px` }">
    <!-- The panel rises out of the rail, anchored above it. One at a time, with
         a counter, so answering advances rather than stacking prompts. -->
    <GatePanel
      v-if="activeGate"
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
         behind it. -->
    <div v-if="chooser" class="chooser" @click.stop>
      <span class="chooser-title">open as…</span>
      <button @click="emit('watch', chooser!), (chooser = null)">
        <strong>Watch</strong>
        <span>Opens a window. Keeps running autonomously and stays in the rail.</span>
      </button>
      <button @click="emit('take-over', chooser!), (chooser = null)">
        <strong>Take over</strong>
        <span>Ends autonomy. Becomes a normal supervised session and leaves the rail.</span>
      </button>
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
      <div v-if="cards.length" class="lane underway">
        <span class="caption">UNDERWAY</span>
        <span class="count">{{ cards.length }} run{{ cards.length === 1 ? "" : "s" }}</span>
        <div class="segments">
          <div v-for="seg in segments" :key="seg.repo" class="segment">
            <span class="seg-label">{{ seg.repo }}</span>
            <div class="cards">
              <div
                v-for="card in seg.items"
                :key="card.session.id"
                class="card"
                :class="[card.state, densityFor(card), { watched: card.watched }]"
                :title="cardTitle(card)"
                @click="onCardClick(card)"
              >
                <span class="glyph">{{ card.glyph }}</span>
                <span class="id">{{ card.label }}</span>
                <span class="origin">{{ card.session.origin.toUpperCase() }}</span>
                <span class="meta">{{ card.held ? `held ${card.held}` : card.elapsed }}</span>
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
                <span class="hairline" :class="card.state"></span>
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
.card.tile .origin,
.card.tile .meta,
.card.compact .meta {
  display: none;
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
  /* RIGHT-anchored, while the gate panel is left-anchored. They share the strip
     directly above the rail, and both can legitimately be open at once — a gate
     pending on one run while you decide how to open another. Anchored to the
     same edge, the chooser (which stacks above) simply covered the panel's left
     half, including its command blob. */
  right: 12px;
  bottom: calc(100% + 8px);
  z-index: 1;
  width: 320px;
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
