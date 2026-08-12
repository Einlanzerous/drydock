<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  CATEGORY_COLOR,
  epicNodeId,
  epicRollup,
  groupTickets,
  listEpicChildren,
  tagColor,
  TICKET_POLL_MS,
  type EpicNode,
  type RepoGroup,
  type Rollup,
  type Ticket,
} from "../lib/tracker.js";

// Left sidebar: live tickets from the active tracker, grouped by repo. At PoC
// fixture scale a flat list was fine; against a live tracker it pulls 100+
// tickets across every project, so this adds the usability layer (DRY-11):
// a search box, project/status/assignee filters, and collapsible groups
// (collapsed by default, with counts). All filtering is client-side over the
// already-loaded set. Each row still spawns an agent scoped to that ticket.
//
// The scope row (DRY-30) is different in kind from the filters: it controls
// what the daemon PULLS from the tracker, not what's shown of the loaded set.
// Host-default project chips are fixed (env config); user-added ones are
// removable; "backlog" opts the backlog bucket into the pull (off by default).
// The parent owns the state, refetches on change, and persists it.
//
// Inside a repo group, tickets nest under their epic (DRY-13) — a second level
// of the same collapse idiom, with a status rollup on the epic row so a
// collapsed epic still says something. Providers pull epics whatever the
// backlog toggle says, so the epic heading a group is normally a real ticket;
// one named only by a child (out-of-scope project) still heads it, marked.
const props = defineProps<{
  /**
   * Provider label. Typed `string`, defaulted upstream, and still rendered
   * through a fallback: this is the header that took the whole desk down in
   * DRY-51 — a throw here happens mid-patch, so Vue stops re-rendering
   * everything, not just the sidebar. The client that fed it `undefined` is
   * fixed; the belt stays because of what a repeat costs.
   */
  name: string;
  tickets: Ticket[];
  /**
   * A refresh the USER asked for is in flight — the header button or the
   * outage panel's Retry (DRY-85).
   *
   * Deliberately not "a pull is in flight". This drives a spinner and two
   * disables, and every one of those is a claim that somebody is waiting; the
   * 20s background poll is not that. It used to be, so the header spun and the
   * scope controls dimmed on a cadence, and since DRY-72 answers the poll from
   * the daemon's cache it read as a blink rather than as a wait.
   */
  refreshing?: boolean;
  /**
   * A pull the user's own SCOPE change started is in flight (DRY-85).
   *
   * Separate from `refreshing` because it guards a different thing: re-toggling
   * scope mid-flight desyncs the control from the list, and `loadTickets`'
   * epoch guard protects the list, not the control. A forced refresh doesn't
   * change scope, so it has no business locking this — and a poll least of all.
   */
  scopeBusy?: boolean;
  /**
   * Why the last pull failed, or null while they're working (DRY-55). Read
   * together with `tickets`, because the two combinations are different
   * statements and only one of them replaces the empty state:
   *
   *   set + no tickets   nothing was fetched. "No tickets match." would be a
   *                      lie, and the plausible one — scope chips make an empty
   *                      sidebar look like a filter you got wrong.
   *   set + tickets      what's on screen is real, just no longer current. It
   *                      still renders; the header says it may be stale.
   *   null               today's behaviour.
   */
  pullError?: string | null;
  /**
   * Has `name` been confirmed by /api/tracker/info, as opposed to being the
   * optimistic default? (DRY-55) The header can live with a guess; an error
   * can't — naming the wrong tracker in it is worse than naming none.
   */
  nameConfirmed?: boolean;
  /** Host-default project scope from /api/tracker/info (fixed chips). */
  scopeProjects: string[];
  /** Browser-added project keys (removable chips). */
  userProjects: string[];
  showBacklog: boolean;
}>();
const emit = defineEmits<{
  (e: "launch", t: Ticket): void;
  (e: "refresh"): void;
  (e: "add-project", key: string): void;
  (e: "remove-project", key: string): void;
  (e: "toggle-backlog", show: boolean): void;
}>();

/**
 * Who to blame in the outage copy. Only ever a real provider name — see the
 * `nameConfirmed` prop.
 */
const outageSubject = computed(() =>
  props.nameConfirmed && props.name ? props.name : "the tracker",
);

/**
 * The pull error, trimmed to something a 266px rail can hold (DRY-55).
 *
 * `notices.ts` caps its own detail at 140 for this exact reason, and the input
 * here is worse than a notice's: both providers build their error as
 * `${res.status} ${await res.text()}` — the tracker's ENTIRE response body — and
 * the daemon then wraps that in `tracker: …` before the shell prefixes
 * `daemon returned 502: `. A Jira behind a proxy that answers 502 with an HTML
 * error page therefore hands this component several KB of markup to render in a
 * sidebar, which is not an error message, it's a wall. Longer than the notice's
 * cap because this one has vertical room and is the primary explanation rather
 * than a second line; the console and the network tab keep the whole thing.
 */
const WHY_MAX = 300;
/**
 * One error, flattened and capped. Extracted from `whyShort` because the epic
 * rows' notes (DRY-83) put a provider error in a `title` too, and it is the same
 * input this cap was written for — a Jira behind a proxy answering 502 with an
 * HTML page. A tooltip doesn't wrap the sidebar the way the outage block would,
 * but several KB of markup in one is no more readable, and the browser renders
 * every byte of it.
 */
function short(e?: string | null): string {
  const one = (e ?? "").replace(/\s+/g, " ").trim();
  return one.length > WHY_MAX ? `${one.slice(0, WHY_MAX - 1)}…` : one;
}
const whyShort = computed(() => short(props.pullError));

const newProject = ref("");
function addProject(): void {
  // Tracker project keys are uppercase by convention (Jira enforces it).
  const key = newProject.value.trim().toUpperCase();
  newProject.value = "";
  if (key) emit("add-project", key);
}

// Sentinel for the assignee filter: the leading space cannot collide with a
// real assignee name. (Was a stray NUL byte, which made git treat this whole
// file as binary — no diffs, no grep.)
const UNASSIGNED = " unassigned";

const search = ref("");
const fProject = ref("");
const fStatus = ref("");
const fAssignee = ref("");
const fEpic = ref("");
// Per-group expand state; absent = collapsed (the default). When a search/filter
// is active we force-open all groups so matches aren't hidden behind a chevron.
// Epics get their own map on the same rule, keyed `${repo} ${epicKey}` — the
// same epic can head a group in two repos when its children span components.
const expanded = reactive<Record<string, boolean>>({});
const epicExpanded = reactive<Record<string, boolean>>({});

/**
 * How many rows currently have this epic open, by epic KEY.
 *
 * `epicExpanded` above is keyed by node id (repo + key), because the same epic
 * can head a group in two repos. Everything to do with the FETCH is keyed by the
 * bare key instead — one epic has one set of children however many rows head it
 * — and the two cannot be derived from each other without splitting the
 * composite id, which is the drift `epicNodeId` exists to warn about. Counted
 * rather than a boolean so collapsing one of two rows doesn't take the other's
 * children with it.
 */
const epicOpenCount = reactive<Record<string, number>>({});

/**
 * An epic's children, fetched on demand when its row is expanded (DRY-83).
 */
interface ChildLoad {
  /** Absent until a fetch succeeds. */
  rows?: Ticket[];
  loading: boolean;
  error?: string;
  /** When `rows` landed, for the age check in `loadChildren`. */
  at?: number;
  /**
   * The daemon served these from a cache it could not refresh (DRY-72).
   *
   * Carried for the same reason `listTickets` carries it: under
   * stale-while-revalidate a tracker outage reaches the browser as a cheerful
   * 200, so a fetch that "succeeded" says nothing about whether the rows are
   * current. Without this an expansion during an outage — and a Refresh during
   * one — is indistinguishable from a healthy pull.
   */
  stale?: string;
}
const childLoads = reactive<Record<string, ChildLoad>>({});
/**
 * Per-key request epoch, the same guard `loadTickets` uses in App.vue.
 *
 * A forced pull may now be issued while an ordinary one is still in flight (see
 * `loadChildren`), so two can genuinely overlap and only the newest may commit.
 */
const childEpoch: Record<string, number> = {};

/**
 * Fetch an epic's children.
 *
 * Called from `toggleEpic` — an explicit expand — and deliberately NOT from
 * `isEpicOpen` or anywhere in the render path. A filter force-opens every epic
 * on the desk, so driving this off "is it open" would fire one request per epic
 * on every keystroke in the search box: DRY-72's per-poll fan-out, back one
 * gesture at a time.
 *
 * When it declines to run, and why each case is separate:
 *
 *   in flight        joined, EXCEPT by a force. A force that returned here would
 *                    take the answer of a flight that may have queried the
 *                    tracker before the user pressed Refresh — DRY-72 trap 3
 *                    inverted, and the cache below the daemon can't fix it
 *                    because the request never leaves.
 *   already loaded   kept, until it ages past the interval the list itself
 *                    refreshes on. Re-pulling on every poll would put the
 *                    fan-out back; never re-pulling means a collapse and
 *                    re-expand can show rows from an hour ago with nothing
 *                    saying so, which is the thing DRY-55 is about.
 *   after a failure  never declined, or the error note's retry is a dead
 *                    control — the rows kept from before the failure would
 *                    satisfy the "already loaded" test forever.
 */
function loadChildren(key: string, force = false): void {
  const cur = childLoads[key];
  if (cur?.loading && !force) return;
  if (cur?.rows && !cur.error && !force && Date.now() - (cur.at ?? 0) < TICKET_POLL_MS) return;

  const epoch = (childEpoch[key] = (childEpoch[key] ?? 0) + 1);
  // The rows already on screen are KEPT while a re-pull is in flight, and that
  // isn't cosmetic: a forced fetch waits on the daemon, and with no fetched rows
  // the fallback is what the pull loaded — which for the epic this feature
  // exists for is EMPTY. Dropping them first therefore blanks an expanded epic
  // for a round trip and fills it again, i.e. replaces a working list with
  // nothing while nothing is wrong (DRY-55's rule, one level down).
  const keep = cur?.rows ? { rows: cur.rows, at: cur.at } : {};
  childLoads[key] = { loading: true, ...keep };
  listEpicChildren(key, force)
    .then((pull) => {
      if (epoch !== childEpoch[key]) return;
      childLoads[key] = {
        loading: false,
        rows: pull.tickets,
        at: Date.now(),
        ...(pull.stale ? { stale: pull.stale.error } : {}),
      };
    })
    .catch((e: unknown) => {
      if (epoch !== childEpoch[key]) return;
      // Same rule on the failure path: a re-pull that fails keeps what it had.
      childLoads[key] = { loading: false, error: String(e), ...keep };
    });
}

/**
 * Epics open right now, by key — what Refresh has to re-pull.
 *
 * Reads `epicOpenCount`, which `toggleEpic` maintains, rather than deriving the
 * set from `groups`: the augmented list below is built from this, and `groups`
 * is built from that, so reading `groups` here would close the loop.
 */
const openEpicKeys = computed(() =>
  Object.keys(epicOpenCount).filter((k) => epicOpenCount[k]! > 0),
);

/**
 * Refresh means "I have stopped trusting what is on screen", so it has to reach
 * the expanded epics too (DRY-83). Left out, the one button somebody presses for
 * that would freshen every row on the desk EXCEPT the ones they opened on
 * purpose — and those are the rows an agent gets spawned from, which is where
 * DRY-55's "spawn against a ticket that closed an hour ago" actually bites.
 *
 * Only what is open right now. Re-pulling every epic ever expanded would make
 * one click cost a request per epic visited this session, most of them collapsed
 * and unread.
 */
function onRefresh(): void {
  for (const key of openEpicKeys.value) {
    // Forced, or this whole loop is theatre: the daemon caches the children key
    // like any other, so re-issuing the same request inside the TTL is answered
    // from the same memory that made the button look stale in the first place
    // (DRY-72 trap 3). Caught by the harness — the re-pull never reached the
    // tracker and every row still looked right.
    loadChildren(key, true);
  }
  emit("refresh");
}

const filtering = computed(
  () =>
    !!search.value.trim() ||
    !!fProject.value ||
    !!fStatus.value ||
    !!fAssignee.value ||
    !!fEpic.value,
);

/**
 * The pull, plus the children fetched for epics that are open (DRY-83).
 *
 * **Everything downstream reads this rather than `props.tickets`, and that is
 * the whole design.** The first version merged fetched rows inside `rowsOf`,
 * downstream of `groupTickets`, and it cost two bugs that share one cause —
 * anything bypassing the grouping bypasses every rule the grouping enforces:
 *
 *  - Filtering. `groups` is built from the FILTERED list, so an epic none of
 *    whose children were in the pull had no surviving row and was dropped
 *    outright: typing a term that matched only a fetched child deleted that
 *    child from the screen, along with the epic heading it.
 *  - Repo grouping. `groupTickets` deliberately leaves a child whose repo
 *    differs from its epic's in its OWN group, wearing a chip naming the parent,
 *    because `repo` is what resolves to a working directory and quietly
 *    relocating a ticket would misrepresent where its agent runs. Rows spliced
 *    in under the epic skipped that and rendered under the wrong heading — and
 *    twice, when the pull already had the row in its real group.
 *
 * Feeding them in HERE means both rules apply to fetched children unchanged, and
 * the merge logic that used to sit in `rowsOf` disappears rather than being
 * fixed twice.
 *
 * Keyed off `epicOpenCount`, so a collapsed epic's rows stop counting towards
 * the group tallies even though the fetch is still cached for re-expanding.
 */
const augmented = computed(() => {
  const out = [...props.tickets];
  const seen = new Set(out.map((t) => t.key));
  for (const key of openEpicKeys.value) {
    for (const t of childLoads[key]?.rows ?? []) {
      // The pull wins on a duplicate: it is the fresher of the two, and it is
      // what every other surface on the desk was drawn from.
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      out.push(t);
    }
  }
  return out;
});

// Filter-option sources, derived from the loaded set so they only offer values
// that actually exist. Off `augmented`, so expanding an epic whose children are
// all in the backlog bucket also offers "Backlog" — a status the pull excludes
// by construction, and which would otherwise be the one thing on screen that
// cannot be filtered for.
const projects = computed(() => [...new Set(augmented.value.map((t) => t.repo))].sort());
const statuses = computed(() => {
  const seen = new Map<string, string>();
  for (const t of augmented.value) if (!seen.has(t.status.category)) seen.set(t.status.category, t.status.label);
  return [...seen].map(([category, label]) => ({ category, label }));
});
const assignees = computed(() => [
  ...new Set(augmented.value.map((t) => t.assignee?.name).filter((n): n is string => !!n)),
].sort());
const hasUnassigned = computed(() => augmented.value.some((t) => !t.assignee));

// The unfiltered grouping. Epic filter options come off this rather than a
// second, subtly different rule, so the list offers exactly the epics the
// sidebar can show — including those only named by a child.
const allGroups = computed(() => groupTickets(augmented.value, augmented.value));

const epicOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const g of allGroups.value) {
    for (const e of g.epics) if (!seen.has(e.key)) seen.set(e.key, e.title);
  }
  return [...seen].map(([key, title]) => ({ key, title })).sort((a, b) => a.key.localeCompare(b.key));
});

/**
 * The filter predicate, as a function rather than inline in `filtered`, because
 * on-demand epic children (DRY-83) have to pass through the SAME test.
 *
 * They arrive outside `props.tickets` — that is the whole point of the call —
 * so nothing else would filter them. Expanding an epic and then typing in the
 * search box would otherwise leave that epic's children as the only unfiltered
 * rows on screen.
 */
const matches = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (t: Ticket): boolean => {
    if (fProject.value && t.repo !== fProject.value) return false;
    if (fStatus.value && t.status.category !== fStatus.value) return false;
    // "This epic" means the epic and its children, so the row you filtered by
    // stays on screen as the header for what it contains.
    if (fEpic.value && t.key !== fEpic.value && t.parent?.key !== fEpic.value) return false;
    if (fAssignee.value === UNASSIGNED) {
      if (t.assignee) return false;
    } else if (fAssignee.value && t.assignee?.name !== fAssignee.value) {
      return false;
    }
    if (q) {
      // Searching an epic key finds its children too — the parent link is part
      // of what a ticket IS here, and typing "DRY-1" to see that epic's work is
      // the obvious reading.
      const hay =
        `${t.key} ${t.title} ${t.repo} ${t.assignee?.name ?? ""} ${t.parent?.key ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
});

const filtered = computed(() => augmented.value.filter(matches.value));

const groups = computed(() => groupTickets(filtered.value, augmented.value));

/**
 * Flatten a group into rows. One v-for over a tagged union beats nesting the
 * loops in the template: the ticket row markup (status dot, title, tag, spawn
 * button) then exists once and serves both an epic's children and the tickets
 * that hang off nothing.
 */
type Row =
  | {
      kind: "epic";
      id: string;
      node: EpicNode;
      roll: Rollup;
      /**
       * Is there anything a click could reveal? Carried on the row rather than
       * re-derived, because the chevron, the row's cursor, its tooltip and its
       * click handler all have to agree, and four independent copies of the
       * predicate is how they stop agreeing (DRY-75).
       */
      expandable: boolean;
      /**
       * Would expanding this row have anything to GO AND GET? (DRY-83) Distinct
       * from `expandable`, which asks whether there is anything to show: an epic
       * whose open children are all in the pull is expandable and needs no
       * request, and firing one anyway is a tracker query per epic per click
       * that can only return rows already on screen.
       */
      fetch: boolean;
      title: string;
      /** The on-demand fetch's state, so the row can show it (DRY-83). */
      load?: ChildLoad;
    }
  | { kind: "ticket"; id: string; t: Ticket; child: boolean }
  /**
   * A line under an expanded epic about the fetch behind it (DRY-83) — in
   * flight, or failed and clickable to retry. A row of its own so the template
   * keeps one v-if chain; see the note in the template for what happens
   * otherwise.
   */
  | { kind: "note"; id: string; text: string; bad?: boolean; detail?: string; retry?: string };

/**
 * Active work before dormant work, so an expanded epic opens on the tickets
 * somebody might start (DRY-83).
 *
 * The rollup bar above it is ordered done-first, because there it reads
 * left-to-right as progress. A LIST is read top-down looking for something to
 * pick up, and on-demand children are mostly backlog by construction — that is
 * why they weren't in the pull — so the tracker's own order would bury the one
 * in-flight ticket under thirty that haven't started.
 */
const CHILD_ORDER: Ticket["status"]["category"][] = [
  "in_progress",
  "review",
  "blocked",
  "planning",
  "backlog",
  "done",
];
function childRank(t: Ticket): number {
  const i = CHILD_ORDER.indexOf(t.status.category);
  return i < 0 ? CHILD_ORDER.length : i;
}

function rowsOf(g: RepoGroup): Row[] {
  const out: Row[] = [];
  for (const node of g.epics) {
    const roll = epicRollup(node);
    const load = childLoads[node.key];
    // How many open children the epic HAS, against how many are loaded. The
    // difference is the bug DRY-83 fixes: the pull excludes the backlog bucket
    // and exempts only the EPICS in it, so an epic whose work hasn't started
    // arrives with no children whatsoever and the row went inert at exactly the
    // moment somebody wanted to look inside it. `childStats` already knows
    // better — it counts every child, including the ones the pull dropped — so
    // total-minus-done is what a click can go and fetch.
    //
    // Authoritative only: the fallback rollup counts loaded children, so
    // deriving this from it would say nothing new.
    const open = roll.authoritative ? roll.total - roll.done : node.children.length;
    // Is anything actually missing? Once a fetch has landed its rows are IN
    // `node.children` (they go through `groupTickets` now), so this goes false
    // on its own — which is what stops a re-expand paying for a query that can
    // only return what is already on screen. It is also false from the start for
    // an epic whose open children were all in the pull, which is the common case
    // on a small tracker and used to cost a request each time regardless.
    const missing = open > node.children.length;
    const expandable = node.shown.length > 0 || open > 0;
    out.push({
      kind: "epic",
      id: epicNodeId(g.repo, node.key),
      node,
      roll,
      expandable,
      // A re-expand still refreshes rows we fetched before (they age; the pull's
      // own don't, since the poll replaces them), hence the second clause.
      fetch: missing || !!load?.rows,
      title: epicRowTitle(node, expandable, roll),
      load,
    });
    if (isEpicOpen(g.repo, node.key)) {
      // A note is said only when there is nothing better to say. A re-pull keeps
      // the rows it already had (see `loadChildren`), and announcing a fetch over
      // a list that is on screen and still right is noise on a 20s surface.
      if (load?.loading && !load.rows) {
        out.push({ kind: "note", id: `${node.key}:loading`, text: `loading ${node.key}'s tickets…` });
      } else if (load?.error) {
        out.push({
          kind: "note",
          id: `${node.key}:error`,
          text: `couldn't load ${node.key}'s tickets — retry`,
          bad: true,
          detail: load.error,
          retry: node.key,
        });
      } else if (load?.stale) {
        // The daemon answered from a cache it could not refresh (DRY-72). Not an
        // error — these rows are real — but a fetch that "succeeded" during a
        // tracker outage is exactly the silence DRY-55 exists to break, and the
        // header's own stale marker is about the LIST, so it says nothing here.
        out.push({
          kind: "note",
          id: `${node.key}:stale`,
          text: `${node.key}'s tickets may be out of date`,
          detail: load.stale,
        });
      }
      const kids = node.shown.slice().sort((a, b) => childRank(a) - childRank(b));
      // An epic somebody opened must never render as a heading with nothing
      // under it — that is the state this whole ticket is about, and a fetch
      // that legitimately returns zero (childStats is on a 5-minute TTL, so it
      // can still promise children that have since closed) would otherwise
      // reproduce it exactly, with no note to explain the difference.
      if (!kids.length && !load?.loading) {
        out.push({
          kind: "note",
          id: `${node.key}:empty`,
          text: filtering.value
            ? `nothing under ${node.key} matches the filter`
            : `no open tickets under ${node.key}`,
        });
      }
      for (const t of kids) out.push({ kind: "ticket", id: t.key, t, child: true });
    }
  }
  for (const t of g.loose) out.push({ kind: "ticket", id: t.key, t, child: false });
  return out;
}

// Rows are built in a computed, not called from the template: rendering there
// re-runs rowsOf — and every epicRollup inside it — on each patch. It reads the
// same reactive state either way, so this only changes how often it runs.
const rendered = computed(() =>
  groups.value.map((g) => ({ ...g, rows: isOpen(g.repo) ? rowsOf(g) : [] })),
);

function isOpen(repo: string): boolean {
  return filtering.value || !!expanded[repo];
}
function toggle(repo: string): void {
  expanded[repo] = !expanded[repo];
}
function isEpicOpen(repo: string, key: string): boolean {
  return filtering.value || !!epicExpanded[epicNodeId(repo, key)];
}
/**
 * Reads the MAP, not `isEpicOpen`. A filter forces every epic open, so deriving
 * the new value from `isEpicOpen` writes `false` on every click while one is
 * active: nothing moves on screen, and the expand state you set before
 * filtering is silently discarded on the way past. `toggle()` above has always
 * had this right for repo groups — this line hadn't, and DRY-75 made it far
 * easier to hit by promoting the whole row to be the target.
 */
function toggleEpic(repo: string, key: string, fetch = false): void {
  const id = epicNodeId(repo, key);
  const open = (epicExpanded[id] = !epicExpanded[id]);
  // Kept in step here because this is the only mutator of `epicExpanded`. The
  // augmented list is built off the count, so an epic collapsed in every group
  // stops contributing rows to the group tallies.
  epicOpenCount[key] = Math.max(0, (epicOpenCount[key] ?? 0) + (open ? 1 : -1));
  // The one place the on-demand fetch is triggered (DRY-83) — an explicit
  // expand, never the render path. See `loadChildren` for why that distinction
  // is load-bearing rather than tidiness.
  if (open && fetch) loadChildren(key);
}
/**
 * Clicking an epic row expands or collapses it (DRY-75). Sessions are opened
 * against tickets and an epic is a heading, so expanding is the common action
 * and it gets the big target; launching moved to `.epic-play` beside it.
 *
 * What this replaced did two things wrong at once. It opened the spawn panel,
 * so the row's default gesture was the rare one — the tooltip admitted as much,
 * telling you to use the chevron if you only wanted the epic's children. And it
 * assigned `= true` rather than toggling, so an expanded epic could not be
 * collapsed by the same click that expanded it. Only the ghost branch, which
 * had no ticket to open, was already right.
 *
 * An epic with nothing to show has nothing to expand — the chevron isn't
 * rendered for one either — so its row is inert rather than toggling state that
 * changes nothing on screen.
 */
function onEpicRow(repo: string, key: string, expandable: boolean, fetch: boolean): void {
  if (expandable) toggleEpic(repo, key, fetch);
}

/**
 * The tooltip for the row AND its chevron, which since DRY-75 do the same
 * thing and so should not describe it twice — they had already drifted to
 * "Collapse epic" against "Collapse DRY-1".
 *
 * Deliberately does NOT name the current state. A `title` is painted once when
 * the pointer arrives and does not repaint when a click under it changes what
 * it describes, so "Expand" is wrong the instant it's acted on and stays wrong
 * until the pointer leaves. The chevron's rotation and the rows appearing say
 * which way it is; this only has to say what the gesture does.
 */
function epicRowTitle(node: EpicNode, expandable: boolean, roll: Rollup): string {
  // Restores what the old row tooltip said about a ghost. The `not pulled`
  // chip carries the full explanation, but that's a much smaller target than
  // the row, and losing the hint entirely was a regression.
  const unpulled = node.ticket ? "" : " — not in this pull";
  // Since DRY-83 the inert case is much narrower, and the two reasons left are
  // worth telling apart. An epic every one of whose children is closed is not
  // an epic with nothing in it, and the rollup two lines below says "40/40 done"
  // either way — a tooltip flatly denying it has children reads as a bug.
  if (!expandable) {
    if (roll.authoritative && roll.total > 0) {
      return `${node.key} — nothing open to expand; all ${roll.total} children are done${unpulled}`;
    }
    return `${node.key} — no children to expand here${unpulled}`;
  }
  // A filter force-opens every epic, so a click here records what you want but
  // moves nothing until the filter clears — same as the repo group above it.
  // Worth saying, because otherwise the row reads as broken.
  if (filtering.value) {
    return `Expand or collapse ${node.key} — the filter holds it open for now${unpulled}`;
  }
  return `Expand or collapse ${node.key}${unpulled}`;
}
function clearFilters(): void {
  search.value = "";
  fProject.value = "";
  fStatus.value = "";
  fAssignee.value = "";
  fEpic.value = "";
}
</script>

<template>
  <aside class="sidebar">
    <div class="head">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="3" fill="#1e2b3a" stroke="#3d6fa6" stroke-width="1.2" />
        <path d="M5 8l2 2 4-4.5" stroke="#5b9bd5" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="label">{{ (name || "Tracker").toUpperCase() }}</span>
      <!-- Both halves over the AUGMENTED set (DRY-83), so the count describes
           what the sidebar holds. Against the pull it would read "0/5" while a
           fetched child sat on screen matching the filter — a header
           contradicting the rows under it. Expanding therefore moves it (5 → 7),
           which is honest: two more tickets really are loaded. What must not
           move is the backlog toggle, which is the control that widens the
           PULL, and that is where the harness looks instead. -->
      <span class="count">{{ filtered.length }}<template v-if="filtered.length !== augmented.length">/{{ augmented.length }}</template></span>
      <!-- The quiet half of DRY-55: these tickets are real, they're just not
           current. Worth a marker rather than a banner — the loud case is the
           empty one below. -->
      <span
        v-if="pullError && tickets.length"
        class="stale"
        :title="`Last pull failed, so these may be out of date — ${whyShort}`"
      >stale</span>
      <button
        class="refresh"
        :class="{ spinning: refreshing }"
        title="Refresh tickets"
        :disabled="refreshing"
        @click="onRefresh"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2v3.2H10.3" />
        </svg>
      </button>
      <!-- A green "live" dot over a list nothing is refreshing is its own small
           untruth, and this is the one pixel already in the header that claims
           freshness (DRY-55). -->
      <span
        class="live"
        :class="{ down: !!pullError }"
        :title="pullError ? 'Not reaching the tracker' : 'Tickets are refreshing'"
      ></span>
    </div>

    <!-- search + filters -->
    <div class="controls">
      <div class="searchbox">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="#5a636f" stroke-width="1.5">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M11 11l3 3" stroke-linecap="round" />
        </svg>
        <input v-model="search" type="text" placeholder="Search tickets…" spellcheck="false" />
        <button v-if="filtering" class="clear" title="Clear filters" @click="clearFilters">✕</button>
      </div>
      <div class="filters">
        <select v-model="fProject" :class="{ on: !!fProject }" title="Project">
          <option value="">Project</option>
          <option v-for="p in projects" :key="p" :value="p">{{ p }}</option>
        </select>
        <select v-model="fStatus" :class="{ on: !!fStatus }" title="Status">
          <option value="">Status</option>
          <option v-for="s in statuses" :key="s.category" :value="s.category">{{ s.label }}</option>
        </select>
        <select v-model="fAssignee" :class="{ on: !!fAssignee }" title="Assignee">
          <option value="">Assignee</option>
          <option v-for="a in assignees" :key="a" :value="a">{{ a }}</option>
          <option v-if="hasUnassigned" :value="UNASSIGNED">Unassigned</option>
        </select>
      </div>
      <!-- Epic filter (DRY-13) gets its own full-width row: epic titles are
           sentences, and squeezed into the quarter-width the row above would
           leave, every option truncates to the same few characters. -->
      <div v-if="epicOptions.length" class="filters">
        <select v-model="fEpic" :class="{ on: !!fEpic }" title="Epic">
          <option value="">Epic</option>
          <option v-for="e in epicOptions" :key="e.key" :value="e.key">{{ e.key }} — {{ e.title }}</option>
        </select>
      </div>
      <!-- pull scope (DRY-30): which projects the daemon fetches, not a view filter -->
      <div class="scope">
        <span
          v-for="p in scopeProjects"
          :key="p"
          class="chip fixed"
          title="Host default (DRYDOCK_TRACKER_PROJECTS)"
        >{{ p }}</span>
        <span v-for="p in userProjects" :key="p" class="chip">
          {{ p }}
          <button class="chip-x" :title="`Stop pulling ${p}`" @click="emit('remove-project', p)">✕</button>
        </span>
        <input
          v-model="newProject"
          class="addkey"
          type="text"
          placeholder="+ project"
          spellcheck="false"
          title="Add a project key to pull (↵)"
          @keydown.enter.prevent="addProject"
        />
        <!-- A switch rather than a bare checkbox (DRY-85). It was the only
             unstyled form control in the sidebar, and it is not a filter over
             what is already loaded — it widens what the daemon PULLS, which on
             a corporate tracker is the difference between ~29 tickets and 250+.
             A switch reads as changing a setting; a checkbox reads as ticking a
             filter, which is the distinction the title had to spell out in
             words. The title now names the cost instead.

             The native input is still the control — kept in the accessibility
             tree and merely made invisible, so role, focus and keyboard
             behaviour stay the browser's. `display:none` would take all three
             away; the track and thumb are decoration painted over it.

             Locked by `scopeBusy` alone. Re-toggling mid-flight genuinely does
             desync the control from the list — `loadTickets`' epoch guard
             protects the list, not this — but that is a hazard of a scope
             change, not of the 20s background poll it used to dim on. -->
        <label
          class="backlog"
          :class="{ on: showBacklog, busy: scopeBusy }"
          title="Also pull backlog-status tickets — widens what the daemon fetches, not a view filter"
        >
          <input
            type="checkbox"
            :checked="showBacklog"
            :disabled="scopeBusy"
            @change="emit('toggle-backlog', ($event.target as HTMLInputElement).checked)"
          />
          <span class="sw" aria-hidden="true"><i></i></span>
          <span class="txt">backlog</span>
        </label>
      </div>
    </div>

    <div class="list">
      <!-- Nothing was fetched, so there is no set for "match" to be about
           (DRY-55). Keyed off `tickets`, not `groups`: a filter that hides
           every loaded row is still "No tickets match", outage or not. -->
      <div v-if="pullError && !tickets.length" class="unreachable">
        <p class="unreachable-head">Can't reach {{ outageSubject }}</p>
        <p class="unreachable-why">{{ whyShort }}</p>
        <button class="retry" :disabled="refreshing" @click="emit('refresh')">
          {{ refreshing ? "Retrying…" : "Retry" }}
        </button>
      </div>
      <p v-else-if="!groups.length" class="empty">No tickets match.</p>
      <template v-for="grp in rendered" :key="grp.repo">
        <button class="grp" :class="{ open: isOpen(grp.repo) }" @click="toggle(grp.repo)">
          <span class="chev">▸</span>
          <span class="grp-name">{{ grp.repo }}</span>
          <span class="grp-count">{{ grp.count }}</span>
        </button>
        <template v-if="isOpen(grp.repo)">
          <template v-for="row in grp.rows" :key="row.id">
            <!-- epic row: header for its children, and a ticket in its own
                 right unless it was never pulled -->
            <div
              v-if="row.kind === 'epic'"
              class="row epic"
              :class="{ ghost: !row.node.ticket, inert: !row.expandable }"
              :title="row.title"
              @click="onEpicRow(grp.repo, row.node.key, row.expandable, row.fetch)"
            >
              <button
                v-if="row.expandable"
                class="epic-chev"
                :class="{ open: isEpicOpen(grp.repo, row.node.key) }"
                :title="row.title"
                @click.stop="toggleEpic(grp.repo, row.node.key, row.fetch)"
              >▸</button>
              <span v-else class="epic-chev empty"></span>
              <div class="meta">
                <div class="line1">
                  <span class="epic-badge">EPIC</span>
                  <span class="key">{{ row.node.key }}</span>
                  <span v-if="row.node.ticket" class="slabel">{{ row.node.ticket.status.label }}</span>
                  <span
                    v-else
                    class="slabel unpulled"
                    title="Named by its children but not in the pull — its project is probably outside the current scope. Add that project to see the epic itself."
                  >not pulled</span>
                </div>
                <div class="ttitle">{{ row.node.title }}</div>
                <!-- An epic can itself hang off something (Jira initiative →
                     epic). Nesting stops at one level by choice, but the link
                     shouldn't vanish with it — epic rows have no .tagrow, so
                     the chip loose rows get would otherwise never render. -->
                <div v-if="row.node.ticket?.parent" class="tagrow">
                  <span
                    class="parent-chip"
                    :title="`Child of ${row.node.ticket.parent.key}${row.node.ticket.parent.title ? ` — ${row.node.ticket.parent.title}` : ''}`"
                  >↳ {{ row.node.ticket.parent.key }}</span>
                </div>
                <div v-if="row.roll.total" class="rollup" :title="row.roll.hint">
                  <span class="bar">
                    <span
                      v-for="s in row.roll.segments"
                      :key="s.category"
                      class="seg"
                      :style="{
                        width: `${(s.n / row.roll.total) * 100}%`,
                        background: CATEGORY_COLOR[s.category].c,
                      }"
                    ></span>
                  </span>
                  <!-- With real counts the ratio means completion, so it says so.
                       Falling back to loaded children it cannot mean that (the
                       pull excludes done), so it reports coverage instead. -->
                  <span v-if="row.roll.authoritative" class="rollup-n">
                    {{ row.roll.done }}/{{ row.roll.total }} done
                  </span>
                  <span v-else class="rollup-n">
                    <template v-if="row.node.shown.length !== row.node.children.length">{{ row.node.shown.length }}/</template>{{ row.node.children.length }}
                  </span>
                </div>
              </div>
              <!-- Launching an epic, now that the row itself expands (DRY-75).
                   A real <button>, unlike the ticket row's `.play`, because
                   there the whole row is the target and the chip is only a
                   label for it. Same glyph so "spawn" reads the same
                   everywhere; the chip is unlit until you point at it, which
                   is what says the row won't do this for you. A ghost epic has
                   no ticket to open and keeps the column with a blank. -->
              <button
                v-if="row.node.ticket"
                class="epic-play"
                :title="`Open ${row.node.key} — spawn an agent on this epic`"
                @click.stop="emit('launch', row.node.ticket)"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2l6 4-6 4z" /></svg>
              </button>
              <span v-else class="epic-play blank"></span>
            </div>

            <!-- What the on-demand child fetch is doing (DRY-83). Its own row
                 variant rather than markup wedged between the two below, because
                 the ticket row's `v-else` chains to the epic row's `v-if` and
                 anything with a `v-if` in between silently re-parents it — the
                 ticket branch then renders for epic rows, off an undefined
                 `row.t`. -->
            <div
              v-else-if="row.kind === 'note'"
              class="child-note"
              :class="{ bad: row.bad }"
              :title="short(row.detail)"
              @click="row.retry && loadChildren(row.retry)"
            >
              {{ row.text }}
            </div>

            <!-- ticket row: an epic's child, or a ticket that hangs off none -->
            <div
              v-else
              class="row"
              :class="{ child: row.child }"
              @click="emit('launch', row.t)"
            >
              <span
                class="status"
                :style="{
                  background: CATEGORY_COLOR[row.t.status.category].c,
                  boxShadow: `0 0 6px ${CATEGORY_COLOR[row.t.status.category].g}`,
                }"
              ></span>
              <div class="meta">
                <div class="line1">
                  <span class="key">{{ row.t.key }}</span>
                  <span class="slabel">{{ row.t.status.label }}</span>
                </div>
                <div class="ttitle">{{ row.t.title }}</div>
                <div class="tagrow">
                  <template v-if="row.t.tag">
                    <span class="tag-dot" :style="{ background: tagColor(row.t.tag) }"></span>
                    <span class="tag">{{ row.t.tag }}</span>
                  </template>
                  <!-- Parent named inline only when the row ISN'T already sitting
                       under its epic — i.e. the cross-repo case, where the link
                       would otherwise be invisible. -->
                  <span
                    v-if="!row.child && row.t.parent"
                    class="parent-chip"
                    :title="`Child of ${row.t.parent.key}${row.t.parent.title ? ` — ${row.t.parent.title}` : ''}`"
                  >↳ {{ row.t.parent.key }}</span>
                  <span v-if="row.t.assignee" class="assignee" :title="`Assigned to ${row.t.assignee.name}`">@{{ row.t.assignee.name }}</span>
                </div>
              </div>
              <div class="play" title="Spawn agent">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="#9cc6ec"><path d="M3 2l6 4-6 4z" /></svg>
              </div>
            </div>
          </template>
        </template>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 266px;
  flex: 0 0 auto;
  background: #0c0f13;
  border-right: 1px solid #ffffff0d;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  height: 42px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid #ffffff0a;
}
.label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #7a8696;
}
.count {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #4f5965;
  margin-left: auto;
}
.refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 5px;
  color: #5a636f;
  cursor: pointer;
}
.refresh:hover:not(:disabled) {
  background: #11161c;
  color: #aecbe8;
}
.refresh:disabled {
  cursor: default;
}
.refresh.spinning {
  color: #5b9bd5;
}
.refresh.spinning svg {
  animation: ddspin 0.7s linear infinite;
}
@keyframes ddspin {
  to {
    transform: rotate(360deg);
  }
}
.live {
  width: 6px;
  height: 6px;
  /* An empty span in a flex row is `0 1 auto`, so it is the FIRST thing the
     header gives up when it overflows — and the header is now one chip wider
     than it was. Without this the outage dot silently isn't there in exactly
     the case it exists for (DRY-55). */
  flex: 0 0 auto;
  border-radius: 50%;
  background: #5fb98a;
  box-shadow: 0 0 6px #5fb98a99;
}
.live.down {
  background: #d57a6e;
  box-shadow: 0 0 6px #d57a6e99;
}
/* Amber, not red: the rows under it are still usable (DRY-55). */
.stale {
  flex: 0 0 auto;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #d6a651;
  background: #d6a6511a;
  border: 1px solid #d6a65133;
  border-radius: 4px;
  padding: 1px 4px;
}

/* search + filters */
.controls {
  flex: 0 0 auto;
  padding: 8px;
  border-bottom: 1px solid #ffffff0a;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.searchbox {
  display: flex;
  align-items: center;
  gap: 6px;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 7px;
  padding: 0 8px;
}
.searchbox:focus-within {
  border-color: #3d6fa6;
}
.searchbox input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: #d5dde6;
  font-size: 12px;
  padding: 7px 0;
}
.searchbox input::placeholder {
  color: #4f5965;
}
.clear {
  background: none;
  border: none;
  color: #6b7682;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 3px;
  border-radius: 4px;
}
.clear:hover {
  color: #c3ccd6;
}
.filters {
  display: flex;
  gap: 5px;
}
.filters select {
  flex: 1;
  min-width: 0;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 6px;
  color: #8a94a0;
  font-size: 10.5px;
  padding: 5px 4px;
  outline: none;
  cursor: pointer;
}
.filters select.on {
  border-color: #3d6fa6;
  color: #aecbe8;
}
.filters select:focus {
  border-color: #3d6fa6;
}

/* pull scope (DRY-30) */
.scope {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: #aecbe8;
  background: #16314a;
  border: 1px solid #2a557d;
  border-radius: 9px;
  padding: 2px 8px;
}
.chip.fixed {
  color: #7a8696;
  background: #141a21;
  border-color: #20272f;
}
.chip-x {
  background: none;
  border: none;
  color: #6b7682;
  cursor: pointer;
  font-size: 9px;
  padding: 0 0 0 2px;
}
.chip-x:hover {
  color: #d57a6e;
}
.addkey {
  width: 74px;
  background: #0b0e12;
  border: 1px solid #20272f;
  border-radius: 9px;
  color: #d5dde6;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  padding: 3px 8px;
  outline: none;
  text-transform: uppercase;
}
.addkey::placeholder {
  color: #4f5965;
  text-transform: none;
}
.addkey:focus {
  border-color: #3d6fa6;
}
.backlog {
  position: relative;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #6b7682;
  cursor: pointer;
  user-select: none;
}
/* Hidden, not removed. The input still carries the role, the checked state and
   the keyboard behaviour — `display:none` or `visibility:hidden` would drop it
   out of the accessibility tree and off the tab order, leaving a switch only a
   mouse can reach. Clipped to a pixel inside the (positioned) label instead. */
.backlog input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.backlog .sw {
  position: relative;
  flex: none;
  width: 20px;
  height: 11px;
  border-radius: 6px;
  background: #0b0e12;
  border: 1px solid #20272f;
  transition:
    background 0.12s ease,
    border-color 0.12s ease;
}
.backlog .sw i {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4f5965;
  transition:
    transform 0.12s ease,
    background 0.12s ease;
}
.backlog.on .sw {
  background: #16314a;
  border-color: #2a557d;
}
.backlog.on .sw i {
  background: #5b9bd5;
  transform: translateX(9px);
}
.backlog.on .txt {
  color: #aecbe8;
}
/* The ring the hidden input can no longer draw for itself. */
.backlog input:focus-visible + .sw {
  outline: 1px solid #3d6fa6;
  outline-offset: 1px;
}
/* Only ever raised by a scope change now, so this is a real wait rather than
   the 20s poll's blink (DRY-85). */
.backlog.busy {
  opacity: 0.45;
  cursor: default;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 16px;
}
.empty {
  font-size: 12px;
  color: #5a636f;
  text-align: center;
  margin: 18px 0;
}
/* The empty state's replacement when the pull failed (DRY-55). Not named
   `.down` — that's the live dot's modifier, and the two would share a rule. */
.unreachable {
  margin: 18px 8px;
  text-align: center;
}
.unreachable-head {
  font-size: 12px;
  color: #d57a6e;
  margin: 0 0 5px;
}
.unreachable-why {
  font-size: 11px;
  line-height: 1.45;
  color: #5a636f;
  margin: 0 0 10px;
  /* Daemon errors arrive as one unbroken token often enough (a URL, a JSON
     blob) to overflow a 266px rail otherwise. */
  overflow-wrap: anywhere;
}
.retry {
  padding: 4px 12px;
  font-size: 11px;
  color: #aecbe8;
  background: #11161c;
  border: 1px solid #ffffff14;
  border-radius: 5px;
  cursor: pointer;
}
.retry:hover:not(:disabled) {
  background: #17202a;
  border-color: #ffffff24;
}
.retry:disabled {
  color: #5a636f;
  cursor: default;
}
.grp {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 6px 0 2px;
  padding: 5px 6px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.grp:hover {
  background: #11161c;
}
.chev {
  color: #5a636f;
  font-size: 9px;
  transition: transform 0.12s ease;
}
.grp.open .chev {
  transform: rotate(90deg);
}
.grp-name {
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #5a636f;
  text-transform: uppercase;
}
.grp-count {
  margin-left: auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: #4f5965;
  background: #141a21;
  border-radius: 9px;
  padding: 1px 7px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 8px 9px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 1px;
}
.row:hover {
  background: #141a21;
}
.status {
  margin-top: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.meta {
  flex: 1;
  min-width: 0;
}
.line1 {
  display: flex;
  align-items: center;
  gap: 7px;
}
.key {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 600;
  color: #5b9bd5;
}
.slabel {
  font-size: 10px;
  color: #6b7682;
}
.ttitle {
  font-size: 12.5px;
  color: #bcc6d1;
  line-height: 1.35;
  margin-top: 2px;
  text-wrap: pretty;
}
.tagrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
}
.tag {
  font-size: 10.5px;
  color: #5a636f;
}
.assignee {
  margin-left: auto;
  font-size: 10px;
  color: #6e7a86;
  font-family: "JetBrains Mono", monospace;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.play {
  margin-top: 1px;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #16314a;
  border: 1px solid #2a557d;
  flex: 0 0 auto;
}

/* epics (DRY-13) */
.row.epic {
  align-items: flex-start;
  gap: 5px;
  padding-left: 4px;
  /* Reads as a header for what follows rather than a peer of it — the same
     inset-bar trick the selected row uses, in the epic tag color. */
  box-shadow: inset 2px 0 0 #8b7fd659;
}
.epic-chev {
  flex: 0 0 auto;
  width: 16px;
  margin-top: 2px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 4px;
  color: #5a636f;
  font-size: 9px;
  line-height: 1.4;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.epic-chev:hover {
  color: #b8aae8;
}
.epic-chev.open {
  transform: rotate(90deg);
}
.epic-chev.empty {
  cursor: default;
}
/* The epic's spawn button (DRY-75). Deliberately the same size and position as
   a ticket row's `.play` so the right-hand column lines up, and deliberately
   NOT the same weight: `.play` is lit at rest because its row spawns on click,
   this one is a hollow chip until hover because its row doesn't. Two rows that
   answer the same gesture differently have to look different, and this is the
   pixel that says so. Bordered at rest all the same — a bare glyph here could
   be taken for a second chevron. */
.epic-play {
  margin-top: 1px;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid #ffffff14;
  color: #6b7682;
  cursor: pointer;
  flex: 0 0 auto;
}
/* `:not(.blank)` is load-bearing. `.blank` is a placeholder span holding the
   column open on a ghost epic, and it can be hovered like anything else — it
   only overrode `border-color` and `cursor`, so a plain `.epic-play:hover`
   (same specificity, declared first) still painted the background and lit a
   button that does nothing on a row with nothing to open. */
.epic-play:not(.blank):hover {
  background: #16314a;
  border-color: #2a557d;
  color: #9cc6ec;
}
.epic-play:focus-visible {
  outline: 1px solid #3d6fa6;
  outline-offset: 1px;
}
/* Ghost epics have nothing to open; the column stays so their titles wrap on
   the same measure as every other epic's. */
.epic-play.blank {
  border-color: transparent;
  cursor: default;
}
.epic-badge {
  font-family: "JetBrains Mono", monospace;
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #8b7fd6;
  border: 1px solid #8b7fd64d;
  border-radius: 3px;
  padding: 0 4px;
  line-height: 1.7;
  flex: 0 0 auto;
}
/* An epic with nothing to show — children all outside the pull (or all done,
   which it excludes), or all filtered out — renders no chevron, so there is
   nothing for a row click to do. Saying so with the cursor beats a row that
   silently ignores you. The spawn button needs no counter-rule: it declares its
   own `cursor`, which beats inheriting this one whatever the parent's
   specificity. (DRY-75) */
.row.epic.inert {
  cursor: default;
}
.row.epic.inert:hover {
  background: none;
}
/* An epic named only by its children: no status of its own to show, so the row
   stays visibly lighter than a real ticket instead of implying one. */
.row.epic.ghost {
  box-shadow: inset 2px 0 0 #8b7fd62e;
}
.row.epic.ghost .key {
  color: #6f8fae;
}
.slabel.unpulled {
  color: #55606b;
  font-style: italic;
  cursor: help;
}
.rollup {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 6px;
  cursor: help;
}
.bar {
  /* Fixed and short on purpose: stretched across the row it reads as a rule
     under the title rather than a statistic. */
  flex: 0 0 92px;
  display: flex;
  height: 3px;
  border-radius: 2px;
  background: #141a21;
  overflow: hidden;
}
.seg {
  flex: 0 0 auto;
  height: 100%;
}
.rollup-n {
  font-family: "JetBrains Mono", monospace;
  font-size: 9.5px;
  color: #4f5965;
  flex: 0 0 auto;
}
/* Children hang off a rail under their epic. Zero bottom margin so consecutive
   children draw one continuous line rather than a dashed one. */
.row.child {
  margin-left: 13px;
  margin-bottom: 0;
  padding-left: 11px;
  border-left: 1px solid #1e262e;
  border-radius: 0 8px 8px 0;
}
/* The on-demand child fetch talking about itself (DRY-83). Sits in the child
   lane so it reads as belonging to the epic above it, and stays quieter than a
   ticket row — it is scaffolding, not work. */
.child-note {
  margin-left: 13px;
  padding: 5px 11px;
  border-left: 1px solid #1e262e;
  font-size: 10.5px;
  color: #6b7682;
}
.child-note.bad {
  color: #b98a80;
  cursor: pointer;
}
.child-note.bad:hover {
  color: #d57a6e;
}
.parent-chip {
  font-family: "JetBrains Mono", monospace;
  font-size: 9.5px;
  color: #6b7682;
  border: 1px solid #20272f;
  border-radius: 8px;
  padding: 0 5px;
  line-height: 1.6;
}
</style>
