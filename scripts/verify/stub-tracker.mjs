// A Switchyard-shaped tracker the daemon can actually talk to (DRY-72
// verification), with controls and — the reason it exists — REQUEST COUNTERS.
//
// Every other tracker harness here stubs at a layer above this one:
// proxy-tracker.mjs sits between the browser and the daemon, so it can break
// `/api/tracker/tickets` but never sees what the daemon does upstream. DRY-72's
// claims are entirely about upstream: that N browser polls become one fan-out,
// that a child-stats query doesn't repeat every 20s, that the daemon keeps
// answering when the tracker stops. None of that is visible from the shell's
// side of the daemon, and `docker stop`-style reasoning can't measure it — the
// only honest probe is an origin that counts what arrives.
//
// Deliberately a Switchyard shape rather than a Jira one: it's the smaller API
// (no Cloud/DC search split, no JQL to parse) and the child-stats path it
// exercises is the WORSE of the two — one request per epic instead of Jira's
// one for all of them — so a cache regression shows up bigger here.
//
// Control surface:
//   POST /__break?mode=502|hang   tracker refuses / accepts and goes silent
//   POST /__heal                  back to normal, releases parked sockets
//   POST /__latency?ms=N          every response delayed by N ms
//   POST /__reset                 zero the counters (not the mode)
//   GET  /__state                 {mode, latencyMs, list, epicList, children, total}
import http from "node:http";

const PORT = Number(process.env.STUB_PORT ?? 4386);

let mode = "ok";
let latencyMs = 0;
const counts = { list: 0, epicList: 0, children: 0, total: 0 };
const held = new Set();
// Requests the daemon has open right now. Reported but never reset: it's what
// lets a harness wait for a BACKGROUND refresh to land before asserting on
// counts. Counting alone can't — under latency there's a gap between a
// provider's sequential queries where the totals sit still, and a "has it
// stopped changing" probe reads that as finished.
let inflight = 0;

// One epic with two children (one of them closed, so childStats has something
// to break down), plus loose tickets. Small on purpose: the assertions are
// about how MANY requests arrive, not how many rows come back.
const TICKETS = [
  {
    id: "e1",
    key: "DRY-1",
    title: "Cache the tracker pull",
    type: "epic",
    status: { category: "in_progress", display_name: "In Progress" },
  },
  {
    id: "t2",
    key: "DRY-2",
    title: "Coalesce concurrent pulls",
    type: "task",
    status: { category: "in_progress", display_name: "In Progress" },
    parent_id: "e1",
    parent: { key: "DRY-1", title: "Cache the tracker pull" },
  },
  {
    id: "t3",
    key: "DRY-3",
    title: "Deadline every request",
    type: "task",
    status: { category: "closed", display_name: "Done" },
    parent_id: "e1",
    parent: { key: "DRY-1", title: "Cache the tracker pull" },
  },
  {
    id: "t4",
    key: "DRY-4",
    title: "Back the poll off",
    type: "task",
    status: { category: "blocked", display_name: "Blocked" },
  },
  {
    id: "t5",
    key: "DRY-5",
    title: "Skip the poll when hidden",
    type: "task",
    status: { category: "planning", display_name: "Planning" },
  },
];

const PROJECT = { key: "DRY", name: "Drydock", repo_url: null };
const withProject = (t) => ({ ...t, project: PROJECT, labels: [] });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // --- control plane (never broken, never counted) ---
  if (url.pathname === "/__break") {
    mode = url.searchParams.get("mode") ?? "502";
    return json(200, { mode });
  }
  if (url.pathname === "/__heal") {
    mode = "ok";
    for (const r of held) r.end();
    held.clear();
    return json(200, { mode });
  }
  if (url.pathname === "/__latency") {
    latencyMs = Number(url.searchParams.get("ms") ?? 0);
    return json(200, { latencyMs });
  }
  if (url.pathname === "/__reset") {
    for (const k of Object.keys(counts)) counts[k] = 0;
    return json(200, counts);
  }
  if (url.pathname === "/__state") return json(200, { mode, latencyMs, inflight, ...counts });

  // --- the tracker itself ---
  counts.total++;
  inflight++;
  res.on("close", () => inflight--);
  const parentId = url.searchParams.get("parent_id");
  const type = url.searchParams.get("type");
  // Counted apart because they answer different questions. `children` is the
  // unbounded half DRY-72 puts on a long TTL; a regression there shows up as
  // this climbing with every poll while `list` behaves.
  if (parentId) counts.children++;
  else if (type === "epic") counts.epicList++;
  else counts.list++;

  if (mode === "hang") {
    // Accept and go silent — the partition shape, and the one a refusing stub
    // structurally cannot produce. Parked until /__heal so the socket is held
    // open rather than reset.
    held.add(res);
    req.on("close", () => held.delete(res));
    return;
  }
  if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
  if (mode === "502") return json(502, { error: "stub tracker is broken" });

  if (url.pathname === "/v1/projects") return json(200, { items: [PROJECT] });
  if (url.pathname !== "/v1/tickets") return json(404, { error: "no such path" });

  const statuses = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
  const rows = TICKETS.filter((t) => {
    if (parentId) return t.parent_id === parentId;
    if (type && t.type !== type) return false;
    if (statuses.length && !statuses.includes(t.status.category)) return false;
    return true;
  });
  // No pagination: one page, no cursor. The cap/truncation path has its own
  // coverage in CLAUDE.md's provider checklist and isn't what this file is for.
  return json(200, { items: rows.map(withProject), page: { next_cursor: null } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`stub tracker on :${PORT} (Switchyard-shaped, counting)`);
});
