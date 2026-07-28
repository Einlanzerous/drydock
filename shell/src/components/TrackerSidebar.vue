<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { CATEGORY_COLOR, groupByRepo, tagColor, type Ticket } from "../lib/tracker.js";

// Left sidebar: live tickets from the active tracker, grouped by repo. At PoC
// fixture scale a flat list was fine; against a live tracker it pulls 100+
// tickets across every project, so this adds the usability layer (DRY-11):
// a search box, project/status/assignee filters, and collapsible groups
// (collapsed by default, with counts). All filtering is client-side over the
// already-loaded set. Each row still spawns an agent scoped to that ticket.
//
// The scope row (DRY-30) is different in kind from the filters: it controls
// what the daemon PULLS from the tracker, not what's shown of the loaded set.
// Host-default project chips are fixed (env config); user-added ones are
// removable; "backlog" opts the backlog bucket into the pull (off by default).
// The parent owns the state, refetches on change, and persists it.
const props = defineProps<{
  /**
   * Provider label. Typed `string`, defaulted upstream, and still rendered
   * through a fallback: this is the header that took the whole desk down in
   * DRY-51 — a throw here happens mid-patch, so Vue stops re-rendering
   * everything, not just the sidebar. The client that fed it `undefined` is
   * fixed; the belt stays because of what a repeat costs.
   */
  name: string;
  tickets: Ticket[];
  refreshing?: boolean;
  /** Host-default project scope from /api/tracker/info (fixed chips). */
  scopeProjects: string[];
  /** Browser-added project keys (removable chips). */
  userProjects: string[];
  showBacklog: boolean;
}>();
const emit = defineEmits<{
  (e: "launch", t: Ticket): void;
  (e: "refresh"): void;
  (e: "add-project", key: string): void;
  (e: "remove-project", key: string): void;
  (e: "toggle-backlog", show: boolean): void;
}>();

const newProject = ref("");
function addProject(): void {
  // Tracker project keys are uppercase by convention (Jira enforces it).
  const key = newProject.value.trim().toUpperCase();
  newProject.value = "";
  if (key) emit("add-project", key);
}

// Sentinel for the assignee filter: the leading space cannot collide with a
// real assignee name. (Was a stray NUL byte, which made git treat this whole
// file as binary — no diffs, no grep.)
const UNASSIGNED = " unassigned";

const search = ref("");
const fProject = ref("");
const fStatus = ref("");
const fAssignee = ref("");
// Per-group expand state; absent = collapsed (the default). When a search/filter
// is active we force-open all groups so matches aren't hidden behind a chevron.
const expanded = reactive<Record<string, boolean>>({});

const filtering = computed(
  () => !!search.value.trim() || !!fProject.value || !!fStatus.value || !!fAssignee.value,
);

// Filter-option sources, derived from the loaded set so they only offer values
// that actually exist.
const projects = computed(() => [...new Set(props.tickets.map((t) => t.repo))].sort());
const statuses = computed(() => {
  const seen = new Map<string, string>();
  for (const t of props.tickets) if (!seen.has(t.status.category)) seen.set(t.status.category, t.status.label);
  return [...seen].map(([category, label]) => ({ category, label }));
});
const assignees = computed(() => [
  ...new Set(props.tickets.map((t) => t.assignee?.name).filter((n): n is string => !!n)),
].sort());
const hasUnassigned = computed(() => props.tickets.some((t) => !t.assignee));

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return props.tickets.filter((t) => {
    if (fProject.value && t.repo !== fProject.value) return false;
    if (fStatus.value && t.status.category !== fStatus.value) return false;
    if (fAssignee.value === UNASSIGNED) {
      if (t.assignee) return false;
    } else if (fAssignee.value && t.assignee?.name !== fAssignee.value) {
      return false;
    }
    if (q) {
      const hay = `${t.key} ${t.title} ${t.repo} ${t.assignee?.name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

const groups = computed(() => groupByRepo(filtered.value));

function isOpen(repo: string): boolean {
  return filtering.value || !!expanded[repo];
}
function toggle(repo: string): void {
  expanded[repo] = !expanded[repo];
}
function clearFilters(): void {
  search.value = "";
  fProject.value = "";
  fStatus.value = "";
  fAssignee.value = "";
}
</script>

<template>
  <aside class="sidebar">
    <div class="head">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="3" fill="#1e2b3a" stroke="#3d6fa6" stroke-width="1.2" />
        <path d="M5 8l2 2 4-4.5" stroke="#5b9bd5" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="label">{{ (name || "Tracker").toUpperCase() }}</span>
      <span class="count">{{ filtered.length }}<template v-if="filtered.length !== tickets.length">/{{ tickets.length }}</template></span>
      <button
        class="refresh"
        :class="{ spinning: refreshing }"
        title="Refresh tickets"
        :disabled="refreshing"
        @click="emit('refresh')"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2v3.2H10.3" />
        </svg>
      </button>
      <span class="live"></span>
    </div>

    <!-- search + filters -->
    <div class="controls">
      <div class="searchbox">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#5a636f" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M11 11l3 3" stroke-linecap="round" />
        </svg>
        <input v-model="search" type="text" placeholder="Search tickets…" spellcheck="false" />
        <button v-if="filtering" class="clear" title="Clear filters" @click="clearFilters">✕</button>
      </div>
      <div class="filters">
        <select v-model="fProject" :class="{ on: !!fProject }" title="Project">
          <option value="">Project</option>
          <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="fStatus" :class="{ on: !!fStatus }" title="Status">
          <option value="">Status</option>
          <option v-for="s in statuses" :key="s.category" :value="s.category">{{ s.label }}</option>
        </select>
        <select v-model="fAssignee" :class="{ on: !!fAssignee }" title="Assignee">
          <option value="">Assignee</option>
          <option v-for="a in assignees" :key="a" :value="a">{{ a }}</option>
          <option v-if="hasUnassigned" :value="UNASSIGNED">Unassigned</option>
        </select>
      </div>
      <!-- pull scope (DRY-30): which projects the daemon fetches, not a view filter -->
      <div class="scope">
        <span
          v-for="p in scopeProjects"
          :key="p"
          class="chip fixed"
          title="Host default (DRYDOCK_TRACKER_PROJECTS)"
        >{{ p }}</span>
        <span v-for="p in userProjects" :key="p" class="chip">
          {{ p }}
          <button class="chip-x" :title="`Stop pulling ${p}`" @click="emit('remove-project', p)">✕</button>
        </span>
        <input
          v-model="newProject"
          class="addkey"
          type="text"
          placeholder="+ project"
          spellcheck="false"
          title="Add a project key to pull (↵)"
          @keydown.enter.prevent="addProject"
        />
        <!-- Disabled while a pull is in flight: a mid-flight re-toggle races the
             fetches and leaves the checkbox out of sync with the list. -->
        <label
          class="backlog"
          :class="{ busy: refreshing }"
          title="Also pull backlog-status tickets from the tracker"
        >
          <input
            type="checkbox"
            :checked="showBacklog"
            :disabled="refreshing"
            @change="emit('toggle-backlog', ($event.target as HTMLInputElement).checked)"
          />
          backlog
        </label>
      </div>
    </div>

    <div class="list">
      <p v-if="!groups.length" class="empty">No tickets match.</p>
      <template v-for="grp in groups" :key="grp.repo">
        <button class="grp" :class="{ open: isOpen(grp.repo) }" @click="toggle(grp.repo)">
          <span class="chev">▸</span>
          <span class="grp-name">{{ grp.repo }}</span>
          <span class="grp-count">{{ grp.tickets.length }}</span>
        </button>
        <template v-if="isOpen(grp.repo)">
          <div
            v-for="t in grp.tickets"
            :key="t.key"
            class="row"
            @click="emit('launch', t)"
          >
            <span
              class="status"
              :style="{
                background: CATEGORY_COLOR[t.status.category].c,
                boxShadow: `0 0 6px ${CATEGORY_COLOR[t.status.category].g}`,
              }"
            ></span>
            <div class="meta">
              <div class="line1">
                <span class="key">{{ t.key }}</span>
                <span class="slabel">{{ t.status.label }}</span>
              </div>
              <div class="ttitle">{{ t.title }}</div>
              <div class="tagrow">
                <template v-if="t.tag">
                  <span class="tag-dot" :style="{ background: tagColor(t.tag) }"></span>
                  <span class="tag">{{ t.tag }}</span>
                </template>
                <span v-if="t.assignee" class="assignee" :title="`Assigned to ${t.assignee.name}`">@{{ t.assignee.name }}</span>
              </div>
            </div>
            <div class="play" title="Spawn agent">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="#9cc6ec"><path d="M3 2l6 4-6 4z" /></svg>
            </div>
          </div>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 266px;
  flex: 0 0 auto;
  background: #0c0f13;
  border-right: 1px solid #ffffff0d;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  height: 42px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid #ffffff0a;
}
.label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #7a8696;
}
.count {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #4f5965;
  margin-left: auto;
}
.refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 5px;
  color: #5a636f;
  cursor: pointer;
}
.refresh:hover:not(:disabled) {
  background: #11161c;
  color: #aecbe8;
}
.refresh:disabled {
  cursor: default;
}
.refresh.spinning {
  color: #5b9bd5;
}
.refresh.spinning svg {
  animation: ddspin 0.7s linear infinite;
}
@keyframes ddspin {
  to {
    transform: rotate(360deg);
  }
}
.live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5fb98a;
  box-shadow: 0 0 6px #5fb98a99;
}

/* search + filters */
.controls {
  flex: 0 0 auto;
  padding: 8px;
  border-bottom: 1px solid #ffffff0a;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.searchbox {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 7px;
  padding: 0 8px;
}
.searchbox:focus-within {
  border-color: #3d6fa6;
}
.searchbox input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: #d5dde6;
  font-size: 12px;
  padding: 7px 0;
}
.searchbox input::placeholder {
  color: #4f5965;
}
.clear {
  background: none;
  border: none;
  color: #6b7682;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 3px;
  border-radius: 4px;
}
.clear:hover {
  color: #c3ccd6;
}
.filters {
  display: flex;
  gap: 5px;
}
.filters select {
  flex: 1;
  min-width: 0;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 6px;
  color: #8a94a0;
  font-size: 10.5px;
  padding: 5px 4px;
  outline: none;
  cursor: pointer;
}
.filters select.on {
  border-color: #3d6fa6;
  color: #aecbe8;
}
.filters select:focus {
  border-color: #3d6fa6;
}

/* pull scope (DRY-30) */
.scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: #aecbe8;
  background: #16314a;
  border: 1px solid #2a557d;
  border-radius: 9px;
  padding: 2px 8px;
}
.chip.fixed {
  color: #7a8696;
  background: #141a21;
  border-color: #20272f;
}
.chip-x {
  background: none;
  border: none;
  color: #6b7682;
  cursor: pointer;
  font-size: 9px;
  padding: 0 0 0 2px;
}
.chip-x:hover {
  color: #d57a6e;
}
.addkey {
  width: 74px;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 9px;
  color: #d5dde6;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  padding: 3px 8px;
  outline: none;
  text-transform: uppercase;
}
.addkey::placeholder {
  color: #4f5965;
  text-transform: none;
}
.addkey:focus {
  border-color: #3d6fa6;
}
.backlog {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: #6b7682;
  cursor: pointer;
  user-select: none;
}
.backlog input {
  accent-color: #3d6fa6;
  width: 11px;
  height: 11px;
  cursor: pointer;
}
.backlog.busy {
  opacity: 0.45;
  cursor: default;
}
.backlog.busy input {
  cursor: default;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 16px;
}
.empty {
  font-size: 12px;
  color: #5a636f;
  text-align: center;
  margin: 18px 0;
}
.grp {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 6px 0 2px;
  padding: 5px 6px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.grp:hover {
  background: #11161c;
}
.chev {
  color: #5a636f;
  font-size: 9px;
  transition: transform 0.12s ease;
}
.grp.open .chev {
  transform: rotate(90deg);
}
.grp-name {
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #5a636f;
  text-transform: uppercase;
}
.grp-count {
  margin-left: auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #4f5965;
  background: #141a21;
  border-radius: 9px;
  padding: 1px 7px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 9px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 1px;
}
.row:hover {
  background: #141a21;
}
.status {
  margin-top: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.meta {
  flex: 1;
  min-width: 0;
}
.line1 {
  display: flex;
  align-items: center;
  gap: 7px;
}
.key {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 600;
  color: #5b9bd5;
}
.slabel {
  font-size: 10px;
  color: #6b7682;
}
.ttitle {
  font-size: 12.5px;
  color: #bcc6d1;
  line-height: 1.35;
  margin-top: 2px;
  text-wrap: pretty;
}
.tagrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
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
.assignee {
  margin-left: auto;
  font-size: 10px;
  color: #6e7a86;
  font-family: "JetBrains Mono", monospace;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.play {
  margin-top: 1px;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #16314a;
  border: 1px solid #2a557d;
  flex: 0 0 auto;
}
</style>
