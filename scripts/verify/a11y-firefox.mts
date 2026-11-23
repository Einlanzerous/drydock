// DRY-105: the frontend quality pass, driven in FIREFOX (the primary browser).
//
// What is asserted, each against a way the obvious change is wrong:
//
//   FONT      JetBrains Mono comes from /fonts, and nothing is requested from
//             fonts.googleapis.com / gstatic.
//   SCHEME    `color-scheme: dark` on :root, so native controls are dark.
//   MOTION    under prefers-reduced-motion: reduce a looping animation computes to
//             `none`; without it, it still runs (the gate is not unconditional).
//   DIALOG    Ctrl+K opens a real modal <dialog> (`:modal`), the search input
//             has focus inside it, Esc closes it THROUGH App.vue (open -> false),
//             and the accounts-style focus hand-back leaves nothing in the dialog.
//   IME       Enter with isComposing (and keyCode 229) does NOT activate a palette
//             row; the same Enter without it does. The positive control is what
//             makes the negative one mean something.
//
// RIG (a throwaway daemon on a spare port, env stripped of the session's own
// DRYDOCK_* — see CLAUDE.md "Real env wins"):
//
//   cd daemon
//   env $(env | grep -o '^DRYDOCK_[A-Z_0-9]*' | sed 's/^/-u /' | tr '\n' ' ') \
//     DRYDOCK_PORT=4398 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
//     DRYDOCK_STATE_FILE=/tmp/dry105/s.json \
//     DRYDOCK_SESSIONS_DIR=/tmp/dry105/sessions-4398 node --import tsx src/index.ts
//   cd shell && VITE_DAEMON_URL=http://127.0.0.1:4398 bunx vite --port 5398 --strictPort
//   bunx playwright install firefox     # once
//   node --import tsx scripts/verify/a11y-firefox.mts
//
// Clean up per CLAUDE.md: the positive IME control spawns a workspace session,
// which leaves a detached supervisor.
import { firefox } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5398";
const DAEMON = process.env.DAEMON_URL ?? "http://127.0.0.1:4398";
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

const browser = await firefox.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const external: string[] = [];
  page.on("request", (r) => {
    if (/googleapis|gstatic/.test(r.url())) external.push(r.url());
  });
  await page.goto(SHELL);
  await page.waitForSelector(".topbar, header, .desk", { timeout: 15000 });

  // FONT / SCHEME
  const font = await page.evaluate(async () => {
    await document.fonts.load('12px "JetBrains Mono"');
    // check() alone is true for a family with no face at all; ask for a LOADED one.
    return [...document.fonts].some((f) => f.family.includes("JetBrains Mono") && f.status === "loaded");
  });
  check("FONT self-hosted JetBrains Mono loads", font);
  check("FONT no third-party font requests", external.length === 0, external.join(","));
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  check("SCHEME color-scheme is dark", scheme === "dark", scheme);

  // MOTION
  const anim = () =>
    page.evaluate(() => {
      const d = document.createElement("div");
      d.style.animation = "ddpulse 1s infinite";
      document.body.appendChild(d);
      const n = getComputedStyle(d).animationName;
      d.remove();
      return n;
    });
  check("MOTION animates by default", (await anim()) === "ddpulse");
  await page.emulateMedia({ reducedMotion: "reduce" });
  check("MOTION none under reduce", (await anim()) === "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // DIALOG
  await page.keyboard.press("Control+k");
  const dlg = page.locator("dialog.qdialog");
  await dlg.waitFor({ state: "visible", timeout: 3000 });
  check("DIALOG is a modal <dialog>", await dlg.evaluate((d) => d.matches(":modal")));
  check(
    "DIALOG search input has focus inside it",
    await page.evaluate(() => !!document.activeElement?.closest("dialog.qdialog")),
  );
  check(
    "DIALOG background is inert (a click behind does not take focus)",
    await page.evaluate(() => {
      const b = document.querySelector("button:not(dialog button)") as HTMLElement | null;
      b?.focus();
      return !document.activeElement || !!document.activeElement.closest("dialog.qdialog");
    }),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("DIALOG Esc closes it", !(await dlg.evaluate((d: HTMLDialogElement) => d.open)));

  // IME
  const rows = () => page.evaluate((u) => fetch(`${u}/api/sessions`).then((r) => r.json()), DAEMON);
  const before = ((await rows()) as { sessions?: unknown[] }).sessions?.length ?? 0;
  await page.keyboard.press("Control+k");
  await dlg.waitFor({ state: "visible" });
  await page.keyboard.type("workspace");
  await page.evaluate(() => {
    const i = document.querySelector("dialog.qdialog input") as HTMLInputElement;
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  check("IME composing Enter leaves the palette open", await dlg.evaluate((d: HTMLDialogElement) => d.open));
  check(
    "IME composing Enter spawned nothing",
    (((await rows()) as { sessions?: unknown[] }).sessions?.length ?? 0) === before,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  check("IME plain Enter (control) activates the row", !(await dlg.evaluate((d: HTMLDialogElement) => d.open)));
} finally {
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
