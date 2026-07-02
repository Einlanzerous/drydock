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
  | { type: "idle"; idle: boolean } // agent yielded its turn (Stop hook) / resumed
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
