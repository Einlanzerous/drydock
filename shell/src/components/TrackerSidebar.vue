<script setup lang="ts">
import { computed } from "vue";
import { CATEGORY_COLOR, groupByRepo, tagColor, type Ticket } from "../lib/tracker.js";

// Left sidebar: live tickets from the active tracker, grouped by repo. Each row
// spawns an agent scoped to that ticket. Labeled with the provider's name (the
// prototype hardcodes "SWITCHYARD"; DRY-10 generalizes it).
const props = defineProps<{ name: string; tickets: Ticket[] }>();
const emit = defineEmits<{ (e: "launch", t: Ticket): void }>();

const groups = computed(() => groupByRepo(props.tickets));
</script>

<template>
  <aside class="sidebar">
    <div class="head">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="3" fill="#1e2b3a" stroke="#3d6fa6" stroke-width="1.2" />
        <path d="M5 8l2 2 4-4.5" stroke="#5b9bd5" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="label">{{ name.toUpperCase() }}</span>
      <span class="count">{{ tickets.length }}</span>
      <span class="live"></span>
    </div>
    <div class="list ddscroll">
      <template v-for="grp in groups" :key="grp.repo">
        <div class="grp">
          <span class="grp-name">{{ grp.repo }}</span>
          <div class="grp-rule"></div>
        </div>
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
            <div class="tagrow" v-if="t.tag">
              <span class="tag-dot" :style="{ background: tagColor(t.tag) }"></span>
              <span class="tag">{{ t.tag }}</span>
            </div>
          </div>
          <div class="play" title="Spawn agent">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="#9cc6ec"><path d="M3 2l6 4-6 4z" /></svg>
          </div>
        </div>
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
.live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5fb98a;
  box-shadow: 0 0 6px #5fb98a99;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 16px;
}
.grp {
  margin: 6px 6px 4px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.grp-name {
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #5a636f;
  text-transform: uppercase;
}
.grp-rule {
  flex: 1;
  height: 1px;
  background: #ffffff0a;
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
