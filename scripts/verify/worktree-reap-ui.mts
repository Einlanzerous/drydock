// DRY-90 shell half, driven in a real browser.
//
// Three claims `worktree-reap.mts` structurally cannot make, because all three
// are about which GESTURE reached the daemon:
//
//   B. Closing a window reaps its worktree when the policy allows, and says so.
//   C. DRY-60's automatic sweep closes a window and reaps NOTHING. Asserted on
//      a worktree that B just proved is reapable — the same ticket, the same
//      branch, the same predicate — so the only difference between the two
//      sections is who closed the window. Point it at a worktree the policy
//      would refuse anyway and this check passes against the bug.
//   A. The panel's Reset refuses a dirty worktree, says what is in it, and
//      discards it on the second press. It passed `--force` unconditionally
//      until this ticket, so there was no refusal to render.
//
// C is the one this file exists for. The sweep runs with nobody present and
// takes a pile of windows at once; a deletion hanging off it is the failure
// mode the whole design is arranged around, and nothing in the daemon can see
// the difference — the kill it receives is byte-identical either way.
//
// RIG (four terminals; the harness builds its own git fixture under /tmp/dry90,
// so nothing here touches a real repo):
//
//   (cd daemon && STUB_PORT=4396 node --import tsx ../scripts/verify/stub-tracker.mts)
//
//   cd daemon
//   DRYDOCK_PORT=4390 DRYDOCK_HOST=127.0.0.1 \
//     DRYDOCK_SESSIONS_DIR=/tmp/dry90-sessions/sessions-4390 \
//     DRYDOCK_STATE_FILE=/tmp/dry90-state.json \
//     DRYDOCK_WORKTREES_ROOT=/tmp/dry90/wt \
//     DRYDOCK_REPO_PATHS=demo=/tmp/dry90/demo,dry=/tmp/dry90/demo \
//     DRYDOCK_WORKTREE_REAP_MS=0 DRYDOCK_CLEAR_FINISHED_AFTER_MS=4000 \
//     DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4396 \
//     DRYDOCK_SWITCHYARD_TOKEN=stub node --import tsx src/index.ts
//
//   cd shell && VITE_DAEMON_URL=http://127.0.0.1:4390 bunx vite --port 5390 --strictPort
//
//   (cd daemon && node --import tsx ../scripts/verify/worktree-reap-ui.mts)
//
// Two of those daemon settings are load-bearing rather than convenient:
//
//   DRYDOCK_WORKTREE_REAP_MS=0 turns the SCHEDULED reaper off. Leave it on and
//   section C proves nothing — the timer would remove that worktree on its own
//   and the sweep would be blamed for it.
//   DRYDOCK_CLEAR_FINISHED_AFTER_MS=4000 is what makes the sweep reachable at
//   all; five minutes is the right default and a terrible test (DRY-60).
//
// `dry=` in DRYDOCK_REPO_PATHS is there because the stub tracker's project has
// no repo_url, so its tickets group under the lowercased project key.
//
// VERBOSE=1 prints the daemon's verdict for every worktree request.
//
// Afterwards: `rm -rf /tmp/dry90 /tmp/dry90-sessions`, and kill the supervisors it leaves behind
// (CLAUDE.md's loop over /proc/<pid>/exe, never `pkill -f supervisor/main`).
import { chromium } from "playwright";
import * as fs from "node:fs";
import { addWorktree, assertDaemonRoot, buildFixture, git } from "./git-fixture.mjs";

const SHELL = "http://127.0.0.1:5390";
const DAEMON = "http://127.0.0.1:4390";
const WT = (n: string) => `/tmp/dry90/wt/${n}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: unknown = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

async function spawn(body: unknown): Promise<string> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { session?: { id: string } ; error?: string };
  if (!json.session) throw new Error(`spawn failed: ${json.error}`);
  return json.session.id;
}

/**
 * A clean desk before anything is measured.
 *
 * Both halves are needed and the second is the one that bit: a leftover SESSION
 * puts a window on screen that every count here would attribute to this run,
 * and a saved WORKSPACE (DRY-28) restores windows for sessions that died days
 * ago — so the first `.frame` on the page can be a stale window whose ✕ kills
 * nothing and whose id is in no session record. Clicking that instead of the
 * window under test made this file report a reap that never happened, and then
 * a close that never reaped.
 */
async function cleanDesk(): Promise<void> {
  const list = (await (await fetch(`${DAEMON}/api/sessions`)).json()) as { sessions: { id: string }[] };
  for (const s of list.sessions) {
    await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
  }
  await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
}
await cleanDesk();

// A fresh repo every run. DRY-15 REUSES an existing worktree rather than
// recreating it, so a checkout left dirty by the previous run silently turns
// the case under test into "a dirty worktree" — which is refused, correctly,
// and reads as the feature being broken.
const fixture = buildFixture("/tmp/dry90");
// The daemon's worktrees root, not this file's idea of it. Same guard and same
// reason as `worktree-reap.mts`: what goes wrong is DRYDOCK_WORKTREES_ROOT
// missing from a long rig line, and every constant here would still agree with
// itself if it were.
await assertDaemonRoot(DAEMON, `${fixture.worktrees}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
// VERBOSE=1 prints the daemon's own verdict for every worktree request and the
// desk's state around each assertion. Off by default and worth turning on the
// moment anything below fails: the route answers 200 for a refusal, so "removed
// nothing" and "asked about the wrong worktree" look identical from outside.
const VERBOSE = process.env.VERBOSE === "1";
page.on("console", (m) => { if (VERBOSE && m.type() === "error") console.log("    [console]", m.text()); });
page.on("response", (r) => {
  if (!VERBOSE || !r.url().includes("/api/worktrees/")) return;
  void r.text().then((t) => console.log("    [res]", r.status(), t)).catch(() => {});
});
/** Wait until the desk shows exactly `n` windows — never assert on a count you
 *  did not wait for: the 3s poll is what adds and removes them. */
const frames = async (n: number, ms = 12_000): Promise<number> => {
  const until = Date.now() + ms;
  let count = await page.locator(".frame").count();
  while (count !== n && Date.now() < until) {
    await sleep(250);
    count = await page.locator(".frame").count();
  }
  return count;
};
const dump = async (label: string) => {
  if (!VERBOSE) return;
  const titles = await page.locator(".frame .title").allTextContents();
  const err = await page.locator("p.error").allTextContents();
  const note = await page.locator("p.note").allTextContents();
  console.log(`    [dom ${label}] frames=${JSON.stringify(titles)} error=${JSON.stringify(err)} note=${JSON.stringify(note)}`);
};
await page.goto(SHELL);
await page.waitForSelector(".topbar");

// --- B: reap on an explicit close -------------------------------------------
console.log("\nB. closing a window reaps a finished worktree");
const bId = await spawn({ command: "/bin/sh", args: ["-c", "sleep 300"], repo: "dry", ticket: "DRY-3" });
if (VERBOSE) console.log(`    [b] ${bId}`);
check("the spawn made a worktree", fs.existsSync(WT("demo-DRY-3")), WT("demo-DRY-3"));
const bWin = await frames(1);
check("a window appeared for it", bWin === 1, `${bWin} window(s)`);
await dump("before close");
await page.locator(".frame .ctl.close").first().click();
check("the window went", (await frames(0)) === 0);
await page.waitForTimeout(2000);
await dump("after close");
check("the worktree is gone", !fs.existsSync(WT("demo-DRY-3")), WT("demo-DRY-3"));
const noteText = await page.locator("p.note").first().textContent().catch(() => null);
check("and the desk says so", !!noteText && /worktree/i.test(noteText), (noteText ?? "(no banner)").trim());
check(
  "and names the branch it kept",
  !!noteText && /agent\/DRY-3/.test(noteText),
  (noteText ?? "").trim(),
);
const branches = git(fixture.repo, "branch", "--list", "agent/DRY-3");
check("the branch survived", branches.includes("agent/DRY-3"), branches || "(gone)");
await page.locator("p.note .banner-x").first().click().catch(() => {});

// --- C: the automatic sweep must NOT reap ------------------------------------
//
// Same ticket, so the worktree is reapable by exactly the policy that removed
// it in B. The only difference is who closes the window.
console.log("\nC. DRY-60's sweep closes the window and reaps nothing");
const cId = await spawn({ command: "/bin/sh", args: ["-c", "sleep 1"], repo: "dry", ticket: "DRY-3" });
if (VERBOSE) console.log(`    [c] ${cId}`);
check("the worktree is back", fs.existsSync(WT("demo-DRY-3")), WT("demo-DRY-3"));
check("a window appeared for it", (await frames(1)) === 1);
// The run finishes in ~1s; the sweep clears it 4s after the desk first sees it.
const cWindows = await frames(0, 20_000);
await dump("after sweep wait");
check("the sweep took the window", cWindows === 0, `${cWindows} window(s)`);
const gone = (await (await fetch(`${DAEMON}/api/sessions`)).json()) as { sessions: { id: string }[] };
check("…and the session", !gone.sessions.some((s) => s.id === cId), JSON.stringify(gone.sessions.map((s) => s.id)));
check("the worktree is STILL THERE", fs.existsSync(WT("demo-DRY-3")), WT("demo-DRY-3"));
const sweptNote = await page.locator("p.note").count();
check("and nothing claimed otherwise", sweptNote === 0, `${sweptNote} note banner(s)`);

// --- A: Reset refuses, then discards on demand -------------------------------
console.log("\nA. the panel's Reset");
// DRY-5, not DRY-3: the sidebar's pull is `open=true`, so a CLOSED ticket has
// no row to click. (DRY-3 is closed in the stub, which is what made it the
// right ticket for B and C and the wrong one here.)
const aPath = addWorktree(fixture, "demo-DRY-5", "agent/DRY-5");
fs.writeFileSync(`${aPath}/README.md`, "# demo\nunsaved work\n");
await page.locator(".grp").first().click().catch(() => {});
await page.waitForTimeout(400);
await page.locator(".row", { hasText: "DRY-5" }).first().click();
await page.waitForSelector(".panel", { timeout: 5000 });
await page.waitForTimeout(1000);
const reuse = await page.locator(".wt-reuse").count();
check("the panel offers Reset for an existing worktree", reuse === 1, `${reuse}`);
await page.locator(".wt-reuse .wt-reset").click();
await page.waitForTimeout(1500);
const refused = await page.locator(".wt-refused").first().textContent().catch(() => null);
check("Reset is refused, and says what it found", !!refused && /uncommitted/.test(refused), (refused ?? "(nothing)").trim());
check("…and the worktree is untouched", fs.existsSync(aPath), aPath);
await page.locator(".wt-refused .wt-reset").click();
await page.waitForTimeout(2000);
check("Reset anyway discards it", !fs.existsSync(aPath), aPath);

await page.screenshot({ path: "/tmp/dry90-ui.png" });
await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
