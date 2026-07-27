// Daemon logging (DRY-45).
//
// The daemon owns other people's live work: when it dies, every PTY dies with
// it and nothing is recoverable. The first incident that made that concrete had
// *no* server-side trace at all — the only diagnostics were a startup banner and
// two console.warns, and the crash stack went to the stderr of whatever terminal
// happened to run `bun run daemon`. So: every session-lifecycle event goes to a
// file that outlives the process, and "the sessions died and there are no logs"
// becomes a falsifiable claim rather than the expected outcome.
//
// Deliberately dependency-free and deliberately SYNCHRONOUS. Volume is tiny
// (session and client lifecycle, never PTY data), and the lines that matter most
// are the ones written from a crash handler microseconds before the process
// goes away — a buffered stream would lose exactly those.
//
// Every line is one line: values containing whitespace (stack traces above all)
// are JSON-quoted, so `grep` and per-line parsing keep working.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { expandHome } from "./repos.js";

export type LogFields = Record<string, unknown>;

/**
 * Console sinks whose reader is gone. Node surfaces a broken pipe as an
 * asynchronous 'error' on the stream, NOT as a throw from console.log — so a
 * try/catch around the write does nothing, and with no listener it becomes an
 * uncaughtException. That matters here because our uncaughtException handler
 * logs: one EPIPE would feed itself forever, each turn of the loop paying for a
 * synchronous appendFileSync. Measured on this host: 250+ consecutive uncaught
 * EPIPEs from a single broken pipe. A permanent listener per stream breaks the
 * cycle, and we stop writing to a sink we know is dead — the file sink, which
 * is the one that matters after the fact, carries on.
 */
const dead = new Set<NodeJS.WritableStream>();
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => dead.add(stream));
}

/**
 * File-sink health. A latch would be wrong: a transient ENOSPC, a directory
 * that briefly vanishes under a deploy, an NFS blip — any one of them would
 * silently end file logging for the rest of the process's life, and the notice
 * about it goes to a console that may itself be gone. So we back off and retry,
 * and when the file comes back we say so IN THE FILE, with the count of lines
 * that were lost while it was down.
 */
let fileFailedAt = 0; // 0 = healthy; otherwise when it broke
let fileDropped = 0; // lines lost since it broke
const FILE_RETRY_MS = 30_000;

function target(): string {
  return CONFIG.log.file ? expandHome(CONFIG.log.file) : "";
}

function toConsole(stream: NodeJS.WritableStream, line: string): void {
  if (dead.has(stream)) return;
  try {
    stream.write(line + "\n");
  } catch {
    dead.add(stream); // files and TTYs can fail synchronously instead
  }
}

/** Append one line, rotating a single generation aside when over the cap. */
function write(line: string): void {
  const file = target();
  if (!file) return; // DRYDOCK_LOG_FILE= (empty) disables the file sink
  if (fileFailedAt && Date.now() - fileFailedAt < FILE_RETRY_MS) {
    fileDropped++;
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Stat per write instead of tracking a byte counter in memory: the
    // documented workflow (CLAUDE.md) runs 2-3 daemons at once, and two
    // processes each trusting their own counter rotate on top of each other and
    // lose the file. A stat per line is free at this volume.
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* not created yet */
    }
    if (size > 0 && size + Buffer.byteLength(line) + 1 > CONFIG.log.maxBytes) {
      // One generation is enough to cover "what happened just before the crash"
      // without turning into a log-management project.
      try {
        fs.renameSync(file, `${file}.1`);
      } catch {
        /* rotation failed — keep appending rather than lose the line */
      }
    }
    fs.appendFileSync(file, line + "\n");
    if (fileFailedAt) {
      // Recovered. Record the gap in the file itself — the reader of this file
      // is the one who needs to know a stretch of it is missing. Direct append,
      // not write(), so this can't recurse.
      const note = fmt("WARN", "log file recovered", {
        droppedLines: fileDropped,
        downSec: Math.round((Date.now() - fileFailedAt) / 1000),
      });
      fileFailedAt = 0;
      fileDropped = 0;
      fs.appendFileSync(file, note + "\n");
    }
  } catch (err) {
    // Never take the daemon down over logging — but never swallow this either:
    // a silently unwritable log reproduces the exact "they died and there are no
    // logs" symptom this module exists to end, while the startup banner is still
    // advertising the path.
    const first = fileFailedAt === 0;
    fileFailedAt = Date.now();
    fileDropped++;
    if (first) {
      toConsole(
        process.stderr,
        fmt("ERROR", "log file write failed — backing off, will retry", {
          file,
          retrySec: FILE_RETRY_MS / 1000,
          err: String(err),
        }),
      );
    }
  }
}

function fmt(level: string, msg: string, fields?: LogFields): string {
  let line = `${new Date().toISOString()} ${level.padEnd(5)} [drydock] ${msg}`;
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue;
    const s = String(v);
    line += ` ${k}=${/[\s"]/.test(s) ? JSON.stringify(s) : s}`;
  }
  return line;
}

function emit(level: "INFO" | "WARN" | "ERROR", msg: string, fields?: LogFields): void {
  const line = fmt(level, msg, fields);
  toConsole(level === "INFO" ? process.stdout : process.stderr, line);
  write(line);
}

export const log = {
  info: (msg: string, fields?: LogFields) => emit("INFO", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("WARN", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("ERROR", msg, fields),
  /** Where lines are landing, for the startup banner. "" when disabled. */
  file: target,
};

/**
 * Normalize anything that can be thrown into loggable fields. `throw null` and
 * `throw "boom"` are both legal: reading `.message` off the first is itself a
 * TypeError, and inside an uncaughtException handler that is fatal (Node exits
 * 7, taking every PTY with it) — a crash handler with its own crash path is
 * worse than none. The second doesn't throw but yields undefined for message
 * and stack, i.e. a log line with nothing in it.
 */
export function describe(err: unknown): LogFields {
  if (err instanceof Error) return { err: err.message, stack: err.stack };
  let text: string;
  try {
    text = String(err); // a hostile toString() can throw too
  } catch {
    text = "(unstringifiable)";
  }
  return { err: `non-Error throw (${typeof err}): ${text}` };
}
