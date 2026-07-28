// Being somewhere else (DRY-49).
//
// The premise of an autonomous run is that you walked away, so the tab strip is
// often the only surface left. Both signals here encode state by SHAPE as well
// as colour, because a 16px favicon at a glance is a silhouette — a recoloured
// hull and a hull are the same icon to anyone not looking for the difference.
//
//   nothing     outline hull
//   running     hull with a blue waterline
//   gate        solid disc with an exclamation   ← a different silhouette
//   failed      solid disc with a cross          ← a different silhouette
//   finished    filled hull (completion is not an interruption)
//
// The favicon is DRAWN, not fetched: a canvas data URL has no asset pipeline,
// no extra request, and cannot 404 on a shell served from a container.
import { computed, ref, watch } from "vue";

export type AttentionState = "idle" | "running" | "gate" | "failed" | "finished";

const BASE_TITLE = "Drydock";

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

/** The hull from the Drydock mark, at favicon scale. */
function drawHull(ctx: CanvasRenderingContext2D, fill: string | null, stroke: string): void {
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = stroke;
  ctx.beginPath();
  ctx.moveTo(5, 12);
  ctx.lineTo(5, 20);
  ctx.quadraticCurveTo(5, 25, 11, 25);
  ctx.lineTo(38, 25);
  ctx.lineTo(46, 16);
  ctx.lineTo(46, 13);
  ctx.lineTo(11, 13);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.stroke();
  // Mast, so the outline reads as a ship rather than a wedge.
  ctx.beginPath();
  ctx.moveTo(22, 13);
  ctx.lineTo(22, 4);
  ctx.stroke();
}

/** A filled disc carrying one glyph — deliberately NOT hull-shaped. */
function drawDisc(ctx: CanvasRenderingContext2D, color: string, glyph: string): void {
  ctx.beginPath();
  ctx.arc(24, 24, 21, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "#12100b";
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, 24, 25);
}

function faviconFor(state: AttentionState): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  switch (state) {
    case "gate":
      drawDisc(ctx, "#e0a33c", "!");
      break;
    case "failed":
      drawDisc(ctx, "#d5695c", "✕");
      break;
    case "finished":
      drawHull(ctx, "#5fb98a", "#5fb98a");
      break;
    case "running":
      drawHull(ctx, null, "#7aa6cc");
      ctx.fillStyle = "#3f7fb8";
      ctx.fillRect(4, 30, 40, 4);
      break;
    default:
      drawHull(ctx, null, "#5b7794");
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
  try {
    // `tag` so a reconnect that re-announces an open gate replaces its own
    // notification instead of stacking a second copy of the same question.
    new Notification(title, { body, tag: `drydock-gate-${requestId}` });
  } catch {
    /* notification construction can throw on some platforms; never fatal */
  }
}
