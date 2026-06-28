<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import TerminalPane from "./components/TerminalPane.vue";
import { createSession, killSession, listSessions } from "./lib/daemon.js";
import type { SessionInfo } from "./lib/protocol.js";

const sessions = ref<SessionInfo[]>([]);
const error = ref<string | null>(null);
const cwd = ref("");
const command = ref("claude");
let poll: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    sessions.value = await listSessions();
    error.value = null;
  } catch (e) {
    error.value = `Daemon unreachable — is it running on :4317? (${String(e)})`;
  }
}

async function spawn(cmd: string) {
  try {
    await createSession({
      command: cmd,
      cwd: cwd.value.trim() || undefined,
      title: cmd === "claude" ? "claude-code" : cmd,
    });
    await refresh();
  } catch (e) {
    error.value = String(e);
  }
}

async function onKill(id: string) {
  await killSession(id);
  await refresh();
}

onMounted(() => {
  refresh();
  // Light poll only to discover sessions created elsewhere; live content rides
  // each pane's own WebSocket.
  poll = setInterval(refresh, 4000);
});
onBeforeUnmount(() => poll && clearInterval(poll));
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1>⚓ Drydock</h1>
      <span class="tagline">watch the agents work</span>
      <span class="spacer"></span>
      <input v-model="cwd" class="cwd" placeholder="working dir (default: $HOME)" />
      <input v-model="command" class="cmd" placeholder="command" @keyup.enter="spawn(command)" />
      <button @click="spawn(command)">New</button>
      <button class="ghost" @click="spawn('claude')">+ claude</button>
      <button class="ghost" @click="spawn('bash')">+ bash</button>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <main class="grid" :class="{ empty: sessions.length === 0 }">
      <p v-if="sessions.length === 0" class="hint">
        No sessions yet. Spawn one above — it'll keep running in the daemon even if
        you close this tab.
      </p>
      <TerminalPane
        v-for="s in sessions"
        :key="s.id"
        :session="s"
        @kill="onKill"
      />
    </main>
  </div>
</template>
