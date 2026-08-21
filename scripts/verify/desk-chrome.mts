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
async function open(browser: Browser): Promise<{ page: Page; spawns: Spawn[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const spawns: Spawn[] = [];
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
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
  switcherMid: number;
  switcherLeft: number;
  switcherRight: number;
  controlsLeft: number;
  brandRight: number;
}
function bars(page: Page): Promise<Bars> {
  // Every rect is read inline. A `const box = (sel) => …` helper here compiles
  // to esbuild's `__name(…)` wrapper, which does not exist in the page — DRY-80's
  // rule, and it fails as a ReferenceError on a line that reads perfectly well.
  return page.evaluate(() => {
    const h = (document.querySelector(".topbar") as HTMLElement).getBoundingClientRect();
    const sw = (document.querySelector(".switcher") as HTMLElement).getBoundingClientRect();
    const c = (document.querySelector(".controls") as HTMLElement).getBoundingClientRect();
    const b = (document.querySelector(".brand") as HTMLElement).getBoundingClientRect();
    return {
      headerMid: h.left + h.width / 2,
      switcherMid: sw.left + sw.width / 2,
      switcherLeft: sw.left,
      switcherRight: sw.right,
      controlsLeft: c.left,
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

  // The pinned rows are searchable, which is what replaces the chord.
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
  const { page, close } = await open(browser);
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
  await page.addStyleTag({ content: ".controls { padding-left: 220px; }" });
  await sleep(150);
  const after = await bars(page);
  check(
    "and stays put when the right-hand cluster grows",
    Math.abs(after.switcherMid - at.switcherMid) <= 1,
    `moved ${Math.round(after.switcherMid - at.switcherMid)}px`,
  );
  check(
    "with nothing painted over anything",
    after.switcherRight <= after.controlsLeft && after.switcherLeft >= after.brandRight,
    `switcher ${Math.round(after.switcherLeft)}-${Math.round(after.switcherRight)}, ` +
      `brand ends ${Math.round(after.brandRight)}, controls start ${Math.round(after.controlsLeft)}`,
  );

  // A laptop, where the sides genuinely need the room — the width the ticket
  // asked for this to be checked at.
  await page.setViewportSize({ width: 1280, height: 800 });
  await sleep(200);
  const narrow = await bars(page);
  check(
    "still centred at a laptop width",
    Math.abs(narrow.switcherMid - narrow.headerMid) <= 1,
    `switcher ${Math.round(narrow.switcherMid)} vs header ${Math.round(narrow.headerMid)}`,
  );
  check(
    "and still not overlapping the controls there",
    narrow.switcherRight <= narrow.controlsLeft,
    `switcher ends ${Math.round(narrow.switcherRight)}, controls start ${Math.round(narrow.controlsLeft)}`,
  );
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
    "no pill, and no keystroke, cost the tracker a request",
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
  const s = await snap(page);
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

await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
