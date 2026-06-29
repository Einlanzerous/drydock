// Window manager for the Drydock desktop (DRY-9 / DRY-4).
//
// Owns the window model and the three layout engines (Float / Tile / Focus).
// The geometry is ported directly from the design prototype's computeRects():
// float honors each window's own rect; tile auto-grids ceil(sqrt(n)) columns
// and reserves space for the dock; focus puts one window large with a
// right-hand thumbnail strip of the rest.
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

export type LayoutMode = "float" | "tile" | "focus";
export type WinType = "agent" | "bash";

export interface Win {
  id: string; // daemon session id
  type: WinType;
  title: string; // "claude-code" | "bash"
  ticket?: string; // e.g. "ARGY-89" — badge in the title bar
  repo: string; // "~/{repo}" label
  // Float-mode geometry (the other layouts derive rects from window order):
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const PAD = 12;
const GAP = 10;
const STRIP_W = 210;
const MIN_W = 300;
const MIN_H = 180;

export function useWindowManager() {
  const layout = ref<LayoutMode>("float");
  const windows = reactive<Win[]>([]);
  const focusedId = ref<string | null>(null);
  const desk = reactive({ w: 1000, h: 640 });
  let z = 30;

  // Cascade offset so freshly spawned float windows don't stack exactly.
  function cascade() {
    const n = windows.filter((w) => !w.minimized).length;
    return { x: 90 + ((n * 30) % 240), y: 54 + ((n * 26) % 150) };
  }

  function add(win: Omit<Win, "x" | "y" | "w" | "h" | "z" | "minimized"> & Partial<Win>): Win {
    const pos = cascade();
    const w: Win = {
      x: win.x ?? pos.x,
      y: win.y ?? pos.y,
      w: win.w ?? 632,
      h: win.h ?? 462,
      z: ++z,
      minimized: win.minimized ?? false,
      ...win,
    } as Win;
    windows.push(w);
    focusedId.value = w.id;
    return w;
  }

  function remove(id: string) {
    const i = windows.findIndex((w) => w.id === id);
    if (i >= 0) windows.splice(i, 1);
    if (focusedId.value === id) {
      const next = windows.find((w) => !w.minimized);
      focusedId.value = next?.id ?? null;
    }
  }

  function bringFront(id: string) {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    w.z = ++z;
    focusedId.value = id;
  }

  function minimize(id: string) {
    const w = windows.find((x) => x.id === id);
    if (w) w.minimized = true;
  }

  function restore(id: string) {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    w.minimized = false;
    w.z = ++z;
    focusedId.value = id;
  }

  function setLayout(m: LayoutMode) {
    layout.value = m;
  }

  function setDesk(w: number, h: number) {
    desk.w = w;
    desk.h = h;
  }

  // ---- drag / resize (float mode only) ----
  let drag:
    | { mode: "move" | "resize"; id: string; sx: number; sy: number; ox: number; oy: number }
    | null = null;
  let raf = 0;

  function startDrag(e: MouseEvent, id: string) {
    if (layout.value !== "float") return;
    e.stopPropagation();
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    drag = { mode: "move", id, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y };
    bringFront(id);
  }

  function startResize(e: MouseEvent, id: string) {
    if (layout.value !== "float") return;
    e.stopPropagation();
    e.preventDefault();
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    drag = { mode: "resize", id, sx: e.clientX, sy: e.clientY, ox: w.w, oy: w.h };
    bringFront(id);
  }

  function onMove(e: MouseEvent) {
    if (!drag || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!drag) return;
      const w = windows.find((x) => x.id === drag!.id);
      if (!w) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (drag.mode === "move") {
        w.x = Math.max(0, drag.ox + dx);
        w.y = Math.max(0, drag.oy + dy);
      } else {
        w.w = Math.max(MIN_W, drag.ox + dx);
        w.h = Math.max(MIN_H, drag.oy + dy);
      }
    });
  }

  function onUp() {
    drag = null;
  }

  onMounted(() => {
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  });

  const isDragging = () => drag !== null;

  // ---- geometry: ported from the prototype's computeRects() ----
  function computeRects(): Record<string, Rect> {
    const vis = windows.filter((w) => !w.minimized);
    const anyMin = windows.some((w) => w.minimized);
    const dockReserve = anyMin ? 72 : 14;
    const rects: Record<string, Rect> = {};

    if (layout.value === "float") {
      for (const w of vis) rects[w.id] = { x: w.x, y: w.y, w: w.w, h: w.h, z: w.z };
      return rects;
    }

    if (layout.value === "tile") {
      const n = vis.length || 1;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cw = (desk.w - PAD * 2 - GAP * (cols - 1)) / cols;
      const ch = (desk.h - PAD - dockReserve - GAP * (rows - 1)) / rows;
      vis.forEach((w, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        rects[w.id] = {
          x: PAD + c * (cw + GAP),
          y: PAD + r * (ch + GAP),
          w: cw,
          h: ch,
          z: w.id === focusedId.value ? 50 : 10,
        };
      });
      return rects;
    }

    // focus: one large window + right-hand thumbnail strip
    const others = vis.filter((w) => w.id !== focusedId.value);
    const foc = vis.find((w) => w.id === focusedId.value) ?? vis[0];
    if (foc) {
      rects[foc.id] = {
        x: PAD,
        y: PAD,
        w: desk.w - PAD * 2 - (others.length ? STRIP_W + GAP : 0),
        h: desk.h - PAD - dockReserve,
        z: 50,
      };
    }
    const th = others.length
      ? (desk.h - PAD - dockReserve - GAP * (others.length - 1)) / others.length
      : 0;
    others.forEach((w, i) => {
      rects[w.id] = {
        x: desk.w - PAD - STRIP_W + GAP,
        y: PAD + i * (th + GAP),
        w: STRIP_W - GAP,
        h: th,
        z: 10,
      };
    });
    return rects;
  }

  return {
    layout,
    windows,
    focusedId,
    desk,
    add,
    remove,
    bringFront,
    minimize,
    restore,
    setLayout,
    setDesk,
    startDrag,
    startResize,
    isDragging,
    computeRects,
  };
}
