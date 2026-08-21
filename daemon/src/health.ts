// What state this daemon is actually in (DRY-48).
//
// `/healthz` used to be a one-line handler answering `{ok:true, sessions:N}`,
// which proved that the event loop still turned and the HTTP server still
// answered — and nothing else. It could not fail. That became load-bearing at
// DRY-45, which let the process survive an uncaught exception on the reasoning
// that a restart was a guaranteed total loss of every PTY while wedging was a
// possible partial one: a daemon that had taken a fault and was in a suspect
// state looked exactly as healthy from outside as one that hadn't, and prod's
// unit is Restart=always, so systemd had nothing to act on either way.
//
// DRY-57 changed the trade (sessions outlive the process now, so the default
// flipped back to exiting) but not the gap: nothing anywhere said "this process
// is suspect". This module is that signal, and the three states it can report
// are chosen for what somebody would DO about them:
//
//   ok        everything probed is working.
//   degraded  something is broken and no PTY is at risk — a dead workspace
//             store, an unreachable tracker, a log file that can't be written,
//             or a fault this process took and stayed up through. **Not an
//             instruction to restart.** A daemon holding five live agents after
//             one uncaught exception is not down, and restarting it for being
//             suspect costs exactly the thing DRY-45 was protecting.
//   down      the daemon cannot do its core job: the session registry can't be
//             enumerated, or the rediscovery index (DRY-57) can't be read or
//             written, so a new session can't be recorded and a restart won't
//             find the running ones. Also not an instruction to restart —
//             restarting a daemon whose sessions dir has vanished ABANDONS
//             those agents. It says a human is needed.
//
// `ok` on the wire keeps its old meaning deliberately: false only for `down`.
// Everything already watching this endpoint (the harnesses, docs/deploy.md, a
// monitor somebody wrote) reads that boolean, and a daemon that starts
// answering false because its tracker is unreachable would be this ticket
// making liveness LESS useful rather than more.
import { CONFIG, type UncaughtPolicy } from "./config.js";
import { log } from "./log.js";
import { indexHealth } from "./sessions-dir.js";
import type { StateStore, StoreHealth } from "./state/types.js";
import { TrackerHttpError, type TrackerProvider } from "./tracker/types.js";

export type HealthStatus = "ok" | "degraded" | "down";

/** Uncaught exceptions and unhandled rejections this process has taken. */
export interface FaultReport {
  total: number;
  uncaughtExceptions: number;
  unhandledRejections: number;
  /** ISO timestamp of the most recent one. Absent when there have been none. */
  lastAt?: string;
  /** One line: `TypeError: x is not a function`. No stack — that's in the log. */
  last?: string;
  /** What the NEXT uncaught exception will do (DRYDOCK_EXIT_ON_UNCAUGHT). */
  onUncaught: UncaughtPolicy;
  /**
   * Set when `when-idle` is armed: this process has taken a fault and will exit
   * as soon as nothing is running. Reported because "it's still here" and "it's
   * still here for now" are different answers to a monitor.
   */
  exitWhenIdle?: boolean;
}

/** The session registry, and the on-disk index a restart reads it back from. */
export interface RegistryReport {
  ok: boolean;
  sessions: number;
  live: number;
  /** The rediscovery index directory (DRY-57), and whether it still works. */
  index: { ok: boolean; dir: string; error?: string };
  error?: string;
}

/** The log sink — DRY-45's "the sessions died and there are no logs" claim. */
export interface LogReport {
  ok: boolean;
  /** "" when the file sink is deliberately disabled (DRYDOCK_LOG_FILE=). */
  file: string;
  /** Lines lost while the file sink has been down. */
  droppedLines?: number;
  /** How long it has been down, seconds. */
  downSec?: number;
  error?: string;
}

export interface TrackerReport {
  /** The provider actually in use. */
  id: string;
  /** DRYDOCK_TRACKER. Differs from `id` when the daemon fell back to fixture. */
  configured: string;
  /**
   * `unknown` until something asks it something. Deliberately NOT probed from
   * here — see `TrackerWatch`.
   */
  state: "ok" | "degraded" | "unknown";
  lastOkAt?: string;
  /** Consecutive failures since the last answer. */
  failures?: number;
  error?: string;
}

export interface DaemonHealth {
  /** False ONLY for `down` — see the header. */
  ok: boolean;
  status: HealthStatus;
  /** Registry size. Unchanged from what this endpoint has always reported. */
  sessions: number;
  uptimeMs: number;
  pid: number;
  faults: FaultReport;
  registry: RegistryReport;
  log: LogReport;
  tracker: TrackerReport;
  store: StoreHealth & { capabilities: { sessionHistory: boolean } };
}

/**
 * `/readyz`. Deliberately a NARROWER question than `/healthz`, not a summary of
 * it: it never consults the workspace store or the tracker, because an outage in
 * either costs nobody a PTY (DRY-28's first non-negotiable property) and a
 * supervisor acting on one would restart a daemon that is serving perfectly.
 *
 * It also never blocks. `/healthz` awaits `store.health()`, which can sit there
 * for the pool's connect timeout when a configured Postgres is down — fine for a
 * human reading a report, wrong for the endpoint something polls on a timer.
 */
export interface Readiness {
  ready: boolean;
  sessions: number;
  live: number;
  /** This process has taken a fault. NOT a reason to be un-ready — see above. */
  suspect: boolean;
  faults: number;
  /** Why `ready` is false. Absent when it's true. */
  reason?: string;
}

/** Cap on anything derived from an error message put on the wire. */
const ERROR_MAX = 300;

/** Squash to one capped line, and never throw doing it. */
function oneLine(err: unknown): string {
  let text: string;
  try {
    // `${err.name}: ${err.message}` rather than the stack: this rides on an
    // unauthenticated endpoint and the stack is already in the log file, which
    // is where somebody debugging is.
    text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  } catch {
    // `throw {toString(){throw 1}}` is legal, and this runs in a crash handler.
    text = "(unstringifiable)";
  }
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > ERROR_MAX ? `${one.slice(0, ERROR_MAX - 1)}…` : one;
}

type FaultKind = "uncaughtException" | "unhandledRejection";

/**
 * The count and the last one of each, and nothing else.
 *
 * A module singleton like `log`, for the same reason: the crash handlers that
 * feed it are registered at the bottom of server.ts and must not have to be
 * handed a dependency to record a fault. Every method here is written on the
 * assumption that it runs INSIDE `process.on("uncaughtException")`, where a
 * throw is fatal — Node exits 7 and takes every session's daemon-side link with
 * it, so a crash handler with its own crash path is worse than no handler
 * (log.ts's `describe` exists for the same reason).
 */
class FaultLog {
  private readonly counts: Record<FaultKind, number> = {
    uncaughtException: 0,
    unhandledRejection: 0,
  };
  private lastAt = 0;
  private lastText: string | undefined;

  record(kind: FaultKind, err: unknown): void {
    try {
      this.counts[kind] += 1;
      this.lastAt = Date.now();
      this.lastText = oneLine(err);
    } catch {
      /* the log line is the durable record; these counters are the summary */
    }
  }

  get total(): number {
    return this.counts.uncaughtException + this.counts.unhandledRejection;
  }

  report(onUncaught: UncaughtPolicy, exitWhenIdle: boolean): FaultReport {
    return {
      total: this.total,
      uncaughtExceptions: this.counts.uncaughtException,
      unhandledRejections: this.counts.unhandledRejection,
      ...(this.lastAt ? { lastAt: new Date(this.lastAt).toISOString() } : {}),
      ...(this.lastText ? { last: this.lastText } : {}),
      onUncaught,
      ...(exitWhenIdle ? { exitWhenIdle: true } : {}),
    };
  }
}

export const faults = new FaultLog();

/**
 * Statuses that mean "the tracker answered, and the answer was no".
 *
 * 429 and 408 are absent on purpose (rate-limited and timed out are both a
 * tracker this daemon can't currently use), and so is every 5xx.
 */
const CALLER_FAULT = new Set([400, 404, 405, 409, 410, 422]);

/**
 * What the tracker has been doing, OBSERVED rather than probed.
 *
 * Health must not go and ask the tracker itself. One sidebar pull against a
 * corporate Jira measured 5.7-6s of cursor pages (DRY-72), so a probe here
 * would put that fan-out behind every poll of a health endpoint — reinstating,
 * on a timer nobody can see, exactly the cost that ticket removed. So this
 * records the outcome of the calls the daemon was making anyway, and reports
 * `unknown` until there has been one. A daemon nobody has opened a browser at
 * is not degraded; it is unasked.
 */
export class TrackerWatch {
  private okAt = 0;
  private failures = 0;
  private lastError: string | undefined;

  /**
   * The tracker answered. Also called for a request the TRACKER was right to
   * refuse — see `failed`.
   */
  answered(): void {
    this.okAt = Date.now();
    this.failures = 0;
    this.lastError = undefined;
  }

  failed(err: unknown): void {
    // A 404 for a ticket key somebody mistyped proves the tracker is reachable
    // — we asked it and it told us. Counting that as an outage would have a
    // health endpoint report a degraded daemon because of one bad key in the
    // Ctrl+K palette, and (since nothing else may be polling) leave it saying so
    // indefinitely. 401/403 deliberately do NOT get this treatment: a credential
    // the tracker rejects means every call will fail, which is precisely a
    // tracker this daemon cannot use.
    if (err instanceof TrackerHttpError && CALLER_FAULT.has(err.status)) {
      this.answered();
      return;
    }
    this.failures += 1;
    this.lastError = oneLine(err);
  }

  report(id: string): TrackerReport {
    const configured = CONFIG.tracker.kind;
    const base = { id, configured };
    // A live provider that couldn't be configured falls back to fixture data
    // with a warning at boot (tracker/index.ts) — one log line, at the moment
    // nobody is reading, after which the sidebar renders five invented tickets
    // and looks like a working tracker. That is the same class of silence this
    // whole ticket is about, so it reports as degraded regardless of what has
    // or hasn't been asked since.
    if (configured !== id) {
      return {
        ...base,
        state: "degraded",
        error: `DRYDOCK_TRACKER=${configured} but this daemon is serving ${id} data — check the credentials it needs`,
      };
    }
    if (this.failures) {
      return {
        ...base,
        state: "degraded",
        failures: this.failures,
        ...(this.okAt ? { lastOkAt: new Date(this.okAt).toISOString() } : {}),
        ...(this.lastError ? { error: this.lastError } : {}),
      };
    }
    if (!this.okAt) return { ...base, state: "unknown" };
    return { ...base, state: "ok", lastOkAt: new Date(this.okAt).toISOString() };
  }
}

export const trackerWatch = new TrackerWatch();

/**
 * Record what every tracker call did, wherever it was called from.
 *
 * A wrapper rather than a line at each of the six call sites (five in server.ts,
 * one in runs.ts), because the seventh would be added by somebody who had never
 * read this file. `comment`/`transition` are conditionally present because the
 * interface makes them optional and `runs.ts` tests for `tracker.comment`
 * before using it — a wrapper that always defined them would tell that check
 * the fixture provider can post to tickets.
 */
export function watchTracker(inner: TrackerProvider, watch = trackerWatch): TrackerProvider {
  const seen = async <T>(work: Promise<T>): Promise<T> => {
    try {
      const out = await work;
      watch.answered();
      return out;
    } catch (err) {
      watch.failed(err);
      throw err;
    }
  };
  return {
    id: inner.id,
    name: inner.name,
    capabilities: inner.capabilities,
    listProjects: () => seen(inner.listProjects()),
    listTickets: (q) => seen(inner.listTickets(q)),
    searchTickets: (text, projects) => seen(inner.searchTickets(text, projects)),
    getTicket: (key, opts) => seen(inner.getTicket(key, opts)),
    ...(inner.comment ? { comment: (k: string, b: string) => seen(inner.comment!(k, b)) } : {}),
    ...(inner.transition
      ? { transition: (k: string, to: string) => seen(inner.transition!(k, to)) }
      : {}),
  };
}

/** How often an armed `when-idle` policy re-asks whether anything is running. */
const IDLE_POLL_MS = 5_000;

/**
 * The conditional arm of DRYDOCK_EXIT_ON_UNCAUGHT (DRY-48).
 *
 * The knob was a blunt either/or because "wedged" wasn't expressible: exit
 * immediately and take the reconnect, or stay up forever in a state nobody can
 * see. With the fault recorded, the interesting policy is the one the ticket
 * names — stay up while there is something to lose, exit once the process is
 * both suspect AND idle, so a fresh daemon takes over at the moment that costs
 * nothing.
 *
 * A POLL rather than a subscription to session ends, deliberately. This arms
 * inside a crash handler, in a process whose state is by definition suspect;
 * hanging the exit off a listener means that if the thing that broke is what
 * would have fired it, the daemon stays up forever and the policy is silently
 * off. The timer is unref'd so it is never itself a reason to stay alive.
 */
export class IdleExit {
  private timer: NodeJS.Timeout | undefined;
  private fired = false;

  constructor(
    private readonly deps: {
      /** Nothing left to lose: no session is still running. */
      idle: () => boolean;
      exit: () => void;
      everyMs?: number;
    },
  ) {}

  /** Armed, i.e. this process is now waiting for a quiet moment to exit. */
  get armed(): boolean {
    return this.timer !== undefined || this.fired;
  }

  arm(): void {
    if (this.armed) return;
    // Checked once immediately: a fault taken on a daemon with nothing running
    // must not wait out a poll interval to act on a decision already made.
    if (this.check()) return;
    this.timer = setInterval(() => this.check(), this.deps.everyMs ?? IDLE_POLL_MS);
    this.timer.unref();
  }

  /** True once it has exited (or asked to). */
  private check(): boolean {
    let idle: boolean;
    try {
      idle = this.deps.idle();
    } catch {
      // Suspect process, remember. If we can't tell whether anything is running,
      // the safe answer is "something is" — this policy exists to avoid exiting
      // while there is something to lose.
      return false;
    }
    if (!idle) return false;
    this.fired = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.deps.exit();
    return true;
  }
}

/** Anything with a liveness bit — `PtySession`, without importing it. */
interface Live {
  running: boolean;
}

/**
 * Assembles the report. Constructed once in server.ts, which owns every part it
 * asks: the registry, the store and the tracker are injected rather than
 * imported so this file stays a thing that has opinions about state and reaches
 * for nothing on its own (the same rule `runs.ts` and the worktree reaper
 * follow).
 */
export class Health {
  constructor(
    private readonly deps: {
      sessions: () => readonly Live[];
      store: StateStore;
      trackerId: string;
      idleExit: IdleExit;
    },
  ) {}

  /**
   * The registry and the on-disk index behind it. Cheap enough for every poll —
   * one `access` and one `readdir` over a directory holding a handful of files
   * per session, which is what keeps this off the store's blocking path.
   *
   * The index is probed first and separately so a registry that can't be listed
   * still reports what it found about the directory: two independent ways for
   * this daemon to lose track of its own sessions, and a report that folded them
   * together would leave whoever reads it guessing which one happened.
   */
  private registry(): RegistryReport {
    const index = indexHealth();
    try {
      const sessions = this.deps.sessions();
      return {
        ok: index.ok,
        sessions: sessions.length,
        live: sessions.filter((s) => s.running).length,
        index,
      };
    } catch (err) {
      // In memory, and it still can't be listed. Nothing this daemon says about
      // itself is trustworthy after that, which is the whole of `down`.
      return { ok: false, sessions: 0, live: 0, index, error: oneLine(err) };
    }
  }

  /** Everything, including the store probe that is allowed to block. */
  async report(): Promise<DaemonHealth> {
    const registry = this.registry();
    const logSink = log.health();
    const tracker = trackerWatch.report(this.deps.trackerId);
    const store = {
      ...(await this.deps.store.health()),
      // What this backend can do, not just whether it's up (DRY-56). For an
      // operator, not the shell — the shell learns the same fact from
      // /api/sessions/history answering 501, which is the answer it needs at the
      // moment it needs it, and a second source for one truth is how the two
      // drift. Derived from whether the port exists, so it can't claim more than
      // the store implements.
      capabilities: { sessionHistory: Boolean(this.deps.store.history) },
    };
    const status: HealthStatus = !registry.ok
      ? "down"
      : faults.total || !logSink.ok || !store.ok || tracker.state === "degraded"
        ? "degraded"
        : "ok";
    return {
      ok: status !== "down",
      status,
      sessions: registry.sessions,
      uptimeMs: Math.round(process.uptime() * 1000),
      pid: process.pid,
      faults: faults.report(CONFIG.log.onUncaught, this.deps.idleExit.armed),
      registry,
      log: logSink,
      tracker,
      store,
    };
  }

  /** The thin one. Nothing here awaits anything. */
  readiness(): Readiness {
    const registry = this.registry();
    return {
      ready: registry.ok,
      sessions: registry.sessions,
      live: registry.live,
      suspect: faults.total > 0,
      faults: faults.total,
      ...(registry.ok
        ? {}
        : {
            reason:
              registry.error ??
              `the session index at ${registry.index.dir} can't be read or written: ${registry.index.error}`,
          }),
    };
  }
}
