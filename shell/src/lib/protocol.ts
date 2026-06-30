// Wire protocol shared with the daemon.
// (Duplicated verbatim from daemon/src/protocol.ts — keep them in sync.)

export type PermissionDecision = "allow" | "deny";

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "permission"; requestId: string; decision: PermissionDecision };

export type ServerMessage =
  | { type: "replay"; data: string }
  | { type: "data"; data: string }
  | { type: "status"; status: SessionStatus; exitCode?: number }
  | { type: "permission-request"; requestId: string; tool: string; input: unknown }
  | {
      type: "permission-resolved";
      requestId: string;
      decision: PermissionDecision | "timeout";
    };

export type SessionStatus = "running" | "exited";

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
  cols: number;
  rows: number;
  createdAt: number;
  pendingPermissions: number;
}
