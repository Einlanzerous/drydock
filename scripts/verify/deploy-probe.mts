// DRY-81: the deploy's health check tells "answered" apart from "authorized".
//
// `install-prod.sh` ends by polling the daemon it has just restarted. That poll
// was `curl -fsS .../api/sessions`, and `-f` exits non-zero on 4xx — so on a
// host with DRYDOCK_AUTH_PASSWORD set, the route's CORRECT 401 to an anonymous
// caller read as "daemon not answering". Every deploy printed
//
//   error: daemon not answering on :4318 — check: journalctl --user -u …
//
// and exited 1, over a daemon that was up and serving. The cost is not the
// wrong sentence: the exit status propagates to anything wrapping the script,
// and the sentence sends somebody to go poking at a prod daemon holding live
// agent PTYs. It only appears once auth is on, which is the host where a deploy
// is least casual — and the first install is clean, because auth isn't
// configured yet, so it arrives with the SECOND deploy.
//
// WHY A HARNESS. Three reasons, and the first is that the bug is invisible from
// everywhere except a host in a posture no unit test arranges:
//
//   1. The claim is about a REAL 401 from a REAL route. A stub answering 401
//      would be testing this file's idea of the daemon's auth posture — which
//      is exactly the guess that produced the bug. So both postures here are a
//      real daemon, and each one's status code is asserted BEFORE the probe is
//      run against it: if `/api/sessions` ever stops answering 401 anonymously,
//      this file must say the premise moved rather than pass on quietly.
//   2. The fix's failure mode is the mirror of the bug. "Any HTTP response means
//      it's up" also cures the false failure — and then reports a successful
//      deploy when an nginx with a dead upstream is sitting on the port and prod
//      is down. Nor is rejecting 5xx enough on its own: a stray web server's
//      plain 200 page is indistinguishable from the daemon by status code, so
//      the probe reads a field out of the body and the squatters below include
//      one answering 200. That third case is review's; the first version of
//      this file tested 404 and 503, neither of which can catch it.
//   3. The probe had no timeout at all, so a listener that accepts and never
//      answers hung the deploy forever with nothing on stdout. That is a claim
//      about wall-clock, which curl can't express and reading can't confirm.
//
// WHAT IT DRIVES. `DRYDOCK_DEPLOY_PROBE=1 deploy/install-prod.sh` — a mode of
// the real script that resolves the port and runs the real probe, then exits
// having touched nothing. Same argument as DRY-87's `DRYDOCK_DEPLOY_PRINT_UNIT`:
// a harness that reimplemented the curl would verify its own copy. The mode is
// bound to the deploy path it stands in for by the static checks at the end —
// they are what catches a second, differently-spelled curl being added to the
// tail.
//
// CONFIRM IT DISCRIMINATES. Four mutations of `probe_daemon`, each measured
// rather than counted by hand, and each failing a different section — which is
// the point of having four:
//
//   accept only 200 (the ticket's bug)          3 of 23, all in "auth on"
//   accept any HTTP response (the overcorrect)  6 of 23, every squatter check
//   accept on the status code alone             2 of 23, the 200 squatter
//   drop `-m 5` from the curl (unbounded)       2 of 23, the black-hole pair
//
// RIG: no browser, no database, no systemd, no second terminal — this file owns
// its daemons.
//   node --import tsx scripts/verify/deploy-probe.mts
// It takes :4381 (override with PORT=) plus one ephemeral port and /tmp/dry81*,
// and cleans up on the way out including after a failure. About a minute, most
// of it the probes that are SUPPOSED to wait.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Detail, SessionsResponse } from "./api.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = path.join(REPO, "deploy/install-prod.sh");
const PORT = Number(process.env.PORT ?? 4381);
const DAEMON = `http://127.0.0.1:${PORT}`;
const SCRATCH = "/tmp/dry81";
const PROD_DIR = path.join(SCRATCH, "prod");
const STUB_BIN = path.join(SCRATCH, "bin");
const STUB_MARKER = path.join(SCRATCH, "stubs-invoked");
const PASSWORD = "dry81-throwaway-password";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

// The dev daemon is on :4317 and prod on :4318, and both of them hold live
// agent PTYs. Nothing here writes, but every probe below is aimed by a .env
// this file wrote, and a default that quietly resolved to prod would make the
// auth-on case pass by testing somebody's running deployment. Refuse instead —
// DRY-90's harnesses take the same line about their worktrees root.
if (PORT === 4317 || PORT === 4318) {
  console.error(`refusing to run against :${PORT} — that is a real daemon's port`);
  process.exit(1);
}

/**
 * `process.env` with every `DRYDOCK_*` key removed.
 *
 * CLAUDE.md's `env -u` sweep, and it is not optional here: this file is most
 * likely to be run from inside a Drydock session, which inherits the daemon
 * that spawned it — so a "throwaway" daemon started from one comes up on PROD's
 * Postgres and PROD's auth password. That would 401 the auth-OFF case, i.e. the
 * one control this file has, and it would do it while looking like a pass of
 * the auth-ON case.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("DRYDOCK_")) out[k] = v;
  }
  return out;
}

// --- the rig -----------------------------------------------------------------

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
  ms: number;
}

/**
 * Run the real installer in probe mode.
 *
 * ASYNC, and it has to be: `spawnSync` blocks this process's event loop for the
 * whole probe, so the squatter servers below — which live in this process —
 * accepted curl's connection into the kernel backlog and then never answered
 * it. Every squatter case reported "no HTTP response" and passed for the wrong
 * reason, having tested the black-hole path twice instead.
 *
 * `PATH` is prefixed with stubs for every command the script would reach if the
 * probe block stopped exiting — `systemctl` above all, since the real one would
 * restart THIS host's prod unit and take its agents' cgroup with it on any
 * checkout older than DRY-87. They record that they ran; the last check in this
 * file asserts none of them ever did.
 */
function probe(prodDir: string, timeoutMs = 90_000): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", [INSTALLER], {
      env: {
        ...cleanEnv(),
        PATH: `${STUB_BIN}:${process.env.PATH ?? ""}`,
        DRYDOCK_DEPLOY_PROBE: "1",
        DRYDOCK_PROD_DIR: prodDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += String(b)));
    child.stderr.on("data", (b: Buffer) => (err += String(b)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, ms: Date.now() - started });
    });
  });
}

/** A prod-dir-shaped directory holding nothing but a `.env` naming a port. */
function prodDirOn(port: number, dir = PROD_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), `DRYDOCK_PORT=${port}\n`);
  return dir;
}

let daemon: ChildProcess | null = null;
/** The daemon's stderr, for the case where it never comes up at all. */
const log: string[] = [];

/**
 * A throwaway daemon on PORT, in one of the two postures.
 *
 * The empty pins are the other half of `cleanEnv`: `env.ts` walks up from the
 * daemon's cwd and applies any key of the CHECKOUT's `.env` that isn't already
 * in the environment, so on a host that has run `bun run db:up` or set a
 * password there, the auth-off daemon would not be auth-off. An empty string
 * counts as present (`key in process.env`), which is the only way to say "no"
 * to that loader.
 */
async function startDaemon(auth: string | null): Promise<boolean> {
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    DRYDOCK_PORT: String(PORT),
    DRYDOCK_HOST: "127.0.0.1",
    DRYDOCK_SESSIONS_DIR: `${SCRATCH}/s`,
    DRYDOCK_STATE_FILE: `${SCRATCH}/state.json`,
    DRYDOCK_WORKTREES_ROOT: `${SCRATCH}/wt`,
    DRYDOCK_TRACKER: "fixture",
    DRYDOCK_DATABASE_URL: "",
    DRYDOCK_MULTI_USER: "",
    DRYDOCK_AUTH_PASSWORD_HASH: "",
    DRYDOCK_AUTH_PASSWORD: auth ?? "",
  };
  daemon = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: path.join(REPO, "daemon"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", () => {});
  daemon.stderr?.on("data", (b: Buffer) => log.push(String(b)));
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const code = await status(`${DAEMON}/api/sessions`);
    if (code) return true;
  }
  return false;
}

async function stopDaemon(): Promise<void> {
  if (!daemon) return;
  const proc = daemon;
  daemon = null;
  const ended = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  await Promise.race([ended, sleep(5_000)]);
  // The port has to be genuinely free before the squatter cases bind it.
  for (let i = 0; i < 50; i++) {
    if (!(await status(`${DAEMON}/api/sessions`))) return;
    await sleep(100);
  }
}

/** The HTTP status of a GET, or 0 if nothing answered. */
async function status(url: string): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status;
  } catch {
    return 0;
  }
}

/** Something on PORT that is not a Drydock daemon, answering one status code. */
function squatter(code: number, body: string): Promise<http.Server> {
  return listening(
    http.createServer((_req, res) => {
      res.writeHead(code, { "Content-Type": "text/html" });
      res.end(body);
    }),
  );
}

/**
 * A listener that accepts and then says nothing, ever — the case the probe used
 * to hang the whole deploy on, since it had no timeout.
 *
 * No connection handler at all: `net.createServer()` accepts and leaves the
 * socket open, which is the shape being tested. `listening` does the bookkeeping.
 */
const blackHole = (): Promise<net.Server> => listening(net.createServer());

/** Sockets each server has accepted, so `closeServer` can end them. */
const accepted = new WeakMap<http.Server | net.Server, Set<net.Socket>>();

/**
 * Bind on PORT, or say why not, and remember what connects.
 *
 * Two things learned the hard way here, both of which presented as the same
 * `ERR_UNSETTLED_TOP_LEVEL_AWAIT` with nothing said about a port:
 *
 *  - A server that FAILS to bind (the daemon before it not having let go yet)
 *    leaves its promise pending forever. Hence the `error` rejection.
 *  - `server.close()` stops the listener but waits on connections that are
 *    already open, and curl leaves one behind on every timed-out attempt. So
 *    the sockets are tracked and destroyed rather than waited on — the black
 *    hole's whole point is that nothing there is ever going to close politely.
 */
function listening<T extends http.Server | net.Server>(server: T): Promise<T> {
  const sockets = new Set<net.Socket>();
  accepted.set(server, sockets);
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  for (const socket of accepted.get(server) ?? []) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Can this process bind `port` on loopback right now? */
function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probeSocket = net.createServer();
    probeSocket.once("error", () => resolve(false));
    probeSocket.listen(port, "127.0.0.1", () => probeSocket.close(() => resolve(true)));
  });
}

/**
 * A port the kernel says is free, for the "it reads the .env" case.
 *
 * NOT `PORT + 1`, which is what this was and what the harness's first green run
 * was measuring: this host runs several agents at once, each with a throwaway
 * daemon somewhere in the 43xx range, and :4382 turned out to hold one. The
 * check then read "a .env naming another port probes THAT port — exit 0",
 * because the probe found somebody else's perfectly healthy daemon.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
  });
}

function setUp(): void {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(STUB_BIN, { recursive: true });
  for (const name of ["systemctl", "git", "bun", "systemd-run"]) {
    const p = path.join(STUB_BIN, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${name} $*" >>"${STUB_MARKER}"\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  }
}

async function teardown(): Promise<void> {
  await stopDaemon();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

// --- the checks ---------------------------------------------------------------

async function main(): Promise<void> {
  setUp();
  console.log(`\nDRY-81 deploy probe — installer ${INSTALLER}, daemon :${PORT}`);

  // Every claim below is about what is on this port, so somebody else's daemon
  // sitting on it does not make this file fail — it makes it lie. Refuse.
  if (!(await bindable(PORT))) {
    console.error(`:${PORT} is already in use — pass PORT=<free port> or stop what is on it`);
    await teardown();
    process.exit(1);
  }

  // --- 1. auth off: what the first install sees -------------------------------
  console.log("\nAuth off (the posture the first install runs in)");
  if (!(await startDaemon(null))) {
    check("daemon is up", false, log.join("").slice(-400));
    await teardown();
    process.exit(1);
  }
  const anonOff = await fetch(`${DAEMON}/api/sessions`);
  const body = (await anonOff.json()) as SessionsResponse;
  // Asserted on the body as well as the code, because the whole hazard on this
  // route is a status code that came from something other than the daemon.
  check(
    "rig: /api/sessions answers 200 anonymously",
    anonOff.status === 200 && Array.isArray(body.sessions),
    `${anonOff.status} ${JSON.stringify(body).slice(0, 60)}`,
  );

  const off = await probe(prodDirOn(PORT));
  check("the probe succeeds", off.code === 0, `exit ${off.code} ${off.err.trim()}`);
  check(
    "and says which port and what it saw",
    new RegExp(`:${PORT}\\b`).test(off.out) && /\b200\b/.test(off.out),
    off.out.trim(),
  );

  // The port comes from the .env the deploy just seeded, not from a guess. Same
  // daemon, still running: only the .env moves.
  const idle = await freePort();
  const wrong = (await bindable(idle))
    ? await probe(prodDirOn(idle, path.join(SCRATCH, "prod-wrong")))
    : null;
  check(
    "a .env naming another port probes THAT port",
    wrong !== null && wrong.code !== 0 && wrong.err.includes(`:${idle}`),
    wrong ? `exit ${wrong.code} ${wrong.err.trim()}` : `:${idle} was taken between picking it and using it`,
  );

  // --- 2. auth on: the ticket -------------------------------------------------
  console.log("\nAuth on (the posture every deploy after the first runs in)");
  await stopDaemon();
  if (!(await startDaemon(PASSWORD))) {
    check("daemon is up with auth on", false, log.join("").slice(-400));
    await teardown();
    process.exit(1);
  }
  const anonOn = await status(`${DAEMON}/api/sessions`);
  // The premise. If this stops being 401 — a route moved behind a different
  // code, a posture renamed — everything below is testing nothing, so it has to
  // fail here rather than further down.
  //
  // This is the `single` tier. The claim the probe rests on is that `multi`
  // answers an anonymous caller identically, and that half is REASONED rather
  // than measured here: `multi` needs Postgres, which this file deliberately
  // does not take. The reasoning is that `Auth.identify` returns `anonymous`
  // before `stillValid` can reach `store.users` (daemon/src/auth/index.ts), so
  // no store outage and no `needsSetup` state can move the code off 401 — but
  // CLAUDE.md's DRY-27 section is emphatic that the three postures are
  // different code paths, so do not read this line as covering all of them.
  check("rig: /api/sessions answers 401 anonymously (single)", anonOn === 401, String(anonOn));

  // THE CONTROL, and it runs on every invocation. This is the exact command the
  // script used to end with; against this daemon it must FAIL, or the posture
  // above isn't real and the check below passes for the wrong reason.
  const old = spawnSync("curl", ["-fsS", `${DAEMON}/api/sessions`], { encoding: "utf8" });
  check(
    "control: the old `curl -f` probe fails against it (the bug)",
    old.status !== 0,
    `exit ${old.status}`,
  );

  const on = await probe(prodDirOn(PORT));
  check("the probe succeeds anyway", on.code === 0, `exit ${on.code} ${on.err.trim()}`);
  check("and reports the 401 as an answer", /401/.test(on.out), on.out.trim());
  // A deploy that succeeds must be silent on stderr: the error line is what
  // sends somebody to journalctl over a healthy prod daemon.
  check("and writes nothing to stderr", on.err.trim() === "", on.err.trim());

  // --- 3. it still fails when it should ---------------------------------------
  console.log("\nAnd still fails when the daemon really is missing");
  await stopDaemon();
  const dead = await probe(prodDirOn(PORT));
  check("nothing listening -> the probe fails", dead.code === 1, `exit ${dead.code}`);
  check(
    "and says there was no response at all",
    /no HTTP response/.test(dead.err),
    dead.err.trim(),
  );

  // The other half of the fix, and it is the half a naive one gets wrong twice
  // over. "Any HTTP response means it's up" cures the ticket and then reports a
  // healthy deploy while prod is down behind a proxy — 502/503/504 is precisely
  // what a reverse proxy with a dead upstream answers. And rejecting 5xx is not
  // enough on its own (review's find on the first version of this file, which
  // tested only 404 and 503): a plain 200 page is what a stray web server
  // serves, and no status code can tell it from the daemon. This is a real
  // deploy-path case rather than a lab one — if anything is already holding
  // :4318 the daemon loses the bind and exits, so the squatter is what answers
  // the probe.
  const squatters = [
    { code: 404, body: "nope\n", what: "a proxy with no route" },
    { code: 503, body: "nope\n", what: "a proxy with a dead upstream" },
    {
      code: 200,
      body: "<html><body><h1>Welcome to nginx!</h1></body></html>",
      what: "a stray web server",
    },
  ];
  for (const sq of squatters) {
    const server = await squatter(sq.code, sq.body);
    const squat = await probe(prodDirOn(PORT));
    await closeServer(server);
    check(
      `${sq.what} answering ${sq.code} -> the probe fails`,
      squat.code === 1,
      `exit ${squat.code}`,
    );
    check(
      `and names the ${sq.code} rather than blaming the daemon`,
      new RegExp(`${sq.code}`).test(squat.err) && /not as a Drydock daemon/.test(squat.err),
      squat.err.trim(),
    );
  }

  // --- 4. and cannot hang the deploy ------------------------------------------
  console.log("\nAnd is bounded when the port accepts but never answers");
  const hole = await blackHole();
  const hung = await probe(prodDirOn(PORT));
  await closeServer(hole);
  // Without `-m` on the curl this never returns, and the harness's own 90s
  // timer is what ends it — which shows up as a SIGKILL and no status, hence
  // asserting on both.
  check(
    "a black-hole listener -> the probe gives up",
    hung.code === 1 && hung.signal === null,
    `exit ${hung.code} signal ${hung.signal}`,
  );
  check("and does so in under a minute", hung.ms < 60_000, `${(hung.ms / 1000).toFixed(1)}s`);

  // --- 5. the mode is the deploy's own probe ----------------------------------
  //
  // Everything above drives DRYDOCK_DEPLOY_PROBE. That is a mode of the real
  // script rather than a copy of it, but nothing so far would notice a SECOND,
  // differently-spelled curl being added to the deploy tail — which is the
  // shape this bug had. These read the script.
  console.log("\nThe deploy path and the probed path are the same code");
  const src = fs.readFileSync(INSTALLER, "utf8");
  // Comment lines are stripped first. The script now EXPLAINS the old
  // `curl -fsS` at length, so a naive grep over the whole file counts the
  // history as three live invocations and reports the fix as absent.
  const live = src
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const curls = live.match(/\bcurl\b/g) ?? [];
  check("the script contains exactly one curl", curls.length === 1, `${curls.length} found`);
  // A style guard, and worth saying which: in THIS shape `-f` would not even
  // reproduce the ticket. Measured on curl 8.5.0 — `-f -w '%{http_code}'`
  // against a 401 still prints 401 and merely exits 22, which the `|| true`
  // swallows. What the flag would bring back is the old IDIOM (`if curl -fsS
  // …; then`), and that is what this refuses. The behavioural guard is the
  // live 401 above.
  check(
    "and it does not pass -f/--fail",
    !/curl[^\n]*(\s-[a-zA-Z]*f[a-zA-Z]*\b|--fail)/.test(live),
    (live.match(/curl[^\n]*/) ?? [""])[0].trim(),
  );
  check(
    "the deploy tail calls probe_daemon",
    /if\s+CODE="\$\(probe_daemon\s+"\$PORT"\)"/.test(live),
    (live.match(/^.*probe_daemon "\$PORT".*$/m) ?? [""])[0].trim(),
  );

  // Probing restarts nothing. If the mode ever stops exiting, the script runs
  // on into a clone, an install and a `systemctl --user restart
  // drydock-daemon.service` — this host's real prod unit.
  const invoked = fs.existsSync(STUB_MARKER) ? fs.readFileSync(STUB_MARKER, "utf8").trim() : "";
  // The marker is the whole check. A sibling asserting `$PROD_DIR/.git` is
  // absent was here and is gone: the stub `git` exits 0 without cloning, so
  // that directory could not appear under any mutation of the installer, and a
  // check that cannot fail is worse than none (review).
  check("no probe run reached git, bun or systemctl", invoked === "", invoked.slice(0, 200));

  await teardown();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on("unhandledRejection", async (err) => {
  console.error("harness error:", err);
  await teardown();
  process.exit(1);
});

await main();
