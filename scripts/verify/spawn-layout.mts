// A spawn ADDS a window to the desk you are on (DRY-93).
//
// Three spawn paths called `wm.setLayout("float")` on their way past — the
// palette's pinned rows (`spawnFresh`), the ticket panel's Spawn Agent
// (`spawnWorkspace`) and the rail's Watch (`watchRun`) — so a Tile or Focus
// desk was re-scattered every time a session appeared. All three are driven
// here, because a fix that covers only the palette looks identical from the
// ticket panel.
//
// Two things are asserted per path, and the first alone would be worthless:
//
//   1. the layout mode is untouched — on the switcher AND on what the daemon
//      was told, since the mode is persisted and a desk that snapped to float
//      writes "float" to `/api/workspace`;
//   2. the new window is actually ON SCREEN, in the terms of that mode. Check
//      only (1) and this passes against a focus-mode spawn filed in the
//      thumbnail strip, or a tile-mode one left at a float rect on top of a
//      neighbour: a layout that did not change, and a window you cannot see.
//
// Sections D and D′ are the second-order half, and are why this isn't
// cosmetic. `setLayout` sets `arranged`, the flag DRY-28's conflict rule reads
// as "a HUMAN shaped this desk"; a spawn must not set it. Nothing exposes the
// flag, so it is read through the only thing it decides — an outage that began
// before the first read heals, and whose desk wins. D′ is the control: a
// switcher click during the same outage must still win, or D would pass
// against a flag nothing ever sets, including one deleted outright.
//
// RIG (three terminals). The stub `claude` matters — `spawnWorkspace` spawns a
// bare `claude`, and with no shim that is the real CLI on whatever host this is:
//
//   bunx playwright install chromium         # once per machine
//
//   mkdir -p /tmp/dry93-bin
//   printf '#!/bin/sh\nexec node --import %s/node_modules/tsx/dist/loader.mjs %s/scripts/verify/stub-cli.mts "$@"\n' \
//     "$PWD" "$PWD" > /tmp/dry93-bin/claude && chmod +x /tmp/dry93-bin/claude
//
//   mkdir -p /tmp/dry93-repos/switchyard    # NOT a git dir, so no worktree is offered
//
//   (cd daemon && PATH="/tmp/dry93-bin:$PATH" \
//      DRYDOCK_PORT=4393 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d93 \
//      DRYDOCK_STATE_FILE=/tmp/dry93-state.json DRYDOCK_TRACKER=fixture \
//      DRYDOCK_REPO_PATHS=switchyard=/tmp/dry93-repos/switchyard \
//      DRYDOCK_CLEAR_FINISHED_AFTER_MS=0 \
//      DRYDOCK_WORKTREES_ROOT=/tmp/dry93-wt DRYDOCK_WORKTREE_REAP_MS=0 \
//      node --import tsx src/index.ts &)
//   (cd shell && VITE_DAEMON_URL=http://127.0.0.1:4393 bunx vite --port 5393 --strictPort &)
//
//   (cd daemon && node --import tsx ../scripts/verify/spawn-layout.mts)
//
// `DRYDOCK_CLEAR_FINISHED_AFTER_MS=0` turns DRY-60's sweep off. Left on, a
// window this file counts can be taken mid-round by something with nothing to
// do with this ticket.
//
// The two worktree knobs are not this ticket's business and are here anyway:
// left at their defaults, a throwaway daemon boots pointed at the HOST's real
// worktrees root and runs DRY-90's sweep over other agents' checkouts. It kept
// all nine of them, correctly — liveness is read from every daemon's index —
// but that is a policy this rig has no reason to be relying on.
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a NAME to a
// function — tsx's transform wraps those in a `__name(...)` helper the page
// does not have. Anonymous inline arrows cross intact.
//
// VERBOSE=1 prints every rectangle it measures.
//
// Afterwards: `rm -rf /tmp/d93 /tmp/dry93-*`, and kill the supervisors it
// leaves behind (CLAUDE.md's loop over /proc/<pid>/exe, never
// `pkill -f supervisor/main`).
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Detail, SessionsResponse, WorkspaceResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5393";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4393";
/** A flat fixture ticket in a repo the daemon can resolve — no epic to expand. */
const TICKET = process.env.TICKET ?? "SWY-12";
/** Mirrors RAIL_HEIGHT in useWindowManager.ts — the strip tile/focus may not use. */
const RAIL_HEIGHT = 98;
/** The managed layouts animate (`all .26s`), so nothing is measured before this. */
const SETTLE_MS = 1000;
const VERBOSE = process.env.VERBOSE === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
const j = async <T,>(u: string, init?: RequestInit): Promise<T> =>
  (await fetch(u, init)).json() as Promise<T>;

let failures = 0;
let ran = 0;
/**
 * Counts as well as reports, and the summary prints both numbers.
 *
 * The README's discrimination note is "N of M failed against the pre-fix tree",
 * and that is how a later reader tells "still discriminates" from "a section
 * stopped running". A denominator counted by hand is one that can be wrong the
 * day it is written.
 */
function check(name: string, ok: boolean, detail: Detail = ""): void {
  ran++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Frame extends Rect {
  /** The bar carries `.focused` for `wm.focusedId` — the window you are in. */
  focused: boolean;
  ticket: string;
}

/**
 * Every window's rectangle as the BROWSER lays it out, in viewport coordinates.
 *
 * Not the saved model: a desk that persisted "tile" and painted float rects is
 * exactly the failure a model-only check cannot see. These are viewport
 * coordinates and the saved ones are desk-relative, so the two are never
 * compared directly — `deskRect` is the origin where a comparison is needed.
 */
const frames = (page: Page): Promise<Frame[]> =>
  page.$$eval(".frame", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        focused: !!e.querySelector(".bar.focused"),
        ticket: e.querySelector(".bar .ticket")?.textContent?.trim() ?? "",
      };
    }),
  );

const deskRect = (page: Page): Promise<Rect> =>
  page.$eval(".desk", (e) => {
    const r = e.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

/** The mode the SWITCHER says the desk is in. */
const activeMode = (page: Page): Promise<string> =>
  page
    .locator(".switcher button.active")
    .first()
    .textContent()
    .then((t) => (t ?? "").trim().toLowerCase());

/** The layout mode as the DAEMON holds it — the half of the desk a page's own
 *  header cannot vouch for, and the one that survives a reload. */
async function stored(): Promise<string> {
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  return workspace?.layout ?? "(nothing saved)";
}

async function spawn(body: unknown): Promise<string> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { session?: { id: string }; error?: string };
  if (!json.session) throw new Error(`spawn failed: ${json.error}`);
  return json.session.id;
}

/**
 * A clean desk before anything is measured.
 *
 * Both halves are load-bearing. A leftover SESSION puts a window on screen that
 * every count here attributes to this run; a saved WORKSPACE (DRY-28) restores
 * windows for sessions that died in the previous round — and, since the saved
 * layout MODE is this file's subject, would carry that round's mode into the
 * next one, where it reads as the mode having survived a spawn.
 */
async function reset(): Promise<void> {
  const { sessions } = await j<SessionsResponse>(`${DAEMON}/api/sessions`);
  for (const s of sessions) await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
  await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
  await sleep(600);
}

async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (VERBOSE && /drydock/.test(m.text())) console.log(`      [console] ${m.text().slice(0, 110)}`);
  });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar", { timeout: 15000 });
  return { ctx, page };
}

/** Wait until the desk shows exactly `n` windows. Never assert on a count you
 *  did not wait for: the 3s poll is what adds most of them. */
async function waitFrames(page: Page, n: number, ms = 25000): Promise<Frame[]> {
  const until = Date.now() + ms;
  let f = await frames(page);
  while (f.length !== n && Date.now() < until) {
    await sleep(250);
    f = await frames(page);
  }
  return f;
}

/**
 * Poll a predicate, returning the seconds it took (null on timeout).
 *
 * The budget is generous on purpose: the heals below sit behind DRY-58's
 * 5s→10s→20s backoff, and a tight timeout measures that schedule rather than
 * the rule under test.
 */
async function waitFor(fn: () => Promise<boolean>, ms = 60000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(700);
  }
  return null;
}

/** `waitFor`'s answer as a detail line. Reads as "after nulls" otherwise, on
 *  precisely the runs somebody is trying to diagnose. */
const took = (s: number | null) => (s === null ? "timed out" : `after ${s}s`);

const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2;

const inside = (f: Rect, d: Rect, bottomInset: number): boolean =>
  f.x >= d.x - 4 &&
  f.y >= d.y - 4 &&
  f.x + f.w <= d.x + d.w + 4 &&
  f.y + f.h <= d.y + d.h - bottomInset + 4;

const fmt = (f: Rect) => `${f.w}×${f.h} at ${f.x},${f.y}`;

/** Open the ticket panel from the sidebar. Repo groups render collapsed. */
async function openTicket(page: Page): Promise<void> {
  for (const g of await page.locator(".grp").all()) {
    await g.click();
    await sleep(150);
  }
  await page.locator(".row:not(.epic)").filter({ hasText: TICKET }).first().click();
  await page.waitForSelector("button.send", { timeout: 8000 });
  await sleep(600);
}

/**
 * One spawn, asserted in the terms of the mode the desk is in.
 *
 * `before` is the desk as it was and `n` what it must become. The mode-specific
 * half is where the real claim lives — "the layout mode is unchanged" is
 * satisfied by a window that never appeared at all.
 */
async function landed(
  page: Page,
  mode: string,
  label: string,
  before: Frame[],
  n: number,
  ticket = "",
): Promise<void> {
  const arrived = await waitFrames(page, n);
  check(`${label}: the desk shows ${n} windows`, arrived.length === n, `${arrived.length}`);
  await sleep(SETTLE_MS); // the layout transition, and the 400ms persist debounce
  const f = await frames(page);
  const desk = await deskRect(page);
  if (VERBOSE) console.log(`      [${mode}/${label}] desk ${fmt(desk)} · ${f.map(fmt).join(" | ")}`);

  check(`${label}: the switcher still says ${mode}`, (await activeMode(page)) === mode, await activeMode(page));
  // The persisted half, so this is asserted on what the daemon was TOLD and not
  // only on what the header renders. A desk that snapped to float and was put
  // back would still be caught here.
  const saved = await stored();
  check(`${label}: and the daemon was told ${mode}`, saved === mode, saved);
  if (f.length !== n) return; // everything below would be measuring the wrong window

  // `add()` appends, so the new window is the last frame — and it must also be
  // the focused one, which is the whole of "make sure it's visible" that the
  // removed `setLayout("float")` was standing in for.
  const isNew = f[f.length - 1];
  const focused = f.filter((w) => w.focused);
  check(
    `${label}: the new window is the focused one`,
    focused.length === 1 && focused[0] === isNew,
    `${focused.length} focused; last frame focused=${isNew.focused}`,
  );
  if (ticket) {
    check(`${label}: …and it is the window for ${ticket}`, isNew.ticket === ticket, isNew.ticket || "(no badge)");
  }

  if (mode === "tile") {
    check(
      `${label}: it is inside the desk, clear of the rail`,
      inside(isNew, desk, RAIL_HEIGHT),
      `${fmt(isNew)} in ${fmt(desk)}`,
    );
    // Uniform cells is what tiling MEANS, and it is the check a window dropped
    // at its own float rect fails — containment alone would pass it.
    const odd = f.filter((w) => Math.abs(w.w - isNew.w) > 3 || Math.abs(w.h - isNew.h) > 3);
    check(`${label}: every window is a cell of one grid`, odd.length === 0, odd.map(fmt).join(" | "));
    const hits = f.flatMap((a, i) =>
      f.slice(i + 1).filter((b) => overlap(a, b)).map((b) => `${fmt(a)} / ${fmt(b)}`),
    );
    check(`${label}: and nothing overlaps`, hits.length === 0, hits.join(" | "));
  } else if (mode === "focus") {
    check(
      `${label}: it is inside the desk, clear of the rail`,
      inside(isNew, desk, RAIL_HEIGHT),
      `${fmt(isNew)} in ${fmt(desk)}`,
    );
    // The case the ticket names: focus must bring the new window UP. Filed in
    // the strip, "the layout didn't change" is perfectly true and you still
    // cannot see what you just spawned.
    check(
      `${label}: it is the large pane, not a thumbnail`,
      isNew.w > desk.w * 0.5,
      `${isNew.w}px of ${desk.w}px`,
    );
    const strip = f.filter((w) => w !== isNew);
    check(
      `${label}: and the rest are the strip`,
      strip.every((w) => w.w < desk.w * 0.25 && w.x > desk.x + desk.w * 0.5),
      strip.map(fmt).join(" | "),
    );
  } else {
    // float: unchanged behaviour. The removed call was a no-op here — which is
    // exactly why the bug went unnoticed — so this round is a guard, not a fix.
    check(
      `${label}: it is on screen`,
      inside(isNew, desk, 0) && isNew.w > 200 && isNew.h > 120,
      `${fmt(isNew)} in ${fmt(desk)}`,
    );
    const moved = before.filter((b, i) => f[i].x !== b.x || f[i].y !== b.y || f[i].w !== b.w);
    check(`${label}: and the windows already there did not move`, moved.length === 0, moved.map(fmt).join(" | "));
  }
}

// ---------------------------------------------------------------- rounds ----

const browser = await chromium.launch();

for (const mode of ["tile", "focus", "float"]) {
  console.log(`\n${mode.toUpperCase()} — a spawn adds a window and leaves the mode alone`);
  await reset();
  const { ctx, page } = await open(browser);
  // Two windows first: a grid of one is a grid whatever the code does, and
  // "the ones already there didn't move" needs some.
  await spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], title: "one" });
  await spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], title: "two" });
  const seeded = await waitFrames(page, 2);
  check(`${mode}: two windows to start from`, seeded.length === 2, `${seeded.length}`);
  await page.locator(".switcher button").filter({ hasText: new RegExp(mode, "i") }).click();
  await sleep(SETTLE_MS);
  check(`${mode}: the desk is in ${mode}`, (await activeMode(page)) === mode, await activeMode(page));

  // 1. the palette's pinned row — spawnFresh
  let before = await frames(page);
  await page.locator(".controls button.new").click();
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette .row.pinrow").filter({ hasText: "Blank shell session" }).click();
  await landed(page, mode, "palette", before, 3);

  // 2. the ticket panel's Spawn Agent — spawnWorkspace
  before = await frames(page);
  await openTicket(page);
  await page.locator("button.send").click();
  await landed(page, mode, "ticket", before, 4, TICKET);

  // 3. the rail's Watch — watchRun
  before = await frames(page);
  await spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], title: "run", autonomous: true });
  await page.waitForSelector(".rail .card", { timeout: 15000 });
  await page.locator(".rail .card").first().click();
  await page.locator(".chooser button").filter({ hasText: "Watch" }).click();
  await landed(page, mode, "watch", before, 5);

  await ctx.close();
}

// -------------------------------------------------------------- the flag ----
//
// `setLayout` sets `arranged` on a real change, so while a spawn forced "float"
// every spawn from tile or focus also claimed a person had arranged this desk —
// in the one path that had just thrown their arrangement away. Nothing exposes
// the flag, so it is read through the only thing it decides: whose desk wins
// when the store heals after an outage that began before the first read
// (DRY-58, and DRY-28 property 7).
//
// THE DESK MUST NOT BE IN FLOAT WHEN THE SPAWN HAPPENS, and that is the whole
// difficulty. The forced call was `setLayout("float")`, which the guard makes a
// no-op in float — so a section run from the default mode passes against the
// bug, which is what the first cut of this one did. But reaching tile by
// clicking the switcher IS arranging, so the mode has to arrive some other way.
//
// It arrives from the local MIRROR: `apply()` assigns `layout.value` directly,
// deliberately, because putting somebody else's desk on screen is not this
// client arranging one. So the browser CONTEXT is reused between pages — same
// origin, same localStorage — and three different answers are set up, which is
// what makes each check legible:
//
//   the mirror says   tile    ← what this offline page comes up in
//   the daemon says   focus   ← the desk "arranged on the other machine"
//   D′ then clicks    float   ← this client, arranging, during the outage
async function arrangedRig(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page }> {
  await reset();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const first = await ctx.newPage();
  await first.goto(SHELL);
  await first.waitForSelector(".topbar", { timeout: 15000 });
  await spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], title: "one" });
  await spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], title: "two" });
  await waitFrames(first, 2);
  await first.locator(".switcher button").filter({ hasText: /tile/i }).click();
  await sleep(1200); // past the 400ms persist debounce, so the mirror holds tile
  await first.close();

  // The desk the daemon turns out to be holding — same windows, a mode this
  // browser has never been in, so "whose desk won" has a one-word answer.
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  if (!workspace) throw new Error("nothing was saved to /api/workspace — the rig is wrong");
  const res = await fetch(`${DAEMON}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: workspace.version, layout: "focus", windows: workspace.windows }),
  });
  if (!res.ok) throw new Error(`seeding the remote desk failed: ${res.status}`);

  // Same context (so the mirror survives), new page (so `mayPush` starts shut),
  // and the store unreachable from before its first read.
  const page = await ctx.newPage();
  await page.route("**/api/workspace", (route) => route.abort());
  await page.goto(SHELL);
  await page.waitForSelector(".topbar", { timeout: 15000 });
  await page.waitForSelector(".notice", { timeout: 15000 });
  await waitFrames(page, 2);
  return { ctx, page };
}

/** How many windows are laid out as the big focus pane — 1 in focus mode, 0
 *  in tile or float. Evidence the desk MOVED, not just that a label changed. */
async function bigPanes(page: Page): Promise<number> {
  const desk = await deskRect(page);
  return (await frames(page)).filter((f) => f.w > desk.w * 0.5).length;
}

console.log("\nD — a spawn is not somebody arranging this desk");
{
  const { ctx, page } = await arrangedRig(browser);
  check("the desk came up in the mirror's mode", (await activeMode(page)) === "tile", await activeMode(page));

  // The spawn under test. Nothing else about this client is touched — no drag,
  // no resize, no switcher click.
  await page.locator(".controls button.new").click();
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.locator(".palette .row.pinrow").filter({ hasText: "Blank shell session" }).click();
  const spawned = await waitFrames(page, 3);
  check("the spawn landed", spawned.length === 3, `${spawned.length} window(s)`);
  check("and the desk is still in tile", (await activeMode(page)) === "tile", await activeMode(page));

  await page.unroute("**/api/workspace");
  const healed = await waitFor(async () => (await activeMode(page)) === "focus");
  check("on heal the daemon's desk wins — the spawn did not count as arranging", healed !== null, took(healed));
  // The mode word is not enough on its own: assert the windows were actually
  // re-laid out, and that the daemon still holds the desk it started with
  // rather than this client's.
  check("…and the windows were actually re-laid out", (await bigPanes(page)) === 1, `${await bigPanes(page)} large pane(s)`);
  check("…and this desk was never written over it", (await stored()) === "focus", await stored());
  await ctx.close();
}

// The control. Without it, D passes against an `arranged` nothing ever sets —
// including a fix that deleted the flag rather than one that stopped spawns
// from latching it.
console.log("\nD′ — but changing the layout mode still is");
{
  const { ctx, page } = await arrangedRig(browser);
  check("the desk came up in the mirror's mode", (await activeMode(page)) === "tile", await activeMode(page));
  // Float, not focus: clicking the mode the daemon happens to hold would agree
  // with it by accident and prove nothing about who won.
  await page.locator(".switcher button").filter({ hasText: /float/i }).click();
  await sleep(SETTLE_MS);
  check("the switcher took", (await activeMode(page)) === "float", await activeMode(page));

  await page.unroute("**/api/workspace");
  const won = await waitFor(async () => (await stored()) === "float");
  check("this client's arrangement is what's persisted", won !== null, took(won));
  check("…and the daemon's desk was not applied over it", (await activeMode(page)) === "float", await activeMode(page));
  check("…so no window was promoted to a focus pane", (await bigPanes(page)) === 0, `${await bigPanes(page)} large pane(s)`);
  await ctx.close();
}

await reset();
await browser.close();
console.log(`\n${failures ? `${failures} FAILED of ${ran}` : `all ${ran} passed`}`);
process.exit(failures ? 1 : 0);
