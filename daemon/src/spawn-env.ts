// Per-spawn environment variables, validated (DRY-66).
//
// `SpawnOptions.env` and the PTY env spread have always existed; what was
// missing was the HTTP handler reading `body.env`, so the sink was wired and
// nothing filled it. A caller that wanted to hand one run a value — an assigned
// subtask key, a subpath scoping an agent to one subtree — had to compose a file
// per spawn and smuggle its path through `args`, which works but leaves the
// contract in a temp dir instead of beside the work.
//
// WHAT THIS LIST IS, AND WHAT IT IS NOT. It is not a security boundary and must
// not be sold as one: the same request body carries `command` and `args`, so
// this route has always been remote code execution by design (README's "what
// this port is"). Nothing here narrows that, and a longer deny set would not
// either — every interpreter ships its own code-injection variable, so a
// blocklist aiming at "dangerous" can only ever be a list of the ones somebody
// remembered.
//
// It draws a narrower line, which it can actually hold: a caller may not reach
// the machinery the DAEMON runs the session with. Two things hang off that.
//
//  1. The daemon resolves `claude` and `shell` to a BARE executable name
//     (`resolveSpawn` in session.ts) and its DRY-27 hooks call back with a bare
//     `curl`. So `PATH` doesn't let a caller run something new — it lets them
//     change what the daemon's own recorded command MEANS, and, worse, what
//     answers that session's permission gates. A run started under `manual` with
//     a shimmed `curl` on PATH reports approvals nobody gave. `LD_PRELOAD` and
//     friends reach the same two binaries by another door.
//  2. `DRYDOCK_*` is the daemon's channel into the session, not the caller's.
//     The four keys it injects already win on spread order (session.ts), so
//     accepting these would mean accepting keys that silently don't take.
//
// The other half is accident, and it is the case that will actually happen: a
// consumer that forwards its own `process.env` wholesale to add one variable.
// Refusing loudly turns "the agent ran with the caller's PATH and behaved
// strangely" into a 400 naming the key.
//
// One thing a caller should know rather than discover: whatever is sent here is
// written to the sessions-dir index file alongside the socket, because that is
// how a session survives a daemon restart (DRY-57) — the supervisor rebuilds the
// PTY env from it. Nothing here is secret-aware, and the spawn log records the
// KEYS only. A credential passed this way is a credential on disk.

import { INHERITED_SESSION_MARKERS } from "./supervisor/markers.js";

/**
 * Uppercase only, per the requesting consumer's own suggestion.
 *
 * It costs the lowercase spellings — `http_proxy`, `no_proxy` — which are real
 * and conventional. This comment used to present that as a convenience, on the
 * grounds that they were the ones least worth handing to a caller. That was
 * backwards, and review caught it: the pattern excludes the lowercase spelling
 * and admits the UPPERCASE one, which is the spelling curl honours for
 * `ALL_PROXY`. The pattern is a shape rule and nothing more; what a key is
 * allowed to MEAN is the deny set's job, and the proxy family is in it now.
 *
 * What the pattern does buy is that `=` and NUL are unrepresentable in a key,
 * which is what stops one from forging a second entry in the environ array.
 */
const KEY = /^[A-Z][A-Z0-9_]*$/;

/**
 * Keys that change what the daemon's own spawn resolves to and runs.
 *
 * Prefix families rather than names for the loader ones: `LD_PRELOAD`,
 * `LD_LIBRARY_PATH` and `LD_AUDIT` are three doors into the same room, and
 * `DYLD_*` is the same room on macOS.
 */
const DENIED_EXACT = new Set([
  // Selects the executable for `claude`, for `shell`, and for the hooks' curl.
  "PATH",
  // `--require` runs arbitrary code in every node process the session starts.
  "NODE_OPTIONS",
  // Sourced at startup by non-interactive bash and by sh — including the
  // `$SHELL -l` a `shell` session is.
  "BASH_ENV",
  "ENV",
  // Word splitting for every command the session's shell runs.
  "IFS",
  // Bash imports these from the environment at startup, and `PS4` is executed
  // as a prompt string once `xtrace` is among them — the same door as BASH_ENV,
  // one step further along. Listed together because either alone is inert.
  "SHELLOPTS",
  "PS4",
  // Where the login shell reads its startup files from, and — the sharper half —
  // where `claude` reads `~/.claude/settings.json`, which it merges ON TOP of
  // the `--settings` file the daemon passes. That file is what installs the
  // PreToolUse hook, so `HOME` is a way to edit the gate's own configuration.
  "HOME",
  // Does not pick the executable — `CONFIG.defaultShell` was resolved from the
  // DAEMON's env at boot — but it is what anything downstream re-execs as "the
  // user's shell", so it belongs with HOME rather than on its own.
  "SHELL",
  // The proxy family, and the reason this list gained a section rather than a
  // key (review, measured on curl 8.5.0 against a plain-http daemon URL):
  // `ALL_PROXY` is honoured, and the DRY-27 hooks reach the daemon through a
  // bare `curl`. So a caller can answer their own PreToolUse gate without
  // replacing a binary at all — the harm PATH is denied for, by a shorter road.
  // `HTTP_PROXY` (uppercase) curl deliberately ignores, because CGI turns a
  // `Proxy:` header into exactly that variable; almost every other client
  // honours it. The family goes in whole rather than leaving keys that work for
  // some of what an agent runs and not others.
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
  // Passed through by DRY-59 as host config — which is the reason it cannot be
  // set per spawn, not an argument that it can. `transcripts.ts` reads the
  // DAEMON's copy to find a run's transcript, under a comment saying in as many
  // words that daemon and agent always agree on it and that this lookup answers
  // for the wrong directory if they ever stop. A caller setting it here is that
  // divergence: the agent writes its transcript somewhere the daemon does not
  // scan, every such run comes back `transcriptMissing`, and DRY-62 then offers
  // "Start again" over a conversation that exists — the direction CLAUDE.md
  // singles out as worse than the bug it was guarding against.
  "CLAUDE_CONFIG_DIR",
  // Set by the daemon AFTER this map is spread (session.ts), so accepting it
  // would 201 a value that never reaches the PTY. That is the one thing this
  // channel may not do, and it was the only key left that could still do it.
  "TERM",
]);
const DENIED_PREFIXES = ["LD_", "DYLD_", "DRYDOCK_"];

/**
 * Why a specific key is refused, where "it changes what the daemon runs" is not
 * the honest answer.
 *
 * The point is the same one that gives DRY-59's markers their own message: a
 * caller who reads "refused" and cannot tell policy from physics goes looking
 * for a knob. `PATH` has a knob (set it on the daemon); `TERM` does not, and
 * `CLAUDE_CONFIG_DIR` has one that is deliberately host-wide.
 */
const DENIED_WHY: Record<string, string> = {
  TERM: "the daemon sets it after this map is applied, so it could only ever look like it worked",
  CLAUDE_CONFIG_DIR:
    "the daemon reads its OWN copy to find a run's transcript, so a per-spawn one takes Resume away from the session afterwards (DRY-62). Set it on the daemon if the host wants it moved",
  HOME: "it moves the login shell's startup files and `~/.claude/settings.json`, which is where this session's permission-gate hook is installed",
};
const PROXY_WHY =
  "the session's hooks reach the daemon through a bare `curl`, so a proxy can answer its own permission gates";
for (const k of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY"]) {
  DENIED_WHY[k] = PROXY_WHY;
}

/** DRY-59's strip runs last and would delete these unannounced. See markers.ts. */
const STRIPPED = new Set<string>(INHERITED_SESSION_MARKERS);

/**
 * Bounds on what is STORED — written to the sessions-dir index file and handed
 * to `execve`. `env` is the first field on this route that invites a blob, and
 * these caps are what keep it from being one.
 *
 * They are not bounds on what was READ. This comment used to imply the two were
 * the same choice, and that capping here was what let the autonomous `input`
 * prompt keep its generous length — review pointed out that `readJsonCapped`
 * takes a size, so both are available. The route now passes it 1 MiB and these
 * stay as they are: the read cap stops an unauthenticated allocation, and these
 * stop a 900 KiB environment block reaching a PTY.
 */
const MAX_KEYS = 64;
const MAX_VALUE_BYTES = 4096;
const MAX_TOTAL_BYTES = 16 * 1024;

export type SpawnEnvResult =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; error: string };

/**
 * Validate a spawn request's `env`, or say why it was refused.
 *
 * REFUSED, not filtered. The house pattern elsewhere on this route is to ignore
 * an unrecognised value rather than fail the spawn (`permissionMode`), and that
 * reasoning is explicitly "it can only ever loosen or tighten a run". This field
 * is the opposite: a value dropped on the way through is a run that proceeds
 * without the thing that was supposed to scope it — an agent let loose on the
 * whole repo because the subpath it was handed went missing between the POST
 * and the PTY. Silence is the one failure mode this channel cannot have, since
 * being inspectable is the entire reason to prefer it to the temp-file
 * workaround it replaces.
 */
export function sanitizeSpawnEnv(raw: unknown): SpawnEnvResult {
  if (raw === undefined || raw === null) return { ok: true, env: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "env must be an object of string values" };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return { ok: true, env: undefined };
  if (entries.length > MAX_KEYS) {
    return { ok: false, error: `env has ${entries.length} keys; the cap is ${MAX_KEYS}` };
  }

  const env: Record<string, string> = {};
  let total = 0;
  for (const [key, value] of entries) {
    if (!KEY.test(key)) {
      return {
        ok: false,
        error: `env key ${JSON.stringify(key)} is not of the form [A-Z][A-Z0-9_]*`,
      };
    }
    if (DENIED_EXACT.has(key) || DENIED_PREFIXES.some((p) => key.startsWith(p))) {
      return {
        ok: false,
        error:
          `env.${key} is refused: ` +
          (DENIED_WHY[key] ??
            "it is part of how the daemon runs the session (which executable resolves, " +
              "or its own channel into the PTY). Set it on the daemon's own environment " +
              "if the host wants it"),
      };
    }
    if (STRIPPED.has(key)) {
      // Named separately because the fix is different: this one is not policy
      // about what a caller may do, it is a key that CANNOT arrive. Before
      // DRY-66 refused it here, it would have been accepted, written to the
      // index file, and then deleted by the supervisor — leaving somebody to
      // debug a variable that reached the PTY as nothing.
      return {
        ok: false,
        error:
          `env.${key} is refused: the supervisor strips it from every PTY (DRY-59), ` +
          `so setting it here could only ever look like it worked.`,
      };
    }
    if (typeof value !== "string") {
      // Not coerced. `1` becoming `"1"` is a guess, and an object becoming
      // "[object Object]" is a guess that reaches the agent as a plausible
      // string — the caller finds out from the agent's behaviour, which is the
      // longest possible way to learn about a typo.
      return {
        ok: false,
        error: `env.${key} must be a string, not ${Array.isArray(value) ? "an array" : typeof value}`,
      };
    }
    if (value.includes("\0")) {
      // execve takes NUL-terminated strings, so an embedded one truncates the
      // value silently at the boundary rather than failing.
      return { ok: false, error: `env.${key} contains a NUL byte` };
    }
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_VALUE_BYTES) {
      return { ok: false, error: `env.${key} is ${bytes} bytes; the cap is ${MAX_VALUE_BYTES}` };
    }
    // `key.length`, not `Buffer.byteLength`: the KEY regex above has already
    // established `[A-Z][A-Z0-9_]*`, so a multi-byte key is unreachable and
    // measuring for one reads as though it weren't (review).
    //
    // The `+ 2` is the `=` and the NUL that every `environ` entry carries. Two
    // bytes a key is not what makes or breaks a 16 KiB budget; the reason to
    // count them is that the cap should name the thing it bounds, and the thing
    // it bounds is the block handed to `execve`.
    total += key.length + bytes + 2;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: `env exceeds the ${MAX_TOTAL_BYTES} byte cap` };
    }
    env[key] = value;
  }
  return { ok: true, env };
}
