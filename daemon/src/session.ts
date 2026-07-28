import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_PATH_AUTONOMOUS } from "./hooks.js";
import { log } from "./log.js";
import { assertSocketPathFits, forget, writeMeta } from "./sessions-dir.js";
import { SupervisorLink } from "./supervisor/link.js";
import { PROTOCOL_VERSION, type SessionMeta } from "./supervisor/wire.js";
import type {
  EventMessage,
  PendingGate,
  PermissionDecision,
  PermissionMode,
  RunFailure,
  RunOrigin,
  ServerMessage,
  SessionInfo,
  SessionStatus,
} from "./protocol.js";

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** Tracker ticket this session is scoped to; surfaced to the SessionStart hook. */
  ticket?: string;
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
   * First prompt, typed into the PTY by the DAEMON once the CLI has settled.
   *
   * Load-bearing for autonomous runs specifically. A supervised spawn's prompt
   * is typed by TerminalPane when its WebSocket opens — but an autonomous run
   * has no pane, so nothing would ever type it and the agent would sit at an
   * empty prompt looking exactly like a run in progress.
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

export type RunEndNotifier = (session: PtySession, reason: RunEndReason) => void;

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
  readonly worktree?: string;
  readonly branch?: string;
  readonly origin: RunOrigin;
  readonly permissionMode: PermissionMode;
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
  ) {
    this.id = meta.id;
    this.createdAt = meta.createdAt;
    this.command = meta.command;
    this.args = meta.args;
    this.exec = meta.exec;
    this.env = meta.env;
    this.cwd = meta.cwd;
    this.ticket = meta.ticket;
    this.worktree = meta.worktree;
    this.branch = meta.branch;
    this.autonomous = meta.autonomous;
    this.origin = meta.origin;
    this.permissionMode = meta.permissionMode;
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
      worktree: this.worktree,
      branch: this.branch,
      autonomous: this.autonomous,
      origin: this.origin,
      permissionMode: this.permissionMode,
      env: this.env,
      handoff: this.handoff,
      killedAt: this.killedAt,
    };
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
      worktree: opts.worktree,
      branch: opts.branch,
      autonomous,
      origin: opts.origin ?? "you",
      permissionMode,
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
        TERM: "xterm-256color",
      },
    };

    const link = await SupervisorLink.start(meta);
    const session = new PtySession(meta, notifyGate, notifyRunEnd);
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
  ): PtySession {
    const session = new PtySession(meta, notifyGate, notifyRunEnd);
    session.seedScrollback(link.takeReplay());
    // Whatever size the last client negotiated, not what the spawn asked for.
    session.cols = link.hello.cols;
    session.rows = link.hello.rows;
    session.bind(link);
    log.info("session adopted after a daemon restart", {
      id: meta.id,
      supervisorPid: link.hello.pid,
      pid: link.hello.childPid,
      command: meta.command,
      ticket: meta.ticket,
      autonomous: meta.autonomous || undefined,
      replayBytes: session.scrollbackBytes,
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
  ): PtySession {
    const session = new PtySession(meta, notifyGate, notifyRunEnd);
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

  /** Replace the buffer wholesale — the supervisor's copy is authoritative. */
  private seedScrollback(replay: Buffer): void {
    this.scrollback = replay.byteLength ? [replay] : [];
    this.scrollbackBytes = replay.byteLength;
  }

  /** Wire a link's output, exit and reattach into this session. */
  private bind(link: SupervisorLink): void {
    this.link = link;
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

  // --- daemon-typed first prompt (DRY-49) --------------------------------
  private initialInput?: string;
  private initialTimer: NodeJS.Timeout | null = null;
  private readonly spawnedAt = Date.now();

  /**
   * Type the first prompt once the CLI is ready to receive it.
   *
   * "Ready" is not a fixed delay. TerminalPane can afford one (700ms after its
   * socket opens, by which point the CLI has been booting for a while); the
   * daemon is typing at t=0 of the process, and `claude` takes seconds to draw
   * its banner and enable bracketed paste. Sending early doesn't error — it
   * silently lands in a prompt that isn't listening yet, which for an
   * unattended run means a card that says "starting" forever.
   *
   * So: wait for the first output, then for output to go quiet, capped so a CLI
   * that never stops redrawing still gets its prompt.
   */
  private scheduleInitialInput(text: string): void {
    this.initialInput = text;
    // Ceiling, in case the CLI never falls quiet (spinners, animated banners).
    const cap = setTimeout(() => this.flushInitialInput(), 15_000);
    cap.unref?.();
  }

  /** Re-arm the settle timer on every chunk; fire once output pauses. */
  private noteOutputForInitialInput(): void {
    if (!this.initialInput) return;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = setTimeout(() => this.flushInitialInput(), 1_200);
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
      waitedMs: Date.now() - this.spawnedAt,
    });
    this.link?.write(data);

    // The RETURN IS A SEPARATE WRITE, and that is the whole difference between
    // an autonomous run and a prompt sitting in a text box forever. Appending
    // "\r" to the payload above puts it in the same read() as the text, and
    // Claude Code's TUI treats that burst as pasted content — verified: the
    // prompt appeared in the composer and the agent never started. Give the
    // CLI a beat to render what it received, then press enter on its own.
    //
    // (A supervised spawn deliberately never does this: TerminalPane pre-fills
    // and leaves the human to submit. Nobody is there to submit this one.)
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
    this.noteOutputForInitialInput();
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
      activity: this.activity,
      failure: this.failure,
      handoff: this.handoff,
    };
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
