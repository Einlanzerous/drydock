// DRY-58 surface verification: does the desk resume roaming without a reload?
//
// Three scenarios, because they are three different paths through one outage
// and only the first is obvious:
//   A  outage AFTER a good read      → mayPush stayed open, the failed push
//                                      must be flushed on heal
//   B  outage BEFORE the first read, client touches nothing
//                                    → the daemon's desk wins and lands live
//   C  outage BEFORE the first read, client drags a window
//                                    → this client's arrangement wins
//
// B and C are the pair the conflict rule exists for; either alone proves
// nothing. Throwaway daemon :4370, partition proxy :4371, vite :5370.
//
// Run from `daemon/`, where tsx resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/roam.mts)
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  deskWindows,
  type HealthResponse,
  type SessionsResponse,
  type WorkspaceResponse,
} from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5370";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4370"; // past the proxy — ground truth
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4371"; // what the shell talks to (and its mirror key)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
const j = async <T,>(u: string, init?: RequestInit): Promise<T> =>
  (await fetch(u, init)).json() as Promise<T>;

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const breakStore = (mode = "503") => j(`${PROXY}/__break?mode=${mode}`, { method: "POST" });
const healStore = () => j(`${PROXY}/__heal`, { method: "POST" });

/** A window's position, as one side or the other holds it. */
interface Spot {
  x: number;
  y: number;
}
type Desk = Record<string, Spot>;

/** Desk as the DAEMON holds it, keyed by window id. */
async function stored(): Promise<Desk> {
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  return Object.fromEntries(
    deskWindows(workspace).map((w) => [w.id, { x: Math.round(w.x), y: Math.round(w.y) }]),
  );
}

/** Desk as THIS BROWSER holds it — the localStorage mirror the wm writes. */
async function local(page: Page): Promise<Desk> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), `drydock.layout.${PROXY}`);
  const parsed = raw ? (JSON.parse(raw) as WorkspaceResponse["workspace"]) : null;
  return Object.fromEntries(
    deskWindows(parsed).map((w) => [w.id, { x: Math.round(w.x), y: Math.round(w.y) }]),
  );
}

/** Where the windows actually are on screen, sorted — DOM, not model. */
const onScreen = (page: Page): Promise<number[]> =>
  page.$$eval(".frame", (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().x)).sort((a, b) => a - b),
  );

const noticed = (page: Page) => page.locator(".notice").count().then((n) => n > 0);

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  ms = 45000,
): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(500);
  }
  return null;
}

/** Drag the first window's title bar — a real arrangement, not a poke. */
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.locator(".frame .bar").first().boundingBox();
  // A missing box means no window was on the desk to drag, which invalidates
  // everything after it — said out loud rather than as a TypeError on `box.x`.
  if (!box) throw new Error("no .frame .bar on the desk to drag");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
  await sleep(800); // past the 400ms persist debounce
}

async function freshPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (/drydock/.test(m.text())) console.log(`        [console] ${m.text().slice(0, 110)}`);
  });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar", { timeout: 15000 });
  await page.waitForSelector(".frame", { timeout: 15000 });
  await sleep(1500);
  return { ctx, page };
}

const moved = (a: Desk, b: Desk, id: string, tol = 4) =>
  !!a[id] && !!b[id] && Math.abs(a[id].x - b[id].x) <= tol;

// ---------------------------------------------------------------- setup ----
await healStore();
for (const s of (await j<SessionsResponse>(`${DAEMON}/api/sessions`)).sessions) {
  await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
}
await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
for (const t of ["one", "two"]) {
  await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "bash", title: t }),
  });
}
await sleep(600);

const browser = await chromium.launch();

// ------------------------------------------- A: outage after a good read ----
console.log("\nA. outage AFTER a good read — the push that failed is flushed on heal");
{
  const { ctx, page } = await freshPage(browser);
  check("read succeeded, no notice at load", !(await noticed(page)));

  await breakStore("503");
  await drag(page, 260, 150);
  const dragged = await local(page);
  const id = Object.keys(dragged)[0];

  check("notice shown while degraded", await noticed(page));
  const midOutage = await stored();
  check(
    "the drag did NOT reach the daemon during the outage",
    !midOutage[id] || Math.abs(midOutage[id].x - dragged[id].x) > 4,
    `daemon ${JSON.stringify(midOutage[id])} vs browser ${JSON.stringify(dragged[id])}`,
  );

  await healStore();
  const t = await waitFor("clear", async () => !(await noticed(page)));
  check("notice cleared on heal — no reload, no interaction", t !== null, `after ${t}s`);
  check(
    "the arrangement made during the outage is what's persisted",
    moved(await stored(), dragged, id),
    JSON.stringify({ daemon: (await stored())[id], browser: dragged[id] }),
  );

  await drag(page, -120, -60);
  const again = await local(page);
  check("roaming resumed — a later drag reaches the daemon directly", moved(await stored(), again, id));
  await ctx.close();
}

const saved = await stored();
const targetId = Object.keys(saved)[0];
console.log(`   desk on the daemon: ${JSON.stringify(saved)}`);

// ------------------------------ B: outage before first read, untouched ------
console.log("\nB. outage BEFORE the first read, nothing arranged — the daemon's desk wins");
{
  await breakStore("503");
  const { ctx, page } = await freshPage(browser); // fresh context = empty mirror
  check("notice shown when the load-time read fails", await noticed(page));

  const cascade = await local(page);
  check(
    "desk built from scratch at cascade, not the saved one",
    !moved(cascade, saved, targetId, 20),
    `browser ${JSON.stringify(cascade[targetId])} vs saved ${JSON.stringify(saved[targetId])}`,
  );
  const beforeHeal = await onScreen(page);

  await healStore(); // and now: no reload, no click, no keystroke
  const t = await waitFor("adopt", async () => moved(await local(page), saved, targetId));
  check("the saved desk landed on screen live", t !== null, `after ${t}s`);
  check("notice cleared", !(await noticed(page)));
  const afterHeal = await onScreen(page);
  check(
    "the windows actually moved in the DOM",
    JSON.stringify(beforeHeal) !== JSON.stringify(afterHeal),
    `${JSON.stringify(beforeHeal)} → ${JSON.stringify(afterHeal)}`,
  );
  check(
    "the saved desk was NOT overwritten by the cascade one",
    moved(await stored(), saved, targetId),
    JSON.stringify({ daemon: (await stored())[targetId], saved: saved[targetId] }),
  );
  await ctx.close();
}

const savedB = await stored();

// ------------------------------- C: outage before first read, arranged ------
console.log("\nC. outage BEFORE the first read, a window dragged — this client wins");
{
  await breakStore("503");
  const { ctx, page } = await freshPage(browser);
  await drag(page, 340, 210);
  const dragged = await local(page);
  const id = Object.keys(dragged)[0];
  check(
    "the drag differs from what the daemon holds",
    !moved(dragged, savedB, id, 20),
    `browser ${JSON.stringify(dragged[id])} vs daemon ${JSON.stringify(savedB[id])}`,
  );

  await healStore();
  const t = await waitFor("flush", async () => moved(await stored(), dragged, id));
  check("this client's arrangement is what's persisted", t !== null, `after ${t}s`);
  check("notice cleared", !(await noticed(page)));
  check(
    "the drag was not yanked back to the daemon's desk",
    moved(await local(page), dragged, id),
    JSON.stringify({ browser: (await local(page))[id], dragged: dragged[id] }),
  );
  await ctx.close();
}

// ------------------------------------------------- the DRY-28 invariant ----
console.log("\nD. the property none of this may regress");
{
  const health = await j<HealthResponse>(`${DAEMON}/healthz`);
  const { sessions } = await j<SessionsResponse>(`${DAEMON}/api/sessions`);
  check("daemon still up", health.ok === true);
  check(
    "sessions stayed live throughout",
    sessions.length === 2 && sessions.every((s) => s.status === "running"),
    `${sessions.length} session(s): ${sessions.map((s) => s.status).join(",")}`,
  );
}

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
