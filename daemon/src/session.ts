import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_PATH_AUTONOMOUS } from "./hooks.js";
import { log } from "./log.js";
import { assertSocketPathFits, forget, writeMeta } from "./sessions-dir.js";
import { SupervisorLink } from "./supervisor/link.js";
import { PROTOCOL_VERSION, type SessionMeta } from "./supervisor/wire.js";
import type { SessionStart } from "./state/types.js";
import type {
  EventMessage,
  PendingGate,
  PermissionDecision,
  PermissionMode,
  RunFailure,
  RunOrigin,
  ServerMessage,
  SessionEndOutcome,
  SessionInfo,
  SessionStatus,
  SessionVisibility,
} from "./protocol.js";

/**
 * How finely a seeded replay is cut before it enters the ring (DRY-79).
 *
 * Only the trim's granularity — the buffer is concatenated again on every
 * attach — so this trades a few array entries for a ring that degrades by
 * 64 KiB rather than by everything it was seeded with. Independent of the
 * supervisor's REPLAY_CHUNK_BYTES, which sizes a frame on a socket.
 */
const SEED_CHUNK_BYTES = 64 * 1024;

/**
 * When the CLI is ready to be typed at (DRY-49, retuned in DRY-88).
 *
 * All three numbers are measured against Claude Code v2.1.238 on this host,
 * from a client that attaches immediately and answers the CLI's DA1 query the
 * way a real terminal does. Its startup writes, relative to the attach:
 *
 *   333ms  ~13 bytes   save cursor, reset scroll region, show cursor
 *   372ms   ~6 bytes   hide cursor
 *   393ms  ~24 bytes   enable bracketed paste / focus events
 *  1100ms  ~18 bytes   set the window title
 *  1268ms  ~849 bytes  THE BANNER — the first thing that is actually painted
 *  1397ms  ~47 bytes   cursor parked in the composer
 *
 * Input sent at 1200ms was still discarded; at 1400ms it arrived. So "ready"
 * lands within ~50ms of the first paint finishing, and nothing before it
 * counts: the four escape-only writes are the CLI *configuring* a terminal,
 * not using one. A settle armed on those fires at ~1.6s — which is what was
 * happening — and a prompt sent then is lost in silence, since a CLI that
 * isn't listening yet does not error.
 *
 * Hence: arm on the first PAINT, wait for output to go quiet, and never fire
 * inside the floor.
 *
 * THE FLOOR IS LOAD-BEARING, and for two cases rather than the obvious one. It
 * covers a host slow enough to split the paint across a gap wider than the
 * settle — and it is also the whole margin under a MISREAD paint, which is a
 * thing that can genuinely happen: a chunk boundary through an escape sequence
 * leaves printable residue on the far side (`\x1b[?20` + `04h` reads as a
 * paint), so a badly-cut stream can arm this clock at the CLI's very first
 * write. Measured from there the floor still clears the 1400ms the CLI needs,
 * which is why 2000ms rather than something snugger: it is sized to be right
 * when `paintsSomething` is wrong.
 */
const INITIAL_INPUT_SETTLE_MS = 1_200;
const INITIAL_INPUT_FLOOR_MS = 2_000;
/** Ceiling, for a CLI that never falls quiet (spinners, animated banners). */
const INITIAL_INPUT_CEILING_MS = 15_000;

/**
 * Did this chunk put anything on the screen?
 *
 * Escape sequences and control bytes are stripped; whatever is left is what a
 * human would see. Deliberately includes an OSC title change in what it
 * strips — a CLI that has only named the window has not drawn anything yet.
 */
function paintsSomething(chunk: string): boolean {
  const text = chunk
    // The string-payload escapes first — OSC, then DCS/SOS/PM/APC — since their
    // payloads are ordinary text, and anything that stripped only the introducer
    // would read a window title as a screenful.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // Two rules for the DCS family, not one with an optional terminator: a
    // lazy `*?` in front of an OPTIONAL suffix matches the empty string, so
    // that spelling strips the introducer and leaves the payload behind —
    // which is the opposite of the job.
    .replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_X][\s\S]*$/g, "")
    // Then CSI, then anything else shaped like ESC + intermediates + a final
    // byte. That last one has to be a RANGE, not a hand-listed set: written as
    // `\x1b[@-Z\\-_]` it misses ESC 7 / ESC 8 (save/restore cursor), which is
    // the first thing Claude Code writes — measured, the stray "7" left behind
    // read as a paint and armed the settle 900ms before anything was drawn.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, "");
  return /\S/.test(text);
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
  /**
   * Extra variables for the PTY, on top of the daemon's own environment.
   *
   * Since DRY-66 a caller can fill this over HTTP (`POST /api/sessions`), which
   * is why `sanitizeSpawnEnv` exists — this type says nothing about what may be
   * in here, and the route is the only place that can. Note the two things that
   * outrank it: the daemon's own keys are spread after it just below, and the
   * supervisor's DRY-59 strip runs after that.
   */
  env?: Record<string, string>;
  /** Tracker ticket this session is scoped to; surfaced to the SessionStart hook. */
  ticket?: string;
  /**
   * Tracker repo NAME, kept alongside the cwd it resolved to (DRY-56).
   *
   * The daemon used to resolve `repo` → cwd at spawn and drop the name, which
   * left a tombstone unable to say which repo a dead session belonged to — a
   * path is not an answer to "what was this working on". Deliberately NOT added
   * to SessionInfo: the browser reads it off the history record, and mirroring
   * a field into protocol.ts costs a hand-synced copy in the shell for
   * something no live pane renders.
   */
  repo?: string;
  /** Isolated git worktree the session runs in (DRY-15); equals cwd when set. */
  worktree?: string;
  /** Branch checked out in that worktree. */
  branch?: string;
  /** Run unattended: a rail card instead of a window, and hour-long gates (DRY-49). */
  autonomous?: boolean;
  /** Who kicked it off. Defaults to the human at the browser. */
  origin?: RunOrigin;
  /** How much it may do without asking. Defaults to `manual` (gate everything). */
  permissionMode?: PermissionMode;
  /**
   * The account this session belongs to (DRY-27). Taken from the authenticated
   * caller by the route — never from the request body, which would let anyone
   * spawn a session in somebody else's name.
   */
  owner?: string;
  /** Display name of that account, cached on the session for the desk to label. */
  ownerName?: string;
  /** Who else may see it. Defaults to `private`; see SessionVisibility. */
  visibility?: SessionVisibility;
  /**
   * First prompt, typed into the PTY by the DAEMON once the CLI has painted
   * and settled (see scheduleInitialInput).
   *
   * Every spawn path that has a prompt uses this since DRY-88 — the supervised
   * one included, which used to seed it into TerminalPane and have the pane
   * type it 700ms after its socket opened. Two things were wrong with that and
   * only one of them was the timing: the other is that a browser's copy of the
   * prompt is deleted by anything that re-mounts the pane, so the reconcile
   * races and the poll landing mid-spawn all had a say in whether an agent
   * ever heard what it was spawned to do.
   *
   * Whether the RETURN is pressed afterwards is `autonomous`, not this field.
   */
  input?: string;
}

/**
 * How a run ended, for the surfaces that have to say something durable about
 * it (DRY-49). Note `ended-turn` is not a claim of completion: the Stop hook
 * fires when the agent hands control back, which is "done OR waiting for a
 * reply", and we can't tell which — so the word "finished" is reserved for a
 * process that actually exited zero.
 */
export type RunEndReason = "finished" | "ended-turn" | "failed" | "stopped";

/**
 * Does "whose session is this" mean anything on this daemon? (DRY-27)
 *
 * Only under multi-user. Everywhere else there is exactly one identity, so an
 * ownership check can only ever produce a wrong answer — and it did, in the
 * direction nobody tests: turn multi-user OFF again and every session spawned
 * while it was on carries a uuid owner, while the viewer is now the
 * `DRYDOCK_OWNER` constant. Owned, not yours, not public: invisible and
 * unkillable, on a daemon with no accounts to explain it.
 *
 * Read at call time rather than captured, because the mode is host config and a
 * session outlives the process that spawned it.
 */
function ownershipApplies(): boolean {
  return CONFIG.auth.mode === "multi";
}

export type RunEndNotifier = (session: PtySession, reason: RunEndReason) => void;

/**
 * Told when ANY session ends — autonomous or not (DRY-56).
 *
 * Separate from RunEndNotifier because that one is gated on `autonomous`
 * inside announceRunEnd: a supervised session ending its turn is a person
 * sitting in front of it, and DRY-49's artefacts are for the runs nobody saw.
 * History has the opposite requirement — a tombstone for a plain shell you
 * closed is exactly as useful as one for an unattended agent — so recording it
 * through the run-end path would silently keep history for a fraction of
 * sessions and look like it worked.
 */
export type SessionEndNotifier = (session: PtySession) => void;

/**
 * Strip ANSI/OSC control sequences from captured PTY output.
 *
 * Scrollback is raw terminal bytes — cursor moves, colour, the CLI's repeated
 * full-frame redraws. Handing that to a tracker comment or a handoff document
 * gives a human a page of escape codes, so both readable surfaces go through
 * here. Coarse by design (it drops sequences rather than interpreting them);
 * the goal is legibility, not a faithful terminal replay.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (window titles…)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (colour, cursor, erase)
    .replace(/\x1b[()][0-9A-B]/g, "") // charset selection
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "\n");
}

/**
 * Translate a logical command into the executable to actually spawn. "shell"
 * resolves to the host owner's own login shell ($SHELL) so their zsh/oh-my-zsh
 * config loads, rather than a hardcoded bash. "claude" gets `--settings` pointing
 * at the daemon's generated hooks file, so the approval + ticket-context hooks
 * work in any cwd with no per-repo install. The logical command is kept on the
 * session (SessionInfo.command) so the shell still classifies panes by "claude"
 * vs other — only the spawn target changes.
 */
function resolveSpawn(
  command: string,
  args: string[],
  autonomous: boolean,
  mode: PermissionMode,
): { file: string; args: string[] } {
  if (command === "shell") {
    return { file: CONFIG.defaultShell, args: ["-l", ...args] };
  }
  if (command === "claude") {
    // Autonomous runs get the settings file that also reports activity, so the
    // rail's action line has a source; supervised sessions don't pay for it.
    const settings = autonomous ? CLAUDE_SETTINGS_PATH_AUTONOMOUS : CLAUDE_SETTINGS_PATH;
    // `manual` is passed by OMITTING the flag: it IS the CLI's no-flag default
    // (a bare `claude` reports "manual mode on"), so the safe posture stays the
    // exact command line that shipped rather than one that depends on the CLI
    // keeping that spelling.
    const modeArgs = mode === "manual" ? [] : ["--permission-mode", mode];
    return { file: "claude", args: ["--settings", settings, ...modeArgs, ...args] };
  }
  return { file: command, args };
}

/**
 * One tool call as a single clause for the rail's action line (DRY-49).
 *
 * The card is one line that must never wrap or change height, so this is a
 * summary, not a rendering of the arguments — the permission panel is where
 * the full input belongs. Unknown tools degrade to their own name rather than
 * to a JSON blob, because an unrecognised tool is exactly when a card would
 * otherwise fill with something unreadable.
 */
function describeToolCall(tool: string, input: unknown): string {
  const arg = (key: string): string | undefined => {
    const v = (input as Record<string, unknown> | null | undefined)?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const short = (p: string): string => p.replace(/^.*\/(?=[^/]+\/[^/]+$)/, "");
  const path = arg("file_path") ?? arg("path") ?? arg("notebook_path");
  switch (tool) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path ? `editing ${short(path)}` : "editing a file";
    case "Write":
      return path ? `writing ${short(path)}` : "writing a file";
    case "Read":
      return path ? `reading ${short(path)}` : "reading a file";
    case "Bash": {
      const cmd = arg("command");
      return cmd ? `running ${cmd.split("\n")[0].slice(0, 80)}` : "running a command";
    }
    case "Glob":
    case "Grep": {
      const pattern = arg("pattern");
      return pattern ? `searching ${pattern.slice(0, 60)}` : "searching";
    }
    case "WebFetch":
    case "WebSearch":
      return arg("url") ?? arg("query") ?? "looking something up";
    case "Task":
      return arg("description") ?? "running a subagent";
    default:
      return tool;
  }
}

/**
 * How a gate finished. Carries the reason alongside the decision so a denial
 * can tell the agent *why* — a bare "no" usually makes it retry the identical
 * call, which is how a denial turns into a loop instead of a redirect (DRY-50).
 *
 * Daemon-internal on purpose: the browser never sees this shape, so mirroring
 * it into protocol.ts would tax the shell's copy with a type it can't use.
 */
export interface PermissionOutcome {
  decision: PermissionDecision | "timeout";
  reason?: string;
}

interface PendingPermission {
  tool: string;
  input: unknown;
  requestedAt: number;
  resolve: (outcome: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Told when a gate opens or closes, for surfaces that aren't attached clients.
 * The manager injects this so a gate reaches the shell-wide stream even when
 * the session has no pane — the entire point of DRY-50.
 */
export type GateNotifier = (event: GateEvent) => void;

/** Derived, not restated: these ARE the stream's gate variants. */
export type GateEvent = Extract<EventMessage, { type: "gate-open" | "gate-resolved" }>;

/**
 * One terminal session. The daemon — not any client — owns the PTY master for
 * the whole life of the child process. Clients (browser tabs) attach and detach
 * freely over WebSockets; the child never notices. That decoupling is the whole
 * point: minimize a pane, close the laptop, reconnect tomorrow — the agent kept
 * running and we replay everything it printed while you were gone.
 */
export class PtySession {
  readonly id: string;
  readonly createdAt: number;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly ticket?: string;
  readonly repo?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly origin: RunOrigin;
  readonly permissionMode: PermissionMode;
  /**
   * The account this session belongs to (DRY-27), and who else may see it.
   *
   * Undefined on a session spawned before accounts existed — read through
   * `ownedBy`/`visibleTo` rather than directly, so the "nobody recorded one"
   * case is answered in one place instead of at every call site.
   */
  /**
   * Not readonly, for one reason: the first account created on a daemon that
   * was running `off` or `single` adopts the sessions spawned under it. See
   * `adoptOwner` and SessionManager.adoptSessions.
   */
  owner?: string;
  ownerName?: string;
  readonly visibility: SessionVisibility;
  title: string;
  /**
   * Not readonly: Take-over turns a run into an ordinary supervised session.
   * That crossing goes one way only — see takeOver().
   */
  private autonomous: boolean;

  /** What to exec, resolved once at spawn and carried through a restart. */
  private readonly exec: { file: string; args: string[] };
  /** The env vars the daemon ADDS — never a snapshot of process.env. */
  private readonly env: Record<string, string>;
  /**
   * The supervisor holding this session's PTY master (DRY-57).
   *
   * Undefined only for a session adopted after it had already ended, which
   * exists purely long enough to produce the artefacts its run never got.
   */
  private link?: SupervisorLink;
  /** Its index files are gone; stop rewriting them. See onExit. */
  private forgotten = false;
  /**
   * When this run actually ended, if that was BEFORE we found out about it.
   *
   * Only set by `adoptExited`. Without it the handoff document for a run that
   * ended while the daemon was down is stamped with the moment the daemon came
   * back — which turns a 39-second run into however long the daemon happened to
   * be away, in the one document that is the only account of what happened.
   */
  private endedAtValue?: number;

  /** See endedAtValue. Undefined means "it is ending now". */
  get endedAt(): number | undefined {
    return this.endedAtValue;
  }
  private cols: number;
  private rows: number;
  private status: SessionStatus = "running";
  private exitCode: number | null = null;
  /**
   * The agent finished a turn (Stop hook) and is now waiting on the user. Unlike
   * `status`, the process is still alive — this is "your turn", not "exited". We
   * can't tell "task complete" from "paused to ask a question" (both just end the
   * turn), so the UI labels it honestly as idle rather than asserting completion.
   */
  private idle = false;

  /** Capped scrollback so a next-day reattach gets full history, not a flood. */
  private scrollback: Buffer[] = [];
  private scrollbackBytes = 0;
  /** What `seedScrollback` last installed, before any live byte was appended. */
  private seededBytes = 0;

  private readonly clients = new Set<WebSocket>();
  private readonly pending = new Map<string, PendingPermission>();

  /** What the agent is doing now, for the rail's action line (DRY-49). */
  private activity?: string;
  private failure?: RunFailure;
  private handoff?: string;
  /**
   * Tools this run has been told to stop asking about ("Always allow Bash",
   * deferred here from DRY-50). Session-scoped AND tool-scoped, held in memory
   * on the session object, so it expires with the run by construction — there
   * is nowhere for it to persist to.
   */
  private readonly allowedTools = new Set<string>();
  /** Fired at most once per terminal state; see notifyRunEnd. */
  private endsAnnounced = new Set<RunEndReason>();
  /** This process was signalled on purpose, so its exit code isn't a verdict. */
  private stoppedByRequest = false;
  /** When somebody asked for it to stop. Persisted — see SessionMeta.killedAt. */
  private killedAt?: number;

  private constructor(
    meta: SessionMeta,
    private readonly notifyGate: GateNotifier = () => {},
    private readonly notifyRunEnd: RunEndNotifier = () => {},
    private readonly notifyEnded: SessionEndNotifier = () => {},
  ) {
    this.id = meta.id;
    this.createdAt = meta.createdAt;
    this.command = meta.command;
    this.args = meta.args;
    this.exec = meta.exec;
    this.env = meta.env;
    this.cwd = meta.cwd;
    this.ticket = meta.ticket;
    this.repo = meta.repo;
    this.worktree = meta.worktree;
    this.branch = meta.branch;
    this.autonomous = meta.autonomous;
    this.origin = meta.origin;
    this.permissionMode = meta.permissionMode;
    this.owner = meta.owner;
    this.ownerName = meta.ownerName;
    // Defaulted at the boundary, not at every reader: a session from before
    // DRY-27 is private, which is the only safe reading of "nobody said".
    this.visibility = meta.visibility ?? "private";
    this.title = meta.title;
    this.cols = meta.cols;
    this.rows = meta.rows;
    this.handoff = meta.handoff;
  }

  /** The index entry this session would be rebuilt from after a restart. */
  private toMeta(): SessionMeta {
    return {
      protocol: PROTOCOL_VERSION,
      id: this.id,
      createdAt: this.createdAt,
      command: this.command,
      args: this.args,
      exec: this.exec,
      cwd: this.cwd,
      title: this.title,
      cols: this.cols,
      rows: this.rows,
      ticket: this.ticket,
      repo: this.repo,
      worktree: this.worktree,
      branch: this.branch,
      autonomous: this.autonomous,
      origin: this.origin,
      permissionMode: this.permissionMode,
      owner: this.owner,
      ownerName: this.ownerName,
      visibility: this.visibility,
      env: this.env,
      handoff: this.handoff,
      killedAt: this.killedAt,
    };
  }

  /**
   * Is this session `viewer`'s to see and drive?
   *
   * One predicate, consulted by the list, the attach, the kill, the gate answer
   * and the file read — because ownership checks that are written out at each
   * call site are ownership checks that get forgotten at one of them, and the
   * one that gets forgotten is the interesting one.
   *
   * A session with NO recorded owner belongs to whoever is asking. That is not a
   * hole: it can only happen on a daemon that spawned it before accounts
   * existed, and the alternative — hiding it — orphans a live agent behind a
   * feature switch, with no surface left that could stop it.
   */
  visibleTo(viewer: string): boolean {
    if (!ownershipApplies()) return true;
    return !this.owner || this.owner === viewer || this.visibility === "public";
  }

  /**
   * Stricter than `visibleTo`: may `viewer` END this, or change what it is?
   *
   * A public run is somebody else's work being shown to you. Watching it is the
   * point; stopping it is not, and a bulk "clear finished" that reached across
   * accounts would be the worst possible way to discover the difference.
   */
  ownedBy(viewer: string): boolean {
    if (!ownershipApplies()) return true;
    return !this.owner || this.owner === viewer;
  }

  /**
   * Hand this session to the first account, at bootstrap (DRY-27).
   *
   * Persisted immediately, not just held in memory: the index file is what a
   * restart rebuilds this session from, so an un-persisted change would survive
   * exactly until the next `--watch` save and then put the session back where
   * nobody can reach it.
   */
  adoptOwner(owner: string, ownerName?: string): void {
    this.owner = owner;
    if (ownerName) this.ownerName = ownerName;
    this.persist();
  }

  /**
   * Push the mutable half of the index back to disk.
   *
   * Only a handful of things change after a spawn and survive a restart —
   * a take-over, a handoff path, a retitle — but each one that DOESN'T get
   * written is a lie the next boot reads: a run adopted back onto the rail
   * after somebody took it over, or a second tracker comment for a handoff
   * that already exists.
   */
  private persist(): void {
    if (this.forgotten) return;
    try {
      writeMeta(this.toMeta());
    } catch (err) {
      // The session is live and driving an agent; an index write failing costs
      // a restart's memory of it, not the run.
      log.warn("could not update the session index", { id: this.id, err: String(err) });
    }
  }

  /** Start a new session under its own detached supervisor. */
  static async spawn(
    opts: SpawnOptions,
    notifyGate: GateNotifier = () => {},
    notifyRunEnd: RunEndNotifier = () => {},
    notifyEnded: SessionEndNotifier = () => {},
  ): Promise<PtySession> {
    const id = randomUUID();
    assertSocketPathFits(id);
    const command = opts.command;
    const args = opts.args ?? [];
    const autonomous = opts.autonomous ?? false;
    const permissionMode = opts.permissionMode ?? "manual";
    const meta: SessionMeta = {
      protocol: PROTOCOL_VERSION,
      id,
      createdAt: Date.now(),
      command,
      args,
      exec: resolveSpawn(command, args, autonomous, permissionMode),
      cwd: opts.cwd ?? os.homedir(),
      title: opts.title ?? command,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      ticket: opts.ticket,
      repo: opts.repo,
      worktree: opts.worktree,
      branch: opts.branch,
      autonomous,
      origin: opts.origin ?? "you",
      permissionMode,
      owner: opts.owner,
      ownerName: opts.ownerName,
      visibility: opts.visibility ?? "private",
      env: {
        ...opts.env,
        // Lets the PreToolUse hook tell the daemon which session it belongs to.
        // Both of these are baked into the child at spawn and CANNOT be changed
        // afterwards, which is the one real limit on a session outliving its
        // daemon: move the daemon's host or port and an already-running agent's
        // hooks keep calling the old address. Host config, so it doesn't move
        // on its own — but it is why DRYDOCK_SESSIONS_DIR exists.
        DRYDOCK_SESSION_ID: id,
        DRYDOCK_DAEMON_URL: `http://${CONFIG.host}:${CONFIG.port}`,
        // What this session's hooks prove themselves with (DRY-27). Per session
        // and minted here, which is the point: the wrapped CLI needs to reach
        // `/hook/*` on a daemon that now refuses anonymous requests, and handing
        // it the USER's token would give every agent the ability to spawn
        // sessions, read anyone's desk, and — the one that matters — answer its
        // own permission gates. This key opens the hook endpoints for this
        // session and nothing else.
        //
        // It lives in the agent's own environment, so the agent can read it.
        // That is fine and unavoidable: it is a credential for saying "I am the
        // process you started", which the process is. The boundary that has to
        // hold is the one above — and it holds because /api/* does not accept
        // this key at all.
        DRYDOCK_SESSION_KEY: randomUUID(),
        TERM: "xterm-256color",
      },
    };

    const link = await SupervisorLink.start(meta);
    const session = new PtySession(meta, notifyGate, notifyRunEnd, notifyEnded);
    // `bind` takes the link's buffered replay, which is what this path used to
    // skip (DRY-79) — see its comment. Not the SIZES, though, which is the half
    // of `adopt` that must not be copied here: it takes `hello.cols`/`rows`
    // because a previous client negotiated them, whereas at spawn the request's
    // own dimensions are the newest thing anybody has said and the supervisor is
    // only echoing them back.
    session.bind(link);

    log.info("session spawned", {
      id,
      supervisorPid: link.hello.pid,
      pid: link.hello.childPid,
      command,
      cwd: meta.cwd,
      ticket: meta.ticket,
      branch: meta.branch,
      autonomous: autonomous || undefined,
      // Logged because it decides whether this run can ask for anything at all;
      // "why did nothing ever gate?" should be answerable from the log.
      permissionMode,
      // KEYS ONLY, never values (DRY-66). Being able to reconstruct what a run
      // was told is the point of the field — it replaces a prompt file in a
      // temp dir — but a caller may put anything in a value, so the log records
      // that a channel was used and leaves reading it to the sessions-dir entry.
      env: Object.keys(opts.env ?? {}).join(",") || undefined,
      // What the child printed before the daemon could attach (DRY-79). The
      // SEEDED count, not `scrollbackBytes`: `bind` flushes the link's
      // `pendingData` on its way past — output that arrived live in the same
      // segment as Ready — so the ring is already wider than the window by the
      // time this line runs, and this number is read as the window (CLAUDE.md
      // sizes the spawn-then-bind decision on it). Zero is the normal case for
      // a quiet command and is not a symptom.
      replayBytes: session.seededBytes,
    });

    if (opts.input) session.scheduleInitialInput(opts.input);
    return session;
  }

  /**
   * Take back a session whose supervisor outlived the daemon (DRY-57).
   *
   * The scrollback comes back with it: the ring buffer lives in the supervisor
   * now, so "we replay everything it printed while you were gone" survives the
   * daemon's own absence, not just a closed browser tab.
   */
  static adopt(
    meta: SessionMeta,
    link: SupervisorLink,
    notifyGate: GateNotifier = () => {},
    notifyRunEnd: RunEndNotifier = () => {},
    notifyEnded: SessionEndNotifier = () => {},
  ): PtySession {
    const session = new PtySession(meta, notifyGate, notifyRunEnd, notifyEnded);
    // Whatever size the last client negotiated, not what the spawn asked for.
    session.cols = link.hello.cols;
    session.rows = link.hello.rows;
    // The scrollback comes back inside `bind`, the same as it does for a spawn.
    session.bind(link);
    log.info("session adopted after a daemon restart", {
      id: meta.id,
      supervisorPid: link.hello.pid,
      pid: link.hello.childPid,
      command: meta.command,
      ticket: meta.ticket,
      autonomous: meta.autonomous || undefined,
      replayBytes: session.seededBytes,
      ageSec: Math.round((Date.now() - meta.createdAt) / 1000),
    });
    return session;
  }

  /**
   * Rebuild a session that ENDED while the daemon was down, from the transcript
   * and exit record its supervisor flushed on the way out.
   *
   * It has no link and never runs again. It exists because DRY-49's premise is
   * that nobody was watching: an unattended run whose daemon died before it
   * finished used to leave nothing at all — no handoff, no tracker comment, no
   * card — which is the one outcome that feature must not have.
   */
  static adoptExited(
    meta: SessionMeta,
    exitCode: number,
    endedAt: number,
    scrollback: Buffer | undefined,
    notifyGate: GateNotifier = () => {},
    notifyRunEnd: RunEndNotifier = () => {},
    notifyEnded: SessionEndNotifier = () => {},
  ): PtySession {
    const session = new PtySession(meta, notifyGate, notifyRunEnd, notifyEnded);
    if (scrollback) session.seedScrollback(scrollback);
    session.status = "exited";
    session.exitCode = exitCode;
    session.endedAtValue = endedAt;
    // We CAN tell a deliberate stop from a crash, because `/kill` records the
    // intent in the index before it sends the signal. That matters twice over:
    // signalling a process exits it 129/137/143, so without this the branch
    // below would mark a run somebody deliberately stopped as FAILED and post
    // "nobody was watching when this stopped — please pick it up" to its ticket
    // (DRY-49's trap 2, which this path would otherwise have reintroduced by
    // the back door), and it keeps this ending the same shape as the one the
    // live path produces — transcript kept, no tracker comment.
    session.stoppedByRequest = Boolean(meta.killedAt);
    if (exitCode !== 0 && !session.stoppedByRequest) {
      session.failure = {
        at: endedAt,
        reason: `exited ${exitCode} while the daemon was down`,
        lastLine: session.lastOutputLine(),
      };
    }
    return session;
  }

  /**
   * Replace the buffer wholesale — the supervisor's copy is authoritative.
   *
   * SPLIT INTO CHUNKS, not installed as one buffer, because `onData`'s trim is
   * whole-chunk: `scrollback.length > 1` guards it, so a single seed chunk
   * survives until the first live byte pushes the ring over cap and then goes
   * ENTIRELY, in one `shift()`. Measured on a 200 KB ring, seeded to ~199 KB
   * and then sent 50 KB of live output: 51,010 bytes retained as one buffer
   * against 186,006 chunked. A session adopted with a full ring lost three
   * quarters of its scrollback to its next few keystrokes, and a spawn's
   * pre-attach block — the bytes DRY-79 is about — is always the oldest chunk
   * there is, so it is always the first to go.
   */
  private seedScrollback(replay: Buffer): void {
    this.scrollback = [];
    for (let at = 0; at < replay.byteLength; at += SEED_CHUNK_BYTES) {
      this.scrollback.push(replay.subarray(at, at + SEED_CHUNK_BYTES));
    }
    this.scrollbackBytes = replay.byteLength;
    this.seededBytes = replay.byteLength;
  }

  /**
   * Wire a link's output, exit and reattach into this session — and take the
   * scrollback it buffered during the handshake.
   *
   * THE SEED LIVES HERE so that it cannot be forgotten by one caller, which is
   * exactly what DRY-79 was: `adopt` seeded and `spawn` did not, so everything
   * a PTY printed between starting and the daemon dialling its supervisor was
   * dropped — out of the pane, out of the ring, and so out of every later
   * reattach and out of DRY-49's handoff. There is ALWAYS something in that
   * buffer, because the supervisor spawns the PTY before it binds its socket
   * and the daemon then polls for that socket before it can send Attach.
   */
  private bind(link: SupervisorLink): void {
    this.link = link;
    this.seedScrollback(link.takeReplay());
    link.onReattach((replay) => {
      // A dropped-and-recovered connection hands back the whole buffer. Replace
      // rather than append: we can't know how much of it we already had, and
      // appending would print the session's history to every attached pane a
      // second time.
      this.seedScrollback(replay);
      log.info("supervisor reattached — scrollback resynced", {
        id: this.id,
        bytes: this.scrollbackBytes,
      });
    });
    link.onData((data) => this.onData(data));
    link.onExit((exitCode) => this.onExit(exitCode));
  }

  /** Drop the connection WITHOUT killing the agent (daemon shutdown). */
  detachSupervisor(): void {
    this.link?.dispose();
  }

  // --- daemon-typed first prompt (DRY-49, both spawn paths since DRY-88) ---
  private initialInput?: string;
  private initialTimer: NodeJS.Timeout | null = null;
  private firstPaintAt = 0;
  private readonly spawnedAt = Date.now();

  /**
   * Type the first prompt once the CLI is ready to receive it.
   *
   * "Ready" is not a fixed delay, and this is the only place that gets to
   * decide when it has arrived — for the unattended run that has nobody to
   * type for it (DRY-49) and, since DRY-88, for the supervised workspace whose
   * prompt is a pre-fill. TerminalPane used to do its own, 700ms after its
   * socket opened, on the stated grounds that the CLI had "been booting for a
   * while" by then. It hasn't: the supervisor spawns the PTY before it binds
   * its socket and the daemon dials within tens of milliseconds (DRY-79
   * measured 5-47ms), so that pane was typing at roughly t=700ms of the
   * process — a third of the way to the 1400ms where Claude Code starts
   * listening. Every ticket-driven workspace lost its prompt, in silence,
   * because a CLI that isn't listening yet does not error.
   *
   * So: wait for the CLI to PAINT (see paintsSomething — the escape-only
   * writes that configure a terminal are not it), then for output to go quiet,
   * never sooner than the floor, capped so a CLI that never stops redrawing
   * still gets its prompt.
   */
  private scheduleInitialInput(text: string): void {
    this.initialInput = text;
    // Output that landed before the daemon attached counts (DRY-79).
    // `noteOutputForInitialInput` is driven from `onData`, which the seeded
    // replay never passes through, so a CLI whose banner finished inside that
    // window and then went quiet would wait out the ceiling below instead of
    // the settle. Short-circuits on the first painting chunk rather than
    // joining the ring, which can be a megabyte of it.
    if (this.scrollback.some((c) => paintsSomething(c.toString("utf8"))))
      this.noteOutputForInitialInput("");
    const cap = setTimeout(() => this.flushInitialInput(), INITIAL_INPUT_CEILING_MS);
    cap.unref?.();
  }

  /**
   * Re-arm the settle timer on every chunk; fire once output pauses.
   *
   * Nothing is armed until something has been painted, so the CLI's terminal
   * setup can't start the clock. `chunk` is empty for the seeded case above,
   * which has already been found to paint.
   */
  private noteOutputForInitialInput(chunk: string): void {
    if (!this.initialInput) return;
    if (!this.firstPaintAt) {
      if (chunk && !paintsSomething(chunk)) return;
      this.firstPaintAt = Date.now();
    }
    if (this.initialTimer) clearTimeout(this.initialTimer);
    const floorLeft = this.firstPaintAt + INITIAL_INPUT_FLOOR_MS - Date.now();
    const wait = Math.max(INITIAL_INPUT_SETTLE_MS, floorLeft);
    this.initialTimer = setTimeout(() => this.flushInitialInput(), wait);
    this.initialTimer.unref?.();
  }

  private flushInitialInput(): void {
    const text = this.initialInput;
    if (!text || this.status !== "running") return;
    this.initialInput = undefined;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    // Bracketed paste so a multi-line ticket brief lands as one block instead
    // of each newline submitting a fragment — same encoding TerminalPane uses.
    const data = text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text;
    log.info("typing initial prompt", {
      id: this.id,
      bytes: Buffer.byteLength(text),
      // Both, because they answer different questions: `waitedMs` is what the
      // human waited, `paintedAfterMs` is where the CLI's first paint landed —
      // the number the constants above are tuned against, and the one to read
      // if this ever starts arriving in an empty composer again.
      waitedMs: Date.now() - this.spawnedAt,
      paintedAfterMs: this.firstPaintAt ? this.firstPaintAt - this.spawnedAt : undefined,
      submit: this.autonomous,
    });
    this.link?.write(data);

    // The RETURN IS A SEPARATE WRITE, and that is the whole difference between
    // an autonomous run and a prompt sitting in a text box forever. Appending
    // "\r" to the payload above puts it in the same read() as the text, and
    // Claude Code's TUI treats that burst as pasted content — verified: the
    // prompt appeared in the composer and the agent never started. Give the
    // CLI a beat to render what it received, then press enter on its own.
    //
    // ONLY for a run nobody is watching. A supervised workspace pre-fills and
    // leaves the human to submit — they may want to edit the prompt first, and
    // the ticket panel's two buttons are exactly the choice between the two.
    // The daemon types both prompts since DRY-88; pressing return is still the
    // thing that separates them, so it hangs off `autonomous` rather than off
    // which surface asked.
    if (!this.autonomous) return;
    const submit = setTimeout(() => {
      if (this.status === "running") this.link?.write("\r");
    }, 400);
    submit.unref?.();
  }

  private onData(data: string): void {
    const chunk = Buffer.from(data, "utf8");
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.byteLength;
    // Trim oldest whole chunks once over cap. Coarse (may clip mid-escape on the
    // boundary) but fine for a PoC scrollback replay.
    while (this.scrollbackBytes > CONFIG.scrollbackBytes && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift()!;
      this.scrollbackBytes -= dropped.byteLength;
    }
    this.noteOutputForInitialInput(data);
    this.broadcast({ type: "data", data });
  }

  private onExit(exitCode: number): void {
    this.status = "exited";
    this.exitCode = exitCode;
    this.idle = false; // process is gone; "exited" supersedes "your turn"
    // Capture the parting line BEFORE anything else: it's the whole content of
    // a failed card, and the only triage a human gets without opening the
    // handoff. A run killed after a gate timeout already has a failure reason —
    // don't overwrite the explanation with whatever the CLI printed on its way
    // out.
    if (exitCode !== 0 && !this.failure && !this.stoppedByRequest) {
      this.failure = {
        at: Date.now(),
        reason: `exited ${exitCode}`,
        lastLine: this.lastOutputLine(),
      };
    } else if (this.failure && !this.failure.lastLine) {
      this.failure = { ...this.failure, lastLine: this.lastOutputLine() };
    }
    log.info("session exited", {
      id: this.id,
      command: this.command,
      exitCode,
      uptimeSec: Math.round((Date.now() - this.createdAt) / 1000),
      clients: this.clients.size,
    });
    this.broadcast({ type: "status", status: "exited", exitCode });
    // Resolve any dangling permission gates so the CLI isn't left hanging.
    // These have to be *announced*, not just resolved: a pane would vanish
    // along with the exited session, but the shell-wide stream outlives it and
    // would otherwise keep rendering a gate for a process that no longer exists,
    // with a held-time ticking up forever (DRY-50).
    for (const [requestId, p] of this.pending) {
      clearTimeout(p.timer);
      this.announceGate(
        { type: "permission-resolved", requestId, decision: "timeout" },
        { type: "gate-resolved", sessionId: this.id, requestId, decision: "timeout" },
      );
      p.resolve({ decision: "timeout" });
      this.pending.delete(requestId);
    }
    this.announceRunEnd(
      this.failure ? "failed" : this.stoppedByRequest ? "stopped" : "finished",
    );
    // Unconditional, unlike the line above (DRY-56). History records every
    // session; the run artefacts record only the unattended ones.
    this.notifyEnded(this);

    // LAST, and after the run-end announcement on purpose. The index exists so
    // a daemon that wasn't here can find out what happened; this daemon WAS
    // here, has the whole record in memory, and has just written whatever
    // artefacts the run was owed. Leaving the files behind would make the next
    // boot re-derive an ending it already handled — a second handoff document,
    // a second tracker comment — so the invariant is: an exit record still on
    // disk at boot means, and only means, that nobody was home when it ended.
    this.forgotten = true;
    forget(this.id);
  }

  // --- run lifecycle (DRY-49) ---------------------------------------------

  /**
   * Tell the run-end subscribers, at most once per terminal state.
   *
   * Only autonomous runs announce: the whole point of the artefact and the
   * tracker comment is that nobody watched this happen, and a supervised
   * session ending its turn is a person sitting in front of it.
   *
   * The set (rather than a boolean) exists because "ended turn" and "failed"
   * are both reachable on one run — the agent hands back, then an unanswered
   * gate later kills it — and the failure is the one a human must not miss.
   */
  private announceRunEnd(reason: RunEndReason): void {
    if (!this.autonomous || this.endsAnnounced.has(reason)) return;
    // A failure is the final word on a run. Denying an unanswered gate makes
    // the CLI end its turn, so a failed run reaches this twice — once as
    // "ended-turn", once as "failed" — and without this it would report an
    // ending, then a different ending, and describe a run that had already
    // failed as merely having handed back its turn.
    if (reason !== "failed" && this.failure) return;
    this.endsAnnounced.add(reason);
    this.notifyRunEnd(this, reason);
  }

  /**
   * Announce an ending that happened while the daemon wasn't running (DRY-57).
   *
   * Only reachable from boot reconciliation, on a session rebuilt by
   * `adoptExited`. `announceRunEnd` still gates on `autonomous`, so a
   * supervised session that died with its daemon stays silent — there was a
   * human in front of it, and the artefacts are for the runs nobody saw.
   */
  announceMissedEnding(): void {
    // Deliberately the same ternary as onExit's. The two paths describe the
    // same event — a run reaching a terminal state — and the only difference
    // is whether the daemon was there to watch it happen, which must not be
    // something a handoff document can tell.
    this.announceRunEnd(
      this.failure ? "failed" : this.stoppedByRequest ? "stopped" : "finished",
    );
  }

  /**
   * How this session ended, in the vocabulary history stores (DRY-56).
   *
   * The same ternary onExit and announceMissedEnding use, exposed because the
   * recorder lives outside this class — `exit_code` can't distinguish a
   * deliberate stop (129/137/143) from a crash, and the thing that knows the
   * difference is `stoppedByRequest`, which only exists in here.
   *
   * Typed as the three outcomes the body can actually produce rather than as
   * the persisted `SessionEndReason`, which is these plus `unknown` (DRY-64).
   * Narrower still satisfies the recorder, and it means the value can go
   * straight onto the wire without a client having to handle a case this can
   * never return.
   */
  ending(): { endedAt: number; exitCode?: number; endReason: SessionEndOutcome } {
    return {
      endedAt: this.endedAtValue ?? Date.now(),
      exitCode: this.exitCode ?? undefined,
      endReason: this.failure ? "failed" : this.stoppedByRequest ? "stopped" : "finished",
    };
  }

  /** What history records at spawn. Everything a tombstone has to be able to say. */
  historyStart(): SessionStart {
    return {
      id: this.id,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      repo: this.repo,
      ticket: this.ticket,
      worktree: this.worktree,
      branch: this.branch,
      title: this.title,
      createdAt: this.createdAt,
    };
  }

  /** Scrollback with the terminal control codes taken out, for humans. */
  transcript(): string {
    return stripAnsi(Buffer.concat(this.scrollback).toString("utf8"));
  }

  /** The last thing the process printed — the failed card's one line of triage. */
  private lastOutputLine(): string | undefined {
    const lines = this.transcript().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line) return line.slice(0, 300);
    }
    return undefined;
  }

  /** Where this run's handoff document was written, once runs.ts has written it. */
  noteHandoff(path: string): void {
    this.handoff = path;
    // Persisted because boot reconciliation reads its absence as "this run
    // ended unattended and still owes a human its artefacts" (DRY-57).
    this.persist();
  }

  /**
   * Stop being autonomous — the rail's one legal lane crossing, and it only
   * goes one way. A run can become an ordinary supervised session; an ordinary
   * session can't be handed back to the rail, because half its history happened
   * in a window with a human in it and the run artefacts would be a fiction.
   */
  takeOver(): void {
    this.autonomous = false;
    // Or a daemon restart would put it back on the rail, and a session somebody
    // is sitting in front of would start writing handoff documents again.
    this.persist();
  }

  /** Stop gating this tool for the rest of the run ("Always allow Bash"). */
  allowTool(tool: string): void {
    this.allowedTools.add(tool);
    log.info("tool allowed for the rest of the run", { id: this.id, tool });
  }

  /**
   * Record what the agent is doing, for the rail's action line. Fed by the
   * reporting PreToolUse hook, which never gates — so this is the only thing
   * in the daemon that knows about a Read or an Edit.
   */
  noteActivity(tool: string, input: unknown): void {
    this.activity = describeToolCall(tool, input);
  }

  /** Attach a client: replay scrollback, then stream live + any open gates. */
  attach(ws: WebSocket): void {
    this.clients.add(ws);
    log.info("client attached", {
      id: this.id,
      clients: this.clients.size,
      replayBytes: this.scrollbackBytes,
    });
    this.send(ws, { type: "replay", data: Buffer.concat(this.scrollback).toString("utf8") });
    this.send(ws, {
      type: "status",
      status: this.status,
      exitCode: this.exitCode ?? undefined,
    });
    if (this.idle) this.send(ws, { type: "idle", idle: true });
    for (const gate of this.pendingGates()) {
      this.send(ws, { type: "permission-request", ...gate });
    }
  }

  /**
   * Every gate still waiting on an answer, oldest first (the Map is
   * insertion-ordered and must stay that way — the UI numbers gates "1 of 2").
   *
   * The single source for both replay paths: the per-pane replay in attach()
   * above and the shell-wide stream's catch-up on connect. Two hand-written
   * copies of "what does a newly-arrived client need to know" is exactly how
   * one surface ends up showing a gate the other has already forgotten.
   */
  /**
   * Announce a gate change to BOTH surfaces at once.
   *
   * Panes and the shell-wide stream have to agree, and leaving that to four
   * call sites remembering two lines each is how onExit() came to resolve its
   * dangling gates while telling the stream nothing — a gate rendered forever
   * for a dead process. One method, so the pairing is structural.
   */
  private announceGate(msg: ServerMessage, event: GateEvent): void {
    this.broadcast(msg);
    this.notifyGate(event);
  }

  pendingGates(): PendingGate[] {
    return [...this.pending].map(([requestId, p]) => ({
      requestId,
      tool: p.tool,
      input: p.input,
      requestedAt: p.requestedAt,
    }));
  }

  detach(ws: WebSocket): void {
    if (!this.clients.delete(ws)) return; // already dropped (e.g. by an error)
    log.info("client detached", { id: this.id, clients: this.clients.size });
  }

  /**
   * Called from the Stop hook: the agent ended its turn and is waiting on the
   * user. No-op once exited or already idle so we don't churn broadcasts.
   */
  markIdle(): void {
    if (this.status !== "running" || this.idle) return;
    this.idle = true;
    this.broadcast({ type: "idle", idle: true });
    // For an unattended run this IS the ending, in practice: an interactive
    // `claude` doesn't exit when a task is done, it hands the turn back and
    // waits for a reply that nobody is there to give. So the artefacts get
    // written here — while being careful, per DRY-18, never to call it "done".
    this.announceRunEnd("ended-turn");
  }

  /** The agent is active again (user sent input). Clears the "your turn" flag. */
  private clearIdle(): void {
    if (!this.idle) return;
    this.idle = false;
    this.broadcast({ type: "idle", idle: false });
  }

  write(data: string): void {
    if (this.status !== "running") return;
    // Any user input means they've responded — drop the "your turn" flag so the
    // pane stops glowing the moment they start interacting again.
    this.clearIdle();
    this.link?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.status !== "running") return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.link?.resize(cols, rows);
    } catch {
      // Racing a just-exited PTY; ignore.
    }
  }

  /** Cheap liveness check — avoids building a SessionInfo just to read status. */
  get running(): boolean {
    return this.status === "running";
  }

  kill(): void {
    if (!this.running) {
      log.info("kill requested for an already-exited session", {
        id: this.id,
        status: this.status,
      });
      return;
    }
    log.info("session kill requested", { id: this.id, command: this.command });
    // Somebody asked for this. Signalling a process makes it exit non-zero
    // (129/143 for HUP/TERM), and without this an autonomous run that was
    // deliberately stopped reported itself FAILED and posted "nobody was
    // watching when this stopped — please pick it up" to the ticket. Somebody
    // was watching; they pressed the button. The one exception is the
    // unanswered-gate path, which kills too — it records its failure first, so
    // the check below leaves that verdict alone.
    if (!this.failure) this.stoppedByRequest = true;
    // Recorded BEFORE the kill is sent, and that ordering is the point (DRY-57
    // review). Everything that cleans up after a kill depends on the child
    // actually dying and the Exit frame coming back; if it ignores the signal,
    // or the daemon goes down inside that window, the index entry outlives the
    // decision and the next boot would adopt a session somebody deliberately
    // ended straight back onto the desk. This is what reconciliation reads to
    // finish the job instead of undoing it.
    this.killedAt = Date.now();
    this.persist();
    this.link?.kill();
  }

  /**
   * Called from the PreToolUse hook path. Registers a pending gate, lights up
   * every attached client, and returns a promise that resolves when a human
   * clicks approve/deny — or when we hit our own timeout (caller then defers to
   * the CLI's normal flow).
   */
  requestPermission(tool: string, input: unknown): Promise<PermissionOutcome> {
    // A tool gate means the agent is mid-turn, not idle — the permission overlay
    // is its own attention signal, so drop any stale "your turn" flag.
    this.clearIdle();
    // Also the moment we learn what the agent is up to for a gated tool: the
    // reporting hook deliberately doesn't match Bash, to stay clear of this one.
    this.noteActivity(tool, input);

    // "Always allow <Tool>" — answered before anything is announced, so no gate
    // is ever raised, nothing flashes on the rail, and no surface has to learn
    // about a gate that resolves in the same tick (DRY-50's bug class).
    if (this.allowedTools.has(tool)) {
      return Promise.resolve({
        decision: "allow",
        reason: `Always-allowed for this run (${tool})`,
      });
    }

    const requestId = randomUUID();
    const requestedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (this.autonomous) return this.failUnanswered(requestId, tool, resolve);
        this.announceGate(
          { type: "permission-resolved", requestId, decision: "timeout" },
          { type: "gate-resolved", sessionId: this.id, requestId, decision: "timeout" },
        );
        resolve({ decision: "timeout" });
      }, this.permissionTimeoutMs());

      this.pending.set(requestId, { tool, input, requestedAt, resolve, timer });
      const gate: PendingGate = { requestId, tool, input, requestedAt };
      this.announceGate(
        { type: "permission-request", ...gate },
        { type: "gate-open", sessionId: this.id, gate },
      );
    });
  }

  /** Supervised gates stay under the CLI's hook timeout; autonomous ones don't. */
  private permissionTimeoutMs(): number {
    return this.autonomous
      ? CONFIG.autonomous.permissionTimeoutMs
      : CONFIG.permissionTimeoutMs;
  }

  /**
   * An autonomous run's gate went unanswered. End it — visibly, and on the
   * record.
   *
   * The supervised path answers `"timeout"`, which makes the hook return an
   * empty body and the CLI fall back to its own TUI prompt. That is fine when
   * someone is looking at the terminal and catastrophic when nobody is: the
   * run sits at a prompt inside a PTY with no window, indistinguishable from
   * work in progress, forever. So an unattended run gets an explicit DENY with
   * a reason naming the timeout, a failed terminal state, and — via the
   * run-end subscribers — a handoff document and a tracker comment.
   *
   * The kill is deferred by a beat so the hook's response actually reaches the
   * CLI first: the denial reason is written into the transcript that the
   * handoff document is made of, which is the difference between "the run
   * failed" and "the run failed, and here is the sentence explaining why".
   */
  private failUnanswered(
    requestId: string,
    tool: string,
    resolve: (outcome: PermissionOutcome) => void,
  ): void {
    // Minutes normally, seconds when the timeout is short — a test harness (or
    // a deliberately impatient host) that sets 25s must not have its runs
    // report "unanswered for 0m", which reads as a bug in the timeout itself.
    const ms = this.permissionTimeoutMs();
    const held = ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
    const reason =
      `Denied automatically: this ${tool} request waited ${held} ` +
      `with nobody to answer it, so Drydock ended the run.`;
    this.failure = { at: Date.now(), reason: `${tool} gate unanswered for ${held}` };
    log.warn("autonomous gate went unanswered — denying and ending the run", {
      id: this.id,
      tool,
      ticket: this.ticket,
      held,
    });
    this.announceGate(
      { type: "permission-resolved", requestId, decision: "deny" },
      { type: "gate-resolved", sessionId: this.id, requestId, decision: "deny" },
    );
    resolve({ decision: "deny", reason });
    const grace = setTimeout(() => this.kill(), 2_000);
    grace.unref?.();
  }

  resolvePermission(requestId: string, decision: PermissionDecision, reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.announceGate(
      { type: "permission-resolved", requestId, decision },
      { type: "gate-resolved", sessionId: this.id, requestId, decision },
    );
    p.resolve({ decision, reason });
    return true;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      title: this.title,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      ticket: this.ticket,
      worktree: this.worktree,
      branch: this.branch,
      status: this.status,
      exitCode: this.exitCode,
      idle: this.idle,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      pendingPermissions: this.pending.size,
      autonomous: this.autonomous,
      origin: this.origin,
      permissionMode: this.permissionMode,
      owner: this.owner,
      ownerName: this.ownerName,
      visibility: this.visibility,
      activity: this.activity,
      failure: this.failure,
      handoff: this.handoff,
    };
  }

  /**
   * The secret a spawned CLI's hooks authenticate with (DRY-27).
   *
   * Read off the env the daemon injected rather than stored separately, so
   * there is exactly one copy and it survives a restart with the rest of the
   * index. Undefined for a session spawned before this existed — the hook
   * routes treat that as "this session has no key" and let it through, which is
   * self-healing (every new session has one) and is not a bypass anyone can
   * claim: the key is looked up FROM the session, not taken from the request.
   */
  get hookKey(): string | undefined {
    return this.env.DRYDOCK_SESSION_KEY;
  }

  /** Cheap check for the run-end subscribers, which run outside this class. */
  get isAutonomous(): boolean {
    return this.autonomous;
  }

  /** The failure record, for the handoff document and the tracker comment. */
  get runFailure(): RunFailure | undefined {
    return this.failure;
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}
