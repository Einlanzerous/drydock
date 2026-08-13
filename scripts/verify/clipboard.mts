// DRY-71: the terminal's clipboard keystrokes.
//
// Why a browser. Every claim here is "what did the browser do with this key
// combination", which lives entirely between Chromium's editing-command table,
// xterm's keymap and the pane's custom handler. The daemon sees only the
// result — bytes on a PTY — and cannot tell a paste from somebody typing fast,
// so curl is structurally blind to all of it.
//
// Why it asserts on the PTY's echo rather than on a JS event. A `paste` event
// the harness dispatches itself proves xterm's listener works, which was never
// in doubt; the bug is that the listener is unreachable, because xterm's keymap
// calls preventDefault() first. So the keys are pressed for real
// (`page.keyboard`, which goes through Chromium's input pipeline and therefore
// through its editing-command table) and the assertion is on characters
// arriving in the terminal's rows, which only a real paste could have put
// there.
//
// Why `navigator.clipboard` is taken away from the page. The ticket's central
// constraint is that the fix must use clipboard EVENTS, because prod is served
// over plain HTTP (docs/deploy.md) where `navigator.clipboard` is simply
// absent. A harness on 127.0.0.1 is a secure context, so a fix written against
// that API would pass here and do nothing in prod — the worst possible split.
// `addInitScript` therefore stashes the real object on `window.__clip` (the
// harness's own seeding and reading go through it) and leaves the page a
// throwing stub, so a reach for it is a failure here rather than a surprise on
// the prod box.
//
// Setup + overrides: see README.md. Run from `daemon/` like the other .mts
// harnesses, so tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/clipboard.mts)
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";

const SHELL = process.env.SHELL_URL ?? "http://127.0.0.1:5379";
const API = process.env.API_URL ?? "http://127.0.0.1:4379";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds waited, or null on timeout — so a caller can report which it was. */
async function waitFor(fn: () => Promise<boolean>, ms = 20_000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(150);
  }
  return null;
}

type Spawned = { session: { id: string } };
const spawned: string[] = [];

/**
 * Spawn a pane, identified by its working directory.
 *
 * By cwd because that is the only thing about a spawn the desk renders that the
 * caller controls: a window's title comes from the COMMAND (`App.vue`'s
 * reconcile), so the session `title` in the POST body never reaches the bar and
 * three `/bin/sh` panes are indistinguishable there.
 */
async function spawnPane(dir: string, args: string[]): Promise<void> {
  // Created here rather than asked for in the README, because getting it wrong
  // is silent and looks like a product bug: the daemon records the cwd it was
  // given, so the frame still renders `~/<dir>` and the pane still attaches —
  // the PTY just dies on the spot, and every keystroke afterwards appears to
  // vanish into a working terminal. (Cost an hour once, to the author.)
  mkdirSync(`/tmp/${dir}`, { recursive: true });
  const r = await fetch(`${API}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args, cwd: `/tmp/${dir}` }),
  });
  if (!r.ok) throw new Error(`spawn failed: ${r.status} ${await r.text()}`);
  spawned.push(((await r.json()) as Spawned).session.id);
}

/**
 * A shell that makes what the browser sent VISIBLE.
 *
 * `stty lnext undef` is load-bearing: without it a ^V reaching the tty is eaten
 * by the line discipline's literal-next and echoes nothing, so the SYN this
 * ticket is named for is invisible at the only surface the harness can see —
 * and a harness that cannot see the symptom cannot prove it is gone (or, as
 * here, that it is deliberately still there). `cat` then echoes each line back,
 * so a paste shows up twice; the checks are substring tests for that reason.
 */
const echoPane = (dir: string): Promise<void> =>
  spawnPane(dir, ["-c", "stty lnext undef; cat"]);

const kill = (id: string): Promise<unknown> =>
  fetch(`${API}/api/sessions/${id}/kill`, { method: "POST" }).catch(() => undefined);

/**
 * Every `page.evaluate` body in this file is a STRING, not a function — the
 * same constraint `auth.mts` and `backlog-toggle.mts` document at length.
 * `tsx`'s esbuild transform wraps named functions in a `__name(...)` helper
 * (keepNames), and Playwright ships an evaluate body to the browser as SOURCE,
 * where that helper does not exist. It fails as `ReferenceError: __name is not
 * defined` from inside the page, pointing at a line that reads perfectly well.
 * Strings aren't transformed, so they cross intact.
 */
function evalIn<T>(page: Page, js: string, fallback: T): Promise<T> {
  return page.evaluate(js).then((v) => (v as T) ?? fallback, () => fallback);
}

/**
 * One window, addressed by the working directory it was spawned in.
 *
 * Never `.nth(0)` / `.last()`: window order on the desk is the cascade's, not
 * the spawn's, and a check that drives the wrong pane fails for a reason with
 * nothing to do with the clipboard. Matched on the frame's `~/<dir>` chip
 * exactly, not by prefix — these three names share one.
 */
const FRAME_JS = (dir: string) => `(() => {
  for (const f of document.querySelectorAll(".frame")) {
    const repo = f.querySelector(".bar .repo");
    if (repo && repo.textContent === "~/" + ${JSON.stringify(dir)}) return f;
  }
  return null;
})()`;

const rowsOf = (page: Page, dir: string): Promise<string> =>
  evalIn(
    page,
    `(() => { const f = ${FRAME_JS(dir)}; if (!f) return "";
      const r = f.querySelector(".xterm-rows"); return r ? r.textContent || "" : ""; })()`,
    "",
  );

/**
 * Attached to a LIVE PTY — not merely rendered, and not merely connected.
 *
 * `term.open()` runs on mount whatever the socket does, so an `.xterm` element
 * on screen says nothing about whether a keystroke would reach a PTY. The
 * pane's own "reconnecting…" badge being gone says the WebSocket is up; DRY-41's
 * exit banner being absent says there is still something on the other end of
 * it. Both, because a pane bound to a dead PTY is attached, silent, and
 * indistinguishable from a clipboard that stopped working.
 */
const attached = (page: Page, dir: string): Promise<boolean> =>
  evalIn(
    page,
    `(() => { const f = ${FRAME_JS(dir)};
      return !!f && !!f.querySelector(".xterm-rows")
        && !f.querySelector(".detached") && !f.querySelector(".exited"); })()`,
    false,
  );

/**
 * Focus one pane's terminal.
 *
 * Straight at the helper textarea rather than by clicking the pane: windows
 * cascade and overlap, so a click aimed at a covered pane lands on the one on
 * top — and every keystroke after it would be measured against the wrong PTY.
 */
const focusPane = (page: Page, dir: string): Promise<boolean> =>
  evalIn(
    page,
    `(() => { const f = ${FRAME_JS(dir)}; if (!f) return false;
      const t = f.querySelector(".xterm-helper-textarea"); if (!t) return false;
      t.focus(); return document.activeElement === t; })()`,
    false,
  );

/** The harness's own clipboard, held out of the page's reach (see the header). */
const clipRead = (page: Page): Promise<string> => evalIn(page, `window.__clip.readText()`, "");
const clipWrite = (page: Page, text: string): Promise<unknown> =>
  page.evaluate(`window.__clip.writeText(${JSON.stringify(text)})`);

/**
 * Did the page reach for `navigator.clipboard`?
 *
 * Deliberately NOT through `evalIn`: its rejection handler returns the fallback,
 * and the fallback for "which calls happened" is the empty list — so any
 * evaluation error at all would report the constraint as HELD. This check
 * guards the one claim that decides whether the feature works in prod, so it
 * fails closed: an error becomes a marker no assertion can mistake for silence.
 */
const clipReached = (page: Page): Promise<string[]> =>
  page.evaluate(`window.__clipReached`).then(
    (v) => (Array.isArray(v) ? (v as string[]) : ["<the probe itself is missing>"]),
    (e) => [`<could not read the probe: ${e}>`],
  );

const INIT_JS = `(() => {
  Object.defineProperty(window, "__clip", { value: navigator.clipboard });
  window.__clipReached = [];
  const trap = () => {
    // What a plain-HTTP origin actually does: the property is undefined, so the
    // call throws. A rejected promise instead would let a fix written against
    // this API look like it merely "failed once".
    throw new TypeError("navigator.clipboard is unavailable on this origin");
  };
  Object.defineProperty(Navigator.prototype, "clipboard", {
    configurable: true,
    get() {
      window.__clipReached.push("navigator.clipboard");
      return { readText: trap, writeText: trap, read: trap, write: trap };
    },
  });
})()`;

/**
 * Select `token` by double-clicking it.
 *
 * The point is measured with a DOM Range over the token's own characters rather
 * than computed from the configured font size: xterm's cell width is whatever
 * font actually loaded, so a harness that arithmetics its way there selects a
 * neighbouring word on any host without the Nerd Font — and then reports a
 * clipboard bug that isn't one.
 */
async function selectWord(page: Page, dir: string, token: string): Promise<boolean> {
  const at = await evalIn<{ x: number; y: number } | null>(
    page,
    `(() => {
      const f = ${FRAME_JS(dir)};
      const host = f && f.querySelector(".xterm-rows");
      if (!host) return null;
      const token = ${JSON.stringify(token)};
      const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.data.indexOf(token);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + token.length);
        const box = r.getBoundingClientRect();
        if (!box.width) continue;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      return null;
    })()`,
    null,
  );
  if (!at) return false;
  await page.mouse.dblclick(at.x, at.y);
  await sleep(250);
  // Confirmed, not assumed from the click landing. A terminal selection is
  // DRAWN rather than a DOM range — `window.getSelection()` is empty for it —
  // so the evidence is xterm's own `.xterm-selection` overlay having something
  // in it. Without this, "the clipboard is empty" cannot be told apart from
  // "nothing was selected to copy", and the copy checks below would report a
  // bug that isn't one.
  return evalIn(
    page,
    `(() => { const f = ${FRAME_JS(dir)};
      const s = f && f.querySelector(".xterm-selection");
      return !!s && s.childElementCount > 0; })()`,
    false,
  );
}

/**
 * A precondition, not a claim.
 *
 * Silent when it holds, because it is scaffolding rather than a result; loud and
 * NAMED when it doesn't. The alternative — discarding these booleans — makes a
 * focus that landed on the wrong element or a double-click that selected nothing
 * present as an empty clipboard, i.e. as a bug in the code under test.
 */
async function must(what: string, ok: boolean | Promise<boolean>): Promise<boolean> {
  const held = await ok;
  if (!held) check(`PRECONDITION ${what}`, false);
  return held;
}

/** Put `token` on screen in a pane, by typing it. Also proves input reaches the PTY. */
async function typeToken(page: Page, dir: string, token: string): Promise<number | null> {
  await must(`focus ${dir}`, focusPane(page, dir));
  await page.keyboard.type(token);
  await page.keyboard.press("Enter");
  return waitFor(async () => (await rowsOf(page, dir)).includes(token), 8_000);
}

const ALPHA = "dry71-alpha";
const BRAVO = "dry71-bravo";
const INTPANE = "dry71-interrupt";
const WINPANE = "dry71-notlinux";
const STUBPANE = "dry71-refuses";
const TOKEN = "COPYME71"; // no word separators, so xterm's double-click takes exactly this

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(INIT_JS);
  const page = await ctx.newPage();

  try {
    await page.goto(SHELL, { waitUntil: "domcontentloaded" });

    // --------------------------------------------------------------- (a) paste
    console.log("\n(a) pasting into a pane");
    await echoPane(ALPHA);
    const up = await waitFor(() => attached(page, ALPHA));
    check("the pane is attached to a live PTY", up !== null, `after ${up}s`);

    // Ctrl+Shift+V. Chromium maps it to PasteAndMatchStyle on Linux/Windows,
    // which fires a `paste` event on the focused textarea — the event xterm
    // already listens for, and whose own keymap is the only thing in the way.
    const P1 = "PASTED-CTRLSHIFTV-71";
    await clipWrite(page, P1);
    await must(`focus ${ALPHA}`, focusPane(page, ALPHA));
    await page.keyboard.press("Control+Shift+V");
    const pasted = await waitFor(async () => (await rowsOf(page, ALPHA)).includes(P1), 6_000);
    check("Ctrl+Shift+V pastes the clipboard into the terminal", pasted !== null,
      pasted !== null ? `after ${pasted}s` : "clipboard text never reached the PTY");

    // Shift+Insert — undocumented before this ticket, and the only paste
    // keystroke that already worked. It has to survive the fix: a custom key
    // handler is exactly the thing that swallows it by accident.
    const P2 = "PASTED-SHIFTINSERT-71";
    await clipWrite(page, P2);
    await must(`focus ${ALPHA}`, focusPane(page, ALPHA));
    await page.keyboard.press("Shift+Insert");
    const pasted2 = await waitFor(async () => (await rowsOf(page, ALPHA)).includes(P2), 6_000);
    check("Shift+Insert still pastes", pasted2 !== null,
      pasted2 !== null ? `after ${pasted2}s` : "clipboard text never reached the PTY");

    // Ctrl+V is left alone ON PURPOSE, and this asserts that positively. It is
    // readline's literal-next and the tty's `lnext`, so rebinding it to paste
    // takes a working key away from anyone with the muscle memory — the same
    // line every Linux terminal draws. "^V" echoed in the rows is the SYN
    // arriving at the PTY.
    await must(`focus ${ALPHA}`, focusPane(page, ALPHA));
    await page.keyboard.press("Control+v");
    const syn = await waitFor(async () => (await rowsOf(page, ALPHA)).includes("^V"), 5_000);
    check("Ctrl+V still sends SYN (literal-next), unclaimed by paste", syn !== null,
      syn !== null ? `after ${syn}s` : "no ^V echoed");
    await page.keyboard.press("Enter"); // flush the line, so later echoes start clean

    // --------------------------------------------------------------- (b) copy
    console.log("\n(b) copying a selection out of a pane");
    const echoed = await typeToken(page, ALPHA, TOKEN);
    check("a token to copy is on screen", echoed !== null, `after ${echoed}s`);

    check("double-click selects the token", await selectWord(page, ALPHA, TOKEN));
    await clipWrite(page, "CLIPBOARD-UNTOUCHED");
    await page.keyboard.press("Control+Insert");
    await sleep(400);
    let clip = await clipRead(page);
    check("Ctrl+Insert still copies", clip.includes(TOKEN), JSON.stringify(clip));

    await must("re-select the token", selectWord(page, ALPHA, TOKEN));
    await clipWrite(page, "CLIPBOARD-UNTOUCHED");
    await page.keyboard.press("Control+Shift+C");
    await sleep(400);
    clip = await clipRead(page);
    check("Ctrl+Shift+C copies the selection to the clipboard", clip.includes(TOKEN),
      JSON.stringify(clip));

    // ---------------------------------------------------------- (c) both ways
    console.log("\n(c) the round trip, between two panes");
    // Not implied by (a) and (b) passing separately: what `copy` writes and what
    // `paste` reads are different clipboard FORMATS, and a selection written as
    // text/html arrives at the PTY as markup. It is also the gesture the ticket
    // actually describes ("including between two Drydock windows").
    await echoPane(BRAVO);
    const up2 = await waitFor(() => attached(page, BRAVO));
    check("a second pane is attached", up2 !== null, `after ${up2}s`);
    await must(`focus ${BRAVO}`, focusPane(page, BRAVO));
    await page.keyboard.press("Control+Shift+V");
    const crossed = await waitFor(async () => (await rowsOf(page, BRAVO)).includes(TOKEN), 6_000);
    check("text copied in one pane pastes into another", crossed !== null,
      crossed !== null ? `after ${crossed}s` : "the token never reached the second PTY");

    // ------------------------------------------------------------ (d) SIGINT
    console.log("\n(d) Ctrl+C is still an interrupt");
    // The trap is what makes this POSITIVE. "the process died" is also what a
    // pane whose socket dropped looks like; a line the shell can only have
    // printed because it received SIGINT is not.
    await spawnPane(INTPANE, ["-c", "trap 'echo GOTSIGINT' INT; while :; do sleep 0.2; done"]);
    const up3 = await waitFor(() => attached(page, INTPANE));
    check("the interrupt pane is attached", up3 !== null, `after ${up3}s`);
    await must(`focus ${INTPANE}`, focusPane(page, INTPANE));
    await page.keyboard.press("Control+c");
    const interrupted = await waitFor(
      async () => (await rowsOf(page, INTPANE)).includes("GOTSIGINT"),
      8_000,
    );
    check("Ctrl+C sends SIGINT rather than copying", interrupted !== null,
      interrupted !== null ? `after ${interrupted}s` : "the shell never trapped INT");

    // Ctrl+K, here rather than in a palette harness, because DRY-71 moved the
    // letter-matching out of `isPaletteChord` and into the `chordLetter` the
    // clipboard keys share with it. That refactor can only break one thing, and
    // this is it: the palette's chord is pressed from inside a terminal by
    // design (DRY-43), so nothing else on this desk would notice.
    await must(`focus ${INTPANE} again`, focusPane(page, INTPANE));
    await page.keyboard.press("Control+k");
    const palette = await waitFor(
      async () => (await evalIn(page, `!!document.querySelector(".palette")`, false)),
      5_000,
    );
    check("Ctrl+K still opens the palette from inside a pane", palette !== null,
      palette !== null ? `after ${palette}s` : "the palette never opened");
    await page.keyboard.press("Escape");
    await sleep(300);

    // ------------------------------------------------- (e) the prod constraint
    console.log("\n(e) the clipboard is reached through events, not navigator.clipboard");
    const reached = await clipReached(page);
    check("the shell never touched navigator.clipboard", reached.length === 0, reached.join(", "));

    // ------------------------------------------------------- (f) not on Linux
    console.log("\n(f) copying from a browser that is not on Linux");
    // The half a Linux box structurally cannot show you. xterm mirrors a MOUSE
    // selection into its helper textarea to feed X11's PRIMARY selection, and
    // that mirror is guarded by `Browser.isLinux` (SelectionService.refresh) —
    // so on this host a real DOM selection is always lying about, and
    // `queryCommandEnabled("copy")` is true for reasons that have nothing to do
    // with the terminal. On Windows there is none and it is false. A copy that
    // turned out to need it would pass every check above and do nothing on half
    // the platforms in the ticket's title.
    //
    // `navigator.platform` is where xterm reads that from, and an init script
    // gets in before its module ever evaluates. Chromium's own editing-command
    // table is left alone, which is right: Ctrl+Insert is Copy on Windows too.
    // What changes is the one thing that actually differs between the two —
    // whether there is a DOM selection for the command to find.
    const win = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    await win.addInitScript(INIT_JS);
    await win.addInitScript(
      `Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" })`,
    );
    const winPage = await win.newPage();
    await winPage.goto(SHELL, { waitUntil: "domcontentloaded" });
    check("the shell agrees it is not on Linux",
      (await evalIn(winPage, `navigator.platform`, "")) === "Win32");

    await echoPane(WINPANE);
    const up4 = await waitFor(() => attached(winPage, WINPANE));
    check("a pane is attached in that browser", up4 !== null, `after ${up4}s`);
    const wEchoed = await typeToken(winPage, WINPANE, TOKEN);
    check("a token to copy is on screen there too", wEchoed !== null, `after ${wEchoed}s`);
    await must("select the token (not on Linux)", selectWord(winPage, WINPANE, TOKEN));

    // The proof that this run measures something the Linux one cannot, and it
    // asserts on the MIRROR rather than on a symptom of it. `window
    // .getSelection()` alone would be a bad witness: whether a textarea's
    // selection shows up there is a browser-version detail, so a check built on
    // it can report "no selection" for the wrong reason and pass either way.
    // The mirror IS `textarea.value` + a selection range over it, so that is
    // what gets read — plus `queryCommandEnabled("copy")`, which is the thing
    // the fallback in `copySelection` exists for and which flips with it.
    const mirror = await evalIn(
      winPage,
      `(() => { const t = document.querySelector(".xterm-helper-textarea");
        return { value: t.value, from: t.selectionStart, to: t.selectionEnd,
                 doc: String(window.getSelection() || ""),
                 enabled: document.queryCommandEnabled("copy") }; })()`,
      null as null | { value: string; from: number; to: number; doc: string; enabled: boolean },
    );
    check("xterm's Linux selection mirror is genuinely absent",
      !!mirror && mirror.value === "" && mirror.from === mirror.to && mirror.doc === "",
      JSON.stringify(mirror));
    check("so the copy command reports itself DISABLED, as it does on Windows",
      !!mirror && mirror.enabled === false, JSON.stringify(mirror?.enabled));

    await clipWrite(winPage, "CLIPBOARD-UNTOUCHED");
    await winPage.keyboard.press("Control+Shift+C");
    await sleep(400);
    let wClip = await clipRead(winPage);
    check("Ctrl+Shift+C copies anyway", wClip.includes(TOKEN), JSON.stringify(wClip));

    // Ctrl+Insert is the browser's, not the pane's — deliberately. It reaches
    // xterm's `copy` listener on its own even here (measured, which is why the
    // pane doesn't claim it), so intercepting it would be a line of code that
    // changes nothing while reading like the fix.
    await must("re-select the token (not on Linux)", selectWord(winPage, WINPANE, TOKEN));
    await clipWrite(winPage, "CLIPBOARD-UNTOUCHED");
    await winPage.keyboard.press("Control+Insert");
    await sleep(400);
    wClip = await clipRead(winPage);
    check("Ctrl+Insert copies too, unclaimed by the pane", wClip.includes(TOKEN),
      JSON.stringify(wClip));

    // ------------------------------------------- (g) the fallback, exercised --
    console.log("\n(g) the copy still lands when execCommand refuses");
    // `copySelection` reads `execCommand`'s boolean and, on false, retries with
    // an off-screen textarea holding the text — a selection the command cannot
    // refuse. Every browser measured returns true, so nothing above this ever
    // reaches that branch, and an untested fallback for a SILENT failure is
    // worse than none: it would rot unnoticed and be there for exactly the
    // browser nobody tried.
    //
    // So this is the browser it is for, built to order: `execCommand` is stubbed
    // to refuse — returning false without copying — while the DOM has no
    // selection of its own, and to work normally once something is selected.
    // That is precisely the "command disabled" behaviour the branch guards
    // against. Without the fallback nothing reaches the clipboard at all.
    const stub = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    await stub.addInitScript(INIT_JS);
    await stub.addInitScript(`(() => {
      const real = document.execCommand.bind(document);
      // Driven by an explicit counter the harness sets, NOT by inspecting the
      // selection: on this Linux host xterm's mirror keeps handing the bare
      // attempt a selection, so a stub that refuses "when nothing is selected"
      // never refuses, the fallback is never reached, and the section passes
      // while testing nothing. Refusing the FIRST attempt is also the honest
      // model — a disabled command returns false and copies nothing.
      window.__refuseCopies = 0;
      window.__refusals = 0;
      document.execCommand = (cmd, ...rest) => {
        if (cmd === "copy" && window.__refuseCopies > 0) {
          window.__refuseCopies--;
          window.__refusals++;
          return false;
        }
        return real(cmd, ...rest);
      };
    })()`);
    const stubPage = await stub.newPage();
    await stubPage.goto(SHELL, { waitUntil: "domcontentloaded" });
    await echoPane(STUBPANE);
    const up5 = await waitFor(() => attached(stubPage, STUBPANE));
    check("a pane is attached in the refusing browser", up5 !== null, `after ${up5}s`);
    const sEchoed = await typeToken(stubPage, STUBPANE, TOKEN);
    check("a token to copy is on screen in the refusing browser", sEchoed !== null,
      `after ${sEchoed}s`);
    await must("select the token (refusing browser)", selectWord(stubPage, STUBPANE, TOKEN));
    // Exactly one refusal armed: the bare attempt is refused, the fallback's is
    // not. Two would refuse the fallback as well and prove only that a doubly
    // broken browser stays broken.
    await evalIn(stubPage,
      `(() => { window.__refuseCopies = 1; window.__refusals = 0; return true; })()`, false);

    await clipWrite(stubPage, "CLIPBOARD-UNTOUCHED");
    await stubPage.keyboard.press("Control+Shift+C");
    await sleep(400);
    const refusals = await evalIn(stubPage, `window.__refusals`, -1);
    check("the bare attempt really was refused", refusals === 1, `refusals=${refusals}`);
    const sClip = await clipRead(stubPage);
    check("the fallback puts the selection on the clipboard regardless",
      sClip.includes(TOKEN), JSON.stringify(sClip));
  } finally {
    for (const id of spawned) await kill(id);
    await browser.close();
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
