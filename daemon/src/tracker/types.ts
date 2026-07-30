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
  /**
   * Parent ticket, when this one hangs off something (DRY-13). Carries the
   * title, not just the key, on purpose: a child can still arrive without its
   * epic — the parent may sit outside the configured project scope, or the
   * provider may not be able to express "epics too" (older Jira DC, where the
   * link is a per-instance custom field). Providers exempt epics from the
   * backlog exclusion so this is the exception rather than the rule, but when
   * it happens the title lets the sidebar head the group with a real name
   * instead of a bare key.
   *
   * `type` is the parent's own type where the provider exposes it (Jira does;
   * Switchyard's inline parent doesn't). The sidebar uses it to tell an
   * epic parent from a task parent when the parent itself isn't loaded.
   */
  parent?: { key: string; title?: string; type?: string };
  /**
   * For an epic: how its children break down by status, across ALL of them
   * rather than the ones this pull happened to return (DRY-13).
   *
   * Counting the loaded children instead would be free, and useless in the
   * case that matters: the sidebar excludes the backlog, so an epic whose work
   * hasn't started yet loads zero children and its row says nothing at all.
   * Getting the real numbers costs one extra request on Jira (`parent in (…)`
   * for every epic at once) and one per epic on Switchyard, whose list filter
   * has no OR — small either way, since it's scoped to epics.
   *
   * Optional because a provider that can't answer should degrade to the
   * loaded-children rollup, not break.
   */
  childStats?: { total: number; byCategory: Partial<Record<TicketCategory, number>> };
  /** Primary label/tag, surfaced as a chip in the sidebar. */
  tag?: string;
  /** Assignee, when the provider exposes one. Absent = unassigned. */
  assignee?: { id?: string; name: string };
  url?: string;
}

/**
 * One comment off a ticket's thread (DRY-53), normalized across providers.
 *
 * Deleted comments are dropped by the provider rather than carried with a flag:
 * the only consumer is agent context, and a retracted comment is exactly the
 * thing not to brief an agent from.
 */
export interface TicketComment {
  /** Display name of whoever wrote it — "claude" and a human read differently. */
  author?: string;
  /**
   * Timestamp exactly as the provider wrote it — ISO-8601-ish, but Switchyard
   * separates with a space and Jira offsets with `+0000`. Rendering parses it
   * best-effort and falls back to the raw string, so no provider has to
   * normalize a field whose only job is to orient a reader in time.
   */
  createdAt?: string;
  body: string;
}

/**
 * What a `getTicket` caller actually needs (DRY-53).
 *
 * `thread` buys the comment history and the walk up to the epic, which cost
 * extra tracker round trips: up to two on Switchyard, whose single-ticket
 * endpoint hands back a bare parent UUID, plus a comment page on Jira. Only the
 * SessionStart brief reads any of it — the shell's ticket panel renders none of
 * it — so it is opt-in rather than a tax on every ticket click.
 */
export interface TicketDetailOptions {
  thread?: boolean;
}

/** Ticket plus the body pulled into a spawned agent's context. */
export interface TicketDetail extends Ticket {
  description: string;
  project: string;
  labels: string[];
  /**
   * The comment thread, oldest first (DRY-53). House style records decisions,
   * design reviews and handoffs as comments, so on any ticket with history this
   * — not `description` — is where current state lives. The window that
   * actually reaches an agent is chosen at format time (tracker/context.ts);
   * providers return what they have.
   *
   * `commentCount` is the thread's TRUE length, which is not `comments.length`
   * whenever a provider capped its fetch. The formatter needs the real number
   * to tell the agent it's seeing a window rather than the whole record.
   *
   * Optional on purpose: a provider that can't answer omits both, and the
   * formatter emits no activity section at all rather than an empty one that
   * reads as "nobody has commented".
   */
  comments?: TicketComment[];
  commentCount?: number;
  /**
   * Nearest ancestor of type epic (DRY-53), when there is one and the provider
   * could resolve it. `parent` (inherited from Ticket) is the IMMEDIATE parent;
   * these differ for a subtask, whose epic sits two rungs up
   * (epic → task/bug/spike → subtask), and coincide for a task under an epic —
   * the formatter dedupes that case.
   *
   * Keys only, deliberately: enough for an agent to look the epic up and check
   * its work against the plan, without paying for the epic's body on every
   * spawn. The title rides along because both providers hand it over for free.
   */
  epic?: { key: string; title?: string };
}

export interface Project {
  key: string;
  name: string;
  repo?: string | null;
  color?: string | null;
}

export interface TicketQuery {
  project?: string;
  /**
   * Scope to these project keys (DRY-30). Unset/empty = no project filter —
   * which against a corporate tracker means "everything"; the server layer
   * defaults this from DRYDOCK_TRACKER_PROJECTS so an unscoped pull only
   * happens when the host explicitly configured none.
   */
  projects?: string[];
  /** Only non-closed tickets (the default for the sidebar). */
  open?: boolean;
  /**
   * Include backlog-bucket tickets in an `open` query. OFF by default
   * (DRY-30): a big tracker's backlog dwarfs the actionable set, so providers
   * must exclude it in the upstream query (JQL / status param), not
   * post-filter what was already pulled.
   */
  includeBacklog?: boolean;
  text?: string;
  limit?: number;
}

/**
 * Optional, capability-gated writes.
 *
 * `comment` here is the WRITE, and it belongs to DRY-49 — posting an autonomous
 * run's outcome back to its ticket. It is not the comment thread the rest of
 * this file is full of: that is DRY-53 READING an existing ticket to brief an
 * agent, it needs no capability (a provider with no thread to give just omits
 * it), and it flows the opposite way. Only the write can be unavailable, which
 * is why only the write is gated — the fixture provider advertises
 * `comment: false` so the zero-config default proves a run's record stands up
 * without a tracker at all.
 *
 * The reader is `runs.ts`, and only `runs.ts`. This used to say "the UI hides
 * what a provider can't do", which was never true of `comment` and is not true
 * of `transition` either: the flags are shipped to the browser on
 * `/api/tracker/info` and the shell reads neither. Nothing renders differently
 * for a provider that can't comment — which is defensible, since the surface
 * that would (the rail's terminal state) is required to stand alone anyway
 * (DRY-73).
 */
export interface TrackerCapabilities {
  comment: boolean;
  transition: boolean;
}

/**
 * One issue tracker. The shell depends on this, not on Switchyard or Jira.
 * `comment` / `transition` are optional and advertised via `capabilities`.
 *
 * Mind the direction of travel, since comments appear on both sides of this
 * interface: `getTicket({ thread: true })` reads a thread INTO a spawning agent
 * (DRY-53), `comment()` writes what that agent did back OUT (DRY-49).
 */
export interface TrackerProvider {
  readonly id: string; // 'switchyard' | 'jira' | 'fixture'
  readonly name: string; // display name for the sidebar header
  readonly capabilities: TrackerCapabilities;

  listProjects(): Promise<Project[]>;
  listTickets(q: TicketQuery): Promise<Ticket[]>; // sidebar (grouped by repo in the shell)
  searchTickets(text: string, projects?: string[]): Promise<Ticket[]>; // Ctrl+K palette / search endpoint
  getTicket(key: string, opts?: TicketDetailOptions): Promise<TicketDetail>;

  /**
   * Post to a ticket's thread — in practice an autonomous run's outcome
   * (DRY-49, `runs.ts`), which is the only caller.
   *
   * Best-effort by contract, not by accident: the caller fires this without
   * awaiting it and swallows the rejection, because the durable record of a run
   * is the handoff document on disk and this is a pointer to it. Never make
   * anything depend on it having landed.
   */
  comment?(key: string, body: string): Promise<void>;
  transition?(key: string, to: string): Promise<void>;
}

/** What the shell needs to know about the active provider (no credentials). */
export interface TrackerInfo {
  id: string;
  name: string;
  capabilities: TrackerCapabilities;
  /**
   * Host-configured default project scope (DRYDOCK_TRACKER_PROJECTS, DRY-30).
   * The sidebar renders these as fixed chips; empty = unscoped.
   */
  projects: string[];
}
