// Finished sessions clear themselves, and nothing else does (DRY-60).
//
// A session that ends stays in the daemon's registry on purpose — a terminal
// state has to survive until somebody sees it — and before this, *seeing it* was
// the only thing that cleared it, one window and one card at a time. The fix is
// a delay plus a "Clear finished" button, and both are destructive, so what
// needs holding down is mostly what they must NOT take.
//
// Browser, because every claim here is about the desk: which windows are on it,
// which one has focus, and whether the tab is in front of somebody. None of that
// exists at the API, where all four sessions below look identical — exited.
//
// Rig in this directory's README. Run it against BOTH tiers: the file store is
// where a swept session's scrollback was the only copy there ever was, and the
// database tier is where a removed window could come back as a tombstone
// (round B's "the window is gone" is what proves it doesn't).
import { chromium } from "playwright";

const DAEMON = process.env.DRY60_DAEMON ?? "http://127.0.0.1:4360";
const SHELL = process.env.DRY60_SHELL ?? "http://127.0.0.1:5360";

/** The session poll's period. Every wait below is a multiple of it, not a guess. */
const POLL_MS = 3000;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

const api = async (p, init) => {
  const res = await fetch(`${DAEMON}${p}`, init);
  if (!res.ok && res.status !== 404) throw new Error(`${p} -> ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Ends on its own, cleanly. The thing the sweep is for. */
const ENDS_WELL = ["-c", "sleep 1"];
/** Ends on its own, badly — a non-zero exit is what sets `failure`. */
const ENDS_BADLY = ["-c", "exit 3"];
/** Never ends. Standing in for an agent still working. */
const RUNS_ON = ["-c", "while :; do sleep 1; done"];

async function spawn(args, extra = {}) {
  const out = await api("/api/sessions", json({ command: "/bin/sh", args, ...extra }));
  return out.session.id;
}

const listed = async () => (await api("/api/sessions")).sessions;
const byId = async (id) => (await listed()).find((s) => s.id === id);

/**
 * Which tier this daemon is on. The sweep behaves identically either way; what
 * differs is what a swept session leaves behind, and therefore whether the desk
 * owes anybody a warning about it.
 */
const KEEPS_HISTORY = (await api("/healthz")).store?.capabilities?.sessionHistory === true;
console.log(`tier: ${KEEPS_HISTORY ? "postgres (history kept)" : "file (no history)"}`);

/** The DRY-58 notice line, if the desk is holding one about session history. */
const historyNotice = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".notice")]
      .map((n) => n.textContent.trim())
      .find((t) => t.includes("aren't being recorded")),
  );

/**
 * The host's sweep delay, read rather than assumed — this harness is only
 * meaningful against a daemon started with it turned down, and hardcoding it
 * here would mean silently waiting out five real minutes and calling it a pass.
 */
const config = await api("/api/config");
const SWEEP_MS = config?.desk?.clearFinishedAfterMs;
if (!SWEEP_MS || SWEEP_MS > 30_000) {
  console.log(
    `this daemon's DRYDOCK_CLEAR_FINISHED_AFTER_MS is ${SWEEP_MS} — start it with something ` +
      `under 30000 (see the README) or this harness measures nothing`,
  );
  process.exit(2);
}
/** Long enough for the sweep to have happened, with two polls of slack. */
const PAST_SWEEP = SWEEP_MS + POLL_MS * 2;

/**
 * Being in another tab, as the desk sees it.
 *
 * The countdown deliberately measures time in front of a person rather than time
 * since the run ended, and `document.visibilityState` is the only signal there
 * is for that. Overriding the property (and firing the event the desk listens
 * for) tests OUR rule; actually backgrounding a headless tab would also throttle
 * the poll to once a minute and test Chromium's.
 */
async function setVisible(page, visible) {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { value: v ? "visible" : "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: !v, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}

/** Every rail card, as {label, meta}. `.meta` is where the countdown renders. */
const cards = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".card")].map((c) => ({
      label: c.querySelector(".id")?.textContent.trim() ?? "",
      meta: c.querySelector(".meta")?.textContent.trim() ?? "",
      state: c.className.replace("card", "").trim(),
    })),
  );

/** Every window frame, as {title, tag}. `.statustag` is where the countdown renders. */
const frames = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".frame")].map((f) => ({
      title: f.querySelector(".title")?.textContent.trim() ?? "",
      tag: f.querySelector(".statustag")?.textContent.trim() ?? "",
    })),
  );

/**
 * Start from an empty daemon and an empty desk.
 *
 * Not politeness — correctness. This runs against a throwaway daemon, and an
 * earlier run that died partway through (or a `sleep 1` from ten minutes ago)
 * leaves finished sessions behind that are indistinguishable from this run's.
 * The round A assertions below are about a rail with a known number of cards
 * on it, and a leftover is how that reads as a product failure it isn't.
 */
for (const s of await listed()) await api(`/api/sessions/${s.id}/kill`, json({}));
await api("/api/workspace", { method: "DELETE" }).catch(() => {});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on("pageerror", (e) => console.log("  PAGE ERROR:", e.message));

// --- Round A: the rail. Time on screen, not time since it ended -------------
// Autonomous runs, so these are cards with no window — the shape the ticket is
// actually about (two dozen unattended runs finishing while nobody is there).
console.log("\n--- round A: the countdown measures being looked at ---");

const okRun = await spawn(ENDS_WELL, { autonomous: true, ticket: "DRY60-OK", title: "DRY60-OK" });
const badRun = await spawn(ENDS_BADLY, { autonomous: true, ticket: "DRY60-BAD", title: "DRY60-BAD" });
await sleep(3000); // let both reach a terminal state before anything looks

await page.goto(SHELL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".topbar");
await page.waitForSelector(".card", { timeout: 20000 });

// Away. The poll keeps running (we faked the property, not the tab), so this is
// the desk seeing two finished runs on every tick and correctly declining to
// start their clocks.
// Nothing has been lost yet, so nothing may be claimed about losing it — a
// fresh install must not carry a permanent line about a feature it never asked
// for (DRY-56's rule, and the sweep is a second way to break it).
check(
  "a desk that has swept nothing says nothing about history",
  (await historyNotice(page)) === undefined,
  `notice=${JSON.stringify(await historyNotice(page))}`,
);

await setVisible(page, false);
await sleep(SWEEP_MS * 2 + POLL_MS);

let seen = await cards(page);
check(
  "a run that finished while you were in another tab is still there when you come back",
  // Assert on OUR run rather than on a card count: the count is also a claim
  // about everything else that has ever run against this daemon.
  seen.some((c) => c.label === "DRY60-OK") && (await byId(okRun)) !== undefined,
  `after ${Math.round((SWEEP_MS * 2 + POLL_MS) / 1000)}s hidden: ${JSON.stringify(seen.map((c) => c.label))}`,
);
check(
  "and it never started counting down to nobody",
  seen.every((c) => !c.meta.startsWith("clears")),
  JSON.stringify(seen.map((c) => c.meta)),
);

// Back at the desk. The clock starts now.
await setVisible(page, true);
await sleep(POLL_MS * 2);
seen = await cards(page);
const okCard = seen.find((c) => c.label === "DRY60-OK");
const badCard = seen.find((c) => c.label === "DRY60-BAD");
check(
  "the finished card says it is going, before it goes",
  okCard?.meta.startsWith("clears") === true,
  `meta=${JSON.stringify(okCard?.meta)}`,
);
check(
  "the failed card does not — it is not going anywhere",
  badCard !== undefined && !badCard.meta.startsWith("clears"),
  `state=${JSON.stringify(badCard?.state)} meta=${JSON.stringify(badCard?.meta)}`,
);

await sleep(PAST_SWEEP);
seen = await cards(page);
check(
  "the finished run clears itself — card and session both",
  !seen.some((c) => c.label === "DRY60-OK") && (await byId(okRun)) === undefined,
  `cards=${JSON.stringify(seen.map((c) => c.label))}`,
);
// The ticket's one hard constraint. A failure is why you came back.
check(
  "the failed run is left alone, on both",
  seen.some((c) => c.label === "DRY60-BAD") && (await byId(badRun))?.failure !== undefined,
  `cards=${JSON.stringify(seen.map((c) => c.label))}`,
);

// The tier speaking, at the one moment it costs something. On the file store
// that scrollback was the only copy there ever was and the desk just discarded
// it unasked, which is precisely the quiet condition DRY-58's notice is for; on
// Postgres the session is still in history, so there is nothing to warn about
// and a line here would be noise on every host that did the recommended thing.
const notice = await historyNotice(page);
check(
  KEEPS_HISTORY
    ? "a tier that keeps history stays quiet — the swept session is still there"
    : "a tier that keeps none says so, once the sweep has actually cost something",
  KEEPS_HISTORY ? notice === undefined : notice !== undefined,
  `notice=${JSON.stringify(notice)}`,
);

await api(`/api/sessions/${badRun}/kill`, json({}));

// --- Round B: the desk. What a sweep must never take ------------------------
console.log("\n--- round B: windows, focus, and a workspace's second PTY ---");

const keepA = await spawn(ENDS_WELL, { title: "DRY60-FOCUSED" });
const goneB = await spawn(ENDS_WELL, { title: "DRY60-IDLE" });
const liveC = await spawn(RUNS_ON, { title: "DRY60-WORKING" });
const wsAgent = await spawn(ENDS_WELL, { title: "DRY60-WS" });
const wsShell = await spawn(RUNS_ON, { title: "DRY60-WS-SHELL" });
await sleep(3000);

const win = (id, title, z, extra = {}) => ({
  id,
  kind: "terminal",
  type: "bash",
  title,
  repo: "dry60",
  x: 40 + z * 30,
  y: 40 + z * 20,
  w: 460,
  h: 300,
  z,
  minimized: false,
  ...extra,
});
await api(
  "/api/workspace",
  {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // keepA has the top z, so restore focuses it — see useWindowManager.apply.
    // The click below makes that explicit rather than incidental.
    body: JSON.stringify({
      version: 2,
      layout: "float",
      windows: [
        win(keepA, "DRY60-FOCUSED", 5),
        win(goneB, "DRY60-IDLE", 4),
        win(liveC, "DRY60-WORKING", 3),
        // The case the ticket names: a workspace binds a second PTY that has no
        // window of its own. Its agent has exited; its zsh has not.
        win(wsAgent, "DRY60-WS", 2, { kind: "workspace", type: "agent", shellId: wsShell }),
      ],
    }),
  },
);

await page.goto(SHELL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".topbar");
await page.waitForSelector(".frame", { timeout: 20000 });
await setVisible(page, true);
await page.click('.frame:has(.title:text-is("DRY60-FOCUSED")) .body');
await sleep(POLL_MS * 2);

let open = await frames(page);
const tagOf = (t) => open.find((f) => f.title === t)?.tag ?? "(no frame)";
check(
  "an unfocused finished window says it is going, in its own title bar",
  tagOf("DRY60-IDLE").startsWith("clears in"),
  `tag=${JSON.stringify(tagOf("DRY60-IDLE"))}`,
);
check(
  "the focused one has no countdown at all — not a restarting one",
  tagOf("DRY60-FOCUSED") === "",
  `tag=${JSON.stringify(tagOf("DRY60-FOCUSED"))}`,
);

await sleep(PAST_SWEEP);
open = await frames(page);
const titles = open.map((f) => f.title);
check(
  "the unfocused finished window clears itself, and leaves nothing behind",
  !titles.includes("DRY60-IDLE") && (await byId(goneB)) === undefined,
  `frames=${JSON.stringify(titles)}`,
);
check(
  "the window you are sitting in is not taken out from under you",
  titles.includes("DRY60-FOCUSED") && (await byId(keepA)) !== undefined,
  `frames=${JSON.stringify(titles)}`,
);
check(
  "a session that is still working is not swept",
  titles.includes("DRY60-WORKING") && (await byId(liveC))?.status === "running",
  `status=${JSON.stringify((await byId(liveC))?.status)}`,
);
// Half a workspace is not a finished session: clearing the window kills the zsh
// beside the agent, and that is where somebody's half-typed command line lives.
check(
  "a workspace whose agent exited is left while its shell is alive",
  titles.includes("DRY60-WS") && (await byId(wsShell))?.status === "running",
  `frames=${JSON.stringify(titles)} shell=${JSON.stringify((await byId(wsShell))?.status)}`,
);

// --- and the button, which is the escape hatch for all of that --------------
const count = await page.textContent(".sweep-n").catch(() => null);
check(
  "the button counts only what it would actually take",
  count?.trim() === "1",
  `"Clear finished" offers ${JSON.stringify(count)}, want "1" (only the focused one is clearable)`,
);

await page.click(".sweep");
await sleep(POLL_MS * 2);
open = await frames(page);
const after = open.map((f) => f.title);
check(
  "clicking it beats the focus rule — asking is not the same as the desk deciding",
  !after.includes("DRY60-FOCUSED") && (await byId(keepA)) === undefined,
  `frames=${JSON.stringify(after)}`,
);
// The failure worth avoiding, in the ticket's own words: a bulk clear that takes
// a running agent with it.
check(
  "and takes nothing that was still running",
  (await byId(liveC))?.status === "running" &&
    (await byId(wsShell))?.status === "running" &&
    after.includes("DRY60-WORKING") &&
    after.includes("DRY60-WS"),
  `frames=${JSON.stringify(after)}`,
);

for (const id of [liveC, wsAgent, wsShell]) await api(`/api/sessions/${id}/kill`, json({}));
await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
