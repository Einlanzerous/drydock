// The daemon's handle on a session supervisor (DRY-57).
//
// Everything `PtySession` used to get from an `IPty` it now gets from here:
// write, resize, kill, a stream of output, an exit. The difference is that the
// process on the other end is not our child and does not die with us.
//
// ONE READER OWNS THE SOCKET FOR ITS WHOLE LIFE, and the handshake is a phase
// within it rather than a separate pass. The obvious shape — read frames until
// Ready, then hand the socket to something else — silently eats output: a busy
// session's Ready and its next Data frames arrive in the same TCP segment and
// are decoded in the same loop, so whatever is listening at the moment Ready is
// seen is what receives them. Same reason `pendingData` exists below.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { log } from "../log.js";
import { forget, probeSocket, readExitRecord, sessionPaths, writeMeta } from "../sessions-dir.js";
import {
  FrameReader,
  Frame,
  PROTOCOL_VERSION,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  type SessionMeta,
  type SupervisorHello,
} from "./wire.js";

const SUPERVISOR_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

/** How long a freshly spawned supervisor gets to bind its socket. */
const SPAWN_READY_MS = 15_000;
const SPAWN_POLL_MS = 25;
const HANDSHAKE_MS = 5_000;

/** Reconnect budget for a socket that dropped while the supervisor still lives. */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 200;

export class ProtocolMismatch extends Error {}

export class SupervisorLink {
  private socket!: net.Socket;
  private reader!: FrameReader;
  /** Handshake until Ready arrives; the replay is only meaningful before it. */
  private phase: "handshake" | "live" = "handshake";
  private replayChunks: Buffer[] = [];
  private helloValue?: SupervisorHello;

  private dataCb?: (data: string) => void;
  /**
   * Output that arrived before anyone asked for it.
   *
   * There is a real gap between Ready and `PtySession` registering its handler
   * — the session object is constructed from the replay first — and a `claude`
   * mid-redraw fills it. Buffering here rather than racing means the first
   * frames after an adopt aren't the ones that go missing.
   */
  private pendingData: string[] = [];
  private exitCb?: (exitCode: number) => void;
  private pendingExit?: number;
  private reattachCb: (replay: Buffer) => void = () => {};

  private ready!: { resolve: () => void; reject: (err: Error) => void };
  private settled = false;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  /**
   * Reconnect attempts, on the LINK rather than inside recover()'s loop.
   *
   * A local counter resets every time a socket connects, so a supervisor that
   * accepts and immediately closes yields an endless connect/drop cycle instead
   * of the intended five tries. Only a completed handshake clears this.
   */
  private recoverAttempts = 0;
  /** Set once an Exit frame arrives, so a close afterwards is expected. */
  private ended = false;
  private disposed = false;

  private constructor(readonly id: string) {}

  get hello(): SupervisorHello {
    if (!this.helloValue) throw new Error("supervisor link used before its handshake completed");
    return this.helloValue;
  }

  /** Scrollback as it stood the moment we attached. Consumed once, by the session. */
  takeReplay(): Buffer {
    const replay = Buffer.concat(this.replayChunks);
    this.replayChunks = [];
    return replay;
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
    const buffered = this.pendingData;
    this.pendingData = [];
    for (const chunk of buffered) cb(chunk);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitCb = cb;
    if (this.pendingExit !== undefined) {
      const code = this.pendingExit;
      this.pendingExit = undefined;
      cb(code);
    }
  }

  /**
   * A dropped socket was re-established. The payload is the supervisor's whole
   * buffer again, which the session must REPLACE its scrollback with rather
   * than append to — the supervisor's copy is authoritative and we have no way
   * to know how much of it we already saw.
   */
  onReattach(cb: (replay: Buffer) => void): void {
    this.reattachCb = cb;
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.phase = "handshake";
    this.replayChunks = [];
    this.reader = new FrameReader(
      (type, payload) => this.onFrame(type, payload),
      (message) => {
        log.warn("bad frame from supervisor — dropping the connection", { id: this.id, message });
        this.fail(new Error(message));
        socket.destroy();
      },
    );
    socket.on("data", (chunk) => this.reader.push(chunk));
    // Announce ourselves before anything is sent to us. A supervisor stays
    // silent until it sees this, so a bare connect-and-hang-up (the liveness
    // probe) doesn't make it serialize a scrollback nobody will read.
    socket.write(encodeFrame(Frame.Attach));
    // Load-bearing, same class as the pg pool and WebSocket listeners: an
    // unhandled 'error' event throws. The daemon may now die without costing a
    // PTY, but it must still not die for a reason this trivial.
    socket.on("error", (err) => {
      log.warn("supervisor socket error", { id: this.id, err: String(err) });
      this.fail(err instanceof Error ? err : new Error(String(err)));
    });
    // Armed for EVERY connection, not just the first. `open()` used to own this
    // timer, which left the reconnect path with none: a supervisor that accepts
    // and then says nothing parked the link in handshake phase indefinitely,
    // replay chunks accumulating, with nothing to time it out.
    this.armHandshake(socket);
    socket.on("close", () => {
      // Only meaningful while a handshake is outstanding; a no-op afterwards.
      this.fail(new Error("supervisor closed the connection during handshake"));
      if (this.ended || this.disposed) return;
      // A link whose FIRST handshake never completed has no session behind it
      // yet — open()'s caller is already rejecting and will dispose. Recovering
      // here would also dereference a hello we never received.
      if (!this.helloValue) return;
      void this.recover();
    });
  }

  /** Drop a connection that connects and then says nothing. */
  private armHandshake(socket: net.Socket): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (this.phase === "live" || this.disposed) return;
      log.warn("supervisor handshake stalled — dropping the connection", {
        id: this.id,
        ms: HANDSHAKE_MS,
      });
      // Rejects an outstanding open(); on a reconnect `fail` is a no-op and the
      // destroy is what matters — it turns a stall into a counted attempt.
      this.fail(new Error(`supervisor handshake timed out after ${HANDSHAKE_MS}ms`));
      socket.destroy();
    }, HANDSHAKE_MS);
    this.handshakeTimer.unref?.();
  }

  private onFrame(type: number, payload: Buffer): void {
    switch (type) {
      case Frame.Hello: {
        const hello = decodeJson<SupervisorHello>(payload);
        if (!hello) return this.fail(new Error("supervisor sent an unparseable hello"));
        if (hello.protocol !== PROTOCOL_VERSION) {
          // Refuse by name rather than drive a wire we don't understand. The
          // supervisor keeps holding the PTY either way, so this leaves a human
          // a live agent to rescue instead of a garbled one.
          return this.fail(
            new ProtocolMismatch(
              `supervisor speaks protocol ${hello.protocol}, this daemon speaks ` +
                `${PROTOCOL_VERSION} — it was started by a different Drydock build`,
            ),
          );
        }
        this.helloValue = hello;
        return;
      }
      case Frame.Replay:
        if (this.phase === "handshake") this.replayChunks.push(payload);
        return;
      case Frame.Ready: {
        if (!this.helloValue) return this.fail(new Error("supervisor sent Ready before Hello"));
        this.phase = "live";
        clearTimeout(this.handshakeTimer);
        this.recoverAttempts = 0; // a completed handshake, and only that, is progress
        if (this.settled) {
          // A reconnect, not the first handshake: hand the session a fresh
          // authoritative buffer to replace what it had.
          this.reattachCb(this.takeReplay());
        } else {
          this.settled = true;
          this.ready.resolve();
        }
        return;
      }
      case Frame.Data: {
        const text = payload.toString("utf8");
        if (this.dataCb) this.dataCb(text);
        else this.pendingData.push(text);
        return;
      }
      case Frame.Exit: {
        this.ended = true;
        const code = decodeJson<{ exitCode: number }>(payload)?.exitCode ?? 0;
        if (this.exitCb) this.exitCb(code);
        else this.pendingExit = code;
        return;
      }
      default:
        log.warn("unknown frame from supervisor", { id: this.id, type });
    }
  }

  /** Reject the pending handshake, if one is still outstanding. */
  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.ready.reject(err);
  }

  /**
   * The socket dropped and no Exit frame explained it.
   *
   * This is the case that must not be guessed at. Declaring the session dead
   * while the supervisor is actually alive abandons a running agent that
   * nothing can reach any more — precisely the failure this ticket exists to
   * end — so ask the operating system whether the process is still there and
   * try to get back in before concluding anything.
   */
  private async recover(): Promise<void> {
    while (this.recoverAttempts < RECONNECT_ATTEMPTS) {
      if (this.disposed || this.ended) return;
      // Optional-chained: a link can reach here before Hello ever arrived, and
      // the `hello` getter THROWS in that state — into a floating promise, so
      // the failure surfaced as an UNHANDLED REJECTION instead of the "the
      // supervisor is gone" path below. Reachable: the supervisor holds its
      // listener open for 250ms after the child exits, and boot reconciliation
      // dials straight into that window.
      const pid = this.helloValue?.pid;
      if (pid === undefined || !alive(pid)) break;
      const attempt = ++this.recoverAttempts;
      await delay(RECONNECT_DELAY_MS * attempt);
      try {
        const socket = await dial(sessionPaths(this.id).sock);
        this.attach(socket);
        log.info("supervisor connection re-dialled", { id: this.id, attempt });
        // NOT recovered yet — `attach` starts a handshake that may still stall
        // or close. Ready is what clears recoverAttempts; until then a fresh
        // recover() picks up the count where this one left off.
        return;
      } catch (err) {
        log.warn("supervisor reconnect failed", { id: this.id, attempt, err: String(err) });
      }
    }
    if (this.disposed || this.ended) return;
    this.ended = true;
    // Ask the disk how it went before giving up on knowing (DRY-79). The
    // supervisor writes its exit record BEFORE broadcasting the Exit frame, so
    // a record here means the child ended properly and we merely weren't
    // listening — which is routine for a session that ends inside the attach
    // window: the frame was broadcast to an empty client set, and the socket we
    // then dialled closed 250ms later with nothing left to say. Reporting -1
    // for that made a `printf` that exited 0 a FAILED run, with DRY-49's
    // handoff and a tracker comment to match, and `session-exit` carrying
    // `endReason: failed` (DRY-64) — the same misreading DRY-49's trap 2 and
    // DRY-56's trap 3 are about, arrived at from the other side.
    //
    // -1 stays the answer when there is no record, and it still means what it
    // always meant: the supervisor is gone and nothing wrote down why.
    const record = readExitRecord(this.id);
    const code = record?.exitCode ?? -1;
    log.warn("supervisor is gone without an exit frame — treating the session as ended", {
      id: this.id,
      supervisorPid: this.helloValue?.pid,
      // Named rather than implied: "we found the record" and "we guessed" are
      // different enough that a log reader should not have to infer it from the
      // code being 0.
      exitCode: code,
      from: record ? "exit record" : "unknown",
    });
    if (this.exitCb) this.exitCb(code);
    else this.pendingExit = code;
  }

  write(data: string): void {
    this.send(encodeFrame(Frame.Input, Buffer.from(data, "utf8")));
  }

  resize(cols: number, rows: number): void {
    this.send(encodeJsonFrame(Frame.Resize, { cols, rows }));
  }

  kill(): void {
    this.send(encodeJsonFrame(Frame.Kill, {}));
  }

  private send(frame: Buffer): void {
    if (this.socket?.writable) this.socket.write(frame);
  }

  /**
   * Let go WITHOUT killing anything. Called on daemon shutdown: the whole point
   * is that the agent on the other end carries on and is found again at boot.
   */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.handshakeTimer);
    this.socket?.destroy();
  }

  // --- construction ---------------------------------------------------------

  private static async open(id: string, sock: string): Promise<SupervisorLink> {
    const link = new SupervisorLink(id);
    const ready = new Promise<void>((resolve, reject) => {
      link.ready = { resolve, reject };
    });
    try {
      // The handshake deadline is armed by attach(), which is also what covers
      // the reconnect path — see armHandshake.
      link.attach(await dial(sock));
      await ready;
      return link;
    } catch (err) {
      link.dispose();
      throw err;
    }
  }

  /**
   * Adopt an already-running supervisor. Undefined when nothing is listening.
   *
   * No separate liveness probe: the connection attempt IS the probe, and a
   * refused one answers the same question for the cost of one syscall instead
   * of two round trips per session at boot.
   */
  static async connect(id: string): Promise<SupervisorLink | undefined> {
    try {
      return await SupervisorLink.open(id, sessionPaths(id).sock);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A socket file outlives the process that bound it, so these two mean
      // "the supervisor is a corpse", not "something went wrong".
      if (code === "ECONNREFUSED" || code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * Write the index entry, start a detached supervisor, and wait until it is
   * actually reachable before handing back a link.
   *
   * The wait is not politeness. `POST /api/sessions` answers 201 with a session
   * id the client immediately opens a WebSocket against, so returning before
   * the socket is bindable turns every spawn into a race whose loser is a pane
   * that never connects. (herdr's client does the same thing for the same
   * reason — spawn the server, then poll the socket to a deadline.)
   */
  static async start(meta: SessionMeta): Promise<SupervisorLink> {
    try {
      return await SupervisorLink.spawn(meta);
    } catch (err) {
      // The index entry is written before the process exists, so every failure
      // past that point (exec failed, never bound, handshake died) would leave
      // a `<id>.json` for a session that never ran — which the next boot then
      // reports as "supervisor vanished without an exit record" before cleaning
      // it up, i.e. a scary line about a session nobody ever had.
      forget(meta.id);
      throw err;
    }
  }

  private static async spawn(meta: SessionMeta): Promise<SupervisorLink> {
    const paths = sessionPaths(meta.id);
    writeMeta(meta);

    // The supervisor's stdout/stderr, kept per session. NOT the daemon's log
    // file: config.ts already documents why concurrent daemons don't share one
    // (interleaved lines, raced rotations), and this is N more writers.
    const out = fs.openSync(paths.log, "a", 0o600);
    let died: number | null = null;
    try {
      const child = spawn(
        process.execPath,
        // Dev and prod both run `node --import tsx src/index.ts` (there is no
        // build step), so the supervisor needs the same loader flags — minus
        // `--watch`, which would give every session its own file watcher and
        // restart the process that is holding the PTY on any edit.
        [...process.execArgv.filter((a) => !a.startsWith("--watch")), SUPERVISOR_ENTRY, paths.meta],
        { detached: true, stdio: ["ignore", out, out] },
      );
      // detached + unref: its own process group and session (Node calls setsid
      // for us), and nothing about the daemon's event loop holds a reference.
      child.unref();
      child.once("exit", (code) => {
        died = code ?? -1;
      });
      // Its own 'error' listener, or a failed exec throws into the daemon.
      child.once("error", (err) => {
        log.warn("could not spawn the supervisor process", { id: meta.id, err: String(err) });
        died = -1;
      });

      const deadline = Date.now() + SPAWN_READY_MS;
      for (;;) {
        if ((await probeSocket(paths.sock)) === "live") break;
        if (died !== null) {
          throw new Error(`supervisor exited ${died} before binding its socket — see ${paths.log}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`supervisor did not bind ${paths.sock} within ${SPAWN_READY_MS}ms`);
        }
        await delay(SPAWN_POLL_MS);
      }
      return await SupervisorLink.open(meta.id, paths.sock);
    } finally {
      fs.closeSync(out);
    }
  }
}

function dial(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    const onError = (err: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      reject(err);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/** Does this pid still exist? Signal 0 checks without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
