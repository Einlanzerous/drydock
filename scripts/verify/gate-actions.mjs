/**
 * DRY-78 — the permission gate's action row must stay inside its panel.
 *
 * The row holds an escape link, up to three buttons, and no `flex-wrap`, and
 * `.panel` has no `overflow` to clip what spills. One button's width is
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
 * Three assertions per control, because each catches a different width:
 *
 *   inPanel   — the rect lies inside `.panel`'s rect. The one that works at a
 *               wide viewport, where the spill renders outside the panel but
 *               still inside the window, so the two below pass over the bug.
 *   inView    — the rect lies inside the viewport. The narrow-viewport case,
 *               where the spill leaves the screen entirely.
 *   hittable  — `elementFromPoint` at the rect's centre lands on the control.
 *               DRY-74's lesson: `getBoundingClientRect()` is healthy whether
 *               or not anything can reach the element.
 *
 * Rig: see README. Usage:
 *   node scripts/verify/gate-actions.mjs [shellUrl] [daemonUrl]
 */
import { chromium } from "./node_modules/playwright/index.mjs";

const SHELL = process.argv[2] ?? "http://127.0.0.1:5399";
const DAEMON = process.argv[3] ?? "http://127.0.0.1:4399";

/**
 * The tool names the row is measured against.
 *
 * `Bash` is here to be the control, not for coverage: every gate you meet by
 * hand while testing is a short builtin and they all fit, which is exactly how
 * this shipped. A run that passes on Bash and fails on the MCP name has
 * reproduced the bug; one that fails on both has broken something else.
 */
const TOOLS = [
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
 * `.panel` is `width: 604px; max-width: calc(100vw - 40px)` anchored at
 * `left: 12px`, so it is NOT centred and the spill is asymmetric — the widths
 * below straddle the point where max-width takes over (644px) for that reason.
 * The heights straddle the desk's own room: the panel grows UPWARD out of a
 * 98px rail, so a taller row costs headroom rather than reach.
 */
const VIEWPORTS = [
  { w: 1600, h: 900 },
  { w: 1200, h: 800 },
  { w: 900, h: 700 },
  { w: 700, h: 620 },
  { w: 560, h: 560 },
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, init) {
  const res = await fetch(`${DAEMON}${path}`, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

/**
 * Raise a real gate and DON'T await it — the endpoint holds the connection open
 * until somebody answers, which is the behaviour under test. The returned
 * promise is settled by the answer at the end of the scenario; it is kept only
 * so an unhandled rejection can't take the run down.
 */
function raiseGate(sessionId, tool, command) {
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
async function measureRow(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".panel");
    if (!panel) return { error: "no .panel" };
    const p = panel.getBoundingClientRect();
    // The line naming the tool in full. It is measured because it is what makes
    // truncating the button honest — if this is cut too, the panel never says
    // what is being approved.
    const askEl = panel.querySelector(".ask");
    const ask = askEl ? askEl.getBoundingClientRect() : null;
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
      ask: ask && { overflow: askEl.scrollWidth - askEl.clientWidth },
      controls,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

function assertRow(tag, m) {
  if (m.error) {
    check(`${tag} panel present`, false, m.error);
    return;
  }
  // Sub-pixel layout: a rect can land a hair outside a container it is flush
  // with. 1px of slack keeps that from reading as a 159px overflow.
  const EPS = 1;
  for (const c of m.controls) {
    const overflowRight = c.rect.right - m.panel.right;
    const overflowLeft = m.panel.left - c.rect.left;
    const inPanel = overflowRight <= EPS && overflowLeft <= EPS;
    check(
      `${tag} · "${c.label}" inside panel`,
      inPanel,
      inPanel ? "" : `spills ${Math.max(overflowRight, overflowLeft).toFixed(0)}px`,
    );

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
  const topVisible = m.panel.top >= -EPS;
  check(
    `${tag} · panel top not clipped`,
    topVisible,
    topVisible ? "" : `top ${m.panel.top.toFixed(0)}px, height ${m.panel.height.toFixed(0)}px`,
  );
}

const browser = await chromium.launch();
let sessionId = null;
try {
  // An AUTONOMOUS run: `orphanGates` is what the rail's panel renders, and a
  // gate is an orphan when its session has no pane. A windowed session's gate
  // goes to PermissionPrompt.vue inside the terminal instead — a different
  // component with a different action row.
  const spawned = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "/bin/sh",
      args: ["-c", "while :; do sleep 1; done"],
      autonomous: true,
      title: "DRY-78",
    }),
  });
  sessionId = spawned.id ?? spawned.session?.id;
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
      await page.waitForSelector(".panel .actions button", { timeout: 15000 });
      if (tool.expand) await page.click('.panel .truncation button:has-text("Show all")');
      // The panel's own transition, plus the rail's post-flush re-measure.
      await page.waitForTimeout(350);

      const tag = `${vp.w}x${vp.h} ${tool.key}`;
      assertRow(tag, await measureRow(page));

      // Deny mode swaps the whole row for [Cancel, Send denial] (DRY-73) — a
      // different set of controls at a different width, so it is measured
      // rather than assumed to be narrower.
      await page.click('.panel .actions button:has-text("Deny…")');
      await page.waitForSelector(".panel .reason input");
      assertRow(`${tag} denying`, await measureRow(page));
      await page.click('.panel .actions button:has-text("Cancel")');
      await page.waitForTimeout(100);

      // Answer it so the next scenario starts from a clean panel; the held hook
      // connection settles here.
      await page.click('.panel .actions button:has-text("Approve")');
      await page.waitForSelector(".panel", { state: "detached", timeout: 15000 });
      await flight;
    }
  }
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
