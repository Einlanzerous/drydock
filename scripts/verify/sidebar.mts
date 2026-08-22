// DRY-55: a tracker outage has to name itself.
//
// Why a browser and not curl: curl against /api/tracker/tickets shows a 502 and
// a clear error body, which is exactly the state in which this bug shipped. The
// claim is about what the SIDEBAR says — and what it said was "No tickets
// match.", a sentence that is also true of a perfectly healthy tracker with
// nothing in scope. Only a rendered page can tell those apart.
//
// Three axes, none of which subsumes another:
//
//   the empty case    an outage that starts BEFORE the first load. No last-good
//                     list, so the sidebar is empty and must say why. The only
//                     one that was ever silent.
//   the stale case    an outage that starts AFTER a good load. The list is
//                     retained and must not pass for current.
//   the hang case     a tracker that accepts and goes silent. Different code
//                     path entirely: nothing rejects, so the catch that powers
//                     both cases above never runs unless the pull is budgeted.
//
// Setup + overrides: see README.md. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/sidebar.mts)
import { chromium, type Page } from "playwright";
// The proxy's own declaration of what it serves, rather than a copy of it here
// (DRY-80). `import type` erases, so this does not start a second proxy.
import type { ProxyTrackerState } from "./proxy-tracker.mjs";
import type { Detail } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5375";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4375";

let failures = 0;
function check(name: string, ok: boolean, extra: Detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (p: string): Promise<ProxyTrackerState> =>
  fetch(`${PROXY}${p}`, { method: "POST" }).then((r) => r.json() as Promise<ProxyTrackerState>);
const state = (): Promise<ProxyTrackerState> =>
  fetch(`${PROXY}/__state`).then((r) => r.json() as Promise<ProxyTrackerState>);

/**
 * Poll until `fn` holds. Fixed sleeps are what make a browser harness flaky:
 * the ticket poll runs every 20s and a pull takes as long as it takes, so any
 * constant is either a stall or a race. Returns seconds waited, or null.
 */
async function waitFor(fn: () => Promise<boolean>, ms = 30_000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(250);
  }
  return null;
}

/** What the sidebar is saying right now. */
interface Snapshot {
  groups: number;
  count: string | null;
  unreachable: string | null;
  why: string | null;
  retry: boolean;
  empty: string | null;
  stale: boolean;
  staleTitle: string | null;
  dotDown: boolean;
  dotWidth: number;
  staleWidth: number;
  notices: string[];
  trackerNotices: string[];
  errors: string[];
}

/**
 * A FUNCTION body, with `document.querySelector` written out rather than behind
 * the `const q = (s) => …` helper it used to have (DRY-80).
 *
 * That helper is the shape tsx breaks: its esbuild transform wraps NAME-BOUND
 * functions in a `__name(...)` helper (keepNames), and Playwright ships an
 * evaluate body to the browser as SOURCE, where that helper does not exist — so
 * the page throws `ReferenceError: __name is not defined` at a line that reads
 * perfectly well. A string body dodges that, and auth.mts takes that route; but
 * a string is opaque to tsc, and this is the largest DOM-reading body in the
 * directory, so stringifying it would exempt exactly the code this conversion
 * was meant to start checking. Repetition is the cheaper price.
 */
function snap(page: Page): Promise<Snapshot> {
  return page.evaluate((): Snapshot => {
    const notices = [...document.querySelectorAll(".notice")].map((n) =>
      (n.textContent ?? "").trim(),
    );
    const stale = document.querySelector(".sidebar .stale");
    return {
      // Repo groups render COLLAPSED, so `.row` counts nothing until one is
      // expanded — a `.row`-based check reads zero against a full sidebar and
      // passes every assertion about an empty one for the wrong reason.
      groups: document.querySelectorAll(".sidebar .grp").length,
      count: document.querySelector(".sidebar .count")?.textContent?.trim() ?? null,
      unreachable:
        document.querySelector(".sidebar .unreachable-head")?.textContent?.trim() ?? null,
      why: document.querySelector(".sidebar .unreachable-why")?.textContent?.trim() ?? null,
      retry: !!document.querySelector(".sidebar .retry"),
      empty: document.querySelector(".sidebar .empty")?.textContent?.trim() ?? null,
      stale: !!stale,
      staleTitle: stale?.getAttribute("title") ?? null,
      dotDown: !!document.querySelector(".sidebar .live.down"),
      // The dot is a 6px empty span in a flex row: `flex: 0 0 auto` is the only
      // thing keeping it from being the first casualty of an overflowing
      // header, and a clamped one is invisible in exactly the case it's for.
      dotWidth: document.querySelector(".sidebar .live")?.getBoundingClientRect().width ?? 0,
      staleWidth: stale?.getBoundingClientRect().width ?? 0,
      notices,
      // Identified by its OWN copy, not by count. Any other notice in the strip
      // (session-history, workspace-store) would otherwise fail "exactly one"
      // and, worse, a run with zero tracker notices and one unrelated one would
      // pass it.
      trackerNotices: notices.filter((t) => /Tickets aren't (loading|refreshing)/.test(t)),
      errors: [...document.querySelectorAll(".error")].map((n) => (n.textContent ?? "").trim()),
    };
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let good = 0;

try {
  console.log("\n(a) outage BEFORE the first load — the silent case");
  await post("/__break?mode=502");
  await page.goto(SHELL);
  await page.waitForSelector(".sidebar", { timeout: 10_000 });
  await waitFor(async () => (await snap(page)).unreachable !== null);
  let s = await snap(page);
  check("the sidebar names the tracker and the failure", /Can't reach Switchyard/.test(s.unreachable ?? ""), s.unreachable ?? "(nothing)");
  // The regression this file exists for.
  check("it does NOT claim nothing matched", s.empty === null, s.empty ?? "absent");
  check("the error is quoted", /502/.test(s.why ?? ""), s.why ?? "(nothing)");
  check("a retry is offered", s.retry);
  check("the live dot is down", s.dotDown);
  check("the dot survives the wider header", s.dotWidth >= 5, `${s.dotWidth}px`);
  check("nothing is marked stale (there's nothing to be stale)", !s.stale);
  check("nothing loaded", s.groups === 0 && s.count === "0", `${s.groups} groups, count=${s.count}`);
  check("one tracker notice", s.trackerNotices.length === 1, JSON.stringify(s.notices));
  check("the notice says tickets aren't LOADING", /aren't loading from Switchyard/.test(s.trackerNotices[0] ?? ""), s.trackerNotices[0] ?? "");
  // "Was it never sent, or sent and rejected" — only one of those is a product
  // bug, and the DOM alone can't tell them apart.
  check("the pull actually reached the proxy", (await state()).blocked > 0, JSON.stringify(await state()));

  // A notice is a condition, not an event (DRY-58): the poll re-raises it every
  // 20s, so re-reporting must not stack.
  for (let i = 0; i < 2; i++) {
    await page.click(".sidebar .refresh");
    await waitFor(async () => !(await page.locator(".sidebar .refresh").isDisabled()));
  }
  s = await snap(page);
  check("still one tracker notice after two more failures", s.trackerNotices.length === 1, JSON.stringify(s.notices));

  console.log("\n(b) the outage ends — no reload");
  await post("/__heal");
  // Prefer the retry the outage block offers; fall back to the header button so
  // a tree WITHOUT the fix keeps running and reports every failure rather than
  // throwing on a missing selector at check four (the discrimination run in
  // README.md is the whole reason this file is trustworthy).
  await page.click(s.retry ? ".sidebar .retry" : ".sidebar .refresh");
  await waitFor(async () => (await snap(page)).groups > 0);
  s = await snap(page);
  check("tickets render", s.groups > 0 && s.count !== "0", `${s.groups} groups, count=${s.count}`);
  check("the outage block is gone", s.unreachable === null);
  check("the notice cleared itself", s.trackerNotices.length === 0, JSON.stringify(s.notices));
  check("the dot is live again", !s.dotDown);
  good = s.groups;

  console.log("\n(c) outage AFTER a good load — real data, no longer current");
  await post("/__break?mode=502");
  await page.click(".sidebar .refresh");
  await waitFor(async () => (await snap(page)).stale);
  s = await snap(page);
  check("the last-good list is retained", s.groups === good && good > 0, `${s.groups} vs ${good} groups`);
  // Drawing the outage block here would throw away a working list to say so.
  check("no outage block over real rows", s.unreachable === null, s.unreachable ?? "absent");
  check("the list is marked stale", s.stale);
  check("the marker explains itself", /out of date/.test(s.staleTitle ?? ""), s.staleTitle ?? "");
  check("the stale chip has real width", s.staleWidth > 20, `${s.staleWidth}px`);
  check("the dot is down", s.dotDown);
  check("one tracker notice", s.trackerNotices.length === 1, JSON.stringify(s.notices));
  check("the notice says tickets aren't REFRESHING", /aren't refreshing from Switchyard/.test(s.trackerNotices[0] ?? ""), s.trackerNotices[0] ?? "");
  // A tracker outage is not a daemon outage; the red banner belongs to the
  // session poll and must stay out of this.
  check("no red banner", s.errors.length === 0, JSON.stringify(s.errors));

  console.log("\n(d) and that one ends too");
  await post("/__heal");
  await page.click(".sidebar .refresh");
  await waitFor(async () => !(await snap(page)).stale);
  s = await snap(page);
  check("the stale marker is gone", !s.stale);
  check("the notice cleared itself", s.trackerNotices.length === 0, JSON.stringify(s.notices));
  check("the list survived both outages", s.groups === good, `${s.groups} vs ${good}`);

  console.log("\n(e) a 502 carrying the tracker's whole response body");
  // Both providers build their error as `${res.status} ${await res.text()}`, so
  // a Jira behind a proxy that 502s with an HTML page puts the page in the
  // message. Uncapped, the 266px rail renders kilobytes of markup.
  await post("/__break?mode=huge");
  await page.click(".sidebar .refresh");
  await waitFor(async () => (await snap(page)).stale);
  s = await snap(page);
  // `s.stale` is part of the assertion, not context: without it a tree that
  // renders no marker at all has a null title, and "shorter than 500" passes
  // vacuously against the very baseline this run exists to fail.
  check(
    "the rail reports it, capped",
    s.stale && (s.staleTitle ?? "").length < 500,
    s.stale ? `${(s.staleTitle ?? "").length} chars` : "no marker at all",
  );
  await post("/__heal");
  await page.click(".sidebar .refresh");
  await waitFor(async () => !(await snap(page)).stale);

  console.log("\n(f) a tracker that accepts and goes silent");
  // The mode a 502-only proxy cannot see. Nothing rejects, so the catch that
  // powers (a) and (c) never runs on its own — only the pull's own budget ends
  // it. Without one this hangs forever: the sidebar keeps saying "No tickets
  // match." with its spinner latched, since `finally` never runs either.
  await page.reload();
  await page.waitForSelector(".sidebar", { timeout: 10_000 });
  await waitFor(async () => (await snap(page)).groups > 0);
  await post("/__break?mode=hang");
  await page.click(".sidebar .refresh");
  const held = await waitFor(async () => (await state()).held > 0, 10_000);
  check("the request is parked, not answered", held !== null, held === null ? "never arrived" : `after ${held}s`);
  // Budget is 15s (LIST_TIMEOUT_MS, raised from 12s in DRY-61 to sit clear of
  // the daemon's own pull deadline); allow a margin, and fail loudly rather
  // than hanging the whole run if it never fires. The daemon's deadline can't
  // rescue this case — the proxy holds the BROWSER's request, so the daemon
  // never sees one to give up on.
  const gaveUp = await waitFor(async () => (await snap(page)).stale, 40_000);
  check("the pull gives up and reports", gaveUp !== null, gaveUp === null ? "still hanging after 40s" : `after ${gaveUp}s`);
  s = await snap(page);
  check("the last-good list is still there", s.groups === good, `${s.groups} vs ${good}`);
  check("one tracker notice", s.trackerNotices.length === 1, JSON.stringify(s.notices));
  check("the spinner is not latched", !(await page.locator(".sidebar .refresh").isDisabled()));

  await post("/__heal");
  await page.click(".sidebar .refresh");
  const recovered = await waitFor(async () => !(await snap(page)).stale);
  check("and it recovers from a hang", recovered !== null, recovered === null ? "still stale" : `after ${recovered}s`);

  console.log("\n(g) a shell newer than its daemon — we don't know the tracker's name");
  // /api/tracker/info 404s, so `providerName` never leaves its optimistic
  // default. Naming a LABEL wrongly is cosmetic; naming it inside an error is a
  // claim about which system is down, and on a Jira host it points whoever
  // reads it at a tracker that was never configured.
  await post("/__break?mode=skew");
  await page.reload();
  await page.waitForSelector(".sidebar", { timeout: 10_000 });
  await waitFor(async () => (await snap(page)).unreachable !== null);
  s = await snap(page);
  check("the outage doesn't guess a name", /Can't reach the tracker/.test(s.unreachable ?? ""), s.unreachable ?? "(nothing)");
  check("and specifically doesn't say Switchyard", !/Switchyard/.test(s.unreachable ?? ""), s.unreachable ?? "");
  check("the notice doesn't either", !/Switchyard/.test(s.trackerNotices[0] ?? ""), s.trackerNotices[0] ?? "");
} finally {
  await browser.close();
  await post("/__heal").catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
