<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { sessionFile } from "../lib/daemon.js";
import { renderMarkdown } from "../lib/markdown.js";

// Floating markdown viewer (DRY-35): opened by Ctrl/Cmd-clicking a file token
// in a terminal. Same float chrome as TicketDetail (DRY-20) — draggable,
// raiseable via the parent-allocated z, non-modal. Content is fetched through
// the daemon relative to the ORIGIN SESSION's cwd (the daemon confines the
// read to that subtree), and relative .md links inside a doc navigate within
// this same window.
const props = defineProps<{ sessionId: string; path: string; z: number }>();
const emit = defineEmits<{ (e: "focus"): void; (e: "close"): void }>();

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

const winStyle = computed(() => {
  const base = { zIndex: String(props.z) };
  return pos.value
    ? { ...base, left: `${pos.value.x}px`, top: `${pos.value.y}px`, transform: "none" }
    : base;
});

// `current` starts at the clicked token and moves as in-doc links are followed;
// after the first load it's the daemon's RESOLVED absolute path, so relative
// navigation is anchored at the real file, not the clicked text.
const current = ref(props.path);
const html = ref("");
const loading = ref(true);
const loadError = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const r = await sessionFile(props.sessionId, current.value);
    current.value = r.path;
    html.value = renderMarkdown(r.content);
  } catch (e) {
    loadError.value = String(e instanceof Error ? e.message : e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.sessionId, props.path] as const,
  () => {
    current.value = props.path;
    pos.value = null; // re-center on a freshly clicked doc
    void load();
  },
  { immediate: true },
);

const title = computed(() => current.value.split("/").filter(Boolean).pop() ?? current.value);

/** Posix-only dirname/normalize — daemon paths are the daemon host's. */
function resolveSibling(from: string, href: string): string {
  const base = from.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return (from.startsWith("/") ? "/" : "") + base.join("/");
}

// One delegated handler: markdown-internal .md links navigate this window
// (still daemon-confined); external http(s) links got target=_blank in the
// sanitizer; anything else is inert.
function onBodyClick(e: MouseEvent): void {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  const href = a.getAttribute("href") ?? "";
  if (/^https?:/i.test(href)) return; // sanitizer set target/rel; let it through
  e.preventDefault();
  if (/\.(md|markdown|txt)$/i.test(href)) {
    current.value = href.startsWith("/") ? href : resolveSibling(current.value, href);
    void load();
  }
}
</script>

<template>
  <div ref="panelEl" class="panel" :style="winStyle" @mousedown="emit('focus')">
    <header class="phead" @mousedown="onHeaderDown">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5b9bd5" stroke-width="1.4">
        <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
        <path d="M10 2v3h3" />
      </svg>
      <span class="fname" :title="current">{{ title }}</span>
      <span class="grow"></span>
      <button
        class="refresh"
        title="Reload from disk (agents rewrite files mid-session)"
        :disabled="loading"
        @mousedown.stop
        @click="load"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2v3.2H10.3" />
        </svg>
      </button>
      <button class="x" title="Close" @mousedown.stop @click="emit('close')">✕</button>
    </header>

    <div class="doc">
      <p v-if="loading" class="muted">Loading…</p>
      <p v-else-if="loadError" class="muted err">{{ loadError }}</p>
      <div v-else class="mdbody" v-html="html" @click="onBodyClick"></div>
    </div>
    <footer class="pfoot" :title="current">{{ current }}</footer>
  </div>
</template>

<style scoped>
/* Float chrome mirrors TicketDetail (DRY-20): absolute, stacked by inline z,
   CSS-centered until first drag, non-modal. */
.panel {
  position: absolute;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  width: min(640px, calc(100vw - 340px));
  max-height: calc(100% - 90px);
  display: flex;
  flex-direction: column;
  background: #0e1217;
  border: 1px solid #263140;
  border-radius: 12px;
  box-shadow: 0 18px 50px #000000bb;
  animation: winpop 0.14s ease;
}
.phead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid #ffffff0a;
  cursor: grab;
  user-select: none;
}
.fname {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  font-weight: 600;
  color: #9cc6ec;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow {
  flex: 1;
}
.refresh,
.x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 5px;
  color: #6b7682;
  cursor: pointer;
}
.refresh:hover:not(:disabled),
.x:hover {
  background: #141a21;
  color: #c3ccd6;
}
.doc {
  flex: 1;
  min-height: 60px;
  overflow-y: auto;
  padding: 12px 16px;
}
.muted {
  font-size: 12px;
  color: #5a636f;
}
.err {
  color: #d57a6e;
}
.pfoot {
  padding: 5px 12px;
  border-top: 1px solid #ffffff0a;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #4f5965;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
