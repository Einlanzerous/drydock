// DRY-85: the backlog control is a switch, and it does not dim on a pull
// nobody asked for.
//
// Why a browser. Both halves are claims about a control's appearance over time.
// curl cannot see a class, and the daemon cannot see the distinction being
// made at all — which gesture started a pull exists only in the shell, and the
// route it hits is byte-identical either way.
//
// Why `hang` is load-bearing. Against the fixture tracker a pull settles in
// single-digit milliseconds, so "was the control disabled while it ran" is a
// race the harness loses: it samples after the window closed, reports a clean
// pass, and would do so against the bug just as happily. Parking the pull at
// the proxy gives that window a beginning and an end, and asserting `held > 0`
// at the moment of the check is what proves the harness was looking while a
// pull really was in flight rather than after it finished. Every check below
// that claims "during a pull" carries that proof with it.
//
// The background pull under test is the real 20s poll, not a synthesised one.
// It is the poll the ticket is about ("dims on EVERY background poll"), and
// faking a visibility wake would test a different entry point into the same
// function while leaving the reported symptom unobserved.
//
// Setup + overrides: see README.md. Run from `daemon/` like the other .mts
// harnesses, so tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/backlog-toggle.mts)
import { chromium, type Page } from "playwright";
// The proxy's own declaration of what it serves, rather than a copy of it here
// (DRY-80). `import type` erases, so this does not start a second proxy.
import type { ProxyTrackerState } from "./proxy-tracker.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5375";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4375";


let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string): Promise<ProxyTrackerState> =>
  fetch(`${PROXY}${p}`, { method: "POST" }).then((r) => r.json() as Promise<ProxyTrackerState>);
const state = (): Promise<ProxyTrackerState> =>
  fetch(`${PROXY}/__state`).then((r) => r.json() as Promise<ProxyTrackerState>);

/** Seconds waited, or null on timeout — so a caller can report which it was. */
async function waitFor(fn: () => Promise<boolean>, ms = 40_000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(200);
  }
  return null;
}

/** What the scope row's controls look like right now. */
type Snapshot = {
  present: boolean;
  busy: boolean;
  disabled: boolean;
  spinning: boolean;
  track: boolean;
  thumb: boolean;
  on: boolean;
  checked: boolean;
  type: string | null;
  display: string | null;
  visibility: string | null;
  groups: number;
};

/**
 * Every `page.evaluate` body in this file is a STRING, not a function — the
 * same constraint `auth.mts` documents at length. `tsx`'s esbuild transform
 * wraps named functions in a `__name(...)` helper (keepNames), and Playwright
 * ships an evaluate body to the browser as SOURCE, where that helper does not
 * exist. It fails as `ReferenceError: __name is not defined` from inside the
 * page, pointing at a line that reads perfectly well. Strings aren't
 * transformed, so they cross intact.
 */
const SNAP_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const label = q(".sidebar .backlog");
  const input = q(".sidebar .backlog input");
  const cs = input ? getComputedStyle(input) : null;
  return {
    present: !!label,
    // The two ways the old control announced a fetch.
    busy: !!(label && label.classList.contains("busy")),
    disabled: !!(input && input.disabled),
    spinning: !!q(".sidebar .refresh.spinning"),
    // The switch itself.
    track: !!q(".sidebar .backlog .sw"),
    thumb: !!q(".sidebar .backlog .sw i"),
    on: !!(label && label.classList.contains("on")),
    checked: !!(input && input.checked),
    type: input ? input.getAttribute("type") : null,
    // Hidden must mean "painted over", not "removed": \`display:none\` and
    // \`visibility:hidden\` both drop it off the tab order and out of the
    // accessibility tree, leaving a switch only a mouse can operate.
    display: cs ? cs.display : null,
    visibility: cs ? cs.visibility : null,
    groups: document.querySelectorAll(".sidebar .grp").length,
  };
})()`;

// A switch a keyboard cannot reach is a worse control than the checkbox it
// replaced, and nothing else in this file would notice.
const FOCUS_JS = `(() => {
  const i = document.querySelector(".sidebar .backlog input");
  if (!i) return false;
  i.focus();
  return document.activeElement === i;
})()`;

function snap(page: Page): Promise<Snapshot> {
  return page.evaluate(SNAP_JS) as Promise<Snapshot>;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

try {
  await post("/__heal");
  await page.goto(SHELL);
  await page.waitForSelector(".sidebar .backlog", { timeout: 15_000 });
  await waitFor(async () => (await snap(page)).groups > 0, 15_000);

  console.log("\n(a) it is a switch, and still a checkbox underneath");
  let s = await snap(page);
  check("the track and thumb render", s.track && s.thumb);
  check("the control is still an <input type=checkbox>", s.type === "checkbox", s.type ?? "(none)");
  check("it is not display:none", s.display !== "none", s.display ?? "?");
  check("it is not visibility:hidden", s.visibility !== "hidden", s.visibility ?? "?");
  const focused = (await page.evaluate(FOCUS_JS)) as boolean;
  check("it takes focus", focused);
  check("off to begin with", !s.on && !s.checked);

  console.log("\n(b) a BACKGROUND poll leaves it alone — the regression");
  await post("/__break?mode=hang");
  // Wait for the 20s poll to fire and park at the proxy. Until `held` moves,
  // there is no pull in flight and every assertion below would be vacuous.
  const waited = await waitFor(async () => (await state()).held > 0, 40_000);
  check("the poll fired and is parked mid-flight", waited !== null, waited === null ? "never parked" : `after ${waited}s`);
  const during = await state();
  s = await snap(page);
  check("a pull really is in flight for these checks", during.held > 0, JSON.stringify(during));
  check("the backlog control does NOT dim", !s.busy);
  check("the backlog control does NOT disable", !s.disabled);
  check("the refresh button does NOT spin", !s.spinning);
  check("it still reads as off", !s.on && !s.checked);

  console.log("\n(c) the race guard survives, narrowed to a scope change");
  await post("/__heal");
  // Let the aborted poll's failure drain before asking for anything else.
  await waitFor(async () => (await state()).held === 0, 20_000);
  await sleep(500);
  await post("/__break?mode=hang");
  // The LABEL, not `.sw`. Both builds have a label and clicking it toggles the
  // input either way, so against an unpatched shell this section reports what
  // it found instead of dying on a missing selector — a harness that throws
  // half way through is one you cannot read the discrimination off.
  await page.click(".sidebar .backlog");
  const parked = await waitFor(async () => (await state()).held > 0, 20_000);
  check("the toggle's own pull is parked mid-flight", parked !== null, parked === null ? "never parked" : `after ${parked}s`);
  s = await snap(page);
  check("the control dims while ITS pull is in flight", s.busy);
  check("and is disabled, so a re-toggle can't race it", s.disabled);
  check("the switch shows the new state immediately", s.on && s.checked);

  console.log("\n(d) and it comes back");
  await post("/__heal");
  const cleared = await waitFor(async () => !(await snap(page)).busy, 30_000);
  check("the lock clears once the pull settles", cleared !== null, cleared === null ? "still locked" : `after ${cleared}s`);
  s = await snap(page);
  check("still usable", !s.disabled);
} finally {
  await browser.close();
  await post("/__heal").catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
