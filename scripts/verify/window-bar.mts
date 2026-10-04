// A window's bar says what it is with the dot's SHAPE, not a word (DRY-102).
//
// The bar used to open with `shell` / `workspace` / `claude-code` on every
// window. That word is gone; a plain shell's status dot is a square, anything
// with an agent in it is a circle, and the word survives as the dot's tooltip
// and as the rail's label for a docked window that has no ticket.
//
// What is asserted is what the browser DREW — the bar's text and the dot's
// computed radius — in all three layouts, because Float, Tile and Focus position
// the same frame three ways and a rule that holds in one says nothing of the
// others. The kind each window should be is taken from the DAEMON's command for
// that session, never from the DOM being checked.
//
// RIG (three terminals) — the same throwaway pair as desk-restore.mts, stub
// `claude` included, since the palette's `claude` and `workspace` rows spawn a
// bare `claude`:
//
//   mkdir -p /tmp/dry102-bin
//   printf '#!/bin/sh\nexec node --import %s/node_modules/tsx/dist/loader.mjs %s/scripts/verify/stub-cli.mts "$@"\n' \
//     "$PWD" "$PWD" > /tmp/dry102-bin/claude && chmod +x /tmp/dry102-bin/claude
//
//   (cd daemon && PATH="/tmp/dry102-bin:$PATH" \
//      DRYDOCK_PORT=4402 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d102 \
//      DRYDOCK_TRACKER=fixture DRYDOCK_CLEAR_FINISHED_AFTER_MS=0 \
//      DRYDOCK_STATE_FILE=/tmp/dry102-state.json \
//      node --import tsx src/index.ts &)
//   (cd shell && VITE_DAEMON_URL=http://127.0.0.1:4402 bunx vite --port 5402 --strictPort &)
//
//   (cd daemon && node --import tsx ../scripts/verify/window-bar.mts)
//   (cd daemon && SHOT=/tmp/dry102.png node --import tsx ../scripts/verify/window-bar.mts)
//
// It REFUSES :4317 and :4318: it kills every session the daemon has, to start
// from a clean desk, and those two are the ones that own real agents.
//
// ON `page.evaluate` BODIES (DRY-80): no body here may bind a NAME to a
// function — tsx's transform wraps those in a `__name(...)` helper the page does
// not have. Anonymous inline arrows cross intact.
//
// Afterwards, IN THIS ORDER: kill the supervisors it leaves behind (CLAUDE.md's
// loop over /proc/<pid>/exe, never `pkill -f supervisor/main`), and only then
// `rm -rf /tmp/d102 /tmp/dry102-*`.
import { chromium, type Page } from "playwright";
import type { Detail, SessionInfo, SessionsResponse } from "./api.mjs";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5402";
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4402";
const SHOT = process.env.SHOT;
/** The managed layouts animate (`all .26s`). */
const SETTLE_MS = 1000;

if (/:431[78]\b/.test(DAEMON)) {
  console.error(`refusing ${DAEMON}: this kills every session the daemon holds`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let ran = 0;
function check(name: string, ok: boolean, detail: Detail = ""): void {
  ran++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const listed = async (): Promise<SessionInfo[]> =>
  ((await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse).sessions;

interface Bar {
  /** Everything the bar prints. The two controls are SVG-only, so this is the labels. */
  text: string;
  hasTitle: boolean;
  tip: string;
  radius: string;
  workspace: boolean;
}

/** Every window's bar as the BROWSER draws it. */
const bars = (page: Page): Promise<Bar[]> =>
  page.$$eval(".frame", (els) =>
    els.map((e) => {
      const dot = e.querySelector(".bar .dot");
      return {
        text: (e.querySelector(".bar")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        hasTitle: !!e.querySelector(".bar .title"),
        tip: dot?.getAttribute("title") ?? "",
        radius: dot ? getComputedStyle(dot).borderTopLeftRadius : "",
        workspace: !!e.querySelector(".ws"),
      };
    }),
  );

async function pick(page: Page, row: string): Promise<void> {
  await page.click("button.new");
  await page.fill(".palette .search input", row);
  await page.click(".palette .row.pinrow");
  await sleep(1500);
}

const KIND_WORDS = /\b(shell|workspace|claude-code|claude|bash|zsh)\b/;

// --- the run -----------------------------------------------------------------

for (const s of await listed()) await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar");
  await sleep(4000); // past a poll, so windows of the sessions just killed are gone

  await pick(page, "shell");
  await pick(page, "claude");
  await pick(page, "workspace");
  await page.waitForFunction(() => document.querySelectorAll(".frame").length === 3, undefined, {
    timeout: 15_000,
  });

  // Ground truth for "what kinds are on the desk": the daemon's own commands.
  // One shell window, one agent, and a workspace whose zsh has no window.
  const sessions = await listed();
  const agents = sessions.filter((s) => s.command === "claude").length;
  check("the daemon holds two agents and two shells (one of them the workspace's)", agents === 2 && sessions.length === 4, `${agents} of ${sessions.length}`);

  for (const mode of ["Float", "Tile", "Focus"]) {
    console.log(`\n${mode}`);
    await page.click(`.switcher button:has-text("${mode}")`);
    await sleep(SETTLE_MS);
    const bs = await bars(page);
    check("three windows", bs.length === 3, `${bs.length}`);
    check("no bar has a title element", bs.every((b) => !b.hasTitle));
    check(
      "no bar prints a kind word",
      bs.every((b) => !KIND_WORDS.test(b.text)),
      bs.map((b) => JSON.stringify(b.text)).join(" "),
    );
    check("every bar still prints something to read", bs.every((b) => b.text.startsWith("~/")), bs.map((b) => b.text).join(" "));
    const shells = bs.filter((b) => b.tip === "shell");
    const round = bs.filter((b) => b.tip !== "shell");
    check("one window is the shell, and its dot is a square", shells.length === 1 && shells[0].radius === "2px", shells.map((b) => b.radius).join(" "));
    check(
      "the agent and the workspace have round dots",
      round.length === 2 && round.every((b) => b.radius === "50%"),
      round.map((b) => `${b.tip}:${b.radius}`).join(" "),
    );
    check(
      "the word survives as the dot's tooltip",
      bs.map((b) => b.tip).sort().join(",") === "claude-code,shell,workspace",
      bs.map((b) => b.tip).sort().join(","),
    );
    check("the workspace is the one whose tooltip says so", bs.find((b) => b.workspace)?.tip === "workspace");
    if (SHOT && mode === "Tile") await page.screenshot({ path: SHOT });
  }

  console.log("\nDocked");
  // Minimise the shell: with no ticket, its rail chip is labelled by the word
  // the bar dropped — which is why the word could leave the bar but not the model.
  await page.click('.switcher button:has-text("Tile")');
  await sleep(SETTLE_MS);
  const shellFrame = page.locator(".frame").filter({ has: page.locator('.bar .dot[title="shell"]') });
  await shellFrame.locator(".bar .ctl").first().click();
  await sleep(SETTLE_MS);
  const chip = await page.$$eval(".dock-item", (els) =>
    els.map((e) => {
      const dot = e.querySelector(".dot");
      return {
        label: e.querySelector(".dock-id")?.textContent?.trim() ?? "",
        radius: dot ? getComputedStyle(dot).borderTopLeftRadius : "",
      };
    }),
  );
  check("the docked shell has a chip", chip.length === 1, `${chip.length}`);
  check("…still labelled", chip[0]?.label === "shell", JSON.stringify(chip[0]?.label));
  check("…with the square it had on the desk", chip[0]?.radius === "2px", chip[0]?.radius);
  if (SHOT) await page.screenshot({ path: SHOT.replace(/\.png$/, "-docked.png") });
} finally {
  await browser.close();
  for (const s of await listed()) await fetch(`${DAEMON}/api/sessions/${s.id}/kill`, { method: "POST" });
}

console.log(`\n${failures ? "FAILED" : "OK"}: ${failures} of ${ran} checks failed`);
process.exit(failures ? 1 : 0);
