import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG, PERMISSION_MODES, type PermissionMode } from "./config.js";
import { faults, Health, IdleExit } from "./health.js";
import { describe, log, type LogFields } from "./log.js";
import { SessionManager } from "./manager.js";
import type { PtySession, SpawnOptions } from "./session.js";
import { expandHome, resolveRepoCwd } from "./repos.js";
import { sanitizeSpawnEnv } from "./spawn-env.js";
import { occupiedDirs, sessionsDir } from "./sessions-dir.js";
import {
  describeManagedWorktree,
  ensureWorktree,
  isGitWorkTree,
  planWorktree,
  removeWorktree,
  samePath,
  worktreeExists,
  WorktreeNotSafe,
} from "./worktree.js";
import { WorktreeReaper } from "./worktree-reaper.js";
import type { ClientMessage, EventMessage, SessionVisibility } from "./protocol.js";
import { Auth, BadRequest, NotSupported, type Identity } from "./auth/index.js";
import { createTracker, trackerInfo } from "./tracker/index.js";
import { ticketContext } from "./tracker/context.js";
import { TicketListCache, ticketQueryKey } from "./tracker/cache.js";
import { createStore } from "./state/index.js";
import { runEndHandler } from "./runs.js";
import { SessionHistoryRecorder } from "./history.js";
import { knownTranscripts } from "./transcripts.js";

const manager = new SessionManager();
const tracker = createTracker();
const store = createStore();
// Who may talk to this daemon (DRY-27). Constructed with the store because
// accounts live in it — and absent from it on the file tier, which is precisely
// what makes multi-user impossible there rather than merely discouraged.
const auth = new Auth(store);
// What Auth needs to know about live PTYs, injected rather than imported so it
// stays a thing that decides who somebody is (DRY-27). Two questions: whether an
// account still has agents running (removing it would strand them with nothing
// able to reach them), and where the pre-accounts sessions go when the first
// account is seeded.
auth.useSessions({
  liveSessionsFor: (owner) => manager.liveSessionsFor(owner),
  adoptSessions: (from, to, toName) => manager.adoptSessions(from, to, toName),
});
// The sidebar's pull, cached and coalesced (DRY-72). One per daemon, keyed by
// query, so every browser tab on the same scope shares one fan-out at the
// tracker instead of each paying for its own.
const ticketCache = new TicketListCache(CONFIG.tracker.cache.ticketsMs);

// An autonomous run that reaches a terminal state leaves a handoff document
// and (capability permitting) a tracker comment behind (DRY-49). Subscribed
// here rather than inside the session so PtySession keeps knowing nothing about
// trackers or the filesystem.
manager.onRunEnd(runEndHandler(tracker));

/**
 * Worktrees whose work is finished (DRY-90).
 *
 * Both of its questions are asked of things it is deliberately not allowed to
 * import: the session registry, because a worktree with a session in it is
 * never reaped whatever the ticket says, and the tracker, because a merge that
 * happened while this daemon was down leaves no other trace. Injected for the
 * same reason `runEndHandler` is — the reaper stays a thing that reasons about
 * git.
 */
const reaper = new WorktreeReaper({
  // Two sources, and the second is the one that matters. This daemon's registry
  // holds every session it knows about — running or exited, since an exited one
  // is still a card on somebody's desk that DRY-62's Resume spawns back into.
  // But `~/.drydock/worktrees` is shared by every daemon on the host while the
  // registry is per-process, so the registry alone answers "not in use" for the
  // dev daemon's live agents when the PROD daemon sweeps (review, DRY-92).
  // `occupiedDirs()` reads the on-disk session index of every daemon here.
  //
  // Both `worktree` and `cwd` are checked on both sides, because a spawn that
  // fell back to the plain repo cwd (the DRY-15 catch) records only the latter.
  inUse: (wtPath) =>
    manager.list().some((s) => samePath(s.worktree, wtPath) || samePath(s.cwd, wtPath)) ||
    occupiedDirs().some((dir) => samePath(dir, wtPath)),
  ticketDone: async (key) => {
    try {
      const ticket = await tracker.getTicket(key);
      return ticket.status.category === "done";
    } catch (err) {
      // An outage, an unknown key, a provider with no such ticket. All of them
      // mean "couldn't tell", which is not "no" and certainly not "yes" — the
      // caller keeps the worktree. Logged at warn because a tracker that always
      // fails here is a reaper that has silently stopped reaping.
      log.warn("worktree reaper couldn't ask the tracker", { ticket: key, err: String(err) });
      return undefined;
    }
  },
});

// Retained session history, on the tiers that keep any (DRY-56). `store.history`
// is undefined on the file store, which makes every call below a no-op — the
// capability is derived from that, so it can't claim more than the backend does.
const history = new SessionHistoryRecorder(store.history, CONFIG.state.owner);
manager.useHistory(history);

/**
 * The conditional arm of DRYDOCK_EXIT_ON_UNCAUGHT (DRY-48).
 *
 * Armed by the uncaught-exception handler under `when-idle`, and it exits once
 * the registry is EMPTY — not once nothing is running. The first cut said
 * `!some(running)` under a comment claiming a fresh daemon would rebuild the
 * finished cards from `adoptExited`, and review caught that being false twice
 * over: a session that ends while this daemon is up has its index files
 * `forget`ten on the spot (session.ts), and on the path where `adoptExited` IS
 * reached it deliberately does not put the session back in the registry. So an
 * exited session is not recoverable by restarting — it is a card on somebody's
 * desk with readable scrollback, and DRY-60 spent a whole ticket making sure a
 * finished run survives until somebody has actually SEEN it (five minutes of
 * VISIBLE time, by default). Exiting the moment the last PTY stops would
 * discard exactly that, on the host most likely to choose this posture, and
 * would do it after deliberately waiting for the moment those cards were the
 * only thing left.
 *
 * The daemon cannot tell a read card from an unread one — that clock is the
 * shell's, because only the browser knows what is on screen — so "nothing left
 * to lose" is the honest reading: no sessions at all. A ✕, DRY-60's sweep and
 * `Clear finished` all kill, and a kill leaves the registry synchronously, so a
 * desk somebody is watching empties on its own. A desk nobody is watching does
 * not, and this stays up: that is the conservative direction, and never worse
 * than the `0` posture such a host would otherwise be running.
 *
 * The exit is deliberately bare — no `detachAll()`, unlike the signal handlers.
 * That call exists to say "let go without signalling", and letting the process
 * end does exactly that: the supervisors are not our children and closing our
 * socket ends nothing (DRY-57). Doing MORE work in a process we have already
 * decided is suspect is the wrong direction.
 */
const idleExit = new IdleExit({
  idle: () => manager.list().length === 0,
  exit: () => {
    log.error("suspect and idle — exiting so a fresh daemon takes over", {
      ...inventory(),
      policy: CONFIG.log.onUncaught,
    });
    process.exit(1);
  },
});

/**
 * What state this daemon is in, for /healthz and /readyz (DRY-48).
 *
 * Everything it reports on is injected, so health.ts stays a module with
 * opinions about state rather than one that reaches into the daemon — the same
 * rule `runs.ts` and the worktree reaper follow. `manager.list()` and not
 * `listFor`: this endpoint's audience is the HOST, and a census that depended on
 * who asked would be a strange thing for an operator to read.
 */
const health = new Health({
  sessions: () => manager.list(),
  store,
  trackerId: tracker.id,
  idleExit,
});

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

/**
 * How many password checks may run at once (DRY-27).
 *
 * scrypt is memory-hard on purpose — ~16 MiB and ~50ms per attempt — which is
 * the property that makes it worth using and also a lever anybody who can reach
 * the port can pull, since `/api/auth/login` is by definition answered before
 * anyone has proved anything. Four is past any human's concurrency and far
 * short of a machine's.
 *
 * Deliberately not a per-IP lockout: those are evaded by using more sources and
 * are a way to lock a real person out of a daemon holding their live agents.
 */
const MAX_CONCURRENT_LOGINS = 4;
let loginsInFlight = 0;

/**
 * Consecutive failed sign-ins, and the delay they buy.
 *
 * The concurrency cap above bounds how much work arrives at once; it does not
 * bound how many GUESSES an attacker gets, because a patient one simply sends
 * them four at a time. This does: each failure adds a delay to the ANSWER, so
 * the millionth guess costs a second and a half whether or not anybody is in a
 * hurry.
 *
 * Delay rather than lockout, deliberately. A lockout on a daemon holding
 * somebody's live agents is a denial of service anybody can trigger from
 * outside — the owner is locked out of their own running work by a stranger
 * typing the wrong password. A delay costs an attacker everything and costs the
 * owner one slow login, once, before their correct password resets it.
 */
const FAILED_LOGIN_DELAY_MS = 250;
const FAILED_LOGIN_DELAY_CAP_MS = 1_500;
let failedLogins = 0;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Learn what a hook payload can tell us about a session (DRY-56).
 *
 * Two things ride on every Claude Code hook body, and both are free here:
 *
 * `session_id` is the CLI's OWN id, which is not `PtySession.id` and is the
 * only thing `claude --resume <id>` accepts. `pty_sessions.agent_session_id`
 * has existed unwritten since DRY-28 for exactly this. Taken opportunistically
 * from whichever hook arrives first rather than from one designated event: the
 * earliest is SessionStart, but a session whose SessionStart failed still
 * reports it on its first tool call, and recording it late beats not at all.
 * Left null when the CLI doesn't send one — a guessed resume id is worse than
 * an honest "respawn fresh" button.
 *
 * The activity stamp is debounced inside the recorder; this path is the rail's
 * hot one and must stay free of round trips.
 */
function noteFromHook(session: PtySession | undefined, body: unknown): void {
  if (!session) return;
  const agentId = (body as { session_id?: unknown } | null | undefined)?.session_id;
  if (typeof agentId === "string" && agentId) {
    history.noteAgentSessionId(session, agentId);
  }
  history.active(session);
}

/**
 * Let a spawned CLI's hooks prove they are that session (DRY-27).
 *
 * The key is looked up FROM the session and compared to what arrived, so a
 * caller cannot assert their way in by presenting a key for a session id they
 * guessed — they would have to present the right key for the right id, which is
 * the whole point.
 *
 * A session with no key recorded is let through, and that is a deliberate,
 * self-closing gap: it can only be a session spawned by a daemon from before
 * this existed, and every session spawned since has one. Refusing them instead
 * would mean an upgrade silently breaks every live agent's gates — the
 * permission prompt just stops arriving — which is the worst failure this
 * daemon has, delivered by the feature meant to secure it.
 */
function hookAuthorized(session: PtySession, req: http.IncomingMessage): boolean {
  if (!auth.enabled) return true;
  const expected = session.hookKey;
  if (!expected) return true;
  const presented = req.headers["x-drydock-key"];
  return typeof presented === "string" && timingSafeEqualStrings(presented, expected);
}

/** Constant-time string compare that tolerates a length mismatch. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const x = crypto.createHash("sha256").update(a, "utf8").digest();
  const y = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Resolve the caller, or answer them and return null.
 *
 * Returning null-after-answering rather than throwing keeps every route a
 * single `if` — and it makes the DEFAULT for a new route "you forgot to call
 * this and it doesn't compile", because `who.id` is what the route needs to do
 * anything at all.
 *
 * The two failure codes are not interchangeable. 401 means "prove who you are";
 * 503 means the daemon could not FIND OUT, because the accounts store is
 * unreachable — and a shell that treats the second as the first would throw
 * away a working token and demand a password nobody can verify, turning a
 * database blip into a locked desk (DRY-58's lesson, one layer up).
 */
async function identify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { streamToken?: string } = {},
): Promise<Identity | null> {
  const result = await auth.identify(req.headers.authorization, opts);
  if (result.ok) return result.identity;
  if (result.reason === "unavailable") {
    send(res, 503, { error: "accounts are unreachable — try again shortly", degraded: true });
    return null;
  }
  send(res, 401, {
    error: result.reason === "anonymous" ? "sign in to use this Drydock" : "sign in again",
    authRequired: true,
  });
  return null;
}

/**
 * The session `id` names, if the caller is allowed to know it exists.
 *
 * 404 for "not yours", not 403, and the two arms answer identically on purpose:
 * a daemon that says "forbidden" for one id and "unknown" for another has told
 * an unauthorized caller which session ids are real.
 *
 * `need` is the difference between watching and driving. A `public` run is
 * somebody else's work put on display — seeing it is the point, stopping it or
 * typing into it is not — so every route that CHANGES a session asks for
 * "own" while the ones that only read ask for "see".
 */
function sessionFor(
  id: string,
  viewer: string,
  need: "see" | "own",
  res: http.ServerResponse,
): PtySession | null {
  const session = manager.get(id);
  const allowed = session && (need === "own" ? session.ownedBy(viewer) : session.visibleTo(viewer));
  if (!allowed) {
    send(res, 404, { error: `unknown session ${id}` });
    return null;
  }
  return session;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Dev shell runs on a different origin (Vite), and a deployed one may be a
    // different host entirely (docs/deploy.md). `*` stays correct now that
    // there is auth (DRY-27) precisely BECAUSE the credential is a bearer
    // token rather than a cookie: `*` forbids credentialed requests, so a
    // hostile page can send this daemon a request and cannot attach the
    // token — where a cookie would have ridden along on its own.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Drydock-Session, X-Drydock-Key",
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
 * Translate an account-management failure into a status and a body.
 *
 * Three outcomes with three meanings: the request was wrong (400), this tier
 * cannot keep accounts at all (501 — the same answer session history gives on
 * the file store, and for the same reason: a client has to tell "not supported
 * here" from "you asked wrong"), or the store is unreachable (503, which will
 * pass).
 */
function accountsError(err: unknown): [number, { error: string }] {
  if (err instanceof BadRequest) return [400, { error: err.message }];
  if (err instanceof NotSupported) return [501, { error: err.message }];
  return [503, { error: `accounts unavailable: ${String(err)}` }];
}

/**
 * readJson with a hard ceiling (DRY-28). The control-API payloads are a few
 * hundred bytes, so readJson buffering whatever it's handed has never mattered;
 * /api/workspace is the first endpoint whose whole job is to accept a blob, and
 * it sits on a port with no authentication (see CONFIG.host). Stop at the cap
 * while reading rather than after allocating the whole thing.
 */
async function readJsonCapped(
  req: http.IncomingMessage,
  maxBytes: number,
  what = "body",
): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) {
      // Named by the caller since DRY-27 gave this a second one. "workspace
      // exceeds the 4096 byte cap" on the LOGIN route is a sentence that sends
      // whoever reads it to the wrong knob entirely.
      throw new PayloadTooLarge(`${what} exceeds the ${maxBytes} byte cap`);
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
    /** The authenticated caller. Filled in by the gate below; see `me()`. */
    let who: Identity | undefined;

    if (req.method === "OPTIONS") return send(res, 204, {});

    // --- Liveness (DRY-48) ---------------------------------------------------
    // Both unauthenticated, like the /healthz this replaces: whatever is asking
    // whether the daemon is alive is the thing least able to hold a credential,
    // and a liveness probe that needs a login is a probe nobody can point at a
    // daemon that has stopped answering.
    //
    // What that costs is a deliberate decision rather than an inherited one
    // (review). On a daemon with auth ON this is the only route besides
    // /api/auth/{info,login} that answers a stranger, and it now serves more
    // than `ok` and the store: two host paths (the sessions dir and the log
    // file), live/exited session counts, and `faults.last` — the message of an
    // exception this daemon took. Those are kept, because they are the answer to
    // "what is this daemon and what happened to it", which is the whole ticket,
    // and because the store's error has carried a path here since DRY-28. What
    // is NOT kept is somebody ELSE's text: `TrackerWatch` reports "the tracker
    // answered 500" rather than the 500's body, which on a tracker behind a
    // proxy is that proxy's error page. The body still goes to the sidebar and
    // the 502, both behind the gate.
    //
    // Two endpoints because they answer to two audiences. /healthz is the
    // report — everything probed, including the store, whose probe is allowed
    // to block for the pool's connect timeout when a configured Postgres is
    // down — inside the store's retry window it answers immediately instead,
    // with `store.cooling` and `retryInMs` (DRY-58). That is also why nothing
    // on the deploy path waits on it:
    // `install-prod.sh` polls /api/sessions instead (DRY-81), and would trade a
    // false failure under auth for a slow one under a database outage if it
    // came here. /readyz is what something polls on a timer: narrower,
    // synchronous, and deliberately blind to the store and the tracker, because
    // an outage in either costs nobody a PTY and a supervisor acting on one
    // would restart a daemon that is serving perfectly (DRY-28's first
    // property).
    //
    // /healthz always answers 200 and puts its verdict in the body; /readyz is
    // the one that speaks in status codes. That split is deliberate rather than
    // incidental — a report that 503s is a report several things already
    // watching this endpoint would stop reading (a `fetch` caller checking
    // `res.ok` gets nothing at exactly the moment the body has the most to
    // say), and a signal that always answers 200 is not a signal.
    //
    // NEITHER is an instruction to restart. `degraded` means suspect or
    // depending on something broken — restarting for that is what DRY-45 was
    // written to prevent — and even `down` is more likely to want a human than a
    // bounce (a vanished sessions dir is not fixed by starting again, it is made
    // permanent). See health.ts.
    if (pathname === "/healthz") {
      return send(res, 200, await health.report());
    }

    if (pathname === "/readyz") {
      const ready = health.readiness();
      // 503 rather than 200-with-a-field, because the audience is a supervisor
      // and the status code is the part of this it can act on without parsing.
      return send(res, ready.ready ? 200 : 503, ready);
    }

    // --- Identity (DRY-27) -------------------------------------------------
    // The only two routes below that answer without a credential, because they
    // are what a client asks BEFORE it has one: what kind of door is this, and
    // here is the key. Everything else on /api goes through `identify`.

    // What the shell needs in order to draw the right thing. Unauthenticated on
    // purpose and deliberately thin: the posture and whether a second account is
    // possible, never a user list — "who has an account here" is not a question
    // an anonymous caller gets to ask.
    if (pathname === "/api/auth/info" && req.method === "GET") {
      return send(res, 200, await auth.info());
    }

    if (pathname === "/api/auth/login" && req.method === "POST") {
      // Bounded, unlike the routes behind the gate. This is the one endpoint
      // that must accept a body from somebody who has proved nothing, and
      // `readJson` buffers whatever it is handed — a cap here is the difference
      // between an unauthenticated write and an unauthenticated allocation.
      // A name and a password are hundreds of bytes.
      let body: any;
      try {
        body = await readJsonCapped(req, 4096, "login");
      } catch (err) {
        if (err instanceof PayloadTooLarge) return send(res, 413, { error: err.message });
        return send(res, 400, { error: `invalid JSON body: ${String(err)}` });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(res, 400, { error: "body must be a JSON object" });
      }
      // Password hashing is deliberately expensive — scrypt at ~16 MiB and
      // ~50ms a go — which on a public endpoint is a lever somebody else can
      // pull. Bounding how many run AT ONCE bounds both without a lockout: a
      // real person never sees it, and there is no per-source bookkeeping to
      // get wrong or to be evaded by using more sources.
      if (loginsInFlight >= MAX_CONCURRENT_LOGINS) {
        log.warn("login refused — too many at once", { inFlight: loginsInFlight });
        return send(res, 429, { error: "too many sign-ins at once — try again in a moment" });
      }
      loginsInFlight += 1;
      let outcome;
      try {
        outcome = await auth.login(body.name, body.password);
      } finally {
        // In a `finally`, because a rejection here would otherwise leak a slot
        // permanently and the fourth failure would close the door for good.
        loginsInFlight -= 1;
      }
      if (!outcome.ok) {
        // A 503 is the store being unreachable, not a wrong password — counting
        // it would let a database outage throttle the owner's real login the
        // moment it came back.
        if (outcome.status !== 503) {
          failedLogins += 1;
          await wait(Math.min(failedLogins * FAILED_LOGIN_DELAY_MS, FAILED_LOGIN_DELAY_CAP_MS));
        }
        // Logged because a login that keeps failing is either somebody locked
        // out or somebody trying, and the daemon log is the only place either
        // is visible — the browser only ever sees its own attempt.
        log.warn("login refused", {
          name: String(body.name ?? ""),
          reason: outcome.error,
          consecutiveFailures: failedLogins || undefined,
        });
        return send(res, outcome.status ?? 401, { error: outcome.error });
      }
      failedLogins = 0;
      log.info("signed in", { user: outcome.identity?.name });
      return send(res, 200, {
        token: outcome.token,
        user: { id: outcome.identity!.id, name: outcome.identity!.name },
        expiresInMs: CONFIG.auth.sessionTtlMs,
      });
    }

    // Everything past here needs to know who is asking. `/hook/*` is the one
    // exception and authenticates differently (per-session key, see below), so
    // it is routed around this rather than through it.
    if (!pathname.startsWith("/hook/")) {
      const gate = await identify(req, res, {
        // The stream token is accepted for the SSE route ALONE, and only from
        // the query string, because `EventSource` cannot send a header. See
        // Audience in auth/tokens.ts for why that is a separate, minute-long
        // credential instead of the real one.
        streamToken:
          pathname === "/api/events" ? (url.searchParams.get("token") ?? undefined) : undefined,
      });
      if (!gate) return;
      who = gate;
    }

    // Who this request is, once past the gate. Non-null for every route below
    // except the hooks, which never read it.
    const me = (): Identity => who!;

    /** A short-lived credential for the transports that can't carry a header. */
    if (pathname === "/api/auth/stream-token" && req.method === "POST") {
      return send(res, 200, { token: auth.streamToken(me()), expiresInMs: 60_000 });
    }

    /** Who the caller currently is, for a shell restoring a stored token. */
    if (pathname === "/api/auth/me" && req.method === "GET") {
      return send(res, 200, { user: { id: me().id, name: me().name }, mode: auth.mode });
    }

    // --- Accounts (DRY-27, multi-user only) --------------------------------
    // 501 rather than 404 on the single-account tiers, matching how session
    // history answers on the file store: the route exists, this Drydock just
    // cannot do it, and the shell has to tell that apart from being newer than
    // its daemon.
    if (pathname === "/api/users") {
      try {
        if (req.method === "GET") return send(res, 200, { users: await auth.listUsers() });
        if (req.method === "POST") {
          const body = await readJson(req).catch(() => null);
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return send(res, 400, { error: "body must be a JSON object" });
          }
          const created = await auth.createUser(body.name, body.password);
          return send(res, 201, { user: created });
        }
      } catch (err) {
        return send(res, ...accountsError(err));
      }
    }

    const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch && req.method === "DELETE") {
      try {
        await auth.removeUser(decodeURIComponent(userMatch[1]), me());
        return send(res, 200, { ok: true });
      } catch (err) {
        return send(res, ...accountsError(err));
      }
    }

    const passwordMatch = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
    if (passwordMatch && req.method === "PUT") {
      const id = decodeURIComponent(passwordMatch[1]);
      try {
        const body = await readJsonCapped(req, 4096, "password change").catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { error: "body must be a JSON object" });
        }
        // Own account only, current password required — see Auth.setPassword.
        // Both rules live there rather than here so there is one place to read
        // for "can this become account takeover", instead of a route that
        // enforces half of it and a method that trusts the route.
        await auth.setPassword(id, body.current, body.password, me());
        // The caller has just invalidated their own token — the epoch moved.
        // Say so in the response rather than letting the next poll 401 out of
        // nowhere.
        return send(res, 200, { ok: true, signedOut: true });
      } catch (err) {
        return send(res, ...accountsError(err));
      }
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
        // OWNED, not merely visible. A gate is a question addressed to whoever
        // is responsible for the run — only they can answer it (the answer
        // route requires ownership) — so streaming one to a spectator on a
        // public run would render a panel whose buttons return 404, carrying
        // the tool's input along with it. Watching somebody's run is not
        // supervising it.
        gates: manager
          .listFor(me().id)
          .filter((session) => session.ownedBy(me().id))
          .flatMap((session) =>
            session.pendingGates().map((gate) => ({ sessionId: session.id, gate })),
          ),
      });

      // Scoped to this viewer (DRY-27). The manager broadcasts every gate to
      // every subscriber — it has to, since a subscriber is a browser tab and
      // not an account — so the filter is here, at the point where a stream
      // belongs to somebody. Without it, the one surface built to outlive a
      // pane would be the one that leaks a colleague's tool calls, tool INPUT
      // included.
      const viewer = me().id;
      const unsubscribeGates = manager.onGate((event) => {
        // A RESOLUTION goes to everyone, deliberately. It carries no detail —
        // a requestId and a decision — so it can only ever retract a row this
        // client was already sent, and the alternative is worse in a way that
        // is easy to miss: a session killed mid-gate is dropped from the
        // registry before its dangling gates are announced, so there would be
        // nothing left to check visibility against and the row would sit in the
        // tray forever with its held-time climbing. Exactly the strand
        // gate-snapshot exists to repair, reintroduced by the filter meant to
        // secure it.
        if (event.type === "gate-resolved") return write(event);
        // An OPENING carries the tool and its input, and only its owner can
        // answer it — see the snapshot above.
        const session = manager.get(event.sessionId);
        if (session?.ownedBy(viewer)) write(event);
      });

      // Exits (DRY-64), so learning that a run ended is an event rather than a
      // poll of every session for one field.
      //
      // `visibleTo`, not `ownedBy` — the looser of the two, unlike the gate
      // filter above. A gate is a question only its owner can answer and it
      // carries the tool's input; an exit is three fields a spectator on a
      // public run can already read off `GET /api/sessions`, and withholding it
      // would leave their pane's card marching forever for a process that has
      // stopped.
      //
      // The session is asked directly rather than looked up: `/kill` drops it
      // from the registry the moment it signals (DRY-60), so by the time the
      // child actually goes there is nothing left to find — and that exit is
      // precisely the one somebody is waiting on.
      //
      // `ending()` rather than `info()`: it is the narrow accessor that exists
      // precisely because `exitCode` cannot say whether a run was stopped or
      // crashed, and it costs three fields per connected stream instead of a
      // whole `SessionInfo` rendered to read three.
      const unsubscribeExits = manager.onSessionEnd((session) => {
        if (!session.visibleTo(viewer)) return;
        const { exitCode, endReason } = session.ending();
        write({
          type: "session-exit",
          sessionId: session.id,
          status: "exited",
          exitCode: exitCode ?? null,
          endReason,
        });
      });

      // Collected rather than chained, so adding a third subscription to this
      // handler is one line and cannot half-happen: an unsubscribe left out of
      // a hand-composed teardown leaks a listener holding a dead response, and
      // the leak is invisible until something writes to it.
      const subscriptions = [unsubscribeGates, unsubscribeExits];
      const unsubscribe = (): void => {
        for (const drop of subscriptions) drop();
      };
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
        // Policy this daemon never applies itself (DRY-60) — the desk does the
        // sweeping, because only the desk can see what's on screen. Served here
        // so the delay is host config like everything else, and so turning it
        // off is one env var rather than a setting per browser profile.
        desk: { clearFinishedAfterMs: CONFIG.desk.clearFinishedAfterMs },
      });
    }

    // --- Session control API ---
    // Scoped to the caller since DRY-27: your own sessions, plus any run
    // somebody deliberately made public. On a daemon with auth off this is
    // every session, because there is one identity and everything is its own.
    if (pathname === "/api/sessions" && req.method === "GET") {
      return send(res, 200, { sessions: manager.listFor(me().id).map((s) => s.info()) });
    }

    // --- Session history (DRY-56) ---
    // "What has run here recently, live or dead." The shell's restore uses it to
    // tell a window whose session is still running (reattach, as always) from
    // one whose session is gone (a tombstone it can resume from).
    //
    // 501, not an empty list, when the tier keeps no history. An empty list is
    // indistinguishable from "nothing has ever run", which is the exact
    // confusion `001_workspace.sql` was written to pre-empt — and the shell has
    // to say something different in the two cases.
    if (pathname === "/api/sessions/history" && req.method === "GET") {
      if (!history.enabled) {
        return send(res, 501, {
          error: "this Drydock keeps no session history",
          reason: "the file store cannot retain it — set DRYDOCK_DATABASE_URL",
          capability: "sessionHistory",
        });
      }
      const asked = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50;
      try {
        // The caller's own history. Not filtered after the fact — asked for by
        // owner in SQL, so a busy colleague's runs can't consume the limit and
        // leave you an empty page that reads as "nothing ever ran".
        const records = (await history.recent(me().id, limit)) ?? [];
        // Say which of these can actually be resumed (DRY-62). Recording an
        // `agentSessionId` only means a hook reported one — a session spawned
        // before DRY-59 has one AND no transcript, so the tombstone would offer
        // a Resume that lands on the CLI's own "no conversation found". Marked
        // here rather than stored, because it is a fact about the filesystem
        // now and not about the run then: a transcript can be pruned, and the
        // record would go on claiming otherwise.
        const transcripts = knownTranscripts();
        return send(res, 200, {
          sessions: transcripts
            ? records.map((r) =>
                r.agentSessionId && !transcripts.has(r.agentSessionId)
                  ? { ...r, transcriptMissing: true }
                  : r,
              )
            : records,
        });
      } catch (err) {
        // Same rule as /api/workspace: a store that can't answer degrades, it
        // never escalates. The desk still restores, it just can't draw
        // tombstones this time round.
        log.warn("session history unavailable", { err: String(err) });
        return send(res, 503, { error: `state store: ${String(err)}`, degraded: true });
      }
    }

    // Answer a gate without holding that session's WebSocket (DRY-50). The
    // session id stays mandatory and in the path: this daemon is
    // unauthenticated, and while it already spawns arbitrary commands (DRY-27),
    // that is no reason to make someone else's gates answerable by guessing a
    // request id alone.
    const answerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/permission$/);
    if (answerMatch && req.method === "POST") {
      // "own", not "see": answering a gate decides what an agent is allowed to
      // do to the host, so it belongs to whoever is responsible for that run —
      // a spectator on a public one may watch it ask and may not answer.
      const session = sessionFor(decodeURIComponent(answerMatch[1]), me().id, "own", res);
      if (!session) return;
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
      const session = sessionFor(decodeURIComponent(autonomyMatch[1]), me().id, "own", res);
      if (!session) return;
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
      // Bounded since DRY-66, and the cap is generous rather than tight. The
      // reader was `readJson`, which buffers whatever it is handed — fine while
      // every field here was a few hundred bytes of control payload, and no
      // longer the whole story now that `env` invites a map. The sanitizer's own
      // 16 KiB cap bounds what is STORED and handed to execve; it cannot bound
      // what was allocated to reach it, because the parse has already happened.
      // On the default `off` posture that allocation needs no credential, and
      // since DRY-57 inverted the crash posture an OOM here takes the desk down
      // rather than being ridden out.
      //
      // 1 MiB, not 16 KiB: `input` (DRY-49's initial prompt) legitimately has no
      // small bound, and a cap that made a long prompt fail would trade one
      // silent failure for a louder one nobody asked for.
      let body: any;
      try {
        body = await readJsonCapped(req, 1_048_576, "spawn body");
      } catch (err) {
        if (err instanceof PayloadTooLarge) return send(res, 413, { error: err.message });
        return send(res, 400, { error: `invalid JSON body: ${String(err)}` });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return send(res, 400, { error: "body must be a JSON object" });
      }
      if (!body.command || typeof body.command !== "string") {
        return send(res, 400, { error: "command is required" });
      }
      // Per-spawn environment (DRY-66). Checked here, with the other pure
      // validation and BEFORE the worktree block below, because that block has
      // a side effect: a refusal further down would leave a git worktree and a
      // branch on disk for a spawn that never happened. See spawn-env.ts for
      // why this field is refused rather than filtered, and for the narrow line
      // its deny set actually draws — it is not, and cannot be, a boundary on a
      // route that already takes `command` and `args`.
      const spawnEnv = sanitizeSpawnEnv(body.env);
      if (!spawnEnv.ok) return send(res, 400, { error: spawnEnv.error });
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
        // The daemon's own four keys are spread AFTER this map in session.ts,
        // and DRY-59's strip runs after that again in the supervisor. So a
        // caller can neither reassign the session key it would answer its own
        // permission gates with, nor set a marker that gets deleted with no
        // word said — the route refuses those outright instead.
        env: spawnEnv.env,
        cwd,
        ticket,
        // The tracker repo NAME, not just the cwd it resolved to (DRY-56):
        // a tombstone has to be able to say what a dead session was working on.
        repo: typeof body.repo === "string" ? body.repo : undefined,
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
        // Whose run this is (DRY-27). From the authenticated caller and NEVER
        // from the body — a spawn that could name its own owner would let
        // anyone put a session on somebody else's desk, or hide one on nobody's.
        owner: me().id,
        ownerName: me().name,
        // Visibility, unlike the owner, IS the caller's to choose — it is the
        // one thing about a run only the person starting it knows. Whitelisted
        // rather than coerced, and anything unrecognised reads as `private`:
        // the failure direction for a typo has to be "fewer people saw it".
        visibility: body.visibility === "public" ? ("public" as SessionVisibility) : "private",
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
    //
    // Refuses by default since DRY-90: `removeWorktree` used to pass `--force`
    // unconditionally, so this route was "delete it whatever it holds" and the
    // only thing standing between a stale worktree and its uncommitted contents
    // was that nothing automatic ever called it. A 409 carries the safety report
    // so the panel can say what would be lost; `force: true` is the human having
    // read that and meant it.
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
        removeWorktree(repoDir, body.worktree, { force: body.force === true });
        return send(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof WorktreeNotSafe) {
          return send(res, 409, { error: err.message, safety: err.safety });
        }
        return send(res, 500, { error: `worktree remove: ${String(err)}` });
      }
    }

    // Consider ONE worktree against the reaper's policy and remove it if it
    // passes (DRY-90) — the explicit trigger, for a window somebody closed.
    //
    // It applies exactly the policy the scheduled sweep does, which is the
    // point: a close is a trigger for evaluating the predicate, never a way
    // round it. So a dirty or unmerged worktree comes back `removed: false`
    // with a reason, and the caller says nothing rather than prompting about
    // something that would be refused anyway.
    //
    // Scoped to worktrees the daemon manages — `describeManagedWorktree` refuses
    // anything whose parent directory isn't DRYDOCK_WORKTREES_ROOT. The route
    // above will act on any path it is given, as it always has; this one, being
    // the one a client calls without a human reading a confirmation first,
    // deliberately cannot.
    if (pathname === "/api/worktrees/reap" && req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.worktree !== "string") {
        return send(res, 400, { error: "worktree is required" });
      }
      const managed = describeManagedWorktree(body.worktree);
      if (!managed) {
        return send(res, 404, { error: `${body.worktree} is not a drydock-managed worktree` });
      }
      const decision = await reaper.reapOne(managed);
      return send(res, 200, {
        removed: decision.verdict === "reaped",
        verdict: decision.verdict,
        reason: decision.reason,
        worktree: managed.path,
        branch: managed.branch,
        ticket: managed.ticket,
      });
    }

    const killMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/kill$/);
    if (killMatch && req.method === "POST") {
      const session = manager.get(killMatch[1]);
      // A session that isn't there is not an error: "gone" is the state that was
      // asked for. This route has always been idempotent and has to stay that
      // way — DRY-60's sweep and the ✕ button race each other by design, and a
      // second kill landing after the first must not raise a banner.
      if (!session) return send(res, 200, { ok: true });
      // Somebody else's, though, is refused — and refused as "unknown", so this
      // doesn't become a way to enumerate other people's sessions. Before
      // accounts this was a bare `manager.remove(id)`: harmless when one person
      // could reach the port, and a bulk clear that stops a colleague's live
      // agent (reporting success) once several can.
      if (!session.ownedBy(me().id)) {
        return send(res, 404, { error: `unknown session ${killMatch[1]}` });
      }
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
    //
    // `owner` became a real boundary in DRY-27. It is still never taken from the
    // request — it is the authenticated caller's id, which on the single-account
    // postures is exactly the host-config constant it always was, so a desk
    // saved before accounts existed is still the desk that loads.
    if (pathname === "/api/workspace") {
      const name = url.searchParams.get("name") || CONFIG.state.workspace;
      const owner = me().id;
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
          body = await readJsonCapped(req, CONFIG.state.maxBytes, "workspace");
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
      // "own", and the comment that used to be here was wrong in a way worth
      // recording: it argued this only shows you what the terminal already has,
      // so a spectator could read it out of the scrollback anyway. That is not
      // what this route does. It resolves an ARBITRARY relative path under the
      // session's working directory and reads the file — the agent need never
      // have opened it. On a public run that made every .md and .txt in
      // somebody else's worktree readable by anyone signed in, which is a
      // different thing entirely from watching their terminal.
      const session = sessionFor(fileMatch[1], me().id, "own", res);
      if (!session) return;
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
      // One ticket's children (DRY-83), for the sidebar expanding an epic. Same
      // route rather than a new one: it wants the same cache, the same 502, and
      // the same `stale` contract, and all three already live here.
      const parent = url.searchParams.get("parent") ?? undefined;
      const query = {
        project: url.searchParams.get("project") ?? undefined,
        // A parent query is NOT project-scoped. It already names one ticket's
        // children, so scoping can only wrongly hide a child that lives in
        // another project — and the bound the scope exists to provide (DRY-30)
        // is already there: an epic's children are not a corporate tracker.
        projects: parent ? undefined : scopedProjects(),
        open: url.searchParams.get("open") === "true",
        // Backlog stays out of the pull unless asked for (DRY-30). The sidebar
        // DOES ask for it on a parent query — reaching an epic's not-yet-started
        // children without pulling the whole backlog is the point of DRY-83.
        includeBacklog: url.searchParams.get("backlog") === "true",
        parent,
        text: url.searchParams.get("text") ?? undefined,
      };
      try {
        // Cached and coalesced (DRY-72) — see tracker/cache.ts. This is the
        // sidebar's 20s poll, once per browser tab, and against a corporate Jira
        // the underlying pull runs 5.7-6s; without this the daemon re-ran the
        // whole fan-out for every tab on every tick, and the browser waited on
        // it. Note what the cache does NOT do: it never answers with a failure,
        // so `stale` rides along instead and the sidebar can still say the list
        // has stopped moving (DRY-55). Only a cold cache can 502 here now.
        const { tickets, stale } = await ticketCache.get(
          ticketQueryKey(query),
          () => tracker.listTickets(query),
          // `fresh=true` is the sidebar's Refresh button (and its outage Retry)
          // overruling the cadence. Without it that button would spin against
          // the cache and change nothing — and the one moment somebody presses
          // it is the moment they've stopped trusting what's on screen.
          { force: url.searchParams.get("fresh") === "true" },
        );
        return send(res, 200, { tickets, ...(stale ? { stale } : {}) });
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
        // No `thread` (DRY-53): this serves the shell's ticket panel, which
        // renders the description and nothing from the comment history or the
        // epic walk. Asking for them here would put 2 extra Switchyard round
        // trips behind every ticket click for data that goes straight in the
        // bin.
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
      if (!hookAuthorized(session, req)) {
        // Logged loudly: on a daemon with auth on, this means something that
        // is not this session's own CLI is POSTing its hook endpoint — either a
        // stale settings file from a session spawned by another daemon, or
        // somebody probing. Both are worth a line, and neither may hold the
        // connection open the way a real gate does.
        log.warn("hook rejected — wrong or missing session key", { id: session.id });
        return send(res, 401, { error: "bad session key" });
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
      noteFromHook(session, body);
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
      if (session && hookAuthorized(session, req) && typeof body?.tool_name === "string") {
        session.noteActivity(body.tool_name, body.tool_input ?? {});
        noteFromHook(session, body);
      }
      // Still 200 on a rejected key, unlike the gate above. This hook feeds a
      // caption and holds nothing open; answering it with an error would put a
      // failure in the agent's transcript for a cosmetic write we simply
      // declined to make.
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
      const body = await readJson(req).catch(() => ({}));
      if (session && hookAuthorized(session, req)) {
        session.markIdle();
        noteFromHook(session, body);
      }
      return send(res, 200, {});
    }

    // --- SessionStart hook endpoint (DRY-9 ticket-spawn) ---
    // When a session was spawned for a ticket, the wrapped CLI's SessionStart
    // hook hits this and we return Claude Code's `additionalContext` schema
    // carrying the ticket body — so the agent starts with the full ticket in
    // context without it being typed into the prompt. Non-ticket sessions (or an
    // unknown one) get an empty object, which the hook treats as "no context".
    if (pathname === "/hook/sessionstart" && (req.method === "POST" || req.method === "GET")) {
      const sessionId = (req.headers["x-drydock-session"] as string | undefined) ?? "";
      const session = manager.get(sessionId);
      if (session && !hookAuthorized(session, req)) {
        log.warn("session-start hook rejected — wrong or missing session key", { id: session.id });
        return send(res, 401, { error: "bad session key" });
      }
      // Before the ticket check, not after: a session with no ticket still has
      // an agent session id worth recording, and it is the earliest moment we
      // can learn it (DRY-56).
      if (req.method === "POST") {
        noteFromHook(session, await readJson(req).catch(() => ({})));
      }
      if (!session?.ticket) return send(res, 200, {});
      try {
        // The one caller that reads the thread and the epic, so the one that
        // pays for them (DRY-53).
        const t = await tracker.getTicket(session.ticket, { thread: true });
        return send(res, 200, {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            // Comment thread + epic keys, windowed to a budget (DRY-53). The
            // shape of the brief lives in tracker/context.ts.
            additionalContext: ticketContext(t),
          },
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
  // Async since DRY-27 — deciding who is attaching can mean a round trip to the
  // accounts store — so the catch has to cover the rejection as well as the
  // synchronous throw. A promise rejecting out of here would reach
  // `unhandledRejection` with a socket left open and nothing ever written to it.
  try {
    void upgrade(req, socket, head).catch((err) => {
      log.warn("upgrade failed — closing socket", describe(err));
      socket.destroy();
    });
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

async function upgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attach$/);
  if (!match) {
    return rejectUpgrade(socket, 404, "not a session attach endpoint", {
      path: url.pathname,
    });
  }
  // A browser's WebSocket constructor cannot set an Authorization header, so
  // this is the second of the two transports that take a short-lived `stream`
  // token in the query string instead (see Audience in auth/tokens.ts). The
  // header is still read first, which is what makes `wscat`/curl testing with
  // an ordinary bearer work.
  const result = await auth.identify(req.headers.authorization, {
    streamToken: url.searchParams.get("token") ?? undefined,
  });
  if (!result.ok) {
    // 401 with a real response, not a bare destroy: the browser reports a
    // failed handshake as an opaque code-1006 close, so without this the one
    // symptom of an expired token would be a pane that reconnects forever.
    return rejectUpgrade(socket, result.reason === "unavailable" ? 503 : 401, "not signed in", {
      id: match[1],
      reason: result.reason,
    });
  }
  const viewer = result.identity;
  const session = manager.get(match[1]);
  if (!session || !session.visibleTo(viewer.id)) {
    // The stale-tab case: a browser reconnecting to a session this daemon no
    // longer has (it restarted, or the session was killed). Silently destroying
    // the socket made the single most likely post-restart symptom invisible.
    // Somebody else's session answers identically — see sessionFor().
    return rejectUpgrade(socket, 404, "unknown session", { id: match[1] });
  }
  /**
   * May this client TYPE, or only watch? (DRY-27)
   *
   * This is what makes a `public` run worth having. Refusing the attach
   * outright would leave "everyone can see it" meaning nothing but a card on a
   * rail; accepting input from anyone would mean a spectator can type into
   * somebody else's agent. So the socket opens for anyone who may see the
   * session, and the frames that CHANGE it are dropped for everyone else.
   *
   * Decided once, here, from the identity that opened the socket — not
   * per-frame from something the client sends.
   */
  const mayDrive = session.ownedBy(viewer.id);
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
      // Every frame here changes the session, so a spectator on a public run
      // has nothing to send. Dropped silently rather than answered with an
      // error: the shell already knows (it renders a read-only pane), and a
      // stray keystroke is not worth a round trip to be told about.
      if (!mayDrive) return;
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

// --- Crash containment (DRY-45, revised by DRY-57, reported by DRY-48) ---
// This process is no longer the lifetime of the sessions it owns. Each PTY is
// held by its own detached supervisor and found again at boot, so an exit costs
// a reconnect rather than every agent on the host.
//
// Two of the three rules survive that change, and one inverts. Still true: never
// die for a reason that only concerns one client (a bad WebSocket frame, a
// vanished SSE reader), and always leave a trace when we do die. No longer true:
// that staying up in a suspect state beats exiting — see CONFIG.log.onUncaught,
// which since DRY-48 is a policy rather than a boolean, and the faults it counts.

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
  // Recorded BEFORE the log line, so a process that exits on the next statement
  // has still counted the fault — and so a `/healthz` polled between the throw
  // and a `when-idle` exit says what happened. `faults.record` cannot throw by
  // construction (health.ts), which is the same constraint `describe` is
  // written to: a TypeError raised INSIDE this handler is fatal (Node exits 7),
  // and a crash handler with its own crash path is worse than no handler.
  // faults.record("uncaughtException", err);
  // describe() rather than err.message: `throw null` makes that dereference a
  // TypeError. Stack goes in as a field so the record stays one greppable line.
  log.error("UNCAUGHT EXCEPTION", {
    ...describe(err),
    ...inventory(),
    action: {
      exit: "exiting",
      stay: "staying up",
      "when-idle": "staying up until nothing is running",
    }[CONFIG.log.onUncaught],
    faults: faults.total,
  });
  // Node's default here is to die, and since DRY-57 we let it: the sessions
  // outlive us and a fresh daemon reattaches to them, which beats serving the
  // shell from a process in an unknown state. The other two postures are
  // DRYDOCK_EXIT_ON_UNCAUGHT=0 (wedged-but-attached, what shipped before
  // DRY-57) and =idle (DRY-48) — see config.ts.
  if (CONFIG.log.onUncaught === "exit") process.exit(1);
  if (CONFIG.log.onUncaught === "when-idle") idleExit.arm();
});

process.on("unhandledRejection", (reason) => {
  faults.record("unhandledRejection", reason);
  log.error("UNHANDLED REJECTION", { ...describe(reason), ...inventory(), faults: faults.total });
  // Deliberately not routed through the exit policy, which is about uncaught
  // EXCEPTIONS and says so in its name. A rejection leaves a far narrower dent —
  // one promise chain failed, rather than an arbitrary point in a synchronous
  // run being abandoned mid-way — and it has never exited this daemon, so
  // routing it here would smuggle a real behaviour change into a ticket about
  // reporting. It is counted, so /healthz reports the process as suspect, which
  // is what DRY-48 was actually asked for.
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
    auth: CONFIG.auth.mode,
  });
  // Said once, at the top of every log, because the alternative is that nobody
  // ever finds out. This process spawns arbitrary commands as the host user, so
  // "who can reach this port" is the single most consequential thing about how
  // it is configured — and the default is still open, because a fresh clone has
  // to work. A warning that names the fix is the least this can do.
  if (!CONFIG.auth.enabled && CONFIG.host !== "127.0.0.1" && CONFIG.host !== "localhost") {
    log.warn("UNAUTHENTICATED on a non-loopback address — anyone who can reach this port can run commands as you", {
      host: CONFIG.host,
      fix: "set DRYDOCK_AUTH_PASSWORD, or bind DRYDOCK_HOST=127.0.0.1",
    });
  }
  // Look for finished worktrees (DRY-90). AFTER the port is bound and never
  // awaited: it walks git repos, and the reason `manager.reconcile()` above sits
  // where it does is that nothing may delay a daemon answering for its sessions.
  // Boot is the trigger that matters — a merge lands while the daemon is down
  // far more often than while it is up.
  reaper.start();
});
