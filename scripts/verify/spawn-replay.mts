// DRY-79: a spawned session's FIRST output reaches the pane.
//
// The supervisor spawns the PTY before it binds its socket, and the daemon then
// polls for that socket every 25ms before it can dial and say Attach — so every
// session has a window, measured at 5-47ms here, in which the child is writing
// and nothing upstream of the supervisor is listening. What it wrote arrives as
// Replay frames during the handshake. `PtySession.adopt` read them;
// `PtySession.spawn` did not, so all of it was dropped: not in the pane, not in
// the daemon's scrollback, and therefore not in a later reattach or in DRY-49's
// handoff either.
//
// WHY A HARNESS AND NOT A CURL. The replay is a WebSocket frame — `{"type":
// "replay","data":…}` on `/api/sessions/:id/attach` — so the bytes this is about
// never appear in an HTTP response at all. `/api/sessions` answers 201 and lists
// a healthy session either way; that is the whole reason this shipped and stayed
// shipped since DRY-57.
//
// WHAT IT DOES NOT CHECK, deliberately: the other half of `adopt` that must not
// be copied here, `hello.cols`/`hello.rows`. At spawn the supervisor initialises
// its `cols`/`rows` FROM the meta the daemon just handed it, so its hello echoes
// the request back and copying the sizes is a no-op no assertion could see. The
// claim is about intent (a later client's negotiated size must not overwrite the
// spawn's own), and there is no client yet to negotiate one. A check here would
// pass against both spellings, which is worse than no check.
//
// RIG (throwaway daemon, per CLAUDE.md's second-instance pattern — and note the
// `env -u` sweep it prescribes: a shell inside a Drydock session carries the
// PROD daemon's DRYDOCK_* config, and every unauthenticated fetch below then
// 401s against a daemon this file thinks is open):
//   cd daemon
//   DRYDOCK_PORT=4379 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d79 \
//     DRYDOCK_STATE_FILE=/tmp/dry79-state.json DRYDOCK_TRACKER=fixture \
//     DRYDOCK_SCROLLBACK_BYTES=1048576 node --import tsx src/index.ts
//
// The scrollback cap is in that line because the bulk case below asserts an
// EXACT character count over a ~300 KB payload: a host whose `.env` turns the
// ring down to, say, 128 KB fails this file for a reason that has nothing to do
// with the ticket. 1048576 is the default — the line pins it rather than
// changing it.
// then, from another terminal:
//   (cd daemon && node --import tsx ../scripts/verify/spawn-replay.mts)
// and afterwards kill the supervisors it left behind — CLAUDE.md's loop over
// /proc/<pid>/exe, never `pkill -f supervisor/main`.
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";
import type { ServerMessage } from "../../daemon/src/protocol.js";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4379";
const WS = DAEMON.replace(/^http/, "ws");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};
const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

interface ErrorResponse {
  error?: string;
}

async function spawn(args: string[], title: string): Promise<string | undefined> {
  const res = await fetch(`${DAEMON}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: "/bin/sh", args: ["-c", args.join("")], title }),
  });
  const json = (await res.json()) as SpawnResponse & ErrorResponse;
  if (res.status !== 201 || !json.session?.id) {
    check(`${title} spawned`, false, `${res.status} ${JSON.stringify(json.error ?? json)}`);
    return undefined;
  }
  return json.session.id;
}

/**
 * One attached pane, with its replay kept APART from what arrived afterwards.
 *
 * Keeping the two separate is the point. A harness that concatenates them can be
 * passed by a socket that merely caught the marker live — which is exactly what
 * happens for a command that keeps printing, and is why CLAUDE.md's DRY-27
 * section had to tell testers to use output that CONTINUES. The claim here is
 * about output that does NOT.
 */
class Pane {
  replay = "";
  live = "";
  private ws: WebSocket;
  private replayed: Promise<boolean>;

  constructor(id: string) {
    this.ws = new WebSocket(`${WS}/api/sessions/${id}/attach`);
    // Resolves false rather than REJECTING, and that is not tidiness: every
    // call site here is a top-level `await`, so a rejection would end the whole
    // run as an unhandled rejection — no FAIL line for the case that failed,
    // and every later case silently skipped. A harness's own failure has to
    // present as a failed check.
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
      this.ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });
  }

  /**
   * The one-shot scrollback dump; everything after it is `live`. False means the
   * socket never delivered one — checked at every call site, since an attach
   * that didn't happen makes every assertion below it meaningless.
   */
  ready(): Promise<boolean> {
    return this.replayed;
  }

  /** Wait for a marker to arrive AFTER the replay, or give up. */
  waitLive(marker: string, ms: number): Promise<boolean> {
    return this.waitFor(() => this.live.includes(marker), ms);
  }

  /**
   * Wait for a marker to arrive at all — replay or live.
   *
   * The distinction is not pedantry, and picking the wrong one cost a false
   * failure here first time out: the bulk case's window swallowed all 302 KB of
   * its output, END included, so a wait watching only `live` sat out its whole
   * timeout while everything it wanted was already in hand. Anything whose
   * timing races the attach has to ask this one.
   */
  waitSeen(marker: string, ms: number): Promise<boolean> {
    return this.waitFor(() => (this.replay + this.live).includes(marker), ms);
  }

  private async waitFor(done: () => boolean, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (done()) return true;
      await sleep(50);
    }
    return false;
  }

  close(): void {
    this.ws.close();
  }
}

const kill = (id: string) => fetch(`${DAEMON}/api/sessions/${id}/kill`, { method: "POST" });

console.log(`\nDRY-79 spawn replay — daemon ${DAEMON}`);

// --- 1. output printed before anything attached ------------------------------

// PRE is printed at once and never again; POST two seconds later, by which time
// the pane is long attached. That gap is what separates the two claims below.
const id = await spawn(
  ["printf 'DRY79-PRE\\n'; sleep 2; printf 'DRY79-POST\\n'; sleep 60"],
  "dry79-pre",
);
if (!id) {
  console.log("\n  no session id — nothing further can be asserted\n");
  process.exit(1);
}

const pane = new Pane(id);
if (!(await pane.ready())) {
  check("the pane attached", false, "no replay frame — nothing below can be asserted");
  process.exit(1);
}
check("the pane's replay carries the pre-attach marker", pane.replay.includes("DRY79-PRE"), JSON.stringify(pane.replay));
// The window, in bytes, for the ticket's first question. Reported rather than
// asserted: it is a race with the child, so any threshold would be flaky. What
// it answers is whether the supervisor's spawn-then-bind ordering is worth
// changing — see the note under check 4.
console.log(`  NOTE  pre-attach window: ${Buffer.byteLength(pane.replay)} bytes`);

// The half that keeps the check above honest. A socket that simply caught the
// marker live would pass that one; it cannot pass this one, because POST is
// still two seconds in the future when the replay is taken.
check("the replay is a snapshot, not the live stream", !pane.replay.includes("DRY79-POST"), JSON.stringify(pane.replay));
check("live output still arrives after it", await pane.waitLive("DRY79-POST", 6_000), JSON.stringify(pane.live));
// Seeding and then flushing the link's `pendingData` is two paths onto one
// buffer, so "it appears" is not enough — DRY-57 trap 4's rule, one layer down.
check(
  "the pre-attach marker appears exactly once",
  occurrences(pane.replay + pane.live, "DRY79-PRE") === 1,
  `${occurrences(pane.replay + pane.live, "DRY79-PRE")}`,
);

// --- 2. it is in the daemon's SCROLLBACK, not merely passed through ----------

// The consequence the ticket is filed for outlives the first pane: a reattach, a
// second browser, and DRY-49's handoff document all read the daemon's ring
// rather than the socket that was open at the time. A fix that handed the replay
// to the first client without keeping it would pass every check above.
const second = new Pane(id);
const secondAttached = await second.ready();
check("a later pane attaches", secondAttached, secondAttached ? "" : "no replay frame");
check(
  "a later pane replays the pre-attach marker too",
  occurrences(second.replay, "DRY79-PRE") === 1,
  `${occurrences(second.replay, "DRY79-PRE")} in ${JSON.stringify(second.replay)}`,
);
check(
  "and the rest of the session with it, once",
  occurrences(second.replay, "DRY79-POST") === 1,
  `${occurrences(second.replay, "DRY79-POST")}`,
);
pane.close();
second.close();
await kill(id);

// --- 3. a session that prints once and exits ---------------------------------

// The ticket's sharpest symptom: everything this session will ever print is in
// the window, so the pane was empty and the run read as a command that did
// nothing. Nothing is attached while it runs — the attach happens after it has
// already exited.
const oneShot = await spawn(["printf 'DRY79-ONESHOT\\n'"], "dry79-oneshot");
if (!oneShot) {
  // Said out loud because the FAIL above it names a status code and nothing
  // else. This session exits in single-digit milliseconds and its supervisor
  // then holds the socket open for only 250ms (`supervisor/main.ts`), so on a
  // loaded host the daemon's 25ms poll can arrive after the socket is gone and
  // `POST /api/sessions` 500s. That is the linger, not this ticket — rerun.
  console.log(
    "  NOTE  a one-shot spawn can lose the race with the supervisor's 250ms" +
      " post-exit linger; if this repeats, it is not the replay",
  );
}
if (oneShot) {
  await sleep(1_500);
  const sessions = ((await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse)
    .sessions;
  const info = sessions.find((s) => s.id === oneShot);
  // Context for the check below rather than a claim of its own: a session that
  // is somehow still running would make an empty pane unremarkable.
  check("the one-shot session has exited", info?.status === "exited", info?.status ?? "gone");
  // The exit CODE takes the same window, and lost the same way. The Exit frame
  // was broadcast to an empty client set — the daemon hadn't dialled yet — so
  // the socket it did dial closed with nothing left to say, and the daemon
  // synthesized -1: a `printf` that exited 0 presented as a failed run, with
  // DRY-49's handoff and a tracker comment behind it. The record the supervisor
  // flushes before it goes is now read instead.
  check("its exit code survived the window too", info?.exitCode === 0, `${info?.exitCode}`);
  // The consequence rather than the number, and the reason the number matters:
  // a non-zero code with no `stoppedByRequest` beside it is what draws a failed
  // card and writes a handoff.
  check("and it is not reported as a failure", info?.failure === undefined, info?.failure?.reason ?? "");
  const dead = new Pane(oneShot);
  const deadAttached = await dead.ready();
  check("a pane attaches to the exited session", deadAttached, deadAttached ? "" : "no replay frame");
  check(
    "its only output survived it",
    dead.replay.includes("DRY79-ONESHOT"),
    JSON.stringify(dead.replay),
  );
  dead.close();
}

// --- 4. a large window, and the chunk boundary inside it ---------------------

// Two things at once. The window is not always a few bytes: five concurrent
// chatty spawns measured 57-193 KB each, which is what makes it worth reading
// rather than shrinking (the supervisor's own spawn-to-listen gap is 1-2ms of a
// 5-47ms window, so binding before spawning would not close it — the daemon's
// 25ms socket poll is the term that dominates).
//
// And the payload is the character a `claude` TUI is mostly made of, because
// where the window is large enough the supervisor cuts its replay into 256 KiB
// frames (REPLAY_CHUNK_BYTES) and those cuts land mid-character routinely. The
// daemon concatenates before decoding for that reason, and the spawn path is now
// a second consumer of it. Whether a given run crosses that boundary is a race —
// the NOTE below prints the window it got, and two runs here got 114 KB and the
// whole 302 KB — so the boundary is exercised opportunistically. The exact count
// is not: every character printed has to arrive, whichever side of the boundary
// it fell.
//
// That 302 KB run is the ticket's sizing question answered in its starkest form.
// The window is not "a few frames": a burst that FINISHES inside it left a pane
// that was empty and stayed empty, for a session that had printed 300 KB.
const LINE = "─".repeat(100);
// 100k characters, ~300 KB — comfortably past REPLAY_CHUNK_BYTES and comfortably
// under DRYDOCK_SCROLLBACK_BYTES, which is the other bound that matters: over
// the ring's cap the oldest chunks are TRIMMED and the exact count below fails
// for a reason that is not this ticket. The rig pins the cap at its 1 MiB
// default for that reason, and a short count says so below.
const LINES = 1_000;
const big = await spawn(
  [`i=0; while [ $i -lt ${LINES} ]; do printf '%s\\n' '${LINE}'; i=$((i+1)); done; `,
   "printf 'DRY79-END\\n'; sleep 60"],
  "dry79-bulk",
);
if (big) {
  const bulk = new Pane(big);
  const bulkAttached = await bulk.ready();
  check("the bulk pane attached", bulkAttached, bulkAttached ? "" : "no replay frame");
  const arrived = await bulk.waitSeen("DRY79-END", 20_000);
  const all = bulk.replay + bulk.live;
  check("the bulk session finished writing", arrived, `${Buffer.byteLength(all)} bytes seen`);
  // Labelled differently from the one above on purpose. This session is still
  // printing while the pane connects, so the replay is the daemon's whole ring
  // at that moment — the supervisor's window PLUS whatever arrived live between
  // the daemon binding the link and the pane attaching. Case 1's number is the
  // window alone, because nothing is printed after it.
  console.log(`  NOTE  replay at attach: ${Buffer.byteLength(bulk.replay)} bytes`);
  const seen = occurrences(all, "─");
  check("every character printed arrived exactly once", seen === LINES * 100, `${seen} of ${LINES * 100}`);
  if (seen > 0 && seen < LINES * 100) {
    // A partial count has two very different causes and the number alone can't
    // separate them: a dropped replay (this ticket) or a ring smaller than the
    // payload (host config). Say so rather than let the next reader guess.
    console.log(
      "  NOTE  a PARTIAL count can also mean DRYDOCK_SCROLLBACK_BYTES is below" +
        ` ${Buffer.byteLength(all)} bytes on this daemon — check the rig line above`,
    );
  }
  check(
    "nothing was decoded across a chunk boundary",
    !all.includes("\uFFFD"),
    `${occurrences(all, "\uFFFD")} replacement characters`,
  );
  bulk.close();
  await kill(big);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
