import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { CLAUDE_SETTINGS_PATH } from "./hooks.js";
import type {
  PermissionDecision,
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
function resolveSpawn(command: string, args: string[]): { file: string; args: string[] } {
  if (command === "shell") {
    return { file: CONFIG.defaultShell, args: ["-l", ...args] };
  }
  if (command === "claude") {
    return { file: "claude", args: ["--settings", CLAUDE_SETTINGS_PATH, ...args] };
  }
  return { file: command, args };
}

interface PendingPermission {
  tool: string;
  input: unknown;
  resolve: (decision: PermissionDecision | "timeout") => void;
  timer: NodeJS.Timeout;
}

/**
 * One terminal session. The daemon — not any client — owns the PTY master for
 * the whole life of the child process. Clients (browser tabs) attach and detach
 * freely over WebSockets; the child never notices. That decoupling is the whole
 * point: minimize a pane, close the laptop, reconnect tomorrow — the agent kept
 * running and we replay everything it printed while you were gone.
 */
export class PtySession {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly ticket?: string;
  title: string;

  private readonly pty: pty.IPty;
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

  constructor(opts: SpawnOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.cwd = opts.cwd ?? os.homedir();
    this.ticket = opts.ticket;
    this.title = opts.title ?? opts.command;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;

    const spawn = resolveSpawn(this.command, this.args);
    this.pty = pty.spawn(spawn.file, spawn.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        ...opts.env,
        // Lets the PreToolUse hook tell the daemon which session it belongs to.
        DRYDOCK_SESSION_ID: this.id,
        DRYDOCK_DAEMON_URL: `http://${CONFIG.host}:${CONFIG.port}`,
        TERM: "xterm-256color",
      },
    });

    this.pty.onData((data) => this.onData(data));
    this.pty.onExit(({ exitCode }) => this.onExit(exitCode));
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
    this.broadcast({ type: "data", data });
  }

  private onExit(exitCode: number): void {
    this.status = "exited";
    this.exitCode = exitCode;
    this.idle = false; // process is gone; "exited" supersedes "your turn"
    this.broadcast({ type: "status", status: "exited", exitCode });
    // Resolve any dangling permission gates so the CLI isn't left hanging.
    for (const [requestId, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve("timeout");
      this.pending.delete(requestId);
    }
  }

  /** Attach a client: replay scrollback, then stream live + any open gates. */
  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.send(ws, { type: "replay", data: Buffer.concat(this.scrollback).toString("utf8") });
    this.send(ws, {
      type: "status",
      status: this.status,
      exitCode: this.exitCode ?? undefined,
    });
    if (this.idle) this.send(ws, { type: "idle", idle: true });
    for (const [requestId, p] of this.pending) {
      this.send(ws, { type: "permission-request", requestId, tool: p.tool, input: p.input });
    }
  }

  detach(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /**
   * Called from the Stop hook: the agent ended its turn and is waiting on the
   * user. No-op once exited or already idle so we don't churn broadcasts.
   */
  markIdle(): void {
    if (this.status !== "running" || this.idle) return;
    this.idle = true;
    this.broadcast({ type: "idle", idle: true });
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
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.status !== "running") return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // Racing a just-exited PTY; ignore.
    }
  }

  kill(): void {
    if (this.status === "running") this.pty.kill();
  }

  /**
   * Called from the PreToolUse hook path. Registers a pending gate, lights up
   * every attached client, and returns a promise that resolves when a human
   * clicks approve/deny — or when we hit our own timeout (caller then defers to
   * the CLI's normal flow).
   */
  requestPermission(tool: string, input: unknown): Promise<PermissionDecision | "timeout"> {
    // A tool gate means the agent is mid-turn, not idle — the permission overlay
    // is its own attention signal, so drop any stale "your turn" flag.
    this.clearIdle();
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.broadcast({ type: "permission-resolved", requestId, decision: "timeout" });
        resolve("timeout");
      }, CONFIG.permissionTimeoutMs);

      this.pending.set(requestId, { tool, input, resolve, timer });
      this.broadcast({ type: "permission-request", requestId, tool, input });
    });
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.broadcast({ type: "permission-resolved", requestId, decision });
    p.resolve(decision);
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
      status: this.status,
      exitCode: this.exitCode,
      idle: this.idle,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      pendingPermissions: this.pending.size,
    };
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
