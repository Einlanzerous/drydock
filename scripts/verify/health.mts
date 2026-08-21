// DRY-48: /healthz has an opinion, and a fault is expressible.
//
// `/healthz` used to be `{ok:true, sessions:N}` from a handler that could not
// fail: it proved the event loop turned and the HTTP server answered, and
// nothing else. So a daemon that had taken an uncaught exception and stayed up
// (DRY-45's posture, and still available as DRYDOCK_EXIT_ON_UNCAUGHT=0) looked
// exactly as healthy from outside as one that hadn't.
//
// WHY A HARNESS, given that most of this is readable from a curl. Three claims
// here are about what the PROCESS does, not about a payload:
//
//   1. A fault has to be a REAL fault. Every check below that mentions one is
//      driven by a genuine `uncaughtException` — thrown from a timer callback in
//      a preload (`fault-inject.mts`), with nothing of the daemon on the stack.
//      A route that threw would be caught by server.ts's own catch-all and
//      become a 500, so no handler would fire and the whole section would pass
//      against a daemon that counts nothing.
//   2. The three postures of DRYDOCK_EXIT_ON_UNCAUGHT are three different
//      lifetimes, and two of them are assertions about a process that is no
//      longer there (or is, and shouldn't be). `when-idle` in particular can
//      only be tested by watching a daemon NOT exit while a session runs and
//      then exit when it stops — a pair, because a policy that exits
//      immediately passes the second half on its own.
//   3. `degraded` must never read as `down`. The whole trade DRY-45 struck is
//      that a daemon holding live PTYs is worth more than a clean process, so a
//      broken store, an unreachable tracker or a fault this process survived
//      must leave `ok:true` and `/readyz` 200. That is a claim about what
//      something watching this daemon would DO, and it is the one a payload
//      screenshot can't make.
//
// It starts every daemon it needs, so there is no rig to set up:
//
//   (cd daemon && node --import tsx ../scripts/verify/health.mts)
//
// No browser, no database, no systemd. About ninety seconds — most of it spent
// starting six throwaway daemons and waiting out one idle-exit poll.
//
// CONFIRM IT DISCRIMINATES. Against `main` it fails 45 of 57; of the twelve
// survivors, four are the legacy-compatibility checks (which are meant to pass),
// four are premises this ticket didn't change, one is rig setup, and three pass
// vacuously — see this file's section in scripts/verify/README.md, which names
// them. Per mutation, against the finished tree, all measured:
//
//   `ok: status !== "down"` → `ok: status === "ok"`      3 of 57, the degraded
//     checks — i.e. the ticket's own "not to be restarted for being suspect"
//   `readiness()` refusing a degraded tracker            1 of 57
//   the uncaught handler not calling `faults.record`     7 of 57
//   `when-idle` ignoring whether anything is running     4 of 57 ┐ the pair, and
//   `when-idle` never arming at all                      3 of 57 ┘ why it is one
//   `TrackerWatch.failed` without its CALLER_FAULT arm   1 of 57, the 404
//   `indexHealth` calling `sessionsDir()`                0 of 57 — vacuous, and
//     recorded as such rather than dropped: `ensured` makes the two spellings
//     agree in a running daemon, so that check is a latch, not a discriminator.
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Detail, HealthResponse, ReadyResponse, SpawnResponse } from "./api.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.PORT ?? 4348);
const DAEMON = `http://127.0.0.1:${PORT}`;
const SCRATCH = "/tmp/dry48";
const SESSIONS_DIR = path.join(SCRATCH, "sessions");
const STATE_FILE = path.join(SCRATCH, "state.json");
const LOG_FILE = path.join(SCRATCH, "daemon.log");
const FAULT_FILE = path.join(SCRATCH, "fault");
/** The daemon re-asks "is anything running?" every 5s under `when-idle`. */
const IDLE_POLL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

// The dev daemon is on :4317 and prod on :4318, and both hold live agent PTYs.
// This file chmods a sessions directory to 000 and sends SIGUSR2 to whatever is
// listening, so a default that resolved to either would be a very bad afternoon.
if (PORT === 4317 || PORT === 4318) {
  console.error(`refusing to run against :${PORT} — that is a real daemon holding live PTYs`);
  process.exit(2);
}

/**
 * A daemon started from inside a Drydock session inherits the daemon that
 * spawned it (CLAUDE.md), so a "throwaway" would come up on PROD's Postgres,
 * PROD's password and PROD's sessions dir. Every path this file breaks on
 * purpose is one it was handed, so that is not a subtle failure mode.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("DRYDOCK_")) out[k] = v;
  }
  return out;
}

// --- the rig -----------------------------------------------------------------

let daemon: ChildProcess | null = null;
/**
 * A field rather than a bare `let`, because tsc narrows a module-scope boolean
 * to the literal it was last assigned and then reports every `=== true` on it
 * as a comparison with no overlap — the assignment it can't see is the one in
 * the `exit` listener. A property read is re-widened after any call.
 */
const state = { daemonExited: false };

/**
 * The child's pid, through a call.
 *
 * Same tsc quirk as `state` above: a module-scope `let` initialised to null is
 * narrowed to `null` for the whole file, so `daemon?.pid` at the top level reads
 * as `never`. Narrowing doesn't cross into a function body, so this does.
 */
const daemonPid = (): number | undefined => daemon?.pid ?? undefined;
const daemonLog: string[] = [];

interface Posture {
  /** DRYDOCK_EXIT_ON_UNCAUGHT. Unset = the default. */
  onUncaught?: string;
  /** Load fault-inject.mts, so this daemon can be made to take a real fault. */
  faults?: boolean;
  tracker?: Record<string, string>;
}

/**
 * A throwaway daemon in one posture.
 *
 * The port is asserted FREE first, and that guard is not defensive
 * housekeeping: every section here is a different posture on one port, so a
 * daemon that outlived its section answers for the next one — and answers
 * plausibly, since it is a real Drydock. The first cut of this file did exactly
 * that and reported eighteen failures that were all one leak (DRY-81's rule:
 * assert it is OUR daemon, not merely that something answered).
 */
async function startDaemon(posture: Posture = {}): Promise<boolean> {
  if (await hz()) {
    console.error(`  something is already listening on :${PORT} — refusing to start another`);
    return false;
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  state.daemonExited = false;
  daemonLog.length = 0;
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    DRYDOCK_PORT: String(PORT),
    DRYDOCK_HOST: "127.0.0.1",
    DRYDOCK_SESSIONS_DIR: SESSIONS_DIR,
    DRYDOCK_STATE_FILE: STATE_FILE,
    DRYDOCK_LOG_FILE: LOG_FILE,
    DRYDOCK_WORKTREES_ROOT: path.join(SCRATCH, "wt"),
    DRYDOCK_TRACKER: "fixture",
    // Empty rather than absent: `env.ts` walks up from the daemon's cwd and
    // applies any key of the CHECKOUT's `.env` that isn't already in the
    // environment, and an empty string counts as present.
    DRYDOCK_DATABASE_URL: "",
    DRYDOCK_MULTI_USER: "",
    DRYDOCK_AUTH_PASSWORD: "",
    DRYDOCK_FAULT_FILE: FAULT_FILE,
    ...(posture.onUncaught === undefined ? {} : { DRYDOCK_EXIT_ON_UNCAUGHT: posture.onUncaught }),
    ...posture.tracker,
  };
  const args = ["--import", "tsx"];
  if (posture.faults) args.push("--import", path.join(REPO, "scripts/verify/fault-inject.mts"));
  daemon = spawn(process.execPath, [...args, "src/index.ts"], {
    cwd: path.join(REPO, "daemon"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (b: Buffer) => daemonLog.push(String(b)));
  daemon.stderr?.on("data", (b: Buffer) => daemonLog.push(String(b)));
  daemon.once("exit", () => (state.daemonExited = true));
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await hz()) return true;
    if (state.daemonExited) return false;
  }
  return false;
}

/**
 * Stop it, and do not return while it is still answering.
 *
 * SIGTERM detaches and exits (DRY-57), so this is normally immediate — but a
 * suspect daemon is precisely the thing that might not honour it, and every
 * caller here is about to start another one on the same port. So the escalation
 * is real and the failure is LOUD: a silent give-up is what turns one wedged
 * daemon into a whole file measuring the wrong process.
 */
async function stopDaemon(): Promise<void> {
  const proc = daemon;
  daemon = null;
  if (proc && !state.daemonExited) {
    const ended = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGTERM");
    await Promise.race([ended, sleep(5_000)]);
    if (!state.daemonExited) proc.kill("SIGKILL");
  }
  for (let i = 0; i < 100; i++) {
    if (!(await hz())) return;
    await sleep(100);
  }
  check("the daemon under test stopped", false, `still answering on :${PORT}`);
}

/** `/healthz`, or null if nothing answered. */
async function hz(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${DAEMON}/healthz`, { signal: AbortSignal.timeout(8_000) });
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * `/readyz` with its status code — the half a supervisor acts on.
 *
 * Never null, and every field below is read through `?.`, because a harness has
 * to FAIL against the tree it is discriminating from rather than crash on it:
 * pre-DRY-48 there is no such route and no such field, and the first cut of this
 * file died on `h.faults.total` at check 6 of 57, reporting nothing about the
 * other fifty-one.
 */
async function readyz(): Promise<{ code: number; body: Partial<ReadyResponse> }> {
  try {
    const res = await fetch(`${DAEMON}/readyz`, { signal: AbortSignal.timeout(8_000) });
    const body = await res.json().catch(() => ({}));
    return { code: res.status, body: body as Partial<ReadyResponse> };
  } catch {
    return { code: 0, body: {} };
  }
}

/**
 * A GET/POST whose failure is a value rather than a throw.
 *
 * Half the daemons here are expected to die mid-section, and a bare `await
 * fetch` against one that has gone takes the HARNESS down with it — which is
 * strictly worse than a FAIL, because every check after it silently never runs.
 * Measured: one mutation reported "4 of 49" where the honest answer was 6 of 53.
 */
async function call(path: string, init?: RequestInit): Promise<number> {
  try {
    const res = await fetch(`${DAEMON}${path}`, { ...init, signal: AbortSignal.timeout(8_000) });
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * `/healthz` for the sections that have already established a daemon is up.
 *
 * An empty object rather than null for the same reason `readyz` is partial: a
 * mutated or pre-DRY-48 daemon that answers with less — or dies mid-section —
 * must produce failures, not a stack trace that eats every check after it.
 */
const hzSafe = async (): Promise<Partial<HealthResponse>> => (await hz()) ?? {};

/** Make the daemon take a real fault, and wait for it to have landed. */
async function injectFault(kind: "exception" | "rejection"): Promise<void> {
  // Signalled by the CHILD's pid rather than the one /healthz reports: that
  // field is part of what is under test, so aiming the signal with it would
  // make every fault check depend on the payload being right — and against a
  // daemon that reports no pid this file would die rather than fail.
  const pid = daemonPid();
  if (!pid) return;
  fs.writeFileSync(FAULT_FILE, `${kind}\n`);
  process.kill(pid, "SIGUSR2");
  // The throw is one timer tick away, and the exit (if the posture takes one) a
  // few more. Long enough to have happened; short enough not to hide a wedge.
  await sleep(1_000);
}

async function spawnSession(seconds = 120): Promise<string> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args: ["-c", `sleep ${seconds}`] }),
  });
  return ((await res.json()) as SpawnResponse).session.id;
}

/**
 * Kill every supervisor this file's daemons left behind.
 *
 * Both filters, per CLAUDE.md, and for the documented reason: the exe test
 * alone matches every supervisor on the host (they are all the same `node`),
 * and the sessions-dir test alone matches the shell running this check.
 */
function reapSupervisors(): void {
  let killed = 0;
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!/node/.test(fs.readlinkSync(`/proc/${pid}/exe`))) continue;
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!cmdline.includes("supervisor/main") || !cmdline.includes(SESSIONS_DIR)) continue;
      process.kill(Number(pid), "SIGKILL");
      killed++;
    } catch {
      /* gone, or not ours to read */
    }
  }
  if (killed) console.log(`  (reaped ${killed} supervisor${killed > 1 ? "s" : ""})`);
}

/**
 * Never leave a daemon behind, however this file ends.
 *
 * A child spawned here outlives its parent, so an exception anywhere below (or
 * a Ctrl-C) leaves a real Drydock holding :4348 — which the NEXT run then finds
 * and refuses to start over, turning one bad run into a permanently broken
 * file. Learned the hard way, twice.
 */
process.on("exit", () => {
  try {
    daemon?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
});

console.log(`\nDRY-48 health — daemon ${DAEMON}, scratch ${SCRATCH}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// --- (a) a healthy daemon says so, in the old words as well as the new -------
//
// The legacy half is not padding. Everything already watching this endpoint
// reads `ok` and `store` — the other harnesses in this directory, docs/deploy.md,
// whatever a host has pointed at it — so a report that grew a `status` field and
// moved those would be this ticket breaking the thing it set out to improve.

console.log("\n(a) a healthy daemon");
if (!(await startDaemon())) {
  check("daemon starts", false, daemonLog.join("").slice(-400));
} else {
  const h = await hzSafe();
  check("status is ok", h?.status === "ok", JSON.stringify(h?.status));
  check("legacy `ok` is still true", h?.ok === true);
  check("legacy `sessions` is still a count", h?.sessions === 0, String(h?.sessions));
  check("legacy `store` is still where it was", h?.store?.kind === "file" && h?.store?.ok === true);
  check(
    "store capabilities survive (DRY-56)",
    h?.store?.capabilities?.sessionHistory === false,
    JSON.stringify(h?.store?.capabilities),
  );
  check("no faults on a fresh process", h?.faults?.total === 0, JSON.stringify(h?.faults));
  check("the default policy is reported", h?.faults?.onUncaught === "exit", h?.faults?.onUncaught);
  check(
    "it reports its own pid and an uptime",
    h?.pid === daemonPid() && (h?.uptimeMs ?? 0) > 0,
    `${h?.uptimeMs}ms pid ${h?.pid} vs child ${daemonPid()}`,
  );
  // Asserted before anything below chmods it. DRY-90's lesson: a harness that
  // breaks a path from its own constant, rather than the one the daemon says it
  // is using, is a harness that can break somebody's real installation.
  check(
    "the index it reports is the one this file made",
    h?.registry?.index?.dir === SESSIONS_DIR,
    `${h?.registry?.index?.dir} vs ${SESSIONS_DIR}`,
  );
  check("the log file it reports is ours", h?.log?.file === LOG_FILE, h?.log?.file);

  const r = await readyz();
  check("/readyz answers 200", r.code === 200, String(r.code));
  check("/readyz is ready and unsuspicious", r.body?.ready === true && r.body?.suspect === false);

  // --- (b) a tracker that ANSWERED no is not a tracker that is down ----------
  //
  // `unknown` until something asks, because health must not go and ask itself:
  // one sidebar pull against a corporate Jira is 5.7-6s of cursor pages (DRY-72)
  // and putting that behind a health poll would reinstate, on a hidden timer,
  // exactly what that ticket removed.
  console.log("\n(b) the tracker, observed rather than probed");
  check("unknown before anything asks", h?.tracker?.state === "unknown", h?.tracker?.state);
  await call("/api/tracker/tickets?open=true");
  const asked = await hzSafe();
  check("ok once a call succeeds", asked?.tracker?.state === "ok", JSON.stringify(asked.tracker));
  const missing = await call("/api/tracker/ticket/NO-SUCH-KEY-1");
  const after404 = await hzSafe();
  check(
    "a 404 for a mistyped key leaves it ok",
    missing === 404 && after404?.tracker?.state === "ok" && after404?.status === "ok",
    `${missing} then ${JSON.stringify(after404.tracker)}`,
  );
  await stopDaemon();
}

// --- (c) a fault is counted, and counted separately --------------------------

console.log("\n(c) faults, under DRYDOCK_EXIT_ON_UNCAUGHT=0");
if (!(await startDaemon({ onUncaught: "0", faults: true }))) {
  check("daemon starts (stay posture)", false, daemonLog.join("").slice(-400));
} else {
  check("the `stay` policy is reported", (await hz())?.faults?.onUncaught === "stay");
  await injectFault("exception");
  const one = await hz();
  check("it survived an uncaught exception", one !== null);
  if (one) {
    check("counted as an uncaught exception", one?.faults?.uncaughtExceptions === 1, JSON.stringify(one?.faults));
    check("the last one is quoted", /injected uncaught exception/.test(one?.faults?.last ?? ""), one?.faults?.last ?? "");
    check("and stamped", Boolean(one?.faults?.lastAt) && Date.now() - Date.parse(one?.faults?.lastAt!) < 60_000);
    check("status went degraded", one?.status === "degraded", one?.status);
    // The ticket's central requirement. A daemon holding live PTYs after one
    // uncaught exception is not down and must not be restarted for it.
    check("`ok` stays TRUE while degraded", one?.ok === true, JSON.stringify(one?.ok));
    const r = await readyz();
    check("/readyz stays 200 while suspect", r.code === 200 && r.body?.ready === true, String(r.code));
    check("/readyz says suspect", r.body?.suspect === true && r.body?.faults === 1, JSON.stringify(r.body));
  }
  await injectFault("rejection");
  const two = await hz();
  check(
    "an unhandled rejection is counted apart from an exception",
    two?.faults?.unhandledRejections === 1 && two?.faults.uncaughtExceptions === 1 && two?.faults.total === 2,
    JSON.stringify(two?.faults),
  );

  // --- (d) dependencies degrade; none of them un-readies the daemon ----------
  //
  // DRY-28's first non-negotiable property, restated at this layer: a dead
  // database never costs a PTY. The same has to be true of the log sink, and of
  // the tracker (section (f)).
  console.log("\n(d) a broken dependency is degraded, never down");
  // Every path this section damages is asserted to be THIS daemon's first, and
  // not from the constants at the top of the file. The daemon in front of you is
  // the only thing that knows what it was configured with, and a harness that
  // chmods 000 from its own idea of that is a harness that can break somebody's
  // real installation (DRY-90's rig lesson, and section (a) makes the same
  // check against the daemon it starts).
  const intact = await hzSafe();
  check(
    "the paths about to be broken belong to this daemon",
    intact?.log?.file === LOG_FILE && intact?.registry?.index?.dir === SESSIONS_DIR,
    `${intact?.log?.file} / ${intact?.registry?.index?.dir}`,
  );
  // There is no state file until something has been saved, and the file store's
  // health check is right to call a not-yet-created one healthy — so save a desk
  // first, or this breaks nothing and passes for it.
  await call("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 2, layout: "tile", windows: [] }),
  });
  check("a desk was saved, so there is a store file to break", fs.existsSync(STATE_FILE), STATE_FILE);
  fs.chmodSync(LOG_FILE, 0o000);
  fs.chmodSync(STATE_FILE, 0o000);
  // Something has to try to WRITE for the sink to notice; a probe that wrote
  // its own line would be the only thing keeping the retry loop turning.
  await injectFault("exception");
  const broken = await hz();
  check("the log sink reports its own failure", broken?.log?.ok === false, JSON.stringify(broken?.log));
  check(
    "with what was lost while it was down",
    (broken?.log?.droppedLines ?? 0) >= 1,
    JSON.stringify(broken?.log?.droppedLines),
  );
  check("the store reports unhealthy", broken?.store?.ok === false, JSON.stringify(broken?.store?.error));
  check("still degraded rather than down", broken?.status === "degraded" && broken.ok === true, broken?.status);
  const stillReady = await readyz();
  check(
    "/readyz is blind to both (a supervisor must not restart for them)",
    stillReady.code === 200 && stillReady.body?.ready === true,
    String(stillReady.code),
  );
  fs.chmodSync(LOG_FILE, 0o644);
  fs.chmodSync(STATE_FILE, 0o644);

  // --- (e) down means the daemon cannot do its own job ----------------------
  console.log("\n(e) down: the session index");
  fs.chmodSync(SESSIONS_DIR, 0o000);
  const down = await hz();
  check("status is down", down?.status === "down", down?.status);
  check("`ok` is false — the one thing that sets it", down?.ok === false, JSON.stringify(down?.ok));
  const notReady = await readyz();
  check("/readyz answers 503", notReady.code === 503 && notReady.body?.ready === false, String(notReady.code));
  check(
    "and names the directory",
    (notReady.body?.reason ?? "").includes(SESSIONS_DIR),
    notReady.body?.reason ?? "",
  );
  fs.chmodSync(SESSIONS_DIR, 0o700);
  const healed = await hz();
  check(
    "it heals with no restart once the directory comes back",
    healed?.status === "degraded" && healed?.ok === true,
    healed?.status,
  );

  // The other way the index goes: the directory itself is gone. Safe here only
  // because this daemon has no sessions — deleting one with live supervisors in
  // it leaves processes no daemon can ever find (CLAUDE.md), which is the same
  // reason the probe below must not silently put it back.
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  const vanished = await hz();
  check("a vanished index is down too", vanished?.status === "down", vanished?.status);
  // `sessionsDir()` CREATES the directory on first use, so a probe reaching for
  // it would answer ok and leave the daemon recording sessions into a fresh
  // directory that has forgotten everything it was holding. A probe that repairs
  // is a probe that cannot report.
  //
  // Honestly: this one is a LATCH, not a discriminator. `sessionsDir()` latches
  // on `ensured`, which reconcile sets before the port binds, so today it would
  // not recreate the directory either and the mutation fails nothing. Kept
  // because the property is worth holding down if that latch ever moves, and
  // recorded as 0 of 57 in the table above rather than quietly counted as cover.
  check(
    "and the probe did not quietly recreate it",
    !fs.existsSync(SESSIONS_DIR),
    "the health check made its own sessions directory",
  );
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  check("and heals again when it is put back", (await hz())?.status === "degraded");
  await stopDaemon();
}

// --- (f) a tracker this daemon cannot reach ---------------------------------

console.log("\n(f) an unreachable tracker");
if (
  !(await startDaemon({
    tracker: {
      DRYDOCK_TRACKER: "switchyard",
      // Port 9 is discard; nothing is listening on it here, so a connect fails
      // outright rather than hanging.
      DRYDOCK_SWITCHYARD_URL: "http://127.0.0.1:9",
      DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS: "2000",
    },
  }))
) {
  check("daemon starts (unreachable tracker)", false, daemonLog.join("").slice(-400));
} else {
  const before = await hzSafe();
  check("a tracker nobody has asked is not degraded", before?.status === "ok", before?.status);
  const list = await call("/api/tracker/tickets?open=true");
  const after = await hzSafe();
  check(
    "a failed call degrades it",
    list === 502 && after?.tracker?.state === "degraded" && after?.status === "degraded",
    `${list} ${JSON.stringify(after.tracker)}`,
  );
  check("the process itself is not suspect", after?.faults?.total === 0, JSON.stringify(after.faults));
  const r = await readyz();
  check("/readyz is blind to the tracker too", r.code === 200 && r.body?.suspect === false, String(r.code));
  await stopDaemon();
}

// --- (g) fixture data served under a live provider's name -------------------
//
// A live provider that can't be configured falls back to fixture data with one
// warning at boot, after which the sidebar renders five invented tickets and
// looks like a working tracker. Same class of silence as the ticket itself.

console.log("\n(g) a tracker that quietly isn't the configured one");
if (!(await startDaemon({ tracker: { DRYDOCK_TRACKER: "switchyard" } }))) {
  check("daemon starts (fallback tracker)", false, daemonLog.join("").slice(-400));
} else {
  const h = await hzSafe();
  check(
    "the fallback is reported without anybody having to ask the tracker",
    h?.tracker?.state === "degraded" && h?.tracker?.id === "fixture" && h?.tracker?.configured === "switchyard",
    JSON.stringify(h.tracker),
  );
  await stopDaemon();
}

// --- (h) the default posture: exit, and it costs a reattach and nothing else -

console.log("\n(h) the default: exit, because a session outlives the process");
if (!(await startDaemon({ faults: true }))) {
  check("daemon starts (default posture)", false, daemonLog.join("").slice(-400));
} else {
  const id = await spawnSession();
  await injectFault("exception");
  check("the daemon exited", state.daemonExited === true);
  check("nothing answers on the port", (await hz()) === null);
  // The half that makes exiting the right default. The supervisor is not our
  // child (DRY-57), so the agent is still running and a fresh daemon adopts it.
  if (!(await startDaemon())) {
    check("a fresh daemon starts", false, daemonLog.join("").slice(-400));
  } else {
    const h = await hzSafe();
    check(
      "a fresh daemon adopts the session the crash did not kill",
      h?.registry?.sessions === 1 && h?.registry?.live === 1,
      JSON.stringify(h.registry),
    );
    check("and reports itself unsuspicious", h?.faults?.total === 0 && h?.status === "ok", h?.status);
    await call(`/api/sessions/${id}/kill`, { method: "POST" });
    await stopDaemon();
  }
}

// --- (i) when-idle: the posture the boolean could not express ---------------
//
// The pair matters. A policy that exited immediately would pass the second half
// on its own, and one that never exited would pass the first.

console.log("\n(i) when-idle");
if (!(await startDaemon({ onUncaught: "idle", faults: true }))) {
  check("daemon starts (idle posture)", false, daemonLog.join("").slice(-400));
} else {
  const id = await spawnSession();
  await injectFault("exception");
  const armed = await hz();
  check("it stayed up while a session is running", armed !== null);
  check(
    "and says it is only staying for now",
    armed?.faults?.exitWhenIdle === true && armed?.faults?.onUncaught === "when-idle",
    JSON.stringify(armed?.faults),
  );
  check("degraded, with the session still listed", armed?.status === "degraded" && armed?.registry?.live === 1);
  // Past the poll interval, so "still here" means the policy is holding rather
  // than that the timer hasn't fired yet.
  await sleep(IDLE_POLL_MS * 1.5);
  check("still up a poll interval later", (await hz()) !== null && !state.daemonExited);

  await call(`/api/sessions/${id}/kill`, { method: "POST" });
  const deadline = Date.now() + IDLE_POLL_MS * 3;
  while (!state.daemonExited && Date.now() < deadline) await sleep(250);
  check(
    "and exits once nothing is running",
    state.daemonExited === true,
    state.daemonExited ? "" : "still up after 3 poll intervals",
  );
  check(
    "saying why, in the file that outlives it",
    /suspect and idle — exiting/.test(fs.readFileSync(LOG_FILE, "utf8")),
    LOG_FILE,
  );
}

// --- (j) a policy that cannot mean what it says stops the boot --------------
//
// `flag()`'s rule (DRY-27), applied to a knob whose silent misreading either
// wedges a daemon forever or exits one somebody asked to keep.

console.log("\n(j) an unrecognised policy");
{
  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: path.join(REPO, "daemon"),
    env: { ...cleanEnv(), DRYDOCK_PORT: String(PORT + 1), DRYDOCK_EXIT_ON_UNCAUGHT: "Idle!" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout?.on("data", (b: Buffer) => (out += String(b)));
  proc.stderr?.on("data", (b: Buffer) => (out += String(b)));
  // Bounded, and the bound is not politeness: a daemon that DOESN'T refuse
  // starts and serves forever, so an unbounded wait here hangs the file rather
  // than failing it — which is exactly what happens against a tree without this
  // check. Killed either way, since the one that started is a real daemon on a
  // real port.
  const code = await Promise.race([
    new Promise<number | null>((r) => proc.once("exit", (c) => r(c))),
    sleep(15_000).then(() => null),
  ]);
  proc.kill("SIGKILL");
  check("it refuses to start", code === 1, code === null ? "still running after 15s" : `exit ${code}`);
  check(
    "and names the knob and its vocabulary",
    /DRYDOCK_EXIT_ON_UNCAUGHT=Idle!/.test(out) && /idle/.test(out),
    out.split("\n").slice(0, 3).join(" ").slice(0, 200),
  );
}

// --- done -------------------------------------------------------------------

await stopDaemon();
reapSupervisors();
console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
