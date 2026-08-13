// The claims DRY-28 makes at the surface, re-checked because DRY-58 rewrote
// the code that makes them true — plus the two DRY-58 adds about how the
// degraded state presents.
//
// CLAUDE.md is explicit that these are the tests that matter for "the desk
// follows the person": both pass under the old localStorage design by accident,
// so only the surface version proves anything.
//
// ON `page.evaluate` BODIES HERE (DRY-80). This file runs under `tsx`, whose
// esbuild transform wraps NAME-BOUND functions in a `__name(...)` helper
// (keepNames) — and Playwright ships an evaluate body to the browser as SOURCE,
// where that helper does not exist, so the page throws
// `ReferenceError: __name is not defined` at a line that reads perfectly well.
// Anonymous inline arrows are not name-bound and cross intact, which is why
// most of the bodies below are still functions. `VISIBILITY_JS` is a string
// because its body binds a name — the `get:` accessor — and is therefore the
// one that would break. Anything added here that introduces a `const q = …`
// inside a body has to become a string too; see auth.mts, which is all strings.
//
// Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/surface.mts)
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { HealthResponse, SessionsResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5370";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4370"; // past the proxy — ground truth
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4371"; // what the shell talks to (and its mirror key)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
const j = async <T,>(u: string, i?: RequestInit): Promise<T> =>
  (await fetch(u, i)).json() as Promise<T>;
let failures = 0;
const check = (n: string, ok: boolean, d: unknown = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const noticed = (page: Page) => page.locator(".notice").count();
const geo = (page: Page): Promise<number[]> =>
  page.$$eval(".frame", (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().x)).sort((a, b) => a - b),
  );

/**
 * Being in another tab, as the desk sees it — a STRING body, see the note at
 * the top of this file. The `get:` accessor is bound to a name, so under tsx's
 * transform this exact body is the one that arrives in the page carrying an
 * undefined `__name` call.
 */
const VISIBILITY_JS = `(() => {
  window.__vis = "hidden";
  Object.defineProperty(document, "visibilityState", { get: () => window.__vis });
})()`;

async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const b = await page.locator(".frame .bar").first().boundingBox();
  // A missing box means no window was on the desk to drag, which invalidates
  // everything after it — said out loud rather than as a TypeError on `b.x`.
  if (!b) throw new Error("no .frame .bar on the desk to drag");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await sleep(900);
}
async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(SHELL);
  await page.waitForSelector(".frame", { timeout: 15000 });
  await sleep(1500);
  return { ctx, page };
}

await fetch(`${PROXY}/__heal`, { method: "POST" });
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

console.log("\n1. the desk follows the person (DRY-28, unchanged by this work)");
let arranged: number[];
{
  const { ctx, page } = await open(browser);
  await drag(page, 220, 130);
  arranged = await geo(page);

  // localStorage wiped, same profile → the daemon is the only possible source.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".frame", { timeout: 15000 });
  await sleep(1800);
  check(
    "wipe localStorage, reload → desk intact",
    JSON.stringify(await geo(page)) === JSON.stringify(arranged),
    `${JSON.stringify(await geo(page))} vs ${JSON.stringify(arranged)}`,
  );
  await ctx.close();
}
{
  // A profile that has never been here at all.
  const { ctx, page } = await open(browser);
  check(
    "a browser that has never seen this desk gets the same desk",
    JSON.stringify(await geo(page)) === JSON.stringify(arranged),
    `${JSON.stringify(await geo(page))} vs ${JSON.stringify(arranged)}`,
  );
  await ctx.close();
}

console.log("\n2. how the degraded state presents (DRY-58)");
{
  const { ctx, page } = await open(browser);
  const deskBefore = await geo(page);

  // `hang` rather than `503`, so the push takes its full 8s budget to fail.
  // That gap is what makes the focus check meaningful: the drag itself blurs
  // whatever was focused, so measuring across it would only ever prove that
  // clicking a title bar moves focus. Drag first, focus after, THEN let the
  // notice arrive on its own.
  await fetch(`${PROXY}/__break?mode=hang`, { method: "POST" });
  await drag(page, 60, 40);
  await page.evaluate(() => document.querySelector("button")?.focus());
  const before = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 60));
  check("nothing shown yet", (await noticed(page)) === 0);

  for (let i = 0; i < 30 && (await noticed(page)) === 0; i++) await sleep(500);
  check("the notice appears", (await noticed(page)) === 1);
  const after = await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 60));
  check("it does not steal focus", before === after, `${before} → ${after}`);
  await fetch(`${PROXY}/__break?mode=503`, { method: "POST" });

  // Keep failing: several more pushes, several more retries.
  await drag(page, 30, 20);
  await drag(page, 30, 20);
  await sleep(7000);
  check("still exactly one, however many failures", (await noticed(page)) === 1);
  check(
    "the desk kept working while degraded",
    JSON.stringify(await geo(page)) !== JSON.stringify(deskBefore),
  );

  await fetch(`${PROXY}/__heal`, { method: "POST" });
  await sleep(9000);
  check("and it clears itself", (await noticed(page)) === 0);
  await ctx.close();
}

console.log("\n3. a tab nobody is looking at doesn't wedge");
{
  const { ctx, page } = await open(browser);
  // Stub the API the loop consults. Not a perfect background tab, but it does
  // exercise the branch — and the branch's whole job is to reschedule rather
  // than sit waiting for an event that may never arrive.
  await page.evaluate(VISIBILITY_JS);
  await fetch(`${PROXY}/__break?mode=503`, { method: "POST" });
  await drag(page, 100, 60);
  await sleep(1500);
  check("degraded while hidden", (await noticed(page)) === 1);

  await fetch(`${PROXY}/__heal`, { method: "POST" });
  await sleep(12000);
  check(
    "recovered without ever becoming visible — the reschedule, not the event",
    (await noticed(page)) === 0,
  );
  await ctx.close();
}

const { sessions } = await j<SessionsResponse>(`${DAEMON}/api/sessions`);
console.log("\n4. still true at the end");
check("sessions all live", sessions.length === 2 && sessions.every((s) => s.status === "running"));
check("daemon ok", (await j<HealthResponse>(`${DAEMON}/healthz`)).ok === true);

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
