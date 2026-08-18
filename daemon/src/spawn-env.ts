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
 * It costs `http_proxy` and `no_proxy`, which are real and lowercase by
 * convention — and which are also the ones least worth handing to a caller,
 * since between them they redirect every request the agent makes. The pattern
 * additionally makes `=` and NUL in a key unrepresentable, which is what stops
 * a key from forging a second entry in the environ array.
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
]);
const DENIED_PREFIXES = ["LD_", "DYLD_", "DRYDOCK_"];

/** DRY-59's strip runs last and would delete these unannounced. See markers.ts. */
const STRIPPED = new Set<string>(INHERITED_SESSION_MARKERS);

/**
 * Bounds. `POST /api/sessions` reads its body uncapped (`readJson`), which has
 * never mattered because the control payloads are a few hundred bytes — `env`
 * is the first field on this route that invites a blob, and it is one that gets
 * written to the sessions-dir index file and handed to `execve`. Capped here
 * rather than by swapping the route's reader, so the autonomous `input` prompt
 * keeps its own (deliberately generous) length.
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
          `env.${key} is refused: it is part of how the daemon runs the session ` +
          `(which executable resolves, or its own channel into the PTY). ` +
          `Set it on the daemon's own environment if the host wants it.`,
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
    total += Buffer.byteLength(key, "utf8") + bytes;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: `env exceeds the ${MAX_TOTAL_BYTES} byte cap` };
    }
    env[key] = value;
  }
  return { ok: true, env };
}
