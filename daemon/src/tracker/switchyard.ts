import type {
  Project,
  Ticket,
  TicketCategory,
  TicketDetail,
  TicketQuery,
  TrackerProvider,
} from "./types.js";

/**
 * Live Switchyard backend. Talks to the Switchyard REST API (the same surface
 * the `switchyard` MCP proxies) with credentials read from host config —
 * DRYDOCK_SWITCHYARD_URL + DRYDOCK_SWITCHYARD_TOKEN. The browser never sees the
 * token; it only calls the daemon's /api/tracker/* endpoints.
 */
export interface SwitchyardConfig {
  baseUrl: string;
  token?: string;
}

// Shape returned by the Switchyard API (subset we consume).
interface SwitchyardTicket {
  key: string;
  title: string;
  type?: string;
  description?: string;
  status?: { category?: string; display_name?: string };
  project?: { key?: string; name?: string; repo_url?: string | null };
  labels?: { name: string }[];
  assignee?: { id?: string; name?: string } | null;
}

// The list endpoint has no `open` flag; "open" = every non-closed category.
// (Verified against the live API: `open=true` is ignored, a status list filters.)
// Backlog is requested only when the query opts in (DRY-30) — excluded at the
// API level so it's never pulled, not hidden client-side.
const OPEN_CATEGORIES = "planning,in_progress,blocked";
const OPEN_CATEGORIES_WITH_BACKLOG = `backlog,${OPEN_CATEGORIES}`;

// The API caps a page at ~100; an unbounded list (the sidebar) follows the
// cursor until exhausted, but never past this many tickets — a backstop so a
// huge tracker can't pull the whole world into one sidebar.
const MAX_TICKETS = 2000;

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  backlog: "Backlog",
  planning: "Planning",
  in_progress: "In Progress",
  review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

/** Map a Switchyard status (category + display name) onto our stable bucket. */
function mapCategory(category?: string, displayName?: string): TicketCategory {
  if (displayName && /review/i.test(displayName)) return "review";
  switch (category) {
    case "in_progress":
      return "in_progress";
    case "planning":
      return "planning";
    case "blocked":
      return "blocked";
    case "closed":
      return "done";
    case "backlog":
    default:
      return "backlog";
  }
}

/** Grouping bucket for the sidebar: repo basename if known, else project key. */
function repoOf(t: SwitchyardTicket): string {
  const url = t.project?.repo_url;
  if (url) return url.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
  return (t.project?.key ?? t.key.split("-")[0]).toLowerCase();
}

function toTicket(t: SwitchyardTicket): Ticket {
  const category = mapCategory(t.status?.category, t.status?.display_name);
  return {
    key: t.key,
    title: t.title,
    status: { category, label: t.status?.display_name ?? CATEGORY_LABEL[category] },
    repo: repoOf(t),
    type: t.type,
    tag: t.labels?.[0]?.name,
    assignee: t.assignee?.name ? { id: t.assignee.id, name: t.assignee.name } : undefined,
  };
}

export class SwitchyardProvider implements TrackerProvider {
  readonly id = "switchyard";
  readonly name = "Switchyard";
  readonly capabilities = { comment: true, transition: true };

  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(cfg: SwitchyardConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.token = cfg.token;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) throw new Error(`switchyard ${path} -> ${res.status} ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }

  /** The API paginates under `items`; tolerate a bare array too. */
  private items(body: any): any[] {
    return Array.isArray(body) ? body : (body?.items ?? []);
  }

  async listProjects(): Promise<Project[]> {
    const body = await this.req(`/v1/projects`);
    return this.items(body).map((p: any) => ({
      key: p.key,
      name: p.name ?? p.key,
      repo: p.repo_url ?? null,
      color: p.color ?? null,
    }));
  }

  async listTickets(q: TicketQuery): Promise<Ticket[]> {
    // The API filters by a single `project` param, so a multi-project scope
    // (DRY-30) fans out one query per key and concatenates — projects are
    // disjoint, so no dedupe needed.
    if (q.projects?.length) {
      const per = await Promise.all(
        q.projects.map((p) => this.listTickets({ ...q, projects: undefined, project: p })),
      );
      return per.flat();
    }
    // No explicit limit (the sidebar) means "all open tickets" — a single page
    // caps at ~100, so follow `next_cursor` until exhausted (bounded by
    // MAX_TICKETS). A caller that passes a limit (e.g. the palette) gets one page.
    const paginate = q.limit === undefined;
    const pageSize = q.limit ?? 200;
    const out: Ticket[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams();
      if (q.project) params.set("project", q.project);
      if (q.open) {
        params.set("status", q.includeBacklog ? OPEN_CATEGORIES_WITH_BACKLOG : OPEN_CATEGORIES);
      }
      if (q.text) params.set("text", q.text);
      params.set("limit", String(pageSize));
      if (cursor) params.set("cursor", cursor);
      const body = await this.req(`/v1/tickets?${params}`);
      out.push(...this.items(body).map(toTicket));
      cursor = body?.page?.next_cursor ?? undefined;
    } while (paginate && cursor && out.length < MAX_TICKETS);
    return out;
  }

  async searchTickets(text: string, projects?: string[]): Promise<Ticket[]> {
    // Search spans all statuses (you're looking for a specific ticket) but
    // stays inside the project scope (DRY-30).
    return this.listTickets({ text, projects, limit: 50 });
  }

  async getTicket(key: string): Promise<TicketDetail> {
    const t: SwitchyardTicket = await this.req(`/v1/tickets/${encodeURIComponent(key)}`);
    return {
      ...toTicket(t),
      project: t.project?.key ?? "",
      labels: (t.labels ?? []).map((l) => l.name),
      description: t.description ?? "",
    };
  }

  // NOTE: paths verified live; the write *bodies* below are not yet exercised
  // against the API (no UI calls them). Confirm the field names when wiring the
  // capability-gated comment/transition UI.
  async comment(key: string, body: string): Promise<void> {
    await this.req(`/v1/tickets/${encodeURIComponent(key)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async transition(key: string, to: string): Promise<void> {
    await this.req(`/v1/tickets/${encodeURIComponent(key)}/transition`, {
      method: "POST",
      body: JSON.stringify({ status: to }),
    });
  }
}
