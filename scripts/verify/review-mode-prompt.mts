// A ticket spawn's prompt follows the ticket's Switchyard `review_mode` (DRY-99).
//
// The claim curl cannot express: the prompt that REACHED the CLI is the one for
// that ticket's mode. The daemon answered 200 and the panel filled a composer for
// the whole time the mode was being ignored — so every assertion here is on
// bytes the wrapped process ECHOED BACK (`stub-cli.mts`, exactly as prefill.mts
// does), never on what the composer showed.
//
// Seven rounds:
//   0. the wire: `null` (unclassified) and an ABSENT key stay two different things
//      through the daemon, and a mode this build has never heard of reads as `null`
//   1. each of six tickets spawns the prompt for ITS mode — and not the neighbours'
//   2. a mode that changed after the sidebar cached the list: the panel's own
//      detail fetch wins, so a ticket lifted into `decision` is not spawned as
//      `evidence` from a stale row
//   3. …and it never overwrites a prompt somebody has started editing
//   4. a daemon older than this ticket (no per-mode prompts served): every ticket
//      falls back to the ordinary prompt rather than to nothing
//   5. host config: precedence, blank-means-unset, the `\n` escape, and a fixture
//      ticket (no modes at all) carrying no `reviewMode` key
//   6. a bad placeholder in ANY per-mode template refuses to boot, naming it
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a name to a
// function — tsx's transform wraps those in a `__name(...)` helper that does
// not exist in the page. Anonymous inline arrows cross intact.
//
// Rig in the README (it needs the stub tracker, a daemon pointed at it with TWO
// prompt variables set, and a shell). Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/review-mode-prompt.mts)
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5389";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4389";
const STUB = process.env.STUB ?? "http://127.0.0.1:4381";

/**
 * What the rig daemon must be started with, and why there are two.
 *
 * They have to DIFFER: a ticket from an older Switchyard (no `review_mode` key)
 * takes the ordinary prompt, and an `evidence` ticket takes the evidence one.
 * With the defaults those are the same sentence, so a build that read an absent
 * key as `evidence` would pass — the round would not be able to tell the two
 * answers apart, which is the whole distinction this ticket exists to keep.
 */
const ORDINARY = "Ordinary prompt for {key}.";
const EVIDENCE = "Evidence prompt for {key}.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let ran = 0;
/**
 * Counts as well as reports, so the discrimination note in the README can say
 * "N of M failed against the pre-fix tree" — a denominator nobody has to count
 * by hand is one that cannot be wrong the day it is written (see prefill.mts).
 */
const check = (n: string, ok: boolean, d: string | number = "") => {
  ran++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d !== "" ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

type ConfigBody = { desk?: { agentPrompt?: string; agentPrompts?: Record<string, string> } };
type WireTicket = { key: string; reviewMode?: string | null };

const despace = (s: string) => s.replace(/\s+/g, "");
/** The template as the panel expands it: `{key}` filled, the rest as written. */
const expand = (template: string, key: string) => template.replaceAll("{key}", key);
const times = (hay: string, needle: string): number => hay.split(needle).length - 1;

/**
 * What the review loop must say in every prompt that runs to a PR (the DRY-99
 * follow-up), as tripwires rather than an expectation about wording: a rewrite
 * that drops one should fail HERE and be re-argued, not sail past.
 *
 * The reason it exists: the loop first named only "the CI reviewer's comments
 * until it reports nothing blocking", and agents kept ending their turn saying
 * they were done with the PR still red — a failing check is not a review comment,
 * an "important" finding is not always "blocking", and a nit is neither. And the
 * BOUND must survive the widening, or the loop is the unbounded one again.
 *
 * `ends` is the tail that makes the hand-back conditional, which differs for `full`
 * (whose sign-off request waits on the same condition).
 */
function loopChecks(label: string, raw: string, ends: string): void {
  const x = despace(raw);
  check(`${label}: watches CI, not only the reviewer`, x.includes("ghprchecks") && x.includes("everyfailingcheck"));
  check(`${label}: nits are fixed or answered, not skipped`, x.includes("eachnitorreplywithwhynot"));
  check(`${label}: the bound survives, and covers a check still pending`, x.includes("atmost3reviewrounds") && x.includes("whateverisstillpending"));
  check(`${label}: it does not hand back on red`, x.includes(ends));
}

/**
 * What the agent pane's terminal is showing, with whitespace removed — the rows
 * are read rather than the socket because "it arrived" is a claim about the CLI.
 * Despaced because a TUI paints with cursor-positioning where a line has spaces
 * and a long prompt wraps at the pane's width (see prefill.mts).
 */
const rows = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.querySelector(".agent .xterm") ?? document.querySelector(".xterm");
    return el ? (el as HTMLElement).innerText.replace(/\s+/g, "") : "";
  });

const json = async <T,>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>;
const setStubMode = (key: string, value: string) =>
  fetch(`${STUB}/__review_mode?key=${key}&value=${value}`, { method: "POST" });

// --- Refuse rather than measure nothing --------------------------------------
//
// Every one of these is a rig that would let a round pass for the wrong reason.
const served = (await json<ConfigBody>(`${DAEMON}/api/config`)).desk ?? {};
const perMode = served.agentPrompts ?? {};
const refuse = (why: string): never => {
  console.log(
    `${why}\n\nStart the rig as the README describes: the stub with STUB_REVIEW_MODES=1, a daemon on\n` +
      `DRYDOCK_TRACKER=switchyard with DRYDOCK_AGENT_PROMPT='${ORDINARY}' and\n` +
      `DRYDOCK_AGENT_PROMPT_EVIDENCE='${EVIDENCE}'.`,
  );
  process.exit(2);
};
if (!served.agentPrompts) refuse("this daemon serves no desk.agentPrompts — it predates DRY-99.");
if (served.agentPrompt !== ORDINARY || perMode.evidence !== EVIDENCE)
  refuse(
    `this daemon serves agentPrompt=${JSON.stringify(served.agentPrompt)} and ` +
      `agentPrompts.evidence=${JSON.stringify(perMode.evidence)}.`,
  );
const tickets = (await json<{ tickets: WireTicket[] }>(`${DAEMON}/api/tracker/tickets`)).tickets ?? [];
if (!tickets.some((t) => t.key === "DRY-22")) refuse("the stub isn't serving DRY-21..26 (STUB_REVIEW_MODES=1).");

/** What each rig ticket should arrive as, and where its prompt comes from. */
const CASES: { key: string; label: string; template: string; wire: string }[] = [
  { key: "DRY-21", label: "evidence", template: perMode.evidence, wire: `"evidence"` },
  { key: "DRY-22", label: "decision", template: perMode.decision, wire: `"decision"` },
  { key: "DRY-23", label: "full", template: perMode.full, wire: `"full"` },
  { key: "DRY-24", label: "not classified (null)", template: perMode.unclassified, wire: "null" },
  // The one that matters most: a server that never sends the key is NOT
  // unclassified, and is not `evidence` either — it takes the ordinary prompt.
  { key: "DRY-25", label: "no review_mode key at all", template: served.agentPrompt ?? "", wire: "(absent)" },
  { key: "DRY-26", label: "a mode this build has never heard of", template: perMode.unclassified, wire: "null" },
];

// --- Helpers that touch the desk ---------------------------------------------
async function reset(): Promise<void> {
  const list = await json<{ sessions: { id: string }[] }>(`${DAEMON}/api/sessions`);
  for (const s of list.sessions) await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
  await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
  await sleep(500);
}

const browser = await chromium.launch();

async function open(config?: unknown): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  if (config) {
    // Before goto: the desk reads /api/config once during start-up, and a route
    // installed after that lands on nothing. Relayed rather than re-pointed
    // because a desk's daemon URL is baked in by Vite (see prefill.mts round 6).
    await page.route("**/api/config", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }),
    );
  }
  await page.goto(SHELL);
  await page.waitForSelector(".grp", { timeout: 15000 });
  await sleep(1200);
  return { page, close: () => ctx.close() };
}

/** Open the ticket panel from the sidebar. Repo groups render collapsed. */
async function openTicket(page: Page, key: string): Promise<void> {
  for (const g of await page.locator(".grp").all()) {
    await g.click();
    await sleep(150);
  }
  await page.locator(".row:not(.epic)").filter({ hasText: key }).first().click();
  await page.waitForSelector("button.send", { timeout: 8000 });
  await sleep(800);
}

/** Press "send" (supervised — pre-fills, never submits) and read what reached the CLI. */
async function spawnAndRead(page: Page): Promise<string> {
  await page.locator("button.send").click();
  await page.waitForSelector(".agent .xterm", { timeout: 15000 });
  // Long enough for the stub to paint, start listening, and be typed at — the
  // same 6s prefill.mts allows, and the prompt is longer here.
  await sleep(6000);
  return rows(page);
}

// --- 0. the wire --------------------------------------------------------------
console.log("\n0. the daemon keeps null, absent and unknown apart");
{
  const by = new Map(tickets.map((t) => [t.key, t]));
  const shape = (k: string) => (by.get(k) && "reviewMode" in by.get(k)! ? JSON.stringify(by.get(k)!.reviewMode) : "(absent)");
  for (const c of CASES) check(`${c.key} (${c.label}) arrives as ${c.wire}`, shape(c.key) === c.wire, shape(c.key));
  // The single-ticket route is the one the PANEL reads, and it is built by a
  // different code path from the list — both have to carry it.
  const one = (await json<{ ticket: WireTicket }>(`${DAEMON}/api/tracker/ticket/DRY-24?thread=true`)).ticket;
  check("…and the single-ticket route says null for an unclassified one", one.reviewMode === null, JSON.stringify(one.reviewMode));
  const absent = (await json<{ ticket: WireTicket }>(`${DAEMON}/api/tracker/ticket/DRY-25?thread=true`)).ticket;
  check("…and leaves the key absent for an older server's", !("reviewMode" in absent));
}

// --- 1. each mode's prompt ARRIVES --------------------------------------------
console.log("\n1. each ticket spawns the prompt for its own mode");
for (const c of CASES) {
  await reset();
  const { page, close } = await open();
  await openTicket(page, c.key);
  const seen = await spawnAndRead(page);
  const want = despace(expand(c.template, c.key));
  check(`${c.key} (${c.label}): its whole prompt reached the CLI`, seen.includes(want), seen.slice(-120));
  // The neighbours' prompts must NOT have: a build that sent everyone the same
  // sentence passes the check above for exactly one of the six.
  const others = CASES.filter((o) => o.template !== c.template).map((o) => despace(expand(o.template, c.key)));
  const leaked = others.filter((o) => seen.includes(o));
  check(`${c.key}: and none of the other modes' did`, leaked.length === 0, leaked.map((l) => l.slice(0, 30)).join(" | "));
  check(`${c.key}: it went once, unsubmitted, nothing dropped`, times(seen, want) === 1 && !seen.includes("[CR]") && !seen.includes("[dropped"));
  await close();
}

// The distinctions the ticket names, said as tripwires so a reworded default
// that stops saying one fails HERE and gets re-argued, rather than sailing past.
console.log("\n   …and the policy each one carries");
{
  const d = despace(perMode.decision), f = despace(perMode.full), u = despace(perMode.unclassified), e = despace(perMode.evidence);
  check("decision plans first and says to stop", d.includes("Planfirst") && /stopandhandback/.test(d));
  check("decision then runs it through — the review loop and its bound", /atmost3reviewrounds/.test(d));
  check("full is decision plus a merge sign-off", f.includes("Planfirst") && f.includes("Donotmerge") && /signoffonthemerge/.test(f));
  check("decision does NOT forbid the merge (that is what full adds)", !d.includes("Donotmerge"));
  check("unclassified asks and does not run the ticket", /noreviewmode/.test(u) && /Ianswer/.test(u) && !/atmost3reviewrounds/.test(u));
  check("evidence does not plan-gate", !e.includes("Planfirst"));
  // A thing said in prose that the agent has to be able to DO: the plan tools
  // are Switchyard's, and named so a respawn checks whether it is approved.
  check("the plan clause names the tools", d.includes("get_plan") && d.includes("open_plan_draft") && d.includes("submit_plan"));
  // `evidence` is a short override in this rig (it has to differ from the ordinary
  // prompt), so ITS built-in loop is checked in round 5, on a daemon with nothing set.
  loopChecks("decision", perMode.decision, "Handbackonlywheneverycheckisgreenandeverycommentanswered");
  loopChecks("full", perMode.full, "onceitisgreenandanswered");
}

// --- 2. a mode that changed after the sidebar cached the list -----------------
console.log("\n2. the panel's own fetch beats a stale sidebar row");
{
  await reset();
  const { page, close } = await open(); // the list, cached by the daemon, says `decision`
  try {
    await setStubMode("DRY-22", "full"); // …and now it does not
    await openTicket(page, "DRY-22");
    const seen = await spawnAndRead(page);
    check(
      "the FULL prompt arrived, not the decision one the row said",
      seen.includes(despace(expand(perMode.full, "DRY-22"))),
      seen.slice(-100),
    );
    check("and not the stale one", !seen.includes(despace(expand(perMode.decision, "DRY-22"))));
  } finally {
    await setStubMode("DRY-22", "decision");
    await close();
  }
}

// --- 3. …and never over a prompt somebody is typing ---------------------------
console.log("\n3. a mode landing late does not overwrite an edit in progress");
{
  await reset();
  const { page, close } = await open();
  const MINE = "my own words for DRY-21";
  try {
    // Hold the panel's detail fetch, so its mode arrives AFTER the edit.
    await page.route("**/api/tracker/ticket/**", async (route) => {
      await sleep(2500);
      await route.continue();
    });
    await setStubMode("DRY-21", "decision"); // the row says evidence; the fetch will say decision
    for (const g of await page.locator(".grp").all()) {
      await g.click();
      await sleep(150);
    }
    await page.locator(".row:not(.epic)").filter({ hasText: "DRY-21" }).first().click();
    await page.waitForSelector("button.send", { timeout: 8000 });
    await page.locator("textarea.prompt").fill(MINE);
    await sleep(4000); // the detail has landed by now
    const box = await page.locator("textarea.prompt").inputValue();
    check("the box still holds what was typed", box === MINE, JSON.stringify(box.slice(0, 60)));
    const seen = await spawnAndRead(page);
    check("and that is what reached the CLI", seen.includes(despace(MINE)), seen.slice(-80));
    check("not the decision prompt the late fetch would have filled", !seen.includes("Planfirst"));
  } finally {
    await setStubMode("DRY-21", "evidence");
    await close();
  }
}

// --- 4. a daemon older than this ticket ---------------------------------------
console.log("\n4. a daemon that serves no per-mode prompts: the ordinary one, for everyone");
{
  await reset();
  // What a pre-DRY-99 daemon answers: `agentPrompt`, and no `agentPrompts`. This is
  // the REAL config with that one field taken away, not a hand-written body, so
  // everything else the desk reads at start-up is what a daemon actually says.
  const real = await json<{ desk?: Record<string, unknown> }>(`${DAEMON}/api/config`);
  const older = { ...real, desk: { ...real.desk, agentPrompts: undefined } };
  const { page, close } = await open(older);
  await openTicket(page, "DRY-22"); // a `decision` ticket — the one that must NOT run unattended… on a daemon that cannot say so
  const seen = await spawnAndRead(page);
  // Not asserting the policy is right (an older daemon has none), only that the
  // panel degrades to what that daemon has always served rather than to nothing
  // or to a policy invented in the browser — which is why the fallback is the
  // ordinary prompt and not a copy of a per-mode one held here.
  check("it fell back to the ordinary prompt", seen.includes(despace(expand(ORDINARY, "DRY-22"))), seen.slice(-80));
  check("…and did not invent a policy of its own", !seen.includes("Planfirst") && !seen.includes("noreviewmode"));
  await close();
}

await browser.close();

// --- 5. host config: precedence, blank, escape, and a tracker with no modes ---
//
// A SECOND daemon per case, on a fixture tracker, because these are claims about
// what a daemon started a particular way SERVES — and `DRYDOCK_*` stripped first,
// or a "throwaway" quietly inherits whatever the developer's own host has set
// (CLAUDE.md, on why that is the prod database and the prod password).
console.log("\n5. host config");

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

interface Booted {
  port: number;
  config: ConfigBody | null;
  out: string;
  exited: () => boolean;
  code: () => number | null;
  stop: () => Promise<void>;
}

async function boot(extra: Record<string, string>): Promise<Booted> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DRYDOCK_")) env[k] = v;
  Object.assign(env, {
    DRYDOCK_PORT: String(port),
    DRYDOCK_HOST: "127.0.0.1",
    DRYDOCK_TRACKER: "fixture",
    DRYDOCK_SESSIONS_DIR: `/tmp/dry99-sessions-${port}`,
    DRYDOCK_STATE_FILE: `/tmp/dry99-state-${port}.json`,
    // Off, or this throwaway runs DRY-90's boot sweep over the worktrees of
    // whoever is running the harness.
    DRYDOCK_WORKTREE_REAP_MS: "0",
    // The default is `~/.drydock/daemon-<port>.log`, and the port is the KERNEL's
    // — so every run drops one file per daemon into the developer's real
    // ~/.drydock, none of them ever reused or cleaned. Empty disables the sink;
    // stdout/stderr are piped below, which is all this harness reads.
    DRYDOCK_LOG_FILE: "",
    ...extra,
  });
  // Runs from `daemon/`. It spawns no PTY and so leaves no supervisor behind —
  // a kill is the whole cleanup.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let code: number | null = null;
  let done = false;
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  child.on("exit", (c) => ((code = c ?? -1), (done = true)));
  let config: ConfigBody | null = null;
  for (let i = 0; i < 40 && !config && !done; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`);
      if (r.ok) config = (await r.json()) as ConfigBody;
    } catch {
      /* not up yet */
    }
  }
  return {
    port,
    config,
    out,
    exited: () => done,
    code: () => code,
    stop: async () => {
      child.kill();
      // Wait for it to be GONE before removing what it writes to: a daemon
      // shutting down can still write its state, and a `rm` that races that
      // leaves the file behind. (Bounded, so a wedged child cannot hang the run.)
      if (!done) await Promise.race([new Promise((res) => child.once("exit", res)), sleep(5000)]);
      // Safe to remove outright, unlike a real sessions dir: these daemons run a
      // fixture tracker and spawn nothing, so there is no detached supervisor
      // whose only handle this directory is (CLAUDE.md, on `rm -rf` of a live one).
      rmSync(`/tmp/dry99-sessions-${port}`, { recursive: true, force: true });
      rmSync(`/tmp/dry99-state-${port}.json`, { force: true });
    },
  };
}

const CUSTOM = "Custom {key}.";
const cases = {
  none: {},
  base: { DRYDOCK_AGENT_PROMPT: CUSTOM },
  both: { DRYDOCK_AGENT_PROMPT: CUSTOM, DRYDOCK_AGENT_PROMPT_EVIDENCE: "Ev {key}." },
  own: { DRYDOCK_AGENT_PROMPT_FULL: "Mine {key}.", DRYDOCK_AGENT_PROMPT_DECISION: "" },
  escape: { DRYDOCK_AGENT_PROMPT_DECISION: "Line one.\\nLine two {key}." },
  // Not a config, a refusal: see round 6.
  bad: { DRYDOCK_AGENT_PROMPT_FULL: "Work {tickets}." },
} as const;
// In parallel: each is a tsx cold start, and none of them shares anything.
const booted = Object.fromEntries(
  await Promise.all(Object.entries(cases).map(async ([k, v]) => [k, await boot(v)] as const)),
) as Record<keyof typeof cases, Booted>;

try {
  const p = (b: Booted) => b.config?.desk?.agentPrompts ?? {};
  const a = (b: Booted) => b.config?.desk?.agentPrompt;

  const none = booted.none;
  check("no variables: every mode has a built-in prompt", ["evidence", "decision", "full", "unclassified"].every((m) => !!p(none)[m]));
  check("…and the ordinary prompt is the evidence one (a host that never sees a mode is unchanged)", a(none) === p(none).evidence);
  check("…the four are four different sentences", new Set(Object.values(p(none))).size === 4);
  // The built-in `evidence` prompt — the DEFAULT, and the one the follow-up changed.
  loopChecks("built-in evidence", p(none).evidence, "Handbackonlywheneverycheckisgreenandeverycommentanswered");

  const base = booted.base;
  check("DRYDOCK_AGENT_PROMPT still sets the ordinary prompt", a(base) === CUSTOM, JSON.stringify(a(base)));
  check("…and speaks for evidence, which is the run-it-through mode", p(base).evidence === CUSTOM);
  // The asymmetry, and the reason for it: a run-it-through prompt applied to a
  // mode that exists to make an agent STOP would put back the failure DRY-99 fixes.
  check(
    "…but does NOT stand in for decision, full or unclassified",
    ["decision", "full", "unclassified"].every((m) => p(base)[m] !== CUSTOM && !!p(base)[m]),
  );

  const both = booted.both;
  check("a per-mode variable beats DRYDOCK_AGENT_PROMPT for its own mode", p(both).evidence === "Ev {key}.", JSON.stringify(p(both).evidence));
  check("…without taking the ordinary prompt with it", a(both) === CUSTOM);

  const own = booted.own;
  check("DRYDOCK_AGENT_PROMPT_FULL sets full", p(own).full === "Mine {key}.", JSON.stringify(p(own).full));
  check("a BLANK per-mode variable is unset, not an empty prompt", !!p(own).decision && p(own).decision.length > 100, String(p(own).decision?.length));

  const esc = booted.escape;
  check("`\\n` is decoded in a per-mode variable too", p(esc).decision === "Line one.\nLine two {key}.", JSON.stringify(p(esc).decision));

  // A tracker with no review modes: the fixture. Its tickets must carry NO key —
  // `undefined`, not `null` — or every one of them would be asked about.
  const fx = (await json<{ tickets: WireTicket[] }>(`http://127.0.0.1:${none.port}/api/tracker/tickets`)).tickets;
  check("a tracker with no modes serves tickets with no reviewMode key at all", fx.length > 0 && fx.every((t) => !("reviewMode" in t)), `${fx.length} tickets`);

  // --- 6. a bad placeholder in ANY per-mode template refuses to boot ---------
  console.log("\n6. …and a bad placeholder is refused, not expanded to nothing");
  const bad = booted.bad;
  check("the daemon did not come up", bad.config === null);
  check("it exited, rather than serving a prompt with a hole in it", bad.exited() && bad.code() !== 0, `code ${bad.code()}`);
  check("and named the variable", bad.out.includes("DRYDOCK_AGENT_PROMPT_FULL"), bad.out.slice(0, 120));
  check("and the placeholder", bad.out.includes("{tickets}"));
} finally {
  for (const b of Object.values(booted)) await b.stop();
}

console.log(failures ? `\n${failures} of ${ran} FAILED\n` : `\nall ${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
