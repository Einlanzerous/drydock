<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  CATEGORY_COLOR,
  getTicket,
  tagColor,
  type Ticket,
  type TicketDetail,
} from "../lib/tracker.js";
import { resolveRepoCwd } from "../lib/daemon.js";

// Ticket detail panel (DRY-9 ticket-spawn). Opened when a ticket is picked from
// the sidebar or Ctrl+K palette: shows the full description for *you* to read,
// then "Send to agent" spawns claude in the chosen working dir. The ticket body
// is delivered to the agent as context via the SessionStart hook (not typed in),
// so the editable prompt here is just your instruction. The working dir is
// pre-resolved from the ticket's repo and editable — projects with no repo
// (e.g. an ideas board) resolve to $HOME, which you can override here.
// DRY-20: this is a floating, draggable window rather than a modal — it stacks
// against the terminals via `z` (owned by the parent's window manager) and no
// longer dismisses on outside click, so you can work other windows with it open.
const props = defineProps<{ ticket: Ticket; z: number }>();
const emit = defineEmits<{
  (e: "send", payload: { ticket: Ticket; prompt: string; cwd: string }): void;
  (e: "focus"): void;
  (e: "close"): void;
}>();

// Float position. `null` means "not dragged yet" → CSS centers it near the top;
// the first drag pins it to explicit pixels. Reset whenever the ticket changes.
const panelEl = ref<HTMLElement | null>(null);
const pos = ref<{ x: number; y: number } | null>(null);
let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;

function onHeaderDown(e: MouseEvent): void {
  emit("focus");
  const el = panelEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  pos.value = { x: r.left, y: r.top };
  drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);
  e.preventDefault();
}
function onDragMove(e: MouseEvent): void {
  if (!drag) return;
  pos.value = {
    x: Math.max(0, drag.ox + (e.clientX - drag.sx)),
    y: Math.max(0, drag.oy + (e.clientY - drag.sy)),
  };
}
function onDragUp(): void {
  drag = null;
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
}
onBeforeUnmount(onDragUp);

const detail = ref<TicketDetail | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const prompt = ref("");
const cwd = ref("");
const cwdMatched = ref(true);

function defaultPrompt(t: Ticket): string {
  return `Work ticket ${t.key}. Its full description is attached as context — implement it.`;
}

watch(
  () => props.ticket,
  async (t) => {
    detail.value = null;
    loading.value = true;
    loadError.value = null;
    prompt.value = defaultPrompt(t);
    cwd.value = "";
    cwdMatched.value = true;
    pos.value = null; // re-center each freshly opened ticket
    // Resolve the spawn cwd in parallel with the description fetch.
    resolveRepoCwd(t.repo)
      .then((r) => {
        cwd.value = r.cwd;
        cwdMatched.value = r.matched;
      })
      .catch(() => {});
    try {
      detail.value = await getTicket(t.key);
    } catch (e) {
      loadError.value = String(e);
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

const winStyle = computed(() => {
  const base = { zIndex: String(props.z) };
  return pos.value
    ? { ...base, left: `${pos.value.x}px`, top: `${pos.value.y}px`, transform: "none" }
    : base; // fall back to the CSS-centered default position
});

function send(): void {
  if (!prompt.value.trim() || !cwd.value.trim()) return;
  emit("send", { ticket: props.ticket, prompt: prompt.value, cwd: cwd.value.trim() });
}
</script>

<template>
  <div ref="panelEl" class="panel" :style="winStyle" @mousedown="emit('focus')">
    <header class="phead" @mousedown="onHeaderDown">
      <span
        class="status"
        :style="{
          background: CATEGORY_COLOR[ticket.status.category].c,
          boxShadow: `0 0 6px ${CATEGORY_COLOR[ticket.status.category].g}`,
        }"
      ></span>
      <span class="key">{{ ticket.key }}</span>
      <span class="slabel">{{ ticket.status.label }}</span>
      <span class="repo">{{ ticket.repo }}</span>
      <span class="grow"></span>
      <button class="x" title="Close" @mousedown.stop @click="emit('close')">✕</button>
    </header>

    <h2 class="title">{{ ticket.title }}</h2>
    <div class="tagrow" v-if="ticket.tag">
      <span class="tag-dot" :style="{ background: tagColor(ticket.tag) }"></span>
      <span class="tag">{{ ticket.tag }}</span>
    </div>

    <div class="desc ddscroll">
      <p v-if="loading" class="muted">Loading ticket…</p>
      <p v-else-if="loadError" class="muted err">Couldn't load description: {{ loadError }}</p>
      <pre v-else>{{ detail?.description }}</pre>
    </div>

    <label class="plabel">Working directory</label>
    <input v-model="cwd" class="cwd" :class="{ warn: !cwdMatched }" spellcheck="false" />
    <p v-if="!cwdMatched" class="cwd-note">
      No repo set for <strong>{{ ticket.repo }}</strong> — defaulting to your home dir. Set where the agent should run.
    </p>

    <label class="plabel">Your prompt to the agent</label>
    <textarea
      v-model="prompt"
      class="prompt"
      rows="2"
      spellcheck="false"
      @keydown.meta.enter="send"
      @keydown.ctrl.enter="send"
    ></textarea>

    <div class="actions">
      <span class="hint">The ticket body is attached as context via the SessionStart hook.</span>
      <span class="grow"></span>
      <button class="cancel" @click="emit('close')">Cancel</button>
      <button class="send" :disabled="!prompt.trim() || !cwd.trim()" @click="send">Send to agent</button>
    </div>
  </div>
</template>

<style scoped>
/* Floating window (DRY-20): positioned absolutely within the app, stacked via
   the inline z-index. The default (undragged) position centers it near the top;
   a drag switches to explicit left/top. No backdrop — it's non-modal. */
.panel {
  position: absolute;
  left: 50%;
  top: 56px;
  transform: translateX(-50%);
  width: min(620px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: #11151a;
  border: 1px solid #2a3744;
  border-radius: 12px;
  box-shadow: 0 24px 60px #000000bb;
  padding: 16px 18px;
}
.phead {
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: grab;
  user-select: none;
}
.status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.key {
  font-family: "JetBrains Mono", monospace;
  font-size: 13px;
  font-weight: 600;
  color: #5b9bd5;
}
.slabel {
  font-size: 11px;
  color: #6b7682;
}
.repo {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #5a636f;
}
.grow {
  flex: 1;
}
.x {
  background: none;
  border: none;
  color: #6b7682;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.x:hover {
  background: #1b2531;
  color: #c3ccd6;
}
.title {
  margin: 12px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: #e6ecf2;
  line-height: 1.3;
}
.tagrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}
.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
}
.tag {
  font-size: 10.5px;
  color: #5a636f;
}
.desc {
  margin: 12px 0;
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  background: #0b0e12;
  border: 1px solid #ffffff0d;
  border-radius: 8px;
  padding: 10px 12px;
}
.desc pre {
  margin: 0;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #aeb8c4;
  white-space: pre-wrap;
  word-break: break-word;
}
.muted {
  margin: 0;
  font-size: 12.5px;
  color: #6b7682;
}
.err {
  color: #d6a651;
}
.plabel {
  font-size: 11px;
  color: #7a8696;
  margin-bottom: 5px;
}
.cwd {
  width: 100%;
  background: #0b0e12;
  border: 1px solid #2a3744;
  border-radius: 8px;
  padding: 8px 11px;
  color: #c3ccd6;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  outline: none;
  margin-bottom: 10px;
}
.cwd:focus {
  border-color: #3d6fa6;
}
.cwd.warn {
  border-color: #6b5326;
}
.cwd-note {
  margin: -4px 0 10px;
  font-size: 10.5px;
  line-height: 1.4;
  color: #d6a651;
}
.cwd-note strong {
  font-family: "JetBrains Mono", monospace;
  color: #e0b566;
}
.prompt {
  resize: vertical;
  background: #0b0e12;
  border: 1px solid #2a3744;
  border-radius: 8px;
  padding: 9px 11px;
  color: #d5dde6;
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
  line-height: 1.45;
  outline: none;
}
.prompt:focus {
  border-color: #3d6fa6;
}
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.hint {
  font-size: 10.5px;
  color: #5a636f;
}
.cancel,
.send {
  padding: 7px 14px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: none;
}
.cancel {
  background: #1b2531;
  color: #aeb8c4;
}
.send {
  background: #2a6db0;
  color: #eef5fb;
}
.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
