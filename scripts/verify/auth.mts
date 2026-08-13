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
// both carry a short-lived `stream` token in the query string instead, and a
// real browser is the only thing that exercises the path the shell takes.
//
// THE SSE ASSERTION IS POSITIVE, and that is the point of its shape. The first
// version of this file checked for the ABSENCE of a "stream is down" banner,
// using two class names that exist nowhere in the shell (the real one is
// `.offline`) — and it ran before anything had been spawned, when that banner
// is suppressed anyway. It could not fail. So this raises a REAL gate through
// the hook endpoint and waits for the panel to appear: nothing renders that
// panel except an event delivered over the stream this is meant to be testing.
//
// Setup + overrides: see README.md.
import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const SINGLE = process.env.SINGLE_SHELL ?? "http://127.0.0.1:5394";
const SINGLE_API = process.env.SINGLE_API ?? "http://127.0.0.1:4394";
const SINGLE_SESSIONS = process.env.SINGLE_SESSIONS_DIR ?? "/tmp/dry27s-single";
const MULTI = process.env.MULTI_SHELL ?? "http://127.0.0.1:5393";
const MULTI_API = process.env.MULTI_API ?? "http://127.0.0.1:4393";
const OFF = process.env.OFF_SHELL ?? "http://127.0.0.1:5392";
const OFF_API = process.env.OFF_API ?? "http://127.0.0.1:4392";

/**
 * The two throwaway accounts' passwords, from the environment with NO defaults.
 *
 * Not hygiene theatre: a literal here is a password-shaped string in a
 * checked-in file, which every secret scanner is right to flag and which then
 * needs an exception that outlives whoever added it. Failing loudly with the
 * export line beats a default nobody should be using — and it keeps this file's
 * copy of the rig from drifting from the README's.
 */
const PASSWORD = required("DRYDOCK_TEST_PASSWORD");
const PASSWORD_B = required("DRYDOCK_TEST_PASSWORD_B");

function required(name: string): string {
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
function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `fn` holds. Fixed sleeps are what make a browser harness flaky: a
 * sign-in is a round trip plus a desk boot (auth info, tracker, workspace, the
 * first session poll), and any constant is either a stall or a race.
 */
async function waitFor(fn: () => Promise<boolean>, ms = 15_000): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return Math.round((Date.now() - t0) / 100) / 10;
    await sleep(150);
  }
  return null;
}

interface Snapshot {
  login: boolean;
  desk: boolean;
  error: string | null;
  notice: string | null;
  who: string | null;
  /** The rail's real "the stream is down" banner. `.offline`, not `.stream-down`. */
  streamDown: boolean;
  /** A gate panel is on screen — only an SSE event puts one there. */
  gatePanel: boolean;
  railCards: string[];
  windowTitles: string[];
  watching: string | null;
}

/**
 * Every `page.evaluate` body in this file is a STRING, not a function.
 *
 * Not a style choice. This file runs under `tsx`, whose esbuild transform wraps
 * named functions in a `__name(...)` helper (keepNames) — and Playwright ships
 * an evaluate body to the browser as SOURCE, where that helper does not exist.
 * The result is `ReferenceError: __name is not defined` from inside the page,
 * pointing at a line that looks perfectly fine. Strings are not transformed, so
 * they cross the boundary intact. It is the one real cost of `.mts` here, and
 * it is cheaper than a harness that can't read the DOM.
 */
const SNAP_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const text = (s) => { const el = q(s); return el ? el.textContent.trim() : null; };
  const all = (s) => Array.from(document.querySelectorAll(s)).map((n) => n.textContent.trim());
  return {
    login: !!q(".gate .card"),
    desk: !!q(".topbar"),
    error: text(".gate .error"),
    notice: text(".gate .notice"),
    who: text(".whoami .who, .whoami .ghost"),
    streamDown: !!q(".rail .offline"),
    gatePanel: !!q(".rail .panel .title"),
    railCards: all(".rail .card .id"),
    windowTitles: all(".frame .bar .title"),
    watching: text(".watching"),
  };
})()`;

function snap(page: Page): Promise<Snapshot> {
  return page.evaluate(SNAP_JS) as Promise<Snapshot>;
}

/** The `.origin` slot of the rail card whose id contains `label`, or null. */
const cardField = (label: string, sel: string): string =>
  `(() => {
    const card = Array.from(document.querySelectorAll(".rail .card")).find((c) => {
      const id = c.querySelector(".id");
      return id && id.textContent.includes(${JSON.stringify(label)});
    });
    if (!card) return null;
    const el = card.querySelector(${JSON.stringify(sel)});
    return el ? el.textContent.trim() : null;
  })()`;

/** Does that card have `sel` at all — the ✕ a spectator must not be offered. */
const cardHas = (label: string, sel: string): string =>
  `(() => {
    const card = Array.from(document.querySelectorAll(".rail .card")).find((c) => {
      const id = c.querySelector(".id");
      return id && id.textContent.includes(${JSON.stringify(label)});
    });
    return !!(card && card.querySelector(${JSON.stringify(sel)}));
  })()`;

async function signIn(page: Page, password = PASSWORD, name?: string): Promise<void> {
  if (name !== undefined) {
    await page.click(".gate .link").catch(() => {});
    await page.fill('.gate input[autocomplete="username"]', name);
  }
  await page.fill('.gate input[type="password"]', password);
  await page.click(".gate .go");
}

const api = (base: string, path: string, token?: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

async function login(base: string, name: string, password = PASSWORD): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`could not sign in as ${name}: ${JSON.stringify(body)}`);
  return body.token;
}

interface SpawnedSession {
  session: { id: string };
}

/**
 * The per-session hook key, read off the sessions-dir metadata (DRY-27).
 *
 * A spawned CLI gets this in its environment; a harness standing in for one has
 * to read it from the same place the daemon does. Coupled to the rig's
 * `DRYDOCK_SESSIONS_DIR`, which is why that is an override.
 */
function hookKey(id: string): string {
  const meta = JSON.parse(fs.readFileSync(path.join(SINGLE_SESSIONS, `${id}.json`), "utf8"));
  const key = meta?.env?.DRYDOCK_SESSION_KEY;
  if (typeof key !== "string") throw new Error(`no hook key recorded for session ${id}`);
  return key;
}

/**
 * Raise a real permission gate, as the wrapped CLI would.
 *
 * Deliberately NOT awaited by the caller: the daemon holds this request open
 * until somebody answers, which is the whole behaviour. The rejection is
 * swallowed for the same reason gate-actions.mjs swallows it — the run ends
 * before the gate does.
 */
function raiseGate(sessionId: string, token: string, tool = "Bash"): void {
  void fetch(`${SINGLE_API}/hook/pretooluse`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-drydock-session": sessionId,
      "x-drydock-key": token,
    },
    body: JSON.stringify({
      tool_name: tool,
      tool_input: { command: "echo from the verification harness" },
      permission_mode: "default",
    }),
  }).catch(() => {});
}

const browser: Browser = await chromium.launch();

try {
  // ---------------------------------------------------------------- (a) off --
  // The posture every existing install runs, and the one a fresh clone gets. It
  // is first because the failure it guards against is the whole feature being a
  // regression: a login form on a daemon that has no accounts is a prompt
  // nobody can satisfy.
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
  const token = await login(SINGLE_API, "owner");
  {
    // Asserted on BYTES ARRIVING, not on a terminal existing. `term.open()`
    // runs on mount whatever the socket does, so "an .xterm element appeared"
    // is true of a pane whose WebSocket was refused — the same shape of
    // un-failable check as the SSE one this scenario had. A marker the shell
    // could not have invented is the only honest evidence the socket opened.
    const marker = `WSPROBE-${process.pid}`;
    await api(SINGLE_API, "/api/sessions", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "/bin/sh",
        // A LOOP, not a single echo. Output produced before the pane attaches
        // does not come back in the replay — the daemon's own ring starts at
        // the moment it binds the supervisor, and only an ADOPT pulls the
        // supervisor's earlier buffer across (DRY-57). Nothing to do with auth,
        // but a one-shot echo makes this assertion fail for that reason and
        // read as a broken socket.
        args: ["-c", `while :; do echo ${marker}; sleep 1; done`],
        title: "WS-PROBE",
      }),
    });
    const attached = await waitFor(
      async () =>
        (
          await page
            .evaluate<string>(
              `Array.from(document.querySelectorAll(".xterm-rows")).map((n) => n.textContent).join(" ")`,
            )
            .catch(() => "")
        ).includes(marker),
      25_000,
    );
    check("PTY output reaches the browser over the WebSocket", attached !== null, `after ${attached}s`);
    // Reaped with everything else: this one loops forever by design.
    const listed = (await (await api(SINGLE_API, "/api/sessions", token)).json()) as {
      sessions: { id: string; title: string }[];
    };
    for (const s of listed.sessions.filter((x) => x.title === "WS-PROBE")) {
      await api(SINGLE_API, `/api/sessions/${s.id}/kill`, token, { method: "POST" });
    }

    // Now the stream, POSITIVELY. An autonomous run so the rail is populated
    // (its banner is suppressed on an empty rail, which is half of why the
    // absence-check this replaced could not fail), then a real gate through the
    // hook endpoint. Only an SSE event renders that panel.
    const run = (await (
      await api(SINGLE_API, "/api/sessions", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "/bin/sh",
          args: ["-c", "sleep 300"],
          title: "GATE-PROBE",
          autonomous: true,
        }),
      })
    ).json()) as SpawnedSession;
    const carded = await waitFor(
      async () => (await snap(page)).railCards.some((c) => c.includes("GATE-PROBE")),
      12_000,
    );
    check("the run appears on the rail", carded !== null);
    raiseGate(run.session.id, hookKey(run.session.id));
    const gated = await waitFor(async () => (await snap(page)).gatePanel, 15_000);
    check("a gate raised by a hook reaches the browser over SSE", gated !== null, `after ${gated}s`);
    check("and the rail is not reporting a dead stream", !(await snap(page)).streamDown);
    await api(SINGLE_API, `/api/sessions/${run.session.id}/kill`, token, { method: "POST" });
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
  // the stored token rather than by waiting 30 days: what the shell has to do is
  // identical, and it is the 401 handling being tested, not the clock.
  console.log("\n(e) a token that stops working");
  {
    await page.evaluate(`(() => {
      const key = Object.keys(localStorage).find((k) => k.indexOf("drydock:token:") === 0);
      if (key) localStorage.setItem(key, "dd1.tampered.signature");
    })()`);
    await page.reload();
    const out = await waitFor(async () => (await snap(page)).login);
    const s = await snap(page);
    check("a bad token lands on the login view", s.login && !s.desk, `after ${out}s`);
    check("and says what happened", !!s.notice, s.notice ?? "nothing");
    // A multibyte signature must be REFUSED, not throw: `timingSafeEqual` raises
    // on a byte-length mismatch, and that throw used to escape verifyToken and
    // become a 500 on every guarded route.
    const weird = await api(SINGLE_API, "/api/sessions", "dd1.eyJ1IjoieCJ9.ééé");
    check("a multibyte signature is refused, not a 500", weird.status === 401, `${weird.status}`);
    await signIn(page);
    await waitFor(async () => (await snap(page)).desk);
  }

  // ------------------------------------------------------------ (f) sign out --
  // The half that is easy to get wrong and invisible when you do: the desk's
  // timers. A poll that survives a sign-out dials the daemon every 3s with a
  // token that has been thrown away.
  console.log("\n(f) signing out puts the desk down");
  {
    const calls: number[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/sessions")) calls.push(Date.now());
    });
    await page.click('.whoami button:has-text("Sign out")');
    const gone = await waitFor(async () => (await snap(page)).login);
    const s = await snap(page);
    check("the desk is replaced by the login view", s.login && !s.desk, `after ${gone}s`);
    check("and takes its windows with it", s.windowTitles.length === 0);
    // The desk mirror goes too: it is keyed by daemon rather than by account, so
    // leaving it hands the next person to sign in on this browser the last
    // person's desk as their offline fallback.
    const mirrored = await page.evaluate(
      `Object.keys(localStorage).some((k) => k.indexOf("drydock.layout") === 0)`,
    );
    check("and its local mirror", !mirrored);
    const before = calls.length;
    await sleep(7000); // two poll intervals
    check("the session poll has stopped", calls.length === before, `${calls.length - before} calls`);
  }
  await page.close();

  // ---------------------------------------------------------- (g) two people --
  console.log("\n(g) multi-user — one daemon, two desks");
  {
    const a = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const b = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await a.goto(MULTI);
    await waitFor(async () => (await snap(a)).login);
    await signIn(a, PASSWORD, "magos");
    check("A signs in", (await waitFor(async () => (await snap(a)).desk)) !== null);

    await b.goto(MULTI);
    await waitFor(async () => (await snap(b)).login);
    await signIn(b, PASSWORD_B, "colleague");
    check("B signs in", (await waitFor(async () => (await snap(b)).desk)) !== null);

    // Spawned through the API rather than the UI: the ticket panel's Shared
    // checkbox is a separate claim, and this scenario is about what the two
    // desks SHOW.
    const tokenA = await login(MULTI_API, "magos");
    const spawn = (visibility: string, title: string) =>
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
      }).then((r) => r.json() as Promise<SpawnedSession>);
    const priv = await spawn("private", "A-PRIVATE");
    const pub = await spawn("public", "A-PUBLIC");

    const sees = (p: Page, label: string) =>
      waitFor(async () => (await snap(p)).railCards.some((c) => c.includes(label)), 12_000);
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
    const label = await b.evaluate<string | null>(cardField("A-PUBLIC", ".origin"));
    check("the shared card names its owner", label === "MAGOS", label ?? "nothing");
    // No ✕ on somebody else's run: clearing means killing, which the daemon
    // refuses, so the button would fail every time it was pressed.
    const clearable = await b.evaluate(cardHas("A-PUBLIC", ".clear"));
    check("B is not offered a way to clear it", !clearable);

    // The daemon refuses it too, not just the UI — the button being absent is
    // the courtesy, this is the boundary.
    const tokenB = await login(MULTI_API, "colleague", PASSWORD_B);
    const killed = await api(MULTI_API, `/api/sessions/${pub.session.id}/kill`, tokenB, {
      method: "POST",
    });
    check("and the daemon refuses if asked anyway", killed.status === 404, `${killed.status}`);
    // Nor may B read files out of A's working directory — a public run is
    // watchable, not browsable.
    const read = await api(
      MULTI_API,
      `/api/sessions/${pub.session.id}/file?path=README.md`,
      tokenB,
    );
    check("nor read files from A's working directory", read.status === 404, `${read.status}`);
    // Nor take over another account by setting its password.
    const meB = (await (await api(MULTI_API, "/api/auth/me", tokenB)).json()) as {
      user: { id: string };
    };
    const meA = (await (await api(MULTI_API, "/api/auth/me", tokenA)).json()) as {
      user: { id: string };
    };
    const takeover = await api(MULTI_API, `/api/users/${meA.user.id}/password`, tokenB, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current: PASSWORD_B, password: `${PASSWORD_B}-taken` }),
    });
    check("nor set another account's password", takeover.status === 400, `${takeover.status}`);
    check("B's own id differs from A's", meA.user.id !== meB.user.id);

    // Removing an account with live sessions would strand them: no surface can
    // list, attach to or kill a session whose owner doesn't exist.
    const stranding = await api(MULTI_API, `/api/users/${meA.user.id}`, tokenB, {
      method: "DELETE",
    });
    const strandingBody = (await stranding.json()) as { error?: string };
    check(
      "removing an account with running sessions is refused",
      stranding.status === 400 && /still running/.test(strandingBody.error ?? ""),
      strandingBody.error ?? `${stranding.status}`,
    );

    // Watching it opens a read-only pane.
    await b.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll(".rail .card")).find((c) => {
        const id = c.querySelector(".id");
        return id && id.textContent.includes("A-PUBLIC");
      });
      if (card) card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    })()`);
    const watched = await waitFor(async () => !!(await snap(b)).watching, 15_000);
    const bWatch = await snap(b);
    check("watching it says so", watched !== null, bWatch.watching ?? "no tag");
    check("and names whose it is", (bWatch.watching ?? "").includes("magos"));

    // Desks are separate — asserted with a window that actually EXISTS on one of
    // them, and as a DELTA, because B's desk is not empty by this point (B is
    // watching the public run, a window B opened on purpose). An absolute
    // `=== 0` would fail against correct behaviour, and written before the watch
    // step existed it would have passed vacuously.
    const bBefore = (await snap(b)).windowTitles.length;
    const aBefore = (await snap(a)).windowTitles.length;
    const supervised = await api(MULTI_API, "/api/sessions", tokenA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "/bin/sh", args: ["-c", "sleep 600"], title: "A-DESK" }),
    }).then((r) => r.json() as Promise<SpawnedSession>);
    const drew = await waitFor(async () => (await snap(a)).windowTitles.length > aBefore, 12_000);
    const aAfter = (await snap(a)).windowTitles.length;
    const bAfter = (await snap(b)).windowTitles.length;
    check("A's supervised session opens a window on A's desk", drew !== null, `${aBefore}→${aAfter}`);
    check("and nothing appears on B's", bAfter === bBefore, `${bBefore}→${bAfter}`);

    for (const id of [priv.session.id, pub.session.id, supervised.session.id]) {
      await api(MULTI_API, `/api/sessions/${id}/kill`, tokenA, { method: "POST" });
    }
    await a.close();
    await b.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
