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
  /** Parent ticket (DRY-13). See daemon/src/tracker/types.ts for why the title rides along. */
  parent?: { key: string; title?: string; type?: string };
  /** For an epic: its children by status, across all of them (DRY-13). */
  childStats?: { total: number; byCategory: Partial<Record<TicketCategory, number>> };
  tag?: string;
  assignee?: { id?: string; name: string };
  url?: string;
}

/** One comment off a ticket's thread (DRY-53). See daemon/src/tracker/types.ts. */
export interface TicketComment {
  author?: string;
  createdAt?: string;
  body: string;
}

export interface TicketDetail extends Ticket {
  description: string;
  project: string;
  labels: string[];
  /**
   * Comment thread, oldest first, and the thread's TRUE length (DRY-53) —
   * `commentCount` differs from `comments.length` when the provider capped its
   * fetch.
   *
   * **`/api/tracker/ticket/<KEY>` does not populate these**, and neither is
   * `epic` below. They cost extra tracker round trips (up to two on Switchyard,
   * whose single-ticket endpoint hands back a bare parent UUID) and only the
   * daemon's SessionStart brief reads them, so the daemon asks for them there
   * and not on the path this panel uses. Rendering them here means teaching
   * that route to pass `{thread: true}` first.
   */
  comments?: TicketComment[];
  commentCount?: number;
  /** Nearest ancestor epic, when the provider could resolve one (DRY-53). */
  epic?: { key: string; title?: string };
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

/**
 * Is this ticket an epic? `type` is the provider's own word for it, so the
 * comparison is case-insensitive: Switchyard says `epic`, Jira says `Epic`.
 */
export function isEpic(t: Pick<Ticket, "type">): boolean {
  return t.type?.toLowerCase() === "epic";
}

/** An epic and the loaded tickets that hang off it (DRY-13). */
export interface EpicNode {
  key: string;
  title: string;
  /**
   * The epic ticket itself — absent when a child names an epic the pull didn't
   * return. Providers exempt epics from the backlog exclusion (DRY-13), so this
   * means the epic is outside the configured project scope, or the provider
   * couldn't ask for it. Rows without one are grouping headers, not tickets:
   * the sidebar won't open a detail panel off them, because everything that
   * panel shows above the fold (status, repo) would have to be invented.
   */
  ticket?: Ticket;
  /** Children in the loaded set, before the sidebar's filters. */
  children: Ticket[];
  /** Children surviving the current filter — what actually renders. */
  shown: Ticket[];
  /** Did the epic row itself match the filter, as opposed to only its children? */
  self: boolean;
}

export interface RepoGroup {
  repo: string;
  epics: EpicNode[];
  /** Tickets in the group that hang off no epic. */
  loose: Ticket[];
  /**
   * Tickets in this group matching the current filter — the header count.
   * Deliberately not "rows rendered": an epic heading a group renders whether
   * or not it matched, and an epic named only by a child isn't a ticket at all,
   * so both appear without being counted. The header is answering "how much
   * work is in here", and scaffolding isn't work.
   */
  count: number;
}

/**
 * Identity of an epic's group within a repo. The same epic can head a group in
 * two repos when its children span components, so the repo is part of the key.
 *
 * Exported because the sidebar keys its expand/collapse state by the same
 * identity — two separators for one composite key is how they silently drift.
 * The separator is written `\u0000` and NOT as a literal byte: a raw NUL in
 * source makes git treat the whole file as binary, which costs the diff, blame
 * and grep. This repo has paid that once already (the sidebar's assignee
 * sentinel) and it compiles fine either way, so nothing catches it but this.
 */
export function epicNodeId(repo: string, epicKey: string): string {
  return `${repo}\u0000${epicKey}`;
}

/** Jira's stock subtask type is spelled "Sub-task"; Switchyard's is "subtask". */
const SUBTASK = /^sub-?tasks?$/;

/**
 * Would `t`'s parent be an epic? Trivial when the parent is loaded. When it
 * isn't we lean on the hierarchy (epic → task/bug/spike → subtask): a subtask's
 * parent is a task, anything else's parent is an epic. Jira hands us the
 * parent's own type and we prefer it; Switchyard's inline parent has none.
 */
function parentIsEpic(t: Ticket, loaded: Map<string, Ticket>): boolean {
  const p = t.parent;
  if (!p) return false;
  const known = loaded.get(p.key);
  if (known) return isEpic(known);
  if (p.type) return isEpic(p);
  return !SUBTASK.test(t.type?.toLowerCase() ?? "");
}

/**
 * Group tickets by repo for the sidebar, nesting each repo's tickets under
 * their epic (DRY-13).
 *
 * Takes the filtered set AND the full one because the two answer different
 * questions: `all` establishes which keys are epics and how many children they
 * really have, `shown` decides what renders. Without that split, searching for
 * a child would strand it — its epic wouldn't match, so the row it belongs
 * under would vanish along with the hierarchy.
 *
 * Nesting is deliberately confined to a single repo group. A child whose epic
 * groups elsewhere (Jira derives the bucket per-component, so this is real)
 * stays a row in its OWN group and wears a chip naming the parent instead:
 * `repo` is what resolves to a working directory, so quietly relocating a
 * ticket into another repo's group would misrepresent where its agent runs.
 */
export function groupTickets(shown: Ticket[], all: Ticket[]): RepoGroup[] {
  const loaded = new Map(all.map((t) => [t.key, t]));
  const visible = new Set(shown.map((t) => t.key));
  const groups = new Map<string, RepoGroup>();
  const nodes = new Map<string, EpicNode>(); // keyed by epicNodeId

  const group = (repo: string): RepoGroup => {
    let g = groups.get(repo);
    if (!g) groups.set(repo, (g = { repo, epics: [], loose: [], count: 0 }));
    return g;
  };
  const node = (repo: string, key: string, title: string, ticket?: Ticket): EpicNode => {
    const id = epicNodeId(repo, key);
    let n = nodes.get(id);
    if (!n) {
      nodes.set(id, (n = { key, title, ticket, children: [], shown: [], self: false }));
      group(repo).epics.push(n);
    }
    // A child may have created the node before we reached the epic itself.
    if (ticket && !n.ticket) {
      n.ticket = ticket;
      n.title = ticket.title;
    }
    return n;
  };

  // Pass over the FULL set so epics and child counts are established even when
  // the filter would have hidden them. Repo order follows first appearance.
  for (const t of all) {
    if (isEpic(t)) {
      node(t.repo, t.key, t.title, t).self = visible.has(t.key);
      continue;
    }
    const p = t.parent;
    const sameGroup = p && (loaded.get(p.key)?.repo ?? t.repo) === t.repo;
    if (p && sameGroup && parentIsEpic(t, loaded)) {
      const n = node(t.repo, p.key, p.title || p.key, loaded.get(p.key));
      n.children.push(t);
      if (visible.has(t.key)) n.shown.push(t);
    } else if (visible.has(t.key)) {
      group(t.repo).loose.push(t);
    } else {
      group(t.repo); // keep the repo's slot; it may still hold visible rows
    }
  }

  // Drop what the filter emptied: epics with no surviving row, then groups with
  // nothing left at all.
  const out: RepoGroup[] = [];
  for (const g of groups.values()) {
    g.epics = g.epics.filter((n) => n.self || n.shown.length > 0);
    g.count = g.loose.length + g.epics.reduce((n, e) => n + (e.self ? 1 : 0) + e.shown.length, 0);
    if (g.count) out.push(g);
  }
  return out;
}

/** Ordered done → in-flight → not-started, so the bar reads left-to-right as progress. */
export const ROLLUP_ORDER: TicketCategory[] = [
  "done",
  "review",
  "in_progress",
  "blocked",
  "planning",
  "backlog",
];

/** Fallback names for the tooltip when counts come from the tracker as bare categories. */
const CATEGORY_LABEL: Record<TicketCategory, string> = {
  done: "Done",
  review: "In Review",
  in_progress: "In Progress",
  blocked: "Blocked",
  planning: "Planning",
  backlog: "Backlog",
};

export interface Rollup {
  segments: { category: TicketCategory; label: string; n: number }[];
  total: number;
  done: number;
  /**
   * True when the counts came from the tracker and cover every child. False
   * when they're just the children this pull loaded — which the sidebar must
   * not present as a completion ratio, since `open=true` excludes done tickets
   * and every epic would read 0-of-N.
   */
  authoritative: boolean;
  hint: string;
}

/**
 * Status breakdown for an epic's row. Prefers the tracker's own counts over
 * every child (DRY-13) and falls back to counting the loaded ones, so a
 * provider that can't answer still gets a bar rather than an empty row.
 */
export function epicRollup(node: EpicNode): Rollup {
  const stats = node.ticket?.childStats;
  const counts = new Map<TicketCategory, { label: string; n: number }>();
  if (stats) {
    for (const [c, n] of Object.entries(stats.byCategory)) {
      if (n) counts.set(c as TicketCategory, { label: CATEGORY_LABEL[c as TicketCategory], n });
    }
  } else {
    for (const c of node.children) {
      const seen = counts.get(c.status.category);
      // Label off the tickets themselves here: providers pass through the
      // tracker's own workflow name ("In Review", "Doing"), and the tooltip
      // should say what the tracker says.
      if (seen) seen.n++;
      else counts.set(c.status.category, { label: c.status.label, n: 1 });
    }
  }
  const segments = ROLLUP_ORDER.filter((c) => counts.has(c)).map((c) => ({
    category: c,
    ...counts.get(c)!,
  }));
  const total = stats ? stats.total : node.children.length;
  const parts = segments.map((s) => `${s.n} ${s.label}`).join(" · ");
  return {
    segments,
    total,
    done: counts.get("done")?.n ?? 0,
    authoritative: !!stats,
    hint: stats
      ? `${parts || "no children"} — all ${total} child ticket${total === 1 ? "" : "s"}`
      : `${parts} — of tickets currently loaded`,
  };
}
