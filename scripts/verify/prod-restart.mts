// DRY-87: a prod DEPLOY leaves the live agents running.
//
// DRY-57's claim is that killing the daemon does not kill the sessions: each PTY
// is held by its own detached supervisor and the daemon re-adopts them on boot.
// That was true of the daemon PROCESS dying and false of the way prod is
// actually redeployed. `deploy/drydock-daemon.service` set no `KillMode`, so
// systemd's default `control-group` applied and `systemctl --user restart` —
// the last line of `install-prod.sh` — SIGTERMed every process in the unit's
// cgroup. `setsid` gives a process its own session, not its own cgroup, and
// cgroup membership is inherited across fork, so the supervisors were in there
// with the daemon along with every `claude`, login shell and MCP server they
// had spawned. Every deploy, not an unlucky one.
//
// WHY A HARNESS AND NOT A CURL, OR A READING OF THE MANUAL. Two claims, and
// both are about a signal nobody sends explicitly:
//
//   1. `KillMode=process` spares the supervisors. Nothing in the daemon's API
//      changes, so there is no response to assert on — the only evidence is a
//      pid that is still there afterwards and an agent that never noticed.
//   2. A changed `KillMode` applies to an ALREADY-RUNNING unit on
//      `daemon-reload`, rather than waiting for the next start. The whole "the
//      deploy that ships the fix is the first one to benefit" story rests on
//      this, and it is exactly the kind of systemd detail that is easy to
//      assert and wrong. `install-prod.sh` reloads before it restarts, so this
//      file reproduces that order rather than describing it.
//
// It also can't be checked against prod itself: the only honest test of a deploy
// is a deploy, and the host running this has live agents in that cgroup. So the
// rig here is a throwaway unit rendered from the REAL template through the REAL
// renderer (`DRYDOCK_DEPLOY_PRINT_UNIT=1 deploy/install-prod.sh`, which is a
// function in that script for this reason) — a copy of the rendering logic would
// verify the copy.
//
// CONFIRM IT DISCRIMINATES: the control case at the end is not decoration. It
// installs the same unit with the one line taken out, and the supervisor must
// DIE. A run reporting 0 failures with that case passing as "survived" means the
// harness has stopped testing anything — which is the state the whole feature
// was in before this ticket.
//
// RIG: no browser, no database, no second terminal — this file owns its unit.
//   (cd daemon && node --import tsx ../scripts/verify/prod-restart.mts)
// It needs a systemd USER manager (`systemctl --user` must answer) and it leaves
// nothing behind: the unit, its sessions dir and its supervisors are all cleaned
// up on the way out, including after a failure.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";
import type { ClientMessage, ServerMessage } from "../../daemon/src/protocol.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALLER = path.join(REPO, "deploy/install-prod.sh");
const UNIT = "drydock-verify-dry87.service";
const UNIT_FILE = path.join(process.env.HOME ?? "/tmp", ".config/systemd/user", UNIT);
const PORT = Number(process.env.PORT ?? 4387);
const DAEMON = `http://127.0.0.1:${PORT}`;
const WS = DAEMON.replace(/^http/, "ws");
// Short on purpose: these are unix sockets, and the absolute path has ~100 bytes.
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? "/tmp/dry87";
const LOG_FILE = "/tmp/dry87-daemon.log";
const STATE_FILE = "/tmp/dry87-state.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const skip = (n: string, why: string) => console.log(`  SKIP  ${n} — ${why}`);

interface Run {
  code: number;
  out: string;
  err: string;
}
function sh(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Run {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: env ?? process.env });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const systemctl = (...args: string[]): Run => sh("systemctl", ["--user", ...args]);

// --- the rig -----------------------------------------------------------------

/** The unit `install-prod.sh` would install, for a given environment. */
function render(env: NodeJS.ProcessEnv = process.env): Run {
  return sh("bash", [INSTALLER], {
    ...env,
    DRYDOCK_DEPLOY_PRINT_UNIT: "1",
    DRYDOCK_PROD_DIR: REPO,
  });
}

/**
 * The rendered unit, pointed at a throwaway daemon.
 *
 * `killMode: false` is the PRE-DRY-87 unit: the same template with the one line
 * commented out, so the control case differs from the real thing by exactly the
 * fix and nothing else.
 */
function testUnit(unit: string, opts: { killMode: boolean }): string {
  let out = unit;
  if (!opts.killMode) {
    // An absent line is tolerated rather than thrown on. `checkRenderer` is what
    // asserts the template still HAS one, so removing it there — the way to
    // watch this file fail the way the bug did — produces a legible run of
    // failures instead of a crash in the rig, which proves nothing to anybody.
    out = out.replace(/^KillMode=process$/m, "# KillMode=process  <- removed by the harness");
  }
  // The real unit deliberately carries no DRYDOCK_* (prod's config lives in its
  // .env). A throwaway one has no .env to read, so its config is passed here —
  // which changes nothing about the cgroup behaviour under test.
  const extra = [
    `Environment=DRYDOCK_PORT=${PORT}`,
    "Environment=DRYDOCK_HOST=127.0.0.1",
    `Environment=DRYDOCK_SESSIONS_DIR=${SESSIONS_DIR}`,
    `Environment=DRYDOCK_STATE_FILE=${STATE_FILE}`,
    `Environment=DRYDOCK_LOG_FILE=${LOG_FILE}`,
    "Environment=DRYDOCK_TRACKER=fixture",
  ].join("\n");
  const patched = out.replace(/^Environment=PATH=.*$/m, (line) => `${line}\n${extra}`);
  if (patched === out) throw new Error("template has no `Environment=PATH=` line to extend");
  return patched;
}

function install(unit: string): void {
  fs.mkdirSync(path.dirname(UNIT_FILE), { recursive: true });
  fs.writeFileSync(UNIT_FILE, unit);
  systemctl("daemon-reload");
}

/**
 * Every supervisor belonging to THIS harness's daemon.
 *
 * Both filters, per CLAUDE.md: the exe, because the shell running a `pgrep -f
 * supervisor/main` matches its own command line, and the sessions dir, because
 * every other supervisor on this host passes the exe test — they are the same
 * node binary, and killing those ends the agents this file is trying not to be
 * about.
 */
function supervisorPids(): number[] {
  const pids: number[] = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (!fs.readlinkSync(`/proc/${entry}/exe`).includes("node")) continue;
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes("supervisor/main")) continue;
      if (!cmdline.includes(SESSIONS_DIR)) continue;
    } catch {
      continue; // exited between readdir and here, or not ours to read
    }
    pids.push(Number(entry));
  }
  return pids;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function sessions(): Promise<SessionsResponse["sessions"]> {
  try {
    const res = await fetch(`${DAEMON}/api/sessions`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    return ((await res.json()) as SessionsResponse).sessions;
  } catch {
    return [];
  }
}

async function spawnSession(script: string, title: string): Promise<string | undefined> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args: ["-c", script], title, cwd: REPO }),
  });
  const json = (await res.json()) as SpawnResponse & { error?: string };
  if (res.status !== 201 || !json.session?.id) {
    check(`${title} spawned`, false, `${res.status} ${JSON.stringify(json.error ?? json)}`);
    return undefined;
  }
  return json.session.id;
}

/**
 * An attached pane: the scrollback replay, then whatever arrives live.
 *
 * Kept apart because the two answer different questions here. The replay is what
 * SURVIVED the restart — the daemon's ring, rebuilt from the supervisor's on
 * adopt. The live half is what the PTY produces AFTERWARDS, which is the only
 * way to tell a supervisor that is still running from a child that has died
 * behind it: a dead child leaves the socket, the session and the scrollback all
 * looking perfectly healthy.
 */
class Pane {
  replay = "";
  live = "";
  private ws: WebSocket;
  private replayed: Promise<boolean>;

  constructor(id: string) {
    this.ws = new WebSocket(`${WS}/api/sessions/${id}/attach`);
    this.replayed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref?.();
      this.ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        if (msg.type === "replay") {
          this.replay = msg.data;
          clearTimeout(timer);
          resolve(true);
          return;
        }
        if (msg.type === "data") this.live += msg.data;
      };
      // Resolve rather than reject: every call site is a top-level await, and an
      // unhandled rejection would end the run with no FAIL line for the case
      // that failed and every later case silently skipped.
      this.ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  ready(): Promise<boolean> {
    return this.replayed;
  }

  send(data: string): void {
    const msg: ClientMessage = { type: "input", data };
    this.ws.send(JSON.stringify(msg));
  }

  waitLive(marker: string, ms: number): Promise<boolean> {
    return waitFor(() => this.live.includes(marker), ms);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

function daemonLog(): string {
  try {
    return fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return "";
  }
}

/** Everything this harness might have left running, from this run or a previous one. */
function teardown(): void {
  systemctl("stop", UNIT);
  for (const pid of supervisorPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Supervisors FIRST, then the directory: an `rm -rf` on a sessions dir with
  // live supervisors in it deletes the socket and metadata that were the only
  // handle on them, leaving processes no daemon can ever find.
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  fs.rmSync(UNIT_FILE, { force: true });
  fs.rmSync(LOG_FILE, { force: true });
  fs.rmSync(STATE_FILE, { force: true });
  systemctl("daemon-reload");
  systemctl("reset-failed", UNIT);
}

// --- the checks --------------------------------------------------------------

async function checkRenderer(): Promise<string> {
  console.log("\nWhat install-prod.sh would install on this host");
  const real = render();
  check("renders", real.code === 0, real.code === 0 ? "" : real.err.trim().slice(0, 200));
  if (real.code !== 0) return "";

  const exec = /^ExecStart=(\S+)/m.exec(real.out)?.[1] ?? "";
  const unitPath = /^Environment=PATH=(.*)$/m.exec(real.out)?.[1] ?? "";

  check("KillMode=process is in the unit", /^KillMode=process$/m.test(real.out));

  // The fnm trap, and the reason this section exists at all. `command -v node`
  // inside an fnm shell answers /run/user/<uid>/fnm_multishells/<pid>_<ts>/bin,
  // a directory created for that shell and reaped with it. The unit installed on
  // this host when the ticket was filed pointed at one belonging to a shell that
  // had exited days earlier — prod would not have come back from a reboot.
  check(
    "ExecStart's node is not ephemeral",
    exec.startsWith("/") && !/^\/(run|tmp|dev\/shm)\//.test(exec),
    exec,
  );
  check("ExecStart's node exists and runs", fs.existsSync(exec) && sh(exec, ["-v"]).code === 0, exec);
  // Worse in kind than ExecStart, because every spawned agent and shell inherits
  // it: a deploy from an odd shell changes what `claude`, `git` and `bun`
  // resolve to inside every session, and says nothing.
  const ephemeral = unitPath.split(":").filter((e) => /^\/(run|tmp|dev\/shm)\//.test(e));
  check("Environment=PATH has no ephemeral entry", ephemeral.length === 0, ephemeral.join(" "));

  // Now force the shapes this host may not happen to have. `node` has to stay
  // reachable through the doctored PATH or the renderer cannot run at all.
  const nodeDir = path.dirname(exec);
  const fnmish = "/run/user/1000/fnm_multishells/999999_1787000000000/bin";
  const doctoredPath = [fnmish, "/tmp/dry87-fake-bin", nodeDir, "/usr/bin", "/bin", "/usr/bin"].join(":");
  const doctored = render({ ...process.env, PATH: doctoredPath });
  const dPath = /^Environment=PATH=(.*)$/m.exec(doctored.out)?.[1] ?? "";
  const entries = dPath.split(":");
  check("a doctored render still succeeds", doctored.code === 0, doctored.err.trim().slice(0, 200));
  // MAPPED, not dropped: that directory is where node, npm and corepack live for
  // an fnm shell, so deleting it outright would take the toolchain with it.
  check(
    "an fnm multishell dir maps onto the resolved node dir",
    !entries.includes(fnmish) && entries.includes(nodeDir),
    dPath,
  );
  check("an ephemeral entry is dropped", !entries.includes("/tmp/dry87-fake-bin"), dPath);
  check(
    "and dropping it is announced, not silent",
    doctored.err.includes("/tmp/dry87-fake-bin"),
    doctored.err.trim().slice(0, 200),
  );
  check(
    "duplicates collapse",
    entries.filter((e) => e === "/usr/bin").length === 1,
    `/usr/bin x${entries.filter((e) => e === "/usr/bin").length}`,
  );

  // An ephemeral node itself must REFUSE. A hard link is enough to produce one:
  // /proc/self/exe — which is what node reports as process.execPath — names the
  // path the binary was exec'd through, so the link reads as a node living in
  // /tmp without copying 120 MB to make the point.
  const fakeNodeDir = "/tmp/dry87-node-bin";
  let refusal: Run | undefined;
  try {
    fs.mkdirSync(fakeNodeDir, { recursive: true });
    fs.rmSync(`${fakeNodeDir}/node`, { force: true });
    fs.linkSync(exec, `${fakeNodeDir}/node`);
    refusal = render({ ...process.env, PATH: [fakeNodeDir, "/usr/bin", "/bin"].join(":") });
  } catch (err) {
    skip("an ephemeral node is refused", `could not hard-link node into /tmp (${String(err)})`);
  }
  if (refusal) {
    check("an ephemeral node is refused", refusal.code !== 0, `exit ${refusal.code}`);
    check("and the refusal names the path", refusal.err.includes(`${fakeNodeDir}/node`), refusal.err.trim().slice(0, 160));
    // Why install-prod.sh renders to `.new` and moves it into place: a refusal
    // prints NOTHING on stdout, so a plain `render_unit >"$UNIT_FILE"` would
    // have truncated prod's installed unit before failing — a host that cannot
    // start its daemon, reached by a script refusing to make things worse.
    check("and it writes no unit for the redirect to truncate", refusal.out.trim() === "", refusal.out.slice(0, 80));
  }
  fs.rmSync(fakeNodeDir, { recursive: true, force: true });

  // Ordering: printing a unit restarts nothing, so it must not relaunch itself.
  check(
    "printing a unit does not relaunch under systemd-run",
    !real.out.includes("relaunching") && !real.err.includes("relaunching"),
    real.err.trim().slice(0, 120),
  );
  return real.out;
}

/**
 * The deploy's own protection: a deploy run from inside a Drydock session is
 * running in the cgroup it is about to restart.
 *
 * Checked with a stub `systemd-run` on PATH, because the real one would run the
 * real deploy. The guard `exec`s, so the stub replaces the script and nothing
 * past that line ever runs — no clone, no install, no systemctl.
 */
function checkRelaunch(): void {
  console.log("\nA deploy launched from inside a Drydock session");
  const inCgroup = (() => {
    try {
      return fs.readFileSync("/proc/self/cgroup", "utf8").includes("drydock-daemon.service");
    } catch {
      return false;
    }
  })();
  if (!inCgroup) {
    // Not a pass. The predicate under test is cgroup membership, and there is no
    // honest way to fake one from here — run this file from a Drydock session
    // (which is where somebody deploys from, and the whole reason for the guard).
    skip("relaunches into a cgroup of its own", "not running inside a Drydock session");
    return;
  }
  const stubDir = "/tmp/dry87-stub-bin";
  const argvFile = "/tmp/dry87-systemd-run-argv";
  fs.mkdirSync(stubDir, { recursive: true });
  fs.rmSync(argvFile, { force: true });
  fs.writeFileSync(
    `${stubDir}/systemd-run`,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >${argvFile}\nprintf 'DETACHED=%s\\n' "\${DRYDOCK_DEPLOY_DETACHED:-}" >>${argvFile}\nexit 0\n`,
    { mode: 0o755 },
  );
  const deployPath = [stubDir, process.env.PATH ?? ""].join(":");
  const r = sh("bash", [INSTALLER, "some-ref"], {
    ...process.env,
    PATH: deployPath,
    DRYDOCK_PROD_DIR: "/tmp/dry87-prod-dir-that-is-never-touched",
  });
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").split("\n") : [];
  check("relaunches into a cgroup of its own", argv.includes("--user") && argv.includes("--pipe"), r.out.trim().slice(0, 160));
  check("waits for it, and collects it", argv.includes("--wait") && argv.includes("--collect"));
  // Without this the relaunched copy relaunches, forever.
  check("marks the child as already detached", argv.some((a) => a === "--setenv=DRYDOCK_DEPLOY_DETACHED=1"));
  // VERBATIM, and that is the point of asserting on it. A transient unit starts
  // from the user manager's environment, which has neither node nor bun on PATH;
  // and this same PATH is what the relaunched copy renders into the unit, so it
  // has to be the one the operator deployed with, ephemeral entries and all.
  // Sanitising belongs to the renderer, which can map an fnm directory onto the
  // node it resolves to — stripping it here would just take the toolchain away
  // from the deploy.
  check("forwards the deploying shell's PATH, verbatim", argv.includes(`--setenv=PATH=${deployPath}`));
  check("forwards DRYDOCK_PROD_DIR", argv.some((a) => a === "--setenv=DRYDOCK_PROD_DIR=/tmp/dry87-prod-dir-that-is-never-touched"));
  // The args have to survive the hop, or `install-prod.sh v0.1.0` deploys main.
  check("passes the ref through", argv.includes("some-ref"), argv.join(" ").slice(0, 200));
  check("and nothing past the exec ran", !fs.existsSync("/tmp/dry87-prod-dir-that-is-never-touched"));
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.rmSync(argvFile, { force: true });
}

/** Start the unit and wait for the daemon to answer. */
async function start(): Promise<boolean> {
  const r = systemctl("start", UNIT);
  if (r.code !== 0) {
    check("unit starts", false, r.err.trim().slice(0, 200));
    return false;
  }
  return await waitFor(healthy, 20_000);
}

async function main(): Promise<void> {
  if (systemctl("is-system-running").code === -1) {
    console.error("no `systemctl --user` on this host — nothing here can run");
    process.exit(1);
  }
  teardown(); // whatever a previous run left

  const rendered = await checkRenderer();
  if (!rendered) {
    teardown();
    process.exit(1);
  }
  checkRelaunch();

  // --- the deploy ------------------------------------------------------------
  //
  // Reproduced in install-prod.sh's order, from the state prod was actually in:
  // a unit ALREADY RUNNING under the old default, then render, then
  // daemon-reload, then restart. Starting it with the fix already in place would
  // test a much weaker claim and hide the one that matters.
  console.log("\nA deploy, with a live session running");
  install(testUnit(rendered, { killMode: false }));
  if (!(await start())) {
    check("throwaway daemon is up (pre-fix unit)", false, "never answered /healthz");
    teardown();
    process.exit(1);
  }
  check("throwaway daemon is up (pre-fix unit)", true, `:${PORT}`);

  const marker = `DRY87-BEFORE-${process.pid}`;
  // `cat` keeps the PTY open and echoes: the second half of the proof is that
  // this child is still THERE afterwards, not just that its supervisor is.
  const id = await spawnSession(`echo ${marker}; exec cat`, "dry87");
  if (!id) {
    teardown();
    process.exit(1);
  }
  const before = new Pane(id);
  check("session attaches", await before.ready());
  check("its output arrives", await waitFor(() => (before.replay + before.live).includes(marker), 5_000), marker);
  before.close();

  const supervisors = supervisorPids();
  check("a supervisor is holding it", supervisors.length > 0, `pids ${supervisors.join(",") || "none"}`);
  const logBefore = daemonLog().length;

  // Exactly what install-prod.sh does, in exactly that order.
  install(testUnit(rendered, { killMode: true })); // renders + daemon-reload
  check(
    "systemd now reports the reloaded KillMode",
    systemctl("show", UNIT, "-p", "KillMode", "--value").out.trim() === "process",
  );
  const restart = systemctl("restart", UNIT);
  check("the unit restarts", restart.code === 0, restart.err.trim().slice(0, 200));

  // THE CLAIM. Not "eventually true": the supervisors are either signalled by
  // the restart or they are not, so this is read straight after it.
  const survived = supervisors.filter(alive);
  check(
    "the supervisors survived the restart",
    survived.length === supervisors.length,
    `${survived.length}/${supervisors.length} alive`,
  );

  check("the daemon comes back", await waitFor(healthy, 20_000));
  check(
    "and re-adopts the session",
    await waitFor(async () => (await sessions()).some((s) => s.id === id && s.status === "running"), 15_000),
    id,
  );
  // The ticket's "done when" names this line specifically: the daemon SAYING it
  // adopted, rather than a session that merely reappeared.
  check(
    "the daemon logs the adoption",
    daemonLog().slice(logBefore).includes("session adopted after a daemon restart"),
    (daemonLog().slice(logBefore).match(/session adopted[^\n]*/) ?? [""])[0].slice(0, 120),
  );

  const after = new Pane(id);
  check("the session re-attaches", await after.ready());
  // The scrollback crossed the restart with it, so the pane is not blank.
  check("its scrollback survived", after.replay.includes(marker), `${after.replay.length}B replay`);
  // And the CHILD is alive, not just the supervisor: a dead child leaves the
  // socket, the session record and the scrollback all looking healthy.
  const ping = `DRY87-AFTER-${process.pid}`;
  after.send(`echo ${ping}\n`);
  check("and the PTY is still driveable", await after.waitLive(ping, 5_000), ping);
  after.close();

  // --- the control -----------------------------------------------------------
  //
  // The same rig with the one line taken out. If this passes as "survived", the
  // rest of this file is measuring nothing. Started fresh rather than reloaded
  // back, so the pre-fix config is unambiguously in effect for the stop.
  console.log("\nControl: the same deploy without KillMode=process");
  systemctl("stop", UNIT);
  install(testUnit(rendered, { killMode: false }));
  if (!(await start())) {
    check("control daemon is up", false, "never answered /healthz");
    teardown();
    process.exit(1);
  }
  check("control daemon is up", true, `KillMode=${systemctl("show", UNIT, "-p", "KillMode", "--value").out.trim()}`);
  const controlId = await spawnSession(`echo DRY87-CONTROL; exec cat`, "dry87-control");
  const controlPids = controlId ? supervisorPids() : [];
  check("a supervisor is holding it", controlPids.length > 0, `pids ${controlPids.join(",") || "none"}`);
  systemctl("restart", UNIT);
  await sleep(1_000); // SIGTERM, then the supervisor's own teardown
  const stillUp = controlPids.filter(alive);
  check(
    "its supervisors are killed by the restart (the bug)",
    controlPids.length > 0 && stillUp.length === 0,
    `${stillUp.length}/${controlPids.length} still alive`,
  );

  teardown();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on("unhandledRejection", (err) => {
  console.error("harness error:", err);
  teardown();
  process.exit(1);
});

await main();
