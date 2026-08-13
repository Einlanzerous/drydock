// Being somewhere else (DRY-49).
//
// The premise of an autonomous run is that you walked away, so the tab strip is
// often the only surface left. Both signals here encode state by SHAPE as well
// as colour, because a 16px favicon at a glance is a silhouette — a recoloured
// hull and a hull are the same icon to anyone not looking for the difference.
//
//   nothing     the mark: a ship in a graving dock
//   running     the mark, dock flooded to a waterline
//   gate        solid disc with an exclamation   ← a different silhouette
//   failed      solid disc with a cross          ← a different silhouette
//   finished    the mark in green (completion is not an interruption)
//
// The favicon is DRAWN, not fetched: a canvas data URL has no asset pipeline,
// no extra request, and cannot 404 on a shell served from a container.
//
// THIS FILE IS THE FAVICON, not `shell/public/favicon.svg` (DRY-86). That file
// is only what the tab shows for the moment before this module mounts and
// overwrites the href, so a change made there alone is invisible in every
// browser — which is how DRY-86 was chased for an evening across three
// browsers and a private window. The two carry the same mark and have to be
// changed together.
//
// Drawn at 32 rather than 48: a favicon is slotted into 16 device pixels, and
// 48 makes that a 3:1 downsample — which is what erased the dock's 1-unit
// walls and left the bare hull that got this reported as "a rowboat". At 32
// the halving is exact, so the geometry below is the SVG's own 16-unit path
// data with the context scaled x2, and every edge lands on an even pixel.
import { computed, ref, watch } from "vue";

export type AttentionState = "idle" | "running" | "gate" | "failed" | "finished";

const BASE_TITLE = "Drydock";

/** Drawn size. Twice the 16px tab slot, so the browser's halving is exact. */
const SIZE = 32;

// Copied VERBATIM from shell/public/favicon.svg. Same mark, same numbers: the
// context is scaled x2 so these stay in that file's 16-unit coordinates and
// the two can be compared without arithmetic.
const DOCK_PATH = "M1 4h2v8h10V4h2v10H1Z";
const HULL_PATH = "M4 8h8l-1 4H5Z";
const HOUSE_PATH = "M6 6h3v2H6Z";
const MAST_PATH = "M7 3h1v3H7Z";

const PLATE = "#0e1116";
const DOCK = "#5b7794";
const SHIP = "#8fb8dd";
const WATER = "#3f7fb8";
const DONE_DOCK = "#3f6b55";
const DONE_SHIP = "#5fb98a";

let link: HTMLLinkElement | null = null;
let alternate: ReturnType<typeof setInterval> | null = null;
let flipped = false;

function iconLink(): HTMLLinkElement {
  if (link?.isConnected) return link;
  link =
    (document.querySelector("link[rel~='icon']") as HTMLLinkElement | null) ??
    document.createElement("link");
  link.rel = "icon";
  if (!link.isConnected) document.head.appendChild(link);
  return link;
}

/**
 * The plate. Every state sits on one, because a background-less icon cannot be
 * legible on every tab strip: 3:1 against Chrome's inactive DARK tab (#35363a)
 * needs relative luminance >= 0.214, against its inactive LIGHT tab (#dee1e6)
 * <= 0.207. Empty interval — no flat palette satisfies both (DRY-86). On the
 * plate the mark clears 4.06:1 (dock) and 9.07:1 (hull) everywhere.
 */
function drawPlate(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 6);
  ctx.fillStyle = PLATE;
  ctx.fill();
}

/**
 * The Drydock mark: a ship in a graving dock. In 16-unit coordinates — the
 * caller has already scaled the context.
 *
 * `water` is how far the basin is flooded, in units up from the dock floor. It
 * is drawn UNDER the ship so the hull sits on it, and it is what distinguishes
 * a run in progress from an idle desk by shape rather than by colour alone.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  dock: string,
  ship: string,
  water = 0,
): void {
  ctx.fillStyle = dock;
  ctx.fill(new Path2D(DOCK_PATH));
  if (water > 0) {
    ctx.fillStyle = WATER;
    ctx.fillRect(3, 12 - water, 10, water);
  }
  ctx.fillStyle = ship;
  ctx.fill(new Path2D(HULL_PATH));
  ctx.fill(new Path2D(HOUSE_PATH));
  ctx.fill(new Path2D(MAST_PATH));
}

/**
 * A filled disc carrying one glyph — deliberately NOT mark-shaped, since these
 * are the two states that want a person and have to differ at a glance.
 *
 * The glyphs are drawn as geometry rather than as text. `fillText` at this size
 * depends on whatever `system-ui` resolves to, antialiases against a coloured
 * disc, and lands differently on every OS; two rectangles and two strokes are
 * the same everywhere and stay crisp at 16px, which is the whole lesson of
 * DRY-86.
 */
function drawDisc(ctx: CanvasRenderingContext2D, color: string, glyph: "!" | "x"): void {
  ctx.beginPath();
  ctx.arc(8, 8, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#12100b";
  if (glyph === "!") {
    ctx.fillRect(7.5, 4, 1, 5);
    ctx.fillRect(7.5, 10.5, 1, 1.5);
  } else {
    ctx.strokeStyle = "#12100b";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(5.5, 5.5);
    ctx.lineTo(10.5, 10.5);
    ctx.moveTo(10.5, 5.5);
    ctx.lineTo(5.5, 10.5);
    ctx.stroke();
  }
}

function faviconFor(state: AttentionState): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  drawPlate(ctx);
  // Everything past here is in the mark's 16-unit space.
  ctx.scale(SIZE / 16, SIZE / 16);
  switch (state) {
    case "gate":
      drawDisc(ctx, "#e0a33c", "!");
      break;
    case "failed":
      drawDisc(ctx, "#d5695c", "x");
      break;
    case "finished":
      drawMark(ctx, DONE_DOCK, DONE_SHIP);
      break;
    case "running":
      drawMark(ctx, DOCK, SHIP, 3);
      break;
    default:
      drawMark(ctx, DOCK, SHIP);
  }
  return canvas.toDataURL("image/png");
}

/**
 * Drive the tab. `counts` is everything the tab strip can say.
 *
 * The title ALTERNATES for the two states that want a person, every 2s, so it
 * still reads in a tab truncated to a dozen characters — a long title that
 * happens to start with the word "Drydock" tells you nothing at that width.
 */
export function useAttention(source: {
  gates: () => number;
  gateLabel: () => string;
  failed: () => number;
  failedLabel: () => string;
  running: () => number;
  finished: () => number;
}) {
  const state = computed<AttentionState>(() => {
    if (source.gates() > 0) return "gate";
    if (source.failed() > 0) return "failed";
    if (source.running() > 0) return "running";
    if (source.finished() > 0) return "finished";
    return "idle";
  });

  const loudTitle = computed(() => {
    if (state.value === "gate") return `(${source.gates()}) ${source.gateLabel()} needs you — Drydock`;
    if (state.value === "failed") return `(${source.failed()}) ${source.failedLabel()} failed — Drydock`;
    return null;
  });

  const quietTitle = computed(() => {
    if (state.value === "running") return `${BASE_TITLE} — ${source.running()} underway`;
    if (state.value === "finished") return `${BASE_TITLE} — ${source.finished()} finished`;
    return BASE_TITLE;
  });

  watch(
    state,
    (s) => {
      const href = faviconFor(s);
      if (href) iconLink().href = href;
    },
    { immediate: true },
  );

  watch(
    [loudTitle, quietTitle],
    ([loud, quiet]) => {
      if (alternate) {
        clearInterval(alternate);
        alternate = null;
      }
      if (!loud) {
        document.title = quiet;
        return;
      }
      flipped = false;
      document.title = loud;
      alternate = setInterval(() => {
        flipped = !flipped;
        document.title = flipped ? BASE_TITLE : loud;
      }, 2000);
    },
    { immediate: true },
  );

  return { state };
}

// --- OS notifications -------------------------------------------------------
// One per GATE, never per state change. A run that starts, edits nine files and
// ends its turn is not nine notifications; it is zero. Only something that has
// stopped and is waiting on a person earns one.
const notified = new Set<string>();
const permission = ref<NotificationPermission>(
  typeof Notification !== "undefined" ? Notification.permission : "denied",
);

/** Asked once, when the first autonomous run is launched — not on page load. */
export async function askToNotify(): Promise<void> {
  if (typeof Notification === "undefined" || permission.value !== "default") return;
  try {
    permission.value = await Notification.requestPermission();
  } catch {
    /* some browsers reject this outside a user gesture — not worth a banner */
  }
}

export function notifyGate(requestId: string, title: string, body: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (notified.has(requestId)) return;
  notified.add(requestId);
  // Bounded: a tab left open for days would otherwise accumulate one id per
  // gate forever. The oldest are gates answered long ago, and all this set
  // prevents is re-announcing one that is still open.
  while (notified.size > 500) notified.delete(notified.values().next().value!);
  try {
    // `tag` so a reconnect that re-announces an open gate replaces its own
    // notification instead of stacking a second copy of the same question.
    new Notification(title, { body, tag: `drydock-gate-${requestId}` });
  } catch {
    /* notification construction can throw on some platforms; never fatal */
  }
}
