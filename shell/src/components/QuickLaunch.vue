<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CATEGORY_COLOR, type Ticket } from "../lib/tracker.js";

// Ctrl+K quick-launch palette. A pinned "blank shell" row sits above the
// ticket list (DRY-39: the palette is the ONLY entry point for plain shells —
// a header button for them duplicated this pill). Fuzzy-search tickets by
// key / title / repo; ↵ activates the selected row (shell row → shell, ticket
// row → ticket panel), ⇧↵ is the shell shortcut from anywhere. Blank claude
// agents live on the header's "+ claude", not here.
const props = defineProps<{ open: boolean; tickets: Ticket[]; providerName: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "launch", t: Ticket): void;
  (e: "spawnShell"): void;
}>();

const query = ref("");
// Row index across the whole list: 0 = the pinned shell row, tickets follow at
// idx-1. Opens at 1 (first ticket) so the muscle-memory "Ctrl+K, ↵ on a
// ticket" flow is unchanged; ↑ from there reaches the shell row.
const idx = ref(1);
const inputEl = ref<HTMLInputElement | null>(null);

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.tickets;
  return props.tickets.filter(
    (t) =>
      t.key.toLowerCase().includes(q) ||
      t.title.toLowerCase().includes(q) ||
      t.repo.toLowerCase().includes(q),
  );
});

/** Selected row, clamped to what's actually rendered (shell row + matches). */
const sel = computed(() => Math.min(idx.value, matches.value.length));

watch(
  () => props.open,
  (o) => {
    if (o) {
      query.value = "";
      idx.value = props.tickets.length ? 1 : 0;
      nextTick(() => inputEl.value?.focus());
    }
  },
);
watch(query, () => (idx.value = matches.value.length ? 1 : 0));

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx.value = Math.min(sel.value + 1, matches.value.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx.value = Math.max(sel.value - 1, 0);
  } else if (e.key === "Enter" && e.shiftKey) {
    emit("spawnShell");
  } else if (e.key === "Enter") {
    if (sel.value === 0) emit("spawnShell");
    else emit("launch", matches.value[sel.value - 1]);
  } else if (e.key === "Escape") {
    emit("close");
  }
}
</script>

<template>
  <div v-if="open" class="scrim" @mousedown="emit('close')">
    <div class="palette" @mousedown.stop>
      <div class="search">
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="#5b9bd5" stroke-width="1.5">
          <path d="M3 2l6 4-6 4z" />
        </svg>
        <input
          ref="inputEl"
          v-model="query"
          placeholder="Spawn an agent on a ticket…  try “auto-advance” or “ARGY”"
          @keydown="onKey"
        />
        <span class="esc">esc</span>
      </div>
      <div class="results">
        <!-- Pinned blank-shell row (DRY-39): always present, above the tickets. -->
        <div
          class="row shellrow"
          :class="{ active: sel === 0 }"
          @mouseenter="idx = 0"
          @click="emit('spawnShell')"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#7a9e6b" stroke-width="1.5" stroke-linecap="round">
            <path d="M3 5l3 3-3 3M8 11h5" />
          </svg>
          <span class="key">shell</span>
          <span class="title">Blank shell session — your login shell, no agent</span>
          <span v-if="sel === 0" class="spawn">↵ spawn</span>
        </div>
        <div
          v-for="(t, i) in matches"
          :key="t.key"
          class="row"
          :class="{ active: i + 1 === sel }"
          @mouseenter="idx = i + 1"
          @click="emit('launch', t)"
        >
          <span
            class="status"
            :style="{
              background: CATEGORY_COLOR[t.status.category].c,
              boxShadow: `0 0 6px ${CATEGORY_COLOR[t.status.category].g}`,
            }"
          ></span>
          <span class="key">{{ t.key }}</span>
          <span class="title">{{ t.title }}</span>
          <span class="repo">~/{{ t.repo }}</span>
          <span v-if="i + 1 === sel" class="spawn">↵ spawn</span>
        </div>
        <div v-if="!matches.length" class="empty">No matching tickets.</div>
      </div>
      <div class="footer">
        <span><b>↑↓</b> navigate</span>
        <span><b>↵</b> spawn</span>
        <span><b>⇧↵</b> shell</span>
        <span class="src">pulled live from {{ providerName }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: absolute;
  inset: 0;
  background: #060709b3;
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: center;
  padding-top: 96px;
  z-index: 10000;
}
.palette {
  width: 600px;
  max-width: 90%;
  height: max-content;
  background: #13171d;
  border: 1px solid #ffffff1c;
  border-radius: 13px;
  box-shadow: 0 24px 70px #000000aa;
  overflow: hidden;
}
.search {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px 17px;
  border-bottom: 1px solid #ffffff10;
}
.search input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #e6edf4;
  font-size: 16px;
  font-family: system-ui, sans-serif;
}
.esc {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #5a636f;
  border: 1px solid #ffffff14;
  border-radius: 5px;
  padding: 2px 6px;
}
.results {
  max-height: 340px;
  overflow-y: auto;
  padding: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 9px;
  cursor: pointer;
  border: 1px solid transparent;
}
.row.active {
  background: #1a2632;
  border-color: #26425c;
}
.status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.key {
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
  font-weight: 600;
  color: #5b9bd5;
  width: 64px;
  flex: 0 0 auto;
}
.title {
  flex: 1;
  font-size: 13.5px;
  color: #cdd6e0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #56606c;
}
.spawn {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #7fa8cf;
  background: #13283d;
  padding: 2px 7px;
  border-radius: 5px;
}
.empty {
  padding: 28px;
  text-align: center;
  color: #5a636f;
  font-size: 13px;
}
.footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 17px;
  border-top: 1px solid #ffffff10;
  font-size: 11.5px;
  color: #5a636f;
}
.footer b {
  color: #8590a0;
}
.src {
  margin-left: auto;
}
</style>
