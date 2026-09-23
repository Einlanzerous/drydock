// DRY-100: the desk's status messages are toasts, and a toast moves nothing.
//
// Four surfaces used to render as full-width rows in App.vue's flex column, so
// every one that appeared or cleared changed the height of `.body` — the
// sidebar and every window jumped under the cursor, and TerminalPane's
// ResizeObserver refitted every terminal for it. The claim is GEOMETRIC, so it
// is measured: `getBoundingClientRect` on `.body` and on every `.term` (the
// element the ResizeObserver watches) before a toast is raised, with it up, and
// after it clears. "The toast rendered" is never the assertion — that was true
// of the in-flow version too.
//
// The surfaces are raised through the shell's OWN code, by failing the network
// calls it makes rather than by reaching into it:
//
//   error      (poll)     GET /api/sessions answers 500 → the 3s poll's `error`
//   notice                the sidebar's Refresh against a tracker that answers
//                         502 with a paragraph → `setNotice("tracker", …)`
//   error      (action)   POST …/kill answers 500 → `actionError`
//   note                  closing a window whose worktree is reapable →
//                         `actionNote`. The REAL daemon reaps it; the harness
//                         only HOLDS the request so a baseline can be taken
//                         with the window already gone and the note not yet up.
//
// What is asserted beyond the geometry, each because it was a way for the
// obvious implementation to be wrong:
//
//   LIFECYCLE   a condition (poll error, notice) leaves by itself when its
//               owner clears it; an event (action error, note) survives the 3s
//               poll and leaves only on ✕ (DRY-51 — the poll's next success once
//               wiped the error raised on the line before it).
//   DISMISSAL   a dismissed condition STAYS dismissed while its owner keeps
//               re-reporting it, and comes back as a NEW toast once the owner
//               has cleared and re-raised it. `setNotice` is idempotent and
//               called by retry loops; a naive ✕ resurrects the toast on the
//               next call.
//   ARRIVAL     a toast that arrives does not move one that is already there.
//   FOCUS       raising one and clicking its ✕ leave `document.activeElement`
//               where it was — a terminal must keep its keyboard (DRY-58).
//   SEMANTICS   `role="alert"` on errors, `role="status"` on notes and notices.
//   DETAIL CAP  a notice's detail is still capped (`DETAIL_MAX`, DRY-58).
//   PLACEMENT   the stack does not overlap the rail.
//
// RIG (four terminals; the harness builds its own git fixture under /tmp/dry100,
// so nothing here touches a real repo). Started from INSIDE a Drydock session,
// the daemon must not inherit that session's DRYDOCK_* — see CLAUDE.md, "Real
// env wins", for the `env -u` form; the tell is /healthz saying
// `store.kind: "postgres"`.
//
//   (cd daemon && STUB_PORT=4367 node --import tsx ../scripts/verify/stub-tracker.mts)
//
//   cd daemon
//   DRYDOCK_PORT=4365 DRYDOCK_HOST=127.0.0.1 \
//     DRYDOCK_SESSIONS_DIR=/tmp/dry100-sessions/sessions-4365 \
//     DRYDOCK_STATE_FILE=/tmp/dry100-state.json \
//     DRYDOCK_WORKTREES_ROOT=/tmp/dry100/wt \
//     DRYDOCK_REPO_PATHS=demo=/tmp/dry100/demo,dry=/tmp/dry100/demo \
//     DRYDOCK_WORKTREE_REAP_MS=0 \
//     DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4367 \
//     DRYDOCK_SWITCHYARD_TOKEN=stub node --import tsx src/index.ts
//
//   cd shell && VITE_DAEMON_URL=http://127.0.0.1:4365 bunx vite --port 5365 --strictPort
//
//   (cd daemon && node --import tsx ../scripts/verify/toast-stack.mts)
//
// DRYDOCK_WORKTREE_REAP_MS=0 turns the SCHEDULED reaper off, so the note this
// raises is provably the close gesture's and not a timer's (see
// worktree-reap-ui.mts, which has the same setting for the same reason).
//
// Afterwards: `rm -rf /tmp/dry100 /tmp/dry100-sessions`, and kill the
// supervisors it leaves behind by the loop in CLAUDE.md — never
// `pkill -f supervisor/main`.
import { chromium, type Page } from "playwright";
import * as fs from "node:fs";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";
import { assertDaemonRoot, buildFixture } from "./git-fixture.mjs";
import { TOAST } from "./toast-dom.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5365";
const DAEMON = process.env.DAEMON_URL ?? "http://127.0.0.1:4365";
const WT = "/tmp/dry100/wt/demo-DRY-3";
// Comfortably more than two 3s polls: an event toast has to be seen surviving
// several, and a dismissal has to be seen surviving several re-reports.
const POLLS_MS = 7 * 1000;

let failures = 0;
function check(name: string, ok: boolean, extra: Detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => Promise<boolean>, ms = 12 * 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

async function spawn(body: unknown): Promise<string> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Partial<SpawnResponse> & { error?: string };
  if (!json.session) throw new Error(`spawn failed: ${json.error}`);
  return json.session.id;
}

// A clean desk before anything is measured. A leftover session is a window on
// screen that every count below would attribute to this run, and a saved
// workspace (DRY-28) restores windows for sessions that died days ago.
const list = (await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse;
for (const s of list.sessions) await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });

// A fresh repo every run — a worktree left dirty by the last one is REUSED and
// silently turns the reapable case into a refused one.
const fixture = buildFixture("/tmp/dry100");
await assertDaemonRoot(DAEMON, fixture.worktrees);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

// --- the faults ------------------------------------------------------------
// One handler per API family, each consulting a flag, so a fault is a boolean
// flipped from the script and never a route juggled mid-run. Everything not
// faulted falls through to the real daemon.
const fault = { poll: false, tracker: false, kill: false };
let reapGate: Promise<void> | null = null;
const JSON_HDR = "application/json";
// Longer than DETAIL_MAX (140), so the cap is exercised rather than assumed.
const LONG = `harness: tracker refused. ${"the migration ledger disagrees with the file on disk; ".repeat(8)}`;

await page.route(/\/api\/sessions(\?.*)?$/, (route) =>
  fault.poll && route.request().method() === "GET"
    ? route.fulfill({ status: 500, contentType: JSON_HDR, body: JSON.stringify({ error: "harness: session list refused" }) })
    : route.fallback(),
);
await page.route(/\/api\/sessions\/[^/]+\/kill$/, (route) =>
  fault.kill
    ? route.fulfill({ status: 500, contentType: JSON_HDR, body: JSON.stringify({ error: "harness: kill refused" }) })
    : route.fallback(),
);
await page.route(/\/api\/tracker\/tickets(\?.*)?$/, (route) =>
  fault.tracker
    ? route.fulfill({ status: 502, contentType: JSON_HDR, body: JSON.stringify({ error: LONG }) })
    : route.fallback(),
);
await page.route(/\/api\/worktrees\/reap$/, async (route) => {
  if (reapGate) await reapGate;
  await route.fallback();
});

// --- measuring --------------------------------------------------------------
interface Box { x: number; y: number; w: number; h: number }
interface Layout { body: Box; terms: Box[] }

/**
 * `.body`'s box and every terminal's. Page-relative on purpose: an in-flow
 * banner shifts `.body` DOWN without changing a size in its own coordinates, so
 * a measurement relative to the desk would see nothing move.
 *
 * Written without a named inner function — a `page.evaluate` body may not bind
 * one (README, "Running these").
 */
const measure = (): Promise<Layout> =>
  page.evaluate((): Layout => {
    const b = document.querySelector(".body")!.getBoundingClientRect();
    return {
      body: { x: b.x, y: b.y, w: b.width, h: b.height },
      terms: [...document.querySelectorAll(".term")].map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    };
  });

/**
 * A baseline worth comparing against: two samples half a second apart that
 * agree. A terminal's first fit lands after fonts load, so the first sample of a
 * fresh page is not the layout — and a baseline taken mid-settle turns every
 * comparison into noise.
 */
async function settled(): Promise<Layout> {
  let prev = JSON.stringify(await measure());
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const cur = JSON.stringify(await measure());
    if (cur === prev) return JSON.parse(cur) as Layout;
    prev = cur;
  }
  throw new Error("the layout never settled — nothing below can be trusted");
}

async function unchanged(label: string, before: Layout): Promise<void> {
  const after = await measure();
  const same = JSON.stringify(before) === JSON.stringify(after);
  check(
    label,
    same,
    same ? `${after.terms.length} terminal(s), body ${after.body.h}px tall` : `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`,
  );
}

const count = (sel: string) => page.locator(sel).count();
const texts = (sel: string) => page.locator(sel).allTextContents().then((t) => t.map((s) => s.trim()));
const box = (loc: ReturnType<Page["locator"]>) => loc.boundingBox();
const frames = (n: number) => until(async () => (await count(".frame")) === n);
const toastWith = (sel: string, re: RegExp) => until(async () => (await texts(sel)).some((t) => re.test(t)));
const gone = (sel: string) => until(async () => (await count(sel)) === 0);
const refresh = () => page.locator(".sidebar .refresh:not([disabled])").first().click();

// ============================================================================
console.log("\n0. the desk, and a selector that can see a toast");
await page.goto(SHELL);
await page.waitForSelector(".topbar");
const aId = await spawn({ command: "/bin/sh", args: ["-c", "sleep 600"], repo: "dry" });
const bId = await spawn({ command: "/bin/sh", args: ["-c", "sleep 600"], repo: "dry", ticket: "DRY-3" });
check("the ticket spawn made a worktree to reap", fs.existsSync(WT), WT);
check("two windows", await frames(2), `${aId.slice(0, 6)} + ${bId.slice(0, 6)}`);
await page.waitForSelector(".term .xterm-screen");
let base = await settled();
check("two terminals to measure (a measurement of zero panes passes anything)", base.terms.length === 2, `${base.terms.length}`);
check("no toast up yet", (await count(TOAST.any)) === 0, `${await count(TOAST.any)}`);
const rail = await box(page.locator(".rail"));

// ============================================================================
console.log("\n1. the poll's error — a CONDITION: leaves when the poll succeeds");
fault.poll = true;
check("it appears", await toastWith(TOAST.error, /Can't list sessions/));
check("as an alert", (await page.locator(TOAST.error).first().getAttribute("role")) === "alert");
await unchanged("body and terminals did not move", base);
const pollBox = await box(page.locator(TOAST.error).first());
check(
  "and it sits clear of the rail",
  !!pollBox && !!rail && pollBox.y + pollBox.height <= rail.y,
  `toast bottom ${pollBox ? pollBox.y + pollBox.height : "?"}, rail top ${rail?.y}`,
);
fault.poll = false;
check("it leaves by itself when the poll answers", await gone(TOAST.error));
await unchanged("…and nothing moved when it went", base);

console.log("   dismissal is remembered while the poll keeps failing");
fault.poll = true;
await toastWith(TOAST.error, /Can't list sessions/);
await page.locator(`${TOAST.error} ${TOAST.dismiss}`).first().click();
check("✕ takes it down", await gone(TOAST.error));
await sleep(POLLS_MS);
check("and it stays down across two more failed polls", (await count(TOAST.error)) === 0, `${await count(TOAST.error)} error toast(s)`);
fault.poll = false;
await sleep(4 * 1000); // one success, so the owner has cleared
fault.poll = true;
check("a fresh failure after a success is a new toast", await toastWith(TOAST.error, /Can't list sessions/));
fault.poll = false;
check("…which the poll takes down again", await gone(TOAST.error));

// ============================================================================
console.log("\n2. a notice — a CONDITION: leaves when its owner clears it");
fault.tracker = true;
await refresh();
check("it appears", await toastWith(TOAST.notice, /Tickets aren't (loading|refreshing)/));
check("as a status", (await page.locator(TOAST.notice).first().getAttribute("role")) === "status");
await unchanged("body and terminals did not move", base);
const detail = (await texts(`${TOAST.notice} .toast-detail`))[0] ?? "";
check(
  "its detail is still capped (DETAIL_MAX)",
  detail.length > 0 && detail.length <= 140 && detail.endsWith("…"),
  `${detail.length} chars of ${LONG.length}`,
);

console.log("   dismissal survives the owner re-reporting the same outage");
await page.locator(`${TOAST.notice} ${TOAST.dismiss}`).first().click();
check("✕ takes it down", await gone(TOAST.notice));
await unchanged("…and nothing moved when it went", base);
await sleep(1500);
await refresh(); // a second failed pull → setNotice() again, with the same key
await sleep(1500);
check("a second failed pull does not resurrect it", (await count(TOAST.notice)) === 0, `${await count(TOAST.notice)}`);
fault.tracker = false;
await refresh(); // success → clearNotice()
await sleep(1000);
fault.tracker = true;
await refresh();
check("after the owner has cleared, the next outage is a NEW toast", await toastWith(TOAST.notice, /Tickets aren't (loading|refreshing)/));
fault.tracker = false;
await refresh();
check("and it leaves by itself when the tracker answers", await gone(TOAST.notice));
await unchanged("…and nothing moved when it went", base);

// ============================================================================
console.log("\n3. a failed action — an EVENT: waits for ✕, and the poll must not wipe it");
fault.kill = true;
await page.locator(".frame .ctl.close").first().click();
check("it appears", await toastWith(TOAST.error, /Couldn't stop that session/));
check("as an alert", (await page.locator(TOAST.error).first().getAttribute("role")) === "alert");
await unchanged("body and terminals did not move", base);
await sleep(POLLS_MS);
check(
  "it survives two more polls (DRY-51)",
  (await texts(TOAST.error)).some((t) => /Couldn't stop that session/.test(t)),
  JSON.stringify(await texts(TOAST.error)),
);
await page.locator(`${TOAST.error} ${TOAST.dismiss}`).first().click();
check("✕ takes it down", await gone(TOAST.error));
await unchanged("…and nothing moved when it went", base);
fault.kill = false;

// ============================================================================
console.log("\n4. a non-failure outcome — an EVENT: the reaper says what it removed");
let release!: () => void;
reapGate = new Promise<void>((r) => (release = r));
await page.locator(".frame", { has: page.locator(".ticket", { hasText: "DRY-3" }) }).locator(".ctl.close").click();
check("the window went", await frames(1));
await sleep(1000);
base = await settled(); // one window now: the baseline is the desk WITHOUT the note
check("no note yet — the reap request is held", (await count(TOAST.note)) === 0);
release();
reapGate = null;
check("it appears", await toastWith(TOAST.note, /worktree/i), (await texts(TOAST.note)).join(" | "));
check("the worktree really is gone (the daemon reaped it)", !fs.existsSync(WT), WT);
check("as a status", (await page.locator(TOAST.note).first().getAttribute("role")) === "status");
await unchanged("body and terminals did not move", base);
await sleep(POLLS_MS);
check("it survives two more polls", (await count(TOAST.note)) === 1, `${await count(TOAST.note)} note toast(s)`);
await page.locator(`${TOAST.note} ${TOAST.dismiss}`).first().click();
check("✕ takes it down", await gone(TOAST.note));
await unchanged("…and nothing moved when it went", base);

// ============================================================================
console.log("\n5. an arrival does not move a toast that is already there");
fault.tracker = true;
await refresh();
await toastWith(TOAST.notice, /Tickets aren't (loading|refreshing)/);
const first = await box(page.locator(TOAST.notice).first());
fault.poll = true;
await toastWith(TOAST.error, /Can't list sessions/);
const second = await box(page.locator(TOAST.error).first());
check("the notice did not move when the poll error arrived", JSON.stringify(first) === JSON.stringify(await box(page.locator(TOAST.notice).first())), `${JSON.stringify(first)}`);
check("the newcomer went BELOW it", !!first && !!second && second.y >= first.y + first.height, `notice ${first?.y}+${first?.height}, error at ${second?.y}`);
fault.kill = true;
await page.locator(".frame .ctl.close").first().click();
await until(async () => (await count(TOAST.error)) === 2);
check("two errors are up (the poll's and the action's)", (await count(TOAST.error)) === 2, `${await count(TOAST.error)}`);
check("the notice still has not moved", JSON.stringify(first) === JSON.stringify(await box(page.locator(TOAST.notice).first())));
check("nor has the poll error", JSON.stringify(second) === JSON.stringify(await box(page.locator(TOAST.error).first())));
await unchanged("three toasts up and body and terminals still did not move", base);
fault.poll = false;
fault.tracker = false;
fault.kill = false;
await refresh();
check("the notice left when the tracker answered", await gone(TOAST.notice));
// The poll's error is a condition and goes by itself on the next good poll; the
// action's is an event and is the one that has to be dismissed by hand. Waiting
// for that is what makes the click below land on the right toast.
check("the poll's error left on its own, the action's stayed", await until(async () => (await count(TOAST.error)) === 1), `${await count(TOAST.error)} error toast(s)`);
await page.locator(`${TOAST.error} ${TOAST.dismiss}`).first().click();
check("everything cleared", await gone(TOAST.any));
await unchanged("…and the desk is exactly where it started", base);

// ============================================================================
// Everything above ran in FLOAT, where a window's rect is its own and a banner
// that pushed the desk down would MOVE every terminal but not RESIZE one. The
// ticket's complaint is the refit, and that needs a layout that derives rects
// from the desk's height: tile and focus. Measured here, against the version
// that pushed, this is the section where a pane's width/height change and not
// just its y.
console.log("\n6. the same in TILE — where an in-flow banner also RESIZES every terminal");
await spawn({ command: "/bin/sh", args: ["-c", "sleep 600"], repo: "dry" });
check("two windows again", await frames(2));
await page.locator(".switcher button", { hasText: /^Tile$/ }).click();
await sleep(600); // the tile transition is .26s and a baseline mid-flight is noise
base = await settled();
check("two terminals tiled to measure", base.terms.length === 2, JSON.stringify(base.terms.map((t) => `${t.w}x${t.h}`)));

fault.poll = true;
await toastWith(TOAST.error, /Can't list sessions/);
await unchanged("poll error: no terminal moved or resized", base);
fault.poll = false;
await gone(TOAST.error);
await unchanged("…and none did when it went", base);

fault.tracker = true;
await refresh();
await toastWith(TOAST.notice, /Tickets aren't (loading|refreshing)/);
await unchanged("notice: no terminal moved or resized", base);
fault.tracker = false;
await refresh();
await gone(TOAST.notice);
await unchanged("…and none did when it went", base);

fault.kill = true;
await page.locator(".frame .ctl.close").first().click();
await toastWith(TOAST.error, /Couldn't stop that session/);
await unchanged("failed action: no terminal moved or resized", base);
await page.locator(`${TOAST.error} ${TOAST.dismiss}`).first().click();
await gone(TOAST.error);
await unchanged("…and none did when it went", base);
fault.kill = false;

// ============================================================================
console.log("\n7. a toast never takes the keyboard");
await page.locator(".term").first().click();
const focused = () => page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`);
const held = await focused();
check("a terminal has focus to begin with", /xterm-helper-textarea/.test(held), held);
fault.poll = true;
await toastWith(TOAST.error, /Can't list sessions/);
check("raising a toast leaves focus where it was", (await focused()) === held, await focused());
await page.locator(`${TOAST.error} ${TOAST.dismiss}`).first().click();
check("clicking its ✕ does too", (await focused()) === held, await focused());
fault.poll = false;

await page.screenshot({ path: "/tmp/dry100-toasts.png" });
await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
