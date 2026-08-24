// DRY-72: the sidebar must stop making the browser wait on the tracker, and
// stop asking the tracker N times for what it asked once.
//
// Why not curl: every claim here is about REQUESTS THAT DIDN'T HAPPEN, or about
// how long one took. `curl /api/tracker/tickets` returns the same 200 with the
// same body whether the daemon answered from memory or spent six seconds
// re-walking a corporate Jira — which is exactly the state the bug shipped in.
// So the harness counts at the origin (stub-tracker.mts) and asserts on timings.
//
// The halves are separate tests and neither subsumes the other:
//
//   the load half     N pulls become one fan-out; the child-stats query, which
//                     spans every status and is the unbounded part, doesn't
//                     repeat per poll. Measured upstream.
//   the latency half  a poll returns immediately even while the tracker is slow,
//                     and Refresh still overrules the cache and waits.
//   the outage half   a tracker that dies leaves the daemon serving last-good
//                     with `stale` set — 200, not 502 — and a COLD key still
//                     502s. This is where DRY-55 goes to die if it's going to:
//                     the browser's catch stops firing once the daemon absorbs
//                     the failure, so the surface section at the end re-proves
//                     the stale marker end-to-end rather than trusting the field.
//
// The `page.evaluate` bodies in sections (k) and (l) are functions rather than
// strings, and that is checked rather than assumed: they bind no name to a
// function, so they pick up none of tsx's `__name(...)` wrapping (see the note
// at the top of surface.mts). A `const q = (s) => …` added inside one would
// break it — which is also why (l) shadows `visibilityState` with a data
// property instead of the getter that would otherwise be the obvious spelling.
//
// Setup + overrides: see README.md. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/tracker-cache.mts)
import { chromium } from "playwright";
import type { Detail, TicketsResponse } from "./api.mjs";
// The stub's own declaration of what it serves (DRY-80) — `import type`
// erases, so this does not start a second stub.
import type { StubState } from "./stub-tracker.mjs";

const DAEMON = process.env.DAEMON_URL ?? "http://127.0.0.1:4385";
const STUB = process.env.STUB_URL ?? "http://127.0.0.1:4386";
const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5385";

let failures = 0;
function check(name: string, ok: boolean, extra: Detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The control routes answer three different shapes — `/__heal` a mode,
// `/__latency` a latency, `/__reset` the counters — and nothing here reads any
// of them. `unknown` says that; naming one of the three would be a guess two
// thirds wrong (DRY-80).
const ctl = (p: string): Promise<unknown> =>
  fetch(`${STUB}${p}`, { method: "POST" }).then((r) => r.json());
const stubState = (): Promise<StubState> =>
  fetch(`${STUB}/__state`).then((r) => r.json() as Promise<StubState>);

/**
 * One sidebar pull, as the shell issues it.
 *
 * `body` is a PARTIAL response plus an optional error: a cold-key 502 carries
 * no `tickets` at all, and section (g) is precisely the assertion that it
 * doesn't. Typing it as the full envelope would be the guess this file was
 * converted to stop making.
 */
interface PullResult {
  status: number;
  body: Partial<TicketsResponse> & { error?: string };
  ms: number;
}

/**
 * Budgeted, and that is not hygiene: section (h) exists precisely because a
 * daemon with no deadline of its own never answers a hung tracker, so an
 * unbudgeted probe there wouldn't fail — it would hang the whole run, which
 * reports as nothing at all. A blown budget is recorded as status 0 so every
 * later assertion still gets to speak.
 */
async function pull({ fresh = false, backlog = false } = {}): Promise<PullResult> {
  const params = new URLSearchParams({ open: "true" });
  if (fresh) params.set("fresh", "true");
  if (backlog) params.set("backlog", "true");
  const t0 = Date.now();
  try {
    const res = await fetch(`${DAEMON}/api/tracker/tickets?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as PullResult["body"];
    return { status: res.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, ms: Date.now() - t0 };
  }
}

/**
 * Wait for any BACKGROUND refresh to land, so counts are quiescent.
 *
 * Gated on the stub's `inflight` and not just on the totals holding still: a
 * provider issues its queries in sequence, so under latency there is a window
 * between two of them where nothing has changed and nothing is finished either.
 * A totals-only probe returns during that gap and the next section's `__reset`
 * then lands mid-fan-out, which shows up later as an off-by-one nobody can
 * reproduce.
 */
async function settle(): Promise<number> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const st = await stubState();
    if (st.inflight === 0 && st.total === prev && ++stable >= 2) return st.total;
    if (st.inflight !== 0 || st.total !== prev) stable = 0;
    prev = st.total;
    await sleep(250);
  }
  return prev;
}

/** What the sidebar is saying, for sections (k) and (l). */
interface SidebarSnap {
  groups: number;
  stale: boolean;
  unreachable: string | null;
  notices: string[];
}

const browser = await chromium.launch();
try {
  console.log("\n(a) concurrent pulls become ONE fan-out");
  await ctl("/__heal");
  await ctl("/__latency?ms=0");
  await ctl("/__reset");
  // Cold key, six clients at once — six browser tabs, or one tab and five
  // reloads. Uncached this was six full fan-outs at the tracker.
  const burst = await Promise.all(Array.from({ length: 6 }, () => pull()));
  await settle();
  let s = await stubState();
  check("every pull answered", burst.every((r) => r.status === 200), JSON.stringify(burst.map((r) => r.status)));
  // `-1` for a pull that returned no list at all, NOT `undefined`. `?.length`
  // reads as a tidy way to satisfy the compiler and quietly makes this vacuous:
  // six failed pulls are six `undefined`s, which is a Set of size 1, so the
  // check passes precisely when nothing was returned. The sizes must also be
  // non-zero for the same reason — "all six agree that the list is empty" is
  // not the claim. (Section (a) is where a cache serving nothing very
  // efficiently would otherwise look like a pass.)
  const sizes = burst.map((r) => r.body.tickets?.length ?? -1);
  check(
    "all six got the same list",
    new Set(sizes).size === 1 && sizes[0] > 0,
    sizes.join(","),
  );
  check("the tracker saw ONE list query, not six", s.list === 1, `list=${s.list}`);
  // At MOST one fan-out, not exactly one: the child-stats TTL is minutes and
  // deliberately outlives a harness run, so a second run against the same daemon
  // legitimately makes no child query at all. Pinning it to exactly one would
  // make this file pass only on the first run after a daemon start — a harness
  // that depends on invisible rig state is the kind that gets ignored. The claim
  // being made is "six pulls cost one fan-out"; what the fan-out contains is
  // asserted next, by value.
  check("six pulls cost at most one fan-out", s.total <= 3, `${s.total} upstream requests: ${JSON.stringify(s)}`);
  check("and at most one child-stats query", s.children <= 1, `children=${s.children}`);
  // The counts being right is worthless if the data is wrong — a cache that
  // serves an empty list is also very efficient.
  const epic = burst[0].body.tickets?.find((t) => t.key === "DRY-1");
  check("the epic's child stats survive the cache", epic?.childStats?.total === 2, JSON.stringify(epic?.childStats ?? null));

  console.log("\n(b) inside the TTL, nothing reaches the tracker at all");
  const before = (await stubState()).total;
  await Promise.all(Array.from({ length: 6 }, () => pull()));
  s = await stubState();
  check("six more pulls, zero upstream requests", s.total === before, `${s.total} vs ${before}`);

  console.log("\n(c) the TTL expires — the list refreshes, the child stats don't");
  await ctl("/__reset");
  const t0 = Date.now();
  let refreshed = false;
  // Poll like the shell does rather than sleeping a constant: the TTL is host
  // config and a fixed sleep would either race it or hide a regression.
  while (Date.now() - t0 < 20_000) {
    await pull();
    if ((await stubState()).list > 0) {
      refreshed = true;
      break;
    }
    await sleep(500);
  }
  const ttlSeconds = Math.round((Date.now() - t0) / 100) / 10;
  check("the list does refresh once the TTL is out", refreshed, refreshed ? `after ${ttlSeconds}s` : "never in 20s");
  // Same rule as sweep.mts: 20s is the right default and a terrible test. A run
  // against the default would spend its life waiting and prove nothing about
  // the child-stats TTL sitting behind it.
  check(
    "the rig turned the TTL down (DRYDOCK_TRACKER_CACHE_MS)",
    ttlSeconds < 15,
    ttlSeconds >= 15 ? `${ttlSeconds}s — this looks like the default; see README.md` : `${ttlSeconds}s`,
  );
  await settle();
  s = await stubState();
  check("the child-stats query did NOT repeat with it", s.children === 0, `children=${s.children}`);

  console.log("\n(d) a slow tracker doesn't become a slow sidebar");
  await ctl("/__latency?ms=2500");
  await ctl("/__reset");
  await sleep(6000); // let the entry go stale under the turned-down TTL
  const quick = await pull();
  check("the pull answers immediately", quick.ms < 800, `${quick.ms}ms against a 2500ms tracker`);
  check("and answers with real rows", (quick.body.tickets?.length ?? 0) > 0, `${quick.body.tickets?.length} tickets`);
  check("not marked stale — nothing has failed", !quick.body.stale, JSON.stringify(quick.body.stale ?? null));
  await settle();

  console.log("\n(e) Refresh still overrules the cache, and waits for the truth");
  await ctl("/__reset");
  const forced = await pull({ fresh: true });
  check("a forced pull waits for the tracker", forced.ms > 2000, `${forced.ms}ms`);
  s = await stubState();
  check("and it actually re-queried", s.list === 1, `list=${s.list}`);
  await ctl("/__latency?ms=0");
  await settle();

  console.log("\n(f) the tracker dies — the daemon keeps answering");
  await ctl("/__break?mode=502");
  const broken = await pull({ fresh: true });
  check("still 200, not 502", broken.status === 200, `${broken.status}`);
  check("the last-good list is retained", (broken.body.tickets?.length ?? 0) > 0, `${broken.body.tickets?.length} tickets`);
  check("and it says so", !!broken.body.stale, JSON.stringify(broken.body.stale ?? null));
  check("the reason is quoted", /502/.test(broken.body.stale?.error ?? ""), broken.body.stale?.error ?? "(none)");
  check("with an age", typeof broken.body.stale?.ageMs === "number", JSON.stringify(broken.body.stale ?? null));
  // The error rides along on EVERY poll now, so an unbounded one is a body the
  // size of the tracker's error page 4320 times a day.
  check("and it's capped", (broken.body.stale?.error ?? "").length <= 500, `${(broken.body.stale?.error ?? "").length} chars`);

  console.log("\n(g) a key it has never fetched still fails honestly");
  // DRY-55's empty case, one layer down: serving last-good is right, inventing
  // one is not. `backlog=true` is a different cache key and this daemon has
  // never pulled it.
  const cold = await pull({ fresh: true, backlog: true });
  check("a cold key 502s rather than answering empty", cold.status === 502, `${cold.status} ${JSON.stringify(cold.body).slice(0, 120)}`);

  console.log("\n(h) a tracker that accepts and goes silent");
  await ctl("/__heal");
  await pull({ fresh: true });
  await ctl("/__break?mode=hang");
  const hung = await pull({ fresh: true });
  // The daemon's own deadline is the only thing that can end this; nothing
  // propagates a client's abort, so without one this never returns.
  check("the daemon gives up rather than hanging", hung.status === 200, `${hung.status} after ${hung.ms}ms`);
  check("within its request deadline", hung.ms < 10_000, `${hung.ms}ms`);
  check("and reports it as stale", !!hung.body.stale, JSON.stringify(hung.body.stale ?? null));
  check("keeping the list", (hung.body.tickets?.length ?? 0) > 0, `${hung.body.tickets?.length} tickets`);

  console.log("\n(i) the outage ends on its own");
  await ctl("/__heal");
  const healed = await pull({ fresh: true });
  check("stale clears", !healed.body.stale, JSON.stringify(healed.body.stale ?? null));
  check("rows intact", (healed.body.tickets?.length ?? 0) > 0, `${healed.body.tickets?.length} tickets`);

  console.log("\n(j) DRY-84: aging counts only while somebody is asking");
  // Both halves are the same nine seconds of a list not being refreshed. The
  // only difference is whether anybody polled during them, and that has to be
  // the difference between silence and a notice — which is what the ticket was
  // opened over: the desk raised "no successful refresh in Ns" against a
  // corporate Jira with no outage behind it, because a hidden tab stops polling
  // (DRY-72 trap 9) and the entry then ages with nothing able to refresh it.
  await ctl("/__heal");
  await ctl("/__latency?ms=0");
  await pull({ fresh: true }); // a known-fresh entry to start the clock from
  await ctl("/__reset");
  await sleep(9000); // nobody asks, for well over the staleness window
  const woke = await pull();
  check("the pull after the silence is answered", woke.status === 200, `${woke.status}`);
  check("and is NOT marked stale", !woke.body.stale, JSON.stringify(woke.body.stale ?? null));
  check("it really had gone unrefreshed", (await stubState()).list <= 1, JSON.stringify(await stubState()));
  await settle();

  // The other half, and the one that fails loudly if the rig left the staleness
  // window at its 60s default: the same aging WHILE POLLED must still report,
  // or DRY-72's trap 3a is undone and a tracker that is slow rather than broken
  // goes back to being invisible.
  await pull({ fresh: true });
  await ctl("/__reset");
  // Long enough to still be running when the window closes, short enough that
  // the daemon's own request deadline doesn't turn it into a FAILURE instead.
  await ctl("/__latency?ms=2000");
  let stalled: PullResult | null = null;
  const stallStart = Date.now();
  while (Date.now() - stallStart < 12_000) {
    const r = await pull();
    if (r.body.stale) {
      stalled = r;
      break;
    }
    await sleep(300);
  }
  const stallSeconds = Math.round((Date.now() - stallStart) / 100) / 10;
  check(
    "a list nobody can refresh, while polled, is still called stale",
    !!stalled,
    stalled ? `after ${stallSeconds}s` : "never in 12s — is DRYDOCK_TRACKER_STALE_AFTER_MS set? see README.md",
  );
  check("and the daemon says WHICH kind it is", stalled?.body.stale?.reason === "stalled", stalled?.body.stale?.reason ?? "(none)");
  check(
    "quoting the refresh that hasn't landed, not the age",
    /a refresh has been running/.test(stalled?.body.stale?.error ?? ""),
    stalled?.body.stale?.error ?? "(none)",
  );
  // Same rule as section (c): the shipping window is 60s and a run that waited
  // one out would prove nothing about either half above.
  check(
    "the rig turned the staleness window down (DRYDOCK_TRACKER_STALE_AFTER_MS)",
    stallSeconds < 15,
    `${stallSeconds}s`,
  );
  await ctl("/__latency?ms=0");
  await settle();

  console.log("\n(k) at the surface — the sidebar still says when it's out of date");
  // The half that cannot be checked from here. Before DRY-72 a tracker outage
  // reached the browser as a FAILED FETCH, and every DRY-55 assertion hangs off
  // that catch. It doesn't fail any more — the daemon answers 200 — so if the
  // shell didn't read `stale`, the marker and the notice would both vanish while
  // every poll looked perfectly healthy. That is the regression this section is
  // for, and no amount of asserting on the JSON above would catch it.
  //
  // Note what it is NOT: a discriminator for the cache. Run against
  // DRYDOCK_TRACKER_CACHE_MS=0 this section passes, because the daemon 502s and
  // the shell's own catch raises the identical marker and notice — which is the
  // point, the contract holds in both worlds. Sections (e) and (g) are the same
  // kind of guard. The cache claims are (a)-(d), (f) and (h), and those fail
  // loudly against an uncached daemon; see README.md for the numbers.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const snap = (): Promise<SidebarSnap> =>
    page.evaluate(() => ({
      // Repo groups render collapsed, so `.row` counts nothing — same trap as
      // sidebar.mts. Assert on `.grp`.
      groups: document.querySelectorAll(".sidebar .grp").length,
      stale: !!document.querySelector(".sidebar .stale"),
      unreachable: document.querySelector(".sidebar .unreachable-head")?.textContent?.trim() ?? null,
      notices: [...document.querySelectorAll(".notice")]
        .map((n) => (n.textContent ?? "").trim())
        .filter((t) => /Tickets aren't (loading|refreshing)/.test(t)),
    }));
  const waitFor = async (fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (await fn()) return true;
      await sleep(250);
    }
    return false;
  };

  await page.goto(SHELL);
  await page.waitForSelector(".sidebar", { timeout: 15_000 });
  const drew = await waitFor(async () => (await snap()).groups > 0);
  check("the sidebar draws against a healthy tracker", drew);
  const good = (await snap()).groups;

  await ctl("/__break?mode=502");
  await page.click(".sidebar .refresh");
  const marked = await waitFor(async () => (await snap()).stale);
  check("the outage reaches the sidebar", marked);
  const v = await snap();
  check("the rows are kept", v.groups === good && good > 0, `${v.groups} vs ${good}`);
  // Throwing away a working list to announce an outage is the worse bug.
  check("no outage block over real rows", v.unreachable === null, v.unreachable ?? "absent");
  check("one notice, and it says REFRESHING", v.notices.length === 1 && /aren't refreshing/.test(v.notices[0] ?? ""), JSON.stringify(v.notices));

  await ctl("/__heal");
  await page.click(".sidebar .refresh");
  const cleared = await waitFor(async () => !(await snap()).stale);
  check("and it clears itself, no reload", cleared);
  check("the notice cleared too", (await snap()).notices.length === 0, JSON.stringify((await snap()).notices));

  console.log("\n(l) DRY-84: a tab that stopped polling doesn't come back to an outage");
  // The reported symptom end to end, and a claim section (j) cannot make:
  // section (j) proves the daemon no longer SAYS stale, this one proves the desk
  // no longer raises a notice — and the notice is a condition (DRY-51/58), so it
  // is raised by one pull and cleared by another, not rendered from the last
  // response. A daemon fix with the shell still reporting from somewhere else
  // would pass (j) and fail here.
  //
  // The tab is hidden by SHADOWING document.visibilityState and firing the
  // event, never by really backgrounding the headless page: Chromium throttles a
  // background tab's timers to about once a minute, so the real thing measures
  // the browser's throttler instead of this code (DRY-60 trap 1). A data
  // property rather than a getter, which also keeps every `page.evaluate` body
  // here free of functions — tsx's transform wraps a named one in a `__name(…)`
  // helper the page doesn't have (see the header).
  await ctl("/__latency?ms=0");
  await ctl("/__reset");
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await sleep(9000); // longer than the staleness window, with nobody asking
  const idle = await stubState();
  // The premise, not decoration: if the hidden tab had gone on polling, the
  // entry would have been refreshed and there would be nothing to report. Zero
  // upstream requests is what says it sat there getting old — and it re-proves
  // DRY-72 trap 9, which is the half of this that must NOT be "fixed" by making
  // a hidden tab poll again.
  check("the hidden tab stopped polling", idle.list === 0, `list=${idle.list} total=${idle.total}`);
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const pulled = await waitFor(async () => (await stubState()).list > 0, 10_000);
  check("coming back pulls immediately", pulled);
  await sleep(3000); // longer than that pull and the refresh behind it
  const back = await snap();
  check("and raises no outage notice", back.notices.length === 0, JSON.stringify(back.notices));
  check("nor the stale marker", !back.stale, `stale=${back.stale}`);
  check("with the rows still on screen", back.groups === good && good > 0, `${back.groups} vs ${good}`);
} finally {
  await browser.close();
  await ctl("/__heal").catch(() => {});
  await ctl("/__latency?ms=0").catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
