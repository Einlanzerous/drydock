<script setup lang="ts">
// The permission gate's decision surface, lifted out of TerminalPane (DRY-50).
//
// It has two hosts and must not care which one it's in: the pane renders it
// over a live terminal, and GateTray renders it for sessions whose window is
// minimized and therefore have no pane at all. Answering is the host's job —
// the pane still answers over its own WebSocket, the tray over HTTP — so this
// component only decides *what* was chosen and hands it up.
//
// Deliberately positionless: no `position`/`inset` here, so each host places
// it. That's what lets the pane keep its exact pre-DRY-50 appearance.
import { ref } from "vue";

defineProps<{
  tool: string;
  input: unknown;
  /** Show the deny-reason field. Off in-pane, where a terminal is right there. */
  allowReason?: boolean;
}>();

const emit = defineEmits<{
  (e: "resolve", decision: "allow" | "deny", reason?: string): void;
}>();

const denying = ref(false);
const reason = ref("");

function approve() {
  emit("resolve", "allow");
}

// Deny opens a field rather than firing immediately, per the Autonomous Runs
// design: a bare denial tends to make the agent retry the identical call, so
// the reason is what turns "no" into a redirect. The second click sends it.
function deny() {
  if (!denying.value) {
    denying.value = true;
    return;
  }
  emit("resolve", "deny", reason.value.trim() || undefined);
}
</script>

<template>
  <div class="permission">
    <div class="permission-text">
      <strong>Permission needed</strong>
      <code>{{ tool }}</code>
      <pre>{{ JSON.stringify(input, null, 2) }}</pre>
    </div>

    <div v-if="allowReason && denying" class="deny-reason">
      <input
        v-model="reason"
        placeholder="Tell the agent why — it goes back as the tool result"
        @keydown.enter="deny"
      />
    </div>

    <div class="permission-actions">
      <button class="approve" @click="approve">Approve</button>
      <button class="deny" @click="deny">
        {{ allowReason && denying ? "Send denial" : "Deny" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Values carried over verbatim from TerminalPane so the in-pane gate looks
   exactly as it did before the extraction — minus the positioning, which is
   now the host's. */
.permission {
  background: #141b22f5;
  border: 1px solid #33506e;
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 12px 30px #000000aa;
}
.permission-text strong {
  color: #e6ecf2;
  font-size: 13px;
}
.permission-text code {
  margin-left: 8px;
  color: #d6a651;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
}
.permission-text pre {
  margin: 8px 0 0;
  max-height: 120px;
  overflow: auto;
  color: #9aa6b2;
  font-size: 11.5px;
  font-family: "JetBrains Mono", monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.deny-reason {
  margin-top: 10px;
}
.deny-reason input {
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid #4a3030;
  background: #0e1319;
  color: #e6ecf2;
  font-size: 12px;
}
.deny-reason input::placeholder {
  color: #6b7684;
}
.permission-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.permission-actions button {
  flex: 1;
  padding: 7px;
  border-radius: 7px;
  border: none;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.approve {
  background: #2a6db0;
  color: #eef5fb;
}
.deny {
  background: #5c2b2b;
  color: #f0c9c4;
}
</style>
