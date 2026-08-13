// Wire protocol shared between daemon and shell.
// (Duplicated verbatim in shell/src/lib/protocol.ts — keep them in sync.)

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
    }
  /**
   * A session reached its terminal state (DRY-64).
   *
   * Exit was WebSocket-only until now — `{type:"status", status:"exited"}` to
   * whoever happened to be attached — so a client that only wanted to know a
   * run had ended either held a socket per session purely to hear it, or polled
   * `GET /api/sessions` on a timer and read three fields off every record.
   *
   * Those three fields, named and typed exactly as `SessionInfo`'s, so a
   * consumer patches the record it already has rather than translating one
   * shape into another. `sessionId` rather than `id` only because every other
   * variant in this union says `sessionId`, and a client switching on `type`
   * should not have to remember which arm renamed it.
   *
   * There is deliberately no catch-up frame beside `gate-snapshot`. A gate
   * needs one because a resolution that fires while the stream is down is gone
   * for good; an exit is a *state*, and an exited session stays in the registry
   * until somebody clears it — so a consumer that was disconnected across one
   * still finds it in `GET /api/sessions`. The event removes the polling loop,
   * not the list.
   */
  | {
      type: "session-exit";
      sessionId: string;
      status: SessionStatus;
      exitCode: number | null;
    };

export type SessionStatus = "running" | "exited";

/**
 * Who started a run (DRY-49). Rendered on every rail card.
 *
 * No `sched`: the design shows one, but nothing in Drydock schedules anything,
 * and a card that can display a state the product cannot produce is a lie with
 * a shape. `agent` is accepted by the spawn API today but nothing sends it yet —
 * that's DRY-46/DRY-34's launch surface.
 */
export type RunOrigin = "you" | "agent";

/**
 * How much a session may do without asking (DRY-49). `manual` gates every
 * gated tool through Drydock; `acceptEdits` lets file edits pass but still
 * stops for Bash and WebFetch; the rest are hands-off and never gate at all.
 *
 * On the wire because the rail must not imply a run will ask you something
 * when its mode means it never will.
 */
export type PermissionMode =
  | "manual"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk";

/**
 * Who can see a session once more than one person can sign in (DRY-27).
 *
 * `private` is the default: yours, and nobody else lists it or attaches to it.
 * `public` is the deliberate opposite — a run started where everyone can watch
 * it, which is the point of pushing work at a shared daemon rather than running
 * it on your own laptop.
 *
 * Present in every posture, including the single-account ones where it cannot
 * yet mean anything. That is on purpose: it lives in the session's metadata,
 * which survives daemon restarts, so a session spawned today keeps its answer
 * on the day multi-user is switched on rather than needing one invented for it.
 */
export type SessionVisibility = "private" | "public";

/**
 * Why an autonomous run ended badly, carried on the card so a failure can be
 * triaged without opening anything (DRY-49).
 */
export interface RunFailure {
  /** Epoch ms the run was declared failed. */
  at: number;
  /** One clause, already human-readable — it goes straight onto the card. */
  reason: string;
  /**
   * The last non-empty line the process printed. Deliberately NOT called
   * stderr: a PTY merges stdout and stderr into one stream, so the daemon
   * cannot tell them apart and shouldn't claim to.
   */
  lastLine?: string;
}

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
  // --- autonomous runs (DRY-49) ---
  /**
   * This session runs unattended: it has a card on the rail rather than a
   * window, and it holds gates for an hour instead of five minutes.
   *
   * It lives on the SESSION, not in the saved workspace, and that is the whole
   * trick: the rail rebuilds from /api/sessions on load, so a run is autonomous
   * because the daemon says so — not because a browser remembered. DRY-28's
   * workspace payload needs no change at all.
   */
  autonomous: boolean;
  origin: RunOrigin;
  /** What this session is allowed to do without asking. */
  permissionMode: PermissionMode;
  /**
   * The account this session belongs to (DRY-27). Absent on a daemon with auth
   * off, where there is one owner and naming them says nothing.
   */
  owner?: string;
  /** Display name of that account, so a shared desk can label a card. */
  ownerName?: string;
  /** Whether anybody else can see this run — see SessionVisibility. */
  visibility?: SessionVisibility;
  /**
   * What the agent is doing right now, in one clause ("editing src/foo.ts").
   * Fed by the reporting PreToolUse hook; absent until the first tool call,
   * which is exactly what the rail reads as "starting".
   */
  activity?: string;
  failure?: RunFailure;
  /** Absolute path of the handoff document written when the run ended. */
  handoff?: string;
}
