// A ticket-driven workspace spawn pre-fills the agent's composer (DRY-88).
//
// The claim curl cannot express: a prompt REACHED the CLI. The daemon answered
// 201 and the pane sent its `{type:"input"}` frame for the whole time this was
// broken — the frame simply landed in a Claude Code that had not started
// reading stdin yet, and a CLI that isn't listening does not error. So every
// assertion here is on bytes the wrapped process ECHOED BACK, and the process
// is `stub-cli.mts`, which drops what arrives early and prints the count.
//
// Four rounds:
//   1. the pre-fill arrives, once, unsubmitted, and the browser never typed it
//   2. it survives a session poll landing mid-spawn
//   3. the bare "+ workspace" has no prompt and types nothing
//   4. the RETURN is the only difference between this and an autonomous run
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a name to a
// function — tsx's transform wraps those in a `__name(...)` helper that does
// not exist in the page. Anonymous inline arrows cross intact.
//
// Rig in the README. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/prefill.mts)
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5388";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4388";
/** The fixture ticket the rounds spawn from — flat, so no epic to expand. */
const TICKET = process.env.TICKET ?? "SWY-12";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

/**
 * What the agent pane's terminal is showing, with spaces removed.
 *
 * The rows are read rather than the socket, because "it arrived" is a claim
 * about the CLI and not about the wire. Whitespace goes because a TUI paints
 * with cursor-positioning escapes where a line has spaces — xterm renders the
 * gaps, but so does wrapping, and a prompt that wraps at the pane's width
 * would otherwise fail a substring test for having been drawn correctly.
 */
const rows = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.querySelector(".agent .xterm") ?? document.querySelector(".xterm");
    return el ? (el as HTMLElement).innerText.replace(/\s+/g, "") : "";
  });

/** How many times `needle` appears in `hay`. A retype is a pass otherwise. */
const times = (hay: string, needle: string): number => hay.split(needle).length - 1;

const PROMPT = `Workticket${TICKET}.`; // the head of TicketDetail's defaultPrompt, despaced

async function reset(): Promise<void> {
  const list = (await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse;
  for (const s of list.sessions)
    await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
  await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
  await sleep(500);
}

/**
 * A desk, with every `{type:"input"}` frame the page sends recorded.
 *
 * That list is the structural half of this ticket: the prompt now lives on the
 * daemon for the whole of its life, so a browser that types one is a browser
 * holding a copy that a re-mount can lose.
 */
async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as any).__typed = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: any) {
      try {
        const m = JSON.parse(data);
        if (m.type === "input") (window as any).__typed.push(m.data);
      } catch {
        /* not one of ours */
      }
      return send.call(this, data);
    };
  });
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await sleep(1200);
  return { ctx, page };
}

/**
 * Everything the page typed, minus what a TERMINAL types back on its own.
 *
 * xterm answers the CLI's DA1 / focus queries over the same socket and through
 * the same frame type, so a bare count of input frames is never zero and the
 * check would pass against anything. Only printable payloads count.
 */
const typedByBrowser = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    ((window as any).__typed as string[]).filter((d) => /[^\x00-\x1f\x7f]/.test(d.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))),
  );

/** Open the ticket panel from the sidebar. Repo groups render collapsed. */
async function openTicket(page: Page): Promise<void> {
  for (const g of await page.locator(".grp").all()) {
    await g.click();
    await sleep(150);
  }
  await page.locator(".row:not(.epic)").filter({ hasText: TICKET }).first().click();
  await page.waitForSelector("button.send", { timeout: 8000 });
  await sleep(800);
}

const browser = await chromium.launch();

console.log("\n1. a ticket spawn puts the prompt in the composer");
{
  await reset();
  const { ctx, page } = await open(browser);
  await openTicket(page);
  await page.locator("button.send").click();
  // Long enough for the stub to paint (1.2s), start listening (1.4s) and be
  // typed at (paint + 2s floor), plus the pane's own mount.
  await page.waitForSelector(".agent .xterm", { timeout: 15000 });
  await sleep(6000);
  const seen = await rows(page);
  check("the prompt is in the composer", times(seen, PROMPT) === 1, `seen ${times(seen, PROMPT)}×`);
  check("nothing was typed before the CLI was listening", !seen.includes("[dropped"), seen.slice(-90));
  check("it was NOT submitted", !seen.includes("[CR]"));
  const typed = await typedByBrowser(page);
  check("the browser never typed it", typed.length === 0, JSON.stringify(typed).slice(0, 90));
  await ctx.close();
}

console.log("\n2. …and survives a session poll landing mid-spawn");
{
  await reset();
  const { ctx, page } = await open(browser);
  await openTicket(page);
  // The gap the ticket names: spawnWorkspace awaits TWO spawns before it
  // registers the window, so a 3s poll tick in between reconciles a list that
  // has the agent session in it and no window for it — and cascade-adds a
  // plain terminal window, which `wm.add` then merges into the workspace
  // (DRY-42). Widening the gap makes that certain rather than occasional.
  let posts = 0;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST" && ++posts === 2) await sleep(4500);
    await route.continue();
  });
  await page.locator("button.send").click();
  await page.waitForSelector(".agent .xterm", { timeout: 20000 });
  await sleep(8000);
  const seen = await rows(page);
  check("the prompt is still in the composer", times(seen, PROMPT) === 1, `seen ${times(seen, PROMPT)}×`);
  check("still nothing dropped", !seen.includes("[dropped"), seen.slice(-90));
  check("still not submitted", !seen.includes("[CR]"));
  // The window has to still BE a workspace: the plain window reconcile adds in
  // that gap is the one `wm.add` merges, and a desk left holding the plain one
  // is a ticket spawn with no drawer and a second window for its zsh.
  check("it is still one workspace window", (await page.locator(".frame").count()) === 1);
  check("the ticket drawer is still there", (await page.locator(".drawerbar").count()) === 1);
  // The one check in this round that fails against the ORIGINAL bug. Delaying
  // the second spawn moves the pane's own 700ms write ~4s later, which is past
  // the point the CLI starts listening — so the old code passes every timing
  // assertion here for a reason that has nothing to do with the race. What it
  // cannot pass is holding no copy of the prompt at all.
  const typed = await typedByBrowser(page);
  check("the browser still never typed it", typed.length === 0, JSON.stringify(typed).slice(0, 90));
  await ctx.close();
}

console.log("\n3. the bare + workspace has no prompt to pre-fill");
{
  await reset();
  const { ctx, page } = await open(browser);
  await page.locator("button.ghost", { hasText: "+ workspace" }).click();
  await page.waitForSelector(".agent .xterm", { timeout: 15000 });
  await sleep(6000);
  const seen = await rows(page);
  check(
    "nothing was typed into it",
    !seen.includes("Workticket") && !seen.includes("[dropped") && !seen.includes("[CR]"),
    seen.slice(-90),
  );
  check("no ticket drawer", (await page.locator(".drawerbar").count()) === 0);
  await ctx.close();
}
await browser.close();

console.log("\n4. the RETURN is what separates a run from a pre-fill");
{
  await reset();
  // No browser: this is the daemon's own decision, and the pairing is the
  // point. Checking only the supervised half proves nothing — deleting the
  // submit outright would pass it, and every autonomous run would then sit at
  // a full composer that nobody ever sends.
  const say = async (autonomous: boolean): Promise<string> => {
    const r = await fetch(`${DAEMON}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "claude", title: "pair", cwd: "/tmp", autonomous, input: "ping" }),
    });
    const { session } = (await r.json()) as SpawnResponse;
    const ws = new WebSocket(`${DAEMON.replace("http", "ws")}/api/sessions/${session.id}/attach`);
    let buf = "";
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { type: string; data?: string };
      if ((m.type === "data" || m.type === "replay") && m.data) buf += m.data;
    };
    await new Promise((res) => (ws.onopen = () => res(null)));
    await sleep(6000);
    ws.close();
    await fetch(`${DAEMON}/api/sessions/${session.id}/kill`, { method: "POST" });
    return buf;
  };
  const supervised = await say(false);
  const unattended = await say(true);
  check("supervised: typed", supervised.includes("ping"), supervised.slice(-60));
  check("supervised: not submitted", !supervised.includes("[CR]"));
  check("autonomous: typed", unattended.includes("ping"), unattended.slice(-60));
  check("autonomous: submitted", unattended.includes("[CR]"));
  check("neither dropped anything", !`${supervised}${unattended}`.includes("[dropped"));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
