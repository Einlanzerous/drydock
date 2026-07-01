// Wire protocol shared between daemon and shell.
// (Duplicated verbatim in shell/src/lib/protocol.ts — keep them in sync.)

export type PermissionDecision = "allow" | "deny";

/** Client (browser) -> Daemon, over a per-session WebSocket. */
export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "permission"; requestId: string; decision: PermissionDecision };

/** Daemon -> Client, over a per-session WebSocket. */
export type ServerMessage =
  | { type: "replay"; data: string } // one-shot scrollback dump on attach
  | { type: "data"; data: string } // live PTY output
  | { type: "status"; status: SessionStatus; exitCode?: number }
  | { type: "idle"; idle: boolean } // agent yielded its turn (Stop hook) / resumed
  | { type: "permission-request"; requestId: string; tool: string; input: unknown }
  | {
      type: "permission-resolved";
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
  status: SessionStatus;
  exitCode: number | null;
  /** Agent has yielded its turn and is waiting on the user (Stop hook). */
  idle: boolean;
  cols: number;
  rows: number;
  createdAt: number;
  pendingPermissions: number;
}
