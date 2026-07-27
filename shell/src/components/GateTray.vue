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
import { computed, onBeforeUnmount, ref } from "vue";
import PermissionPrompt from "./PermissionPrompt.vue";
import { openGates, resolveGate, type OpenGate } from "../composables/gateStore.js";
import type { SessionInfo } from "../lib/protocol.js";

const props = defineProps<{
  /** Sessions with a mounted pane — their gates render in the pane instead. */
  panedSessionIds: string[];
  sessions: SessionInfo[];
}>();

const emit = defineEmits<{ (e: "open", sessionId: string): void }>();

// A gate belongs here only while nothing else is showing it. Without this the
// same gate would render twice for an open window — once in the pane, once
// down here — and the two would race to answer it.
const orphaned = computed(() =>
  openGates.value.filter((g) => !props.panedSessionIds.includes(g.sessionId)),
);

// Held-time ticks, which is the point of carrying requestedAt: a gate nobody
// has answered should read as a number that keeps growing, not as a static
// badge that looks the same after four seconds and forty minutes.
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 1000);
onBeforeUnmount(() => clearInterval(clock));

function held(gate: OpenGate): string {
  const secs = Math.max(0, Math.floor((now.value - gate.requestedAt) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function label(gate: OpenGate): string {
  const session = props.sessions.find((s) => s.id === gate.sessionId);
  return session?.ticket || session?.title || gate.sessionId.slice(0, 8);
}

async function onResolve(gate: OpenGate, decision: "allow" | "deny", reason?: string) {
  try {
    await resolveGate(gate, decision, reason);
  } catch (err) {
    // The gate is still open daemon-side, and the stream replays it on the next
    // reconnect — so surfacing the failure beats silently swallowing a decision
    // the user believes they made.
    console.error("failed to answer gate", err);
  }
}
</script>

<template>
  <div v-if="orphaned.length" class="gate-tray">
    <div v-for="gate in orphaned" :key="gate.requestId" class="gate">
      <div class="gate-head">
        <span class="gate-ticket">{{ label(gate) }}</span>
        <span class="gate-held">held {{ held(gate) }}</span>
        <button class="gate-open" @click="emit('open', gate.sessionId)">Open window</button>
      </div>
      <PermissionPrompt
        :tool="gate.tool"
        :input="gate.input"
        allow-reason
        @resolve="(d, r) => onResolve(gate, d, r)"
      />
    </div>
  </div>
</template>

<style scoped>
.gate-tray {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 380px;
  max-height: 70vh;
  overflow-y: auto;
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
