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
//
// The `page.evaluate` bodies below are functions rather than strings, and that
// is checked rather than assumed — none of them binds a name to a function, so
// none picks up tsx's `__name(...)` wrapper (see the note at the top of
// surface.mts). A `const q = (s) => …` added inside one would break it.
//
// Run from `daemon/`, where tsx resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/sweep.mts)
import { chromium, type Page } from "playwright";
import type { ConfigResponse, HealthResponse, SessionInfo, SessionsResponse, SpawnResponse } from "./api.mjs";

const DAEMON = process.env.DRY60_DAEMON ?? "http://127.0.0.1:4360";
const SHELL = process.env.DRY60_SHELL ?? "http://127.0.0.1:5360";

/** The session poll's period. Every wait below is a multiple of it, not a guess. */
const POLL_MS = 3000;

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

/**
 * The 204/unparseable case really does yield null, and the cast folds it in —
 * one deliberate assertion at the boundary rather than a `!` at every call
 * site. The type parameter each caller names IS checked, against the daemon's
 * own response types.
 *
 * The trailing comma on `<T,>` is required in a `.mts` file: `<T>` alone at the
 * start of an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
 */
const api = async <T,>(p: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${DAEMON}${p}`, init);
  if (!res.ok && res.status !== 404) throw new Error(`${p} -> ${res.status}`);
  return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const json = (body: unknown): RequestInit => ({
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

async function spawn(args: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const out = await api<SpawnResponse>("/api/sessions", json({ command: "/bin/sh", args, ...extra }));
  return out.session.id;
}

const listed = async (): Promise<SessionInfo[]> =>
  (await api<SessionsResponse>("/api/sessions")).sessions;
const byId = async (id: string): Promise<SessionInfo | undefined> =>
  (await listed()).find((s) => s.id === id);

/**
 * Which tier this daemon is on. The sweep behaves identically either way; what
 * differs is what a swept session leaves behind, and therefore whether the desk
 * owes anybody a warning about it.
 */
const KEEPS_HISTORY =
  (await api<HealthResponse>("/healthz")).store?.capabilities?.sessionHistory === true;
console.log(`tier: ${KEEPS_HISTORY ? "postgres (history kept)" : "file (no history)"}`);

/** The DRY-58 notice line, if the desk is holding one about session history. */
const historyNotice = (page: Page): Promise<string | undefined> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".notice")]
      .map((n) => (n.textContent ?? "").trim())
      .find((t) => t.includes("aren't being recorded")),
  );

/**
 * The host's sweep delay, read rather than assumed — this harness is only
 * meaningful against a daemon started with it turned down, and hardcoding it
 * here would mean silently waiting out five real minutes and calling it a pass.
 */
const config = await api<ConfigResponse>("/api/config");
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
async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((v) => {
    Object.defineProperty(document, "visibilityState", { value: v ? "visible" : "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: !v, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}

/** One rail card, measured three separate ways — see `cards` below. */
interface Card {
  label: string;
  meta: string;
  state: string;
  clearing: boolean;
  metaShown: boolean;
  metaFits: boolean;
  cardInLane: boolean;
}

/**
 * Every rail card, as {label, meta, metaShown, metaFits, cardInLane, state}.
 *
 * Three separate questions, and each one has been the bug:
 *
 *  - **is it in the DOM** — what `textContent` answers, and it answers it for a
 *    `display:none` node too, so the first cut of this harness passed against a
 *    countdown nobody could see.
 *  - **is it in its card** — `metaFits`. The card is `overflow: hidden`, so a
 *    clock too wide for it is silently cut, and the id sits beside it.
 *  - **is the CARD in the lane** — `cardInLane`. The one the second cut still
 *    missed: `.underway` is a non-wrapping `overflow-x: auto` row, and
 *    `getClientRects()` is non-empty for an element an ANCESTOR clips —
 *    clipping doesn't remove the layout box. So a card 300px past the lane's
 *    right edge passed both of the checks above, and widening the card to fit
 *    the clock on row 1 is exactly what pushes the far cards out there. The
 *    sort puts quiet (finished, counting-down) cards last, so they are the ones
 *    that go.
 */
const cards = (page: Page): Promise<Card[]> =>
  page.evaluate(() => {
    const laneRect = document.querySelector(".underway")?.getBoundingClientRect();
    return [...document.querySelectorAll(".card")].map((c) => {
      const meta = c.querySelector(".meta");
      const id = c.querySelector(".id");
      const cr = c.getBoundingClientRect();
      const mr = meta?.getBoundingClientRect();
      const ir = id?.getBoundingClientRect();
      // The countdown moved to the card's SECOND ROW below full density, so
      // "not sitting on the id" is a question about rows, not columns — two
      // elements on different rows cannot overlap whatever their x extents are.
      const sharesRowWithId =
        !!mr && !!ir && !(mr.top >= ir.bottom - 0.5 || mr.bottom <= ir.top + 0.5);
      return {
        label: id?.textContent?.trim() ?? "",
        meta: meta?.textContent?.trim() ?? "",
        state: c.className.replace("card", "").trim(),
        // The card's own verdict, not the wording.
        clearing: c.classList.contains("clearing"),
        metaShown:
          !!meta && getComputedStyle(meta).display !== "none" && meta.getClientRects().length > 0,
        metaFits:
          !!mr &&
          mr.right <= cr.right + 0.5 &&
          mr.left >= cr.left - 0.5 &&
          mr.bottom <= cr.bottom + 0.5 &&
          // `!!ir` is implied by `sharesRowWithId` and stated anyway: the
          // implication is not one a compiler can follow, and an assertion here
          // would be the guess this file was converted to stop making.
          (!sharesRowWithId || (!!ir && ir.right <= mr.left + 0.5)),
        cardInLane:
          !!laneRect && cr.right <= laneRect.right + 0.5 && cr.left >= laneRect.left - 0.5,
      };
    });
  });

/** Every window frame, as {title, tag}. `.statustag` is where the countdown renders. */
interface Frame {
  title: string;
  tag: string;
}
const frames = (page: Page): Promise<Frame[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".frame")].map((f) => ({
      title: f.querySelector(".title")?.textContent?.trim() ?? "",
      tag: f.querySelector(".statustag")?.textContent?.trim() ?? "",
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
  okCard?.meta.startsWith("clears") === true && okCard.metaShown && okCard.metaFits,
  `meta=${JSON.stringify(okCard?.meta)} shown=${okCard?.metaShown} fits=${okCard?.metaFits}`,
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

const win = (id: string, title: string, z: number, extra: Record<string, unknown> = {}) => ({
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
const tagOf = (t: string) => open.find((f) => f.title === t)?.tag ?? "(no frame)";
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

// --- Round C: a crowded rail still says what it is about to do ---------------
// The rail sheds detail as it fills — full (≤3) → compact (≤8) → tile — and
// `.meta` is the first thing to go. That put the countdown at `display:none`
// from four runs upward, which is the crowded desk the whole ticket is about:
// cards vanishing with the warning never having rendered once.
//
// The FIRST fix for that was to widen a counting-down card instead (tile 112px
// → compact 176px), and it was no better, because the lane is a single
// non-wrapping `overflow-x: auto` row: measured at a 1500px viewport, ten
// compact cards want 2023px of a 1208px lane and five of them sat off the
// right-hand edge — rendered, and no more readable than `display:none`. Hence
// the width assertion below, which is the one that discriminates: the countdown
// has to cost the card NO width, and it doesn't, because below full density it
// takes the second row (the action line's, which crowding has already emptied).
console.log("\n--- round C: ten runs, and every countdown still legible ---");

const CROWD = 10;
const crowd: string[] = [];
for (let i = 0; i < CROWD; i++) {
  crowd.push(
    await spawn(ENDS_WELL, { autonomous: true, ticket: `DRY60-C${i}`, title: `DRY60-C${i}` }),
  );
}
await sleep(4000);

await page.goto(SHELL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".topbar");
await page.waitForSelector(".card", { timeout: 20000 });
await setVisible(page, true);
await sleep(POLL_MS * 2);

seen = await cards(page);
const counting = seen.filter((c) => c.clearing);
check(
  `all ${CROWD} crowded cards are counting down`,
  counting.length === CROWD && counting.every((c) => /^(clears )?\d+:\d\d$/.test(c.meta)),
  `${counting.length}/${CROWD}: ${JSON.stringify(seen.map((c) => c.meta))}`,
);
check(
  "and the number is actually on screen, not hidden by the density tier",
  counting.length > 0 && counting.every((c) => c.metaShown),
  `${counting.filter((c) => !c.metaShown).length} hidden`,
);
check(
  "and it fits its card rather than being clipped or sat on the id",
  counting.length > 0 && counting.every((c) => c.metaFits),
  `${counting.filter((c) => !c.metaFits).length} clipped/overlapping`,
);
// The regression the first fix shipped, and the check that discriminates it.
// At ten cards the tier is `tile`; a counting-down card any wider than that is
// buying its own legibility with somebody else's card, because the lane is one
// non-wrapping scrolling row.
//
// This is deliberately a claim about WIDTH and not about how many cards are
// visible. "All ten are on screen" is not true at any density — the lane has
// always scrolled at ten — so asserting it would be asserting the rail is
// something it isn't. The off-lane count rides along in the detail because it
// is the human-readable consequence: it went 2 → 5 when the card widened, and
// back to 2 when the clock moved to the second row.
//
// Note there is no separate "the countdown is inside the lane" check, though an
// earlier draft had one. It cannot fail: a meta inside its card (metaFits) on a
// card inside the lane is inside the lane by construction, so it passed against
// the very bug it was written for. A check that can't fail is worse than none.
const offLane = counting.filter((c) => !c.cardInLane).length;
check(
  "and it costs the card no width — the crowd is still at the tier's own size",
  counting.length > 0 && counting.every((c) => c.state.includes("tile")),
  `${offLane}/${counting.length} cards scrolled off the lane; ` +
    `sizes: ${JSON.stringify([...new Set(counting.map((c) => c.state))])}`,
);

await sleep(PAST_SWEEP);
seen = await cards(page);
check(
  "then the whole crowd clears itself",
  // Our own ids, not a global count: `listed()` is a claim about everything
  // that has ever run against this daemon, which round A explicitly refuses to
  // make for exactly this reason.
  !seen.some((c) => c.label.startsWith("DRY60-C")) &&
    (await Promise.all(crowd.map((id) => byId(id)))).every((s) => s === undefined),
  `${seen.length} card(s) left: ${JSON.stringify(seen.map((c) => c.label))}`,
);

// --- Round D: docked, and focus nobody chose --------------------------------
// Two separate ways a window could be taken with no warning anywhere:
//   a DOCKED window has no surface that can render a countdown at all;
//   and `wm.focusedId` is assigned SYNTHETICALLY — by remove(), by add(), and
//   left stale by minimize() — so the sweep's focus exemption could land on a
//   window nobody has ever clicked and hold it forever.
console.log("\n--- round D: the dock, and focus nobody chose ---");

const dockedD = await spawn(ENDS_WELL, { title: "DRY60-DOCKED" });
const plainE = await spawn(ENDS_WELL, { title: "DRY60-TOPZ" });
const plainF = await spawn(ENDS_WELL, { title: "DRY60-UNDER" });
await sleep(3000);

await api("/api/workspace", {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  // plainE has the top z, so restore() focuses it (useWindowManager.apply) —
  // without anybody having touched it. NOTHING is clicked in this round.
  body: JSON.stringify({
    version: 2,
    layout: "float",
    windows: [
      win(plainE, "DRY60-TOPZ", 5),
      win(plainF, "DRY60-UNDER", 4),
      { ...win(dockedD, "DRY60-DOCKED", 3), minimized: true },
    ],
  }),
});

await page.goto(SHELL, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".topbar");
await page.waitForSelector(".frame", { timeout: 20000 });
await setVisible(page, true);
await sleep(POLL_MS * 2);

open = await frames(page);
const tagFor = (t: string) => open.find((f) => f.title === t)?.tag ?? "(no frame)";
check(
  "a window focused by the window manager, not by a person, still counts down",
  tagFor("DRY60-TOPZ").startsWith("clears in") && tagFor("DRY60-UNDER").startsWith("clears in"),
  `topz=${JSON.stringify(tagFor("DRY60-TOPZ"))} under=${JSON.stringify(tagFor("DRY60-UNDER"))}`,
);

await sleep(PAST_SWEEP);
open = await frames(page);
const left = open.map((f) => f.title);
check(
  "so both of them clear — a synthetic focus can't exempt one forever",
  !left.includes("DRY60-TOPZ") && !left.includes("DRY60-UNDER"),
  `frames=${JSON.stringify(left)}`,
);
// DOCKED is the you-owned lane: "you put them here and you're coming back, and
// they never change unless you touch them". A dock item has nowhere to put a
// countdown, so the sweep must not be what touches it.
check(
  "a docked window is never taken by the sweep — nothing there could have warned you",
  (await byId(dockedD)) !== undefined,
  `session ${(await byId(dockedD)) ? "still listed" : "GONE"}`,
);
const dockCount = await page.textContent(".sweep-n").catch(() => null);
check(
  "but the button still counts it, and still takes it",
  dockCount?.trim() === "1",
  `"Clear finished" offers ${JSON.stringify(dockCount)}, want "1"`,
);
await page.click(".sweep");
await sleep(POLL_MS * 2);
check(
  "…and it is gone once asked",
  (await byId(dockedD)) === undefined,
  `session ${(await byId(dockedD)) ? "STILL LISTED" : "gone"}`,
);

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
