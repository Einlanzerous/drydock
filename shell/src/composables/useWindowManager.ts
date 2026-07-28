// Window manager for the Drydock desktop (DRY-9 / DRY-4).
//
// Owns the window model and the three layout engines (Float / Tile / Focus).
// The geometry is ported directly from the design prototype's computeRects():
// float honors each window's own rect; tile auto-grids ceil(sqrt(n)) columns
// and reserves space for the dock; focus puts one window large with a
// right-hand thumbnail strip of the rest.
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { loadLayout, type PersistedLayout, saveLayout } from "./layoutStore.js";

export type LayoutMode = "float" | "tile" | "focus";
export type WinType = "agent" | "bash";
// A plain single-terminal window, or a composite "workspace" (DRY-21): ticket
// drawer + agent PTY + a co-located zsh PTY, all bound to one managed window.
export type WinKind = "terminal" | "workspace";

export interface Win {
  id: string; // daemon session id (for a workspace, the *agent* PTY)
  kind: WinKind; // "terminal" (default) | "workspace"
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
  // --- workspace (DRY-21) only ---
  /** The co-located zsh PTY's session id (the bottom shell pane). */
  shellId?: string;
  /** Ticket drawer pulled down (persisted so it survives a reload). */
  drawerOpen?: boolean;
  /** Bottom shell pane collapsed to reclaim height for the agent. */
  shellCollapsed?: boolean;
  /** Shell pane height as a fraction of the split (0..1); agent gets the rest. */
  shellRatio?: number;
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

/**
 * Height the rail reserves along the bottom edge (DRY-49).
 *
 * CONSTANT, in every state — this replaced a reserve that was 72px when
 * anything was minimized and 14px otherwise. That conditional was fine while
 * the only thing down there was a dock you put things in yourself, but the rail
 * fills on its own: a gate firing while you are mid-drag would have reflowed
 * every tiled window out from under the cursor. A fixed number costs 84px of
 * desk on an empty rail and buys a desk that never moves unless you move it.
 */
export const RAIL_HEIGHT = 98;

export function useWindowManager(opts: { persistKey?: string } = {}) {
  const layout = ref<LayoutMode>("float");
  const windows = reactive<Win[]>([]);
  const focusedId = ref<string | null>(null);
  const desk = reactive({ w: 1000, h: 640 });
  let z = 30;

  // ---- persistence (DRY-14, daemon-backed in DRY-28) ----
  // Restore the saved arrangement. App.vue awaits this *before* the first daemon
  // poll, so reconcile() sees the restored windows and keeps the alive ones at
  // their saved geometry (rather than re-adding at cascade), adds genuinely new
  // sessions, and drops windows whose session is gone.
  //
  // Async since DRY-28: the arrangement now comes from the daemon (falling back
  // to this browser's mirror), which is what lets it follow you between
  // machines. Ordering matters more than it used to — awaiting a network round
  // trip before the first poll is the difference between restoring a desk and
  // rebuilding one from scratch at cascade positions.
  async function hydrate(): Promise<void> {
    if (!opts.persistKey) return;
    const saved = await loadLayout(opts.persistKey, { apply, arranged: () => arranged });
    if (saved) apply(saved);
  }

  /**
   * Put a saved arrangement on screen. Extracted from `hydrate` because DRY-58
   * has a second caller: when the store comes back after an outage that began
   * before the first read, the desk it was holding lands here rather than
   * waiting for a page reload. One function so the restore a reload does and
   * the restore a heal does cannot drift apart.
   */
  function apply(saved: PersistedLayout): void {
    // DRY-42: heal layouts persisted while a duplicate-id window existed (the
    // spawn-vs-poll race wrote both copies, and the deep watcher made the
    // corruption survive reloads). Prefer the workspace-kind entry — it
    // carries shellId and the richer pane state; otherwise last write wins.
    const byId = new Map<string, Win>();
    for (const w of saved.windows) {
      const prev = byId.get(w.id);
      byId.set(w.id, prev && prev.kind === "workspace" && w.kind !== "workspace" ? prev : w);
    }
    windows.splice(0, windows.length, ...byId.values());
    // Assigned, not `setLayout`d: applying someone else's desk is not this
    // client arranging one (see `arranged`).
    layout.value = saved.layout;
    // Keep the z counter above every restored window so new spawns land on top.
    z = windows.reduce((m, w) => Math.max(m, w.z), z);
    const top = windows
      .filter((w) => !w.minimized)
      .reduce<Win | null>((best, w) => (!best || w.z > best.z ? w : best), null);
    focusedId.value = top?.id ?? null;
  }

  /**
   * Has a HUMAN shaped this desk since it loaded? (DRY-58)
   *
   * It decides one thing: when the store heals after an outage that started
   * before we ever read it, whose desk wins — this browser's or the one the
   * daemon turns out to be holding. So the line has to sit exactly where
   * `mayPush`'s data-loss path does. A window appearing because the session
   * poll found a new PTY is NOT arranging: that is the from-scratch cascade
   * desk `mayPush` exists to stop overwriting a real one. Dragging, resizing,
   * minimizing, restoring, switching layout mode and moving a workspace pane's
   * own furniture all are — each one is a position someone chose.
   *
   * Deliberately not `bringFront`: clicking a terminal to type in it is not a
   * desk you arranged, even though it does change the z-order that gets saved.
   */
  let arranged = false;

  // Debounced so a drag/resize (many mutations/sec) coalesces into one write.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (opts.persistKey) saveLayout(opts.persistKey, layout.value, windows);
  }
  function schedulePersist() {
    if (!opts.persistKey) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  }
  if (opts.persistKey) {
    watch(layout, schedulePersist);
    watch(windows, schedulePersist, { deep: true });
  }

  // Cascade offset so freshly spawned float windows don't stack exactly.
  function cascade() {
    const n = windows.filter((w) => !w.minimized).length;
    return { x: 90 + ((n * 30) % 240), y: 54 + ((n * 26) % 150) };
  }

  function add(
    win: Omit<Win, "x" | "y" | "w" | "h" | "z" | "minimized" | "kind"> & Partial<Win>,
  ): Win {
    // DRY-42: adds must be idempotent per session id. spawnWorkspace registers
    // its window only after two awaited spawns, so a 3s poll tick in that gap
    // lets reconcile add a plain window for the agent session first; a second
    // push would give the WindowFrame v-for duplicate keys (Vue's keyed diff
    // corrupts — prod spams "emitsOptions of null") and every .find()-based op
    // (bringFront/updateWin/remove) only ever sees the first copy, leaving the
    // real window un-raisable. Merge in place instead: the raced plain window
    // upgrades to the workspace, keeping its slot in the array.
    const existing = windows.find((w) => w.id === win.id);
    if (existing) {
      Object.assign(existing, win, { z: ++z, minimized: false });
      focusedId.value = existing.id;
      return existing;
    }
    const pos = cascade();
    const w: Win = {
      x: win.x ?? pos.x,
      y: win.y ?? pos.y,
      w: win.w ?? 632,
      h: win.h ?? 462,
      z: ++z,
      minimized: win.minimized ?? false,
      kind: win.kind ?? "terminal",
      ...win,
    } as Win;
    windows.push(w);
    focusedId.value = w.id;
    return w;
  }

  /** Patch a window's fields (used by the workspace pane to persist its own
   *  drawer-open / shell-collapsed / split-ratio state via the deep watcher). */
  function updateWin(id: string, patch: Partial<Win>): void {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    Object.assign(w, patch);
    arranged = true;
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

  // Hand out the next z for a non-session overlay that still needs to stack
  // against the managed windows (e.g. the floating ticket detail, DRY-20). The
  // floor keeps it above the fixed z's the Tile/Focus layouts hardcode (50).
  function allocZ() {
    z = Math.max(z, 50);
    return ++z;
  }

  function minimize(id: string) {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    w.minimized = true;
    arranged = true;
  }

  function restore(id: string) {
    const w = windows.find((x) => x.id === id);
    if (!w) return;
    w.minimized = false;
    w.z = ++z;
    focusedId.value = id;
    arranged = true;
  }

  function setLayout(m: LayoutMode) {
    // Only a real change counts. Every spawn path calls this with "float" to
    // make sure the new window is visible, and a spawn is a session appearing,
    // not a desk being arranged.
    if (layout.value === m) return;
    layout.value = m;
    arranged = true;
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
      arranged = true;
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
    if (saveTimer) persist(); // flush a pending debounced write
  });

  const isDragging = () => drag !== null;

  // ---- geometry: ported from the prototype's computeRects() ----
  function computeRects(): Record<string, Rect> {
    const vis = windows.filter((w) => !w.minimized);
    const dockReserve = RAIL_HEIGHT;
    const rects: Record<string, Rect> = {};

    if (layout.value === "float") {
      // Float still honours each window's own rect, rail or no rail. These are
      // positions a person chose and dragged to; clamping them the day the
      // reserve changed would have silently rearranged every saved desk. The
      // rail simply outranks a floating window in z, which is the same deal
      // float has always had with the dock.
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

  /**
   * Move a window onto a different session id, in place (DRY-56).
   *
   * Resuming a tombstone spawns a NEW session, and the window has to follow it
   * without being removed and re-added: a remove/add pair loses the geometry,
   * drops the window to the top of the z stack and — in tile or focus mode —
   * reflows the whole desk under someone who just pressed a button inside that
   * window. Same reason `apply` exists rather than rebuilding from scratch.
   */
  function replaceId(oldId: string, newId: string): void {
    const w = windows.find((x) => x.id === oldId);
    if (!w) return;
    // A collision would be a duplicate-id desk, which DRY-42 had to go and heal
    // out of persisted layouts once already.
    if (windows.some((x) => x.id === newId)) {
      windows.splice(windows.indexOf(w), 1);
      return;
    }
    w.id = newId;
    if (focusedId.value === oldId) focusedId.value = newId;
  }

  return {
    layout,
    windows,
    focusedId,
    desk,
    hydrate,
    add,
    updateWin,
    remove,
    replaceId,
    bringFront,
    allocZ,
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
