<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
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
  /**
   * Somebody else's public run (DRY-27): the scrollback streams, the keyboard
   * does not.
   *
   * The daemon enforces this — it drops input frames from anyone but the owner
   * — so this prop is not the security boundary, it is the honesty. Without it
   * the terminal accepts keystrokes, sends them, and nothing happens, which is
   * indistinguishable from a wedged agent.
   */
  readOnly?: boolean;
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

// DRY-71: the terminal's clipboard keys.
//
// Off macOS — where Cmd+C/Cmd+V fall through untouched, since xterm's ctrl
// branch requires `!ev.metaKey` — the only copy keystroke a pane had was
// Ctrl+Insert. Ctrl+Shift+C reached no handler at all: Chromium's
// editing-command table has no entry for it (Ctrl+Insert is the Windows/Linux
// copy accelerator), so no `copy` event was ever generated for the browser's
// own listeners, xterm's included, to answer.
//
// Ctrl+C stays SIGINT and Ctrl+V stays SYN. Both are what a Linux terminal
// does, and the interrupt in particular is worth more than a copy shortcut: on
// a desk full of agents, a stale selection quietly turning an interrupt into a
// copy is a bad trade for a selection that is easy to leave behind.
//
// `navigator.clipboard` is not the way out. It needs a secure context and is
// simply absent on `http://<host>:5321`, which is how prod is served
// (docs/deploy.md). A fix written against it works on a dev box at localhost
// and silently does nothing where this actually runs.
const COPY_KEY = { key: "c", code: "KeyC" };
const PASTE_KEY = { key: "v", code: "KeyV" };

/** Layout-tolerant: the letter you typed, or failing that the key you pressed. */
function pressed(ev: KeyboardEvent, k: { key: string; code: string }): boolean {
  return ev.key.toLowerCase() === k.key || ev.code === k.code;
}

function attachClipboardKeys(t: Terminal): void {
  t.attachCustomKeyEventHandler((ev) => {
    // keydown only. The handler also runs for keypress and keyup, and `_keyUp`
    // reads a false as "don't refocus" — so answering every phase would copy
    // three times over and leave the terminal blurred afterwards.
    if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) {
      return true;
    }
    if (pressed(ev, COPY_KEY)) {
      // Claimed whether or not anything is selected: while the keyboard is in a
      // terminal this key means copy, and passing it on for an empty selection
      // would hand a gesture aimed at the pane to the browser, where it is
      // Chrome's inspect-element accelerator.
      ev.preventDefault();
      // `execCommand` dispatches a real `copy` event at the focused element —
      // xterm's helper textarea — and xterm's own listener answers it by
      // putting the selection in `clipboardData`. That is the whole mechanism,
      // and it is deliberately the same listener the right-click menu's Copy
      // reaches, so the two gestures cannot drift apart.
      //
      // It survives having no DOM selection to copy, which is the case that
      // matters and the one a Linux dev box hides: xterm mirrors a MOUSE
      // selection into that textarea for X11's PRIMARY selection, guarded by
      // `Browser.isLinux`, so on Linux a real selection is always lying about
      // and on Windows there is none. Measured on Chromium and Firefox with
      // `navigator.platform` forced to Win32 — `queryCommandEnabled("copy")`
      // goes false, the event fires anyway. `scripts/verify/clipboard.mts`
      // pins it, since a copy that quietly stopped working on half the
      // platforms in this ticket's title would look identical here.
      if (t.hasSelection()) document.execCommand("copy");
      return false;
    }
    // Insurance, not the fix: Ctrl+Shift+V already reaches the browser in xterm
    // 5.5.0, because the ctrl branch of its keymap requires `!shiftKey` and the
    // `ev.key && ctrlKey` fallback maps only `_` and `@` — so no key is
    // produced and `_keyDown` returns before `cancel()`. Stated here so an
    // xterm bump that starts claiming ctrl+shift+letter can't quietly take
    // paste away again, which is exactly how Ctrl+V behaves today.
    if (pressed(ev, PASTE_KEY)) return false;
    return true;
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

// DRY-57: a daemon restart no longer ends a session, so a closed socket is a
// reason to dial again rather than the end of the pane. Before this, `onclose`
// only set `connected = false` and the pane sat there dead until a full page
// reload — which made "your agent survived the restart" true of the daemon and
// invisible in the UI.
let unmounting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const attempts = ref(0);
const RECONNECT_CEILING_MS = 5_000;
/**
 * After this many failures the badge stops saying "reconnecting".
 *
 * A restart is back within one or two tries, so anything past that is a
 * different problem — a session the daemon no longer has (the upgrade is
 * refused with a 404, which the browser reports as an indistinguishable close),
 * or a shell pointed at the wrong daemon entirely. Both used to read as a pane
 * that says "reconnecting…" forever, which is the least useful thing it could
 * say while somebody debugs a port.
 */
const RECONNECT_PATIENCE = 4;

/** What the badge says. Distinguishes "wait" from "something is actually wrong". */
const disconnectedLabel = computed(() =>
  attempts.value > RECONNECT_PATIENCE ? "can't reach the daemon" : "reconnecting…",
);

function scheduleReconnect() {
  if (unmounting) return;
  attempts.value++;
  // Backoff to a 5s ceiling rather than a fixed retry: a daemon restart is back
  // in a couple of seconds, but a host that is down deserves a quiet socket
  // rather than one browser tab dialling it forever at full speed. Unbounded on
  // purpose — the parent unmounts this pane when the session stops being listed,
  // so "give up after N" would only ever abandon a session that still exists.
  const wait = Math.min(400 * 2 ** (attempts.value - 1), RECONNECT_CEILING_MS);
  reconnectTimer = setTimeout(connect, wait);
}

function connect() {
  // Asynchronous since DRY-27: the attach URL now carries a freshly minted,
  // one-minute stream credential, because a browser WebSocket cannot send a
  // header. A failure to mint one is treated exactly like a failed connection —
  // the usual cause is a token that has expired, and the shell's own 401
  // handling has already swapped the desk for the login view by the time this
  // lands, so the backoff simply keeps the pane quiet until it does.
  void attachUrl(props.session.id).then(
    (url) => {
      if (unmounting) return;
      openSocket(url);
    },
    () => {
      if (!unmounting) scheduleReconnect();
    },
  );
}

function openSocket(url: string) {
  const sock = new WebSocket(url);
  ws.value = sock;
  sock.onopen = () => {
    connected.value = true;
    attempts.value = 0;
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
  // No `onerror` handler, deliberately. The WebSocket error event carries no
  // status — the spec makes it information-free so a page can't port-scan by
  // timing handshake failures — so a 404 "unknown session", a wrong daemon port
  // and a daemon mid-restart are genuinely indistinguishable here. `onclose`
  // fires for all three, and the attempt count above is what separates "wait a
  // moment" from "something is actually wrong".
  sock.onclose = () => {
    connected.value = false;
    scheduleReconnect();
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    switch (msg.type) {
      case "replay":
        // Reset first. A replay is always the WHOLE buffer, so on a reconnect —
        // which is now an ordinary event, not a page load — writing it onto
        // what the terminal already shows prints the session's entire history a
        // second time.
        term.value?.reset();
        term.value?.write(msg.data);
        break;
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
  // Not merely "don't send": the cursor stays put and nothing echoes, so a
  // spectator's keystrokes visibly go nowhere rather than appearing to be
  // swallowed by a busy agent.
  t.onData((data) => {
    if (!props.readOnly) sendWs({ type: "input", data });
  });
  registerMdLinks(t);
  // Copy stays available to a spectator (DRY-27): reading somebody else's run
  // is the whole point of a public one. A paste is dropped by the guard above.
  attachClipboardKeys(t);
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
  // Before ws.close(), or our own teardown triggers a reconnect to a session
  // this pane is no longer showing.
  unmounting = true;
  clearTimeout(reconnectTimer);
  resizeObserver?.disconnect();
  ws.value?.close();
  term.value?.dispose();
});
</script>

<template>
  <div class="pane-body" :class="{ attention: !!pending }">
    <div ref="termEl" class="term"></div>
    <!-- "reconnecting", not "detached": since DRY-57 a dropped socket is a
         daemon that went away, not a session that ended, and the pane is
         actively dialling back. -->
    <span v-if="!connected" class="detached">{{ disconnectedLabel }}</span>

    <!-- Says whose, not just that it's read-only: "watching" alone reads as a
         mode you might be able to leave (DRY-27). -->
    <span v-else-if="readOnly" class="watching">
      watching {{ session.ownerName || "another account" }}'s run — read only
    </span>

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
/* Same corner as .detached — they can't both be showing (DRY-27) — but blue
   rather than amber: this is a state you chose, not a fault. */
.watching {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: 10px;
  color: #9dc0e0;
  background: #16222e;
  border: 1px solid #2a445d;
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
