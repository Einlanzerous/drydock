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
}

// Ported verbatim from Drydock.dc.html's fixture, normalized onto our shape.
const FIXTURES: Fixture[] = [
  { key: "ARGY-89", repo: "argosy", title: "Series auto-advance: auto-play the next episode", tag: "frontend", category: "in_progress", assignee: "Ashley" },
  { key: "ARGY-90", repo: "argosy", title: "Skip Intro / Skip Credits buttons (web player)", tag: "frontend", category: "backlog", assignee: "Ashley" },
  { key: "ARGY-91", repo: "argosy", title: "Global auto-play preference (opt-in, default off)", tag: "backend", category: "backlog" },
  { key: "ARGY-64", repo: "argosy", title: "Phase 8 — Extra Credit (Stretch & Scale)", tag: "epic", category: "in_progress", type: "epic", assignee: "Jordan" },
  { key: "SWY-12", repo: "switchyard", title: "Saved filters in the board view", tag: "frontend", category: "review", assignee: "Jordan" },
  { key: "SWY-7", repo: "switchyard", title: "Webhook retries with exponential backoff", tag: "backend", category: "backlog" },
  { key: "DRY-3", repo: "drydock", title: "Tile layout snapping + window persistence", tag: "frontend", category: "in_progress", assignee: "Ashley" },
  { key: "DRY-5", repo: "drydock", title: "Session persistence across server reconnect", tag: "infra", category: "backlog" },
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

  async listTickets(q: TicketQuery): Promise<Ticket[]> {
    let out = FIXTURES.filter((f) => (q.open ? f.category !== "done" : true));
    if (q.project) out = out.filter((f) => f.repo === q.project || f.key.startsWith(q.project!));
    if (q.text) {
      const t = q.text.toLowerCase();
      out = out.filter((f) => f.key.toLowerCase().includes(t) || f.title.toLowerCase().includes(t));
    }
    return out.map(toTicket);
  }

  async searchTickets(text: string): Promise<Ticket[]> {
    const t = text.trim().toLowerCase();
    if (!t) return FIXTURES.map(toTicket);
    return FIXTURES.filter(
      (f) =>
        f.key.toLowerCase().includes(t) ||
        f.title.toLowerCase().includes(t) ||
        f.repo.includes(t),
    ).map(toTicket);
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
