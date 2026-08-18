// DRY-66: `POST /api/sessions` forwards `body.env`, and refuses what it can't.
//
// Two claims, and only one of them is about the route's status code.
//
// The first is that a value ARRIVES — in the PTY, three hops from the request,
// past session.ts's spread and past the supervisor's DRY-59 strip. A 201 proves
// none of that; the daemon answered 201 to a body carrying `env` for the whole
// time the field was being dropped on the floor, which is what the ticket is.
// So the session writes its own environment to a file and this reads it back
// through the daemon: the bytes asserted on can only have come from `execve`.
//
// The second is that a refusal is a refusal — 400 with the key named, and NO
// session started. The dangerous shape of a guard like this is one that answers
// 400 after `manager.create`, or after the worktree block's side effects, so
// the session count is checked alongside every status code.
//
// No browser and no state store: everything here is the daemon's own HTTP.
//
// RIG (throwaway daemon, per CLAUDE.md's second-instance pattern):
//   cd daemon
//   DRYDOCK_PORT=4366 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d66 \
//     DRYDOCK_STATE_FILE=/tmp/dry66-state.json node --import tsx src/index.ts
// then, from another terminal:
//   (cd daemon && node --import tsx ../scripts/verify/spawn-env.mts)
// and afterwards kill the supervisors it left behind — CLAUDE.md's loop over
// /proc/<pid>/exe, never `pkill -f supervisor/main`.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4366";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

interface ErrorResponse {
  error?: string;
}
interface FileResponse {
  path?: string;
  content?: string;
  error?: string;
}

async function post(
  body: unknown,
): Promise<{ status: number; json: SpawnResponse & ErrorResponse }> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as SpawnResponse & ErrorResponse };
}
const count = async (): Promise<number> =>
  ((await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse).sessions.length;

/**
 * A refused spawn, asserted on the code, the message, and the session count.
 *
 * The count is the half that catches a guard placed too late: `manager.create`
 * is awaited, so a 400 issued after it would leave a real PTY behind and every
 * message assertion here would still pass.
 */
async function refused(
  name: string,
  envField: unknown,
  mentions: RegExp,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const before = await count();
  const { status, json } = await post({
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    env: envField,
    ...extra,
  });
  const after = await count();
  check(
    `${name} -> 400`,
    status === 400 && mentions.test(json.error ?? ""),
    `${status} ${JSON.stringify(json.error ?? json)}`,
  );
  check(`${name} started nothing`, after === before, `${before} -> ${after}`);
}

// --- 1. it arrives ----------------------------------------------------------

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dry66-"));
console.log(`\nDRY-66 spawn env — daemon ${DAEMON}, cwd ${cwd}`);

// The env goes to a .txt because that is what the file route will serve, and
// the session then SLEEPS: a process that exits takes its cwd off the registry,
// and the read below needs the session still there to resolve one.
const spawned = await post({
  command: "/bin/sh",
  args: ["-c", "env > env.txt; sleep 30"],
  cwd,
  title: "dry66",
  env: {
    DRY66_MARKER: "value-from-the-request-body",
    // A value with spaces and an `=` in it: the environ array is `KEY=VALUE`
    // strings, so a naive join is how a value like this loses its tail.
    DRY66_TRICKY: "a b=c  d",
  },
});
check("spawn accepted", spawned.status === 201, `${spawned.status} ${JSON.stringify(spawned.json)}`);
const id = spawned.json.session?.id;
if (!id) {
  console.log("\n  no session id — nothing further can be asserted\n");
  process.exit(1);
}
await sleep(1200);

const file = (await (
  await fetch(`${DAEMON}/api/sessions/${id}/file?path=env.txt`)
).json()) as FileResponse;
const lines = (file.content ?? "").split("\n");
const got = (key: string): string | undefined => {
  const hit = lines.find((l) => l.startsWith(`${key}=`));
  return hit === undefined ? undefined : hit.slice(key.length + 1);
};

check(
  "the PTY has the forwarded value",
  got("DRY66_MARKER") === "value-from-the-request-body",
  JSON.stringify(got("DRY66_MARKER") ?? file.error ?? null),
);
check(
  "a value with spaces and = survives whole",
  got("DRY66_TRICKY") === "a b=c  d",
  JSON.stringify(got("DRY66_TRICKY") ?? null),
);
// The daemon's own channel is still the daemon's: its four keys are spread
// AFTER the caller's map, and the deny set refuses the prefix outright, so this
// is the half of that claim that can be read off a live PTY.
check(
  "the daemon's own keys are intact",
  got("DRYDOCK_SESSION_ID") === id,
  got("DRYDOCK_SESSION_ID") ?? "unset",
);
check(
  "the session key is a uuid the caller never chose",
  /^[0-9a-f-]{36}$/.test(got("DRYDOCK_SESSION_KEY") ?? ""),
  got("DRYDOCK_SESSION_KEY") ?? "unset",
);
// Not an env assertion so much as the one that says the strip still runs after
// all of this. Only meaningful when the daemon was itself started from inside a
// claude session (DRY-59 trap 1) — from a bare terminal there is nothing to
// inherit and it would pass against a deleted strip, so it is REPORTED rather
// than counted as a pass.
const leaked = lines.filter((l) =>
  /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)/.test(l),
);
console.log(
  `  NOTE  claude markers in the PTY: ${leaked.length === 0 ? "none" : leaked.join(", ")}` +
    " (only meaningful if this daemon was started from inside a claude session)",
);
await fetch(`${DAEMON}/api/sessions/${id}/kill`, { method: "POST" });
fs.rmSync(cwd, { recursive: true, force: true });

// --- 2. what is refused -----------------------------------------------------

console.log("\nrefusals");

// The first refusal carries a ticket and a git cwd, which is what puts the
// DRY-15 worktree block in play. That block RUNS things — it creates a branch
// and checks out a worktree — and it sits upstream of where a `body` guard
// naturally wants to live. A branch here means the guard was placed below it
// and a refused spawn left work on disk. Everything else about the refusal is
// identical, so this is one assertion, not a second suite.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dry66-repo-"));
const git = (...a: string[]): string =>
  execFileSync("git", ["-C", repo, "-c", "user.email=v@drydock", "-c", "user.name=verify", ...a], {
    encoding: "utf8",
  });
git("init", "-q");
fs.writeFileSync(path.join(repo, "README.md"), "dry66\n");
git("add", "-A");
git("commit", "-qm", "seed");
const branchesBefore = git("branch", "--list");

await refused("PATH", { PATH: "/tmp/shim" }, /PATH/, { cwd: repo, ticket: "DRY-66" });
check(
  "a refused spawn creates no worktree branch",
  git("branch", "--list") === branchesBefore,
  JSON.stringify(git("branch", "--list")),
);
fs.rmSync(repo, { recursive: true, force: true });

await refused("LD_PRELOAD", { LD_PRELOAD: "/tmp/evil.so" }, /LD_PRELOAD/);
await refused("NODE_OPTIONS", { NODE_OPTIONS: "--require /tmp/x.js" }, /NODE_OPTIONS/);
await refused("BASH_ENV", { BASH_ENV: "/tmp/rc" }, /BASH_ENV/);
// The daemon's own namespace, including the key a session would answer its own
// permission gates with (DRY-27). The spread order already beats it; refusing
// makes the attempt loud rather than inert.
await refused("DRYDOCK_SESSION_KEY", { DRYDOCK_SESSION_KEY: "mine" }, /DRYDOCK_SESSION_KEY/);
// DRY-59's strip would delete this three hops later with nothing said. The
// message has to name the strip, or the caller reads "refused" and goes hunting
// for a policy knob that doesn't exist.
await refused(
  "a stripped claude marker",
  { CLAUDE_CODE_SSE_PORT: "12345" },
  /CLAUDE_CODE_SSE_PORT[\s\S]*DRY-59/,
);
await refused("a lowercase key", { subtask: "x" }, /subtask/);
await refused("a key with =", { "A=B": "x" }, /A=B/);
await refused("a non-string value", { DRY66_N: 1 }, /DRY66_N[\s\S]*string/);
await refused("an object value", { DRY66_O: { a: 1 } }, /DRY66_O[\s\S]*string/);
// Built rather than written as an escape, and never as the byte itself: a
// literal NUL in a source file makes it binary to git — no diff, no blame, no
// grep — and nothing but review notices.
await refused("a NUL in a value", { DRY66_Z: `a${String.fromCharCode(0)}b` }, /DRY66_Z[\s\S]*NUL/);
await refused("an array", ["A=B"], /object/);
await refused(
  "too many keys",
  Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`DRY66_K${i}`, "x"])),
  /65 keys/,
);
await refused("an oversized value", { DRY66_BIG: "x".repeat(4097) }, /4097 bytes/);

// The empty cases are NOT refusals: a client that always sends the field must
// not have to special-case having nothing to put in it.
for (const [name, value] of [
  ["omitted", undefined],
  ["null", null],
  ["empty", {}],
] as const) {
  const { status, json } = await post({ command: "/bin/sh", args: ["-c", "sleep 5"], env: value });
  check(`env ${name} still spawns`, status === 201, `${status} ${JSON.stringify(json.error ?? "")}`);
  if (json.session?.id) {
    await fetch(`${DAEMON}/api/sessions/${json.session.id}/kill`, { method: "POST" });
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
