<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachUrl } from "../lib/daemon.js";
import { claimPane, releasePane } from "../composables/gateStore.js";
import PermissionPrompt from "./PermissionPrompt.vue";
import type { ClientMessage, ServerMessage, SessionInfo } from "../lib/protocol.js";

// Body-only terminal: the live xterm view bound to one durable daemon session,
// plus the in-place approval overlay. Window chrome (title bar, drag, minimize,
// close) lives in WindowFrame. Status/attention bubble up so the frame dot and
// the dock can reflect live session state without re-polling.
const props = defineProps<{
  session: SessionInfo;
  active?: boolean;
  hidden?: boolean; // collapsed in the dock — skip fit work
  initialInput?: string; // typed once on first connect (spawn-on-ticket context)
}>();
const emit = defineEmits<{
  (e: "status", id: string, status: SessionInfo["status"]): void;
  (e: "attention", id: string, pending: boolean): void;
  (e: "idle", id: string, idle: boolean): void; // agent yielded its turn ("your turn")
  (e: "initial-sent", id: string): void; // seed typed once; parent clears it so re-mounts don't retype
  (e: "open-file", id: string, path: string): void; // Ctrl/Cmd-clicked a file token (DRY-35 doc viewer)
}>();

// File-ish tokens ending .md/.markdown become links (DRY-35). Custom provider
// because xterm's WebLinksAddon only matches URLs. Matches within one buffer
// line — a long path wrapped across lines loses its tail, acceptable for v1.
const MD_TOKEN = /(?:~\/|\.{0,2}\/)?[\w@%+=,.-]+(?:\/[\w@%+=,.-]+)*\.(?:md|markdown)\b/g;

function registerMdLinks(t: Terminal): void {
  t.registerLinkProvider({
    provideLinks(y, cb) {
      const line = t.buffer.active.getLine(y - 1);
      if (!line) return cb(undefined);
      const text = line.translateToString(true);
      const links: ILink[] = [];
      for (const m of text.matchAll(MD_TOKEN)) {
        links.push({
          // xterm link ranges are 1-based and end-inclusive.
          range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
          text: m[0],
          activate: (ev, token) => {
            // Modifier-gated so plain clicks keep doing selection; the terminal
            // itself is full of dots-and-slashes text you don't want hijacked.
            if (ev.ctrlKey || ev.metaKey) emit("open-file", props.session.id, token);
          },
        });
      }
      cb(links.length ? links : undefined);
    },
  });
}

const termEl = ref<HTMLDivElement | null>(null);
const term = shallowRef<Terminal | null>(null);
const fit = shallowRef<FitAddon | null>(null);
const ws = shallowRef<WebSocket | null>(null);
let resizeObserver: ResizeObserver | null = null;
let sentInitial = false;

const connected = ref(false);
const pending = ref<{ requestId: string; tool: string; input: unknown } | null>(null);

// Claimed for the life of this pane. While it's mounted this session's gates
// render here, so the shell-wide tray must not also show them; once it goes,
// the tray is the only surface left (DRY-50). Claimed at setup rather than in
// onMounted, which awaits font loading first — a gate arriving in that gap
// would otherwise belong to neither surface.
claimPane(props.session.id);

// DRY-41: a dead PTY's pane is otherwise a frozen frame of whatever the CLI
// last drew (often claude's slash menu after /exit) — indistinguishable from a
// live-but-quiet session. The daemon keeps exited sessions listed, so the
// window survives (a workspace's zsh may still be running); this banner is the
// in-pane truth. Seeded from the poll's SessionInfo so a re-mount (dock
// restore, reload) shows it before the WS status replay lands.
const exited = ref(props.session.status === "exited");
const exitCode = ref<number | null>(props.session.exitCode ?? null);

function markExited(code?: number) {
  exited.value = true;
  if (code !== undefined) exitCode.value = code;
  // A blinking cursor on a dead PTY is what made /exit read as "stalled".
  if (term.value) term.value.options.cursorBlink = false;
}

// The WS broadcast covers an attached pane; the 3s poll (session prop) covers
// one whose exit happened while it wasn't listening (detached / just restored).
watch(
  () => props.session.status,
  (s) => {
    if (s === "exited") markExited(props.session.exitCode ?? undefined);
  },
);

function sendWs(msg: ClientMessage) {
  const sock = ws.value;
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
}

function doFit() {
  if (props.hidden || !fit.value || !term.value) return;
  try {
    fit.value.fit();
    sendWs({ type: "resize", cols: term.value.cols, rows: term.value.rows });
  } catch {
    /* element not measurable yet */
  }
}

// Exposed so the parent can refit after a layout change moves/resizes us.
defineExpose({ refit: () => requestAnimationFrame(doFit) });

function connect() {
  const sock = new WebSocket(attachUrl(props.session.id));
  ws.value = sock;
  sock.onopen = () => {
    connected.value = true;
    doFit();
    if (!sentInitial && props.initialInput) {
      sentInitial = true;
      const text = props.initialInput;
      // Tell the parent to drop the seed so a later re-mount (restore from dock,
      // poll re-add) doesn't retype it. `text` is already captured locally.
      emit("initial-sent", props.session.id);
      // A multi-line ticket seed is sent as a bracketed paste (ESC[200~ … ESC[201~)
      // so the CLI drops it into the prompt as one block instead of submitting
      // each line. No trailing CR — we pre-fill, never auto-submit. Give the
      // wrapped CLI a beat to draw its prompt (and enable paste mode) first.
      const data = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
      setTimeout(() => sendWs({ type: "input", data }), 700);
    }
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
        if (msg.status === "exited") markExited(msg.exitCode);
        emit("status", props.session.id, msg.status);
        break;
      case "idle":
        emit("idle", props.session.id, msg.idle);
        break;
      case "permission-request":
        pending.value = { requestId: msg.requestId, tool: msg.tool, input: msg.input };
        emit("attention", props.session.id, true);
        break;
      case "permission-resolved":
        if (pending.value?.requestId === msg.requestId) {
          pending.value = null;
          emit("attention", props.session.id, false);
        }
        break;
    }
  };
}

function resolve(decision: "allow" | "deny", reason?: string) {
  if (!pending.value) return;
  sendWs({ type: "permission", requestId: pending.value.requestId, decision, reason });
  pending.value = null;
  emit("attention", props.session.id, false);
}

onMounted(async () => {
  // Load the Nerd Font before xterm measures glyph metrics — otherwise the
  // prompt's powerline/icon glyphs render with fallback metrics and stay
  // misaligned until a later refit. Best-effort: if the font is unavailable
  // (e.g. offline), fall through to the mono stack below.
  try {
    await Promise.all([
      document.fonts.load('12.5px "MesloLGS NF"'),
      document.fonts.load('bold 12.5px "MesloLGS NF"'),
    ]);
  } catch {
    /* font not loadable — mono fallback still renders text, just no glyphs */
  }
  if (!termEl.value) return; // unmounted while awaiting fonts

  const t = new Terminal({
    fontFamily: "'MesloLGS NF', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace",
    fontSize: 12.5,
    cursorBlink: true,
    scrollback: 10_000,
    theme: { background: "#0b0e12", foreground: "#c3ccd6", cursor: "#7aa6cc" },
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.open(termEl.value!);
  t.onData((data) => sendWs({ type: "input", data }));
  registerMdLinks(t);
  term.value = t;
  fit.value = f;

  // DRY-40: xterm never takes keyboard focus on its own, so after a header
  // spawn the clicked button kept focus and the user's Enter (aimed at the new
  // CLI's trust prompt) re-clicked it, spawning a duplicate. A pane that mounts
  // as the focused window claims the keyboard immediately.
  if (props.active) t.focus();
  if (exited.value) t.options.cursorBlink = false; // mounted onto a dead session

  resizeObserver = new ResizeObserver(() => doFit());
  resizeObserver.observe(termEl.value!);

  connect();
  requestAnimationFrame(doFit);
});

onBeforeUnmount(() => {
  // Release before the socket closes: from here on this session's gates have
  // nowhere to render but the tray (DRY-50).
  releasePane(props.session.id);
  resizeObserver?.disconnect();
  ws.value?.close();
  term.value?.dispose();
});
</script>

<template>
  <div class="pane-body" :class="{ attention: !!pending }">
    <div ref="termEl" class="term"></div>
    <span v-if="!connected" class="detached">detached</span>

    <!-- DRY-41: dead PTY — the scrollback above is a frozen transcript. -->
    <div v-if="exited" class="exited">
      <span class="exited-dot"></span>
      <strong>{{ session.command }}</strong> exited{{ exitCode !== null ? ` (code ${exitCode})` : "" }}
      <span class="exited-hint">output preserved — close the window when done</span>
    </div>

    <!-- Same component the out-of-pane tray uses (DRY-50); the pane keeps its
         own placement and answers over its own socket. -->
    <!-- Keyed by requestId: a second gate can replace `pending` without it ever
         going null, so without this the same instance is reused and any
         half-entered state carries over to a decision about a different tool. -->
    <PermissionPrompt
      v-if="pending"
      :key="pending.requestId"
      class="permission-host"
      :tool="pending.tool"
      :input="pending.input"
      @resolve="resolve"
    />
  </div>
</template>

<style scoped>
.pane-body {
  position: relative;
  height: 100%;
  min-height: 0;
  background: #0b0e12;
}
.term {
  position: absolute;
  inset: 0;
  padding: 6px 8px;
}
.detached {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  color: #d6a651;
  background: #2a2114;
  border: 1px solid #4a3a1c;
  padding: 1px 6px;
  border-radius: 5px;
  font-family: "JetBrains Mono", monospace;
  z-index: 4;
}
.exited {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #14181ef2;
  border: 1px solid #3a4655;
  border-radius: 10px;
  padding: 8px 13px;
  color: #9aa6b2;
  font-size: 12px;
  z-index: 5;
}
.exited strong {
  color: #c3ccd6;
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
}
.exited-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6a737f;
  flex: 0 0 auto;
}
.exited-hint {
  margin-left: auto;
  font-size: 10.5px;
  color: #5a636f;
}
/* Placement only — the prompt's own styling moved with it into
   PermissionPrompt.vue. These are the values it had inline before (DRY-50). */
.permission-host {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  z-index: 6;
}
</style>
