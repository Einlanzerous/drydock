// Wire protocol shared with the daemon.
// (Duplicated verbatim from daemon/src/protocol.ts — keep them in sync.)

export type PermissionDecision = "allow" | "deny";

/**
 * One gate still waiting on an answer. The same shape wherever a gate is
 * surfaced — the per-pane replay and the shell-wide event stream (DRY-50) —
 * so a gate can never render on one surface and be missing from the other.
 */
export interface PendingGate {
  requestId: string;
  tool: string;
  input: unknown;
  /**
   * Epoch ms the gate was raised. Load-bearing rather than decorative: the
   * shell-wide stream outlives any pane, so a client can learn about a gate
   * long after the fact and cannot infer the age itself. "How long has this
   * been held" is how a wedge becomes legible as a number.
   */
  requestedAt: number;
}

/** Client (browser) -> Daemon, over a per-session WebSocket. */
export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | {
      type: "permission";
      requestId: string;
      decision: PermissionDecision;
      /**
       * Free text handed back to the agent as the tool result. A bare denial
       * usually just makes the agent retry the same call, so the reason is
       * what turns "no" into a redirect (DRY-50).
       */
      reason?: string;
    };

/** Daemon -> Client, over a per-session WebSocket. */
export type ServerMessage =
  | { type: "replay"; data: string } // one-shot scrollback dump on attach
  | { type: "data"; data: string } // live PTY output
  | { type: "status"; status: SessionStatus; exitCode?: number }
  | { type: "idle"; idle: boolean } // agent yielded its turn (Stop hook) / resumed
  | ({ type: "permission-request" } & PendingGate)
  | {
      type: "permission-resolved";
      requestId: string;
      decision: PermissionDecision | "timeout";
    };

/**
 * Daemon -> Client, over the shell-wide event stream (SSE `/api/events`).
 *
 * Deliberately not a per-session socket: its whole reason to exist is that a
 * minimized window unmounts its pane and closes the only socket the session
 * had, leaving a gate broadcasting to nobody (DRY-50). This stream's lifetime
 * is the shell's, so it carries every session's gates whether or not that
 * session has a window open.
 */
export type EventMessage =
  /**
   * The complete set of open gates, sent once when a stream opens. A client
   * REPLACES its state with this rather than merging it.
   *
   * A stream of gate-opens alone is not enough to stay correct: any resolution
   * that happens while the stream is down is never delivered, so a client that
   * merely accumulates would keep gates for sessions that are long gone,
   * held-time ticking up. The dev daemon runs under `--watch` and restarts on
   * every save, so that outage is the common case, not the exotic one.
   */
  | {
      type: "gate-snapshot";
      /**
       * The daemon's clock at send. `requestedAt` is stamped daemon-side, and
       * the browser may be on another machine entirely (config.ts binds
       * 0.0.0.0 for exactly that), so a client subtracting its own Date.now()
       * reports the clock skew as held-time. Held-time is the signal a wedge
       * is read from, so it has to be measured against one clock.
       */
      serverNow: number;
      gates: { sessionId: string; gate: PendingGate }[];
    }
  | { type: "gate-open"; sessionId: string; gate: PendingGate }
  | {
      type: "gate-resolved";
      sessionId: string;
      requestId: string;
      decision: PermissionDecision | "timeout";
    };

export type SessionStatus = "running" | "exited";

/** Session summary returned over the HTTP control API. */
export interface SessionInfo {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  /** Tracker ticket key this session was spawned for, if any. */
  ticket?: string;
  /** Isolated git worktree path this session runs in (DRY-15), if any. */
  worktree?: string;
  /** Branch checked out in that worktree (e.g. `agent/DRY-15`). */
  branch?: string;
  status: SessionStatus;
  exitCode: number | null;
  /** Agent has yielded its turn and is waiting on the user (Stop hook). */
  idle: boolean;
  cols: number;
  rows: number;
  createdAt: number;
  pendingPermissions: number;
}
