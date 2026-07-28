// getTicket against stub Jira and Switchyard instances (DRY-53).
//
//   (cd daemon && node --import tsx ../scripts/verify/tracker-getticket.mts)
//
// Both providers grew a comment thread and a walk up to the nearest epic, and
// both have a shape the live tracker here can't show:
//
//   - Switchyard's GET /v1/tickets/:key returns `parent_id` (a UUID) with
//     `parent: null` beside it, while the LIST endpoint hydrates the parent —
//     so the one path that feeds a spawned agent is the one that has to resolve
//     it itself. There is also no three-rung chain in the DRY project to walk.
//   - Jira pages the `comment` field OLDEST first. A deployment that returns a
//     short page therefore hands back the wrong end of the thread, which is the
//     window that misleads rather than merely omits. There's no Jira to test
//     against here, so this asserts on the REQUESTS the provider makes.
//
// Everything here is in-process against a throwaway http server: no daemon, no
// credentials, no network.

import * as http from "node:http";
import { JiraProvider } from "../../daemon/src/tracker/jira.js";
import { SwitchyardProvider } from "../../daemon/src/tracker/switchyard.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : `\n        ${JSON.stringify(detail)}`}`);
}

console.log("--- jira ---");
{
  const seen: string[] = [];
  let failNext: RegExp | undefined;

  const issue = (key: string, type: string, parent?: { key: string; type: string }) => ({
    key,
    fields: {
      summary: `${key} summary`,
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: type },
      project: { key: "SRE" },
      parent: parent
        ? { key: parent.key, fields: { summary: `${parent.key} summary`, issuetype: { name: parent.type } } }
        : null,
    },
  });

  // key -> [issue, commentTotal]
  const WORLD: Record<string, [any, number]> = {
    // subtask two rungs under its epic, on a 63-comment thread
    "SRE-1": [issue("SRE-1", "Sub-task", { key: "SRE-2", type: "Task" }), 63],
    "SRE-2": [issue("SRE-2", "Task", { key: "SRE-3", type: "Epic" }), 0],
    "SRE-3": [issue("SRE-3", "Epic"), 0],
    // task directly under an epic, short thread that arrives whole
    "SRE-9": [issue("SRE-9", "Task", { key: "SRE-3", type: "Epic" }), 2],
    // orphan, no comments
    "SRE-42": [issue("SRE-42", "Task"), 0],
  };

  const PAGE = 20; // what this "deployment" returns inline with the issue

  function comments(total: number, startAt: number, want: number) {
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push(req.url!);
    if (failNext?.test(req.url!)) {
      res.writeHead(500).end("stub: deliberate failure");
      return;
    }
    const m = /^\/rest\/api\/2\/issue\/([^/?]+)/.exec(url.pathname);
    const entry = m ? WORLD[decodeURIComponent(m[1]!)] : undefined;
    if (!entry) {
      res.writeHead(404).end("no such issue");
      return;
    }
    const [iss, total] = entry;
    if (url.pathname.endsWith("/comment")) {
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const maxResults = Number(url.searchParams.get("maxResults") ?? 50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ startAt, maxResults, total, comments: comments(total, startAt, maxResults) }));
      return;
    }
    const fields = (url.searchParams.get("fields") ?? "").split(",");
    const body: any = { key: iss.key, fields: { ...iss.fields } };
    if (fields.includes("description")) body.fields.description = "the plan";
    if (fields.includes("comment")) {
      // The deployment behaviour that matters: a PAGE of the oldest comments.
      body.fields.comment = { startAt: 0, maxResults: PAGE, total, comments: comments(total, 0, PAGE) };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });


  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const jira = new JiraProvider({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });

  // --- 1. long thread on a subtask two rungs under its epic ---
  {
    seen.length = 0;
    const t = await jira.getTicket("SRE-1");
    check("issue GET asks for description + comment", /fields=[^&]*description[^&]*comment|fields=[^&]*comment/.test(seen[0]!), seen[0]);
    check("comment tail is fetched from the END", seen.some((u) => u.includes("/comment?startAt=43&maxResults=20")), seen);
    check("commentCount is the tracker's total, not the page", t.commentCount === 63, t.commentCount);
    check("kept comments are the NEWEST", t.comments?.[t.comments.length - 1]?.body === "comment #62", t.comments?.at(-1));
    check("kept comments are oldest-first within the window", t.comments?.[0]?.body === "comment #43", t.comments?.[0]);
    check("author + timestamp survive mapping", t.comments?.[0]?.author === "Ashley" && !!t.comments?.[0]?.createdAt, t.comments?.[0]);
    check("immediate parent is the task", t.parent?.key === "SRE-2", t.parent);
    check("epic resolves two rungs up", t.epic?.key === "SRE-3", t.epic);
    check("the epic itself is never fetched", !seen.some((u) => u.includes("/issue/SRE-3")), seen);
  }

  // --- 2. task directly under an epic: no walk, no tail fetch ---
  {
    seen.length = 0;
    const t = await jira.getTicket("SRE-9");
    check("short thread arrives whole (no tail fetch)", !seen.some((u) => u.includes("/comment?")), seen);
    check("whole thread is kept", t.comments?.length === 2 && t.commentCount === 2, [t.comments?.length, t.commentCount]);
    check("epic one rung up costs no extra request", t.epic?.key === "SRE-3" && seen.length === 1, [t.epic, seen]);
  }

  // --- 3. no parent, no comments ---
  {
    const t = await jira.getTicket("SRE-42");
    check("orphan has no epic", t.epic === undefined, t.epic);
    check("empty thread reports zero", t.comments?.length === 0 && t.commentCount === 0, [t.comments, t.commentCount]);
  }

  // --- 4. a failing tail fetch must not cost the ticket ---
  {
    failNext = /\/comment\?/;
    const t = await jira.getTicket("SRE-1");
    failNext = undefined;
    check("tail failure keeps the page we had", t.comments?.length === PAGE, t.comments?.length);
    check("tail failure keeps the real total", t.commentCount === 63, t.commentCount);
    check("tail failure doesn't cost the description", t.description === "the plan", t.description);
  }

  // --- 5. a failing parent walk must not cost the ticket ---
  {
    failNext = /\/issue\/SRE-2\?/;
    const t = await jira.getTicket("SRE-1");
    failNext = undefined;
    check("parent-walk failure leaves epic unset", t.epic === undefined, t.epic);
    check("parent-walk failure keeps parent + description", t.parent?.key === "SRE-2" && t.description === "the plan", [t.parent, t.description]);
    check("parent-walk failure keeps the comments", (t.comments?.length ?? 0) > 0, t.comments?.length);
  }

  server.close();
}

console.log("\n--- switchyard ---");
{
  const ID = {
    sub: "uuid-sub",
    task: "uuid-task",
    epic: "uuid-epic",
    epicUnder: "uuid-epic-under",
    initiative: "uuid-initiative",
  };
  const WORLD: Record<string, any> = {
    [ID.sub]: {
      id: ID.sub, key: "DRY-90", title: "the subtask", type: "subtask",
      status: { category: "in_progress", display_name: "In Progress" },
      project: { key: "DRY" }, description: "the plan",
      parent_id: ID.task, parent: null, // <- the quirk
      comments: [
        { body: "first", author: { name: "claude" }, created_at: "2026-07-01 10:00:00+00" },
        { body: "[deleted]", author: { name: "claude" }, created_at: "2026-07-02 10:00:00+00", deleted: true },
        { body: "   ", author: { name: "claude" }, created_at: "2026-07-03 10:00:00+00" },
        { body: "last", author: { name: "Ashley" }, created_at: "2026-07-04 10:00:00+00" },
      ],
    },
    [ID.task]: {
      id: ID.task, key: "DRY-49", title: "the task", type: "task",
      status: { category: "in_progress", display_name: "In Progress" },
      project: { key: "DRY" }, parent_id: ID.epic, parent: null, comments: [],
    },
    [ID.epic]: {
      id: ID.epic, key: "DRY-1", title: "the epic", type: "epic",
      status: { category: "in_progress", display_name: "In Progress" },
      project: { key: "DRY" }, parent_id: null, parent: null, comments: [],
    },
    // An epic under an initiative — Jira's third rung. It should still name its
    // parent (Jira's provider does, reading it off the issue) and stop there.
    [ID.epicUnder]: {
      id: ID.epicUnder, key: "DRY-12", title: "epic under an initiative", type: "epic",
      status: { category: "in_progress", display_name: "In Progress" },
      project: { key: "DRY" }, parent_id: ID.initiative, parent: null, comments: [],
    },
    [ID.initiative]: {
      id: ID.initiative, key: "DRY-0", title: "the initiative", type: "initiative",
      status: { category: "in_progress", display_name: "In Progress" },
      project: { key: "DRY" }, parent_id: null, parent: null, comments: [],
    },
  };
  WORLD["DRY-90"] = WORLD[ID.sub];
  WORLD["DRY-1"] = WORLD[ID.epic];
  WORLD["DRY-12"] = WORLD[ID.epicUnder];

  const seen: string[] = [];
  let failNext: RegExp | undefined;
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    if (failNext?.test(req.url!)) return void res.writeHead(500).end("stub: deliberate failure");
    const m = /^\/v1\/tickets\/([^/?]+)$/.exec(new URL(req.url!, "http://x").pathname);
    const t = m ? WORLD[decodeURIComponent(m[1]!)] : undefined;
    if (!t) return void res.writeHead(404).end("no such ticket");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(t));
  });


  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const swy = new SwitchyardProvider({ baseUrl: `http://127.0.0.1:${port}`, token: "t" });

  {
    seen.length = 0;
    const t = await swy.getTicket("DRY-90");
    check("parent resolved from a bare UUID", t.parent?.key === "DRY-49", t.parent);
    check("parent carries its title and type", t.parent?.title === "the task" && t.parent?.type === "task", t.parent);
    check("epic resolved two rungs up", t.epic?.key === "DRY-1" && t.epic?.title === "the epic", t.epic);
    check("costs exactly one GET per rung", seen.length === 3, seen);
    check("deleted comment is dropped", !t.comments?.some((c) => c.body === "[deleted]"), t.comments);
    check("blank comment is dropped", t.comments?.length === 2, t.comments);
    check("count excludes what was dropped", t.commentCount === 2, t.commentCount);
    check("thread stays oldest-first", t.comments?.[0]?.body === "first" && t.comments?.[1]?.body === "last", t.comments);
  }

  {
    seen.length = 0;
    const t = await swy.getTicket("DRY-1");
    check("an epic looks for no epic above it", t.epic === undefined, t.epic);
    check("an epic with no parent stops at one request", seen.length === 1, seen);
  }

  {
    seen.length = 0;
    const t = await swy.getTicket("DRY-12");
    check("an epic still names its own parent", t.parent?.key === "DRY-0", t.parent);
    check("...and doesn't climb past it", t.epic === undefined && seen.length === 2, [t.epic, seen]);
  }

  {
    failNext = /uuid-task/;
    const t = await swy.getTicket("DRY-90");
    failNext = undefined;
    check("a failed walk leaves parent+epic unset", t.parent === undefined && t.epic === undefined, [t.parent, t.epic]);
    check("a failed walk keeps description + comments", t.description === "the plan" && t.comments?.length === 2, [t.description, t.comments?.length]);
  }

  {
    failNext = /uuid-epic/;
    const t = await swy.getTicket("DRY-90");
    failNext = undefined;
    check("a walk failing mid-climb keeps the rung it reached", t.parent?.key === "DRY-49" && t.epic === undefined, [t.parent, t.epic]);
  }

  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
