// The claims DRY-28 makes at the surface, re-checked because DRY-58 rewrote
// the code that makes them true — plus the two DRY-58 adds about how the
// degraded state presents.
//
// CLAUDE.md is explicit that these are the tests that matter for "the desk
// follows the person": both pass under the old localStorage design by accident,
// so only the surface version proves anything.
import { chromium } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5370";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4370"; // past the proxy — ground truth
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4371"; // what the shell talks to (and its mirror key)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, i) => (await fetch(u, i)).json();
let failures = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const noticed = (page) => page.locator(".notice").count();
const geo = (page) =>
  page.$$eval(".frame", (els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().x)).sort((a, b) => a - b),
  );
async function drag(page, dx, dy) {
  const b = await page.locator(".frame .bar").first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await sleep(900);
}
async function open(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(SHELL);
  await page.waitForSelector(".frame", { timeout: 15000 });
  await sleep(1500);
  return { ctx, page };
}

await fetch(`${PROXY}/__heal`, { method: "POST" });
for (const s of (await j(`${DAEMON}/api/sessions`)).sessions) {
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
let arranged;
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
  await page.evaluate(() => {
    window.__vis = "hidden";
    Object.defineProperty(document, "visibilityState", { get: () => window.__vis });
  });
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

const { sessions } = await j(`${DAEMON}/api/sessions`);
console.log("\n4. still true at the end");
check("sessions all live", sessions.length === 2 && sessions.every((s) => s.status === "running"));
check("daemon ok", (await j(`${DAEMON}/healthz`)).ok === true);

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
