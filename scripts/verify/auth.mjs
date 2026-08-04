// DRY-27: the daemon has a door, and the desk is behind it.
//
// Why a browser and not curl: every claim here is about what the SHELL does
// with a 401, and curl proves none of them. `curl /api/sessions` returning 401
// is exactly the state a shell that ignores auth would also be in — it would
// render its desk, poll every three seconds, and show a red banner about the
// daemon being unreachable. The bug this file exists to catch is a desk that
// draws anyway.
//
// It also covers the two transports curl CANNOT stand in for. `EventSource` and
// the browser `WebSocket` constructor can't send an Authorization header, so
// both carry a short-lived `stream` token in the query string instead — a real
// browser is the only thing that exercises the path the shell actually takes,
// and "the gate stream connected" / "the terminal attached" are the only honest
// assertions that it works.
//
// Setup + overrides: see README.md.
import { chromium } from "playwright";

const SINGLE = process.env.SINGLE_SHELL ?? "http://127.0.0.1:5394";
const SINGLE_API = process.env.SINGLE_API ?? "http://127.0.0.1:4394";
const MULTI = process.env.MULTI_SHELL ?? "http://127.0.0.1:5393";
const MULTI_API = process.env.MULTI_API ?? "http://127.0.0.1:4393";
const OFF = process.env.OFF_SHELL ?? "http://127.0.0.1:5392";
const OFF_API = process.env.OFF_API ?? "http://127.0.0.1:4392";
/**
 * The two throwaway accounts' passwords, from the environment with NO defaults.
 *
 * Not hygiene theatre: a literal here is a password-shaped string in a checked-in
 * file, which every secret scanner is right to flag and which then needs an
 * exception that outlives whoever added it. Failing loudly with the export line
 * is a better trade than a default nobody should be using anyway — and it keeps
 * this file's copy of the rig from drifting from the README's.
 */
const PASSWORD = required("DRYDOCK_TEST_PASSWORD");
const PASSWORD_B = required("DRYDOCK_TEST_PASSWORD_B");

function required(name) {
  const value = process.env[name];
  if (!value || value.length < 8) {
    console.error(
      `${name} must be set to the password this rig's daemons were started with ` +
        `(8+ chars). See scripts/verify/README.md.`,
    );
    process.exit(2);
  }
  return value;
}

let failures = 0;
function check(name, ok, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `fn` holds. Fixed sleeps are what make a browser harness flaky:
 * a sign-in is a round trip plus a desk boot (auth info, tracker, workspace,
 * the first session poll), and any constant is either a stall or a race.
 */
async function waitFor(fn, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(150);
  }
  return null;
}

/** What is on screen: the door, the desk, or neither. */
function snap(page) {
  return page.evaluate(() => ({
    login: !!document.querySelector(".gate .card"),
    desk: !!document.querySelector(".topbar"),
    error: document.querySelector(".gate .error")?.textContent?.trim() ?? null,
    notice: document.querySelector(".gate .notice")?.textContent?.trim() ?? null,
    setup: document.querySelector(".gate .setup")?.textContent?.trim() ?? null,
    who: document.querySelector(".whoami .who, .whoami .ghost")?.textContent?.trim() ?? null,
    // The rail's own connection tag. Its absence is the assertion that the SSE
    // stream authenticated — the shell renders a "gates aren't arriving" line
    // whenever that stream is down (DRY-50), so a stream token that didn't work
    // shows up here rather than in silence.
    gateStreamDown: !!document.querySelector(".rail .stream-down, .rail .disconnected"),
    railCards: [...document.querySelectorAll(".rail .card .id")].map((n) => n.textContent.trim()),
    windowTitles: [...document.querySelectorAll(".frame .bar .title")].map((n) => n.textContent.trim()),
    watching: document.querySelector(".watching")?.textContent?.trim() ?? null,
    terminals: document.querySelectorAll(".xterm-helper-textarea").length,
  }));
}

async function signIn(page, password = PASSWORD, name) {
  if (name !== undefined) {
    await page.click(".gate .link").catch(() => {});
    await page.fill('.gate input[autocomplete="username"]', name);
  }
  await page.fill('.gate input[type="password"]', password);
  await page.click(".gate .go");
}

const api = (base, path, token, init = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

async function login(base, name, password = PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`could not sign in as ${name}: ${JSON.stringify(body)}`);
  return body.token;
}

const browser = await chromium.launch();

try {
  // ---------------------------------------------------------------- (a) off --
  // The posture every existing install runs, and the one a fresh clone gets.
  // It is here first because the failure it guards against is the whole feature
  // being a regression: a login form on a daemon that has no accounts is a
  // password prompt nobody can satisfy.
  console.log("\n(a) auth off — the desk, with no door at all");
  {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(OFF);
    const drew = await waitFor(async () => (await snap(page)).desk);
    const s = await snap(page);
    check("the desk renders with no sign-in", s.desk && !s.login, `after ${drew}s`);
    check("no identity chip, since there is nobody to name", s.who === null);
    check("/api/sessions answers anonymously", (await api(OFF_API, "/api/sessions")).ok);
    await page.close();
  }

  // ------------------------------------------------------------- (b) single --
  console.log("\n(b) single account — the door");
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  {
    await page.goto(SINGLE);
    const shown = await waitFor(async () => (await snap(page)).login);
    let s = await snap(page);
    check("the login view replaces the desk", s.login && !s.desk, `after ${shown}s`);
    // The point of the whole ticket. A shell that ignored auth would have drawn
    // the desk here and started polling — which is what "curl says 401" cannot
    // distinguish.
    check("the desk is not drawn behind it", !s.desk);

    // Derived from the real one rather than written out. Any literal in this
    // file is a password-shaped string a scanner will bind an incident to, and
    // an incident outlives the line that caused it.
    await signIn(page, `${PASSWORD}-but-wrong`);
    const refused = await waitFor(async () => !!(await snap(page)).error);
    s = await snap(page);
    check("a wrong password says so", refused !== null, s.error ?? "no message");
    check("and does not open the desk", !s.desk);

    await signIn(page);
    const opened = await waitFor(async () => (await snap(page)).desk);
    s = await snap(page);
    check("the right password opens the desk", s.desk && !s.login, `after ${opened}s`);
    check("the header names who is signed in", s.who === "owner", s.who ?? "nothing");
  }

  // ------------------------------------------- (c) the headerless transports --
  // The two things curl structurally cannot check, because neither transport
  // exists outside a browser.
  console.log("\n(c) the transports that cannot carry a header");
  {
    check("the gate stream (SSE) is connected", !(await snap(page)).gateStreamDown);
    await page.click('button:has-text("+ workspace")');
    const attached = await waitFor(async () => (await snap(page)).terminals > 0, 25_000);
    const s = await snap(page);
    check("a terminal attaches over the WebSocket", s.terminals > 0, `after ${attached}s`);
    // Ground truth, not the DOM: the pane could render an empty terminal for a
    // socket that never opened.
    const token = await login(SINGLE_API, "owner");
    const list = await (await api(SINGLE_API, "/api/sessions", token)).json();
    check("the daemon agrees a session is running", list.sessions?.length > 0);
  }

  // -------------------------------------------------------- (d) persistence --
  console.log("\n(d) a reload keeps you signed in");
  {
    await page.reload();
    const back = await waitFor(async () => (await snap(page)).desk);
    const s = await snap(page);
    check("the desk comes back without a password", s.desk && !s.login, `after ${back}s`);
  }

  // ---------------------------------------------------- (e) an expired token --
  // The condition every long-lived tab eventually meets. Forged by corrupting
  // the stored token rather than by waiting 30 days: what the shell has to do
  // is identical, and it is the 401 handling being tested, not the clock.
  console.log("\n(e) a token that stops working");
  {
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("drydock:token:"));
      localStorage.setItem(key, "dd1.tampered.signature");
    });
    await page.reload();
    const out = await waitFor(async () => (await snap(page)).login);
    const s = await snap(page);
    check("a bad token lands on the login view", s.login && !s.desk, `after ${out}s`);
    check("and says what happened", !!s.notice, s.notice ?? "nothing");
    await signIn(page);
    await waitFor(async () => (await snap(page)).desk);
  }

  // ------------------------------------------------------------ (f) sign out --
  // The half that is easy to get wrong and invisible when you do: the desk's
  // timers. A poll that survives a sign-out dials the daemon every 3s with a
  // token that has been thrown away.
  console.log("\n(f) signing out puts the desk down");
  {
    const calls = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/sessions")) calls.push(Date.now());
    });
    await page.click('.whoami button:has-text("Sign out")');
    const gone = await waitFor(async () => (await snap(page)).login);
    let s = await snap(page);
    check("the desk is replaced by the login view", s.login && !s.desk, `after ${gone}s`);
    check("and takes its windows with it", s.windowTitles.length === 0);
    const before = calls.length;
    await sleep(7000); // two poll intervals
    check("the session poll has stopped", calls.length === before, `${calls.length - before} calls`);
  }
  await page.close();

  // ------------------------------------------------------------- (g) two people --
  console.log("\n(g) multi-user — one daemon, two desks");
  {
    const a = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const b = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await a.goto(MULTI);
    await waitFor(async () => (await snap(a)).login);
    await signIn(a, PASSWORD, "magos");
    const aIn = await waitFor(async () => (await snap(a)).desk);
    check("A signs in", aIn !== null);

    await b.goto(MULTI);
    await waitFor(async () => (await snap(b)).login);
    await signIn(b, PASSWORD_B, "colleague");
    const bIn = await waitFor(async () => (await snap(b)).desk);
    check("B signs in", bIn !== null);

    // Spawned through the API rather than the UI: the ticket panel's Shared
    // checkbox is a separate claim, and this scenario is about what the two
    // desks SHOW.
    const tokenA = await login(MULTI_API, "magos");
    const spawn = (visibility, title) =>
      api(MULTI_API, "/api/sessions", tokenA, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "/bin/sh",
          args: ["-c", "sleep 600"],
          title,
          autonomous: true,
          visibility,
        }),
      }).then((r) => r.json());
    const priv = await spawn("private", "A-PRIVATE");
    const pub = await spawn("public", "A-PUBLIC");

    const sees = (page, label) =>
      waitFor(async () => (await snap(page)).railCards.some((c) => c.includes(label)), 12_000);
    check("A sees their own private run", (await sees(a, "A-PRIVATE")) !== null);
    check("A sees their own public run", (await sees(a, "A-PUBLIC")) !== null);
    check("B sees the public one", (await sees(b, "A-PUBLIC")) !== null);
    const bSnap = await snap(b);
    check(
      "B does NOT see the private one",
      !bSnap.railCards.some((c) => c.includes("A-PRIVATE")),
      bSnap.railCards.join(", ") || "no cards",
    );
    // The card names its owner rather than its origin, which is the difference
    // between "why is this on my rail" being answerable and not.
    const label = await b.evaluate(
      () =>
        [...document.querySelectorAll(".rail .card")]
          .find((c) => c.querySelector(".id")?.textContent?.includes("A-PUBLIC"))
          ?.querySelector(".origin")?.textContent?.trim() ?? null,
    );
    check("the shared card names its owner", label === "MAGOS", label ?? "nothing");
    // No ✕ on somebody else's run: clearing means killing, which the daemon
    // refuses, so the button would fail every time it was pressed.
    const clearable = await b.evaluate(
      () =>
        !![...document.querySelectorAll(".rail .card")]
          .find((c) => c.querySelector(".id")?.textContent?.includes("A-PUBLIC"))
          ?.querySelector(".clear"),
    );
    check("B is not offered a way to clear it", !clearable);

    // Watching it opens a read-only pane.
    await b.click(".rail .card:has(.id:text-matches('A-PUBLIC'))").catch(async () => {
      await b.evaluate(() =>
        [...document.querySelectorAll(".rail .card")]
          .find((c) => c.querySelector(".id")?.textContent?.includes("A-PUBLIC"))
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
    });
    const watched = await waitFor(async () => !!(await snap(b)).watching, 15_000);
    const bWatch = await snap(b);
    check("watching it says so", watched !== null, bWatch.watching ?? "no tag");
    check("and names whose it is", (bWatch.watching ?? "").includes("magos"));

    // Desks are separate — asserted with a window that actually EXISTS on one
    // of them. A supervised (non-autonomous) session is the one that reconcile
    // gives a window to, so A gets one and B, who cannot see it at all, must
    // still have none. Comparing two empty desks would pass against a daemon
    // that scoped nothing.
    // Measured as a DELTA, because B's desk is not empty by this point — B is
    // watching the public run, which is a window B opened deliberately. An
    // absolute count here would fail against correct behaviour, and (worse) an
    // `=== 0` written before that step existed would have passed vacuously.
    const bBefore = (await snap(b)).windowTitles.length;
    const aBefore = (await snap(a)).windowTitles.length;
    const supervised = await api(MULTI_API, "/api/sessions", tokenA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "/bin/sh", args: ["-c", "sleep 600"], title: "A-DESK" }),
    }).then((r) => r.json());
    const drew = await waitFor(
      async () => (await snap(a)).windowTitles.length > aBefore,
      12_000,
    );
    const aAfter = (await snap(a)).windowTitles.length;
    const bAfter = (await snap(b)).windowTitles.length;
    check("A's supervised session opens a window on A's desk", drew !== null, `${aBefore}→${aAfter}`);
    check("and nothing appears on B's", bAfter === bBefore, `${bBefore}→${bAfter}`);
    await api(MULTI_API, `/api/sessions/${supervised.session.id}/kill`, tokenA, { method: "POST" });

    await api(MULTI_API, `/api/sessions/${priv.session.id}/kill`, tokenA, { method: "POST" });
    await api(MULTI_API, `/api/sessions/${pub.session.id}/kill`, tokenA, { method: "POST" });
    await a.close();
    await b.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
