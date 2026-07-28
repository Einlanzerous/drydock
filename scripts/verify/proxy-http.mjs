// Partition proxy for the DAEMON's HTTP surface (DRY-58 verification).
//
// Sits in front of a throwaway daemon and can make /api/workspace fail on
// command while everything else — /api/sessions, the attach WebSocket, SSE —
// keeps working. That is the shape the ticket is about: the daemon is fine, its
// state store isn't, and the desk has to notice and then un-notice.
//
// Three failure modes, because they are not the same test:
//   503   what a real degraded store returns (routes catch and answer 503)
//   hang  accept-and-go-silent, which is what a network partition feels like
//         and what `docker stop` can never reproduce (CLAUDE.md)
//   delay the first /api/workspace WRITE is held for DELAY_MS and then forwarded
//         normally — it SUCCEEDS, late — while everything behind it 503s.
//
// `delay` exists because `hang` cannot express the recovery race: a slow push
// that ultimately succeeds, overlapping a fast failure behind it. Healing a
// `hang` destroys the parked socket, and the browser then silently retries the
// request on a fresh connection (PUT is idempotent, so Chrome will), which
// makes BOTH writes succeed in an order the test doesn't control — and a test
// that can't tell which write won can't test which write should have.
//
// Control: POST /__break?mode=503|hang|delay , POST /__heal , GET /__state
import http from "node:http";
import net from "node:net";

const LISTEN = Number(process.env.PROXY_PORT ?? 4398);
const TARGET = Number(process.env.TARGET_PORT ?? 4399);
const DELAY_MS = Number(process.env.DELAY_MS ?? 6000);

let mode = "ok"; // "ok" | "503" | "hang" | "delay"
const held = new Set(); // sockets parked by "hang", released on heal
let delayed = 0; // how many writes "delay" has held and forwarded

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  if (url.pathname === "/__break") {
    const m = url.searchParams.get("mode");
    mode = m === "hang" || m === "delay" ? m : "503";
    if (mode === "delay") delayed = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ mode }));
  }
  if (url.pathname === "/__heal") {
    mode = "ok";
    for (const s of held) s.destroy();
    held.clear();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ mode }));
  }
  if (url.pathname === "/__state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ mode, held: held.size, delayed }));
  }

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (url.pathname === "/api/workspace") {
    // VERBOSE=1 prints every workspace request. Worth having: when a harness
    // says a push never arrived, the question is always "was it never sent, or
    // never seen", and only one of those is a product bug.
    if (process.env.VERBOSE) console.log(`[proxy-http] ${req.method} ${url.pathname} mode=${mode}`);
  }

  // Preflights are answered whatever the mode, and this is load-bearing rather
  // than tidy. The shell is cross-origin (vite :5370 → the daemon's port), and
  // a PUT carrying Content-Type: application/json is not CORS-safelisted, so
  // the browser sends OPTIONS first. Failing that preflight means it never
  // sends the PUT at all — the proxy sees no write, the harness sees no push,
  // and a working retry loop looks like a broken one. A partitioned STORE does
  // not break CORS negotiation; the daemon answers OPTIONS from its own route
  // either way. This cost a debugging session: `delay` mode saw nothing but
  // OPTIONS, and `503` mode only worked at all because the browser was caching
  // an earlier successful preflight.
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (url.pathname === "/api/workspace" && mode !== "ok") {
    if (mode === "hang") {
      // Never answer, never close. The client's own budget is the only thing
      // that can save it — 3s on the read, 12s on a write (lib/daemon.ts) —
      // which is what makes this the case that finds a missing one.
      held.add(req.socket);
      req.socket.on("close", () => held.delete(req.socket));
      return;
    }
    if (mode === "delay" && req.method === "PUT" && delayed === 0) {
      // Buffer the body first: `req` is a stream, and by the time the timer
      // fires there is nothing left to pipe.
      delayed = 1;
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        setTimeout(() => forward(req, res, Buffer.concat(chunks), cors), DELAY_MS);
      });
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json", ...cors });
    return res.end(JSON.stringify({ error: "state store: partitioned by proxy", degraded: true }));
  }

  forward(req, res, null, cors);
});

/** Pass a request upstream. `body` non-null means it was already buffered. */
function forward(req, res, body, cors) {
  const upstream = http.request(
    { host: "127.0.0.1", port: TARGET, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: `proxy: ${err.message}` }));
  });
  if (body === null) req.pipe(upstream);
  else upstream.end(body);
}

// The terminal panes attach over WS; without this every pane errors and the
// console noise buries the thing we're actually watching for.
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
  console.log(`[proxy-http] :${LISTEN} → :${TARGET}  (POST /__break?mode=503|hang, /__heal)`);
});
