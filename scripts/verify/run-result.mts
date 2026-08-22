// DRY-63: `GET /api/sessions/{id}/transcript`, and the run-result event that is
// the reason it exists.
//
// The claim is a chain, and only the last link is this repo's code: Claude
// Code's print mode writes its `{"type":"result",...}` event — `total_cost_usd`,
// `num_turns`, `usage` — to STDOUT and to no file it keeps, so the bytes go
// CLI -> pty -> supervisor ring -> daemon scrollback -> this route, and nowhere
// else. Every link in that chain can drop it silently.
//
// So the assertion is not that the route answered 200. It is that a JSON object
// this file wrote goes in one end and comes out the other still PARSING. That
// is the failure mode with teeth: the payload is a single ~420-byte line, the
// pty is 80 columns wide, and the response has been through `stripAnsi` — three
// separate opportunities to hand a consumer a record cut in half, all of which
// answer 200 while doing it. (CLAUDE.md trap 3.)
//
// The event below is REAL, captured from `claude -p --output-format stream-json`
// v2.1.240 and trimmed to the fields a consumer wants; `total_cost_usd` is that
// run's actual cost. Nothing else on the host emits that number, which is what
// makes finding it proof of transport rather than proof of a status code.
//
// Also covered, because they are the same route's edges: the 1 MiB cap keeps
// the TAIL (the result event is emitted when a run ENDS, so head-truncation
// would discard exactly the payload), the cut lands on a line boundary, and the
// `/file` arm that serves a session's own handoff document — including the
// three probes that show it opened nothing else.
//
// NOT covered, and stated rather than implied: the route asks `sessionFor(...,
// "see")` where `/file` asks "own", which only differs on a PUBLIC run owned by
// somebody else — and that needs auth on, Postgres, and two accounts. It was
// settled by reading `visibleTo` against the WebSocket upgrade (server.ts),
// which hands the same bytes to the same viewers. A harness that ran with auth
// off and "passed" would be asserting nothing, since `visibleTo` is
// unconditionally true when no session has an owner.
//
// DISCRIMINATION (CLAUDE.md trap 5) — point it at the unpatched daemon:
//   cp daemon/src/server.ts /tmp/server.patched.ts
//   git show main:daemon/src/server.ts > daemon/src/server.ts
// restart the rig, run, then `cp /tmp/server.patched.ts daemon/src/server.ts`
// to put it back. Restoring with `git checkout` instead would leave the revert
// STAGED, and the next commit would carry it.
//
// Measured against that build: **18 of the 24 checks fail** — everything in
// sections 1, 2 and 2b (the route 404s, since it does not exist) and the three
// `own handoff` claims (403, since /file confines to the cwd).
//
// The six that still pass are the point of doing this. `unknown id -> 404`, the
// three negative handoff probes and the decoy's own existence are answered by
// code this ticket did not touch, and an ordinary read under the cwd is the
// thing that must not have broken — so they are green either way, and a harness
// made only of them would look identical on a build with none of the feature in
// it. Three more used to join them (see the `text.length` guards below), which
// is how that was found: they were satisfied by an EMPTY response and passed
// against the bug.
//
// RIG (throwaway daemon, per CLAUDE.md's second-instance pattern). The ring is
// raised deliberately — the route's cap must NOT be a restatement of
// DRYDOCK_SCROLLBACK_BYTES, and at the 1 MiB default the truncation branch can
// never be reached to be tested:
//   cd daemon
//   env $(env | grep -o '^DRYDOCK_[A-Z_0-9]*' | sed 's/^/-u /' | tr '\n' ' ') \
//     DRYDOCK_PORT=4363 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
//     DRYDOCK_SESSIONS_DIR=/tmp/d63 DRYDOCK_STATE_FILE=/tmp/dry63-state.json \
//     DRYDOCK_WORKTREES_ROOT=/tmp/dry63-wt DRYDOCK_RUNS_ROOT=/tmp/dry63-runs \
//     DRYDOCK_SCROLLBACK_BYTES=4194304 node --import tsx src/index.ts
//
// DRYDOCK_RUNS_ROOT is not decoration: unset, the autonomous runs below write
// handoff documents into ~/.drydock/runs, which the dev and prod daemons share.
// It must also not sit under the session cwd this file makes — otherwise the
// "another session's handoff" probe is answered by the ordinary cwd-confinement
// arm and proves nothing about the new one. The harness checks that itself and
// SKIPS rather than passing, instead of trusting the rig.
//
// then, from another terminal:
//   (cd daemon && node --import tsx ../scripts/verify/run-result.mts)
// Every session it starts exits on its own, so there are no supervisors left to
// clean up — but the exited sessions sit in the registry until the DRY-60 sweep,
// which is also what makes the route answer for them at all.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Detail, FileResponse, SessionInfo, SessionsResponse, SpawnResponse } from "./api.mjs";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4363";
/** Mirrors READ_CAP_BYTES in server.ts. */
const READ_CAP = 1_048_576;
/**
 * ESC, built rather than typed.
 *
 * A literal escape character in a source file makes it binary to git — no diff,
 * no blame, no grep — and nothing but review catches it.
 */
const ESC = String.fromCharCode(27);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let skipped = 0;
const check = (n: string, ok: boolean, d: Detail = ""): void => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const skip = (n: string, why: string): void => {
  console.log(`  SKIP  ${n} — ${why}`);
  skipped++;
};

/** `GET /api/sessions/{id}/transcript` */
interface TranscriptResponse {
  id?: string;
  text?: string;
  bytes?: number;
  truncated?: boolean;
  error?: string;
}

async function spawn(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as SpawnResponse & { error?: string };
  if (!json.session?.id) throw new Error(`spawn failed: ${res.status} ${JSON.stringify(json)}`);
  return json.session.id;
}

const sessions = async (): Promise<SessionInfo[]> =>
  ((await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse).sessions;

/**
 * Wait for a session to exit, and return its record.
 *
 * Bounded and then given up on rather than waited out: every command here is a
 * few seconds of shell, so a session still running at the deadline means
 * something is wrong with the rig, and a harness that waits indefinitely for it
 * reports that as a hang instead of a failure (CLAUDE.md trap 1).
 */
async function ended(id: string, timeoutMs = 60_000): Promise<SessionInfo> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = (await sessions()).find((s) => s.id === id);
    if (!found) throw new Error(`session ${id} left the registry before it was read`);
    // `status`, never `exitCode`: a signalled process exits 129/137/143 and a
    // harness reading the number calls a deliberate stop a crash (CLAUDE.md
    // trap 2). Nothing here is signalled, and this stays right if that changes.
    if (found.status === "exited") return found;
    if (Date.now() > until) throw new Error(`session ${id} never exited`);
    await sleep(250);
  }
}

async function transcript(id: string): Promise<{ status: number; json: TranscriptResponse }> {
  const res = await fetch(`${DAEMON}/api/sessions/${id}/transcript`);
  return { status: res.status, json: (await res.json()) as TranscriptResponse };
}

async function readFileVia(id: string, p: string): Promise<{ status: number; json: FileResponse }> {
  const res = await fetch(`${DAEMON}/api/sessions/${id}/file?path=${encodeURIComponent(p)}`);
  return { status: res.status, json: (await res.json()) as FileResponse };
}

// --- 1. the result event survives the trip ----------------------------------

/**
 * A real result event, minus the fields nobody asked for.
 *
 * Printed on ONE line, which is the whole point — 417 bytes through an
 * 80-column pty. Any layer that wraps, folds or re-flows leaves this parsing as
 * nothing.
 */
const RESULT_EVENT =
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":1714,' +
  '"duration_api_ms":1637,"num_turns":1,"result":"pineapple",' +
  '"session_id":"75f8399a-fb89-483f-b9d9-96cd78e3c409","total_cost_usd":0.089832,' +
  '"usage":{"input_tokens":2,"cache_creation_input_tokens":8166,' +
  '"cache_read_input_tokens":16024,"output_tokens":6,"service_tier":"standard"},' +
  '"permission_denials":[],"uuid":"a147588a-1382-4a5d-8ea2-cbeeed7cfc38"}';

console.log("\n1. the run-result event reaches GET /api/sessions/{id}/transcript");
{
  // Escape noise on both sides, because the route strips ANSI and a strip one
  // character too greedy eats the leading `{` or the closing `}`. Bracketed
  // paste, a colour run, an erase-line and an OSC title are what a CLI actually
  // puts around its output; the record has to come through all four intact.
  // Written as `printf %b` octal, so no control character appears in this file.
  const noise = "\\033[?2004h\\033[1;32mrunning\\033[0m\\033[2K\\r\\033]0;claude\\007";
  const id = await spawn({
    command: "/bin/sh",
    args: [
      "-c",
      `printf '%b' '${noise}'; printf '%s\\n' '${RESULT_EVENT}'; printf '%b' '${noise}'`,
    ],
    cwd: os.tmpdir(),
    title: "dry63-result-event",
  });
  await ended(id);
  const { status, json } = await transcript(id);
  check("the route answers 200", status === 200, `${status} ${json.error ?? ""}`);
  const text = json.text ?? "";

  // The assertion that matters: not "the string is in there" but "a consumer
  // can read it". A wrapped or escape-poisoned record still contains
  // `total_cost_usd` and still fails here.
  const candidates = text.split("\n").filter((l) => l.trim().startsWith("{"));
  let parsed: { total_cost_usd?: number; num_turns?: number } | undefined;
  for (const line of candidates) {
    try {
      const o = JSON.parse(line) as { type?: string; total_cost_usd?: number; num_turns?: number };
      if (o.type === "result") parsed = o;
    } catch {
      /* any other line the shell printed */
    }
  }
  check(
    "a result record parses out of the response",
    parsed !== undefined,
    `${candidates.length} candidate lines`,
  );
  check(
    "it is THIS run's event, not a substring match",
    parsed?.total_cost_usd === 0.089832 && parsed?.num_turns === 1,
    JSON.stringify({ cost: parsed?.total_cost_usd, turns: parsed?.num_turns }),
  );
  // Stripped, not raw: an ESC left in the payload is the tell that the route
  // started serving the ring verbatim, which reads fine in a terminal and
  // breaks every parser pointed at it.
  // `text.length` is half of each of the next three, and not padding: without
  // it they are all satisfied by an EMPTY response, so a route that had stopped
  // answering at all would still show three green lines. Measured — against the
  // unpatched daemon they passed.
  check(
    "no escape sequences survive",
    text.length > 0 && !text.includes(ESC),
    `${text.length} chars, ${text.split(ESC).length - 1} escapes`,
  );
  check(
    "bytes agrees with the payload it describes",
    json.bytes === Buffer.byteLength(text, "utf8"),
    `${json.bytes} vs ${Buffer.byteLength(text, "utf8")}`,
  );
  check("nothing this short is truncated", json.truncated === false, String(json.truncated));
}

// --- 2. the cap keeps the end, on a line boundary ---------------------------

console.log("\n2. above the cap it keeps the TAIL, cut on a line boundary");
{
  const id = await spawn({
    command: "/bin/sh",
    args: [
      "-c",
      'i=0; while [ $i -lt 30000 ]; do echo "LINE-$i padding-padding-padding-padding"; ' +
        "i=$((i+1)); done; echo TAIL-MARKER-DRY63",
    ],
    cwd: os.tmpdir(),
    title: "dry63-cap",
  });
  await ended(id);
  const { json } = await transcript(id);
  const text = json.text ?? "";
  // Never a silent pass. Reaching the cap needs a ring bigger than it, and a rig
  // started without DRYDOCK_SCROLLBACK_BYTES trims the output before the route
  // ever sees a megabyte — so this claim would go green having exercised the
  // branch it exists for exactly zero times.
  check(
    "the response was truncated",
    json.truncated === true,
    json.truncated
      ? `${json.bytes} bytes`
      : `${json.bytes} bytes — is DRYDOCK_SCROLLBACK_BYTES raised on the rig?`,
  );
  check(
    "it stayed under the cap",
    typeof json.bytes === "number" && json.bytes > 0 && json.bytes <= READ_CAP,
    `${json.bytes} <= ${READ_CAP}`,
  );
  // The whole argument for dropping the head rather than the tail: the result
  // event is the LAST thing a run prints.
  check(
    "the last line printed survived",
    text.trimEnd().endsWith("TAIL-MARKER-DRY63"),
    JSON.stringify(text.slice(-30)),
  );
  check(
    "the head was the half dropped",
    text.length > 0 && !text.includes("LINE-0 padding"),
    `${text.length} chars`,
  );
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  check(
    "the cut landed on a line boundary",
    /^LINE-\d+ padding-padding-padding-padding$/.test(first),
    JSON.stringify(first.slice(0, 60)),
  );
}

// --- 2b. one line longer than the cap ---------------------------------------

console.log("\n2b. output that is a single line longer than the cap");
{
  // Doubling, not a 150,000-iteration loop: this has to exceed a megabyte and
  // still finish in a second. The characters are multi-byte on purpose — the
  // fallback path here has no line boundary to cut on, so a byte offset can
  // land mid-character, and only a non-ASCII payload can tell.
  const id = await spawn({
    command: "/bin/sh",
    args: [
      "-c",
      "s='\u00e9\u00e9\u2026\u220e'; i=0; while [ $i -lt 18 ]; do s=\"$s$s\"; i=$((i+1)); done; " +
        "printf '%s' \"$s\"; printf 'ENDMARK-DRY63\\n'",
    ],
    cwd: os.tmpdir(),
    title: "dry63-one-long-line",
  });
  await ended(id);
  const { json } = await transcript(id);
  const text = json.text ?? "";
  check("it truncated", json.truncated === true, `${json.bytes} bytes`);
  // The claim with teeth. That single line's ONLY newline is the one after
  // ENDMARK, at the very end — so a snap-to-next-newline with no bound finds
  // it, cuts everything before it, and returns thirteen characters where a
  // megabyte was asked for. It returned exactly that before LINE_SNAP_BYTES.
  check(
    "it kept the megabyte instead of snapping to the far newline",
    (json.bytes ?? 0) > READ_CAP - 65_536,
    `${json.bytes} of ${READ_CAP}`,
  );
  check("the end of the line is still there", text.trimEnd().endsWith("ENDMARK-DRY63"), JSON.stringify(text.slice(-20)));
  // U+FFFD at the front is what a cut inside a UTF-8 sequence looks like once
  // it has been decoded. Only the first character can be affected, so this
  // looks at exactly that one.
  // `text.length` again, for the fourth time in this file and the same reason:
  // an empty string does not start with U+FFFD either.
  check(
    "the cut landed on a character, not mid-sequence",
    text.length > 0 && !text.startsWith("\ufffd"),
    JSON.stringify(text.slice(0, 8)),
  );
}

// --- 3. an id the caller may not have ---------------------------------------

console.log("\n3. an unknown session");
{
  const { status, json } = await transcript("00000000-0000-0000-0000-000000000000");
  // 404 and not 403, for the reason sessionFor() gives: telling an unauthorized
  // caller which ids are real is what the matching arms exist to prevent.
  check("unknown id -> 404", status === 404, `${status} ${json.error ?? ""}`);
}

// --- 4. the handoff document over /file -------------------------------------

console.log("\n4. /file serves the session's OWN handoff and nothing else");
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dry63-cwd-"));
  fs.writeFileSync(path.join(cwd, "inside.md"), "# in the worktree\n");

  const run = async (title: string): Promise<SessionInfo> => {
    const id = await spawn({
      command: "/bin/sh",
      args: ["-c", "echo autonomous-run-output-DRY63; sleep 1"],
      cwd,
      title,
      autonomous: true,
    });
    await ended(id);
    // The handoff is written from the run-end notification, which lands a beat
    // after the status flips — so `ended()` returning is not the same as the
    // path being advertised. Re-read until it is.
    for (let i = 0; i < 40; i++) {
      const found = (await sessions()).find((s) => s.id === id);
      if (found?.handoff) return found;
      await sleep(250);
    }
    throw new Error(`run ${id} ended without a handoff — is DRYDOCK_RUNS_ROOT writable?`);
  };

  const mine = await run("dry63-handoff-a");
  const other = await run("dry63-handoff-b");
  const handoff = mine.handoff!;

  {
    const { status, json } = await readFileVia(mine.id, handoff);
    check("own handoff -> 200", status === 200, `${status} ${json.error ?? ""}`);
    check(
      "it is the document, not an empty 200",
      (json.content ?? "").includes("autonomous-run-output-DRY63"),
      `${(json.content ?? "").length} chars`,
    );
    check("the path echoed back is the one advertised", json.path === handoff, json.path ?? "");
  }

  // The three that show nothing else was opened. All are answered by the
  // pre-existing cwd confinement, so they pass against the unpatched daemon
  // too — they are here to prove the new arm did not widen it, which is a claim
  // about THIS build and needs re-asserting on every change.
  if (path.resolve(handoff).startsWith(path.resolve(cwd) + path.sep)) {
    // Vacuous otherwise: every probe below would be answered by the confinement
    // rule rather than by the equality test, and go green either way.
    skip("the negative probes", `DRYDOCK_RUNS_ROOT is inside the session cwd (${cwd})`);
  } else {
    // The decoy is WRITTEN, not merely named, and that is the whole difference
    // between this probe and a vacuous one. `/file` cannot distinguish a
    // traversal attempt from a missing file — realpath fails on both, and both
    // answer 404 (see the comment on that catch) — so pointing this at a path
    // that does not exist asserts nothing about the guard: it goes green
    // whatever the daemon would have done with a real file. Found exactly that
    // way, by a run in which a leftover decoy from hand-testing was what made
    // the check meaningful.
    const decoy = path.join(path.dirname(handoff), "dry63-decoy.md");
    fs.writeFileSync(decoy, "# not this session's handoff\n");
    check("the decoy is really on disk", fs.existsSync(decoy), decoy);

    const cases: Array<[string, string]> = [
      ["another session's handoff -> 403", other.handoff!],
      ["an existing sibling in runsRoot -> 403", decoy],
      ["traversal into runsRoot -> 403", path.relative(cwd, handoff)],
    ];
    for (const [name, p] of cases) {
      const { status, json } = await readFileVia(mine.id, p);
      check(name, status === 403, `${status} ${json.error ?? ""}`);
    }
  }

  const inside = await readFileVia(mine.id, "inside.md");
  check("an ordinary read under the cwd still works", inside.status === 200, String(inside.status));
}

console.log(
  `\n${failures ? `${failures} FAILED` : "all passed"}${skipped ? ` (${skipped} skipped)` : ""}\n`,
);
process.exit(failures ? 1 : 0);
