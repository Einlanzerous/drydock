<script setup lang="ts">
import type { Win } from "../composables/useWindowManager.js";

// macOS-style dock for minimized-but-still-running windows. Minimizing is free
// because the daemon owns the PTY lifecycle — the agent never notices its pane
// is hidden. Click to restore. Attention (a pending approval) keeps the dot
// pulsing so you can't lose a gated session in the dock.
defineProps<{
  items: {
    win: Win;
    statusColor: string;
    statusGlow: string;
    attention: boolean;
    sub: string;
  }[];
}>();
const emit = defineEmits<{ (e: "restore", id: string): void }>();
</script>

<template>
  <div v-if="items.length" class="dock">
    <span class="caption">DOCKED</span>
    <div
      v-for="it in items"
      :key="it.win.id"
      class="item"
      @click="emit('restore', it.win.id)"
    >
      <span
        class="dot"
        :class="{ pulse: it.attention }"
        :style="{ background: it.statusColor, boxShadow: `0 0 7px ${it.statusGlow}` }"
      ></span>
      <div class="text">
        <div class="line1">
          <span class="id" :style="{ color: it.win.ticket ? '#5b9bd5' : '#b9c3cf' }">
            {{ it.win.ticket || it.win.title }}
          </span>
          <span class="repo">~/{{ it.win.repo }}</span>
        </div>
        <span class="sub">{{ it.sub }}</span>
      </div>
      <svg class="arrow" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#5a636f" stroke-width="1.4">
        <path d="M3 7h8M8 4l3 3-3 3" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.dock {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 92%;
  padding: 9px 11px;
  background: #10141af2;
  border: 1px solid #ffffff16;
  border-radius: 13px;
  backdrop-filter: blur(14px);
  box-shadow: 0 12px 34px #00000066, 0 0 0 1px #00000040;
  z-index: 9000;
}
.caption {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: #5a636f;
  padding: 0 4px;
}
.item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 11px 7px 9px;
  background: #171c23;
  border: 1px solid #ffffff12;
  border-radius: 10px;
  cursor: pointer;
  animation: dockpop 0.26s ease;
}
.item:hover {
  background: #1e252e;
  border-color: #2c3742;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.pulse {
  animation: ddpulse 1.2s ease-in-out infinite;
}
.text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
.id {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 600;
}
.repo {
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #56606c;
}
.sub {
  font-size: 10.5px;
  color: #7c8693;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arrow {
  margin-left: 2px;
}
</style>
