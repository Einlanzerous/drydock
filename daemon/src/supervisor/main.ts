// The session supervisor (DRY-57) — one detached process per PTY.
//
// Run as: node --import tsx supervisor/main.ts <path to <id>.json>
//
// WHAT THIS PROCESS IS FOR. Until this existed, a session's lifetime WAS the
// daemon process's: `pty.spawn` made every agent a child of the daemon, so the
// daemon exiting closed the PTY master and took every live agent with it,
// unrecoverably. That single fact shaped a lot of Drydock — the daemon stayed
// alive through uncaught exceptions on purpose, `--watch` became the loudest
// warning in CLAUDE.md, and DRY-49's handoff documents exist partly because an
// unattended run's scrollback died with the daemon.
//
// Note that surviving the SIGNAL is not the same as surviving the PIPE. A
// `setsid` child would outlive the daemon's process group and then be hung up
// the instant the master fd closed anyway. Somebody has to keep holding that
// descriptor, so this process does — and nothing else.
//
// THE CRASH POSTURE INVERTS HERE. The daemon can now afford to die: it comes
// back and reattaches. This process cannot — nothing below it will catch the
// session — so it swallows uncaught exceptions where the daemon no longer
// does. That is also why it is kept this small and imports almost nothing: the
// least code with the fewest reasons to fail should be what owns the fd.
//
// Deliberately NOT imported by the daemon (only referenced by path), so that
// editing it doesn't restart a `--watch` daemon and defeat the point of it.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as pty from "node-pty";
import { CONFIG } from "../config.js";
import {
  FrameReader,
  Frame,
  PROTOCOL_VERSION,
  REPLAY_CHUNK_BYTES,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  socketName,
  type ExitRecord,
  type SessionMeta,
  type SupervisorHello,
} from "./wire.js";

/** Matches log.ts's line shape so a supervisor log reads like a daemon log. */
function emit(level: "INFO" | "WARN" | "ERROR", msg: string, fields: Record<string, unknown> = {}): void {
  let line = `${new Date().toISOString()} ${level.padEnd(5)} [drydock/sup] ${msg}`;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const s = String(v);
    line += ` ${k}=${/[\s"]/.test(s) ? JSON.stringify(s) : s}`;
  }
  // One stream, because the daemon points both at the same <id>.log and
  // interleaving two buffered streams into one file reorders the lines.
  process.stdout.write(line + "\n");
}

const metaPath = process.argv[2];
if (!metaPath) {
  emit("ERROR", "usage: supervisor/main.ts <session meta path>");
  process.exit(2);
}

const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as SessionMeta;
if (meta.protocol !== PROTOCOL_VERSION) {
  emit("ERROR", "refusing to start on foreign metadata", {
    found: meta.protocol,
    expected: PROTOCOL_VERSION,
  });
  process.exit(2);
}

const dir = path.dirname(metaPath);
const sockPath = path.join(dir, socketName(meta.id));
const exitPath = path.join(dir, `${meta.id}.exit.json`);
const scrollbackPath = path.join(dir, `${meta.id}.scrollback`);

// --- the PTY ---------------------------------------------------------------

const child = pty.spawn(meta.exec.file, meta.exec.args, {
  name: "xterm-256color",
  cols: meta.cols,
  rows: meta.rows,
  cwd: meta.cwd,
  // The daemon's environment, inherited the ordinary way, plus the handful of
  // variables it adds. `meta.env` carries ONLY those additions — a snapshot of
  // process.env in the index file would mean writing the host's tracker
  // credentials to disk next to a socket, to gain nothing.
  env: { ...(process.env as Record<string, string>), ...meta.env },
});

emit("INFO", "supervising", {
  id: meta.id,
  pid: process.pid,
  childPid: child.pid,
  exec: [meta.exec.file, ...meta.exec.args].join(" "),
  cwd: meta.cwd,
});

/** Last size any client asked for; reported to the next one that attaches. */
let cols = meta.cols;
let rows = meta.rows;

/**
 * The scrollback ring buffer, moved here from the daemon.
 *
 * This is the half of DRY-3 that had to move: replay-on-attach is only "the
 * agent kept running and we replay everything it printed while you were gone"
 * if the buffer outlives the daemon too. Same cap and the same coarse
 * whole-chunk trimming as before, so a reattach gets full history rather than a
 * flood.
 */
let scrollback: Buffer[] = [];
let scrollbackBytes = 0;

function remember(chunk: Buffer): void {
  scrollback.push(chunk);
  scrollbackBytes += chunk.byteLength;
  while (scrollbackBytes > CONFIG.scrollbackBytes && scrollback.length > 1) {
    scrollbackBytes -= scrollback.shift()!.byteLength;
  }
}

// --- clients ---------------------------------------------------------------

const clients = new Set<net.Socket>();

function broadcast(frame: Buffer): void {
  for (const socket of clients) {
    // A client that has gone away must cost that client only. Writes to a
    // half-closed socket surface as an asynchronous 'error' (handled per
    // socket below), so this can't throw into the PTY data path.
    if (socket.writable) socket.write(frame);
  }
}

child.onData((data) => {
  const chunk = Buffer.from(data, "utf8");
  remember(chunk);
  broadcast(encodeFrame(Frame.Data, chunk));
});

net
  .createServer((socket) => {
    // NOT added to `clients` yet, and nothing is written. A connection only
    // becomes a client when it says Attach — see that frame's note in wire.ts.
    // Liveness probes connect and hang up, and must cost nothing.
    socket.on("error", (err) => {
      emit("WARN", "client socket error — dropping that client", { err: String(err) });
      clients.delete(socket);
      socket.destroy();
    });
    socket.on("close", () => clients.delete(socket));

    const reader = new FrameReader(
      (type, payload) => {
        if (type === Frame.Attach) return greet(socket);
        onClientFrame(type, payload);
      },
      (message) => {
        emit("WARN", "bad frame from client — dropping it", { message });
        clients.delete(socket);
        socket.destroy();
      },
    );
    socket.on("data", (chunk) => reader.push(chunk));
  })
  .listen(sockPath, () => {
    // Owner-only, and set AFTER bind because bind creates the node with the
    // process umask. Anything that can connect here can type into this agent's
    // terminal, which is a door the daemon's own (unauthenticated) TCP port
    // being open is no excuse for adding a second of.
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch (err) {
      emit("WARN", "could not restrict socket permissions", { err: String(err) });
    }
    emit("INFO", "listening", { sock: sockPath });
  })
  .on("error", (err) => {
    // Nothing can reach this session without the socket, so there is no point
    // holding a PTY nobody can drive. Exiting here (before any client has
    // attached) is the one case where this process is allowed to give up.
    emit("ERROR", "could not bind the session socket — giving up", { sock: sockPath, err: String(err) });
    child.kill();
    process.exit(1);
  });

/** Promote a connection to a client: identify ourselves, hand over the buffer. */
function greet(socket: net.Socket): void {
  clients.add(socket);
  const hello: SupervisorHello = {
    protocol: PROTOCOL_VERSION,
    sessionId: meta.id,
    pid: process.pid,
    childPid: child.pid,
    startedAt: meta.createdAt,
    cols,
    rows,
  };
  socket.write(encodeJsonFrame(Frame.Hello, hello));

  // Hand over the buffer in chunks, then say so. The daemon concatenates before
  // decoding — a 256 KiB boundary lands mid-UTF-8-character routinely (a
  // `claude` TUI is largely box-drawing characters).
  const all = Buffer.concat(scrollback);
  for (let at = 0; at < all.byteLength; at += REPLAY_CHUNK_BYTES) {
    socket.write(encodeFrame(Frame.Replay, all.subarray(at, at + REPLAY_CHUNK_BYTES)));
  }
  socket.write(encodeFrame(Frame.Ready));
  emit("INFO", "client attached", { clients: clients.size, replayBytes: all.byteLength });
}

function onClientFrame(type: number, payload: Buffer): void {
  switch (type) {
    case Frame.Input:
      child.write(payload.toString("utf8"));
      break;
    case Frame.Resize: {
      const size = decodeJson<{ cols: number; rows: number }>(payload);
      if (!size) return;
      cols = size.cols;
      rows = size.rows;
      try {
        child.resize(size.cols, size.rows);
      } catch {
        /* racing a just-exited PTY */
      }
      break;
    }
    case Frame.Kill:
      emit("INFO", "kill requested", { id: meta.id });
      child.kill();
      break;
    default:
      emit("WARN", "unknown frame type from client", { type });
  }
}

// --- the ending ------------------------------------------------------------

child.onExit(({ exitCode, signal }) => {
  // A signalled child reports exitCode 0 with the signal alongside, so passing
  // the raw code on would tell the daemon a killed run "exited cleanly" — and
  // for an autonomous run that is the difference between `finished` and
  // `failed`, i.e. between silence and a handoff saying nobody was watching.
  // 128+n is the convention the rest of Drydock already assumes (DRY-49's note
  // about stops exiting 129/143).
  const code = exitCode === 0 && signal ? 128 + signal : exitCode;
  emit("INFO", "child exited", { id: meta.id, exitCode: code, signal, clients: clients.size });

  // Flush the transcript BEFORE announcing anything. If the daemon is down,
  // this file is the only account of what the run did — it is what lets boot
  // reconciliation still write DRY-49's handoff document for a run that ended
  // while nobody was home. One write, once, at the end of a session.
  try {
    fs.writeFileSync(scrollbackPath, Buffer.concat(scrollback), { mode: 0o600 });
  } catch (err) {
    emit("WARN", "could not flush scrollback", { err: String(err) });
  }
  try {
    const record: ExitRecord = { protocol: PROTOCOL_VERSION, exitCode: code, endedAt: Date.now() };
    fs.writeFileSync(exitPath, JSON.stringify(record), { mode: 0o600 });
  } catch (err) {
    emit("WARN", "could not write the exit record", { err: String(err) });
  }

  broadcast(encodeJsonFrame(Frame.Exit, { exitCode: code }));

  // Let the exit frame drain before tearing the socket down, or an attached
  // daemon learns about the exit from a closed connection instead of from the
  // frame that carries the code.
  setTimeout(() => {
    for (const socket of clients) socket.end();
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* already gone */
    }
    process.exit(0);
  }, 250);
});

/**
 * This process holds a live PTY and there is nothing underneath it. The daemon
 * gave up this posture in DRY-57 precisely because it could afford to; here it
 * is still the right trade, and it costs far less because there is so little
 * code to be wrong.
 */
process.on("uncaughtException", (err) => {
  emit("ERROR", "UNCAUGHT EXCEPTION — staying up", {
    id: meta.id,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});
process.on("unhandledRejection", (reason) => {
  emit("ERROR", "UNHANDLED REJECTION — staying up", { id: meta.id, reason: String(reason) });
});
