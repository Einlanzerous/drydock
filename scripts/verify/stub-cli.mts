// A CLI that boots the way Claude Code boots, for prefill.mts (DRY-88).
//
// The bug this stands in for is invisible to every ordinary probe: a prompt
// written into a PTY before the wrapped CLI starts reading is DISCARDED, and
// nothing anywhere errors. `cat` cannot model that — it reads from the first
// instant, so a prompt typed at 700ms lands and the harness passes against the
// bug. This stub drops what arrives too early and SAYS so.
//
// The three phases, and the measurement they come from (Claude Code v2.1.238,
// timings relative to a client that attaches immediately):
//
//   ~330ms  escape-only writes — save cursor, scroll region, show/hide cursor,
//           enable bracketed paste, query the terminal. Nothing is painted, and
//           this is exactly what must NOT convince the daemon the CLI is ready.
//  ~1270ms  the banner: the first write with printable text in it.
//  ~1400ms  input starts being accepted. Sent at 1200ms it was still lost.
//
// So PAINT_MS/READY_MS default to those. Env overrides exist for the harness's
// own negative cases, not for tuning.
//
// Run through a shim named `claude` on the daemon's PATH — see the README rig,
// which is also why every argument is ignored rather than parsed: the daemon
// spawns `claude --settings <file> [--permission-mode auto]`.
const PAINT_MS = Number(process.env.STUB_PAINT_MS ?? 1200);
const READY_MS = Number(process.env.STUB_READY_MS ?? 1400);
/**
 * How long after opening stdin anything already buffered counts as "arrived
 * too early".
 *
 * Bytes written to the PTY before this process resumed stdin are sitting in the
 * tty buffer and are delivered in the first read after `resume()` — so the
 * window only has to outlast one event loop turn. It is nowhere near the ~1.8s
 * of headroom the fix leaves, which is what keeps this from being a race.
 */
const DRAIN_MS = 50;

const out = (s: string): void => void process.stdout.write(s);

/**
 * The part of an input burst a person could have typed.
 *
 * A real terminal answers the queries above on its own — xterm sends
 * `ESC [ I` for focus and `ESC [ ? 1 ; 2 c` for the DA1 — and those arrive
 * within milliseconds of the socket opening, i.e. always inside the drain
 * window. Counting them made "was the prompt lost?" answer yes on every run
 * with a browser in it, which is a harness that fails whatever the code does.
 */
const typedText = (s: string): string =>
  s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");

// Phase 1: configure the terminal. Printable characters: none, deliberately.
out("\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?1004h\x1b]0;stub-cli\x07\x1b[>0q\x1b[c");
// Raw NOW, read later — which is what a TUI does, and it is load-bearing for
// the harness rather than dressing. Left in canonical mode the tty ECHOES what
// is typed at it, so a prompt sent to a stub that is not listening still showed
// up in the pane's rows: "the prompt is in the composer" passed against the
// very bug this file exists to catch. Raw mode turns that echo off, so the only
// way text reaches the screen is phase 3 writing it there.
process.stdin.setRawMode?.(true);

// Phase 2: paint.
setTimeout(() => out("\r\n stub-cli ready \r\n> "), PAINT_MS);

// Phase 3: start listening, and report what was thrown away getting here.
setTimeout(() => {
  let dropped = 0;
  let draining = true;
  setTimeout(() => {
    draining = false;
    // The whole verdict on one line, so the harness reads bytes this process
    // produced rather than inferring from an absence. A run that lost the
    // prompt prints a non-zero count here; a healthy one prints nothing at all,
    // because nothing arrived early to count.
    if (dropped) out(`\r\n[dropped ${dropped} chars typed before I was listening]\r\n> `);
  }, DRAIN_MS);
  process.stdin.resume();
  process.stdin.on("data", (d: Buffer) => {
    if (draining) {
      dropped += typedText(d.toString("utf8")).length;
      return;
    }
    // CR is rendered rather than obeyed. The submit is the one thing that
    // separates an autonomous run from a supervised pre-fill, and "did a
    // carriage return arrive" is not answerable from a terminal's rows unless
    // something writes it down.
    out(d.toString("utf8").replace(/\r/g, "[CR]"));
  });
}, READY_MS);

// Nothing above holds the loop open on its own once the timers have run.
setInterval(() => {}, 1 << 30);
