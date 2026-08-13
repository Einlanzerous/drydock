// DRY-58, the partition CLAUDE.md insists on: accept the connection and then
// go silent. `docker stop` frees the port so every attempt fails instantly and
// every missing timeout hides; this holds the socket open and answers nothing.
//
// What it is actually testing is the recovery loop's own liveness. A push that
// never resolves neither succeeds nor throws, so nothing re-arms the retry and
// nothing raises the notice — the outage becomes permanent and silent, which is
// the exact failure this ticket exists to remove.
//
// Run from `daemon/`, where tsx resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/hang.mts)
import { chromium, type Page } from "playwright";
import { deskWindows, type SessionsResponse, type WorkspaceResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5370";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4370"; // past the proxy — ground truth
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4371"; // what the shell talks to (and its mirror key)

/** `proxy-http.mts`'s control surface. `held` is sockets parked by "hang". */
interface ProxyState {
  mode: string;
  held: number;
  delayed: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
const j = async <T,>(u: string, init?: RequestInit): Promise<T> =>
  (await fetch(u, init)).json() as Promise<T>;
let failures = 0;
const check = (n: string, ok: boolean, d: unknown = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

/** Window x-positions keyed by id, as one side or the other holds them. */
type Desk = Record<string, number>;

const local = async (page: Page): Promise<Desk> => {
  const raw = await page.evaluate((k) => localStorage.getItem(k), `drydock.layout.${PROXY}`);
  const p = raw ? (JSON.parse(raw) as WorkspaceResponse["workspace"]) : null;
  return Object.fromEntries(deskWindows(p).map((w) => [w.id, Math.round(w.x)]));
};
const stored = async (): Promise<Desk> => {
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  return Object.fromEntries(deskWindows(workspace).map((w) => [w.id, Math.round(w.x)]));
};
const noticed = (page: Page) => page.locator(".notice").count().then((n) => n > 0);
async function waitFor(fn: () => Promise<boolean>, ms = 60000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(500);
  }
  return null;
}
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const b = await page.locator(".frame .bar").first().boundingBox();
  // A missing box means no window was on the desk to drag, which invalidates
  // everything after it — said out loud rather than as a TypeError on `b.x`.
  if (!b) throw new Error("no .frame .bar on the desk to drag");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  await sleep(800);
}

await j(`${PROXY}/__heal`, { method: "POST" });
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
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => {
  if (/drydock/.test(m.text())) console.log(`      [console] ${m.text().slice(0, 100)}`);
});

console.log("\nHANG: the daemon accepts and never answers");
await page.goto(SHELL);
await page.waitForSelector(".frame", { timeout: 15000 });
await sleep(1500);
check("clean load", !(await noticed(page)));

await j(`${PROXY}/__break?mode=hang`, { method: "POST" });
const before = await local(page);
await drag(page, 300, 170);
const dragged = await local(page);
const id = Object.keys(dragged).find((k) => dragged[k] !== before[k]) ?? Object.keys(dragged)[0];

// The push is now parked on the proxy. Without a client-side budget it never
// settles and nothing below ever becomes true.
const t1 = await waitFor(() => noticed(page), 20000);
check("a hung push still raises the notice", t1 !== null, `after ${t1}s`);
check(
  "the desk did not reach the daemon",
  (await stored())[id] !== dragged[id],
  `daemon ${(await stored())[id]} vs browser ${dragged[id]}`,
);
console.log(`      (proxy holding ${(await j<ProxyState>(`${PROXY}/__state`)).held} socket(s))`);

await j(`${PROXY}/__heal`, { method: "POST" });
const t2 = await waitFor(async () => (await stored())[id] === dragged[id]);
check("recovery was still alive and flushed on heal", t2 !== null, `after ${t2}s`);
check("notice cleared", !(await noticed(page)));

const { sessions } = await j<SessionsResponse>(`${DAEMON}/api/sessions`);
check(
  "sessions stayed live",
  sessions.length === 2 && sessions.every((s) => s.status === "running"),
  `${sessions.length} live`,
);

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
