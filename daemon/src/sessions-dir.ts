// The rediscovery index (DRY-57).
//
// One directory of small files, one set per live session, which is how a
// restarted daemon finds the PTYs it used to own:
//
//   <id>.json          SessionMeta — everything needed to rebuild a PtySession
//   <id>.sock          the supervisor's unix socket (0600)
//   <id>.exit.json     written by the supervisor when the child exits
//   <id>.scrollback    the ring buffer, flushed once on exit
//   <id>.log           the supervisor's own stdio
//
// WHY A DIRECTORY AND NOT THE STATE STORE. It has to be readable at boot with
// no database — that's the default install, and DRY-28's `PostgresStore`
// deliberately connects nothing at boot so a dead database can never cost a
// PTY. A store that might be unreachable is the wrong place for the one record
// that decides whether a live agent is found or abandoned. This is a pidfile,
// not a table.
//
// PER-PORT, like the log file and the state file, and for the documented
// reason: the way to verify a change is a second daemon on a spare port
// (CLAUDE.md), and a shared directory would make that throwaway daemon adopt
// the dev daemon's live agents — reparenting them to a process about to be
// Ctrl-C'd. The cost of that choice is that moving a daemon's port abandons its
// sessions; DRYDOCK_SESSIONS_DIR is the deliberate way to move them with it.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import { expandHome } from "./repos.js";
import {
  PROTOCOL_VERSION,
  SUFFIX,
  socketName,
  type ExitRecord,
  type SessionMeta,
} from "./supervisor/wire.js";

/**
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS, and bind()
 * fails with a bare ENAMETOOLONG that says nothing about which knob to turn.
 * Checked up front so a long home directory produces a sentence instead.
 */
const SUN_PATH_MAX = 100;

/** Owner-only. The daemon's TCP port is already unauthenticated (DRY-27), but
 * that is an argument for not opening a SECOND door: anything that can connect
 * to one of these sockets can type into that agent's terminal. */
const OWNER_ONLY = 0o600;

export interface SessionPaths {
  meta: string;
  sock: string;
  exit: string;
  scrollback: string;
  log: string;
}

let ensured = false;

/** The index directory, created on first use. */
export function sessionsDir(): string {
  const dir = expandHome(CONFIG.sessionsDir);
  if (!ensured) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensured = true;
  }
  return dir;
}

export function sessionPaths(id: string): SessionPaths {
  const dir = sessionsDir();
  return {
    meta: path.join(dir, `${id}${SUFFIX.meta}`),
    sock: path.join(dir, socketName(id)),
    exit: path.join(dir, `${id}${SUFFIX.exit}`),
    scrollback: path.join(dir, `${id}${SUFFIX.scrollback}`),
    log: path.join(dir, `${id}${SUFFIX.log}`),
  };
}

/**
 * Fail early and legibly if the socket path can't fit in a sockaddr_un. Called
 * before a spawn, so the error lands on the request that caused it rather than
 * inside a detached process whose stderr nobody is reading yet.
 */
export function assertSocketPathFits(id: string): void {
  const sock = sessionPaths(id).sock;
  if (Buffer.byteLength(sock) > SUN_PATH_MAX) {
    throw new Error(
      `session socket path is ${Buffer.byteLength(sock)} bytes, over the ~${SUN_PATH_MAX} ` +
        `byte unix-socket limit (${sock}). Set DRYDOCK_SESSIONS_DIR to something shorter.`,
    );
  }
}

/**
 * Write the metadata a restart reads back. Synchronous and rewritten whole:
 * it's a few hundred bytes, and the alternative — a partially updated index —
 * is a session the next boot can't identify.
 */
export function writeMeta(meta: SessionMeta): void {
  const file = sessionPaths(meta.id).meta;
  const tmp = `${file}.tmp`;
  // Write-then-rename so a daemon killed mid-write leaves the previous
  // generation intact rather than a truncated file. This index is read exactly
  // once, at boot, by a process that has no other way to find these sessions.
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: OWNER_ONLY });
  fs.renameSync(tmp, file);
}

function parseMeta(file: string): SessionMeta | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let meta: SessionMeta;
  try {
    meta = JSON.parse(raw) as SessionMeta;
  } catch (err) {
    log.warn("unreadable session metadata — skipping", { file, err: String(err) });
    return undefined;
  }
  // A metadata file from another build is skipped, not coerced. Guessing at a
  // field that changed meaning is how a session gets adopted with the wrong
  // permission mode — i.e. an agent that gates less than the host asked for.
  //
  // This — not the ProtocolMismatch check on the wire — is where a version skew
  // actually lands, because the supervisor refuses to start on foreign metadata
  // in the first place, so the two always agree. Hence the volume: an operator
  // upgrading mid-session needs to know they now have a live agent nothing can
  // reach, and the files are LEFT IN PLACE deliberately. Deleting them would
  // remove the only handle anything has on that process; a human can still find
  // it by pid and the supervisor keeps its PTY alive in the meantime.
  if (meta?.protocol !== PROTOCOL_VERSION || typeof meta.id !== "string") {
    log.error("session from a different Drydock build — cannot adopt, leaving it running", {
      file,
      found: meta?.protocol,
      expected: PROTOCOL_VERSION,
    });
    return undefined;
  }
  return meta;
}

/** Every session this directory knows about, oldest first. */
export function listMeta(): SessionMeta[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir());
  } catch (err) {
    log.warn("could not read the sessions directory", { err: String(err) });
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    // `.exit.json` also ends in `.json`; exclude it explicitly.
    if (!entry.endsWith(SUFFIX.meta) || entry.endsWith(SUFFIX.exit) || entry.endsWith(".tmp")) {
      continue;
    }
    const meta = parseMeta(path.join(sessionsDir(), entry));
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => a.createdAt - b.createdAt);
}

export function readExitRecord(id: string): ExitRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(sessionPaths(id).exit, "utf8")) as ExitRecord;
    return record?.protocol === PROTOCOL_VERSION ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The scrollback the supervisor flushed on its way out.
 *
 * This is what makes a run that ended while the daemon was down still able to
 * produce a handoff document — DRY-49's artefacts are built from the transcript,
 * and before this the transcript died with the process.
 */
export function readScrollback(id: string): Buffer | undefined {
  try {
    return fs.readFileSync(sessionPaths(id).scrollback);
  } catch {
    return undefined;
  }
}

/** Drop every file for a session. Called once its record is safely in memory. */
export function forget(id: string): void {
  const p = sessionPaths(id);
  for (const file of [p.meta, p.exit, p.scrollback, p.sock, p.log]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone — this runs on paths that may never have existed */
    }
  }
}

export type SocketProbe = "live" | "stale";

/**
 * Is a supervisor still listening here?
 *
 * The file existing proves nothing: a unix socket outlives the process that
 * bound it, so a supervisor killed with SIGKILL leaves one behind that looks
 * identical to a live one on disk. The only honest test is to connect —
 * ECONNREFUSED/ENOENT means the file is a corpse (herdr's `prepare_socket_path`
 * reaches the same conclusion the same way). Anything else is treated as live,
 * because wrongly declaring a socket stale unlinks the only handle we have on a
 * running agent.
 */
export function probeSocket(sock: string): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const socket = net.connect(sock);
    const done = (result: SocketProbe): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done("live"));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "stale" : "live"),
    );
    // A socket file whose supervisor is wedged (listening, not accepting) would
    // otherwise hold boot open forever, and boot is when every session is being
    // rediscovered at once.
    socket.setTimeout(2_000, () => done("stale"));
  });
}
