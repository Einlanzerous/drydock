<script setup lang="ts">
import { computed } from "vue";
import type { LayoutMode, Rect, Win } from "../composables/useWindowManager.js";

// One desktop window: chrome + positioning. The body (a live terminal) is
// slotted in by the parent. Geometry comes from the window manager's computed
// rect; in Float mode the title bar drags and the corner resizes, in Tile/Focus
// the rects are managed and those affordances disappear.
const props = defineProps<{
  win: Win;
  rect: Rect;
  layout: LayoutMode;
  focused: boolean;
  statusColor: string;
  statusGlow: string;
  attention: boolean;
  /** Centered glowing badge in the bar, e.g. "Your turn" when the agent yields. */
  statusTag?: string;
  dragging: boolean;
}>();
const emit = defineEmits<{
  (e: "focus"): void;
  (e: "dragStart", ev: MouseEvent): void;
  (e: "resizeStart", ev: MouseEvent): void;
  (e: "minimize"): void;
  (e: "close"): void;
}>();

const frameStyle = computed(() => {
  const r = props.rect;
  const isFloat = props.layout === "float";
  return {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: `${r.h}px`,
    zIndex: String(r.z ?? 1),
    borderColor: props.focused ? "#33506e" : "#ffffff14",
    boxShadow: props.focused
      ? "0 18px 50px #000000aa, 0 0 0 1px #2a486622"
      : "0 10px 30px #00000077",
    transition: props.dragging
      ? "none"
      : isFloat
        ? "box-shadow .2s, border-color .2s"
        : "all .26s cubic-bezier(.4,0,.2,1)",
  };
});

const grab = computed(() => (props.layout === "float" ? "grab" : "default"));
</script>

<template>
  <div class="frame" :style="frameStyle" @mousedown="emit('focus')">
    <div
      class="bar"
      :class="{ focused }"
      :style="{ cursor: grab }"
      @mousedown="emit('dragStart', $event)"
    >
      <span
        class="dot"
        :class="{ pulse: attention }"
        :style="{ background: statusColor, boxShadow: `0 0 7px ${statusGlow}` }"
      ></span>
      <span class="title">{{ win.title }}</span>
      <span v-if="win.ticket" class="ticket">{{ win.ticket }}</span>
      <span class="repo">~/{{ win.repo }}</span>
      <div class="grow"></div>
      <span v-if="statusTag" class="statustag">{{ statusTag }}</span>
      <div class="grow"></div>
      <button
        class="ctl"
        title="Minimize to dock (keeps running)"
        @mousedown.stop
        @click="emit('minimize')"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4">
          <path d="M2.5 8.5h7" />
        </svg>
      </button>
      <button class="ctl close" title="Close" @mousedown.stop @click="emit('close')">
        <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>

    <div class="body">
      <slot></slot>
    </div>

    <div
      v-if="layout === 'float'"
      class="resize"
      @mousedown="emit('resizeStart', $event)"
    >
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="#4a5662" stroke-width="1.1">
        <path d="M10 4L4 10M10 8l-2 2" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.frame {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: #0d1116;
  border: 1px solid #ffffff14;
  border-radius: 10px;
  overflow: hidden;
  animation: winpop 0.22s ease;
}
.bar {
  flex: 0 0 auto;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 8px 0 12px;
  background: #11151a;
  border-bottom: 1px solid #ffffff0d;
  user-select: none;
}
.bar.focused {
  background: #161b22;
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
.title {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  font-weight: 500;
  color: #c5cfda;
}
.ticket {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  font-weight: 600;
  color: #5b9bd5;
  background: #10243a;
  border: 1px solid #234a6e;
  padding: 1px 6px;
  border-radius: 5px;
}
.repo {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #56606c;
}
.statustag {
  flex: 0 0 auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #f0d39a;
  background: #2a2114;
  border-radius: 6px;
  padding: 2px 9px;
  white-space: nowrap;
  animation: ddglow 1.8s ease-in-out infinite;
}
.grow {
  flex: 1;
}
.ctl {
  width: 24px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: #7a8593;
  cursor: pointer;
}
.ctl:hover {
  background: #ffffff14;
  color: #cfd8e2;
}
.ctl.close:hover {
  background: #5c2b2b;
  color: #f0c9c4;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-radius: 0 0 9px 9px;
}
.resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 3px;
  cursor: nwse-resize;
  z-index: 5;
}
</style>
