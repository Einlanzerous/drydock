<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CATEGORY_COLOR, type Ticket } from "../lib/tracker.js";

// Ctrl+K quick-launch palette, and since DRY-82 the only place a session with
// no ticket behind it is started from. Three pinned rows sit above the ticket
// list — blank shell, bare claude agent, workspace — and the header's
// "+ claude" and "+ workspace" buttons are gone with them. That is the same
// cleanup DRY-36 (workspace off the ticket panel) and DRY-39 (the plain-shell
// button) each made once; the capability had to MOVE here first, because the
// palette could not do either of those two things.
//
// Fuzzy-search tickets by key / title / repo; ↵ activates the selected row
// (pinned row → spawn, ticket row → ticket panel).
const props = defineProps<{ open: boolean; tickets: Ticket[]; providerName: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "launch", t: Ticket): void;
  // Kept as one event with a payload rather than three: the pinned rows render
  // from one v-for, and a per-row event name would be a lookup table whose only
  // job is to be kept in step with it. The union is repeated on the handler in
  // App.vue, where vue-tsc checks the two against each other at the binding.
  (e: "spawn", kind: "shell" | "claude" | "workspace"): void;
}>();

/** A row that spawns something with no ticket behind it. */
interface Pinned {
  kind: "shell" | "claude" | "workspace";
  key: string;
  title: string;
  /**
   * Extra words the query matches on, so a pinned row can be TYPED for.
   *
   * This is what replaces the `⇧↵` shell chord (see `onKey`): three pinned rows
   * want one rule, and "type two letters and press ↵" is a rule that keeps
   * working when a fourth is added. Matching the title alone wouldn't do — it
   * is a sentence, so "agent" would pull in the shell row, whose whole
   * distinction is that it has no agent in it.
   */
  terms: string;
  /** Row glyph: one <path> and its stroke, so the markup stays a single v-for. */
  d: string;
  stroke: string;
}
const PINNED: Pinned[] = [
  {
    kind: "shell",
    key: "shell",
    title: "Blank shell session — your login shell, no agent",
    terms: "shell zsh bash terminal",
    d: "M3 5l3 3-3 3M8 11h5",
    stroke: "#7a9e6b",
  },
  {
    kind: "claude",
    key: "claude",
    title: "Bare claude agent — no ticket, no worktree",
    terms: "claude agent",
    d: "M8 2.5v11M3.2 5.2l9.6 5.6M12.8 5.2l-9.6 5.6",
    stroke: "#c08a5e",
  },
  {
    kind: "workspace",
    key: "workspace",
    title: "Workspace — ticket drawer, an agent and a zsh in one window",
    terms: "workspace drawer agent zsh split",
    d: "M2.5 3.5h11v9h-11zM9 3.5v9",
    stroke: "#8f86c8",
  },
];

const query = ref("");
/**
 * Row index across everything rendered: the pinned rows first, tickets after.
 *
 * Not "one pinned row" hard-coded any more — the pinned rows are filtered by the
 * query like the tickets are, so how many of them are on screen is not a
 * constant and `pinned.value.length` is the only honest offset (DRY-82).
 */
const idx = ref(PINNED.length);
const inputEl = ref<HTMLInputElement | null>(null);

const pinned = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return PINNED;
  return PINNED.filter((p) => `${p.key} ${p.terms}`.includes(q));
});

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

/** How many rows are rendered right now — pinned rows plus ticket matches. */
const total = computed(() => pinned.value.length + matches.value.length);
/** Selected row, clamped to what's actually rendered. */
const sel = computed(() => Math.min(idx.value, Math.max(0, total.value - 1)));

watch(
  () => props.open,
  (o) => {
    if (o) {
      query.value = "";
      idx.value = props.tickets.length ? PINNED.length : 0;
      nextTick(() => inputEl.value?.focus());
    }
  },
);
watch(query, () => (idx.value = matches.value.length ? pinned.value.length : 0));

/** Spawn or open whatever is at row `i`. */
function activate(i: number): void {
  const p = pinned.value[i];
  if (p) {
    emit("spawn", p.kind);
    return;
  }
  const t = matches.value[i - pinned.value.length];
  if (t) emit("launch", t);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx.value = Math.min(sel.value + 1, Math.max(0, total.value - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx.value = Math.max(sel.value - 1, 0);
  } else if (e.key === "Enter" && e.shiftKey) {
    // ⇧↵ used to spawn a shell from anywhere in the palette. With three pinned
    // rows a chord for one of them is the worst of both — so there is no chord
    // now, and this SWALLOWS the old one rather than letting it fall through to
    // the branch below. Falling through would silently turn a shell chord into
    // "spawn an agent on whatever ticket happens to be selected", which is the
    // one outcome a stale reflex must not produce (DRY-82).
    e.preventDefault();
  } else if (e.key === "Enter") {
    activate(sel.value);
  } else if (e.key === "Escape") {
    emit("close");
  }
}
</script>

<template>
  <!-- .prevent matters: without it the browser's default mousedown focus action
       runs after the close handler and pulls focus off the terminal we just
       handed it back to (DRY-43). -->
  <div v-if="open" class="scrim" @mousedown.prevent="emit('close')">
    <div class="palette" @mousedown.stop>
      <div class="search">
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="#5b9bd5" stroke-width="1.5">
          <path d="M3 2l6 4-6 4z" />
        </svg>
        <input
          ref="inputEl"
          v-model="query"
          placeholder="Spawn on a ticket — or type shell, claude, workspace"
          @keydown="onKey"
        />
        <span class="esc">esc</span>
      </div>
      <div class="results">
        <!-- Pinned spawn rows (DRY-82): the three sessions that have no ticket
             behind them, above the tickets. Filtered by the query like the rows
             below, which is what lets "type shell, ↵" replace the chord. -->
        <div
          v-for="(p, i) in pinned"
          :key="p.kind"
          class="row pinrow"
          :class="{ active: i === sel }"
          @mouseenter="idx = i"
          @click="emit('spawn', p.kind)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" :stroke="p.stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path :d="p.d" />
          </svg>
          <span class="key">{{ p.key }}</span>
          <span class="title">{{ p.title }}</span>
          <span v-if="i === sel" class="spawn">↵ spawn</span>
        </div>
        <div
          v-for="(t, i) in matches"
          :key="t.key"
          class="row"
          :class="{ active: i + pinned.length === sel }"
          @mouseenter="idx = i + pinned.length"
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
          <span v-if="i + pinned.length === sel" class="spawn">↵ spawn</span>
        </div>
        <!-- Off `total`, not `matches`: a query naming a pinned row ("workspace")
             legitimately matches no ticket, and "No matching tickets." over a
             row that is right there reads as the palette being broken. -->
        <div v-if="!total" class="empty">Nothing matches.</div>
      </div>
      <div class="footer">
        <span><b>↑↓</b> navigate</span>
        <span><b>↵</b> spawn</span>
        <span><b>type</b> shell · claude · workspace</span>
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
  /* Wide enough for "workspace", which is the longest thing this column now
     holds (DRY-82) — at 64px it overflowed into the gap and sat against the
     title with no space between them. A fixed width rather than a min, so the
     pinned rows and the ticket rows keep one left edge for their titles. */
  width: 76px;
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
