/**
 * DRY-78 — the permission gate's action row must stay inside its panel.
 *
 * The row holds an escape link and up to three buttons. One of those buttons is
 * DATA-DRIVEN — `Always allow {{ gate.tool }}` — and an MCP tool name is a
 * single unbreakable token (`mcp__switchyard__transition_ticket_by_category`
 * is 44 characters), so the row's width depends on which tool the agent
 * happened to call. That is why this reproduces intermittently by hand and
 * why the harness drives the tool name rather than hoping to meet one.
 *
 * Unlike DRY-74's spawn panel, this one BLOCKS: an autonomous run is parked on
 * a PreToolUse hook waiting for the answer, and `Approve ↵` is last in the row,
 * so it is the first thing to leave.
 *
 * Three assertions per control, because each catches a different failure:
 *
 *   inPanel   — the rect lies inside `.panel`'s rect, on all FOUR edges. The
 *               horizontal pair is the wide-viewport case, where the spill
 *               leaves the panel but not the window so the two below pass over
 *               it. The vertical pair is the short-desk case: the panel is
 *               anchored by its bottom and capped in height, so without an
 *               `overflow` backstop the surplus renders past that edge and
 *               under the rail instead of clipping — and the panel's own rect
 *               can't show that, since it stays the size of the cap.
 *   inView    — the rect lies inside the viewport. The narrow-viewport case,
 *               where the panel itself left the screen.
 *   hittable  — `elementFromPoint` at the rect's centre lands on the control.
 *               DRY-74's lesson: `getBoundingClientRect()` is healthy whether
 *               or not anything can reach the element.
 *
 * The `page.evaluate` bodies here are functions rather than strings, and that
 * is checked rather than assumed: tsx's esbuild transform only wraps NAME-BOUND
 * functions in its `__name(...)` helper, and neither body below binds one (see
 * the note at the top of surface.mts). Adding a `const q = (s) => …` inside one
 * would break it in the page with `ReferenceError: __name is not defined`.
 *
 * Rig: see README. Usage, run from `daemon/` where tsx resolves (DRY-80):
 *   (cd daemon && node --import tsx ../scripts/verify/gate-actions.mts [shellUrl] [daemonUrl])
 */
import { chromium, type Page } from "playwright";
import type { SpawnResponse } from "./api.mjs";

const SHELL = process.argv[2] ?? "http://127.0.0.1:5378";
const DAEMON = process.argv[3] ?? "http://127.0.0.1:4378";

/**
 * The gate panel, and NOT `.panel` — `TicketDetail.vue` and `MarkdownPane.vue`
 * both use that as their root class, so the bare selector picks whichever the
 * desk happens to hold. RunRail's own code reaches this element through the
 * component instance for the same reason.
 */
const PANEL = ".rail > .panel";

/** One row of the tool table below. `expand` clicks "Show all" on the blob. */
interface ToolCase {
  key: string;
  name: string;
  command: string;
  expand?: boolean;
}

/**
 * The tool names the row is measured against.
 *
 * `Bash` is here to be the control, not for coverage: every gate you meet by
 * hand while testing is a short builtin and they all fit, which is exactly how
 * this shipped. A run that passes on Bash and fails on the MCP name has
 * reproduced the bug; one that fails on both has broken something else.
 */
const TOOLS: ToolCase[] = [
  { key: "builtin", name: "Bash", command: "echo hi" },
  { key: "mcp", name: "mcp__switchyard__transition_ticket_by_category", command: "echo hi" },
  // The vertical worst case. The panel grows UPWARD out of the rail, so the
  // height a wrapped row costs comes out of the headroom the argument needs —
  // and `expand` clicks "Show all", which is the tallest the blob can get
  // (`.blob.expanded` caps at 186px and scrolls past that). A wrapped action
  // row plus a fully expanded argument is the combination that decides whether
  // widening the row's tolerance was paid for out of the panel's top edge.
  {
    key: "mcp+blob",
    name: "mcp__switchyard__transition_ticket_by_category",
    command: Array.from({ length: 40 }, (_, i) => `step_${i} --with --several --flags`).join("\n"),
    expand: true,
  },
];

/**
 * The panel is `width: 604px` anchored at `left: 12px`, so it is NOT centred
 * and the spill is asymmetric — the widths below straddle the point where its
 * max-width takes over for that reason. The heights straddle the desk's own
 * room: the panel grows UPWARD out of a 98px rail, so a taller row costs
 * headroom rather than reach.
 */
const VIEWPORTS: { w: number; h: number }[] = [
  { w: 1600, h: 900 },
  { w: 1200, h: 800 },
  { w: 900, h: 700 },
  { w: 700, h: 620 },
  { w: 560, h: 560 },
  // Short enough that the panel CANNOT fit however the row is arranged, which
  // is the only place the height cap's `overflow` backstop is load-bearing.
  // Without one the surplus doesn't clip — the panel is anchored by its bottom,
  // so the action row renders past that edge and under the rail. Nothing above
  // 500px of viewport reaches this: at 560 the panel still fits with room over.
  { w: 900, h: 430 },
  { w: 640, h: 380 },
];

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}
const results: Result[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
async function api<T,>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON}${path}`, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/**
 * Raise a real gate and DON'T await it — the endpoint holds the connection open
 * until somebody answers, which is the behaviour under test. The returned
 * promise is settled by the answer at the end of the scenario; it is kept only
 * so an unhandled rejection can't take the run down.
 */
function raiseGate(sessionId: string, tool: string, command: string): Promise<Response | null> {
  return fetch(`${DAEMON}/hook/pretooluse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-drydock-session": sessionId },
    body: JSON.stringify({
      tool_name: tool,
      tool_input: { command },
      permission_mode: "default",
    }),
  }).catch(() => null);
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Control {
  label: string;
  rect: Box & { width: number };
  hittable: boolean;
}
/** A successful measurement of the action row and everything it is measured against. */
interface Measured {
  panel: Box & { height: number };
  ask: { overflow: number } | null;
  controls: Control[];
  desk: { top: number; bottom: number } | null;
  viewport: { w: number; h: number };
}
type RowMeasure = { error: string } | Measured;

/**
 * Measure every control in the gate's action row.
 *
 * Runs in the page so `elementFromPoint` is a real hit test rather than
 * arithmetic over rects — the two disagree exactly when something is covering
 * the control, which on this surface is a live possibility: the rail draws a
 * gradient scrim over the desk's bottom 98px and is `pointer-events: none`, so
 * a hit-test failure here can mean a missing `pointer-events: auto` rather than
 * a layout overflow.
 */
async function measureRow(page: Page): Promise<RowMeasure> {
  return page.evaluate((sel): RowMeasure => {
    const panel = document.querySelector(sel);
    if (!panel) return { error: `no ${sel}` };
    const p = panel.getBoundingClientRect();
    // The DESK's rect, not the viewport's. `.desk` is what clips — it starts
    // below a 54px topbar plus whatever notices are in the flex column above it
    // — so a panel whose top is at y=20 is comfortably on screen and entirely
    // cut off. Measuring the clip against the window is the same error the
    // panel's own `max-width: calc(100vw - 40px)` made on the other axis.
    const deskEl = document.querySelector(".desk");
    const desk = deskEl ? deskEl.getBoundingClientRect() : null;
    // The line naming the tool in full. It is measured because it is what makes
    // truncating the button honest — if this is cut too, the panel never says
    // what is being approved.
    const askEl = panel.querySelector(".ask");
    const controls = [...panel.querySelectorAll(".actions button")].map((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        label: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40),
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width },
        // A descendant counts: the fix wraps the tool name in a <span>, and a
        // hit landing on that span is a hit on the button.
        hittable: !!hit && (hit === el || el.contains(hit)),
      };
    });
    return {
      panel: { left: p.left, right: p.right, top: p.top, bottom: p.bottom, height: p.height },
      // scrollWidth vs clientWidth, not the rect: the element is a block that
      // fills the panel either way, so its own rect is inside by construction
      // while the unbreakable token inside it hangs out over the edge.
      ask: askEl ? { overflow: askEl.scrollWidth - askEl.clientWidth } : null,
      controls,
      desk: desk && { top: desk.top, bottom: desk.bottom },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }, PANEL);
}

function assertRow(tag: string, m: RowMeasure): void {
  if ("error" in m) {
    check(`${tag} panel present`, false, m.error);
    return;
  }
  // Sub-pixel layout: a rect can land a hair outside a container it is flush
  // with. 1px of slack keeps that from reading as a 159px overflow.
  const EPS = 1;
  for (const c of m.controls) {
    // All four edges. The vertical pair is not symmetry for its own sake: the
    // panel is anchored by its BOTTOM and capped in height, so a cap without an
    // `overflow` backstop doesn't clip the surplus — the action row renders past
    // the panel's bottom edge and under the rail's lanes, unreachable again by a
    // different route. The panel's own rect can't show that, because it stays
    // the size of the cap while its content leaves; only the controls can.
    const spillRight = c.rect.right - m.panel.right;
    const spillLeft = m.panel.left - c.rect.left;
    const spillBelow = c.rect.bottom - m.panel.bottom;
    const spillAbove = m.panel.top - c.rect.top;
    const worst = Math.max(spillRight, spillLeft, spillBelow, spillAbove);
    check(`${tag} · "${c.label}" inside panel`, worst <= EPS, worst <= EPS ? "" : `spills ${worst.toFixed(0)}px`);

    const inView =
      c.rect.left >= -EPS &&
      c.rect.right <= m.viewport.w + EPS &&
      c.rect.top >= -EPS &&
      c.rect.bottom <= m.viewport.h + EPS;
    check(
      `${tag} · "${c.label}" inside viewport`,
      inView,
      inView ? "" : `rect ${c.rect.left.toFixed(0)}..${c.rect.right.toFixed(0)} of ${m.viewport.w}`,
    );

    check(`${tag} · "${c.label}" hittable`, c.hittable);
  }

  if (m.ask) {
    check(
      `${tag} · tool name not cut from the body`,
      m.ask.overflow <= EPS,
      m.ask.overflow <= EPS ? "" : `overflows its line by ${m.ask.overflow}px`,
    );
  }

  // The panel grows UPWARD out of the rail into a `.desk` that is
  // `overflow: hidden`, so every row the fix adds is headroom spent. A clipped
  // top takes the header and the argument blob — you'd be approving a command
  // you can no longer read, which is worse than a button you can't reach.
  //
  // Against the DESK's top, not the viewport's: the desk starts 54px down and
  // lower still with a notice up, so `top >= 0` passes for a panel with its
  // header already cut. The first version of this check made exactly that
  // mistake and would have passed against the bug it was written for.
  if (m.desk) {
    const over = m.desk.top - m.panel.top;
    check(
      `${tag} · panel top not clipped`,
      over <= EPS,
      over <= EPS ? "" : `${over.toFixed(0)}px above the desk, panel ${m.panel.height.toFixed(0)}px`,
    );
  }
}

const browser = await chromium.launch();
let sessionId: string | null = null;
try {
  // An AUTONOMOUS run: `orphanGates` is what the rail's panel renders, and a
  // gate is an orphan when its session has no pane. A windowed session's gate
  // goes to PermissionPrompt.vue inside the terminal instead — a different
  // component with a different action row.
  const spawned = await api<SpawnResponse & { id?: string }>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "/bin/sh",
      args: ["-c", "while :; do sleep 1; done"],
      autonomous: true,
      title: "DRY-78",
    }),
  });
  sessionId = spawned.id ?? spawned.session?.id ?? null;
  if (!sessionId) throw new Error(`no session id in ${JSON.stringify(spawned)}`);
  console.log(`session ${sessionId}\n`);

  const page = await browser.newPage({
    viewport: { width: VIEWPORTS[0].w, height: VIEWPORTS[0].h },
  });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar");

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    for (const tool of TOOLS) {
      const flight = raiseGate(sessionId, tool.name, tool.command);
      await page.waitForSelector(`${PANEL} .actions button`, { timeout: 15000 });
      if (tool.expand) await page.click(`${PANEL} .truncation button:has-text("Show all")`);
      // The panel's own transition, plus the rail's post-flush re-measure.
      await page.waitForTimeout(350);

      const tag = `${vp.w}x${vp.h} ${tool.key}`;
      assertRow(tag, await measureRow(page));

      // Deny mode swaps the whole row for [Cancel, Send denial] (DRY-73) — a
      // different set of controls at a different width, so it is measured
      // rather than assumed to be narrower.
      await page.click(`${PANEL} .actions button:has-text("Deny…")`);
      await page.waitForSelector(`${PANEL} .reason input`);
      assertRow(`${tag} denying`, await measureRow(page));
      await page.click(`${PANEL} .actions button:has-text("Cancel")`);
      await page.waitForTimeout(100);

      // Answer it so the next scenario starts from a clean panel; the held hook
      // connection settles here.
      await page.click(`${PANEL} .actions button:has-text("Approve")`);
      await page.waitForSelector(PANEL, { state: "detached", timeout: 15000 });
      await flight;
    }
  }

  // --- the desk's height changing WITHOUT the viewport's --------------------
  // The height cap is derived from the desk, and App.vue's notices are in the
  // flex column above it — they push it down. That is the case a `100vh` calc
  // would have got wrong, and the only one that separates "reads the desk" from
  // "reads the window", so every viewport above passes either way.
  //
  // A real tracker outage raises it, via the path App.vue actually uses. (The
  // sidebar is deliberately NOT varied: `sidebarOpen` is a `ref(true)` nothing
  // toggles, so the app cannot vary it either — and the fix made the panel's
  // width relative to the rail, which is why the sidebar stopped mattering.)
  await page.route("**/api/tracker/tickets*", (r) => r.fulfill({ status: 502, body: "{}" }));
  await page.setViewportSize({ width: 900, height: 560 });
  await page.waitForFunction(() => !!document.querySelector(".notice"), null, { timeout: 40000 });
  await page.waitForTimeout(400);
  // Asserted geometrically rather than as a before/after delta: a notice raised
  // earlier in the run (the poll fails on its own schedule) makes "before"
  // already-shortened, and the round then reports itself unarmed while being
  // perfectly armed. That the desk's top meets the notice's bottom is the
  // property either way — it is what makes the desk shorter than the window.
  const armed = await page.evaluate(() => {
    const n = [...document.querySelectorAll(".notice")].pop();
    const d = document.querySelector(".desk");
    if (!n || !d) return null;
    const nb = n.getBoundingClientRect(), db = d.getBoundingClientRect();
    return {
      gap: Math.abs(db.top - nb.bottom),
      pushed: db.top - 55, // .topbar is 54px + 1px border
      text: (n.textContent ?? "").trim().slice(0, 60),
    };
  });
  check(
    "notice sits above the desk and shortens it",
    !!armed && armed.gap <= 1 && armed.pushed > 0,
    armed ? `desk pushed ${armed.pushed.toFixed(0)}px below the topbar — "${armed.text}"` : "no notice",
  );

  const noticeFlight = raiseGate(sessionId, TOOLS[2].name, TOOLS[2].command);
  await page.waitForSelector(`${PANEL} .actions button`, { timeout: 15000 });
  await page.click(`${PANEL} .truncation button:has-text("Show all")`);
  await page.waitForTimeout(350);
  assertRow("900x560 notice-up mcp+blob", await measureRow(page));
  await page.click(`${PANEL} .actions button:has-text("Approve")`);
  await page.waitForSelector(PANEL, { state: "detached", timeout: 15000 });
  await noticeFlight;
} finally {
  if (sessionId) {
    await api(`/api/sessions/${sessionId}/kill`, { method: "POST" }).catch(() => {});
  }
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.log(`\n${failed.length} failed:`);
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
