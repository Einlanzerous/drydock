// The daemon's HTTP responses, as the harnesses read them (DRY-80).
//
// Why this file exists: the point of converting these harnesses to TypeScript
// was that they get `SessionInfo`, `SessionRecord` and friends from `daemon/src`
// for free rather than guessing at them — DRY-27's harness asserted on a field
// by guessing, and nothing but a run could catch it. Nine of these scripts read
// the same three or four envelopes, so declaring them nine times would put the
// guess back, just nine-fold and out of sync.
//
// Everything below is an ENVELOPE only. The payload types are imported from the
// daemon rather than mirrored: a re-declared `SessionInfo` here would be a
// second copy to keep in step by hand, which is the tax CLAUDE.md already pays
// once for protocol.ts and has no reason to pay again.
//
// These are type-only imports, so nothing here survives the transform — tsx
// never resolves a path into `daemon/src` at runtime.
import type { DaemonHealth, Readiness } from "../../daemon/src/health.js";
import type { SessionInfo } from "../../daemon/src/protocol.js";
import type { SessionRecord, WorkspaceState } from "../../daemon/src/state/types.js";
import type { Ticket, TicketDetail } from "../../daemon/src/tracker/types.js";

export type { SessionInfo, SessionRecord, Ticket, TicketDetail, WorkspaceState };

/**
 * The trailing argument every harness's `check()` takes: the diagnosis printed
 * beside a failure.
 *
 * A union rather than `unknown`, which is what this was first widened to when
 * the new typecheck found five call sites in ticket-brief.mts passing a number
 * or a `string[]` to a parameter declared `string`. `unknown` makes the error
 * go away by giving up on the parameter entirely — and these values are
 * interpolated into a template, where the one thing that must not happen is an
 * object arriving and rendering as `[object Object]`: the detail line is then
 * useless at exactly the moment somebody is reading it. This admits every shape
 * that formats usefully and nothing else. Callers with a richer value are
 * expected to `JSON.stringify` it, which most already do.
 */
export type Detail = string | number | readonly string[];

/** `GET /api/sessions` */
export interface SessionsResponse {
  sessions: SessionInfo[];
}

/** `POST /api/sessions` */
export interface SpawnResponse {
  session: SessionInfo;
}

/**
 * `GET /api/sessions/{id}/file`.
 *
 * Read by two harnesses since DRY-63 gave the route a second arm (a session's
 * own handoff document, which lives outside its cwd), which is what moved this
 * up here from a local declaration in spawn-env.mts — see the note at the top
 * about what re-declaring an envelope costs.
 */
export interface FileResponse {
  path?: string;
  content?: string;
  error?: string;
}

/**
 * `GET /healthz` and `GET /readyz` (DRY-48).
 *
 * Imported rather than declared, now that there is something to import: this
 * used to be three fields written out by hand, which was fine while the payload
 * was three fields and is exactly the guess this file exists to remove now that
 * it reports on four subsystems — including the store, whose `StoreHealth` was
 * being partially re-declared here (`capabilities?`) and now arrives whole.
 */
export type HealthResponse = DaemonHealth;
export type ReadyResponse = Readiness;

/** `GET /api/workspace` — null until something has been saved. */
export interface WorkspaceResponse {
  workspace: WorkspaceState | null;
}

/**
 * One window in a saved desk.
 *
 * NOT imported, because the daemon deliberately doesn't have this type:
 * `WorkspaceState.windows` is `unknown[]` on purpose (see its comment — `Win`
 * is UI model that grows a field per desktop feature, and mirroring it in the
 * daemon would mean a daemon change for each one, on a payload it hands back
 * unread). The harnesses read four of its fields, so those four are declared
 * here and the rest stays open.
 */
export interface DeskWindow {
  id: string;
  x: number;
  y: number;
  [key: string]: unknown;
}

/** `GET /api/config` — host policy the DESK applies (DRY-60). */
export interface ConfigResponse {
  autonomous?: { permissionMode?: string; permissionTimeoutMs?: number };
  desk?: { clearFinishedAfterMs?: number };
}

/** `GET /api/sessions/history` — Postgres tier only; 501 elsewhere (DRY-56). */
export interface HistoryResponse {
  sessions: SessionRecord[];
}

/**
 * `GET /api/tracker/tickets`.
 *
 * `stale` rides the 200 rather than arriving as a 502 (DRY-72 trap 2): the
 * daemon answers from last-good during a tracker outage, so the browser's
 * `catch` — which every DRY-55 assertion hangs off — stops firing, and this
 * field is the only thing left that says the list has stopped moving.
 */
export interface TicketsResponse {
  tickets: Ticket[];
  stale?: { ageMs: number; error: string };
}

/** Read a workspace's windows as the desk shapes them. */
export function deskWindows(workspace: WorkspaceState | null | undefined): DeskWindow[] {
  return (workspace?.windows ?? []) as DeskWindow[];
}
