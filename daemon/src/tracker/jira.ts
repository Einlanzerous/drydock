import type {
  Project,
  Ticket,
  TicketCategory,
  TicketDetail,
  TicketQuery,
  TrackerProvider,
} from "./types.js";

/**
 * Live Jira backend (DRY-10) — works against both Jira Cloud and Server/Data
 * Center from one code path:
 *
 * - Everything uses the `/rest/api/2/*` endpoints. Cloud serves v2 alongside
 *   v3, and v2 keeps `description`/comment bodies as plain strings — so we
 *   never have to produce or parse ADF documents.
 * - The ONE real divergence is search: Cloud removed classic `/search`
 *   (mid-2025) in favor of `/search/jql` + nextPageToken; DC still only has
 *   `/search` + startAt. We probe `/search/jql` first and fall back on 404/410,
 *   caching the answer for the daemon's lifetime.
 * - Auth: DRYDOCK_JIRA_EMAIL + DRYDOCK_JIRA_TOKEN → Basic (Cloud API token);
 *   token alone → Bearer (DC personal access token).
 *
 * Credentials stay on the host; the browser only sees /api/tracker/*.
 */
export interface JiraConfig {
  /** Site base, e.g. https://yourco.atlassian.net or https://jira.corp.example */
  baseUrl: string;
  /** Set for Jira Cloud (pairs with an API token as Basic auth). */
  email?: string;
  /** Cloud API token (with email) or DC personal access token (alone). */
  token: string;
}

// Subset of a Jira issue we consume (fields= keeps responses to exactly this).
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: string | null;
    labels?: string[];
    issuetype?: { name?: string };
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { key?: string; name?: string };
    assignee?: { accountId?: string; name?: string; displayName?: string } | null;
  };
}

const FIELDS = "summary,status,issuetype,labels,assignee,project";

// Same backstop as the Switchyard provider: the sidebar's unbounded list never
// pulls more than this many issues out of a huge corporate Jira.
const MAX_TICKETS = 2000;
const PAGE_SIZE = 100; // Jira caps maxResults at 100 on most deployments

/**
 * Jira's stable taxonomy is statusCategory (new / indeterminate / done); the
 * status *name* is free-form per workflow. Category gives the coarse bucket,
 * the name upgrades it to review/blocked/planning when it obviously is one —
 * same trick the Switchyard provider uses for "review".
 */
function mapCategory(categoryKey?: string, statusName?: string): TicketCategory {
  if (statusName) {
    if (/review|approval|qa|verif/i.test(statusName)) return "review";
    if (/block|hold|impedi/i.test(statusName)) return "blocked";
    if (/plan|triage|refine|groom/i.test(statusName)) return "planning";
  }
  switch (categoryKey) {
    case "indeterminate":
      return "in_progress";
    case "done":
      return "done";
    case "new":
    default:
      return "backlog";
  }
}

/** JQL string literal: backslashes and quotes escaped. */
function jqlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class JiraProvider implements TrackerProvider {
  readonly id = "jira";
  readonly name = "Jira";
  readonly capabilities = { comment: true, transition: true };

  private readonly baseUrl: string;
  private readonly auth: string;
  /** Resolved on first search: true = Cloud (`/search/jql`), false = DC (`/search`). */
  private cloudSearch: boolean | undefined;

  constructor(cfg: JiraConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.auth = cfg.email
      ? `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`
      : `Bearer ${cfg.token}`;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rest/api/2${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: this.auth,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) throw new Error(`jira ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }

  private toTicket(i: JiraIssue): Ticket {
    const f = i.fields;
    const category = mapCategory(f.status?.statusCategory?.key, f.status?.name);
    return {
      key: i.key,
      title: f.summary,
      status: { category, label: f.status?.name ?? category },
      // Jira knows nothing about repos; the project key is the grouping bucket,
      // and repos.ts maps it to a real path (DRYDOCK_REPO_PATHS) like any other.
      repo: (f.project?.key ?? i.key.split("-")[0]).toLowerCase(),
      type: f.issuetype?.name,
      tag: f.labels?.[0],
      assignee: f.assignee
        ? {
            id: f.assignee.accountId ?? f.assignee.name,
            name: f.assignee.displayName ?? f.assignee.name ?? "",
          }
        : undefined,
      url: `${this.baseUrl}/browse/${i.key}`,
    };
  }

  private buildJql(q: TicketQuery): string {
    const clauses: string[] = [];
    if (q.project) clauses.push(`project = ${jqlQuote(q.project)}`);
    if (q.open) clauses.push(`statusCategory != Done`);
    if (q.text) clauses.push(`text ~ ${jqlQuote(q.text)}`);
    return `${clauses.join(" AND ")}${clauses.length ? " " : ""}ORDER BY updated DESC`;
  }

  /**
   * One page of search, hiding the Cloud/DC split. Returns the issues plus an
   * opaque "next" cursor (nextPageToken on Cloud, startAt offset on DC);
   * undefined next = exhausted.
   */
  private async searchPage(
    jql: string,
    limit: number,
    next?: string,
  ): Promise<{ issues: JiraIssue[]; next?: string }> {
    if (this.cloudSearch !== false) {
      const params = new URLSearchParams({ jql, maxResults: String(limit), fields: FIELDS });
      if (next) params.set("nextPageToken", next);
      try {
        const body = await this.req(`/search/jql?${params}`);
        this.cloudSearch = true;
        return { issues: body.issues ?? [], next: body.nextPageToken ?? undefined };
      } catch (e) {
        // Only reroute when the endpoint itself is absent (DC); a live probe
        // failing with 400/401/… must surface, not silently switch APIs.
        if (this.cloudSearch || !/-> (404|410)/.test(String(e))) throw e;
        this.cloudSearch = false;
      }
    }
    const startAt = Number(next ?? 0);
    const params = new URLSearchParams({
      jql,
      maxResults: String(limit),
      startAt: String(startAt),
      fields: FIELDS,
    });
    const body = await this.req(`/search?${params}`);
    const issues: JiraIssue[] = body.issues ?? [];
    const consumed = startAt + issues.length;
    return {
      issues,
      next: issues.length && consumed < (body.total ?? 0) ? String(consumed) : undefined,
    };
  }

  async listProjects(): Promise<Project[]> {
    // Cloud paginates under /project/search (values[]); DC only has /project
    // (bare array). Probe like search does.
    let raw: any[];
    try {
      const body = await this.req(`/project/search?maxResults=200`);
      raw = body.values ?? [];
    } catch (e) {
      if (!/-> (404|410)/.test(String(e))) throw e;
      raw = await this.req(`/project`);
    }
    return raw.map((p: any) => ({ key: p.key, name: p.name ?? p.key, repo: null, color: null }));
  }

  async listTickets(q: TicketQuery): Promise<Ticket[]> {
    // Same contract as the Switchyard provider: no limit (the sidebar) means
    // "everything matching", paginated to the MAX_TICKETS backstop; an explicit
    // limit (the palette) is a single page.
    const paginate = q.limit === undefined;
    const jql = this.buildJql(q);
    const out: Ticket[] = [];
    let next: string | undefined;
    do {
      const page = await this.searchPage(jql, Math.min(q.limit ?? PAGE_SIZE, PAGE_SIZE), next);
      out.push(...page.issues.map((i) => this.toTicket(i)));
      next = page.next;
    } while (paginate && next && out.length < MAX_TICKETS);
    return out;
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    return this.listTickets({ text, limit: 50 });
  }

  async getTicket(key: string): Promise<TicketDetail> {
    const i: JiraIssue = await this.req(
      `/issue/${encodeURIComponent(key)}?fields=${FIELDS},description`,
    );
    return {
      ...this.toTicket(i),
      project: i.fields.project?.key ?? "",
      labels: i.fields.labels ?? [],
      // v2 keeps this a plain string (wiki markup at worst) — fine as agent
      // context, and no ADF parsing.
      description: i.fields.description ?? "",
    };
  }

  async comment(key: string, body: string): Promise<void> {
    await this.req(`/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  /**
   * Jira transitions are per-workflow IDs, not status names: resolve `to`
   * against the issue's available transitions (by transition name or target
   * status name, case-insensitive), then fire the id.
   */
  async transition(key: string, to: string): Promise<void> {
    const path = `/issue/${encodeURIComponent(key)}/transitions`;
    const body = await this.req(path);
    const transitions: { id: string; name?: string; to?: { name?: string } }[] =
      body.transitions ?? [];
    const want = to.toLowerCase();
    const match = transitions.find(
      (t) => t.name?.toLowerCase() === want || t.to?.name?.toLowerCase() === want,
    );
    if (!match) {
      const available = transitions.map((t) => t.name ?? t.to?.name).join(", ");
      throw new Error(`jira: no transition to "${to}" on ${key} (available: ${available})`);
    }
    await this.req(path, { method: "POST", body: JSON.stringify({ transition: { id: match.id } }) });
  }
}
