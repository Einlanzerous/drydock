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
//   3. a bare workspace (the palette's pinned row) has no prompt and types nothing
//   4. the RETURN is the only difference between this and an autonomous run
//   5. the HOST's configured prompt is what arrives, placeholders expanded (DRY-94)
//   6. …and with no value set, the daemon's built-in default arrives instead
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a name to a
// function — tsx's transform wraps those in a `__name(...)` helper that does
// not exist in the page. Anonymous inline arrows cross intact.
//
// Rig in the README. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/prefill.mts)
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5388";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4388";
/** The fixture ticket the rounds spawn from — flat, so no epic to expand. */
const TICKET = process.env.TICKET ?? "SWY-12";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let ran = 0;
/**
 * Counts as well as reports, and the summary prints BOTH numbers.
 *
 * The discrimination note in the README is "8 of N failed against the pre-fix
 * tree", and that is how a later reader tells "still discriminates" from "a
 * round stopped running". A denominator anyone has to count by hand is one that
 * can be wrong the day it is written — this one was (16, for 17 checks), and
 * review caught it rather than a run.
 */
const check = (n: string, ok: boolean, d: Detail = "") => {
  ran++;
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

const PROMPT = `Workticket${TICKET}.`; // the head of the prompt template, despaced

/**
 * The template the daemon under test must be started with (DRY-94) — see the
 * README rig, which sets DRYDOCK_AGENT_PROMPT to exactly this.
 *
 * Every piece of it is load-bearing:
 *   - it opens with the same sentence rounds 1-2 look for, so those keep
 *     asserting what they always did (the prompt arrived, once, unsubmitted)
 *     without caring which template produced it;
 *   - `{key}` and `{repo}` are both here, because a template that only ever
 *     substituted the key would pass a harness that only ever checked one;
 *   - `{{esc}}` is the doubled-brace escape, and the round asserts a literal
 *     `{esc}` comes out — a prompt is prose and is entitled to contain braces,
 *     and the boot check refuses anything that looks like a placeholder it
 *     cannot fill.
 */
const CONFIGURED = `Work ticket {key}. See {repo} through, and leave {{esc}} alone.`;
const CONFIGURED_SEEN = `Workticket${TICKET}.Seeswitchyardthrough,andleave{esc}alone.`;

/** `desk` as of DRY-94. `agentPrompt` is absent on an older daemon. */
type ConfigBody = {
  autonomous?: { permissionMode?: string };
  desk?: { clearFinishedAfterMs?: number; agentPrompt?: string };
};

/**
 * This harness is only meaningful against a daemon started with the template
 * above, and it REFUSES rather than measuring nothing — the same rule sweep.mts
 * follows for its turned-down delay. Silently asserting the built-in default
 * would pass on a rig that never set the variable, which is the one thing round
 * 5 exists to find out.
 */
const hostConfig = (await (await fetch(`${DAEMON}/api/config`)).json()) as ConfigBody;
if (hostConfig.desk?.agentPrompt !== CONFIGURED) {
  console.log(
    `this daemon serves desk.agentPrompt = ${JSON.stringify(hostConfig.desk?.agentPrompt)}.\n` +
      `Start it with DRYDOCK_AGENT_PROMPT set to exactly:\n  ${CONFIGURED}\n` +
      `(see the README rig) — rounds 5 and 6 measure nothing without it.`,
  );
  process.exit(2);
}

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
async function open(
  browser: Browser,
  /**
   * Answer /api/config with this body instead of the daemon's own (round 6).
   *
   * The shell's daemon URL is baked in by Vite at start-up, so a desk cannot be
   * re-pointed at a second daemon from inside a running browser. What it can do
   * is be handed that daemon's real config body — which is what this is: not a
   * hand-written fixture, but the answer a daemon started with no
   * DRYDOCK_AGENT_PROMPT actually gives.
   */
  config?: ConfigBody,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  if (config) {
    // Before goto: the desk reads this once during start-up, and a route
    // installed after that lands on nothing.
    await page.route("**/api/config", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }),
    );
  }
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

console.log("\n3. the bare workspace spawn has no prompt to pre-fill");
{
  await reset();
  const { ctx, page } = await open(browser);
  // Through the palette, not a header button: DRY-82 folded "+ claude" and
  // "+ workspace" into the pinned rows here, so this is now the only gesture
  // that starts a bare workspace.
  await page.click("button.new");
  await page.fill(".palette .search input", "workspace");
  await page.click(".palette .row.pinrow");
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


console.log("\n5. the HOST's configured prompt is what arrives (DRY-94)");
{
  await reset();
  const { ctx, page } = await open(browser);
  await openTicket(page);
  await page.locator("button.send").click();
  await page.waitForSelector(".agent .xterm", { timeout: 15000 });
  await sleep(6000);
  const seen = await rows(page);
  // Asserted on the CLI's echo, like every other round here: /api/config
  // answering with the template proves the daemon read the variable and
  // nothing more. The prompt this ticket is about is the one that reaches an
  // agent, and the two were a whole shell bundle apart.
  check("the configured prompt arrived", times(seen, CONFIGURED_SEEN) === 1, seen.slice(-140));
  check("{key} was expanded", !seen.includes("{key}"));
  check("{repo} was expanded", !seen.includes("{repo}"));
  // A dropped `{esc}` and an expanded one are indistinguishable in a template
  // that never had one, which is why the rig's template carries the escape.
  check("{{esc}} survived as a literal {esc}", seen.includes("{esc}"));
  check("nothing was dropped", !seen.includes("[dropped"), seen.slice(-90));
  check("still a pre-fill, not a run", !seen.includes("[CR]"));
  await ctx.close();
}

console.log("\n6. …and with none set, the built-in default arrives");
{
  // A second daemon, started with the variable EMPTY, asked what it serves.
  //
  // Empty rather than absent, and that is not the shortcut it looks like:
  // `config.ts` folds "" into the default (it is how a half-commented-out knob
  // reads), while `env.ts` skips any key already present in the environment —
  // so an empty value is also what stops a `.env` sitting above the checkout
  // from quietly supplying one. Absent, this round would report whatever the
  // developer's own host is configured with and call it the built-in default.
  const port = await new Promise<number>((res) => {
    // Asked of the kernel rather than computed from the harness's own port:
    // this host runs several agents at once, each with a throwaway daemon in
    // the 43xx range, and a guessed port finds somebody else's.
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      // Read BEFORE close: `address()` is null once the server has closed.
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => res(free));
    });
  });
  // Every DRYDOCK_* stripped, then only what this daemon needs put back. The
  // set is not fixed, and overriding one at a time is how a "throwaway" ends up
  // on the prod database with the prod auth password (see CLAUDE.md).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DRYDOCK_")) env[k] = v;
  Object.assign(env, {
    DRYDOCK_AGENT_PROMPT: "",
    DRYDOCK_PORT: String(port),
    DRYDOCK_HOST: "127.0.0.1",
    DRYDOCK_TRACKER: "fixture",
    DRYDOCK_SESSIONS_DIR: `/tmp/dry94-sessions-${port}`,
    DRYDOCK_STATE_FILE: `/tmp/dry94-state-${port}.json`,
    // Off, or this throwaway runs DRY-90's boot sweep over the worktrees of
    // whoever is running the harness. It only ever removes work that is clean
    // and merged, so nothing is lost — but a test daemon that deletes anything
    // at all on the way up is not a thing to leave switched on.
    DRYDOCK_WORKTREE_REAP_MS: "0",
  });
  // Runs from `daemon/`, like the harness itself. It spawns no PTY and so
  // leaves no supervisor behind — a kill is the whole cleanup.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env,
    stdio: "ignore",
  });
  let config: ConfigBody | null = null;
  for (let i = 0; i < 60 && !config; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (r.ok) config = (await r.json()) as ConfigBody;
    } catch {
      /* not up yet */
    }
  }
  const builtIn = config?.desk?.agentPrompt ?? "";
  check("a daemon with none set still serves a template", !!builtIn, builtIn.slice(0, 60));
  // The strip above actually worked. Without this the round would happily
  // "confirm the default" while reading the rig's own variable back.
  check("it is not the rig's configured one", builtIn !== CONFIGURED);
  check("it is a template, unexpanded", builtIn.includes("{key}"));
  // Three tripwires on the SHIPPED default, because they are this ticket's
  // claim about it rather than incidental wording: an autonomous run has to be
  // told to open a PR, to see the review through, and to stop. A default that
  // stops saying one of them should fail here and be re-argued, not sail past.
  check("it says to open a PR", /\bPR\b/.test(builtIn), builtIn.slice(0, 60));
  check("it says to see the review through", /review/i.test(builtIn));
  check("it bounds the loop", /at most|stop waiting|give up/i.test(builtIn));

  if (config) {
    // As every other round does, and for a reason this round found the hard
    // way: the desk RESTORES the saved arrangement, so without this the page
    // comes up holding round 5's workspace and `rows()` reads that pane —
    // which shows the configured prompt, and the check below fails against
    // correct code. The three that follow it would have passed vacuously.
    await reset();
    const { ctx, page } = await open(browser, config);
    await openTicket(page);
    await page.locator("button.send").click();
    await page.waitForSelector(".agent .xterm", { timeout: 15000 });
    await sleep(6000);
    const seen = await rows(page);
    // Whitespace-insensitive because `rows()` is, which also makes this the
    // round that proves a MULTI-LINE default survives: `flushInitialInput`
    // sends one of those as a bracketed paste, and a newline that submitted a
    // fragment instead would leave the tail of this string missing.
    const want = builtIn
      .replace("{key}", TICKET)
      .replace("{repo}", "switchyard")
      .replace(/\s+/g, "");
    check("the built-in default reached the CLI, whole", seen.includes(want), seen.slice(-140));
    check("nothing was dropped", !seen.includes("[dropped"), seen.slice(-90));
    check("still a pre-fill, not a run", !seen.includes("[CR]"));
    await ctx.close();
  }
  child.kill();
}

await browser.close();

console.log(failures ? `\n${failures} of ${ran} FAILED\n` : `\nall ${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
