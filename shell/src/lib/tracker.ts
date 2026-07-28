// Browser-side tracker client (DRY-10). Talks only to the daemon's
// /api/tracker/* — never to Switchyard/Jira directly, so credentials stay
// host-side. The types here mirror the browser-facing subset of
// daemon/src/tracker/types.ts — keep them in sync (same as protocol.ts).
import { DAEMON_HTTP, expectList, getJson } from "./daemon.js";

export type TicketCategory =
  | "backlog"
  | "planning"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

export interface Ticket {
  key: string;
  title: string;
  status: { category: TicketCategory; label: string };
  repo: string;
  type?: string;
  tag?: string;
  assignee?: { id?: string; name: string };
  url?: string;
}

export interface TicketDetail extends Ticket {
  description: string;
  project: string;
  labels: string[];
}

export interface TrackerInfo {
  id: string;
  name: string;
  capabilities: { comment: boolean; transition: boolean };
  /** Host-configured default project scope (DRY-30); empty = unscoped. */
  projects: string[];
}

/** Status-dot colors, keyed by normalized category (design tokens from DRY-9). */
export const CATEGORY_COLOR: Record<TicketCategory, { c: string; g: string }> = {
  in_progress: { c: "#d6a651", g: "#d6a65166" },
  review: { c: "#7f9fd6", g: "#7f9fd655" },
  done: { c: "#5fb98a", g: "#5fb98a77" },
  blocked: { c: "#d57a6e", g: "#d57a6e55" },
  planning: { c: "#6a737f", g: "#6a737f55" },
  backlog: { c: "#6a737f", g: "#6a737f55" },
};

/** Tag/label chip colors, matching the prototype's palette. */
export const TAG_COLOR: Record<string, string> = {
  frontend: "#c9b15a",
  backend: "#7a9e6b",
  infra: "#6fa0a8",
  epic: "#8b7fd6",
  ai: "#d6a651",
};

export function tagColor(tag?: string): string {
  return (tag && TAG_COLOR[tag]) || "#6a737f";
}

export async function getTrackerInfo(): Promise<TrackerInfo> {
  const info = await getJson<TrackerInfo>(`${DAEMON_HTTP}/api/tracker/info`);
  // `name` renders as `name.toUpperCase()`, so a body without one is a crash in
  // the sidebar's template rather than an error the caller can absorb (DRY-51).
  if (typeof info.name !== "string") throw new Error("daemon returned no tracker name");
  return info;
}

export interface TicketScope {
  /**
   * Project keys to pull (DRY-30). Omitted/empty = let the daemon apply its
   * host default (DRYDOCK_TRACKER_PROJECTS); passing keys overrides it, so the
   * caller sends the FULL effective list (host defaults + user-added).
   */
  projects?: string[];
  /** Pull backlog-bucket tickets too. Off by default (DRY-30). */
  backlog?: boolean;
}

export async function listTickets(open = true, scope: TicketScope = {}): Promise<Ticket[]> {
  const params = new URLSearchParams({ open: String(open) });
  if (scope.projects?.length) params.set("projects", scope.projects.join(","));
  if (scope.backlog) params.set("backlog", "true");
  // 502 here is the everyday case, not just version skew: the daemon answers
  // an unreachable tracker with `{error}`, which used to parse as a ticket list
  // and blank `tickets` into undefined — a crash in the sidebar's map (DRY-51).
  const body = await getJson<{ tickets?: Ticket[] }>(
    `${DAEMON_HTTP}/api/tracker/tickets?${params}`,
  );
  return expectList(body.tickets, "tickets");
}

export async function searchTickets(q: string, projects?: string[]): Promise<Ticket[]> {
  const params = new URLSearchParams({ q });
  if (projects?.length) params.set("projects", projects.join(","));
  const body = await getJson<{ tickets?: Ticket[] }>(`${DAEMON_HTTP}/api/tracker/search?${params}`);
  return expectList(body.tickets, "tickets");
}

export async function getTicket(key: string): Promise<TicketDetail> {
  const body = await getJson<{ ticket?: TicketDetail }>(
    `${DAEMON_HTTP}/api/tracker/ticket/${encodeURIComponent(key)}`,
  );
  if (!body.ticket) throw new Error("ticket not found");
  return body.ticket;
}

/** Group a flat ticket list by repo for the sidebar. */
export function groupByRepo(tickets: Ticket[]): { repo: string; tickets: Ticket[] }[] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    if (!groups.has(t.repo)) groups.set(t.repo, []);
    groups.get(t.repo)!.push(t);
  }
  return [...groups.entries()].map(([repo, tickets]) => ({ repo, tickets }));
}
