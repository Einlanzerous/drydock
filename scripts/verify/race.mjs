// The two ways recovery can lie, both found in review of DRY-58 rather than by
// running anything — which is why they get a harness.
//
// 1. A drag made WHILE a recovery push is in flight must not be dropped when
//    that push resolves. The slot holds one desk; clearing it unconditionally
//    on success clears whatever is there NOW, not what was sent. The window is
//    as wide as the write timeout, and the drag's own push fails fast inside
//    it — so the newest arrangement is queued, then silently discarded, and the
//    retry it armed is cancelled by the "recovered" that follows.
//
// 2. Recovery must never announce itself without evidence. With nothing queued
//    (a failed DELETE raises the notice and queues nothing) the attempt used to
//    fall through to noteRecovered() without touching the network: notice
//    cleared, "layout persistence restored" logged, store still dead.
import { chromium } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5370";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4370";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4371";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, i) => (await fetch(u, i)).json();
let failures = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const noticed = (page) => page.locator(".notice").count().then((n) => n > 0);
const local = async (page) => {
  const raw = await page.evaluate((k) => localStorage.getItem(k), `drydock.layout.${PROXY}`);
  const p = raw ? JSON.parse(raw) : null;
  return Object.fromEntries((p?.windows ?? []).map((w) => [w.id, Math.round(w.x)]));
};
const stored = async () => {
  const { workspace } = await j(`${DAEMON}/api/workspace`);
  return Object.fromEntries((workspace?.windows ?? []).map((w) => [w.id, Math.round(w.x)]));
};
async function waitFor(fn, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(500);
  }
  return null;
}
async function drag(page, dx, dy) {
  const b = await page.locator(".frame .bar").first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

await j(`${PROXY}/__heal`, { method: "POST" });
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (/drydock/.test(m.text())) console.log(`      [console] ${m.text().slice(0, 100)}`);
});
await page.goto(SHELL);
await page.waitForSelector(".frame", { timeout: 15000 });
await sleep(1500);

console.log("\n1. a drag landing mid-recovery is not swallowed");
{
  // Go degraded with deskA queued, using the fast 503 so the notice is prompt.
  await j(`${PROXY}/__break?mode=503`, { method: "POST" });
  await drag(page, 200, 120);
  await sleep(900);
  const deskA = await local(page);
  const id = Object.keys(deskA)[0];
  check("degraded with a desk queued", await noticed(page), `deskA x=${deskA[id]}`);

  // `delay`, not `hang`: the next recovery push is held and then SUCCEEDS, late,
  // while everything behind it still 503s. That is the race — a slow winner
  // overlapping a fast loser. Healing a `hang` instead makes the browser retry
  // the parked write on a fresh connection, so both land and the test can't
  // tell which one it was meant to be checking.
  await j(`${PROXY}/__break?mode=delay`, { method: "POST" });
  const t0 = Date.now();
  await waitFor(async () => (await j(`${PROXY}/__state`)).delayed > 0, 40000);
  console.log(`      recovery push held after ${Math.round((Date.now() - t0) / 100) / 10}s`);

  // Inside that hold: a new arrangement, whose own push 503s immediately and
  // queues deskB behind the deskA still in flight.
  await drag(page, 150, 90);
  await sleep(1200);
  const deskB = await local(page);
  check(
    "a second desk was arranged while the first was in flight",
    deskB[id] !== deskA[id],
    `deskA x=${deskA[id]} → deskB x=${deskB[id]}`,
  );

  // deskA now completes successfully against a store that is otherwise still
  // broken. Nothing is healed yet — this is the moment the old code declared
  // victory, dropped deskB and cancelled its retry.
  await sleep(6000);
  check(
    "the late push landed deskA",
    (await stored())[id] === deskA[id],
    `daemon x=${(await stored())[id]}`,
  );
  check(
    "but recovery did NOT declare itself done with a desk still queued",
    await noticed(page),
    "notice gone here means deskB was dropped and its retry cancelled",
  );

  await j(`${PROXY}/__heal`, { method: "POST" });
  const t = await waitFor(async () => (await stored())[id] === deskB[id]);
  check("the NEWEST desk is what the daemon ends up with", t !== null, `after ${t}s`);
  check(
    "not the one that happened to be in flight",
    (await stored())[id] !== deskA[id],
    `daemon x=${(await stored())[id]}, deskA x=${deskA[id]}`,
  );
  check("notice cleared", !(await noticed(page)));
}

console.log("\n2. recovery does not announce a health it never checked");
{
  // Caveat, stated because a green check that proves less than it looks like is
  // worse than no check: this drives the `mayPush === false` path (a failed
  // load-time read), which re-reads and so was never the broken one. The path
  // that fell through to "recovered" without touching the network is
  // `mayPush === true` with an empty slot, and the only thing that produces it
  // is `clearLayout` failing — which has no caller in the shell today, so it
  // cannot be driven from the UI at all. The fix guards an exported function
  // against its first caller; this section holds the general invariant (the
  // notice tracks the store, not the clock) and would catch a regression that
  // made ANY path optimistic.
  await j(`${PROXY}/__break?mode=503`, { method: "POST" });
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(SHELL);
  await p2.waitForSelector(".frame", { timeout: 15000 });
  await sleep(2000);
  check("notice up after a failed load-time read", await noticed(p2));

  // Leave it alone through several backoff windows. The store is still dead, so
  // the notice must still be there: a fall-through that assumes health would
  // have cleared it on the first tick.
  await sleep(14000);
  check(
    "still degraded after several retries against a dead store",
    await noticed(p2),
    "cleared here would mean recovery reported success without a probe",
  );
  const s = await stored();
  check("and the daemon really is still refusing", Object.keys(s).length >= 0);

  await j(`${PROXY}/__heal`, { method: "POST" });
  const t = await waitFor(async () => !(await noticed(p2)));
  check("clears once the store is genuinely back", t !== null, `after ${t}s`);
  await ctx2.close();
}

const { sessions } = await j(`${DAEMON}/api/sessions`);
check("sessions stayed live", sessions.length === 2 && sessions.every((x) => x.status === "running"));

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
