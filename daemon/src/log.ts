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
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { expandHome } from "./repos.js";

export type LogFields = Record<string, unknown>;

/** Bytes in the current log file; -1 until we've stat'd it (lazy open). */
let bytes = -1;

function target(): string {
  return CONFIG.log.file ? expandHome(CONFIG.log.file) : "";
}

/** Append one line, rotating a single generation aside when over the cap. */
function write(line: string): void {
  const file = target();
  if (!file) return; // DRYDOCK_LOG_FILE= (empty) disables the file sink
  try {
    if (bytes < 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
    const size = Buffer.byteLength(line) + 1;
    if (bytes > 0 && bytes + size > CONFIG.log.maxBytes) {
      // One generation is enough to cover "what happened just before the crash"
      // without turning into a log-management project.
      try {
        fs.renameSync(file, `${file}.1`);
        bytes = 0;
      } catch {
        /* rotation failed — keep appending rather than lose the line */
      }
    }
    fs.appendFileSync(file, line + "\n");
    bytes += size;
  } catch {
    // Logging must never be the thing that takes the daemon down.
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
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
  write(line);
}

export const log = {
  info: (msg: string, fields?: LogFields) => emit("INFO", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("WARN", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("ERROR", msg, fields),
  /** Where lines are landing, for the startup banner. "" when disabled. */
  file: target,
};
