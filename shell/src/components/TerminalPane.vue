<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachUrl } from "../lib/daemon.js";
import type { ClientMessage, ServerMessage, SessionInfo } from "../lib/protocol.js";

const props = defineProps<{ session: SessionInfo }>();
const emit = defineEmits<{ (e: "kill", id: string): void }>();

const termEl = ref<HTMLDivElement | null>(null);
const term = shallowRef<Terminal | null>(null);
const fit = shallowRef<FitAddon | null>(null);
const ws = shallowRef<WebSocket | null>(null);
let resizeObserver: ResizeObserver | null = null;

const status = ref<SessionInfo["status"]>(props.session.status);
const connected = ref(false);
const minimized = ref(false);
const pending = ref<{ requestId: string; tool: string; input: unknown } | null>(null);

function sendWs(msg: ClientMessage) {
  const sock = ws.value;
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function doFit() {
  if (minimized.value || !fit.value || !term.value) return;
  try {
    fit.value.fit();
    sendWs({ type: "resize", cols: term.value.cols, rows: term.value.rows });
  } catch {
    /* element not measurable yet */
  }
}

function connect() {
  const sock = new WebSocket(attachUrl(props.session.id));
  ws.value = sock;
  sock.onopen = () => {
    connected.value = true;
    doFit();
  };
  sock.onclose = () => {
    connected.value = false;
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    switch (msg.type) {
      case "replay":
      case "data":
        term.value?.write(msg.data);
        break;
      case "status":
        status.value = msg.status;
        break;
      case "permission-request":
        pending.value = { requestId: msg.requestId, tool: msg.tool, input: msg.input };
        break;
      case "permission-resolved":
        if (pending.value?.requestId === msg.requestId) pending.value = null;
        break;
    }
  };
}

function resolve(decision: "allow" | "deny") {
  if (!pending.value) return;
  sendWs({ type: "permission", requestId: pending.value.requestId, decision });
  pending.value = null;
}

function toggleMinimize() {
  minimized.value = !minimized.value;
  if (!minimized.value) requestAnimationFrame(doFit);
}

onMounted(() => {
  const t = new Terminal({
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: "#0b0e14", foreground: "#c5c8c6" },
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.open(termEl.value!);
  t.onData((data) => sendWs({ type: "input", data }));
  term.value = t;
  fit.value = f;

  resizeObserver = new ResizeObserver(() => doFit());
  resizeObserver.observe(termEl.value!);

  connect();
  requestAnimationFrame(doFit);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  ws.value?.close();
  term.value?.dispose();
});
</script>

<template>
  <section
    class="pane"
    :class="{ minimized, attention: !!pending, exited: status === 'exited' }"
  >
    <header class="pane-bar">
      <span class="dot" :class="status" :title="status"></span>
      <span class="title">{{ session.title }}</span>
      <span class="meta">{{ session.command }}</span>
      <span class="spacer"></span>
      <span v-if="!connected" class="badge detached">detached</span>
      <button class="icon" title="Minimize (keeps running)" @click="toggleMinimize">
        {{ minimized ? "▢" : "—" }}
      </button>
      <button class="icon kill" title="Kill session" @click="emit('kill', session.id)">
        ✕
      </button>
    </header>

    <div v-show="!minimized" class="pane-body">
      <div ref="termEl" class="term"></div>

      <div v-if="pending" class="permission">
        <div class="permission-text">
          <strong>Permission needed</strong>
          <code>{{ pending.tool }}</code>
          <pre>{{ JSON.stringify(pending.input, null, 2) }}</pre>
        </div>
        <div class="permission-actions">
          <button class="approve" @click="resolve('allow')">Approve</button>
          <button class="deny" @click="resolve('deny')">Deny</button>
        </div>
      </div>
    </div>
  </section>
</template>
