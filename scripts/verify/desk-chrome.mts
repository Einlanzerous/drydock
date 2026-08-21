// DRY-82: three unrelated nits on the desk's chrome, in two files.
//
//   1. `+ claude` and `+ workspace` are gone from the header. They could not
//      just be deleted — the palette had exactly one pinned row (blank shell)
//      and its own comment said blank claude agents lived on the header — so
//      the capability moved into the palette first.
//   2. the Float/Tile/Focus switcher stopped drifting. It sat between two
//      `flex:1` spacers, which hand each side equal SLACK rather than equal
//      WIDTH, so its position was a function of how wide `.controls` happened
//      to be: it moved when focus changed repo, when a run finished, when the
//      27th run finished, and when you signed in.
//   3. the sidebar's four filter selects became `key=value` pills, and a term
//      the pull cannot contain now reaches `/api/tracker/search` — which has
//      existed since the palette was built and had no caller in the shell.
//
// Why a browser: every claim here is about what the SHELL does. The daemon is
// unchanged by this ticket except for being asked a question it was already
// able to answer, so a curl proves nothing about any of it.
//
// What each section holds down, and why it is not subsumed by the one before:
//
//   (a) the two header buttons are gone AND the palette does what they did.
//       Asserted on the request bodies the shell sends, not on a window
//       appearing: "a workspace" is two POSTs (the agent and its co-located
//       zsh), and a pinned row that spawned only the first would look identical
//       on screen for the second or so this harness would watch.
//   (b) the switcher is centred on the HEADER, not on the space its siblings
//       leave. Two claims, and the second is the ticket: it is centred now, and
//       it STAYS centred when the right-hand cluster changes width.
//   (c) the pills filter, and cost nothing. Measured on UPSTREAM counts,
//       because a view filter that quietly re-pulled would look instant behind
//       the daemon's cache.
//   (d) a pill can be typed free-hand, so it can name something the pull does
//       not contain — an empty sidebar that looks exactly like a healthy
//       tracker with nothing in scope, which is DRY-55's silence. It has to say
//       which it is.
//   (e) a key outside the pull is FOUND, through the search route, in a block
//       of its own — and a term nothing has says so rather than showing an
//       empty list. Plus the debounce, without which this is a tracker query
//       per keystroke (DRY-72).
//   (f) the same path FAILING. Added after review, which observed that (a)-(e)
//       had never once run it — and that both of the bugs found by reading it
//       lived there: a retry that could never visibly succeed, and a hung
//       request wedging every later search for the life of the page.
//
// The rig is the stub tracker's, so nothing here touches a real tracker. Setup:
// see README.md.
//
// Run from `daemon/`, where tsx resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/desk-chrome.mts)
import { chromium, type Browser, type Page } from "playwright";
import type { StubCounts, StubState } from "./stub-tracker.mjs";
import type { Detail } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5382";
const STUB = process.env.STUB_URL ?? "http://127.0.0.1:4383";
/**
 * The throwaway daemon's password. Its only job is to make the desk have an
 * ACCOUNT, so the header renders the name / `Sign out` pair — one of the five
 * things the ticket lists as resizing `.controls`, and the one that turns the
 * overlap on. Overridable, defaulted, and deliberately not secret: this daemon
 * holds a state file in /tmp and a stub tracker.
 */
const PASSWORD = process.env.DESK_PASSWORD ?? "dry82-throwaway";

let failures = 0;
function check(name: string, ok: boolean, extra: Detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stubState = (): Promise<StubState> =>
  fetch(`${STUB}/__state`).then((r) => r.json() as Promise<StubState>);
const stubReset = (): Promise<StubCounts> =>
  fetch(`${STUB}/__reset`, { method: "POST" }).then((r) => r.json() as Promise<StubCounts>);
const stubBreak = (mode: "502" | "hang"): Promise<unknown> =>
  fetch(`${STUB}/__break?mode=${mode}`, { method: "POST" }).then((r) => r.json());
const stubHeal = (): Promise<unknown> =>
  fetch(`${STUB}/__heal`, { method: "POST" }).then((r) => r.json());

/**
 * The shell's own budget on a tracker call (`LIST_TIMEOUT_MS`), plus room for it
 * to land and render.
 *
 * **The rig's `DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS` has to be far longer than
 * this whole round, and that is load-bearing in both directions.** Shorter than
 * the shell's budget (the daemon's default is) and a silent stub reaches the
 * browser as a prompt 502, so the shell's own deadline is never exercised at
 * all. Longer, but still inside the round, and the daemon gives up on its own
 * partway through — which UNWEDGES the shell for free and makes the wedge check
 * below pass against the bug it exists for. Measured both ways: at 30s it did.
 */
const SHELL_BUDGET_MS = 16_000;
/**
 * How long the wedge probe waits for the next search to report.
 *
 * Deliberately short. Under the fix the new search lands in about a second; the
 * only thing a longer window can buy is time for something else to rescue the
 * hung request, which is precisely the false pass being avoided.
 */
const WEDGE_PROBE_MS = 8_000;

/** Poll until `fn` holds — no fixed sleeps, which is what makes these flaky. */
async function waitFor(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(120);
  }
  return false;
}

/** One `POST /api/sessions` the shell made, as the palette asked for it. */
interface Spawn {
  command?: string;
  title?: string;
}

/**
 * A page with spawns INTERCEPTED.
 *
 * The claim in section (a) is what the palette asks the daemon for, and letting
 * those POSTs through would start a real `claude` per check on whatever host
 * this runs on. The route answers them with a session-shaped 201 so the desk's
 * own code path (which reads `.id` and `.cwd` to place a window and co-locate a
 * shell) runs to completion, and records the body.
 */
async function open(
  browser: Browser,
  /**
   * Put a FINISHED session in the list the desk polls, so `Clear finished`
   * renders (`isFinished` is `status === "exited" && !failure`).
   *
   * Only section (b) asks for it, and only because the header's geometry is a
   * function of how wide `.controls` is: signed out with nothing to clear is the
   * NARROWEST that cluster ever gets, and measuring the overlap there is
   * measuring the one posture in which it cannot fail. That is how the first cut
   * of this section passed against an overlap of 25px at 1100 and 95px at 960.
   */
  withSweepable = false,
): Promise<{ page: Page; spawns: Spawn[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const spawns: Spawn[] = [];
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      if (!withSweepable) return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { sessions?: unknown[] };
      body.sessions = [
        ...(body.sessions ?? []),
        {
          id: "finished-fixture",
          command: "claude",
          title: "a finished run",
          cwd: "/tmp",
          repo: "drydock",
          status: "exited",
          exitCode: 0,
          origin: "you",
          startedAt: 1,
          endedAt: 2,
        },
      ];
      return route.fulfill({ response: res, json: body });
    }
    const body = route.request().postDataJSON() as Spawn;
    spawns.push(body);
    const id = `stub-${spawns.length}`;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id,
          command: body.command,
          title: body.title,
          cwd: "/tmp",
          status: "running",
          startedAt: Date.now(),
        },
      }),
    });
  });
  await page.goto(SHELL, { waitUntil: "domcontentloaded" });
  // The rig runs the daemon WITH a password, so the desk is behind the door —
  // which is the point: `.whoami` only renders when there is an account to name,
  // and that pair is the widest thing `.controls` ever carries.
  if (await page.locator(".gate input[type=password]").count()) {
    await page.fill(".gate input[type=password]", PASSWORD);
    await page.click(".gate .go");
  }
  await page.waitForSelector(".sidebar .grp", { timeout: 20_000 });
  return { page, spawns, close: () => ctx.close() };
}

/** The rendered sidebar, read the way the component computes it. */
interface Snapshot {
  /** `filtered/augmented`, or just `filtered` when they agree. */
  count: string | null;
  selects: number;
  pills: string[];
  unknownPills: number;
  suggestions: string[];
  emptyWhy: string | null;
  emptyHead: string | null;
  found: string[];
  foundNote: string | null;
  scopeChips: number;
  backlogOn: boolean;
}
function snap(page: Page): Promise<Snapshot> {
  // Written out rather than through a `txt(el)` helper — see `bars` for why a
  // NAMED function inside an evaluate body cannot survive the trip.
  return page.evaluate(() => {
    return {
      count: document.querySelector(".sidebar .count")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      selects: document.querySelectorAll(".sidebar .controls select").length,
      pills: [...document.querySelectorAll(".sidebar .pill")].map((p) =>
        (p.textContent ?? "").replace(/\s+/g, " ").replace(/✕/g, "").trim(),
      ),
      unknownPills: document.querySelectorAll(".sidebar .pill.unknown").length,
      suggestions: [...document.querySelectorAll(".sidebar .suggest .sug-label")].map(
        (e) => e.textContent?.trim() ?? "",
      ),
      emptyWhy:
        document.querySelector(".sidebar .empty-why")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      emptyHead:
        document.querySelector(".sidebar .empty p")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      found: [...document.querySelectorAll(".sidebar .found-row .key")].map(
        (e) => e.textContent?.trim() ?? "",
      ),
      foundNote:
        document.querySelector(".sidebar .found-note")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      scopeChips: document.querySelectorAll(".sidebar .scope .chip").length,
      backlogOn: !!document.querySelector(".sidebar .backlog input:checked"),
    };
  });
}

/** Where the switcher sits, against where the header's middle is. */
interface Bars {
  headerMid: number;
  headerRight: number;
  switcherMid: number;
  switcherLeft: number;
  switcherRight: number;
  controlsLeft: number;
  controlsRight: number;
  brandRight: number;
}
function bars(page: Page): Promise<Bars> {
  // Every rect is read inline. A `const box = (sel) => …` helper here compiles
  // to esbuild's `__name(…)` wrapper, which does not exist in the page — DRY-80's
  // rule, and it fails as a ReferenceError on a line that reads perfectly well.
  return page.evaluate(() => {
    const hEl = document.querySelector(".topbar") as HTMLElement;
    const h = hEl.getBoundingClientRect();
    const sw = (document.querySelector(".switcher") as HTMLElement).getBoundingClientRect();
    const c = (document.querySelector(".controls") as HTMLElement).getBoundingClientRect();
    const b = (document.querySelector(".brand") as HTMLElement).getBoundingClientRect();
    return {
      headerMid: h.left + h.width / 2,
      // The header's PAINTABLE right edge — its own padding, which `Sign out`
      // spilled past.
      headerRight: h.right - parseFloat(getComputedStyle(hEl).paddingRight || "0"),
      switcherMid: sw.left + sw.width / 2,
      switcherLeft: sw.left,
      switcherRight: sw.right,
      controlsLeft: c.left,
      controlsRight: c.right,
      brandRight: b.right,
    };
  });
}

/**
 * Open the palette if it isn't already, and say whether it is there.
 *
 * Every palette gesture below goes through this. Spawning closes the palette,
 * and so did the OLD `⇧↵` — so a run against the unpatched tree would otherwise
 * die on the next `fill` instead of reporting the rest of its checks, which is
 * the run this harness has to be legible in.
 */
async function ensurePalette(page: Page): Promise<boolean> {
  if (await page.locator(".palette").count()) return true;
  await page.click("button.new");
  return !!(await waitFor(async () => (await page.locator(".palette").count()) > 0, 3000));
}

/** Click, or report that there was nothing to click. Never throws. */
async function tryClick(page: Page, sel: string): Promise<boolean> {
  try {
    await page.click(sel, { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

const type = async (page: Page, text: string): Promise<void> => {
  await page.fill(".sidebar .searchbox input", "");
  await page.fill(".sidebar .searchbox input", text);
};

const browser = await chromium.launch();

// ---- (a) the header buttons moved into the palette -------------------------
console.log("(a) the two spawn buttons are gone, and the palette does their job");
{
  const { page, spawns, close } = await open(browser);
  const ghosts = await page.evaluate(() =>
    [...document.querySelectorAll(".topbar .controls button")].map((b) =>
      (b.textContent ?? "").replace(/\s+/g, " ").trim(),
    ),
  );
  check("no “+ claude” button on the header", !ghosts.some((t) => t.includes("+ claude")), ghosts.join(" | "));
  check("no “+ workspace” button either", !ghosts.some((t) => t.includes("+ workspace")));
  check("“New session” is still there", ghosts.some((t) => t.startsWith("New session")));

  check("the palette opens", await ensurePalette(page));
  const pinned = await page.evaluate(() =>
    [...document.querySelectorAll(".palette .row.pinrow .key")].map((e) => e.textContent?.trim() ?? ""),
  );
  check(
    "the palette pins all three: shell, claude, workspace",
    pinned.join(",") === "shell,claude,workspace",
    pinned.join(",") || "none",
  );

  // Opens on the first TICKET, not on a pinned row: "Ctrl+K, ↵ on a ticket" is
  // the flow that must not change, and it was hard-coded to "one pinned row".
  const openSel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".palette .row")];
    return rows.findIndex((r) => r.classList.contains("active"));
  });
  check("it still opens on the first ticket, not on a pinned row", openSel === 3, `active row ${openSel}`);

  // The old chord. Repurposing it onto the selection would turn a reflex for
  // "give me a shell" into "spawn an agent on whatever ticket is selected".
  await page.keyboard.press("Shift+Enter");
  await sleep(400);
  check("⇧↵ no longer spawns anything", spawns.length === 0, JSON.stringify(spawns));

  // The pinned rows are searchable at all, which is what replaces the chord.
  await ensurePalette(page);
  await page.fill(".palette .search input", "workspace");
  await sleep(200);
  const filtered = await page.evaluate(() => ({
    pinned: [...document.querySelectorAll(".palette .row.pinrow .key")].map((e) => e.textContent?.trim()),
    empty: !!document.querySelector(".palette .empty"),
  }));
  check(
    "typing “workspace” leaves that row alone on screen",
    filtered.pinned.length === 1 && filtered.pinned[0] === "workspace",
    filtered.pinned.join(",") || "none",
  );
  check("and does not claim nothing matches", !filtered.empty);

  // The keyboard gesture, which is the one the chord was removed in favour of
  // and the one three documents now assert works. It has to be checked with a
  // TICKET matching the same query, because the selection rule reads both — and
  // `de` is the only string this fixture has that does: it is inside "claude"
  // and inside DRY-5's "…when hidden". Nothing in the plain stub set collides
  // with `shell`, `claude`, `workspace` or `wo`, which is exactly why a check
  // written with the obvious query passed against the bug.
  await ensurePalette(page);
  await page.fill(".palette .search input", "de");
  await sleep(250);
  const aimed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".palette .row")];
    const active = rows.findIndex((r) => r.classList.contains("active"));
    return {
      activeIsPinned: active >= 0 && rows[active].classList.contains("pinrow"),
      pinned: rows.filter((r) => r.classList.contains("pinrow")).length,
      tickets: rows.filter((r) => !r.classList.contains("pinrow")).length,
    };
  });
  check(
    "a query aimed at a pinned row highlights it, with a ticket matching too",
    aimed.activeIsPinned && aimed.pinned === 1 && aimed.tickets > 0,
    JSON.stringify(aimed),
  );
  spawns.length = 0;
  await page.keyboard.press("Enter");
  await waitFor(async () => spawns.length >= 1, 5000);
  check(
    // Under the bug this is silent rather than wrong-looking: ↵ opens a ticket
    // panel, so no spawn is issued at all and the palette closes as if it had
    // worked.
    "and ↵ spawns it rather than opening a ticket",
    spawns.length === 1 && spawns[0].command === "claude" && spawns[0].title === "claude-code",
    JSON.stringify(spawns),
  );

  // The other direction, which nothing covered: a ticket-shaped query must still
  // reach a ticket. The selection rule reads the pinned set, so a term that
  // narrows it takes `↵` away from the list — which is what a GENERIC word in
  // `terms` did. `poll` is in two loaded titles and in nothing pinned.
  await ensurePalette(page);
  await page.fill(".palette .search input", "poll");
  await sleep(250);
  const ticketward = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".palette .row")];
    const active = rows.findIndex((r) => r.classList.contains("active"));
    return {
      activeIsPinned: active >= 0 && rows[active].classList.contains("pinrow"),
      pinned: rows.filter((r) => r.classList.contains("pinrow")).length,
      tickets: rows.filter((r) => !r.classList.contains("pinrow")).length,
    };
  });
  check(
    "a ticket-shaped query still selects a ticket",
    !ticketward.activeIsPinned && ticketward.pinned === 0 && ticketward.tickets > 0,
    JSON.stringify(ticketward),
  );
  spawns.length = 0;
  await page.keyboard.press("Enter");
  await sleep(700);
  check("and ↵ opens it rather than spawning", spawns.length === 0, JSON.stringify(spawns));

  // The decision that keeps the rule above honest, asserted rather than left in
  // a comment: a pinned row's `terms` may only NAME the thing. `agent` was on
  // two of three in a repo where every ticket is about agents, so `Ctrl K`,
  // `agent`, `↵` spawned a bare claude instead of opening the ticket somebody
  // was looking for. Re-adding any of these fails here.
  const GENERIC = ["agent", "drawer", "split", "terminal"];
  const claimed: string[] = [];
  for (const word of GENERIC) {
    await ensurePalette(page);
    await page.fill(".palette .search input", word);
    await sleep(150);
    if (await page.locator(".palette .row.pinrow").count()) claimed.push(word);
  }
  check(
    "a generic word claims no pinned row",
    claimed.length === 0,
    claimed.length ? `claimed by: ${claimed.join(", ")}` : "",
  );

  spawns.length = 0;
  await ensurePalette(page);
  await page.fill(".palette .search input", "workspace");
  await tryClick(page, ".palette .row.pinrow");
  // WAITED for, not read straight after the click: a workspace is two POSTs and
  // the second is issued from the first one's `.then`, so reading immediately
  // catches the agent alone — which is exactly what a half-built pinned row
  // would look like, and would pass a `>= 1` check forever.
  await waitFor(async () => spawns.length >= 2, 5000);
  check(
    "the workspace row spawns the agent AND its co-located shell",
    spawns.length === 2 &&
      spawns[0].command === "claude" &&
      spawns[0].title === "workspace" &&
      spawns[1].command === "shell",
    JSON.stringify(spawns),
  );

  spawns.length = 0;
  await ensurePalette(page);
  await page.fill(".palette .search input", "claude");
  await tryClick(page, ".palette .row.pinrow");
  await waitFor(async () => spawns.length >= 1, 5000);
  await sleep(500); // long enough for a second POST to have shown up if there were one
  check(
    "the claude row spawns one bare claude",
    spawns.length === 1 && spawns[0].command === "claude" && spawns[0].title === "claude-code",
    JSON.stringify(spawns),
  );

  spawns.length = 0;
  await ensurePalette(page);
  await page.fill(".palette .search input", "shell");
  await tryClick(page, ".palette .row.pinrow");
  await waitFor(async () => spawns.length >= 1, 5000);
  await sleep(500);
  check(
    "and the shell row still spawns a shell",
    spawns.length === 1 && spawns[0].command === "shell",
    JSON.stringify(spawns),
  );
  await close();
}

// ---- (b) the switcher is centred on the window, not on the slack ------------
console.log("\n(b) the layout switcher does not drift");
{
  // The FULLEST `.controls` this desk ever has: the account pair, `Clear
  // finished` with its badge, the folder chip and `New session`. Measuring the
  // signed-out desk with nothing to clear measures the narrowest, which is the
  // one posture where an overlap is impossible.
  const { page, close } = await open(browser, true);
  const loaded = await waitFor(async () =>
    (await page.locator(".topbar .whoami").count()) > 0 &&
    (await page.locator(".topbar .sweep").count()) > 0,
  );
  check(
    "the header is carrying its widest cluster for these measurements",
    loaded,
    loaded ? "" : "no .whoami and/or no .sweep — every width below proves the easy case",
  );
  const at = await bars(page);
  check(
    "the switcher is centred on the header",
    Math.abs(at.switcherMid - at.headerMid) <= 1,
    `switcher ${Math.round(at.switcherMid)} vs header ${Math.round(at.headerMid)}`,
  );

  // The drift itself. Five real things resize `.controls` — the folder chip
  // following focus, `Clear finished` appearing, its 1-2 digit badge, and the
  // account/Sign out pair — and all five are the same event to the layout:
  // the right-hand cluster got wider. Driven here by padding rather than by
  // arranging one of the five, because what is under test is whether the
  // switcher's position READS that width at all.
  const widened = await page.addStyleTag({ content: ".controls { padding-left: 220px; }" });
  await sleep(150);
  const after = await bars(page);
  check(
    "and stays put when the right-hand cluster grows",
    Math.abs(after.switcherMid - at.switcherMid) <= 1,
    `moved ${Math.round(after.switcherMid - at.switcherMid)}px`,
  );
  // REMOVED before anything else is measured. Left in place it is 220px of
  // padding no real desk has, and every width below would then be measuring a
  // cluster this header never carries — which is the opposite of the mistake
  // this section was just fixed for, and just as wrong.
  await widened.evaluate((el) => (el as HTMLElement).remove());
  await sleep(150);

  // Every width the ticket asked about, and two below it. `grid` was chosen over
  // `left:50%` precisely BECAUSE it keeps the switcher in flow and so cannot be
  // painted over — a claim that was false at 1100 and 1240 until the folder chip
  // learned to step aside, and that only two widths and a signed-out desk let
  // through.
  // `PACK_W` in App.vue: at and below it the header packs rather than centring,
  // because equal tracks would hand the brand room it never needs while the
  // controls overflow across the switcher. Centring is asserted only where it is
  // CLAIMED; not overlapping is asserted everywhere, which is the property the
  // ticket gave as the reason to prefer grid in the first place.
  const PACK_W = 1300;
  for (const width of [1360, 1300, 1240, 1100, 960]) {
    await page.setViewportSize({ width, height: 800 });
    await sleep(250);
    const m = await bars(page);
    if (width > PACK_W) {
      check(
        `still centred at ${width}`,
        Math.abs(m.switcherMid - m.headerMid) <= 1,
        `switcher ${Math.round(m.switcherMid)} vs header ${Math.round(m.headerMid)}`,
      );
    } else {
      check(
        // The packed layout keeps the fix rather than trading it away: the
        // switcher sits after the brand, whose width never changes, so its
        // position still can't be moved by anything on the right.
        `packed at ${width}, and still not a function of the controls`,
        Math.abs(m.switcherLeft - m.brandRight - 16) <= 2,
        `switcher starts ${Math.round(m.switcherLeft)}, brand ends ${Math.round(m.brandRight)}`,
      );
    }
    check(
      `and nothing overlaps the switcher at ${width}`,
      m.switcherRight <= m.controlsLeft,
      `switcher ends ${Math.round(m.switcherRight)}, controls start ${Math.round(m.controlsLeft)} ` +
        `(overlap ${Math.round(m.switcherRight - m.controlsLeft)}px)`,
    );
    check(
      // `Sign out` spilled ~24px past the header's own padding at the narrow
      // widths, which no left-edge test can see.
      `and the controls stay inside the header at ${width}`,
      m.controlsRight <= m.headerRight + 1,
      `controls end ${Math.round(m.controlsRight)}, header ends ${Math.round(m.headerRight)}`,
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await close();
}

// ---- (c) the pills filter, and cost nothing --------------------------------
console.log("\n(c) key=value pills replace the four selects");
{
  const { page, close } = await open(browser);
  let s = await snap(page);
  check("the four filter selects are gone", s.selects === 0, `${s.selects} still there`);
  const allCount = s.count;

  await stubReset();
  await type(page, "Deadline");
  await sleep(250);
  s = await snap(page);
  check("bare text still filters the loaded list", s.count !== allCount, `count=${s.count}`);

  // Completions come from the LOADED set, which is the cheap half of the answer
  // to "no tickets, or no tickets here?".
  await type(page, "stat");
  await sleep(250);
  s = await snap(page);
  check(
    "typing a key offers to make it a pill",
    s.suggestions.includes("status="),
    s.suggestions.join(", ") || "nothing offered",
  );
  await type(page, "status=blo");
  await sleep(250);
  s = await snap(page);
  check(
    "and typing a value offers the ones the pull actually has",
    s.suggestions.includes("status=Blocked"),
    s.suggestions.join(", ") || "nothing offered",
  );

  await page.keyboard.press("Enter");
  await sleep(250);
  s = await snap(page);
  check("↵ turns it into a pill", s.pills.join("|") === "statusBlocked", s.pills.join("|") || "none");
  check("which is not marked as unknown", s.unknownPills === 0);
  check("and it filters to that status", s.count === "1/4", `count=${s.count}`);

  // The seam this redesign had to keep. A pill is instant and local; the chips
  // one row down are a tracker round trip (5.7-6s against a corporate Jira,
  // DRY-72). Measured upstream, since the daemon's cache would hide a re-pull.
  const spent = await stubState();
  check(
    // Named for what it measures. `search` is excluded and has to be — the terms
    // typed above are ≥ MIN_SEARCH and DO reach `/api/tracker/search` — so
    // calling this "cost the tracker a request" claimed something this ticket
    // made false. The seam is narrower than it was: a pill is instant and local,
    // a keystroke in that box is a cheap debounced lookup, and a scope change is
    // the 5.7-6s pull. Only the last one is what must not fire here.
    "no pill, and no keystroke, re-pulled the list",
    spent.list === 0 && spent.children === 0 && spent.epicList === 0,
    `list=${spent.list} children=${spent.children} epicList=${spent.epicList}`,
  );
  check("the scope chips are still chips", s.scopeChips >= 1, `${s.scopeChips} chips`);
  check("and the backlog switch is untouched", s.backlogOn === false);

  // ⌫ on an empty box is the only way to reach a pill without the mouse. The
  // count BEFORE is part of the assertion: "no pills afterwards" is satisfied by
  // a bar that never had one, which is how this reads against the unpatched
  // tree.
  const hadPill = s.pills.length;
  await page.fill(".sidebar .searchbox input", "");
  await page.click(".sidebar .searchbox input");
  await page.keyboard.press("Backspace");
  await sleep(200);
  s = await snap(page);
  check(
    "⌫ on an empty box takes the last pill back",
    hadPill === 1 && s.pills.length === 0,
    `${hadPill} before, ${s.pills.length} after`,
  );
  await close();
}

// ---- (d) a pill that names something the pull can't hold -------------------
console.log("\n(d) a filter can only match what was pulled, and says so");
{
  const { page, close } = await open(browser);
  await type(page, "assignee=Ashley Dodson");
  await page.keyboard.press("Enter");
  await sleep(400);
  let s = await snap(page);
  check(
    "free text still becomes a pill",
    s.pills.join("|") === "assigneeAshley Dodson",
    s.pills.join("|") || "none",
  );
  check("marked as one nothing loaded has", s.unknownPills === 1, `${s.unknownPills} marked`);
  check(
    "and the empty sidebar says which it is",
    !!s.emptyWhy && s.emptyWhy.includes("assignee=Ashley Dodson"),
    s.emptyWhy ?? "no explanation at all",
  );

  // The other direction, and the one that is a lie rather than a silence: a
  // KNOWN pill emptying the list while the tracker has the term perfectly well.
  // The line was gated on `elsewhere`, which is deliberately what the pull does
  // NOT already hold — so a match the pull DOES hold drops out of it and the
  // sidebar states the tracker has nothing, about a loaded, open ticket one
  // pill away from the screen.
  await tryClick(page, ".sidebar .searchbox .clear");
  await type(page, "status=Blocked");
  await page.keyboard.press("Enter");
  await type(page, "Coalesce");
  await waitFor(async () => {
    const t = await snap(page);
    return t.emptyHead !== null && t.foundNote === null;
  });
  s = await snap(page);
  check(
    // The empty block has to BE rendering, or "no explanation" is satisfied by
    // there being nothing to explain.
    "a pill hiding a loaded match empties the list",
    s.emptyHead !== null && s.pills.length === 1,
    `head=${s.emptyHead ?? "none"} pills=${s.pills.join("|") || "none"}`,
  );
  check(
    "and the sidebar does NOT claim the tracker has nothing for it",
    s.emptyWhy === null,
    s.emptyWhy ?? "",
  );
  await close();
}

// ---- (e) what the pull cannot contain, found anyway ------------------------
console.log("\n(e) a key outside the pull reaches /api/tracker/search");
{
  const { page, close } = await open(browser);
  await stubReset();

  // DRY-3 is closed, so the sidebar's `open=true` pull cannot contain it. Before
  // this ticket the sidebar's search was a filter over `props.tickets` and this
  // was indistinguishable from the ticket not existing.
  await type(page, "DRY-3");
  const showed = await waitFor(async () => (await snap(page)).found.includes("DRY-3"));
  let s = await snap(page);
  check("a closed ticket is found", showed, `found: ${s.found.join(",") || "nothing"}`);
  const inGroups = await page.locator(".sidebar .row .key", { hasText: "DRY-3" }).count();
  check(
    "in a block of its own, not merged into the repo groups",
    showed && inGroups === 0,
    showed ? `${inGroups} in the groups` : "nothing was found at all, so this proves nothing",
  );
  check(
    "and the empty line stops claiming nothing matches",
    s.emptyHead === "Nothing in this pull matches.",
    s.emptyHead ?? "no empty line",
  );
  const searched = await stubState();
  check("the search route was actually used", searched.search >= 1, `search=${searched.search}`);

  // A miss that is legitimate: the route is project-scoped, so "not here" is a
  // real answer and has to read as one rather than as an empty list.
  await stubReset();
  await type(page, "ZZQQ");
  await waitFor(async () => {
    const t = await snap(page);
    return t.emptyWhy !== null && t.foundNote === null;
  });
  s = await snap(page);
  check(
    "a term the tracker has nothing for says so",
    !!s.emptyWhy && s.emptyWhy.includes("ZZQQ"),
    s.emptyWhy ?? "no explanation at all",
  );

  // A request per keystroke against a 6s tracker is the pathology DRY-72
  // removed. Seven characters, typed like a person types.
  await stubReset();
  await page.fill(".sidebar .searchbox input", "");
  await page.click(".sidebar .searchbox input");
  await page.keyboard.type("Deadlin", { delay: 30 });
  await sleep(1500);
  const typed = await stubState();
  check(
    // `>= 1` as well as `<= 2`: zero queries is what a shell that never searches
    // scores, and it is the state this whole section exists to remove.
    "typing seven characters is not seven queries",
    typed.search >= 1 && typed.search <= 2,
    `search=${typed.search} for 7 keystrokes`,
  );
  await close();
}

// ---- (f) the failure side of the new request path -------------------------
//
// Added after review, which noted that a 35-check run had exercised none of it
// — and that both Important findings lived here. A search that can only be
// tested when it succeeds is a search whose recovery has never been run.
console.log("\n(f) a search that fails, and a search that hangs");
{
  const { page, close } = await open(browser);

  // (f1) A retry that succeeds has to LOOK like it succeeded. The state is
  // replaced wholesale per outcome rather than patched, because patching `rows`
  // and `done` on success while leaving `error` standing renders "couldn't
  // search — retry" forever over rows that were fetched perfectly well.
  await stubBreak("502");
  await type(page, "DRY-3");
  const failed = await waitFor(async () => {
    const t = await snap(page);
    return !!t.foundNote && t.foundNote.includes("couldn't search");
  });
  check("a failing search says so", failed, (await snap(page)).foundNote ?? "no note at all");

  await stubHeal();
  await tryClick(page, ".sidebar .found-note.bad");
  const recovered = await waitFor(async () => (await snap(page)).found.includes("DRY-3"));
  const s1 = await snap(page);
  check("clicking retry shows the rows it fetched", recovered, `found: ${s1.found.join(",") || "nothing"}`);
  check(
    "and the error note is gone with it",
    s1.foundNote === null,
    s1.foundNote ?? "",
  );

  // (f2) A hung request must not wedge the path. Searches queue behind one
  // handle, so a promise that never settles leaves it latched and NO search ever
  // runs again for the life of the page — the list recovers on its own budget,
  // this had none.
  await stubBreak("hang");
  await type(page, "Coalesce");
  const gaveUp = await waitFor(async () => {
    const t = await snap(page);
    return !!t.foundNote && t.foundNote.includes("couldn't search");
  }, SHELL_BUDGET_MS);
  check("a hung search gives up rather than spinning forever", gaveUp, (await snap(page)).foundNote ?? "still searching");

  // The held request is deliberately NOT released before the next search. Healing
  // first lets the hung promise settle and unlatches the handle on its own — so
  // the wedge check passes against the very bug it exists for, which is what a
  // first cut of this round measured. Switching to 502 leaves the old request
  // held and makes a NEW one fail fast, so "the note changed" can only mean a
  // request went out.
  await stubBreak("502");
  await type(page, "Coalesce concurrent");
  const alive = await waitFor(async () => {
    const t = await snap(page);
    return !!t.foundNote && t.foundNote.includes("couldn't search");
  }, WEDGE_PROBE_MS);
  const s2 = await snap(page);
  check(
    "and the next search still runs — the path is not wedged",
    alive,
    `note: ${s2.foundNote ?? "none"}`,
  );

  await stubHeal();
  await type(page, "Deadline");
  const back = await waitFor(async () => (await snap(page)).found.includes("DRY-3"));
  const s3 = await snap(page);
  check(
    "and it finds things again once the tracker is back",
    back,
    `found: ${s3.found.join(",") || "nothing"}, note: ${s3.foundNote ?? "none"}`,
  );
  await close();
}

await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
