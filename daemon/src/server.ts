import * as http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG } from "./config.js";
import { SessionManager } from "./manager.js";
import type { ClientMessage } from "./protocol.js";
import { createTracker, trackerInfo } from "./tracker/index.js";

const manager = new SessionManager();
const tracker = createTracker();

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Dev shell runs on a different origin (Vite). Localhost-only daemon, so
    // a permissive CORS policy is fine here.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Drydock-Session",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "OPTIONS") return send(res, 204, {});
    if (pathname === "/healthz") return send(res, 200, { ok: true, sessions: manager.list().length });

    // --- Session control API ---
    if (pathname === "/api/sessions" && req.method === "GET") {
      return send(res, 200, { sessions: manager.list().map((s) => s.info()) });
    }

    if (pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.command || typeof body.command !== "string") {
        return send(res, 400, { error: "command is required" });
      }
      const session = manager.create({
        command: body.command,
        args: Array.isArray(body.args) ? body.args : [],
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        cols: typeof body.cols === "number" ? body.cols : undefined,
        rows: typeof body.rows === "number" ? body.rows : undefined,
      });
      return send(res, 201, { session: session.info() });
    }

    const killMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/kill$/);
    if (killMatch && req.method === "POST") {
      manager.remove(killMatch[1]);
      return send(res, 200, { ok: true });
    }

    // --- Tracker API (DRY-10) ---
    // The shell's sidebar + Ctrl+K palette read from here, never from the
    // tracker directly. Credentials stay host-side in the provider.
    if (pathname === "/api/tracker/info" && req.method === "GET") {
      return send(res, 200, trackerInfo(tracker));
    }

    if (pathname === "/api/tracker/tickets" && req.method === "GET") {
      try {
        const tickets = await tracker.listTickets({
          project: url.searchParams.get("project") ?? undefined,
          open: url.searchParams.get("open") === "true",
          text: url.searchParams.get("text") ?? undefined,
        });
        return send(res, 200, { tickets });
      } catch (err) {
        return send(res, 502, { error: `tracker: ${String(err)}` });
      }
    }

    if (pathname === "/api/tracker/search" && req.method === "GET") {
      try {
        const tickets = await tracker.searchTickets(url.searchParams.get("q") ?? "");
        return send(res, 200, { tickets });
      } catch (err) {
        return send(res, 502, { error: `tracker: ${String(err)}` });
      }
    }

    const ticketMatch = pathname.match(/^\/api\/tracker\/ticket\/([^/]+)$/);
    if (ticketMatch && req.method === "GET") {
      try {
        const ticket = await tracker.getTicket(decodeURIComponent(ticketMatch[1]));
        return send(res, 200, { ticket });
      } catch (err) {
        return send(res, 404, { error: `tracker: ${String(err)}` });
      }
    }

    // --- PreToolUse hook endpoint ---
    // The wrapped CLI's hook POSTs its JSON payload here and blocks on the
    // response. We hold the connection open until a human approves/denies in the
    // UI, then answer with Claude Code's hookSpecificOutput schema. On our own
    // timeout we return an empty body so the CLI defers to its normal prompt.
    if (pathname === "/hook/pretooluse" && req.method === "POST") {
      const sessionId =
        (req.headers["x-drydock-session"] as string | undefined) ?? "";
      const session = manager.get(sessionId);
      const body = await readJson(req);
      if (!session) {
        return send(res, 404, { error: `unknown session ${sessionId}` });
      }
      const tool = body.tool_name ?? "unknown";
      const decision = await session.requestPermission(tool, body.tool_input ?? {});
      if (decision === "timeout") {
        return send(res, 200, {}); // defer to the CLI's own prompt
      }
      return send(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason:
            decision === "allow"
              ? "Approved in Drydock"
              : "Denied in Drydock",
        },
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err) });
  }
});

// --- WebSocket attach ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attach$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const session = manager.get(match[1]);
  if (!session) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.attach(ws);
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "input":
          session.write(msg.data);
          break;
        case "resize":
          session.resize(msg.cols, msg.rows);
          break;
        case "permission":
          session.resolvePermission(msg.requestId, msg.decision);
          break;
      }
    });
    ws.on("close", () => session.detach(ws as WebSocket));
  });
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[drydock] daemon listening on http://${CONFIG.host}:${CONFIG.port}`);
});
