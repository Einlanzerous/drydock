import { ChildStatsCache } from "./cache.js";
import { requestSignal, withDeadline } from "./deadline.js";
import { TrackerHttpError } from "./types.js";
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
  /**
   * Repo names with an explicit DRYDOCK_REPO_PATHS override (DRY-31), used to
   * pick among multiple components on one ticket. Injected (not read from
   * CONFIG) so the provider stays constructible in isolation.
   */
  repoOverrides?: string[];
  /**
   * Deadline on a single request, ms (DRY-72). Injected for the same reason as
   * `repoOverrides` above. Omitted = no deadline, which is what shipped before
   * and what the fixture-shaped callers want.
   */
  requestTimeoutMs?: number;
  /**
   * Deadline on a whole ticket pull, ms (DRY-61) — every request it makes,
   * together. The knob above bounds ONE request, and a pull is many: up to
   * twenty cursor pages for the list, then the `parent in (…)` child-stats walk,
   * which spans every status and can page twenty more. Against a tracker that
   * accepts and goes silent each dies at its own deadline and the next begins,
   * so nothing bounds the operation the route is holding a response open for.
   * Omitted = no operation deadline, which is what shipped before.
   */
  listTimeoutMs?: number;
  /**
   * Where epic child counts are remembered between pulls (DRY-72). Injected, and
   * shared with whatever other provider a host might construct, because it caches
   * a property of the TRACKER rather than of this class. Omitted = no caching.
   */
  childStats?: ChildStatsCache;
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
    components?: { name?: string }[];
    assignee?: { accountId?: string; name?: string; displayName?: string } | null;
    // `parent` covers BOTH rungs of Jira's hierarchy on Cloud and on DC 9+:
    // subtask→task and task→epic. It is not the legacy "Epic Link" custom
    // field (customfield_100xx), which older DC instances use instead and
    // which we deliberately don't chase — the field id varies per instance, so
    // it'd be one more host config knob. On such an instance epics simply
    // render flat, which is exactly today's behavior (DRY-13).
    parent?: { key?: string; fields?: { summary?: string; issuetype?: { name?: string } } } | null;
    // Present only when `comment` is in the fields= list (DRY-53). Jira returns
    // a PAGE here, not necessarily the thread: `total` is the real length, and
    // the page it hands back is the OLDEST comments — the opposite end from the
    // one worth briefing an agent with. See fetchComments.
    comment?: {
      comments?: JiraComment[];
      total?: number;
      startAt?: number;
      maxResults?: number;
    } | null;
  };
}

interface JiraComment {
  /** v2 keeps this a plain string; v3 would hand back an ADF document. */
  body?: string;
  author?: { displayName?: string; name?: string } | null;
  created?: string;
}

const FIELDS = "summary,status,issuetype,labels,assignee,project,components,parent";

// Rungs walked upward from a ticket looking for its epic (DRY-53). `parent` on
// an issue doesn't carry the parent's OWN parent, so a subtask costs one GET to
// see the epic above its task. Same bound as the Switchyard provider.
const MAX_ANCESTOR_HOPS = 2;

// Newest comments pulled when the issue GET returned a short page (DRY-53).
// The formatter windows this down further; it only has to be at least as large
// as anything that could survive that budget.
const COMMENT_TAIL = 20;

/**
 * Budget for the requests that DECORATE a brief — the comment tail and the walk
 * up to the epic (DRY-53).
 *
 * These are optional by construction: each one is already wrapped in a catch
 * that degrades a line rather than failing. Without a deadline, though, a slow
 * tracker turns them into a way to lose the whole brief — they're sequential
 * after the issue GET, and the hook that's waiting is a `curl -s -m 25` with no
 * retry. Better to hand over a brief missing its epic line than to hand over
 * nothing at 25 seconds.
 */
const EXTRAS_TIMEOUT_MS = 6_000;
const extrasDeadline = (): AbortSignal => AbortSignal.timeout(EXTRAS_TIMEOUT_MS);

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

/**
 * Is this issue type an epic? Jira's type names are per-instance strings, so
 * this is a name match and nothing better exists over the REST API — the same
 * assumption `issuetype = "Epic"` in buildJql makes, and it fails the same way
 * on a localized or renamed instance: no epic line rather than a wrong one.
 */
function isEpic(typeName?: string): boolean {
  return typeName?.toLowerCase() === "epic";
}

/** JQL string literal: backslashes and quotes escaped. */
function jqlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Component name → repo slug (DRY-31): lowercase, whitespace runs → single
 * dash. This is the rule DRYDOCK_REPO_PATHS keys must follow — "My Service"
 * becomes `my-service` — documented in .env.example.
 */
function componentSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export class JiraProvider implements TrackerProvider {
  readonly id = "jira";
  readonly name = "Jira";
  readonly capabilities = { comment: true, transition: true };

  private readonly baseUrl: string;
  private readonly auth: string;
  private readonly repoOverrides: Set<string>;
  private readonly requestTimeoutMs?: number;
  private readonly listTimeoutMs?: number;
  /** DRY-72. A disabled instance when the host injected none, so no `?.` below. */
  private readonly childStats: ChildStatsCache;
  /**
   * Epics whose child count has already been reported as uncountable, so the
   * warning below is one line per onset rather than one per sidebar poll
   * (DRY-72) — the "a notice is a condition, not an event" rule the shell's
   * notices follow. Tracked as a SET of keys rather than a boolean because a
   * boolean is only correct while one pull means one call to this method.
   */
  private readonly cappedWarned = new Set<string>();
  /** Resolved on first search: true = Cloud (`/search/jql`), false = DC (`/search`). */
  private cloudSearch: boolean | undefined;
  /**
   * Latched off the first time this instance rejects `issuetype = "Epic"`
   * (DRY-13), so the downgrade is paid once rather than on every sidebar
   * refresh. Same one-way-probe shape as `cloudSearch` above.
   */
  private epicClauseUsable = true;

  constructor(cfg: JiraConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.auth = cfg.email
      ? `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`
      : `Bearer ${cfg.token}`;
    this.repoOverrides = new Set(cfg.repoOverrides ?? []);
    this.requestTimeoutMs = cfg.requestTimeoutMs;
    this.listTimeoutMs = cfg.listTimeoutMs;
    this.childStats = cfg.childStats ?? new ChildStatsCache(0);
  }

  /**
   * Ticket → repo bucket (DRY-31). A corporate Jira project is a TEAM (SRE),
   * not a service — the component names the service/repo. Component slug wins;
   * project key (lowercased) is the fallback for component-less tickets, which
   * is also the pre-DRY-31 behavior. Multi-component tickets prefer a
   * component with a configured DRYDOCK_REPO_PATHS override — the one the host
   * demonstrably knows — else the first listed.
   */
  private repoOf(i: JiraIssue): string {
    const slugs = (i.fields.components ?? [])
      .map((c) => (c.name ? componentSlug(c.name) : undefined))
      .filter((s): s is string => !!s);
    const preferred = slugs.find((s) => this.repoOverrides.has(s));
    return preferred ?? slugs[0] ?? (i.fields.project?.key ?? i.key.split("-")[0]).toLowerCase();
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}/rest/api/2${path}`, {
      ...init,
      // Every request gets a deadline (DRY-72). Nothing propagates a client's
      // abort into here, so before this a page-walk begun for a browser that
      // gave up (at 12s, as it then was) ran on to completion — and the next
      // poll's fan-out piled on top of it. A caller carrying its own, tighter budget (extrasDeadline,
      // where a blown deadline costs one line of a brief rather than the brief)
      // keeps it: this is a backstop, not an override.
      //
      // Composed with whatever operation deadline is in scope (DRY-61), because
      // a per-request bound is not a bound on a pull: twenty pages of list plus
      // twenty of child stats is forty times this one. See deadline.ts for why
      // that budget is ambient rather than threaded through every signature.
      signal: requestSignal(init?.signal, this.requestTimeoutMs),
      headers: {
        Accept: "application/json",
        Authorization: this.auth,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      throw new TrackerHttpError(`jira ${path} -> ${res.status} ${await res.text()}`, res.status);
    }
    return res.status === 204 ? {} : res.json();
  }

  private toTicket(i: JiraIssue): Ticket {
    const f = i.fields;
    const category = mapCategory(f.status?.statusCategory?.key, f.status?.name);
    return {
      key: i.key,
      title: f.summary,
      status: { category, label: f.status?.name ?? category },
      // Component (or project-key fallback) is the grouping bucket; repos.ts
      // maps it to a real path (DRYDOCK_REPOS_ROOT / DRYDOCK_REPO_PATHS) like
      // any other repo name. See repoOf (DRY-31).
      repo: this.repoOf(i),
      type: f.issuetype?.name,
      parent: f.parent?.key
        ? {
            key: f.parent.key,
            title: f.parent.fields?.summary,
            type: f.parent.fields?.issuetype?.name,
          }
        : undefined,
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

  /**
   * Does the JQL for `q` actually carry the epic clause? The downgrade path
   * gates on this rather than re-deriving it, because the condition lives in
   * buildJql's shape below and the two drifting apart is the whole bug: a 400
   * from a query with no `issuetype` in it — a mistyped project chip on the
   * palette, say — would otherwise latch the downgrade off for the daemon's
   * lifetime, and epics would quietly go back to obeying the backlog rule long
   * after the typo was fixed.
   */
  private hasEpicClause(q: TicketQuery): boolean {
    return this.epicClauseUsable && !!q.open && !q.includeBacklog;
  }

  private buildJql(q: TicketQuery, epicsToo = this.epicClauseUsable): string {
    const clauses: string[] = [];
    if (q.project) clauses.push(`project = ${jqlQuote(q.project)}`);
    if (q.projects?.length) clauses.push(`project in (${q.projects.map(jqlQuote).join(", ")})`);
    // Children of one ticket (DRY-83). The same `parent` clause attachChildStats
    // uses, which is unsupported JQL on older DC — there it swallows, because it
    // decorates a sidebar that must still draw. Here it must NOT: this query IS
    // the expansion, so a 400 has to reach the route and be reported rather than
    // present as an epic that opens to nothing.
    if (q.parent) clauses.push(`parent = ${jqlQuote(q.parent)}`);
    if (q.open) {
      // Backlog-excluded is the default (DRY-30): only the "In Progress"
      // statusCategory (key `indeterminate` — the middle bucket every workflow
      // has). `!= Done` would also pull the "To Do" category, which on a
      // corporate Jira is the mountain of backlog this scoping exists to
      // avoid. Trade-off: statuses that *name-map* to planning/blocked but sit
      // in "To Do" are hidden too — that's what the includeBacklog toggle is for.
      // Epics ride along regardless (DRY-13). The backlog exclusion exists
      // because a corporate Jira's "To Do" bucket is enormous; the epics inside
      // it are not — there are orders of magnitude fewer, and one is the header
      // its in-flight children hang under. Without this the sidebar's usual
      // state is a child whose epic is missing. JQL expresses it in the same
      // request, so this costs nothing.
      //
      // `epicsToo=false` is the downgrade listTickets falls back to: JQL
      // validates issuetype VALUES against the instance, so `issuetype = "Epic"`
      // is a hard 400 wherever no type is named that — a localized Jira, a
      // renamed type, a scope with none visible. This is the only new query in
      // DRY-13 that sits in the sidebar's critical path, so unlike the child
      // stats it can't just be swallowed: failing it means an empty sidebar.
      clauses.push(
        q.includeBacklog
          ? `statusCategory != Done`
          : epicsToo
            ? `(statusCategory = "In Progress" OR (issuetype = ${jqlQuote("Epic")} AND statusCategory != Done))`
            : `statusCategory = "In Progress"`,
      );
    }
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
    fields: string = FIELDS,
  ): Promise<{ issues: JiraIssue[]; next?: string }> {
    if (this.cloudSearch !== false) {
      const params = new URLSearchParams({ jql, maxResults: String(limit), fields });
      if (next) params.set("nextPageToken", next);
      try {
        const body = await this.req(`/search/jql?${params}`);
        this.cloudSearch = true;
        const issues: JiraIssue[] = body.issues ?? [];
        // An empty page ends the walk even if a token came with it. The DC branch
        // below has always had this guard via its `issues.length &&`; the Cloud
        // branch trusted the token, so a deployment that hands back an empty page
        // AND a token spins forever — `out.length` never grows, so neither the
        // MAX_TICKETS backstop nor the paging condition can stop it. That was
        // survivable while each poll merely leaked its own runaway loop; with a
        // cache in front it also wedges the entry, because a flight that never
        // settles is a `refreshing` handle that is never cleared and an entry
        // `evictIdle` will never reclaim.
        return { issues, next: issues.length ? (body.nextPageToken ?? undefined) : undefined };
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
      fields,
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

  /**
   * The sidebar's pull, under one deadline for the whole thing (DRY-61).
   *
   * Wrapped HERE rather than at the route, so a refresh the cache runs behind a
   * response is bounded too — that one has nobody waiting on it, which is what
   * makes it the pull that piles up. `withDeadline` is a passthrough when one is
   * already running, so `searchTickets` delegating into this doesn't mint a
   * second budget.
   */
  async listTickets(q: TicketQuery): Promise<Ticket[]> {
    return withDeadline(this.listTimeoutMs, "jira ticket list", () => this.pull(q));
  }

  private async pull(q: TicketQuery): Promise<Ticket[]> {
    // Same contract as the Switchyard provider: no limit (the sidebar) means
    // "everything matching", paginated to the MAX_TICKETS backstop; an explicit
    // limit (the palette) is a single page.
    const paginate = q.limit === undefined;
    const pageSize = Math.min(q.limit ?? PAGE_SIZE, PAGE_SIZE);
    const out: Ticket[] = [];
    let next: string | undefined;
    let jql = this.buildJql(q);
    let first = true;
    do {
      let page;
      try {
        page = await this.searchPage(jql, pageSize, next);
      } catch (e) {
        // Retry once, without the epic clause, if the instance rejected it on
        // the FIRST page — mid-pagination the cursor belongs to the old query,
        // and a 400 there is a different problem. See buildJql: this keeps a
        // sidebar that used to work from going blank on an instance with no
        // issue type literally named "Epic".
        // Only downgrade when the epic clause is what could have been rejected.
        // Retrying a query that never contained it re-issues a byte-identical
        // request, so it throws anyway — having silently disabled epics.
        if (!first || !this.hasEpicClause(q) || !/-> 400/.test(String(e))) throw e;
        this.epicClauseUsable = false;
        console.warn(
          `[drydock] jira rejected the epic clause; epics will follow the backlog rule: ${e}`,
        );
        jql = this.buildJql(q, false);
        page = await this.searchPage(jql, pageSize, next);
      }
      first = false;
      out.push(...page.issues.map((i) => this.toTicket(i)));
      next = page.next;
    } while (paginate && next && out.length < MAX_TICKETS);
    // Not on a parent query (DRY-83). Those results are one epic's children, and
    // nothing renders a rollup for a child row — but `parent` also matches a
    // task's subtasks, and a Jira whose hierarchy nests epics would find one in
    // there and pay a second `parent in (…)` search per expansion for a bar
    // nobody draws. The Switchyard provider gets this for free: `listChildren`
    // returns before the child-stats pass.
    if (q.open && !q.parent) await this.attachChildStats(out);
    return out;
  }

  /**
   * Fill in each epic's child breakdown (DRY-13). JQL takes `parent in (…)`, so
   * every epic on screen is answered by ONE extra search no matter how many
   * there are — and `fields=parent,status` keeps the response to the two things
   * being counted.
   *
   * Failures are swallowed deliberately: this decorates a sidebar that must
   * still draw, and the shell falls back to counting the children it loaded.
   * That matters more here than on Switchyard — `parent` is unsupported JQL on
   * an older DC instance, where this throws every time and must stay harmless.
   */
  private async attachChildStats(out: Ticket[]): Promise<void> {
    const epics = new Map(out.filter((t) => isEpic(t.type)).map((t) => [t.key, t]));
    if (!epics.size) return;
    // Is there anything left to learn? Then the expensive half of a sidebar pull
    // doesn't happen at all (DRY-72) — and this is the half that scales with
    // years of closed work rather than with what's on screen. All-or-nothing
    // because one query answers every epic here, so a partial hit saves nothing.
    //
    // "Known uncountable" counts as settled, or the branch below would re-run a
    // full twenty-page walk on every refresh purely to abandon it again.
    const known = [...epics.keys()].map((k) => [k, this.childStats.peek(k)] as const);
    if (known.every(([, v]) => v !== undefined)) {
      for (const [key, v] of known) {
        if (v && v !== "capped") epics.get(key)!.childStats = v;
      }
      return;
    }
    try {
      const jql = `parent in (${[...epics.keys()].map(jqlQuote).join(", ")})`;
      const kids: JiraIssue[] = [];
      let next: string | undefined;
      do {
        const page = await this.searchPage(jql, PAGE_SIZE, next, "parent,status");
        kids.push(...page.issues);
        next = page.next;
      } while (next && kids.length < MAX_TICKETS);
      // Hitting the cap must ABANDON the stats, not truncate them. This query
      // spans every status — years of closed work — so 20 epics of 100 children
      // reaches 2000 on an ordinary corporate Jira. Keeping partial counts
      // would mark them authoritative and render "13/40 done" when the truth is
      // 13/78: precisely the false ratio this whole design refuses to show.
      // Returning early leaves childStats unset, and the shell falls back to
      // counting loaded children without a ratio. Narrowing
      // DRYDOCK_TRACKER_PROJECTS is the lever that brings the real numbers back.
      //
      // Which nobody could know to pull, because until DRY-72 this branch was
      // silent: the most expensive poll the daemon can make — twenty sequential
      // pages — fetched and discarded on every refresh, presenting only as a
      // slow sidebar with no progress bars. Latched so it's one line per onset.
      if (next) {
        // Remembered as capped, so the walk isn't repeated every 20s just to be
        // thrown away again. It expires with the TTL, so an epic that gets
        // archived back under the cap starts counting on its own.
        for (const key of epics.keys()) this.childStats.putCapped(key);
        const fresh = [...epics.keys()].filter((k) => !this.cappedWarned.has(k));
        if (fresh.length) {
          for (const k of fresh) this.cappedWarned.add(k);
          console.warn(
            `[drydock] jira: counting children of ${epics.size} epics exceeded ${MAX_TICKETS} issues, ` +
              `so epic progress bars will count only loaded children. That query spans every status — ` +
              `narrow DRYDOCK_TRACKER_PROJECTS to bring the real numbers back.`,
          );
        }
        return;
      }
      for (const key of epics.keys()) this.cappedWarned.delete(key);
      for (const k of kids) {
        const epic = k.fields.parent?.key ? epics.get(k.fields.parent.key) : undefined;
        if (!epic) continue;
        const stats = (epic.childStats ??= { total: 0, byCategory: {} });
        const c = mapCategory(k.fields.status?.statusCategory?.key, k.fields.status?.name);
        stats.total++;
        stats.byCategory[c] = (stats.byCategory[c] ?? 0) + 1;
      }
      // An epic with no children still gets a definitive zero rather than the
      // "we didn't ask" absence the shell treats as unknown.
      for (const e of epics.values()) e.childStats ??= { total: 0, byCategory: {} };
      // Publish for the next pull (DRY-72). Storing the object by reference is
      // safe because nothing mutates one after this point: a later pull that
      // MISSES builds its counts on freshly-mapped tickets (`??=` on a new
      // Ticket), and one that HITS only ever reads.
      for (const [key, e] of epics) this.childStats.put(key, e.childStats!);
    } catch {
      /* leave childStats unset; the shell degrades to loaded children */
    }
  }

  /**
   * The Ctrl+K palette's search, under its own deadline (DRY-61).
   *
   * Wrapped rather than left to inherit `listTickets`' deadline, even though it
   * delegates straight into it: `withDeadline` nests as a passthrough, so the OUTER label
   * is the one a blown budget reports — and this route is uncached, so unlike
   * the sidebar's pull there is no last-good list to fall back on and the
   * message goes straight to the palette. "jira ticket list exceeded its
   * 10000ms deadline" would name an operation the user never asked for. Same
   * budget, because it is the same tracker doing the same kind of work.
   */
  async searchTickets(text: string, projects?: string[]): Promise<Ticket[]> {
    return withDeadline(this.listTimeoutMs, "jira ticket search", () =>
      this.searchWithin(text, projects),
    );
  }

  private async searchWithin(text: string, projects?: string[]): Promise<Ticket[]> {
    // Search spans all statuses (incl. backlog/done) — you're looking for a
    // specific ticket — but stays inside the project scope (DRY-30).
    return this.listTickets({ text, projects, limit: 50 });
  }

  async getTicket(key: string, opts?: TicketDetailOptions): Promise<TicketDetail> {
    // `comment` rides along in the same request (DRY-53) — a field, not a
    // separate endpoint, so the thread costs nothing extra when it's wanted and
    // isn't asked for when it isn't.
    const fields = opts?.thread ? `${FIELDS},description,comment` : `${FIELDS},description`;
    const i: JiraIssue = await this.req(`/issue/${encodeURIComponent(key)}?fields=${fields}`);
    const detail: TicketDetail = {
      ...this.toTicket(i),
      project: i.fields.project?.key ?? "",
      labels: i.fields.labels ?? [],
      // v2 keeps this a plain string (wiki markup at worst) — fine as agent
      // context, and no ADF parsing.
      description: i.fields.description ?? "",
    };
    if (!opts?.thread) return detail;
    const [comments, epic] = await Promise.all([this.fetchComments(key, i), this.resolveEpic(i)]);
    return { ...detail, epic, ...comments };
  }

  /**
   * The comment thread, oldest first, ending at the NEWEST comment (DRY-53).
   *
   * That last part is the whole difficulty. Jira's `comment` field is paginated
   * and ordered oldest-first, and deployments disagree about how much of it a
   * `fields=comment` GET returns — so on a long thread the issue payload can
   * hand back the twenty oldest comments, which is precisely the window that
   * misleads: an agent briefed from the start of a thread it can't see the end
   * of is worse off than one briefed from none of it.
   *
   * `total` tells us when that happened, and a second request with
   * `startAt = total - COMMENT_TAIL` fetches the tail directly. Deliberately
   * not `orderBy=-created`, which Jira Cloud supports and older DC does not —
   * paging from the end works everywhere and needs no probe.
   *
   * `commentCount` stays the real `total` even when only the tail is kept: the
   * formatter's job is to say "the 5 most recent of 63", and it can only say
   * that if the 63 survives to it.
   *
   * Failures are swallowed. A thread we couldn't fetch must not cost the
   * description we already have.
   */
  private async fetchComments(
    key: string,
    i: JiraIssue,
  ): Promise<{ comments?: TicketComment[]; commentCount?: number }> {
    const page = i.fields.comment;
    if (!page) return {};
    let raw = page.comments ?? [];
    const total = typeof page.total === "number" ? page.total : raw.length;
    const seen = (page.startAt ?? 0) + raw.length;
    if (seen < total) {
      try {
        const startAt = Math.max(0, total - COMMENT_TAIL);
        const body = await this.req(
          `/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${COMMENT_TAIL}`,
          { signal: extrasDeadline() },
        );
        // An EMPTY tail is not an answer — `total` and the page can disagree
        // when comments are deleted between the two requests, and `?? raw`
        // would take `[]` as success and discard the page already in hand,
        // leaving a ticket that reports 63 comments and shows none.
        const tail: JiraComment[] = body?.comments ?? [];
        if (tail.length) raw = tail;
      } catch {
        /* keep the page we have; the formatter still says how many exist */
      }
    }
    const comments = raw
      .filter((c) => typeof c.body === "string" && c.body.trim())
      .map((c) => ({
        author: c.author?.displayName ?? c.author?.name,
        createdAt: c.created,
        body: c.body!.trim(),
      }));
    return { comments, commentCount: Math.max(total, comments.length) };
  }

  /**
   * Nearest ancestor of type epic (DRY-53). `parent` on the issue is the
   * immediate one, which for a subtask is its task — so reaching the epic costs
   * one GET per rung up, bounded by MAX_ANCESTOR_HOPS.
   *
   * Swallowed on failure, like the child stats: this decorates a brief, and on
   * an instance using the legacy Epic Link custom field there is simply no epic
   * to find (see JiraIssue.parent).
   */
  private async resolveEpic(i: JiraIssue): Promise<TicketDetail["epic"]> {
    if (isEpic(i.fields.issuetype?.name)) return undefined;
    // One deadline for the whole climb, not per request: two rungs against a
    // struggling Jira is exactly the case worth bounding.
    const signal = extrasDeadline();
    try {
      let cur = i;
      for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
        const p = cur.fields.parent;
        if (!p?.key) return undefined;
        if (isEpic(p.fields?.issuetype?.name)) {
          return { key: p.key, title: p.fields?.summary };
        }
        // Nothing above this rung would be read, so don't pay for it.
        if (hop + 1 >= MAX_ANCESTOR_HOPS) return undefined;
        // The parent's own parent isn't in what we hold — fetch just enough of
        // it to keep climbing. One request covers the whole next rung: an
        // issue's `parent` field inlines that parent's summary and issuetype,
        // so the grandparent can be judged without fetching IT too.
        cur = await this.req(`/issue/${encodeURIComponent(p.key)}?fields=summary,issuetype,parent`, {
          signal,
        });
      }
    } catch {
      /* no epic line; the rest of the brief is unaffected */
    }
    return undefined;
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
