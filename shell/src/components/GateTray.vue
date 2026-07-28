<script setup lang="ts">
// Permission gates for sessions that have no pane to show them in (DRY-50).
//
// Before this, minimizing a window unmounted its TerminalPane, which closed the
// session's only WebSocket — so the daemon's gate reached nobody and the run
// wedged behind a timeout that fell through to the CLI's own prompt inside a
// PTY nobody was watching. Gates now arrive on the shell-wide stream, and this
// is the surface that renders the ones no pane is responsible for.
//
// DELIBERATELY PLAIN. The Autonomous Runs design replaces this with the rail
// (two lanes, six states, density tiers, a 604px anchored panel) under DRY-49.
// Building any of that here would be building the design's furniture before its
// foundation. This is the smallest thing that makes a gate answerable without a
// terminal — the PermissionPrompt component it hosts is the part that survives.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import PermissionPrompt from "./PermissionPrompt.vue";
import {
  gatesConnected,
  heldMs,
  isAnswering,
  orphanGates,
  resolveGate,
  type OpenGate,
} from "../composables/gateStore.js";
import type { SessionInfo } from "../lib/protocol.js";

const props = defineProps<{ sessions: SessionInfo[] }>();
const emit = defineEmits<{ (e: "open", sessionId: string): void }>();

// Held here rather than raised to App's `error` banner: that ref is owned by
// the 3s session poll, which sets it back to null on every success — so a
// failed answer flashed for at most one poll interval and usually not at all.
// This sits next to the row it belongs to, where the user is already looking.
const answerError = ref<string | null>(null);

// Held-time ticks, which is the point of carrying requestedAt: a gate nobody
// has answered should read as a number that keeps growing, not a static badge
// that looks the same after four seconds and forty minutes. Only runs while
// something is on screen — the tray is empty almost all of the time.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
watch(
  () => orphanGates.value.length > 0,
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

function held(gate: OpenGate): string {
  const secs = Math.floor(heldMs(gate, now.value) / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

const byId = computed(() => Object.fromEntries(props.sessions.map((s) => [s.id, s])));

function label(gate: OpenGate): string {
  const session = byId.value[gate.sessionId];
  return session?.ticket || session?.title || gate.sessionId.slice(0, 8);
}

async function onResolve(gate: OpenGate, decision: "allow" | "deny", reason?: string) {
  try {
    await resolveGate(gate, decision, reason);
    answerError.value = null;
  } catch (err) {
    // The gate is still open daemon-side and the row is still on screen with
    // whatever was typed into it. Say so where the user is looking — a console
    // line is not feedback for a decision they believe they made.
    answerError.value = `Couldn't answer ${label(gate)}: ${
      err instanceof Error ? err.message : String(err)
    }. It's still waiting — try again.`;
  }
}
</script>

<template>
  <div v-if="orphanGates.length" class="gate-tray">
    <!-- The stream is how a gate arrives at all; while it's down what's on
         screen is a snapshot of the past and no new gate will appear. -->
    <p v-if="!gatesConnected" class="gate-offline">
      Disconnected from the daemon — reconnecting. Gates may be out of date.
    </p>
    <p v-if="answerError" class="gate-error">{{ answerError }}</p>

    <div v-for="gate in orphanGates" :key="gate.requestId" class="gate">
      <div class="gate-head">
        <span class="gate-ticket">{{ label(gate) }}</span>
        <span class="gate-held">held {{ held(gate) }}</span>
        <button class="gate-open" @click="emit('open', gate.sessionId)">Open window</button>
      </div>
      <PermissionPrompt
        :tool="gate.tool"
        :input="gate.input"
        allow-reason
        :busy="isAnswering(gate.requestId)"
        @resolve="(d, r) => onResolve(gate, d, r)"
      />
    </div>
  </div>
</template>

<style scoped>
.gate-tray {
  position: fixed;
  right: 18px;
  /* Clear of the DOCK, not just of the windows. computeRects reserves 72px at
     the bottom once anything is minimized, and the dock sits in it — and the
     tray is most likely to be showing exactly when something IS minimized, so
     overlapping would put the dock's right-hand items under an element that
     outranks them and make them unclickable. */
  bottom: 90px;
  /* Above the dock's 9000, not in the windows' band. Window z is not a fixed
     ceiling to clear: computeRects gives the focused window 50 in tile and
     focus, and in float w.z starts at 30 and climbs on every spawn/focus/
     restore, with hydrate() carrying the high-water mark across reloads. Any
     value picked to sit "just above windows" is one the desk grows past. */
  z-index: 9001;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 380px;
  max-height: calc(100vh - 140px);
  overflow-y: auto;
}
.gate-offline {
  margin: 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: #3a2a1acc;
  border: 1px solid #6b4a2a;
  color: #e0c08a;
  font-size: 11.5px;
}
.gate-error {
  margin: 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: #3a1e1ecc;
  border: 1px solid #7a3a34;
  color: #f0c9c4;
  font-size: 11.5px;
}
.gate {
  border-radius: 10px;
}
.gate-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 6px;
}
.gate-ticket {
  color: #7fa8cf;
  font-size: 12px;
  font-weight: 600;
}
.gate-held {
  color: #d6a651;
  font-size: 11px;
  font-family: "JetBrains Mono", monospace;
}
.gate-open {
  margin-left: auto;
  background: none;
  border: none;
  color: #6b7684;
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
}
.gate-open:hover {
  color: #9aa6b2;
}
</style>
