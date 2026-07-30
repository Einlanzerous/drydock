import { ChildStatsCache } from "./cache.js";
import type {
  Project,
  Ticket,
  TicketCategory,
  TicketComment,
  TicketDetail,
  TicketDetailOptions,
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
  /**
   * Deadline on a single request, ms (DRY-72). Injected rather than read from
   * CONFIG so the provider stays constructible in isolation, like the Jira one.
   * Omitted = no deadline, which is what shipped before.
   */
  requestTimeoutMs?: number;
  /**
   * Where epic child counts are remembered between pulls (DRY-72). Injected, and
   * shared with whatever other provider a host might construct, because it caches
   * a property of the TRACKER rather than of this class. Omitted = no caching.
   */
  childStats?: ChildStatsCache;
}

// Shape returned by the Switchyard API (subset we consume).
interface SwitchyardTicket {
  /** UUID. Not exposed to the shell — only used to query an epic's children. */
  id?: string;
  key: string;
  title: string;
  type?: string;
  description?: string;
  status?: { category?: string; display_name?: string };
  project?: { key?: string; name?: string; repo_url?: string | null };
  labels?: { name: string }[];
  assignee?: { id?: string; name?: string } | null;
  // The LIST endpoint inlines the parent as {id, key, title} alongside the raw
  // `parent_id`, so the epic rollup needs no second fetch. No `type` here,
  // which is why the sidebar falls back to the CHILD's type to decide whether
  // an unloaded parent is an epic (DRY-13).
  //
  // GET /v1/tickets/:key does NOT hydrate it (DRY-53): `parent_id` comes back
  // populated with `parent: null` beside it. So getTicket — the one that feeds
  // a spawned agent — has to resolve the UUID itself; see resolveAncestry.
  parent?: { key?: string; title?: string } | null;
  parent_id?: string | null;
  // Inlined by the single-ticket endpoint only (DRY-53), oldest first.
  comments?: SwitchyardComment[] | null;
}

interface SwitchyardComment {
  body?: string;
  author?: { name?: string } | null;
  created_at?: string;
  /** Retracted. Body still ships; dropping it is the caller's job. */
  deleted?: boolean;
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

// How many epics may have their children counted at once (DRY-13). Each slot is
// a cursor chain, not a single request, so this is the real concurrency knob.
const CHILD_STATS_POOL = 6;

// Rungs walked upward from a ticket looking for its epic (DRY-53). The
// hierarchy is epic → {task,bug,spike} → subtask, so two hops is the whole
// ladder; the bound is also what keeps a parent cycle from spinning forever.
const MAX_ANCESTOR_HOPS = 2;

/**
 * Budget for the whole ancestry walk (DRY-53). The walk decorates a brief and
 * already degrades a rung at a time on failure, but without a deadline it's a
 * way to lose the brief entirely: it's sequential after the ticket GET, and the
 * hook waiting on the answer is a `curl -s -m 25` with no retry.
 */
const ANCESTRY_TIMEOUT_MS = 6_000;

/**
 * Switchyard's `type` is a validated enum — `spike|task|bug|epic|subtask`, from
 * the API's own schema — so this is an exact match, not the case-insensitive
 * one the Jira provider needs for a free-text issue-type NAME. Two predicates
 * on purpose; folding them together would hide that one side is guaranteed and
 * the other is whatever an admin typed.
 */
function isEpic(type?: string): boolean {
  return type === "epic";
}

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
    parent: t.parent?.key ? { key: t.parent.key, title: t.parent.title } : undefined,
    tag: t.labels?.[0]?.name,
    assignee: t.assignee?.name ? { id: t.assignee.id, name: t.assignee.name } : undefined,
  };
}

/**
 * Thread → the normalized shape, oldest first (DRY-53).
 *
 * The API returns every comment on the ticket in one go, ascending by
 * created_at, with no pagination envelope — so what arrives is the whole thread
 * and `commentCount` can be counted here rather than asked for. (Verified
 * against the server's loadTicketDetail: unbounded query, `orderBy(asc)`.)
 *
 * Deleted comments arrive as tombstones with the body redacted, so they are
 * dropped before counting — "showing 3 of 11" must not count 4 tombstones an
 * agent can never read.
 */
function toComments(raw: SwitchyardComment[] | null | undefined): {
  comments?: TicketComment[];
  commentCount?: number;
} {
  // No field at all is "we don't know", not "there are none" — the contract in
  // types.ts turns on that difference, and answering 0 to an unasked question
  // is the kind of confident wrong number this module keeps refusing to print.
  if (!Array.isArray(raw)) return {};
  const comments = raw
    .filter((c) => !c.deleted && c.body?.trim())
    .map((c) => ({ author: c.author?.name, createdAt: c.created_at, body: c.body!.trim() }));
  return { comments, commentCount: comments.length };
}

export class SwitchyardProvider implements TrackerProvider {
  readonly id = "switchyard";
  readonly name = "Switchyard";
  readonly capabilities = { comment: true, transition: true };

  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly requestTimeoutMs?: number;
  /** DRY-72. A disabled instance when the host injected none, so no `?.` below. */
  private readonly childStats: ChildStatsCache;
  /**
   * Epics already reported as uncountable, so the warning is one line per onset
   * rather than one per sidebar poll (DRY-72).
   *
   * A SET of keys and not a boolean, because a boolean is wrong HERE in a way it
   * isn't in the Jira provider: `listTickets` fans out one nested call per
   * project, each running its own child-stats pass, so a project with no capped
   * epics would clear the flag a previous project had just set and the "one line
   * per onset" warning would print on essentially every refresh.
   */
  private readonly cappedWarned = new Set<string>();

  constructor(cfg: SwitchyardConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.token = cfg.token;
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.childStats = cfg.childStats ?? new ChildStatsCache(0);
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      // Backstop deadline (DRY-72): nothing propagates a client's abort into
      // here, so without one a page-walk outlives the browser that wanted it.
      // A caller with its own tighter budget (the ancestry walk) keeps it.
      signal:
        init?.signal ??
        (this.requestTimeoutMs ? AbortSignal.timeout(this.requestTimeoutMs) : undefined),
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
    const { rows } = await this.fetchPages(
      q,
      q.open ? (q.includeBacklog ? OPEN_CATEGORIES_WITH_BACKLOG : OPEN_CATEGORIES) : undefined,
    );
    // Epics ride along regardless of the backlog toggle (DRY-13). The exclusion
    // exists because a real backlog is enormous; the epics inside it are not,
    // and one is the header its in-flight children hang under — so without this
    // the sidebar's usual state is a child whose epic is missing. Jira folds the
    // same rule into its JQL; this API has no OR across filters, so it costs a
    // second request. Still bounded: `type=epic` is a small slice by definition.
    if (q.open && !q.includeBacklog) {
      const seen = new Set(rows.map((t) => t.key));
      const epics = await this.fetchPages(q, OPEN_CATEGORIES_WITH_BACKLOG, "epic");
      for (const e of epics.rows) {
        if (!seen.has(e.key)) rows.push(e);
      }
    }
    const out = rows.map(toTicket);
    if (q.open) await this.attachChildStats(rows, out);
    return out;
  }

  /**
   * Fill in each epic's child breakdown (DRY-13). One request per epic — the
   * list filter takes a single `parent_id`, with no OR and no count
   * aggregation, so there's no batching to be had here (Jira gets one query for
   * all of them; this API can't).
   *
   * Run through a small pool rather than Promise.all over every epic. The count
   * being bounded by the epic count does NOT bound the concurrency: each epic
   * is itself a cursor-following chain, so 40 open epics would open 40
   * simultaneous chains from a single sidebar refresh — per browser — at a
   * tracker that may rate-limit.
   *
   * Failures are swallowed deliberately: this is decoration on a sidebar that
   * must still draw. The shell falls back to counting the children it loaded.
   */
  private async attachChildStats(rows: SwitchyardTicket[], out: Ticket[]): Promise<void> {
    const byKey = new Map(out.map((t) => [t.key, t]));
    // Serve what's already counted before opening a single cursor chain
    // (DRY-72). Per-epic here rather than the all-or-nothing the Jira provider
    // uses, because each epic costs its own request — so one new epic on the
    // board should cost one request, not a recount of every other epic's years
    // of closed children.
    const pending: SwitchyardTicket[] = [];
    for (const row of rows) {
      if (!isEpic(row.type) || !row.id) continue;
      const ticket = byKey.get(row.key);
      if (!ticket) continue;
      const known = this.childStats.peek(row.key);
      // `capped` is a hit too, and deliberately: it means we already walked this
      // epic's whole cursor chain and threw it away, so re-walking it every 20s
      // is the "maximum cost, zero value" case rather than a fix for it.
      if (known === undefined) pending.push(row);
      else if (known !== "capped") ticket.childStats = known;
    }
    if (!pending.length) return;

    const capped: string[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (let i = cursor++; i < pending.length; i = cursor++) {
        const row = pending[i]!;
        const ticket = byKey.get(row.key)!;
        try {
          // No limit → follows cursors, so an epic with more children than one
          // page holds is counted in full.
          const kids = await this.fetchPages({}, undefined, undefined, row.id);
          // Same rule as the Jira provider: a capped count is a wrong number
          // wearing an authoritative badge, so drop it and let the shell fall
          // back rather than render a false ratio. The VERDICT is cached even
          // though the count isn't: "this epic can't be counted" is a fact about
          // the epic, not an error, and remembering it is what stops the most
          // expensive query in the system running on every list refresh.
          if (kids.truncated) {
            this.childStats.putCapped(row.key);
            capped.push(row.key);
            continue;
          }
          const byCategory: Partial<Record<TicketCategory, number>> = {};
          for (const k of kids.rows) {
            const c = mapCategory(k.status?.category, k.status?.display_name);
            byCategory[c] = (byCategory[c] ?? 0) + 1;
          }
          const stats = { total: kids.rows.length, byCategory };
          ticket.childStats = stats;
          // By reference, which is safe because nothing mutates one after this:
          // a later pull that misses builds fresh counts, one that hits reads.
          this.childStats.put(row.key, stats);
          this.cappedWarned.delete(row.key);
        } catch {
          /* leave childStats unset; the shell degrades to loaded children */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHILD_STATS_POOL, pending.length) }, worker));

    // Said out loud since DRY-72, once per epic rather than once per pass: an
    // epic whose count is abandoned used to cost a full cursor chain on every
    // refresh and show only as a missing progress bar, so there was nothing to
    // connect the cost to.
    const fresh = capped.filter((k) => !this.cappedWarned.has(k));
    if (fresh.length) {
      for (const k of fresh) this.cappedWarned.add(k);
      console.warn(
        `[drydock] switchyard: ${fresh.length} epic(s) exceeded ${MAX_TICKETS} children ` +
          `(${fresh.slice(0, 3).join(", ")}${fresh.length > 3 ? ", …" : ""}), so their progress ` +
          `bars will count only loaded children.`,
      );
    }
  }

  /**
   * Follow `next_cursor` until exhausted. No explicit limit (the sidebar) means
   * "all matching tickets" — a single page caps at ~100 — bounded by
   * MAX_TICKETS. A caller that passes a limit (e.g. the palette) gets one page.
   */
  private async fetchPages(
    q: TicketQuery,
    status?: string,
    type?: string,
    parentId?: string,
  ): Promise<{ rows: SwitchyardTicket[]; truncated: boolean }> {
    const paginate = q.limit === undefined;
    const pageSize = q.limit ?? 200;
    const out: SwitchyardTicket[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams();
      if (q.project) params.set("project", q.project);
      if (status) params.set("status", status);
      if (type) params.set("type", type);
      if (parentId) params.set("parent_id", parentId);
      if (q.text) params.set("text", q.text);
      params.set("limit", String(pageSize));
      if (cursor) params.set("cursor", cursor);
      const body = await this.req(`/v1/tickets?${params}`);
      out.push(...this.items(body));
      cursor = body?.page?.next_cursor ?? undefined;
    } while (paginate && cursor && out.length < MAX_TICKETS);
    // `truncated` matters to the caller counting children: a partial count that
    // still looks authoritative is a wrong number presented as a right one.
    return { rows: out, truncated: paginate && !!cursor };
  }

  async searchTickets(text: string, projects?: string[]): Promise<Ticket[]> {
    // Search spans all statuses (you're looking for a specific ticket) but
    // stays inside the project scope (DRY-30).
    return this.listTickets({ text, projects, limit: 50 });
  }

  async getTicket(key: string, opts?: TicketDetailOptions): Promise<TicketDetail> {
    const t: SwitchyardTicket = await this.req(`/v1/tickets/${encodeURIComponent(key)}`);
    const base = toTicket(t);
    const detail: TicketDetail = {
      ...base,
      project: t.project?.key ?? "",
      labels: (t.labels ?? []).map((l) => l.name),
      description: t.description ?? "",
    };
    if (!opts?.thread) return detail;

    const { parent, epic } = await this.resolveAncestry(t);
    return {
      ...detail,
      // toTicket reads the inlined `parent`, which this endpoint leaves null —
      // so the resolved one replaces it (DRY-53). Falls back rather than
      // overwriting, so a walk that fails doesn't blank a parent the response
      // did carry, should this endpoint ever start hydrating one.
      parent: parent ?? base.parent,
      epic,
      // Comments ride along on this response already, so the thread costs no
      // extra request. Retracted ones are dropped here: the consumer is agent
      // context, and a deleted comment is precisely what not to brief from.
      ...toComments(t.comments),
    };
  }

  /**
   * Walk up to the immediate parent and the nearest epic (DRY-53).
   *
   * Costs one GET per rung because this endpoint hands back a bare UUID (see
   * SwitchyardTicket.parent_id) — there's no bulk resolve and no key in the
   * payload to shortcut with. Bounded at MAX_ANCESTOR_HOPS: the hierarchy is
   * epic → {task,bug,spike} → subtask, so two hops reaches an epic from the
   * bottom rung, and the bound also means a cycle in the data can't spin here.
   *
   * A ticket that is ITSELF an epic still gets its parent named — Jira's does,
   * because that provider reads the parent straight off the issue, and the two
   * disagreeing about whether an epic has a parent would be a difference in the
   * brief with no reason behind it. It just stops after that one rung: there is
   * no epic above an epic to go looking for.
   *
   * Failures are swallowed. This decorates a brief; a tracker hiccup resolving
   * an epic must not cost the description and comments we already hold — and on
   * the SessionStart path, throwing here would drop the agent's whole context
   * for the sake of one line of it.
   */
  private async resolveAncestry(
    t: SwitchyardTicket,
  ): Promise<{ parent?: Ticket["parent"]; epic?: TicketDetail["epic"] }> {
    let parent: Ticket["parent"];
    let epic: TicketDetail["epic"];
    const seekEpic = !isEpic(t.type);
    // One deadline for the whole climb, not per request — see
    // ANCESTRY_TIMEOUT_MS. The catch below turns a blown budget into a missing
    // line, which is the point.
    const signal = AbortSignal.timeout(ANCESTRY_TIMEOUT_MS);
    try {
      let cur = t;
      for (let hop = 0; hop < MAX_ANCESTOR_HOPS && cur.parent_id; hop++) {
        // Keys work here too, but a UUID is what we're given and the endpoint
        // accepts either.
        const up: SwitchyardTicket = await this.req(
          `/v1/tickets/${encodeURIComponent(cur.parent_id)}`,
          { signal },
        );
        if (!up?.key) break;
        if (hop === 0) parent = { key: up.key, title: up.title, type: up.type };
        if (!seekEpic) break;
        if (isEpic(up.type)) {
          epic = { key: up.key, title: up.title };
          break;
        }
        cur = up;
      }
    } catch {
      /* keep whatever rung we got to; the brief degrades a line at a time */
    }
    return { parent, epic };
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
