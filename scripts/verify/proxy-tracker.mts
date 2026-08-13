// Tracker-outage proxy for the sidebar (DRY-55 verification).
//
// Sits in front of a throwaway daemon and breaks `/api/tracker/tickets` on
// command while everything else — /api/tracker/info, /api/sessions,
// /api/workspace, the attach WebSocket — keeps working. That asymmetry IS the
// shape of the failure: the daemon is fine and says so on every other route, so
// nothing in the desk goes red, and the one surface that went quiet is the one
// the ticket is about.
//
// Deliberately narrower than proxy-http.mts, which breaks the state store.
// Sharing one proxy would mean either a path parameter on a harness three other
// scripts depend on, or a mode matrix where the two outages are independent.
// They're separate concerns, and the modes below aren't the same modes.
//
// `/api/tracker/info` stays UP in every mode but `skew`, and that default is
// realistic rather than convenient: neither provider touches the tracker to
// answer it (it's host config), so a real Switchyard/Jira outage leaves the
// sidebar knowing exactly whose name to put in the error. `skew` is the case
// where it doesn't.
//
// Four failure modes, because they are not the same test:
//   502   a tracker that REFUSES — the daemon's provider throws, its route
//         catches, and the shell gets an error body promptly.
//   hang  accept-and-go-silent, which is what a partition feels like and what
//         `docker stop` can never reproduce (CLAUDE.md). Neither provider's
//         `req()` carries a deadline, so the daemon's route never answers
//         either — the shell's own budget is the only thing that can end it.
//         The mode a 502-only proxy structurally cannot see.
//   huge  a 502 whose body is kilobytes. Both providers build their error as
//         `${res.status} ${await res.text()}`, so a Jira behind a proxy that
//         answers with an HTML error page puts the whole page in the message.
//         Renders as a wall unless the sidebar caps it.
//   skew  tickets 502 AND `/api/tracker/info` 404s — a shell newer than its
//         daemon, which docs/deploy.md makes routine for the length of a
//         partial deploy (DRY-51). The one case where the shell does NOT know
//         which tracker it is talking to, so the outage copy must not guess:
//         `providerName` defaults to "Switchyard" and would otherwise name it
//         on a host running Jira.
//
// Control: POST /__break?mode=502|hang|huge|skew , POST /__heal , GET /__state
//
// Run from `daemon/`, where tsx resolves (DRY-80):
//   (cd daemon && node --import tsx ../scripts/verify/proxy-tracker.mts)
import http from "node:http";
import net from "node:net";

const LISTEN = Number(process.env.PROXY_PORT ?? 4375);
const TARGET = Number(process.env.TARGET_PORT ?? 4374);
const BREAK_PATH = process.env.BREAK_PATH ?? "/api/tracker/tickets";

type Mode = "ok" | "502" | "hang" | "huge" | "skew";

let mode: Mode = "ok";
let blocked = 0;
/** Sockets parked by "hang", released on heal. */
const held = new Set<net.Socket>();

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/__break") {
    const m = url.searchParams.get("mode");
    mode = m === "hang" || m === "huge" || m === "skew" ? m : "502";
    blocked = 0;
    return json(200, { mode });
  }
  if (url.pathname === "/__heal") {
    mode = "ok";
    for (const s of held) s.destroy();
    held.clear();
    return json(200, { mode });
  }
  // `blocked` is the answer to "was the request never SENT, or sent and
  // rejected" — only one of those is a product bug, and the harness asserts on
  // it rather than inferring from the DOM alone.
  if (url.pathname === "/__state") return json(200, { mode, blocked, held: held.size });

  // Answered whatever the mode. A partitioned tracker does not break the
  // daemon's CORS negotiation, and failing the preflight would stop the browser
  // ever sending the request — see proxy-http.mts, which paid a debugging
  // session for this.
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  // Only in `skew`: every other mode leaves info UP, which is the realistic
  // default (neither provider touches the tracker to answer it).
  if (mode === "skew" && url.pathname === "/api/tracker/info") {
    blocked++;
    return json(404, { error: "not found" });
  }

  if (mode !== "ok" && url.pathname === BREAK_PATH) {
    blocked++;
    if (mode === "hang") {
      // Never answer, never close. The shell's own budget (LIST_TIMEOUT_MS in
      // lib/tracker.ts) is the only thing that can end this, which is what
      // makes it the mode that finds a missing one.
      held.add(req.socket);
      req.socket.on("close", () => held.delete(req.socket));
      return;
    }
    // Shaped like the daemon's own catch: server.ts sends
    // `{error: \`tracker: ${String(err)}\`}`, and the provider's Error text is
    // `${res.status} ${await res.text()}`. The shell prefixes
    // "daemon returned 502: " on top. Reproduced rather than approximated,
    // because what's being tested IS the message.
    const upstreamBody = mode === "huge" ? `<html>${"<p>gateway timeout</p>".repeat(400)}</html>` : "partitioned by proxy";
    return json(502, { error: `tracker: Error: jira /search/jql -> 502 ${upstreamBody}` });
  }

  const upstream = http.request(
    { host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  // Guarded: an upstream that dies AFTER the response started has already had
  // its head written, and writeHead again throws ERR_HTTP_HEADERS_SENT — which
  // takes the proxy down mid-run and reads as a product failure.
  upstream.on("error", (err) => {
    if (res.headersSent) return res.destroy();
    json(502, { error: `proxy: ${err.message}` });
  });
  // A client that goes away mid-body (page navigation, browser close — both
  // routine here) emits `error` on `req`; unhandled, that's a process-killing
  // throw rather than a dropped request.
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
});

// Panes attach over WS; without this every pane errors and the console noise
// buries whatever we're actually watching for.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(TARGET, "127.0.0.1", () => {
    up.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(LISTEN, "127.0.0.1", () => {
  console.log(`[proxy-tracker] :${LISTEN} → :${TARGET}, breaks ${BREAK_PATH} on /__break`);
});
