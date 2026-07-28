// DRY-55: a tracker outage has to name itself.
//
// Why a browser and not curl: curl against /api/tracker/tickets shows a 502 and
// a clear error body, which is exactly the state in which this bug shipped. The
// claim is about what the SIDEBAR says — and what it said was "No tickets
// match.", a sentence that is also true of a perfectly healthy tracker with
// nothing in scope. Only a rendered page can tell those apart.
//
// The two halves are different code paths through the same catch and only one
// of them was ever silent, so they're asserted separately: an outage that
// starts BEFORE the first load (no last-good list — the sidebar is empty and
// must say why) and one that starts AFTER a good load (the list is retained and
// must not pass for current).
//
// Setup + overrides: see README.md.
import { chromium } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5375";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:4375";

let failures = 0;
function check(name, ok, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const post = (p) => fetch(`${PROXY}${p}`, { method: "POST" }).then((r) => r.json());

function snap(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      // Repo groups render COLLAPSED, so `.row` counts nothing until one is
      // expanded — a `.row`-based check reads zero against a full sidebar and
      // passes every assertion about an empty one for the wrong reason.
      groups: document.querySelectorAll(".sidebar .grp").length,
      count: q(".sidebar .count")?.textContent?.trim() ?? null,
      unreachable: q(".sidebar .unreachable-head")?.textContent?.trim() ?? null,
      why: q(".sidebar .unreachable-why")?.textContent?.trim() ?? null,
      retry: !!q(".sidebar .retry"),
      empty: q(".sidebar .empty")?.textContent?.trim() ?? null,
      stale: !!q(".sidebar .stale"),
      staleTitle: q(".sidebar .stale")?.getAttribute("title") ?? null,
      dotDown: !!q(".sidebar .live.down"),
      notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent.trim()),
      errors: [...document.querySelectorAll(".error")].map((n) => n.textContent.trim()),
    };
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let good = 0;

try {
  console.log("\n(a) outage BEFORE the first load — the silent case");
  await post("/__break");
  await page.goto(SHELL);
  await page.waitForSelector(".sidebar", { timeout: 10_000 });
  await page.waitForTimeout(1500);
  let s = await snap(page);
  check("the sidebar names the tracker and the failure", /Can't reach Switchyard/.test(s.unreachable ?? ""), s.unreachable ?? "(nothing)");
  // The regression this file exists for.
  check("it does NOT claim nothing matched", s.empty === null, s.empty ?? "absent");
  check("the error is quoted", /502/.test(s.why ?? ""), s.why ?? "(nothing)");
  check("a retry is offered", s.retry);
  check("the live dot is down", s.dotDown);
  check("nothing is marked stale (there's nothing to be stale)", !s.stale);
  check("nothing loaded", s.groups === 0 && s.count === "0", `${s.groups} groups, count=${s.count}`);
  check("one notice", s.notices.length === 1, JSON.stringify(s.notices));
  check("the notice says tickets aren't LOADING", /aren't loading from Switchyard/.test(s.notices[0] ?? ""), s.notices[0] ?? "");

  // A notice is a condition, not an event (DRY-58): the poll re-raises it every
  // 20s, so re-reporting must not stack.
  await page.click(".sidebar .refresh");
  await page.waitForTimeout(700);
  await page.click(".sidebar .refresh");
  await page.waitForTimeout(700);
  s = await snap(page);
  check("still one notice after two more failures", s.notices.length === 1, JSON.stringify(s.notices));

  console.log("\n(b) the outage ends — no reload");
  await post("/__heal");
  // Prefer the retry the outage block offers; fall back to the header button so
  // a tree WITHOUT the fix keeps running and reports every failure rather than
  // throwing on a missing selector at check four (the discrimination run in
  // README.md is the whole reason this file is trustworthy).
  await page.click(s.retry ? ".sidebar .retry" : ".sidebar .refresh");
  await page.waitForTimeout(1500);
  s = await snap(page);
  check("tickets render", s.groups > 0 && s.count !== "0", `${s.groups} groups, count=${s.count}`);
  check("the outage block is gone", s.unreachable === null);
  check("the notice cleared itself", s.notices.length === 0, JSON.stringify(s.notices));
  check("the dot is live again", !s.dotDown);
  good = s.groups;

  console.log("\n(c) outage AFTER a good load — real data, no longer current");
  await post("/__break");
  await page.click(".sidebar .refresh");
  await page.waitForTimeout(1500);
  s = await snap(page);
  check("the last-good list is retained", s.groups === good && good > 0, `${s.groups} vs ${good} groups`);
  // Drawing the outage block here would throw away a working list to say so.
  check("no outage block over real rows", s.unreachable === null, s.unreachable ?? "absent");
  check("the list is marked stale", s.stale);
  check("the marker explains itself", /out of date/.test(s.staleTitle ?? ""), s.staleTitle ?? "");
  check("the dot is down", s.dotDown);
  check("one notice", s.notices.length === 1, JSON.stringify(s.notices));
  check("the notice says tickets aren't REFRESHING", /aren't refreshing from Switchyard/.test(s.notices[0] ?? ""), s.notices[0] ?? "");
  // A tracker outage is not a daemon outage; the red banner belongs to the
  // session poll and must stay out of this.
  check("no red banner", s.errors.length === 0, JSON.stringify(s.errors));

  console.log("\n(d) and that one ends too");
  await post("/__heal");
  await page.click(".sidebar .refresh");
  await page.waitForTimeout(1500);
  s = await snap(page);
  check("the stale marker is gone", !s.stale);
  check("the notice cleared itself", s.notices.length === 0, JSON.stringify(s.notices));
  check("the list survived both outages", s.groups === good, `${s.groups} vs ${good}`);
} finally {
  await browser.close();
  await post("/__heal").catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
