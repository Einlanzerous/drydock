// The ticket panel shows the comment thread (DRY-76).
//
// Why a browser and not curl: `ticket-thread.mts` already proves the daemon
// hands the thread over from both providers, and that is exactly the state this
// ticket describes as the bug — the data was reachable, the agent's brief had
// been reading it since DRY-53, and the human deciding whether to spawn the
// agent was looking at a description the thread had already overtaken. The
// claim here is about what the PANEL says, and only a rendered page can tell
// "3 comments" from "showing 3 of 11", or a comment's own `## heading` from the
// panel's.
//
// Round 1 is the whole path with nothing faked: real daemon, real (fixture)
// provider, real `?thread=true`. The fixture set carries the motivating case on
// purpose — ARGY-89's description still describes a per-series override that
// its second comment says was cut.
//
// Rounds 2-6 fulfil the ticket route in the browser, because they are shapes
// this daemon cannot produce with a fixture tracker: only Jira returns a WINDOW
// of a longer thread (`commentCount` 63, twenty bodies), only a failed tail
// fetch returns a count with no bodies, and only a Jira whose issue GET omits
// the `comment` field returns neither field at all. That those shapes are real
// is `ticket-thread.mts`'s job, asserted there against a stub Jira; what is
// asserted HERE is that the panel says something different and true about each
// one — the three of them rendered identically would be DRY-55's failure on a
// second surface.
//
// Round 7 is the DRY-74 invariant this change is most likely to break: the
// panel is a fixed-height float with the actions pinned to the bottom of its
// scrollport, and a forty-comment thread is the largest thing that has ever
// been put inside it.
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a name to a
// function — tsx's transform wraps those in a `__name(...)` helper that does not
// exist in the page. Anonymous inline arrows cross intact.
//
// Rig in the README. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/ticket-panel.mts)
import { chromium, type Page, type Route } from "playwright";
import type { Detail, TicketDetail } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5384";
/** The fixture ticket with a thread — and with a description the thread contradicts. */
const TICKET = process.env.TICKET ?? "ARGY-89";
/** A second ticket under the same epic, for the switch-while-loading round. */
const SIBLING = process.env.SIBLING ?? "ARGY-90";

let failures = 0;
let ran = 0;
function check(name: string, ok: boolean, detail: Detail = ""): void {
  ran++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the panel is showing. Read as one snapshot rather than as a dozen
 * locators so a failure prints the whole state — half the value of these
 * harnesses is the line beside the FAIL.
 */
interface Panel {
  /** Present at all? Absent means the panel never opened, which is a different bug. */
  open: boolean;
  desc: string;
  /** The count line above the first card — "Showing the 20 most recent of 63…". */
  window: string | null;
  /** Amber: a thread that exists and did not arrive is not the same as none. */
  windowWarn: boolean;
  /** One entry per rendered comment, in DOM order (newest first). */
  comments: { author: string; when: string; body: string; newest: boolean }[];
  /** The jump pill beside the title, which is all that says a thread is there. */
  pill: string | null;
  epic: string | null;
  /** Font sizes, for the heading claim: [panel title, a comment's h2, its p]. */
  sizes: { title: string; h2: string | null; p: string | null };
  /** Is Spawn Agent inside the panel's own box, on all four edges? (DRY-74) */
  sendInPanel: boolean | null;
}

/**
 * One snapshot of the panel, with the `txt` helper it wants written out at
 * every site (DRY-80).
 *
 * That helper is precisely the shape tsx breaks: its esbuild transform wraps
 * NAME-BOUND functions in a `__name(...)` call, and Playwright ships the body
 * to the page as source, where that helper does not exist — so the page throws
 * `ReferenceError: __name is not defined` at a line that reads perfectly well.
 * (It threw here first, which is how this comment came to be written.) Passing
 * the body as a string dodges the transform and is opaque to tsc, which would
 * exempt the largest DOM-reading code in this file from the check.
 */
const read = (page: Page): Promise<Panel> =>
  page.evaluate(() => {
    const panel = document.querySelector(".panel");
    if (!panel) {
      return {
        open: false,
        desc: "",
        window: null,
        windowWarn: false,
        comments: [],
        pill: null,
        epic: null,
        sizes: { title: "", h2: null, p: null },
        sendInPanel: null,
      };
    }
    const win = panel.querySelector(".twindow");
    const head = panel.querySelector(".comment-body h1, .comment-body h2");
    const para = panel.querySelector(".comment-body p");
    const pill = panel.querySelector(".cjump");
    const epic = panel.querySelector(".metarow .epic");
    const send = panel.querySelector("button.send");
    const pr = panel.getBoundingClientRect();
    const sr = send?.getBoundingClientRect();
    return {
      open: true,
      desc: (panel.querySelector(".desc > .mdbody")?.textContent ?? "").trim(),
      window: win ? (win.textContent ?? "").trim() : null,
      windowWarn: !!win?.classList.contains("warn"),
      comments: [...panel.querySelectorAll(".comment")].map((c) => ({
        author: (c.querySelector(".cauthor")?.textContent ?? "").trim(),
        when: (c.querySelector(".cwhen")?.textContent ?? "").trim(),
        body: (c.querySelector(".comment-body")?.textContent ?? "").trim(),
        newest: !!c.querySelector(".cnew"),
      })),
      pill: pill ? (pill.textContent ?? "").trim() : null,
      epic: epic ? (epic.textContent ?? "").trim() : null,
      sizes: {
        title: getComputedStyle(panel.querySelector(".title")!).fontSize,
        h2: head ? getComputedStyle(head).fontSize : null,
        p: para ? getComputedStyle(para).fontSize : null,
      },
      // All four edges, plus the viewport: DRY-74's symptom was a Spawn Agent
      // that had left the bottom of a panel which itself looked fine.
      sendInPanel:
        sr && pr
          ? sr.left >= pr.left - 1 &&
            sr.right <= pr.right + 1 &&
            sr.top >= pr.top - 1 &&
            sr.bottom <= pr.bottom + 1 &&
            sr.bottom <= window.innerHeight + 1
          : null,
    };
  });

/**
 * Open the ticket panel from the sidebar.
 *
 * Two disclosures deep: repo groups render collapsed, and the fixture's only
 * ticket with a thread hangs off an epic — whose children are not in the DOM
 * until the epic row is expanded (DRY-83). A ghost epic has no ticket behind it
 * and nothing to expand.
 */
async function openTicket(page: Page, key = TICKET): Promise<void> {
  for (const g of await page.locator(".grp").all()) {
    await g.click();
    await sleep(120);
  }
  for (const e of await page.locator(".row.epic:not(.ghost)").all()) {
    await e.click();
    await sleep(250);
  }
  await page.locator(".row:not(.epic)").filter({ hasText: key }).first().click();
  await page.waitForSelector("button.send", { timeout: 8000 });
  await sleep(600);
}

/** A `TicketDetail` for a fulfilled response — only the fields the panel reads. */
function detail(over: Partial<TicketDetail>): TicketDetail {
  return {
    key: TICKET,
    title: "Series auto-advance",
    status: { category: "in_progress", label: "In Progress" },
    repo: "argosy",
    project: "argosy",
    labels: [],
    description: "the plan, written first and never updated",
    ...over,
  };
}

function comments(n: number, from = 0): { author: string; createdAt: string; body: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    author: (i + from) % 2 ? "Ashley" : "claude",
    createdAt: `2026-07-${String(((i + from) % 28) + 1).padStart(2, "0")}T12:00:00.000+0000`,
    body: `comment #${i + from}`,
  }));
}

/**
 * Answer the ticket route with `body`, and hand back the URLs it was asked for.
 *
 * The URL list is not incidental: a panel that renders a thread it was handed
 * proves nothing if the shell stopped ASKING for one, and `?thread=true` is the
 * only part of this change the browser owns.
 */
async function fulfilWith(page: Page, body: TicketDetail): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/tracker/ticket/**", async (route: Route) => {
    asked.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ticket: body }),
    });
  });
  return asked;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });

console.log("\n1. the real path: fixture provider, real route, nothing faked");
{
  const page = await ctx.newPage();
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/tracker/ticket/")) asked.push(r.url());
  });
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("the panel opened", p.open);
  check("it asked the daemon for the thread", asked.some((u) => u.includes("thread=true")), asked.join(" ") || "(no ticket request)");
  check("the description is still there", p.desc.includes("Fixture ticket"), p.desc.slice(0, 60));
  check("all three comments render", p.comments.length === 3, p.comments.length);
  // The point of the ordering: the comment that overtakes the description is
  // the one you meet first, not the one you scroll to.
  check("the NEWEST is first", p.comments[0]?.body.includes("Safari") === true, p.comments[0]?.body.slice(0, 50) ?? "");
  check("…and it is badged as the newest", p.comments[0]?.newest === true);
  check("the oldest is last", p.comments[2]?.body.includes("Design review") === true, p.comments[2]?.body.slice(0, 50) ?? "");
  check("only one comment is badged", p.comments.filter((c) => c.newest).length === 1, p.comments.filter((c) => c.newest).length);
  check("the correction is on screen", p.comments.some((c) => c.body.includes("NOT shipping the per-series override")), p.comments.map((c) => c.body.slice(0, 20)).join(" | "));
  check("authors are attributed", p.comments[0]?.author === "Jordan", p.comments[0]?.author ?? "");
  check("timestamps are rendered, not raw ISO", !!p.comments[0]?.when && !p.comments[0]!.when.includes("T"), p.comments[0]?.when ?? "");
  check("the window line says how much of the record this is", p.window === "3 comments, newest first.", p.window ?? "");
  check("the pill above the fold says the thread is there", p.pill === "3 comments", p.pill ?? "");
  // The other half of what the ancestry walk paid for.
  check("the resolved epic is named", p.epic?.includes("ARGY-64") === true, p.epic ?? "");
  await page.close();
}

console.log("\n2. a WINDOW of a longer thread says so (the Jira shape)");
{
  const page = await ctx.newPage();
  const asked = await fulfilWith(page, detail({ comments: comments(20, 43), commentCount: 63 }));
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("the shell asked for the thread", asked.some((u) => u.includes("thread=true")), asked.join(" ") || "(none)");
  check("it does not imply it has the lot", p.window === "Showing the 20 most recent of 63 comments, newest first.", p.window ?? "");
  check("the pill counts the whole thread, not the window", p.pill === "63 comments", p.pill ?? "");
  check("twenty cards render", p.comments.length === 20, p.comments.length);
  check("the newest of the 63 is first", p.comments[0]?.body === "comment #62", p.comments[0]?.body ?? "");
  check("the oldest of the WINDOW is last", p.comments[19]?.body === "comment #43", p.comments[19]?.body ?? "");
  await page.close();
}

console.log("\n3. a comment's own markdown headings stay subordinate");
{
  const page = await ctx.newPage();
  await fulfilWith(
    page,
    detail({
      commentCount: 1,
      comments: [
        {
          author: "Ashley",
          createdAt: "2026-07-04T10:00:00.000+0000",
          body: "## What the design adds\n\nA paragraph under it.",
        },
      ],
    }),
  );
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  const h2 = parseFloat(p.sizes.h2 ?? "0");
  const body = parseFloat(p.sizes.p ?? "0");
  const title = parseFloat(p.sizes.title);
  check("the heading rendered as a heading at all", h2 > 0, p.sizes.h2 ?? "(no h1/h2 in the comment)");
  // Not "smaller": the same size as the words around it. A comment is somebody
  // talking, and the byline above it is the most senior thing in the block.
  check("it is no bigger than the comment's own prose", h2 <= body + 0.01, `${h2} vs ${body}`);
  check("…and well under the panel's title", h2 < title, `${h2} vs ${title}`);
  check("the byline is still attached to the words", p.comments[0]?.author === "Ashley", p.comments[0]?.author ?? "");
  await page.close();
}

console.log("\n4. a thread that exists and did not arrive says THAT");
{
  const page = await ctx.newPage();
  await fulfilWith(page, detail({ comments: [], commentCount: 63 }));
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("it names the count it cannot show", p.window?.startsWith("This ticket has 63 comments, but none could be retrieved") === true, p.window ?? "");
  check("…and warns rather than reading as calm", p.windowWarn);
  check("no cards are invented", p.comments.length === 0, p.comments.length);
  await page.close();
}

console.log("\n5. …which is not the same sentence as an empty thread");
{
  const page = await ctx.newPage();
  await fulfilWith(page, detail({ comments: [], commentCount: 0 }));
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("an empty thread says so plainly", p.window === "No comments.", p.window ?? "");
  check("…without a warning colour", !p.windowWarn);
  check("…and without a pill to jump to nothing", p.pill === null, p.pill ?? "");
  await page.close();
}

console.log("\n6. …nor as a provider that answered no such question");
{
  const page = await ctx.newPage();
  await fulfilWith(page, detail({}));
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("the unanswered case names itself", p.window === "The tracker returned no comment thread for this ticket.", p.window ?? "");
  check("…and warns, because it is not 'nobody commented'", p.windowWarn);
  await page.close();
}

console.log("\n7. a long thread does not push Spawn Agent off the panel (DRY-74)");
{
  const page = await ctx.newPage();
  await fulfilWith(page, detail({ comments: comments(40), commentCount: 40 }));
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  const p = await read(page);
  check("forty comments render", p.comments.length === 40, p.comments.length);
  check("Spawn Agent is still inside the panel and on screen", p.sendInPanel === true, String(p.sendInPanel));
  // The thread has to be able to give way, and `.desc` is the only region
  // DRY-74 allows to: everything else is a control at its natural size.
  const grew = await page.evaluate(() => {
    const panel = document.querySelector(".panel") as HTMLElement | null;
    const desc = document.querySelector(".panel .desc") as HTMLElement | null;
    return panel && desc
      ? { panel: panel.getBoundingClientRect().height, over: desc.scrollHeight - desc.clientHeight }
      : null;
  });
  check("the thread scrolls inside the description box", (grew?.over ?? 0) > 0, JSON.stringify(grew));
  check("…rather than growing the panel past its cap", (grew?.panel ?? 0) <= 950 * 0.82 + 2, JSON.stringify(grew));
  await page.close();
}

console.log("\n8. a slower earlier ticket cannot land on the one now open");
{
  // The race is older than this ticket — the panel is reused between tickets,
  // and its fetch had no guard that the answer belonged to the ticket still on
  // screen — but DRY-76 both widens it (a Switchyard open is 3 upstream GETs
  // where it was 1) and sharpens it: what a stale reply now paints is a comment
  // THREAD under the wrong ticket, on the panel whose whole job is telling you
  // whether the description in front of you is still current.
  const page = await ctx.newPage();
  await page.route("**/api/tracker/ticket/**", async (route: Route) => {
    const first = route.request().url().includes(TICKET);
    // Only the FIRST ticket is slow, so the reply order is guaranteed to be the
    // wrong one. A harness that raced the two would pass by luck.
    if (first) await sleep(3000);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticket: detail({
          key: first ? TICKET : SIBLING,
          description: first ? "SLOW-A description" : "FAST-B description",
          commentCount: 1,
          comments: [
            {
              author: first ? "slow" : "fast",
              createdAt: "2026-07-04T10:00:00.000+0000",
              body: first ? "SLOW-A comment" : "FAST-B comment",
            },
          ],
        }),
      }),
    });
  });
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await openTicket(page);
  // …and switch before the first answers.
  await page.locator(".row:not(.epic)").filter({ hasText: SIBLING }).first().click();
  await sleep(1000);
  const during = await read(page);
  check("the second ticket's thread renders", during.comments[0]?.body === "FAST-B comment", during.comments[0]?.body ?? "(none)");
  // Past the point the first request answers.
  await sleep(3500);
  const after = await read(page);
  check("the superseded reply does not overwrite it", after.comments[0]?.body === "FAST-B comment", after.comments[0]?.body ?? "(none)");
  check("…nor its description", after.desc.includes("FAST-B"), after.desc.slice(0, 60));
  check("…and the panel is not stuck loading", !after.desc.includes("Loading") && after.comments.length === 1, `${after.comments.length} cards`);
  await page.close();
}

await ctx.close();
await browser.close();
console.log(`\n${failures ? `${failures} of ${ran} FAILED` : `all ${ran} passed`}`);
process.exit(failures ? 1 : 0);
