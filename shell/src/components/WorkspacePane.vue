<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import TerminalPane from "./TerminalPane.vue";
import { renderMarkdown } from "../lib/markdown.js";
import { getTicket, type TicketDetail } from "../lib/tracker.js";
import type { Win } from "../composables/useWindowManager.js";
import type { SessionInfo } from "../lib/protocol.js";

// Composite workspace body (DRY-21): one managed window that binds a ticket +
// two daemon PTYs — the agent (claude) on top and a co-located zsh shell on the
// bottom — with a pull-down ticket drawer. Rendered inside WindowFrame, so it
// still gets the frame's focus/z/drag/minimize. Both terminals reuse the
// body-only TerminalPane; the daemon owns each PTY independently.
//
// Layout: a slim drawer bar (only when a ticket is bound) sits above a panes
// region split vertically into agent (flex) / splitter / shell. The drawer
// itself *overlays* the top of the panes region when pulled down, so toggling
// it never resizes the PTYs underneath (no reflow churn). The split ratio and
// the drawer/shell collapse state live on the Win and persist via layoutStore.
const props = defineProps<{
  win: Win;
  agentSession: SessionInfo;
  shellSession?: SessionInfo;
  active?: boolean;
  initialInput?: string;
}>();

const emit = defineEmits<{
  // Agent-pane status bubbles up exactly like a plain terminal, so the frame
  // dot / dock reflect the agent's live state (the shell pane isn't tracked).
  (e: "status", id: string, status: SessionInfo["status"]): void;
  (e: "attention", id: string, pending: boolean): void;
  (e: "idle", id: string, idle: boolean): void;
  (e: "initial-sent", id: string): void;
  // Persist workspace UI state back onto the Win (App → wm.updateWin).
  (e: "patch", id: string, patch: Partial<Win>): void;
  // Ctrl/Cmd-clicked file token in either pane → App's doc viewer (DRY-35).
  (e: "open-file", id: string, path: string): void;
}>();

// Local UI state seeded from the persisted Win. These are authoritative for the
// pane (the Win isn't mutated elsewhere); each change emits a patch to persist.
const drawerOpen = ref(props.win.drawerOpen ?? false);
const shellCollapsed = ref(props.win.shellCollapsed ?? false);
const ratio = ref(clampRatio(props.win.shellRatio ?? 0.2));

function clampRatio(r: number): number {
  return Math.min(0.8, Math.max(0.1, r));
}

function toggleDrawer(): void {
  drawerOpen.value = !drawerOpen.value;
  emit("patch", props.win.id, { drawerOpen: drawerOpen.value });
}
function toggleShell(): void {
  shellCollapsed.value = !shellCollapsed.value;
  emit("patch", props.win.id, { shellCollapsed: shellCollapsed.value });
}

// --- ticket drawer content (lazy: fetch the body only once the ticket is set) ---
const detail = ref<TicketDetail | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

watch(
  () => props.win.ticket,
  async (key) => {
    detail.value = null;
    loadError.value = null;
    if (!key) return;
    loading.value = true;
    try {
      detail.value = await getTicket(key);
    } catch (e) {
      loadError.value = String(e);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

// --- draggable splitter (agent / shell height ratio) ---
const panesEl = ref<HTMLDivElement | null>(null);
let split: { h: number; top: number } | null = null;

function startSplit(e: MouseEvent): void {
  const el = panesEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  split = { h: r.height, top: r.top };
  window.addEventListener("mousemove", onSplitMove);
  window.addEventListener("mouseup", onSplitUp);
  e.preventDefault();
}
function onSplitMove(e: MouseEvent): void {
  if (!split || split.h <= 0) return;
  // Shell occupies the region below the cursor.
  ratio.value = clampRatio((split.top + split.h - e.clientY) / split.h);
}
function onSplitUp(): void {
  if (!split) return;
  split = null;
  window.removeEventListener("mousemove", onSplitMove);
  window.removeEventListener("mouseup", onSplitUp);
  emit("patch", props.win.id, { shellRatio: ratio.value });
}
onBeforeUnmount(onSplitUp);
</script>

<template>
  <div class="ws">
    <!-- Pull-down ticket drawer bar (only when a ticket is bound) -->
    <button v-if="win.ticket" class="drawerbar" @click="toggleDrawer">
      <span class="chev" :class="{ open: drawerOpen }">▸</span>
      <span class="dkey">{{ win.ticket }}</span>
      <span class="dtitle">{{ detail?.title ?? "ticket" }}</span>
      <span class="grow"></span>
      <span class="dhint">{{ drawerOpen ? "hide" : "review ticket" }}</span>
    </button>

    <div ref="panesEl" class="panes">
      <!-- Drawer content overlays the top of the panes; doesn't resize the PTYs -->
      <transition name="drawer">
        <div v-if="win.ticket && drawerOpen" class="drawer">
          <p v-if="loading" class="muted">Loading ticket…</p>
          <p v-else-if="loadError" class="muted err">Couldn't load ticket: {{ loadError }}</p>
          <template v-else-if="detail">
            <div class="dmeta">
              <span class="mkey">{{ detail.key }}</span>
              <span class="mstatus">{{ detail.status.label }}</span>
              <span class="mrepo">{{ detail.repo }}</span>
            </div>
            <h3 class="dh">{{ detail.title }}</h3>
            <!-- Rendered + sanitized (DRY-35); shared pipeline with the doc viewer. -->
            <div class="dbody mdbody" v-html="renderMarkdown(detail.description)"></div>
          </template>
        </div>
      </transition>

      <!-- Agent PTY (primary surface, ~80%) -->
      <div class="agent">
        <TerminalPane
          :session="agentSession"
          :active="active"
          :initial-input="initialInput"
          @status="(id, s) => emit('status', id, s)"
          @attention="(id, p) => emit('attention', id, p)"
          @idle="(id, i) => emit('idle', id, i)"
          @initial-sent="(id) => emit('initial-sent', id)"
          @open-file="(id, p) => emit('open-file', id, p)"
        />
      </div>

      <!-- Shell PTY (co-located zsh, ~20%, independently collapsible) -->
      <template v-if="!shellCollapsed">
        <div class="splitter" @mousedown="startSplit"><span class="grip"></span></div>
        <div class="shell" :style="{ flexBasis: `${ratio * 100}%` }">
          <div class="shellhead">
            <span class="sdot"></span>
            <span class="slabel">shell</span>
            <span class="grow"></span>
            <button class="scollapse" title="Collapse shell" @click="toggleShell">▾</button>
          </div>
          <div class="sbody">
            <TerminalPane
              v-if="shellSession"
              :session="shellSession"
              :active="active"
              @open-file="(id, p) => emit('open-file', id, p)"
            />
            <p v-else class="muted starting">starting shell…</p>
          </div>
        </div>
      </template>
      <button v-else class="shellbar" title="Show shell" @click="toggleShell">
        <span class="chev">▸</span> shell
      </button>
    </div>
  </div>
</template>

<style scoped>
.ws {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #0b0e12;
}
.grow {
  flex: 1;
}
/* --- drawer bar + overlay --- */
.drawerbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 10px;
  background: #10243a;
  border: none;
  border-bottom: 1px solid #234a6e55;
  color: #9cc6ec;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.drawerbar:hover {
  background: #123253;
}
.chev {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.18s ease;
  color: #5b9bd5;
}
.chev.open {
  transform: rotate(90deg);
}
.dkey {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  color: #5b9bd5;
}
.dtitle {
  font-size: 11.5px;
  color: #aeb8c4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.dhint {
  font-size: 10px;
  color: #5a7690;
}
.panes {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.drawer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  max-height: 55%;
  overflow-y: auto;
  z-index: 8;
  background: #0e131aef;
  border-bottom: 1px solid #2a3744;
  box-shadow: 0 14px 30px #000000aa;
  padding: 11px 13px;
}
.dmeta {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 6px;
}
.mkey {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  color: #5b9bd5;
}
.mstatus {
  font-size: 10.5px;
  color: #6b7682;
}
.mrepo {
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: #5a636f;
}
.dh {
  margin: 0 0 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: #e6ecf2;
  line-height: 1.3;
}
.dbody {
  margin: 0;
  font-size: 12px;
  color: #aeb8c4;
  word-break: break-word;
  /* Typography comes from the shared .mdbody rules (style.css, DRY-35). */
}
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
/* --- agent / shell split --- */
.agent {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}
.splitter {
  flex: 0 0 auto;
  height: 6px;
  cursor: ns-resize;
  background: #11151a;
  border-top: 1px solid #ffffff0d;
  display: flex;
  align-items: center;
  justify-content: center;
}
.splitter:hover {
  background: #1a2432;
}
.grip {
  width: 34px;
  height: 2px;
  border-radius: 2px;
  background: #3a4655;
}
.shell {
  flex: 0 0 20%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid #ffffff0d;
}
.shellhead {
  flex: 0 0 auto;
  height: 22px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px 0 10px;
  background: #0e1218;
}
.sdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7a9e6b;
  flex: 0 0 auto;
}
.slabel {
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: #8a94a0;
}
.scollapse {
  background: none;
  border: none;
  color: #7a8593;
  cursor: pointer;
  font-size: 11px;
  padding: 0 4px;
}
.scollapse:hover {
  color: #cfd8e2;
}
.sbody {
  flex: 1;
  min-height: 0;
  position: relative;
}
.shellbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  background: #0e1218;
  border: none;
  border-top: 1px solid #ffffff0d;
  color: #8a94a0;
  cursor: pointer;
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  text-align: left;
}
.shellbar:hover {
  background: #141a22;
}
.muted {
  margin: 0;
  font-size: 12px;
  color: #6b7682;
}
.muted.err {
  color: #d6a651;
}
.starting {
  padding: 8px 10px;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
}
</style>
