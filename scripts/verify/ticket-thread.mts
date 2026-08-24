// `/api/tracker/ticket/<KEY>?thread=true` — on Jira AND on Switchyard (DRY-76).
//
// The panel now renders the comment thread, and the thread is the whole point:
// house style records corrections as comments, so "ticket says do X, but Y makes
// more sense" is a normal thing to find under a description that still says X.
// The agent's brief has had that since DRY-53; the human deciding whether to
// spawn the agent had not.
//
// Why this rig and not `tracker-getticket.mts`, which already stubs both
// providers: that one builds the providers directly, so it can prove
// `getTicket(key, {thread: true})` works and nothing at all about the ROUTE —
// and the route is the entire change. It is also the file that would keep
// passing if `?thread=true` were dropped on the floor between the browser and
// the provider, which is exactly the bug shape DRY-66 shipped once already (a
// value that vanishes behind a 200).
//
// Why a real daemon and not a fetch at the provider: `createTracker` FALLS BACK
// TO THE FIXTURE PROVIDER when a live provider is selected but unconfigured,
// and says so only in a log line. A harness that trusted `DRYDOCK_TRACKER=jira`
// would then assert against fixture data and pass without a Jira in the picture
// — CLAUDE.md trap 3, one surface over. So every round checks
// `/api/tracker/info` first, and every payload assertion is on bytes only this
// stub could have produced.
//
// What it holds down, in order:
//   (a) the thread arrives, from both providers, through the route
//   (b) it arrives NEWEST-INCLUSIVE. Jira pages `comment` oldest-first, so a
//       long thread's inline page is the wrong end of it — the window that
//       misleads rather than merely omits (DRY-53 trap 6)
//   (c) `commentCount` is the tracker's total, not what fitted. "Showing 20 of
//       63" is only sayable if the 63 survives the route
//   (d) a Switchyard tombstone is neither shown nor counted
//   (e) the epic the walk paid for comes back with it
//   (f) WITHOUT `?thread=true` the route is exactly as cheap as it was — one
//       upstream GET, no comments, no epic. The workspace drawer still opens
//       for that price
//   (g) two opens in a row both reach the tracker. This route is deliberately
//       uncached (DRY-72 left it alone so the brief reads a live thread); a
//       panel opened to check for a correction wants the same
//
// It starts its own stub tracker and its own daemons, needs no credentials and
// no network, and takes about ten seconds. Run from `daemon/`, where tsx
// resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/ticket-thread.mts)
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Detail, TicketDetail } from "./api.mjs";

const STUB_PORT = Number(process.env.STUB_PORT ?? 4376);
const PORT = Number(process.env.DAEMON_PORT ?? 4377);
const DAEMON = `http://127.0.0.1:${PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const REPO = path.resolve(import.meta.dirname, "../..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "dry76-"));

let failures = 0;
let ran = 0;
/**
 * Counts as well as reports, and the summary prints both numbers — so a later
 * reader can tell "still discriminates" from "a round stopped running" against
 * the count in the README (prefill.mts's note; its denominator was wrong the
 * day it was written).
 */
function check(name: string, ok: boolean, detail: Detail = ""): void {
  ran++;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the stub tracker: both wire shapes, on one origin -----------------------
//
// One server rather than two because the two providers never run at once here,
// and the thing that must not drift between the rounds is the COUNTER: "one
// upstream GET without the thread" has to mean the same number on both sides.

/** Upstream requests since the last reset — what claim (f) and (g) are about. */
let hits: string[] = [];
/** Set to fail the next request matching it (the "thread we couldn't fetch" case). */
let failNext: RegExp | undefined;

const JIRA_PAGE = 20; // what this "deployment" inlines with the issue
const JIRA_TOTAL = 63; // …of this many

function jiraIssue(key: string, type: string, parent?: { key: string; type: string }) {
  return {
    key,
    fields: {
      summary: `${key} summary`,
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: type },
      project: { key: "SRE" },
      description: "the plan, written first and never updated",
      parent: parent
        ? {
            key: parent.key,
            fields: { summary: `${parent.key} summary`, issuetype: { name: parent.type } },
          }
        : null,
    },
  };
}

/**
 * `comment #N`, oldest first — the bodies claim (b) turns on. Numbered rather
 * than prosaic so "which end of the thread arrived" is readable at a glance:
 * #0 is the oldest of 63 and #62 the newest.
 */
function jiraComments(total: number, startAt: number, want: number) {
  const out = [];
  for (let i = startAt; i < Math.min(total, startAt + want); i++) {
    out.push({
      body: `comment #${i}`,
      author: { displayName: i % 2 ? "Ashley" : "claude" },
      created: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000+0000`,
    });
  }
  return out;
}

// key -> [issue, comment total]. SRE-1 is a subtask two rungs under its epic on
// a 63-comment thread; SRE-42 is an orphan with none.
const JIRA_WORLD: Record<string, [ReturnType<typeof jiraIssue>, number]> = {
  "SRE-1": [jiraIssue("SRE-1", "Sub-task", { key: "SRE-2", type: "Task" }), JIRA_TOTAL],
  "SRE-2": [jiraIssue("SRE-2", "Task", { key: "SRE-3", type: "Epic" }), 0],
  "SRE-3": [jiraIssue("SRE-3", "Epic"), 0],
  "SRE-42": [jiraIssue("SRE-42", "Task"), 0],
};

/**
 * The Switchyard world. `parent: null` beside a populated `parent_id` is not a
 * simplification — it is what that endpoint really returns (DRY-53 trap 5), and
 * it is why the thread drags an ancestry walk along on this provider.
 *
 * The thread carries a TOMBSTONE and a whitespace-only body, because the count
 * the panel prints must not include either: "showing 2 of 4" against a thread
 * with two readable comments is a number nobody can reconcile.
 */
const SWY_WORLD: Record<string, unknown> = {
  "DRY-90": {
    id: "uuid-sub",
    key: "DRY-90",
    title: "the subtask",
    type: "subtask",
    status: { category: "in_progress", display_name: "In Progress" },
    project: { key: "DRY" },
    description: "the plan, written first and never updated",
    parent_id: "uuid-task",
    parent: null,
    comments: [
      { body: "oldest surviving", author: { name: "claude" }, created_at: "2026-07-01 10:00:00+00" },
      { body: "retracted body", author: { name: "claude" }, created_at: "2026-07-02 10:00:00+00", deleted: true },
      { body: "   ", author: { name: "claude" }, created_at: "2026-07-03 10:00:00+00" },
      { body: "actually do Y", author: { name: "Ashley" }, created_at: "2026-07-04 10:00:00+00" },
    ],
  },
  "uuid-task": {
    id: "uuid-task",
    key: "DRY-49",
    title: "the task",
    type: "task",
    status: { category: "in_progress", display_name: "In Progress" },
    project: { key: "DRY" },
    parent_id: "uuid-epic",
    parent: null,
    comments: [],
  },
  "uuid-epic": {
    id: "uuid-epic",
    key: "DRY-1",
    title: "the epic",
    type: "epic",
    status: { category: "in_progress", display_name: "In Progress" },
    project: { key: "DRY" },
    parent_id: null,
    parent: null,
    comments: [],
  },
};

const stub = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  hits.push(req.url!);
  if (failNext?.test(req.url!)) {
    res.writeHead(500).end("stub: deliberate failure");
    return;
  }
  const json = (body: unknown) =>
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));

  const jira = /^\/rest\/api\/2\/issue\/([^/?]+)(\/comment)?$/.exec(url.pathname);
  if (jira) {
    const entry = JIRA_WORLD[decodeURIComponent(jira[1]!)];
    if (!entry) return void res.writeHead(404).end("no such issue");
    const [issue, total] = entry;
    if (jira[2]) {
      // The tail fetch: `startAt = total - N`, which is how the provider reaches
      // the END of a thread on a Jira that won't order it for us.
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      return void json({ startAt, maxResults, total, comments: jiraComments(total, startAt, maxResults) });
    }
    const fields = (url.searchParams.get("fields") ?? "").split(",");
    const body: Record<string, unknown> = { key: issue.key, fields: { ...issue.fields } };
    if (!fields.includes("description")) delete (body.fields as Record<string, unknown>).description;
    if (fields.includes("comment")) {
      (body.fields as Record<string, unknown>).comment = {
        startAt: 0,
        maxResults: JIRA_PAGE,
        total,
        comments: jiraComments(total, 0, JIRA_PAGE),
      };
    }
    return void json(body);
  }

  const swy = /^\/v1\/tickets\/([^/?]+)$/.exec(url.pathname);
  if (swy) {
    const t = SWY_WORLD[decodeURIComponent(swy[1]!)];
    if (!t) return void res.writeHead(404).end("no such ticket");
    return void json(t);
  }
  res.writeHead(404).end("stub: unrouted");
});
await new Promise<void>((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

// --- the daemon under test ---------------------------------------------------

/**
 * Every `DRYDOCK_*` stripped, then the ones that matter pinned back.
 *
 * Not tidiness: when this harness is run BY an agent Drydock spawned, the
 * session inherits the daemon that started it, so a "throwaway" here would come
 * up on the prod Postgres, the prod auth password and the prod tracker token —
 * and the tell is a payload that looks fine (CLAUDE.md, "real env wins"). The
 * empty strings are the second half: `env.ts` walks up from the daemon's cwd
 * and applies any key of the CHECKOUT's `.env` that isn't already set, and only
 * a present-but-empty value counts as "already set".
 */
function daemonEnv(kind: "jira" | "switchyard"): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("DRYDOCK_")) out[k] = v;
  return {
    ...out,
    DRYDOCK_PORT: String(PORT),
    DRYDOCK_HOST: "127.0.0.1",
    DRYDOCK_TRACKER: kind,
    DRYDOCK_SWITCHYARD_URL: kind === "switchyard" ? STUB : "",
    DRYDOCK_SWITCHYARD_TOKEN: "stub",
    DRYDOCK_JIRA_URL: kind === "jira" ? STUB : "",
    DRYDOCK_JIRA_TOKEN: "stub",
    DRYDOCK_JIRA_EMAIL: "stub@example.invalid",
    // The reaper is the daemon's only other caller of `getTicket`, on a timer
    // (DRY-90). Off, because the counters below are the point of this file and
    // one background poll landing mid-round would make "three upstream
    // requests" a number that depends on how long a round took.
    DRYDOCK_WORKTREE_REAP_MS: "0",
    DRYDOCK_SESSIONS_DIR: path.join(SCRATCH, `s-${kind}`),
    DRYDOCK_STATE_FILE: path.join(SCRATCH, `state-${kind}.json`),
    DRYDOCK_DATABASE_URL: "",
    DRYDOCK_MULTI_USER: "",
    DRYDOCK_AUTH_PASSWORD: "",
    DRYDOCK_AUTH_PASSWORD_HASH: "",
  };
}

let daemon: ChildProcess | null = null;
const daemonLog: string[] = [];

async function startDaemon(kind: "jira" | "switchyard"): Promise<boolean> {
  daemonLog.length = 0;
  daemon = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: path.join(REPO, "daemon"),
    env: daemonEnv(kind),
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (b: Buffer) => daemonLog.push(String(b)));
  daemon.stderr?.on("data", (b: Buffer) => daemonLog.push(String(b)));
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      if ((await fetch(`${DAEMON}/healthz`)).ok) return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

async function stopDaemon(): Promise<void> {
  if (!daemon) return;
  const proc = daemon;
  daemon = null;
  const ended = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  await Promise.race([ended, sleep(4000)]);
  proc.kill("SIGKILL");
}

interface TicketResponse {
  ticket?: TicketDetail;
  error?: string;
}

async function open(key: string, thread: boolean): Promise<TicketResponse> {
  hits = [];
  const res = await fetch(
    `${DAEMON}/api/tracker/ticket/${encodeURIComponent(key)}${thread ? "?thread=true" : ""}`,
  );
  return (await res.json()) as TicketResponse;
}

// --- Jira --------------------------------------------------------------------

console.log("\n--- jira ---");
if (!(await startDaemon("jira"))) {
  console.log("  FAIL  the daemon never came up\n", daemonLog.join("").slice(-800));
  failures++;
  // Stopped even though it never answered: "didn't come up in 20s" and "isn't
  // running" are different things — a cold tsx cache can put a daemon over that
  // wait — and a child left holding PORT makes the NEXT round fail to bind, so
  // one slow start would report itself as two dead daemons plus a leaked node.
  await stopDaemon();
} else {
  // FIRST, before any payload assertion: an unconfigured live provider falls
  // back to the fixture and only logs about it, so a green run here could
  // otherwise be a green run against fixture data.
  const info = (await (await fetch(`${DAEMON}/api/tracker/info`)).json()) as { id?: string };
  check("the daemon really is on the Jira provider", info.id === "jira", String(info.id));

  {
    const { ticket } = await open("SRE-1", false);
    check("no thread: the description still arrives", !!ticket?.description, ticket?.description);
    check("no thread: no comments", ticket?.comments === undefined, JSON.stringify(ticket?.comments));
    check("no thread: no epic", ticket?.epic === undefined, JSON.stringify(ticket?.epic));
    check("no thread: ONE upstream request", hits.length === 1, hits.join(" "));
    check("no thread: the `comment` field wasn't even asked for", !hits[0]?.includes("comment"), hits[0] ?? "");
  }

  {
    const { ticket } = await open("SRE-1", true);
    const bodies = (ticket?.comments ?? []).map((c) => c.body);
    check("thread: comments arrive", bodies.length > 0, bodies.length);
    // (b). The inline page is comments #0-19; only a tail fetch reaches #62.
    check("thread: the NEWEST comment is in it", bodies.at(-1) === `comment #${JIRA_TOTAL - 1}`, String(bodies.at(-1)));
    check("thread: it is a window off the END, not the start", bodies[0] === `comment #${JIRA_TOTAL - JIRA_PAGE}`, String(bodies[0]));
    check("thread: the window is the deployment's page size", bodies.length === JIRA_PAGE, bodies.length);
    // (c). The panel says "showing 20 of 63" only if the 63 survives the route.
    check("thread: commentCount is the tracker's total", ticket?.commentCount === JIRA_TOTAL, String(ticket?.commentCount));
    check("thread: count and window really do differ", (ticket?.comments?.length ?? 0) < (ticket?.commentCount ?? 0), `${ticket?.comments?.length}/${ticket?.commentCount}`);
    check("thread: authorship survives the route", ticket?.comments?.some((c) => c.author === "Ashley") === true, JSON.stringify(ticket?.comments?.[0]));
    check("thread: timestamps survive the route", !!ticket?.comments?.[0]?.createdAt, String(ticket?.comments?.[0]?.createdAt));
    // (e). Two rungs up: SRE-1 → SRE-2 (task) → SRE-3 (epic).
    check("thread: the epic two rungs up comes back", ticket?.epic?.key === "SRE-3", JSON.stringify(ticket?.epic));
    // (f)'s other half, named rather than assumed: this is what the thread cost.
    check("thread: it cost 3 upstream requests (issue, tail, one rung)", hits.length === 3, hits.join(" "));
  }

  {
    // A thread the tracker counts and won't hand over. The panel has to say so
    // — "63 comments, none retrieved" is a different fact from "no comments",
    // and rendering them the same way is DRY-55's failure one surface over.
    failNext = /\/comment\?/;
    const { ticket } = await open("SRE-1", true);
    failNext = undefined;
    check("a failed tail keeps the page in hand", (ticket?.comments?.length ?? 0) === JIRA_PAGE, String(ticket?.comments?.length));
    check("a failed tail keeps the real total", ticket?.commentCount === JIRA_TOTAL, String(ticket?.commentCount));
  }

  {
    const { ticket } = await open("SRE-42", true);
    check("an empty thread is reported as zero, not as absent", ticket?.commentCount === 0 && ticket?.comments?.length === 0, `${ticket?.commentCount}/${ticket?.comments?.length}`);
    check("an orphan has no epic", ticket?.epic === undefined, JSON.stringify(ticket?.epic));
  }

  {
    // (g). Deliberately uncached: the panel is opened BECAUSE somebody wants to
    // know whether the ticket changed under them.
    await open("SRE-1", true);
    const first = hits.length;
    await open("SRE-1", true);
    check("a second open reaches the tracker again", hits.length === first && first > 0, `${first} then ${hits.length}`);
  }
  await stopDaemon();
}

// --- Switchyard --------------------------------------------------------------

console.log("\n--- switchyard ---");
if (!(await startDaemon("switchyard"))) {
  console.log("  FAIL  the daemon never came up\n", daemonLog.join("").slice(-800));
  failures++;
  await stopDaemon(); // see the jira round
} else {
  const info = (await (await fetch(`${DAEMON}/api/tracker/info`)).json()) as { id?: string };
  check("the daemon really is on the Switchyard provider", info.id === "switchyard", String(info.id));

  {
    const { ticket } = await open("DRY-90", false);
    check("no thread: the description still arrives", !!ticket?.description, ticket?.description);
    check("no thread: no comments", ticket?.comments === undefined, JSON.stringify(ticket?.comments));
    check("no thread: no epic", ticket?.epic === undefined, JSON.stringify(ticket?.epic));
    // The one that pays for the drawer staying on this path: the ancestry walk
    // is what `{thread: true}` really costs here, and without it there is none.
    check("no thread: ONE upstream request, no ancestry walk", hits.length === 1, hits.join(" "));
  }

  {
    const { ticket } = await open("DRY-90", true);
    const bodies = (ticket?.comments ?? []).map((c) => c.body);
    check("thread: comments arrive", bodies.length > 0, JSON.stringify(bodies));
    check("thread: the newest is last", bodies.at(-1) === "actually do Y", String(bodies.at(-1)));
    // (d). Both directions: not shown, and not counted.
    check("thread: a tombstone is not shown", !bodies.some((b) => b.includes("retracted")), JSON.stringify(bodies));
    check("thread: a tombstone is not counted", ticket?.commentCount === 2, String(ticket?.commentCount));
    check("thread: a whitespace-only comment is dropped too", bodies.length === 2, JSON.stringify(bodies));
    check("thread: the epic two rungs up comes back", ticket?.epic?.key === "DRY-1", JSON.stringify(ticket?.epic));
    check("thread: the bare parent UUID resolved to a key", ticket?.parent?.key === "DRY-49", JSON.stringify(ticket?.parent));
    check("thread: it cost 3 upstream requests (ticket + two rungs)", hits.length === 3, hits.join(" "));
  }

  {
    // The ancestry walk is decoration; losing it must not cost the thread the
    // panel is opened for. (The providers swallow this on purpose — DRY-53.)
    failNext = /uuid-task/;
    const { ticket } = await open("DRY-90", true);
    failNext = undefined;
    check("a failed walk still delivers the comments", (ticket?.comments?.length ?? 0) === 2, String(ticket?.comments?.length));
    check("a failed walk still delivers the description", !!ticket?.description, ticket?.description);
    check("a failed walk leaves the epic unset rather than wrong", ticket?.epic === undefined, JSON.stringify(ticket?.epic));
  }
  await stopDaemon();
}

stub.close();
fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} of ${ran} FAILED` : `all ${ran} passed`}`);
process.exit(failures ? 1 : 0);
