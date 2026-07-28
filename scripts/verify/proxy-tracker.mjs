// Tracker-outage proxy for the sidebar (DRY-55 verification).
//
// Sits in front of a throwaway daemon and 502s `/api/tracker/tickets` on
// command while everything else — /api/tracker/info, /api/sessions,
// /api/workspace, the attach WebSocket — keeps working. That asymmetry IS the
// shape of the failure: the daemon is fine and says so on every other route, so
// nothing in the desk goes red, and the one surface that went quiet is the one
// the ticket is about.
//
// Deliberately narrower than proxy-http.mjs, which breaks the state store.
// Sharing one proxy would mean either a path parameter on a harness three other
// scripts depend on, or a mode matrix where the two outages are independent.
// They're separate concerns and this is twenty lines.
//
// Note `/api/tracker/info` stays UP while broken, and that's realistic rather
// than convenient: neither provider touches the tracker to answer it (it's
// host config), so a real Switchyard/Jira outage leaves the sidebar knowing
// exactly whose name to put in the error.
//
// Control: POST /__break , POST /__heal , GET /__state
import http from "node:http";
import net from "node:net";

const LISTEN = Number(process.env.PROXY_PORT ?? 4375);
const TARGET = Number(process.env.TARGET_PORT ?? 4374);
const BREAK_PATH = process.env.BREAK_PATH ?? "/api/tracker/tickets";

let broken = false;
let blocked = 0;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/__break") {
    broken = true;
    blocked = 0;
    return json(200, { broken });
  }
  if (url.pathname === "/__heal") {
    broken = false;
    return json(200, { broken });
  }
  if (url.pathname === "/__state") return json(200, { broken, blocked });

  // Answered whatever the mode. A partitioned tracker does not break the
  // daemon's CORS negotiation, and failing the preflight would stop the browser
  // ever sending the request — see proxy-http.mjs, which paid a debugging
  // session for this.
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (broken && url.pathname === BREAK_PATH) {
    blocked++;
    // Same body the daemon's own catch produces (server.ts), because the shell
    // renders `error` from it — a bare 502 would under-test the message.
    return json(502, { error: "tracker unreachable: partitioned by proxy" });
  }

  const upstream = http.request(
    { host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => json(502, { error: `proxy: ${err.message}` }));
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
  console.log(`[proxy-tracker] :${LISTEN} → :${TARGET}, 502s ${BREAK_PATH} while broken`);
});
