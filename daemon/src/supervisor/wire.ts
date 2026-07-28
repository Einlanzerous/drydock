// The daemon↔supervisor wire (DRY-57).
//
// A session's PTY master no longer belongs to the daemon. It belongs to a tiny
// detached process that does nothing else, and the daemon talks to it over a
// unix socket — so the daemon can exit, crash, or be restarted by `--watch`
// without the agent on the other end noticing.
//
// Binary length-prefixed frames rather than JSON lines, because most of this
// traffic IS terminal output: base64 inside a JSON envelope would cost a third
// more bytes and a parse per chunk on the hottest path in the daemon.
//
//   [4-byte big-endian payload length][1-byte type][payload]
//
// The length covers the payload only; the type byte is read separately. A frame
// is refused above MAX_FRAME_BYTES rather than buffered — the socket is 0600 in
// the owner's home dir, but a corrupt length prefix on a stream we're about to
// concatenate is an unbounded allocation either way.
import type { PermissionMode, RunOrigin } from "../protocol.js";

/**
 * Bumped whenever a frame type or a metadata field changes meaning.
 *
 * This is a version-skew guard with teeth, and it is here because Drydock has
 * already been bitten by the soft kind (DRY-51: a response nobody checked,
 * parsed as if it were the shape that was wanted). A daemon that adopts a
 * supervisor spawned by a DIFFERENT build has to find out from a mismatched
 * integer, not from garbled terminal output or a metadata field that silently
 * reads `undefined` — the same reason herdr refuses a protocol mismatch by
 * name instead of letting the client and server drift into each other.
 *
 * A mismatch is NOT fatal to the session: the supervisor keeps holding the PTY
 * and the agent keeps running. The daemon just declines to drive it and says
 * so, which leaves a human a live process to rescue rather than a wedged one.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Frame cap. Replay is chunked well under this (see REPLAY_CHUNK_BYTES); the
 * headroom is for a browser paste arriving as one INPUT frame.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Scrollback is handed over in chunks so one adopt can't demand a 1 MiB
 * contiguous allocation on both sides at once. The daemon reassembles them
 * before decoding — see the note on Replay below.
 */
export const REPLAY_CHUNK_BYTES = 256 * 1024;

export const Frame = {
  /**
   * supervisor → daemon, JSON `SupervisorHello`. Always the first frame on a
   * connection, so the version check happens before anything is interpreted.
   */
  Hello: 1,
  /**
   * supervisor → daemon, raw bytes. The ring buffer as it stood when this
   * client connected, in order.
   *
   * The daemon must CONCATENATE these before decoding UTF-8, never decode them
   * one at a time: the chunk boundary is a byte count and lands mid-character
   * often enough to matter (any accented word, any box-drawing character, and
   * a `claude` TUI is made of box-drawing characters). Live Data frames don't
   * have this problem — each one is exactly one node-pty string.
   */
  Replay: 2,
  /** supervisor → daemon, empty. Replay is complete; what follows is live. */
  Ready: 3,
  /** supervisor → daemon, raw bytes — one node-pty chunk, whole. */
  Data: 4,
  /** supervisor → daemon, JSON `{exitCode}`. The child is gone. */
  Exit: 5,
  /** daemon → supervisor, raw bytes to write to the PTY. */
  Input: 6,
  /** daemon → supervisor, JSON `{cols, rows}`. */
  Resize: 7,
  /** daemon → supervisor, JSON `{signal?}`. Kill the child. */
  Kill: 8,
  /**
   * daemon → supervisor, empty. "I am a real client — start talking."
   *
   * Nothing is sent until this arrives, which is what makes a liveness probe
   * free. Without it, merely opening the socket to ask "is anyone home?" made
   * the supervisor serialize its entire scrollback to a connection about to be
   * dropped, and then log the EPIPE — paid twice per session on every boot,
   * once by the probe and once by the connection that actually attaches.
   */
  Attach: 9,
} as const;

export type FrameType = (typeof Frame)[keyof typeof Frame];

/** Human-readable frame names, for log lines about a wire that went wrong. */
export const FRAME_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Frame).map(([name, type]) => [type, name]),
);

/** The supervisor's opening statement. Everything the daemon can't re-derive. */
export interface SupervisorHello {
  protocol: number;
  sessionId: string;
  /** The supervisor's own pid — the process holding the PTY master. */
  pid: number;
  /** The wrapped CLI's pid, for a human with `ps` and a question. */
  childPid: number;
  startedAt: number;
  cols: number;
  rows: number;
}

/**
 * Everything the daemon must be able to rebuild a `PtySession` from after a
 * restart, written to `<id>.json` beside the socket.
 *
 * This is the "rediscovery index" DRY-57 has to settle the location of, and it
 * is deliberately a plain file rather than a row in the state store: it must be
 * readable at boot on a host with no database, and `PostgresStore` connects
 * nothing at boot precisely so a dead database never costs a PTY (DRY-28). The
 * daemon writes it at spawn and rewrites it when one of these fields changes;
 * the supervisor only ever reads it.
 *
 * NB this is runtime state with a process's lifetime — the moral equivalent of
 * a pidfile. DRY-56's `pty_sessions` is a different record with a different
 * job: retained, queryable history that outlives the process. They are not two
 * copies of one fact, and this one must never grow a query.
 */
export interface SessionMeta {
  /** Bumped with PROTOCOL_VERSION; an unreadable generation is skipped, not guessed at. */
  protocol: number;
  id: string;
  createdAt: number;
  /** The LOGICAL command ("claude", "shell"), not the resolved executable. */
  command: string;
  args: string[];
  /**
   * What to actually exec, resolved by the daemon at spawn time.
   *
   * The supervisor is told this rather than deriving it, and that is the whole
   * design in one field: resolving "claude" into `claude --settings <path>
   * --permission-mode <mode>` needs hooks.ts and the permission whitelist, and
   * a process whose only job is to hold a file descriptor must not import the
   * half of the daemon that decides policy. It holds an fd and copies bytes.
   */
  exec: { file: string; args: string[] };
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  ticket?: string;
  worktree?: string;
  branch?: string;
  autonomous: boolean;
  origin: RunOrigin;
  permissionMode: PermissionMode;
  /**
   * Only the variables the daemon ADDS to the child's environment — never a
   * snapshot of `process.env`. The supervisor inherits the daemon's environment
   * the ordinary way, so a host's tracker token stays in memory instead of
   * being written to a file next to a socket. (0600 either way; the cheapest
   * secret to protect is the one that was never persisted.)
   */
  env: Record<string, string>;
  /**
   * Set once runs.ts has written this run's handoff. Load-bearing for boot
   * reconciliation, not decoration: its ABSENCE next to an exit record is how
   * the daemon knows a run ended while it was down and still owes a human its
   * artefacts. Without it, every restart would re-post to the tracker.
   */
  handoff?: string;
}

/** The supervisor's parting note, written next to the metadata as `<id>.exit.json`. */
export interface ExitRecord {
  protocol: number;
  exitCode: number;
  endedAt: number;
}

/**
 * Socket filename for a session id — a PREFIX of the uuid, not the whole thing.
 *
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS, and that is the
 * entire absolute path. A full uuid plus `.sock` spends 41 of them on the
 * filename alone, which leaves a surprisingly ordinary home directory unable to
 * hold a session; 12 hex characters is 48 bits, and the namespace is one
 * directory holding one host's live sessions.
 *
 * Derived rather than stored so the daemon and the supervisor compute the same
 * path from the same id without another field to keep in step.
 */
export function socketName(id: string): string {
  return `${id.slice(0, 12)}.sock`;
}

/** Encode one frame. `payload` is already-serialized bytes. */
export function encodeFrame(type: FrameType, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(payload.byteLength, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, payload]);
}

/** Encode a frame whose payload is JSON. */
export function encodeJsonFrame(type: FrameType, value: unknown): Buffer {
  return encodeFrame(type, Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * Streaming frame decoder.
 *
 * A socket hands us arbitrary byte boundaries, so this holds a tail buffer and
 * yields whole frames only. Written as a class with a callback rather than an
 * async iterator because it sits on the PTY output path, where an extra promise
 * per chunk is a cost paid thousands of times a second for a `claude` redraw.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (type: number, payload: Buffer) => void,
    /** Called once on a fault. The caller's job is to drop the connection. */
    private readonly onFault: (message: string) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.byteLength === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.byteLength < 5) return;
      const length = this.buf.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        // Refuse rather than grow. Past this point the stream is not
        // recoverable anyway: we can't find the next frame boundary without
        // trusting the length we just rejected.
        return this.onFault(`frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES} cap`);
      }
      if (this.buf.byteLength < 5 + length) return; // wait for the rest
      const type = this.buf.readUInt8(4);
      const payload = this.buf.subarray(5, 5 + length);
      // Copy: subarray shares memory with `buf`, which we are about to replace
      // and which the caller may hold on to (scrollback keeps its chunks).
      this.buf = this.buf.subarray(5 + length);
      this.onFrame(type, Buffer.from(payload));
    }
  }
}

/** Parse a JSON frame payload, or undefined if it isn't parseable. */
export function decodeJson<T>(payload: Buffer): T | undefined {
  try {
    return JSON.parse(payload.toString("utf8")) as T;
  } catch {
    return undefined;
  }
}
