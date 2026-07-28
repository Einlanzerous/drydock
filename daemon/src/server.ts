import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG, PERMISSION_MODES, type PermissionMode } from "./config.js";
import { describe, log, type LogFields } from "./log.js";
import { SessionManager } from "./manager.js";
import type { SpawnOptions } from "./session.js";
import { expandHome, resolveRepoCwd } from "./repos.js";
import { sessionsDir } from "./sessions-dir.js";
import {
  ensureWorktree,
  isGitWorkTree,
  planWorktree,
  removeWorktree,
  worktreeExists,
} from "./worktree.js";
import type { ClientMessage, EventMessage } from "./protocol.js";
import { createTracker, trackerInfo } from "./tracker/index.js";
import { createStore } from "./state/index.js";
import { runEndHandler } from "./runs.js";

const manager = new SessionManager();
const tracker = createTracker();
const store = createStore();

// An autonomous run that reaches a terminal state leaves a handoff document
// and (capability permitting) a tracker comment behind (DRY-49). Subscribed
// here rather than inside the session so PtySession keeps knowing nothing about
// trackers or the filesystem.
manager.onRunEnd(runEndHandler(tracker));

// Permission modes where Claude Code runs tools without asking. In these the
// PreToolUse hook still fires, but our approve/deny is moot — so we auto-allow
// rather than show a gate that wouldn't actually hold the tool back.
const HANDS_OFF_MODES = new Set(["bypassPermissions", "auto", "dontAsk"]);

/**
 * Tools `acceptEdits` waves through (DRY-49).
 *
 * Without this, offering acceptEdits would be a lie: the mode's whole meaning
 * is "don't ask me about file edits", but PreToolUse fires in every mode, so
 * Drydock would have raised its own gate for exactly the edits the user just
 * said to stop asking about — moving the interruption rather than removing it.
 * Bash and WebFetch still gate, which is the point of picking this over `auto`:
 * the tools that reach OUT of the worktree still stop.
 */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Dev shell runs on a different origin (Vite). Localhost-only daemon, so
    // a permissive CORS policy is fine here.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Drydock-Session",
    // PUT/DELETE are here for /api/workspace (DRY-28). Without them the
    // browser's preflight rejects the save and the shell silently degrades to
    // its local cache — which looks exactly like "the daemon isn't storing my
    // layout", with no error anywhere on the daemon side to explain it.
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Marker so the route can answer 413 instead of a generic 500. */
class PayloadTooLarge extends Error {}

/**
 * readJson with a hard ceiling (DRY-28). The control-API payloads are a few
 * hundred bytes, so readJson buffering whatever it's handed has never mattered;
 * /api/workspace is the first endpoint whose whole job is to accept a blob, and
 * it sits on a port with no authentication (see CONFIG.host). Stop at the cap
 * while reading rather than after allocating the whole thing.
 */
async function readJsonCapped(req: http.IncomingMessage, maxBytes: number): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new PayloadTooLarge(`workspace exceeds the ${maxBytes} byte cap`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "OPTIONS") return send(res, 204, {});
    if (pathname === "/healthz") {
      return send(res, 200, {
        // `ok` stays an answer about the DAEMON, not about everything it talks
        // to. A daemon whose workspace store is unreachable spawns, attaches
        // and replays perfectly well — reporting it as unhealthy would make
        // anything watching this endpoint act on a fault that costs nobody a
        // session. The store reports alongside instead, so a degraded one is
        // visible without being fatal. (DRY-48 is where this endpoint grows a
        // real opinion about internal state.)
        //
        // NB this probe can block for up to the pool's connect timeout when a
        // configured Postgres is down and its retry window is open. Nothing on
        // the deploy path waits on it — install-prod.sh polls /api/sessions —
        // but a monitor pointed here wants a timeout above 5s. Inside the
        // cooldown it answers immediately with `store.cooling` + `retryInMs`,
        // which is the difference between "the database is down" and "we're
        // waiting to find out" (DRY-58).
        ok: true,
        sessions: manager.list().length,
        store: await store.health(),
      });
    }

    // --- Shell-wide event stream (DRY-50) ---
    // One connection per browser tab, not per session. A pane's WebSocket dies
    // with the pane — that is precisely why a minimized window's gate used to
    // reach nobody — so the surface that must survive a minimize cannot be
    // per-session. SSE rather than a second WebSocket: the traffic is one-way
    // (answers go back over HTTP below), EventSource reconnects on its own, and
    // it costs no upgrade handshake to get wrong.
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Nginx buffers text/event-stream by default, holding events until the
        // buffer fills — a gate would surface minutes late, or never.
        //
        // NB nothing proxies this today: the prod shell container serves static
        // files only (no proxy_pass in shell/docker/nginx.conf) and the browser
        // reaches the daemon directly on :4318 (docs/deploy.md). This is cheap
        // insurance for the day something is put in front, not a description of
        // the current deployment — don't go hunting a proxy on the strength of
        // this header.
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      const write = (event: EventMessage): void => {
        // A client that has gone away mid-write must not throw into the gate
        // that was being announced. res.write on a destroyed socket can also
        // emit 'error' asynchronously — hence the listener below.
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // Catch-up: every gate already waiting, from the same snapshot the
      // per-pane replay uses. A tab opened *after* a gate was raised has to
      // learn about it, otherwise "reload the page" loses an unanswered gate.
      //
      // Sent as one authoritative snapshot rather than a burst of gate-opens.
      // A reconnecting client missed every gate-resolved that fired while it
      // was away, so anything it merges into is already wrong — it has to be
      // told the whole truth and replace what it had.
      write({
        type: "gate-snapshot",
        serverNow: Date.now(),
        gates: manager
          .list()
          .flatMap((session) =>
            session.pendingGates().map((gate) => ({ sessionId: session.id, gate })),
          ),
      });

      const unsubscribe = manager.onGate(write);
      // Load-bearing, same class as the pg pool listener in DRY-28 and the
      // socket handlers in DRY-45: an unhandled 'error' on this response throws,
      // and this process is the lifetime of every live PTY.
      res.on("error", (err) => {
        log.warn("event stream errored", describe(err));
        unsubscribe();
      });
      res.on("close", unsubscribe);

      // Comment frames keep proxies and phones from reaping an idle stream.
      // Unref'd so a quiet daemon can still exit.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 25_000);
      heartbeat.unref?.();
      res.on("close", () => clearInterval(heartbeat));
      return;
    }

    // Host policy the shell needs in order to describe itself honestly (DRY-49):
    // the launch panel says which posture a run will start in, and "the host
    // default" is only useful if it can name the value. Read-only, and
    // deliberately carries no credentials — everything here is already implied
    // by behaviour a client can observe.
    if (pathname === "/api/config" && req.method === "GET") {
      return send(res, 200, {
        autonomous: {
          permissionMode: CONFIG.autonomous.permissionMode,
          permissionTimeoutMs: CONFIG.autonomous.permissionTimeoutMs,
        },
      });
    }

    // --- Session control API ---
    if (pathname === "/api/sessions" && req.method === "GET") {
      return send(res, 200, { sessions: manager.list().map((s) => s.info()) });
    }

    // Answer a gate without holding that session's WebSocket (DRY-50). The
    // session id stays mandatory and in the path: this daemon is
    // unauthenticated, and while it already spawns arbitrary commands (DRY-27),
    // that is no reason to make someone else's gates answerable by guessing a
    // request id alone.
    const answerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/permission$/);
    if (answerMatch && req.method === "POST") {
      const session = manager.get(decodeURIComponent(answerMatch[1]));
      if (!session) return send(res, 404, { error: "unknown session" });
      // This route's contract is 400/404/409, so neither a parse failure nor a
      // body of literal `null` may escape as a 500 with a raw stack — `null`
      // parses fine and only becomes a TypeError at `body.decision`. Same trap
      // documented on /api/workspace below; the guard belongs on every route
      // that reaches into a parsed body.
      let body: any;
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, 400, { error: `invalid JSON body: ${String(err)}` });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(res, 400, { error: "body must be a JSON object" });
      }
      const decision = body.decision;
      if (decision !== "allow" && decision !== "deny") {
        return send(res, 400, { error: "decision must be 'allow' or 'deny'" });
      }
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      // "Always allow <Tool>" (DRY-49, deferred here from DRY-50). Recorded
      // BEFORE the gate is resolved: the agent's very next tool call can arrive
      // in the same tick as the hook response, and an allow-set updated after
      // the fact would gate it anyway — which reads as the button not working.
      //
      // Only meaningful alongside an allow; `deny` + `always` is incoherent (a
      // standing denial is just a tool the agent shouldn't have), so it's
      // ignored rather than honoured.
      if (body.always === true && decision === "allow") {
        const gate = session.pendingGates().find((g) => g.requestId === body.requestId);
        if (gate) session.allowTool(gate.tool);
      }
      // False means the gate is already gone — answered from a pane, timed out,
      // or the session exited. Not an error worth a 500; the caller raced and
      // the honest answer is "there is nothing here to answer".
      const resolved = session.resolvePermission(String(body.requestId ?? ""), decision, reason);
      return send(res, resolved ? 200 : 409, { ok: resolved });
    }

    // Take-over (DRY-49): a run stops being autonomous and becomes an ordinary
    // supervised session. One-way by design — see PtySession.takeOver — so
    // `autonomous: true` is refused rather than quietly ignored, which would
    // leave a caller believing it had put a session back on the rail.
    const autonomyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/autonomy$/);
    if (autonomyMatch && req.method === "POST") {
      const session = manager.get(decodeURIComponent(autonomyMatch[1]));
      if (!session) return send(res, 404, { error: "unknown session" });
      let body: any;
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, 400, { error: `invalid JSON body: ${String(err)}` });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(res, 400, { error: "body must be a JSON object" });
      }
      if (body.autonomous !== false) {
        return send(res, 400, {
          error: "only {autonomous:false} is supported — a session cannot be made autonomous",
        });
      }
      session.takeOver();
      return send(res, 200, { session: session.info() });
    }

    if (pathname === "/api/sessions" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.command || typeof body.command !== "string") {
        return send(res, 400, { error: "command is required" });
      }
      // cwd precedence: an explicit cwd wins; otherwise a ticket's repo name is
      // resolved to its real dir on this host (falling back to $HOME if unknown).
      let cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      if (!cwd && typeof body.repo === "string") {
        const r = resolveRepoCwd(body.repo);
        cwd = r.cwd;
        if (!r.matched) {
          log.warn("repo not found under repos root or overrides — spawning in fallback", {
            repo: body.repo,
            cwd: r.cwd,
          });
        }
      }
      const ticket = typeof body.ticket === "string" ? body.ticket : undefined;

      // Worktree isolation (DRY-15). A ticket-bound spawn in a git repo runs in
      // its own worktree/branch unless the client opts out (`worktree: false`)
      // or the daemon has it disabled. Explicit `worktree`(path)/`branch` strings
      // override the derived defaults. Any git hiccup falls back to the plain
      // cwd so a spawn never hard-fails on isolation.
      let worktree: string | undefined;
      let branch: string | undefined;
      const optOut = body.worktree === false;
      if (CONFIG.worktrees.enabled && !optOut && ticket && cwd && isGitWorkTree(cwd)) {
        try {
          const wt = ensureWorktree(cwd, ticket, {
            path: typeof body.worktree === "string" ? body.worktree : undefined,
            branch: typeof body.branch === "string" ? body.branch : undefined,
          });
          cwd = wt.cwd;
          worktree = wt.cwd;
          branch = wt.branch;
        } catch (err) {
          log.warn("worktree setup failed — spawning in the plain repo cwd", {
            ticket,
            cwd,
            err: String(err),
          });
        }
      }

      const spawnOpts: SpawnOptions = {
        command: body.command,
        args: Array.isArray(body.args) ? body.args : [],
        cwd,
        ticket,
        worktree,
        branch,
        title: typeof body.title === "string" ? body.title : undefined,
        cols: typeof body.cols === "number" ? body.cols : undefined,
        rows: typeof body.rows === "number" ? body.rows : undefined,
        // Autonomous runs (DRY-49). `origin` is validated rather than trusted
        // so a typo can't put an unrenderable value on every rail card;
        // "agent" is already accepted here even though nothing sends it yet —
        // that's the launch surface DRY-46/DRY-34 both need.
        autonomous: body.autonomous === true,
        origin: body.origin === "agent" ? "agent" : "you",
        input: typeof body.input === "string" && body.input.trim() ? body.input : undefined,
        // A whitelist, because this value becomes a spawn argument. An
        // autonomous run with nothing specified falls back to the HOST's
        // policy; a supervised one to `manual`, which is what it has always
        // been. An unrecognised value is ignored rather than rejected: it can
        // only ever loosen or tighten a run, and failing the spawn over it
        // would turn a typo into a session that never started.
        permissionMode: PERMISSION_MODES.has(body.permissionMode)
          ? (body.permissionMode as PermissionMode)
          : body.autonomous === true
            ? CONFIG.autonomous.permissionMode
            : "manual",
      };

      // Awaited since DRY-57: the session isn't real until its detached
      // supervisor has bound its socket, and answering 201 before then makes
      // the WebSocket the client opens next a race it can lose. A failure here
      // is a spawn that didn't happen — answered as one, rather than with an id
      // nothing can ever attach to.
      try {
        const session = await manager.create(spawnOpts);
        return send(res, 201, { session: session.info() });
      } catch (err) {
        log.error("spawn failed", { command: body.command, cwd, ticket, err: String(err) });
        return send(res, 500, { error: `spawn: ${String(err)}` });
      }
    }

    // Resolve a ticket's repo name to the cwd it would spawn in (DRY-12). Lets
    // the detail panel preview the working dir and flag a repo-less project
    // (matched=false → fell back to $HOME) so the user can override before spawn.
    // With `?ticket=`, also previews the DRY-15 worktree/branch the agent will
    // use: `git` says isolation is possible, `worktree`/`branch` are the planned
    // targets, and `worktreeExists` flags a reuse of a prior spawn's worktree.
    if (pathname === "/api/repos/resolve" && req.method === "GET") {
      const base = resolveRepoCwd(url.searchParams.get("repo") ?? undefined);
      const ticket = url.searchParams.get("ticket") ?? undefined;
      const git = isGitWorkTree(base.cwd);
      const out: Record<string, unknown> = { ...base, git };
      if (git && ticket && CONFIG.worktrees.enabled) {
        const plan = planWorktree(base.cwd, ticket);
        if (plan) {
          out.worktree = plan.path;
          out.branch = plan.branch;
          out.worktreeExists = worktreeExists(plan.path);
        }
      }
      return send(res, 200, out);
    }

    // Prune a worktree on demand (DRY-15 cleanup policy). Worktrees are kept on
    // session close; this is the explicit removal path — e.g. the panel's "Reset"
    // when reusing a stale worktree. The branch is left for the human to merge.
    if (pathname === "/api/worktrees/remove" && req.method === "POST") {
      const body = await readJson(req);
      const repoDir =
        typeof body.cwd === "string"
          ? body.cwd
          : typeof body.repo === "string"
            ? resolveRepoCwd(body.repo).cwd
            : undefined;
      if (!repoDir || typeof body.worktree !== "string") {
        return send(res, 400, { error: "repo (or cwd) and worktree are required" });
      }
      try {
        removeWorktree(repoDir, body.worktree);
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, 500, { error: `worktree remove: ${String(err)}` });
      }
    }

    const killMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/kill$/);
    if (killMatch && req.method === "POST") {
      manager.remove(killMatch[1]);
      return send(res, 200, { ok: true });
    }

    // --- Workspace state (DRY-28) ---
    // The desktop arrangement, held by the daemon rather than the browser that
    // drew it, so it follows the person to whatever client attaches next.
    // `?name=` leaves room for more than one saved arrangement; the shell uses
    // "default" only.
    //
    // The governing rule for this whole section: window positions are a
    // convenience and live PTYs are the product, so a store that's unreachable
    // degrades (503 → the shell keeps its local mirror) and never escalates.
    // The daemon has no authentication, so `owner` here is a namespace, not a
    // boundary — it comes from host config, deliberately NOT from the request.
    if (pathname === "/api/workspace") {
      const name = url.searchParams.get("name") || CONFIG.state.workspace;
      const owner = CONFIG.state.owner;
      // Constrain the one request-controlled key that reaches a store. Not
      // theoretical: unconstrained, `?name=__proto__` answered 200 and stored
      // nothing (assigning `__proto__` sets a prototype instead of an own
      // property, so the write vanished at JSON.stringify), and
      // `?name=constructor` read back a phantom workspace off Object.prototype.
      // The file store now uses null-prototype maps too — this is the front
      // door, that's the back stop.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        return send(res, 400, {
          error: "name must be 1-64 chars of [A-Za-z0-9._-] and start alphanumeric",
        });
      }

      if (req.method === "GET") {
        try {
          // null (not 404) for "never saved": absence is the normal first-run
          // state, and making the client tell 404-means-empty apart from
          // 404-means-wrong-url is a distinction it can't act on either way.
          return send(res, 200, { workspace: await store.load(owner, name), kind: store.kind });
        } catch (err) {
          log.warn("workspace load failed — client falls back to its local copy", {
            owner,
            name,
            err: String(err),
          });
          return send(res, 503, { error: `state store: ${String(err)}`, degraded: true });
        }
      }

      if (req.method === "PUT") {
        let body: any;
        try {
          body = await readJsonCapped(req, CONFIG.state.maxBytes);
        } catch (err) {
          if (err instanceof PayloadTooLarge) return send(res, 413, { error: err.message });
          return send(res, 400, { error: `invalid workspace body: ${String(err)}` });
        }
        // Structural checks only. The daemon can't validate a Win — that shape
        // belongs to the shell (see state/types.ts) — so it confirms the
        // envelope it does own and stores the rest verbatim.
        //
        // The object check comes first because a body of literal `null` parses
        // fine and then makes `body.version` a TypeError — thrown outside the
        // parse guard, so a route whose entire contract is 400/413/503 answered
        // 500 with a raw stack-derived message.
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { error: "body must be a JSON object" });
        }
        if (!Number.isFinite(body.version) || typeof body.layout !== "string") {
          return send(res, 400, { error: "version (number) and layout (string) are required" });
        }
        if (!Array.isArray(body.windows)) {
          return send(res, 400, { error: "windows must be an array" });
        }
        try {
          const workspace = await store.save(owner, name, {
            version: body.version,
            layout: body.layout,
            windows: body.windows,
          });
          return send(res, 200, { workspace });
        } catch (err) {
          log.warn("workspace save failed — client keeps its local copy", {
            owner,
            name,
            err: String(err),
          });
          return send(res, 503, { error: `state store: ${String(err)}`, degraded: true });
        }
      }

      if (req.method === "DELETE") {
        try {
          await store.clear(owner, name);
          return send(res, 200, { ok: true });
        } catch (err) {
          return send(res, 503, { error: `state store: ${String(err)}`, degraded: true });
        }
      }
    }

    // --- Session-relative file read (DRY-35 markdown viewer) ---
    // Resolves ?path= against the SESSION's cwd (its worktree when isolated) —
    // the browser only knows the token it clicked in the terminal; the daemon
    // knows where that session actually runs. The daemon is UNAUTHENTICATED,
    // so this must not become an arbitrary-file-read primitive: realpath both
    // ends (no symlink escapes), confine to the session's cwd subtree, allow
    // only renderable text extensions, cap the size. Revisit with daemon auth.
    const fileMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/file$/);
    if (fileMatch && req.method === "GET") {
      const session = manager.get(fileMatch[1]);
      if (!session) return send(res, 404, { error: `unknown session ${fileMatch[1]}` });
      const rel = url.searchParams.get("path") ?? "";
      if (!rel) return send(res, 400, { error: "path is required" });
      if (!/\.(md|markdown|txt)$/i.test(rel)) {
        return send(res, 403, { error: "only .md/.markdown/.txt files can be viewed" });
      }
      try {
        const base = await fs.promises.realpath(expandHome(session.cwd));
        // realpath also fails on nonexistence, so a traversal probe and a
        // missing file are indistinguishable to the caller — intentionally.
        const real = await fs.promises.realpath(path.resolve(base, expandHome(rel)));
        if (real !== base && !real.startsWith(base + path.sep)) {
          return send(res, 403, { error: "path escapes the session's working directory" });
        }
        const st = await fs.promises.stat(real);
        if (!st.isFile()) return send(res, 404, { error: "not a file" });
        if (st.size > 1_048_576) return send(res, 413, { error: "file exceeds the 1 MiB view cap" });
        const content = await fs.promises.readFile(real, "utf8");
        return send(res, 200, { path: real, content });
      } catch {
        return send(res, 404, { error: `no readable file at ${rel}` });
      }
    }

    // --- Tracker API (DRY-10) ---
    // The shell's sidebar + Ctrl+K palette read from here, never from the
    // tracker directly. Credentials stay host-side in the provider.
    if (pathname === "/api/tracker/info" && req.method === "GET") {
      return send(res, 200, trackerInfo(tracker));
    }

    // Project scope for list/search (DRY-30): an explicit `projects=` param
    // (comma-separated keys; UI chips) wins, otherwise the host default
    // (DRYDOCK_TRACKER_PROJECTS). Only when both are empty is the pull
    // unscoped — acceptable at fixture/home scale, ruinous on a corporate
    // tracker, hence the env default.
    const scopedProjects = (): string[] | undefined => {
      const raw = url.searchParams.get("projects");
      const list = (raw !== null ? raw.split(",") : CONFIG.tracker.projects)
        .map((s) => s.trim())
        .filter(Boolean);
      return list.length ? list : undefined;
    };

    if (pathname === "/api/tracker/tickets" && req.method === "GET") {
      try {
        const tickets = await tracker.listTickets({
          project: url.searchParams.get("project") ?? undefined,
          projects: scopedProjects(),
          open: url.searchParams.get("open") === "true",
          // Backlog stays out of the pull unless asked for (DRY-30).
          includeBacklog: url.searchParams.get("backlog") === "true",
          text: url.searchParams.get("text") ?? undefined,
        });
        return send(res, 200, { tickets });
      } catch (err) {
        return send(res, 502, { error: `tracker: ${String(err)}` });
      }
    }

    if (pathname === "/api/tracker/search" && req.method === "GET") {
      try {
        const tickets = await tracker.searchTickets(
          url.searchParams.get("q") ?? "",
          scopedProjects(),
        );
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
      // PreToolUse fires in *every* permission mode. If the agent is running
      // hands-off (bypassPermissions / auto / dontAsk), Claude Code runs the
      // tool regardless of what we return — so popping a gate would be a
      // misleading no-op. Honor the mode and auto-allow without prompting.
      const mode = typeof body.permission_mode === "string" ? body.permission_mode : "default";
      const tool = body.tool_name ?? "unknown";
      // Recorded BEFORE any early return. The rail's action line is fed from
      // here for every gated tool, and a hands-off run — which returns
      // immediately below — is precisely the one whose card would otherwise
      // have nothing to say for its entire life.
      session.noteActivity(tool, body.tool_input ?? {});
      if (HANDS_OFF_MODES.has(mode)) {
        return send(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: `Auto-approved (agent in ${mode} mode)`,
          },
        });
      }
      if (mode === "acceptEdits" && EDIT_TOOLS.has(tool)) {
        return send(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Auto-approved (acceptEdits)",
          },
        });
      }
      const outcome = await session.requestPermission(tool, body.tool_input ?? {});
      if (outcome.decision === "timeout") {
        return send(res, 200, {}); // defer to the CLI's own prompt
      }
      return send(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: outcome.decision,
          // The reason is what the agent actually reads as the tool result. A
          // denial without one tends to produce a retry of the identical call,
          // so when the human typed a reason it replaces the generic string
          // rather than being dropped (DRY-50).
          permissionDecisionReason:
            outcome.reason?.trim() ||
            (outcome.decision === "allow" ? "Approved in Drydock" : "Denied in Drydock"),
        },
      });
    }

    // --- Activity hook endpoint (DRY-49 action line) ---
    // A SECOND PreToolUse hook, matching the tools the gating one deliberately
    // does not (see hooks.ts). It exists because the rail's card would
    // otherwise carry nothing but an elapsed clock: the gating hook matches
    // Bash alone, so the daemon has never seen a Read or an Edit go past.
    //
    // Answers {} immediately and holds nothing open — a hook that can block is
    // a hook that can stall the agent, and this one only feeds a caption.
    if (pathname === "/hook/activity" && req.method === "POST") {
      const sessionId = (req.headers["x-drydock-session"] as string | undefined) ?? "";
      const session = manager.get(sessionId);
      const body = await readJson(req).catch(() => ({}));
      if (session && typeof body?.tool_name === "string") {
        session.noteActivity(body.tool_name, body.tool_input ?? {});
      }
      return send(res, 200, {});
    }

    // --- Stop hook endpoint (DRY-18 "your turn" indicator) ---
    // The wrapped CLI's Stop hook fires when the agent ends its turn and hands
    // control back. We flag the session idle so the pane lights a "Your turn"
    // tag. NB: a turn ending means "done OR waiting for your reply" — we can't
    // tell which, so we never assert "complete". Returning {} lets the agent
    // stop normally (no block).
    if (pathname === "/hook/stop" && req.method === "POST") {
      const sessionId = (req.headers["x-drydock-session"] as string | undefined) ?? "";
      const session = manager.get(sessionId);
      await readJson(req).catch(() => ({})); // drain/ignore the hook payload
      if (session) session.markIdle();
      return send(res, 200, {});
    }

    // --- SessionStart hook endpoint (DRY-9 ticket-spawn) ---
    // When a session was spawned for a ticket, the wrapped CLI's SessionStart
    // hook hits this and we return Claude Code's `additionalContext` schema
    // carrying the ticket body — so the agent starts with the full ticket in
    // context without it being typed into the prompt. Non-ticket sessions (or an
    // unknown one) get an empty object, which the hook treats as "no context".
    if (pathname === "/hook/sessionstart" && req.method === "GET") {
      const sessionId = (req.headers["x-drydock-session"] as string | undefined) ?? "";
      const session = manager.get(sessionId);
      if (!session?.ticket) return send(res, 200, {});
      try {
        const t = await tracker.getTicket(session.ticket);
        const additionalContext =
          `You are working on tracker ticket ${t.key}.\n\n` +
          `# ${t.key}: ${t.title}\n` +
          `Status: ${t.status.label} · Repo: ${t.repo}\n\n` +
          `${t.description}`;
        return send(res, 200, {
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
        });
      } catch {
        // Tracker hiccup: don't block session start — just skip the context.
        return send(res, 200, {});
      }
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err) });
  }
});

// --- WebSocket attach ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    upgrade(req, socket, head);
  } catch (err) {
    // Same bug class this ticket is about: an unguarded throw inside a socket
    // handler. `new URL(…, "http://" + req.headers.host)` throws "Invalid URL"
    // on a malformed Host header — and Node's HTTP parser passes those straight
    // through (verified with `]bad[`, `a b`, empty, `x:99999999`, `[::1`). It
    // throws BEFORE the session lookup, so on a daemon that binds 0.0.0.0 with
    // no auth, one malformed request from anything that could reach the port
    // used to take out every session on the host.
    log.warn("upgrade failed — closing socket", describe(err));
    socket.destroy();
  }
});

/**
 * Refuse an upgrade with a real HTTP response, then close (DRY-45). ws's own
 * abortHandshake() writes one, so once we take ownership of a socket — which is
 * exactly what listening for 'wsClientError' does — skipping it leaves the
 * client with a bare TCP close and nothing to report. Mirrors ws 8.21's
 * abortHandshake shape.
 *
 * The no-op 'error' listener is load-bearing, not defensive: Node's http server
 * removes its OWN socket error handler before emitting 'upgrade' (verified —
 * listenerCount('error') is 0 in the handler), so writing to a socket the peer
 * has already reset would emit 'error' with nothing listening. That is this
 * ticket's bug class exactly, re-introduced by the act of answering politely.
 */
function rejectUpgrade(
  socket: import("node:stream").Duplex,
  code: number,
  message: string,
  fields?: LogFields,
): void {
  log.warn(`upgrade rejected — ${message}`, { status: code, ...fields });
  socket.on("error", () => socket.destroy());
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` +
      `Connection: close\r\n` +
      `Content-Type: text/plain\r\n` +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      `\r\n` +
      message,
  );
}

function upgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attach$/);
  if (!match) {
    return rejectUpgrade(socket, 404, "not a session attach endpoint", {
      path: url.pathname,
    });
  }
  const session = manager.get(match[1]);
  if (!session) {
    // The stale-tab case: a browser reconnecting to a session this daemon no
    // longer has (it restarted, or the session was killed). Silently destroying
    // the socket made the single most likely post-restart symptom invisible.
    return rejectUpgrade(socket, 404, "unknown session", { id: match[1] });
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.attach(ws);
    // A client socket erroring must cost that client and nothing else (DRY-45).
    // `ws` emits 'error' on the WebSocket for any frame-level protocol fault
    // (a malformed/unmasked frame, a bad opcode, an oversized payload); an
    // 'error' event with no listener THROWS in Node, so before this handler a
    // single bad frame from one browser tab took the whole daemon down and
    // every live agent PTY with it. Reproduced: one unmasked frame →
    // "RangeError: Invalid WebSocket frame: MASK must be set" → process exit.
    ws.on("error", (err: Error & { code?: string }) => {
      // `id=` deliberately, matching every line session.ts writes — one grep key
      // has to recover a session's whole timeline.
      log.warn("client socket error — dropping that client", {
        id: session.id,
        code: err.code,
        err: err.message,
      });
      // No terminate() here. For a frame error ws has already called
      // close(1002) before emitting, so tearing the socket down on top of that
      // replaces a status code the client could act on with an opaque 1006.
      session.detach(ws as WebSocket);
    });
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
          session.resolvePermission(msg.requestId, msg.decision, msg.reason);
          break;
      }
    });
    ws.on("close", () => session.detach(ws as WebSocket));
  });
}

// NOT wss.on("error"): with `noServer: true` this WebSocketServer owns no http
// server, so it never emits 'error' — that listener would be decoration. The
// event that actually fires on this path is 'wsClientError' (a bad handshake
// inside handleUpgrade). Note the ownership rule: ws aborts the handshake
// itself ONLY while nothing is listening, so attaching a listener here makes
// closing the socket — and answering the client — our job.
wss.on("wsClientError", (err, socket) => {
  rejectUpgrade(socket, 400, "bad websocket handshake", { err: err.message });
});

// --- Crash containment (DRY-45, revised by DRY-57) ---
// This process is no longer the lifetime of the sessions it owns. Each PTY is
// held by its own detached supervisor and found again at boot, so an exit costs
// a reconnect rather than every agent on the host.
//
// Two of the three rules survive that change, and one inverts. Still true: never
// die for a reason that only concerns one client (a bad WebSocket frame, a
// vanished SSE reader), and always leave a trace when we do die. No longer true:
// that staying up in a suspect state beats exiting — see CONFIG.log.exitOnUncaught.

/**
 * One-line census of what's at stake, for the log lines that precede a death.
 * Reads the cheap `running` getter rather than building a SessionInfo per
 * session — this runs inside crash handlers, where the less work between the
 * fault and the line hitting disk, the better.
 */
function inventory(): LogFields {
  const sessions = manager.list();
  return {
    sessions: sessions.length,
    live: sessions.filter((s) => s.running).length,
    ids: sessions.map((s) => s.id).join(",") || undefined,
  };
}

process.on("uncaughtException", (err) => {
  // describe() rather than err.message: `throw null` makes that dereference a
  // TypeError, and a TypeError raised INSIDE this handler is fatal (Node exits
  // 7) — a crash handler with its own crash path is worse than no handler.
  // Stack goes in as a field so the record stays one greppable line.
  log.error("UNCAUGHT EXCEPTION", {
    ...describe(err),
    ...inventory(),
    action: CONFIG.log.exitOnUncaught ? "exiting" : "staying up",
  });
  // Node's default here is to die, and since DRY-57 we let it: the sessions
  // outlive us and a fresh daemon reattaches to them, which beats serving the
  // shell from a process in an unknown state. DRYDOCK_EXIT_ON_UNCAUGHT=0 keeps
  // the old wedged-but-attached posture (see config.ts).
  if (CONFIG.log.exitOnUncaught) process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("UNHANDLED REJECTION", { ...describe(reason), ...inventory() });
});

// A shutdown no longer destroys anything. Let go of each supervisor without
// signalling it, and say so — this line used to read "destroying live
// sessions", and the whole of DRY-57 is the difference between the two.
//
// It is also what defused the dev-watch footgun: `bun run daemon` is `node
// --watch`, so any save under daemon/src/ still SIGTERMs us, but the agents on
// the other end of these sockets carry on and are adopted by the daemon that
// starts a second later.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.warn(`${signal} — detaching; sessions keep running`, inventory());
    manager.detachAll();
    process.exit(0);
  });
}

let listening = false;

server.on("error", (err: Error & { code?: string }) => {
  log.error("http server error", { code: err.code, err: err.message, listening });
  // Any failure before we're listening is fatal — there are no sessions yet, so
  // nothing to preserve, and a daemon that isn't bound is no daemon. Exit
  // explicitly rather than letting the event loop drain: that path exits 0,
  // which reads as a clean shutdown in whatever is watching us. EADDRINUSE is
  // just the common case; EACCES and EADDRNOTAVAIL are equally terminal.
  if (!listening) process.exit(1);
});

// Find the sessions a previous daemon left running BEFORE binding the port
// (DRY-57). Top-level await, so the first `GET /api/sessions` a browser makes
// already includes everything that was adopted — reconciling afterwards would
// give every reload a window in which the desk correctly reports no sessions
// and the shell reconciles away the windows for agents that are alive.
await manager.reconcile();

server.listen(CONFIG.port, CONFIG.host, () => {
  listening = true;
  log.info("daemon listening", {
    url: `http://${CONFIG.host}:${CONFIG.port}`,
    pid: process.pid,
    log: log.file() || "(stdout only)",
    sessionsDir: sessionsDir(),
    sessions: manager.list().length,
  });
});
