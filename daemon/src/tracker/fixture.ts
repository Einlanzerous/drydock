import type {
  Project,
  Ticket,
  TicketCategory,
  TicketDetail,
  TicketQuery,
  TrackerProvider,
} from "./types.js";

/**
 * Zero-config provider backed by the design prototype's fixture set. This is
 * the default so the shell is fully functional out of the box (the "mock data
 * first" path of DRY-9) — no Switchyard/Jira credentials required. Swap to a
 * live provider via DRYDOCK_TRACKER once the host is configured.
 */
interface Fixture {
  key: string;
  repo: string;
  title: string;
  tag: string;
  category: TicketCategory;
  type?: string;
  assignee?: string;
  parent?: { key: string; title?: string };
}

// Ported verbatim from Drydock.dc.html's fixture, normalized onto our shape.
//
// The parent links (DRY-13) cover all three shapes the sidebar has to render,
// so the zero-config default exercises the rollup rather than just the flat
// case: ARGY-64 is an epic that IS in the set, DRY-1 is an epic that is NOT
// (no fixture row — the sidebar heads that group off the child's `parent`
// alone, the way a real backlog-bucket epic behaves under the default pull),
// and the SWY tickets hang off nothing at all.
const FIXTURES: Fixture[] = [
  { key: "ARGY-89", repo: "argosy", title: "Series auto-advance: auto-play the next episode", tag: "frontend", category: "in_progress", assignee: "Ashley", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" } },
  { key: "ARGY-90", repo: "argosy", title: "Skip Intro / Skip Credits buttons (web player)", tag: "frontend", category: "backlog", assignee: "Ashley", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" } },
  { key: "ARGY-91", repo: "argosy", title: "Global auto-play preference (opt-in, default off)", tag: "backend", category: "backlog", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" } },
  { key: "ARGY-64", repo: "argosy", title: "Phase 8 — Extra Credit (Stretch & Scale)", tag: "epic", category: "in_progress", type: "epic", assignee: "Jordan" },
  { key: "SWY-12", repo: "switchyard", title: "Saved filters in the board view", tag: "frontend", category: "review", assignee: "Jordan" },
  { key: "SWY-7", repo: "switchyard", title: "Webhook retries with exponential backoff", tag: "backend", category: "backlog" },
  { key: "DRY-3", repo: "drydock", title: "Tile layout snapping + window persistence", tag: "frontend", category: "in_progress", assignee: "Ashley", parent: { key: "DRY-1", title: "AI Agent Orchestrator — web terminal multiplexer for AI CLIs" } },
  { key: "DRY-5", repo: "drydock", title: "Session persistence across server reconnect", tag: "infra", category: "backlog", parent: { key: "DRY-1", title: "AI Agent Orchestrator — web terminal multiplexer for AI CLIs" } },
];

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  backlog: "Backlog",
  planning: "Planning",
  in_progress: "In Progress",
  review: "In Review",
  blocked: "Blocked",
  done: "Done",
};

function toTicket(f: Fixture): Ticket {
  return {
    key: f.key,
    title: f.title,
    status: { category: f.category, label: CATEGORY_LABEL[f.category] },
    repo: f.repo,
    type: f.type ?? "task",
    parent: f.parent,
    tag: f.tag,
    assignee: f.assignee ? { name: f.assignee } : undefined,
  };
}

export class FixtureProvider implements TrackerProvider {
  readonly id = "fixture";
  readonly name = "Switchyard"; // sidebar reads as the prototype until live wiring
  readonly capabilities = { comment: false, transition: false };

  async listProjects(): Promise<Project[]> {
    const repos = [...new Set(FIXTURES.map((f) => f.repo))];
    return repos.map((r) => ({ key: r.toUpperCase(), name: r, repo: r }));
  }

  // A fixture "project" matches by repo name or key prefix, so both `ARGY`
  // and `argosy` scope correctly (live trackers use real project keys).
  private inProject(f: Fixture, p: string): boolean {
    return f.repo === p.toLowerCase() || f.key.startsWith(p.toUpperCase());
  }

  async listTickets(q: TicketQuery): Promise<Ticket[]> {
    // Epics are exempt from the backlog exclusion (DRY-13) — see the same rule
    // in the Switchyard and Jira providers.
    let out = FIXTURES.filter((f) =>
      q.open
        ? f.category !== "done" &&
          (q.includeBacklog || f.category !== "backlog" || f.type === "epic")
        : true,
    );
    if (q.project) out = out.filter((f) => this.inProject(f, q.project!));
    if (q.projects?.length) out = out.filter((f) => q.projects!.some((p) => this.inProject(f, p)));
    if (q.text) {
      const t = q.text.toLowerCase();
      out = out.filter((f) => f.key.toLowerCase().includes(t) || f.title.toLowerCase().includes(t));
    }
    // Child breakdown per epic (DRY-13), counted over the whole fixture set —
    // the in-memory stand-in for the extra tracker query the live providers make.
    return out.map((f) => {
      const t = toTicket(f);
      if (f.type !== "epic") return t;
      const byCategory: Partial<Record<TicketCategory, number>> = {};
      let total = 0;
      for (const k of FIXTURES) {
        if (k.parent?.key !== f.key) continue;
        byCategory[k.category] = (byCategory[k.category] ?? 0) + 1;
        total++;
      }
      return { ...t, childStats: { total, byCategory } };
    });
  }

  async searchTickets(text: string, projects?: string[]): Promise<Ticket[]> {
    const t = text.trim().toLowerCase();
    const pool = projects?.length
      ? FIXTURES.filter((f) => projects.some((p) => this.inProject(f, p)))
      : FIXTURES;
    if (!t) return pool.map(toTicket);
    return pool
      .filter(
        (f) =>
          f.key.toLowerCase().includes(t) ||
          f.title.toLowerCase().includes(t) ||
          f.repo.includes(t),
      )
      .map(toTicket);
  }

  async getTicket(key: string): Promise<TicketDetail> {
    const f = FIXTURES.find((x) => x.key === key);
    if (!f) throw new Error(`unknown ticket ${key}`);
    return {
      ...toTicket(f),
      project: f.repo,
      labels: [f.tag],
      description: `# ${f.key} — ${f.title}\n\n(Fixture ticket. Configure a live tracker via DRYDOCK_TRACKER to pull the real description.)`,
    };
  }
}
