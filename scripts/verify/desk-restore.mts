// A desk that is reloaded comes back as it was left (DRY-101).
//
// Four ways a reload used to hand back a different desk, all of them through the
// SECOND device rather than the one you were using — the saved desk is shared,
// and every browser that has it open saves its own view of it back:
//
//   S1  a window closed on one device is still open on another, finds its
//       session gone, draws a Resume card (DRY-56) and — the next time anything
//       on that device is clicked — writes the window back into the shared desk.
//       The next reload anywhere restores a window that was closed days ago.
//   S2  the same, but the desk ALREADY carries such windows: a desk saved before
//       the fix has to heal on load, not merely stop getting worse.
//   S3  a tombstone's own Dismiss, which ends a card, reached nobody else.
//   S4  a workspace is two PTYs and one window. The pairing lived only in the
//       saved desk, so a device that had never heard of the workspace saved the
//       agent as a bare terminal and the zsh as a window, and a reload restored
//       both: four workspaces came back as eight windows.
//   S5  the repair for a desk that is already in that state.
//   S6  count, layout mode and geometry survive a plain reload on one device.
//   S7  a restored pane RENDERS cleanly. A pane replays the PTY's byte history
//       into a terminal that had already been fitted to the new window, so a
//       prompt that redraws itself ("up two lines, clear, rewrite") landed on the
//       wrong rows whenever the window was narrower than the PTY had been:
//       stacked prompts, split lines, a stray `%`. The ticket's four workspaces
//       came back that way because their windows had changed shape.
//
// What is asserted is what the DESK shows and what the DAEMON holds — never one
// without the other. A window that is not on screen but is in the saved desk is a
// resurrection waiting for the next reload; a window on screen that the daemon
// never saved is one that will not survive it.
//
// TWO BROWSER CONTEXTS are the two devices: separate localStorage, so neither
// can see the other's mirror. "Stale" is not simulated — device B is opened
// FIRST and left alone while A closes things, which is exactly what a laptop in a
// drawer is. B's write-back is provoked with the one gesture that always causes
// it, a click on a window (`bringFront` bumps z, the deep watcher pushes the
// whole desk). Without that click nothing here would fail against the bug: a
// stale device that never writes is harmless.
//
// TIERS. Runs on either and should be run on both, but only the database tier
// can fail S1–S3 — the file store keeps no history, so it has no card to
// resurrect and the window is simply dropped. S4–S6 fail on both. The tier is
// read from /healthz and the history-only sections say so and skip.
//
// RIG (three terminals). The stub `claude` matters — `spawnWorkspace` spawns a
// bare `claude`, and with no shim that is the real CLI on whatever host this is:
//
//   bunx playwright install chromium         # once per machine
//
//   mkdir -p /tmp/dry101-bin
//   printf '#!/bin/sh\nexec node --import %s/node_modules/tsx/dist/loader.mjs %s/scripts/verify/stub-cli.mts "$@"\n' \
//     "$PWD" "$PWD" > /tmp/dry101-bin/claude && chmod +x /tmp/dry101-bin/claude
//
//   # database tier only:
//   docker run -d --name dry101-db -e POSTGRES_PASSWORD=dry101pw -e POSTGRES_USER=drydock \
//     -e POSTGRES_DB=drydock -p 127.0.0.1:55101:5432 postgres:16-alpine
//
//   (cd daemon && PATH="/tmp/dry101-bin:$PATH" \
//      DRYDOCK_PORT=4401 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d101 \
//      DRYDOCK_TRACKER=fixture DRYDOCK_CLEAR_FINISHED_AFTER_MS=0 \
//      DRYDOCK_WORKTREES_ROOT=/tmp/dry101-wt DRYDOCK_WORKTREE_REAP_MS=0 \
//      DRYDOCK_STATE_FILE=/tmp/dry101-state.json \
//      node --import tsx src/index.ts &)
//      # …or, for the database tier, swap DRYDOCK_STATE_FILE for
//      #   DRYDOCK_DATABASE_URL='postgres://drydock:dry101pw@127.0.0.1:55101/drydock'
//   (cd shell && VITE_DAEMON_URL=http://127.0.0.1:4401 bunx vite --port 5401 --strictPort &)
//
//   (cd daemon && node --import tsx ../scripts/verify/desk-restore.mts)
//
// `DRYDOCK_CLEAR_FINISHED_AFTER_MS=0` turns DRY-60's sweep off, and this file
// REFUSES to run without it: left on, a window it counts can be cleared
// mid-round by something with nothing to do with this ticket. It also refuses
// :4317 and :4318 — it kills every session the daemon has, to start from a clean
// desk, and those two are the ones that own real agents.
//
// The database-tier sections also shell out to `docker exec … psql` once each,
// to put a history row into a state no API produces: "died on its own and the
// daemon has since forgotten it". That is what a card is FOR, and without one
// nothing here could check that the fix did not swallow real cards along with the
// resurrected ones. Container name: DRY101_DB (default `dry101-db`).
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a NAME to a
// function — tsx's transform wraps those in a `__name(...)` helper the page does
// not have. Anonymous inline arrows cross intact.
//
// Afterwards, IN THIS ORDER: kill the supervisors it leaves behind (CLAUDE.md's
// loop over /proc/<pid>/exe, never `pkill -f supervisor/main`), and only then
// `rm -rf /tmp/d101 /tmp/dry101-*`.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  deskWindows,
  type Detail,
  type HealthResponse,
  type HistoryResponse,
  type SessionInfo,
  type SessionRecord,
  type SessionsResponse,
  type SpawnResponse,
  type WorkspaceResponse,
} from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5401";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4401";
const DB = process.env.DRY101_DB ?? "dry101-db";
const CWDS = "/tmp/dry101-cwd";
const VERBOSE = process.env.VERBOSE === "1";
/** The managed layouts animate (`all .26s`) and persist is debounced 400ms. */
const SETTLE_MS = 1000;
/**
 * The session poll is 3s, history is demand-driven behind a two-pass handshake,
 * and a card being re-checked is floored at 15s (`HISTORY_MIN_INTERVAL_MS`).
 * These are the budgets for "a device notices", and they are generous on purpose:
 * a tight one measures the schedule rather than the rule.
 */
const NOTICE_MS = 20_000;
const CARD_RECHECK_MS = 40_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The trailing comma is required in a `.mts` file: `<T>` alone at the start of
// an arrow is reserved syntax there (it would be a JSX tag in `.tsx`).
const j = async <T,>(u: string, init?: RequestInit): Promise<T> =>
  (await fetch(u, init)).json() as Promise<T>;

let failures = 0;
let ran = 0;
/**
 * Counts as well as reports, and the summary prints both numbers — the README's
 * discrimination note is "N of M failed against the pre-fix tree", and a
 * denominator counted by hand is one that can be wrong the day it is written.
 */
function check(name: string, ok: boolean, detail: Detail = ""): void {
  ran++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * `ONLY=S7` (or `ONLY=S1,S4`) runs just those sections. Each takes a minute or
 * two and S7 is a measurement rather than an assertion about state, so being able
 * to repeat one is how a flaky number gets told apart from a real one.
 */
const only = process.env.ONLY?.split(",").map((x) => x.trim().toUpperCase());
const section = (name: string): boolean => {
  const run = !only || only.some((o) => name.toUpperCase().startsWith(o + " "));
  if (run) console.log(`\n${name}`);
  return run;
};

// --- the daemon --------------------------------------------------------------

async function spawn(body: Record<string, unknown>): Promise<SessionInfo> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Partial<SpawnResponse> & { error?: string };
  if (!json.session) throw new Error(`spawn failed: ${json.error}`);
  return json.session;
}

/** A session with its own directory, so its window has a label of its own. */
const spawnIn = (name: string, body: Record<string, unknown> = {}): Promise<SessionInfo> => {
  const cwd = path.join(CWDS, name);
  fs.mkdirSync(cwd, { recursive: true });
  return spawn({ command: "/bin/sh", args: ["-c", "sleep 900"], cwd, title: name, ...body });
};

const kill = (id: string): Promise<Response> =>
  fetch(`${DAEMON}/api/sessions/${id}/kill`, { method: "POST" });

const listed = async (): Promise<SessionInfo[]> =>
  (await j<SessionsResponse>(`${DAEMON}/api/sessions`)).sessions;

const history = async (): Promise<SessionRecord[]> => {
  const res = await fetch(`${DAEMON}/api/sessions/history?limit=200`);
  return res.status === 501 ? [] : ((await res.json()) as HistoryResponse).sessions;
};

/** The ids in the DAEMON's copy of the desk — what the next reload restores. */
async function savedIds(): Promise<string[]> {
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  return deskWindows(workspace).map((w) => w.id);
}

async function savedLayout(): Promise<string> {
  const { workspace } = await j<WorkspaceResponse>(`${DAEMON}/api/workspace`);
  return workspace?.layout ?? "(nothing saved)";
}

/** Put a desk straight into the daemon, the way a browser that got it wrong would. */
async function seedDesk(layout: string, windows: Record<string, unknown>[]): Promise<void> {
  const res = await fetch(`${DAEMON}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 2, layout, windows }),
  });
  if (!res.ok) throw new Error(`could not seed the desk: ${res.status}`);
}

/** A saved window as a browser would have written it. */
const seededWindow = (
  id: string,
  repo: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  kind: "terminal",
  type: "bash",
  title: "bash",
  repo,
  x: 60,
  y: 60,
  w: 632,
  h: 462,
  z: 1,
  minimized: false,
  ...extra,
});

/**
 * Turn a history row into "died on its own, and the daemon has forgotten it".
 *
 * The one place this file touches SQL, and it exists to model a state rather than
 * to bypass a code path: nothing over HTTP makes a session end WITHOUT somebody
 * asking (a daemon has to restart for it to be forgotten), and a card that
 * genuinely should be drawn is what proves the fix drops the right windows and
 * not all of them. `dismissed_at` may not exist on the tree this is aimed at —
 * the pre-fix daemon has never heard of it — and that is fine: there is nothing
 * there to clear.
 */
function diedOnItsOwn(id: string): void {
  const sql = [
    "update pty_sessions set end_reason = 'failed', exit_code = 3",
    ` where id = '${id}'`,
  ].join("");
  const clear = `update pty_sessions set dismissed_at = null where id = '${id}'`;
  for (const statement of [sql, clear]) {
    try {
      execFileSync(
        "docker",
        ["exec", DB, "psql", "-U", "drydock", "-d", "drydock", "-c", statement],
        { stdio: "pipe" },
      );
    } catch (err) {
      const text = String((err as { stderr?: Buffer }).stderr ?? err);
      if (!/dismissed_at/.test(text)) throw err;
    }
  }
}

/** A clean daemon: no sessions, no saved desk. */
async function reset(): Promise<void> {
  for (const s of await listed()) await kill(s.id);
  await fetch(`${DAEMON}/api/workspace`, { method: "DELETE" });
  await sleep(600);
}

// --- the desk ----------------------------------------------------------------

interface Win {
  title: string;
  /** The `~/…` label without the `~/` — one per session here, so it is the identity. */
  repo: string;
  tomb: boolean;
  workspace: boolean;
  /** Terminal panes drawn inside — a workspace with its zsh showing has two. */
  terms: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Every window as the BROWSER draws it. Geometry is in viewport coordinates, and
 * only ever compared with another reading of the same device at the same size.
 */
const desk = (page: Page): Promise<Win[]> =>
  page.$$eval(".frame", (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return {
        title: e.querySelector(".bar .title")?.textContent?.trim() ?? "",
        repo: (e.querySelector(".bar .repo")?.textContent ?? "").replace(/^~\//, "").trim(),
        tomb: !!e.querySelector(".tomb"),
        workspace: !!e.querySelector(".ws"),
        terms: e.querySelectorAll(".xterm").length,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );

const label = (w: Win): string =>
  `${w.repo}${w.tomb ? " [card]" : w.workspace ? " [workspace]" : ""}`;
const labels = (ws: Win[]): string[] => ws.map(label).sort();
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (VERBOSE && /drydock/.test(m.text())) console.log(`      [console] ${m.text().slice(0, 110)}`);
  });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar", { timeout: 15_000 });
  return { ctx, page };
}

/** Poll until the desk satisfies `ok`, and hand back the last reading either way. */
async function until(page: Page, ok: (ws: Win[]) => boolean, ms = NOTICE_MS): Promise<Win[]> {
  const deadline = Date.now() + ms;
  let ws = await desk(page);
  while (!ok(ws) && Date.now() < deadline) {
    await sleep(250);
    ws = await desk(page);
  }
  return ws;
}

const count = (n: number) => (ws: Win[]) => ws.length === n;

async function reload(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector(".topbar", { timeout: 15_000 });
}

const frameOf = (page: Page, repo: string) =>
  page.locator(".frame").filter({ has: page.locator(".bar .repo", { hasText: `~/${repo}` }) });

/**
 * Wait until the DAEMON's copy of the desk stops changing for a moment.
 *
 * Two browsers write to it on a 400ms debounce, so "I clicked, then looked" is a
 * race between the assertion and the write. Convergence is the claim — a desk
 * that flips between two answers is what this file exists to catch — so it is
 * read twice, a debounce apart, and only trusted when both agree.
 */
async function settled(): Promise<string[]> {
  let prev = (await savedIds()).sort().join("|");
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    const now = (await savedIds()).sort().join("|");
    if (now === prev) return now ? now.split("|") : [];
    prev = now;
  }
  return prev ? prev.split("|") : [];
}

/** A click that makes the device WRITE: focus bumps z and the deep watcher pushes. */
async function provokeWrite(page: Page, repo: string): Promise<void> {
  await frameOf(page, repo).first().locator(".bar .title").click();
  await sleep(SETTLE_MS);
}

// --- the run -----------------------------------------------------------------

const port = new URL(DAEMON).port;
if (port === "4317" || port === "4318") {
  throw new Error(`refusing to run against :${port} — this kills every session the daemon has`);
}
const cfg = await j<{ desk?: { clearFinishedAfterMs?: number } }>(`${DAEMON}/api/config`);
if (cfg.desk?.clearFinishedAfterMs !== 0) {
  throw new Error(
    `the daemon's sweep is on (DRYDOCK_CLEAR_FINISHED_AFTER_MS=${cfg.desk?.clearFinishedAfterMs}) — ` +
      "a window this file counts could be cleared mid-round. Start it with 0.",
  );
}
const health = await j<HealthResponse>(`${DAEMON}/healthz`);
const tier = health.store.kind;
const withHistory = tier === "postgres";
console.log(`tier: ${tier}${withHistory ? " (history kept)" : " (no history — S1–S3 cannot fail here)"}`);
const HOME = path.basename(os.homedir());

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------------------
  if (section("S1  a window closed on one device stays closed on another")) {
    await reset();
    const alpha = await spawnIn("alpha");
    await spawnIn("bravo");
    await spawnIn("charlie", { command: "claude", args: [] });
    const A = await open(browser);
    const B = await open(browser);
    check("device A restored three windows", (await until(A.page, count(3))).length === 3);
    check("device B restored three windows", (await until(B.page, count(3))).length === 3);
    await settled();

    await frameOf(A.page, "alpha").locator(".ctl.close").click();
    check("A closed alpha with the ✕", (await until(A.page, count(2))).length === 2);

    // B has not been told anything. Give it the time to notice on its own: under
    // the bug it draws a card for alpha (database tier) and holds it forever.
    const seenByB = await until(B.page, (ws) => !ws.some((w) => w.repo === "alpha" && !w.tomb));
    if (VERBOSE) console.log(`      [B after notice] ${labels(seenByB).join(", ")}`);
    await provokeWrite(B.page, "bravo");

    const b = await desk(B.page);
    check("B (never reloaded) is showing bravo and charlie", same(labels(b), ["bravo", "charlie"]), labels(b).join(", "));
    check("…and drew no card for the window that was closed", !b.some((w) => w.tomb), labels(b).join(", "));
    const ids = await settled();
    check("the saved desk holds two windows, not three", ids.length === 2, `${ids.length}`);
    check("…and alpha is not one of them", !ids.includes(alpha.id));

    await reload(A.page);
    const a2 = await until(A.page, count(2), 8000);
    check("A, reloaded, shows bravo and charlie and no card", same(labels(a2), ["bravo", "charlie"]), labels(a2).join(", "));
    await reload(B.page);
    const b2 = await until(B.page, count(2), 8000);
    check("B, reloaded, shows the same", same(labels(b2), ["bravo", "charlie"]), labels(b2).join(", "));

    if (withHistory) {
      // The daemon's own account of it — the half a page cannot vouch for.
      const rec = (await history()).find((r) => r.id === alpha.id);
      check("history says alpha was stopped by request", rec?.endReason === "stopped", rec?.endReason ?? "(no row)");
    }
    await A.ctx.close();
    await B.ctx.close();
  }

  // ---------------------------------------------------------------------------
  if (section("S2  a desk that already carries closed windows heals on load")) {
    await reset();
    const live = await spawnIn("bravo");
    const stopped = await spawnIn("alpha");
    await kill(stopped.id);
    // Ended by itself, then cleared by somebody: `finished`, and only the
    // dismissal says it was asked for. Two ways a window ends up here, both.
    const finished = await spawnIn("echo", { args: ["-c", "exit 0"] });
    await sleep(1500); // let it exit by itself before anybody clears it
    await kill(finished.id);
    await sleep(500);
    await seedDesk("float", [
      seededWindow(live.id, "bravo"),
      seededWindow(stopped.id, "alpha", { x: 120, y: 90, z: 2 }),
      seededWindow(finished.id, "echo", { x: 180, y: 120, z: 3 }),
    ]);
    const C = await open(browser);
    // What the desk is allowed to say while it works out which windows are dead:
    // for one poll a window whose session has gone has nothing to draw. It must
    // END with only the live one, and never with a card for either.
    const healed = await until(C.page, (ws) => same(labels(ws), ["bravo"]), NOTICE_MS);
    check("only the live window is left", same(labels(healed), ["bravo"]), labels(healed).join(", "));
    check("and neither closed window became a card", !healed.some((w) => w.tomb));
    await settled();
    const ids = await savedIds();
    check("the saved desk was rewritten without them", same(ids, [live.id]), `${ids.length} saved`);
    await C.ctx.close();

    if (withHistory) {
      // The control. Everything above passes for a fix that drops EVERY window
      // whose session has gone, including the ones a card is for.
      const died = await spawnIn("fail", { args: ["-c", "exit 3"] });
      await sleep(1500);
      await kill(died.id);
      await sleep(500);
      diedOnItsOwn(died.id);
      await seedDesk("float", [
        seededWindow(live.id, "bravo"),
        seededWindow(died.id, "fail", { x: 150, y: 100, z: 2 }),
      ]);
      const D = await open(browser);
      const shown = await until(D.page, (ws) => ws.some((w) => w.tomb), NOTICE_MS);
      check(
        "a session that died on its own STILL gets its card (the control)",
        same(labels(shown), ["bravo", "fail [card]"]),
        labels(shown).join(", "),
      );
      await D.ctx.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (section("S3  a card dismissed on one device is gone from the others")) {
    if (!withHistory) {
      console.log("  skipped — the file tier keeps no history, so there is no card to dismiss");
    } else {
      await reset();
      await spawnIn("bravo");
      const died = await spawnIn("fail", { args: ["-c", "exit 3"] });
      const A = await open(browser);
      const B = await open(browser);
      check("both devices show two windows", (await until(A.page, count(2))).length === 2 && (await until(B.page, count(2))).length === 2);
      await sleep(1500);
      await kill(died.id);
      await sleep(500);
      diedOnItsOwn(died.id);
      const cardA = await until(A.page, (ws) => ws.some((w) => w.tomb));
      const cardB = await until(B.page, (ws) => ws.some((w) => w.tomb));
      check("the session died on its own: both draw a card", cardA.some((w) => w.tomb) && cardB.some((w) => w.tomb));

      await frameOf(A.page, "fail").locator("button.ghost").click();
      check("A dismissed it", (await until(A.page, count(1))).length === 1);
      // B still holds the card. It is not told; it has to ASK, on its own schedule.
      const left = await until(B.page, (ws) => !ws.some((w) => w.tomb), CARD_RECHECK_MS);
      check("B's card goes without a reload", !left.some((w) => w.tomb), labels(left).join(", "));
      await provokeWrite(B.page, "bravo");
      const ids = await settled();
      check("and B did not write it back into the saved desk", ids.length === 1, `${ids.length} saved`);
      await reload(A.page);
      const a2 = await until(A.page, count(1), 8000);
      check("A, reloaded, has no card", same(labels(a2), ["bravo"]), labels(a2).join(", "));
      const rec = (await history()).find((r) => r.id === died.id);
      check("history kept the failure AND that it was dismissed", rec?.endReason === "failed" && Boolean(rec.dismissedAt), `${rec?.endReason} / ${rec?.dismissedAt}`);
      await A.ctx.close();
      await B.ctx.close();
    }
  }

  // ---------------------------------------------------------------------------
  if (section("S4  a workspace is one window, however many devices are watching")) {
    await reset();
    await spawnIn("bravo");
    const A = await open(browser);
    const B = await open(browser);
    await until(A.page, count(1));
    await until(B.page, count(1));
    await settled();

    // The real gesture: the palette's pinned row, which is `spawnWorkspace`.
    await A.page.locator(".controls button.new").click();
    await A.page.waitForSelector(".palette", { timeout: 5000 });
    await A.page.locator(".palette .row.pinrow").filter({ hasText: "Workspace" }).click();
    const a = await until(A.page, (ws) => ws.some((w) => w.workspace), 15_000);
    check("A shows the workspace as one window with two panes", a.length === 2 && a.filter((w) => w.workspace).length === 1, labels(a).join(", "));
    const sessions = await listed();
    const pair = sessions.filter((s) => s.cwd === os.homedir());
    check("the daemon holds its two PTYs", pair.length === 2, `${pair.length}`);
    const shellSession = pair.find((s) => s.command === "shell");
    check("…and says which is the zsh's agent", Boolean(shellSession?.companionOf) && pair.some((s) => s.id === shellSession?.companionOf), `companionOf=${shellSession?.companionOf}`);

    // B never heard of it. Its poll finds two new PTYs and has to decide how many
    // windows they are.
    await until(B.page, (ws) => ws.length >= 2, NOTICE_MS);
    await sleep(4000); // past a full poll, so a second window would have arrived
    const b1 = await desk(B.page);
    check("B, told nothing, shows ONE window for the workspace", b1.filter((w) => w.repo === HOME).length === 1, labels(b1).join(", "));
    check("…a workspace, with its zsh in it", b1.some((w) => w.workspace), labels(b1).join(", "));
    await provokeWrite(B.page, "bravo");
    const ids = await settled();
    check("the saved desk has two windows (bravo + the workspace)", ids.length === 2, `${ids.length}`);

    await reload(A.page);
    await until(A.page, (ws) => ws.some((w) => w.workspace && w.terms >= 2), 10_000);
    await sleep(4000); // past a full poll, so a stray second window would have arrived
    const a3 = await desk(A.page);
    check("A, reloaded, still has two windows — not three, not four", a3.length === 2, labels(a3).join(", "));
    check("…and the workspace is a workspace with both panes", a3.some((w) => w.workspace && w.terms >= 2), a3.map((w) => `${label(w)}×${w.terms}`).join(", "));
    check("both PTYs are still alive", (await listed()).length === 3);
    await A.ctx.close();
    await B.ctx.close();
  }

  // ---------------------------------------------------------------------------
  if (section("S5  a desk already split into two windows is put back together")) {
    await reset();
    const agent = await spawnIn("wsagent", { command: "claude", args: [] });
    const zsh = await spawnIn("wsagent", { companionOf: agent.id });
    const bravo = await spawnIn("bravo");
    // Exactly what an old browser saved: the agent as a bare terminal, the zsh as
    // a window of its own — the state the ticket's four workspaces were in.
    await seedDesk("float", [
      seededWindow(agent.id, "wsagent", { type: "agent", title: "claude-code", x: 60, y: 60 }),
      seededWindow(zsh.id, "wsagent", { title: "shell", x: 200, y: 140, z: 2 }),
      seededWindow(bravo.id, "bravo", { x: 340, y: 220, z: 3 }),
    ]);
    const C = await open(browser);
    await until(C.page, (w) => w.length === 2 && w.some((x) => x.workspace), NOTICE_MS);
    await sleep(4000); // past a full poll
    const now = await desk(C.page);
    check("the pair is one window again", now.filter((w) => w.repo === "wsagent").length === 1, labels(now).join(", "));
    const ws = now.find((w) => w.repo === "wsagent");
    check("…a workspace", Boolean(ws?.workspace), labels(now).join(", "));
    // A repair, not a spawn: the window stays where the agent's was. `.desk` is
    // the origin the saved x/y are relative to.
    const origin = await C.page.$eval(".desk", (e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    check(
      "…in the place the agent's window had, at the size it had",
      Boolean(ws) && Math.abs(ws!.x - (origin.x + 60)) <= 3 && Math.abs(ws!.y - (origin.y + 60)) <= 3 && Math.abs(ws!.w - 632) <= 3,
      ws ? `${ws.w}×${ws.h} at ${ws.x - origin.x},${ws.y - origin.y}` : "(no window)",
    );
    await settled();
    const ids = await savedIds();
    check("and the repair was saved", ids.length === 2 && !ids.includes(zsh.id), `${ids.length} saved`);
    check("the zsh was not killed to do it", (await listed()).some((s) => s.id === zsh.id && s.status === "running"));
    await C.ctx.close();
  }

  // ---------------------------------------------------------------------------
  if (section("S6  the same windows, the same count, the same layout")) {
    await reset();
    await spawnIn("bravo");
    await spawnIn("charlie", { command: "claude", args: [] });
    await spawnIn("echo", { args: ["-c", "exit 0"] });
    const A = await open(browser);
    await until(A.page, count(3));
    await A.page.locator(".controls button.new").click();
    await A.page.waitForSelector(".palette", { timeout: 5000 });
    await A.page.locator(".palette .row.pinrow").filter({ hasText: "Workspace" }).click();
    await until(A.page, (ws) => ws.length === 4 && ws.some((w) => w.workspace), 15_000);
    await A.page.locator(".switcher button").filter({ hasText: /tile/i }).click();
    await sleep(SETTLE_MS * 2);
    const before = await desk(A.page);
    const modeBefore = await savedLayout();
    check("tile is what the daemon was told", modeBefore === "tile", modeBefore);

    await reload(A.page);
    await until(A.page, count(4), 10_000);
    await sleep(SETTLE_MS * 2);
    const after = await desk(A.page);
    check("the same four windows come back", same(labels(after), labels(before)), `${labels(before).join(", ")} → ${labels(after).join(", ")}`);
    check("…in tile", (await savedLayout()) === "tile");
    const moved = before.filter((b) => {
      const a = after.find((x) => x.repo === b.repo);
      return !a || Math.abs(a.x - b.x) > 3 || Math.abs(a.y - b.y) > 3 || Math.abs(a.w - b.w) > 3 || Math.abs(a.h - b.h) > 3;
    });
    check("…each at the rect it had", moved.length === 0, moved.map((m) => m.repo).join(", "));
    check("nothing was drawn as a card", !after.some((w) => w.tomb));
    check("the daemon still holds every PTY", (await listed()).length === 5, `${(await listed()).length}`);
    await A.ctx.close();
  }

  // ---------------------------------------------------------------------------
  if (section("S7  a restored pane renders cleanly, whatever width it comes back at")) {
    let haveZsh = true;
    try {
      execFileSync("zsh", ["--version"], { stdio: "pipe" });
    } catch {
      haveZsh = false;
    }
    if (!haveZsh) {
      console.log("  skipped — needs zsh: it is the shell whose redraw this measures");
    } else {
      // A prompt that does what powerlevel10k does to a replay: two lines, colour,
      // a right-hand segment, and a redraw when the terminal changes size.
      const zdot = "/tmp/dry101-zdot";
      fs.mkdirSync(zdot, { recursive: true });
      fs.writeFileSync(
        path.join(zdot, ".zshrc"),
        "PROMPT=$'%F{blue}%~%f %F{240}on main%f\\n%F{green}❯%f '\nRPROMPT='%F{green}✓ at 1%f'\n",
      );

      /** Rows of the first terminal on the page, as the DOM renders them. */
      const rowsOf = (page: Page): Promise<string[]> =>
        page.$$eval(".xterm-rows > div", (els) =>
          els.map((e) => (e.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+$/, "")),
        );
      /**
       * Dirt, counted. A stray `%` line is zsh's end-of-line mark, printed when it
       * redraws a prompt somewhere it was not expecting to be; a prompt line twice
       * running is a redraw that failed to erase the one before it; and a `✓`
       * glued to the next command is a right-hand segment written over text. A
       * `✓ at 1` that merely WRAPPED onto its own line is ordinary reflow and is
       * not dirt.
       */
      const dirt = (rows: string[]): number => {
        const used = rows.filter((l) => l.length);
        let n = used.filter((l) => /^%\s*$/.test(l)).length;
        n += used.filter((l, i) => i > 0 && /on main$/.test(l) && l === used[i - 1]).length;
        n += used.filter((l) => /✓\S/.test(l)).length;
        return n;
      };

      /**
       * One recording width, one restore width, a fresh session each time.
       *
       * The width that matters is the WINDOW's, so it is set in the saved desk —
       * which is exactly what a workspace's pane becoming a standalone window did
       * to the ticket's four, and what a browser reopened at another size does in
       * Tile. The count reported is what the RESTORE added: the first prompt is
       * drawn at 80 columns and redrawn at the pane's own width, so some of this
       * is zsh's and is already on the live screen before anything is replayed.
       */
      const restoreAdds = async (recorded: number, restored: number): Promise<{ live: number; added: number }> => {
        await reset();
        const z = await spawn({
          command: "/usr/bin/zsh",
          args: ["-i"],
          cwd: path.join(CWDS, "alpha"),
          env: { ZDOTDIR: zdot },
        });
        const win = (w: number) => [seededWindow(z.id, "alpha", { title: "zsh", w })];
        await seedDesk("float", win(recorded));
        const D = await open(browser);
        await D.page.waitForSelector(".xterm-rows", { timeout: 20_000 });
        await sleep(2500);
        await D.page.click(".xterm");
        for (const cmd of ["echo one", "echo two", "ls /tmp | head -3", "echo four"]) {
          await D.page.keyboard.type(cmd);
          await D.page.keyboard.press("Enter");
          await sleep(450);
        }
        await sleep(800);
        const live = dirt(await rowsOf(D.page));
        await settled();
        await seedDesk("float", win(restored));
        await reload(D.page);
        await D.page.waitForSelector(".xterm-rows", { timeout: 20_000 });
        await sleep(3500);
        const after = dirt(await rowsOf(D.page));
        await D.ctx.close();
        return { live, added: Math.max(0, after - live) };
      };

      for (const [from, to] of [
        [1000, 420],
        [1000, 632],
      ] as const) {
        const r = await restoreAdds(from, to);
        check(
          `a ${from}px window restored at ${to}px adds no stacked prompts or stray glyphs`,
          r.added === 0,
          `${r.added} added on top of ${r.live} the live pane already had`,
        );
      }

      // The guard that holds fits off while a replay is parsed is released by the
      // write's callback. A session that has printed NOTHING replays an empty
      // string, and if xterm never called back for one the pane would sit at the
      // recorded size for good — a window that never fits, which nothing else here
      // would notice, since every other check counts windows and not columns.
      await reset();
      const quiet = await spawnIn("alpha");
      await seedDesk("float", [seededWindow(quiet.id, "alpha", { title: "quiet", w: 1000 })]);
      const Q = await open(browser);
      await Q.page.waitForSelector(".xterm-rows", { timeout: 20_000 });
      await sleep(3000);
      const fitted = await Q.page.$eval(".xterm-rows", (e) => Math.round(e.getBoundingClientRect().width));
      // 80 columns is 608px and a 1000px window's pane is ~976px.
      check("a pane with an empty replay still fits its window", fitted > 900, `${fitted}px wide`);
      await Q.ctx.close();

      // The half a page cannot vouch for: the daemon says what size the bytes were
      // drawn at, on the very frame that carries them.
      await reset();
      const probe = await spawnIn("alpha");
      await sleep(800);
      const first = await new Promise<{ type?: string; cols?: number; rows?: number; data?: string }>((resolve, reject) => {
        const ws = new WebSocket(`${DAEMON.replace(/^http/, "ws")}/api/sessions/${probe.id}/attach`);
        const timer = setTimeout(() => reject(new Error("no replay frame")), 8000);
        ws.onmessage = (ev) => {
          clearTimeout(timer);
          ws.close();
          resolve(JSON.parse(String(ev.data)));
        };
        ws.onerror = () => reject(new Error("attach failed"));
      });
      check(
        "the replay frame carries the size the PTY is at",
        first.type === "replay" && Number.isInteger(first.cols) && Number.isInteger(first.rows),
        `${first.type} ${first.cols}x${first.rows}`,
      );
    }
  }
} finally {
  await browser.close();
}

console.log(`\n${failures ? "FAILED" : "OK"}: ${failures} of ${ran} checks failed`);
process.exit(failures ? 1 : 0);
