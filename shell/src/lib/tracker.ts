// Browser-side tracker client (DRY-10). Talks only to the daemon's
// /api/tracker/* — never to Switchyard/Jira directly, so credentials stay
// host-side. The types here mirror the browser-facing subset of
// daemon/src/tracker/types.ts — keep them in sync (same as protocol.ts).
import { DAEMON_HTTP } from "./daemon.js";

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
  const res = await fetch(`${DAEMON_HTTP}/api/tracker/info`);
  return res.json();
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
  const res = await fetch(`${DAEMON_HTTP}/api/tracker/tickets?${params}`);
  return (await res.json()).tickets;
}

export async function searchTickets(q: string, projects?: string[]): Promise<Ticket[]> {
  const params = new URLSearchParams({ q });
  if (projects?.length) params.set("projects", projects.join(","));
  const res = await fetch(`${DAEMON_HTTP}/api/tracker/search?${params}`);
  return (await res.json()).tickets;
}

export async function getTicket(key: string): Promise<TicketDetail> {
  const res = await fetch(`${DAEMON_HTTP}/api/tracker/ticket/${encodeURIComponent(key)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "ticket not found");
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
