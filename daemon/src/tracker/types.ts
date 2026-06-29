// Tracker-provider abstraction (DRY-10).
//
// The sidebar + Ctrl+K palette depend on this interface, never on a concrete
// tracker. Switch backends (Switchyard at home, Jira at work) by host config
// with no UI branching. Credentials live in the daemon/host config and never
// reach the browser — the shell only ever talks to the daemon's /api/tracker/*.
//
// (The browser-facing subset of these types is mirrored in
// shell/src/lib/tracker.ts — keep them in sync, same as protocol.ts.)

/**
 * Stable status bucket every provider normalizes to. The shell colors status
 * dots by this, so it must never carry provider-specific values. Providers map
 * their own status taxonomy (Switchyard categories, Jira statusCategory, …)
 * onto these.
 */
export type TicketCategory =
  | "backlog"
  | "planning"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

/** Normalized ticket shape the sidebar/palette render. Provider-agnostic. */
export interface Ticket {
  key: string; // e.g. "ARGY-89"
  title: string;
  status: { category: TicketCategory; label: string };
  /** Grouping bucket for the sidebar (repo name, or project key as fallback). */
  repo: string;
  /** Ticket type, when the provider exposes it (epic / task / bug / …). */
  type?: string;
  /** Primary label/tag, surfaced as a chip in the sidebar. */
  tag?: string;
  url?: string;
}

/** Ticket plus the body pulled into a spawned agent's context. */
export interface TicketDetail extends Ticket {
  description: string;
  project: string;
  labels: string[];
}

export interface Project {
  key: string;
  name: string;
  repo?: string | null;
  color?: string | null;
}

export interface TicketQuery {
  project?: string;
  /** Only non-closed tickets (the default for the sidebar). */
  open?: boolean;
  text?: string;
  limit?: number;
}

/** Optional, capability-gated writes. The UI hides what a provider can't do. */
export interface TrackerCapabilities {
  comment: boolean;
  transition: boolean;
}

/**
 * One issue tracker. The shell depends on this, not on Switchyard or Jira.
 * `comment` / `transition` are optional and advertised via `capabilities`.
 */
export interface TrackerProvider {
  readonly id: string; // 'switchyard' | 'jira' | 'fixture'
  readonly name: string; // display name for the sidebar header
  readonly capabilities: TrackerCapabilities;

  listProjects(): Promise<Project[]>;
  listTickets(q: TicketQuery): Promise<Ticket[]>; // sidebar (grouped by repo in the shell)
  searchTickets(text: string): Promise<Ticket[]>; // Ctrl+K palette
  getTicket(key: string): Promise<TicketDetail>; // pulled into the spawned agent

  comment?(key: string, body: string): Promise<void>;
  transition?(key: string, to: string): Promise<void>;
}

/** What the shell needs to know about the active provider (no credentials). */
export interface TrackerInfo {
  id: string;
  name: string;
  capabilities: TrackerCapabilities;
}
