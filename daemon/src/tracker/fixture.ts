import { TrackerHttpError } from "./types.js";
import type {
  Project,
  Ticket,
  TicketCategory,
  TicketDetail,
  TicketDetailOptions,
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
  /** Oldest first, like both live providers hand them over (DRY-53). */
  comments?: { author: string; createdAt: string; body: string }[];
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
  // The only fixture with a thread (DRY-53), and it carries the case the whole
  // ticket is about: a description that has been overtaken by its comments, so
  // the zero-config default demonstrates why the activity section exists rather
  // than just proving it renders.
  { key: "ARGY-89", repo: "argosy", title: "Series auto-advance: auto-play the next episode", tag: "frontend", category: "in_progress", assignee: "Ashley", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" },
    comments: [
      { author: "Jordan", createdAt: "2026-03-02T15:04:00Z", body: "Design review: the 10s countdown should pause when the tab is hidden, otherwise it fires against a paused player and the next episode starts to nobody." },
      { author: "Ashley", createdAt: "2026-03-04T09:20:00Z", body: "Scope change agreed in standup: we are NOT shipping the per-series override this round — it needs the preference service from ARGY-91. Auto-advance is global-on for now, and the description's section on per-series toggles is stale." },
      { author: "Jordan", createdAt: "2026-03-05T11:47:00Z", body: "Player emits `ended` twice on Safari when the source swaps mid-buffer. Guard the handler or the countdown double-fires and skips an episode." },
    ] },
  { key: "ARGY-90", repo: "argosy", title: "Skip Intro / Skip Credits buttons (web player)", tag: "frontend", category: "backlog", assignee: "Ashley", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" } },
  { key: "ARGY-91", repo: "argosy", title: "Global auto-play preference (opt-in, default off)", tag: "backend", category: "backlog", parent: { key: "ARGY-64", title: "Phase 8 — Extra Credit (Stretch & Scale)" } },
  // Parented to an initiative that isn't in the set: Jira's third rung
  // (initiative → epic → task). Nesting deliberately stops at one level, so
  // this stays a top-level epic and merely wears a chip naming its parent —
  // the case that would otherwise drop the link with nothing to show for it.
  { key: "ARGY-64", repo: "argosy", title: "Phase 8 — Extra Credit (Stretch & Scale)", tag: "epic", category: "in_progress", type: "epic", assignee: "Jordan", parent: { key: "ARGY-1", title: "Argosy 2026 roadmap" } },
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
    // One ticket's children (DRY-83), before everything below — the same
    // ordering the live providers use, and for the same reasons: the epic
    // exemption is about pulling headings into a backlog-less list, and the
    // project scope can only wrongly hide a child of the epic that was asked
    // for by name.
    if (q.parent) {
      const kids = FIXTURES.filter((f) => f.parent?.key === q.parent);
      return kids
        .filter((f) =>
          q.open ? f.category !== "done" && (q.includeBacklog || f.category !== "backlog") : true,
        )
        .map(toTicket);
    }
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

  async getTicket(key: string, opts?: TicketDetailOptions): Promise<TicketDetail> {
    const f = FIXTURES.find((x) => x.key === key);
    // 404 so the health watch reads this as the tracker answering rather than
    // as an outage (DRY-48) — a stand-in tracker still has to be honest about
    // WHICH kind of no it is saying.
    if (!f) throw new TrackerHttpError(`unknown ticket ${key}`, 404);
    const detail: TicketDetail = {
      ...toTicket(f),
      project: f.repo,
      labels: [f.tag],
      description: `# ${f.key} — ${f.title}\n\n(Fixture ticket. Configure a live tracker via DRYDOCK_TRACKER to pull the real description.)`,
    };
    if (!opts?.thread) return detail;
    // Nearest epic (DRY-53), resolved out of the fixture set the way the live
    // providers resolve it out of the tracker. ARGY-89's epic is present and
    // resolves; DRY-3's parent DRY-1 has no fixture row, so its epic stays
    // unknown — the honest stand-in for a parent outside the pull, which keeps
    // the unresolved branch on the zero-config path too.
    //
    // Only the immediate parent is checked, where the live providers climb two
    // rungs. That's the whole ladder this set has: DRY-13 chose these rows for
    // the shapes the SIDEBAR must render and deliberately stops nesting at one
    // level, so there is no subtask→task→epic chain here to walk. A loop would
    // be generality with nothing to exercise it, and inventing a subtask row to
    // feed it would change fixture coverage that another ticket picked on
    // purpose.
    const parent = f.parent ? FIXTURES.find((x) => x.key === f.parent!.key) : undefined;
    return {
      ...detail,
      epic:
        f.type !== "epic" && parent?.type === "epic"
          ? { key: parent.key, title: parent.title }
          : undefined,
      comments: f.comments ?? [],
      commentCount: f.comments?.length ?? 0,
    };
  }
}
