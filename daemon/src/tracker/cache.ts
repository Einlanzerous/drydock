import { CONFIG } from "../config.js";
import type { Ticket } from "./types.js";

/**
 * Tracker caching (DRY-72).
 *
 * Until this existed there was none anywhere in the tracker path: every
 * `/api/tracker/tickets` went straight at the provider, and the sidebar polls
 * that route every 20s **per browser tab**. Against a corporate Jira one pull
 * measured 5.7-6s — three cursor pages for the list plus a `parent in (…)` child
 * query spanning every status — so the browser's own 12s budget
 * (`LIST_TIMEOUT_MS`) was being tripped by ordinary load rather than by an
 * outage, and each abort left the daemon still walking pages for a client that
 * had stopped listening.
 *
 * Two caches, at two layers, because the two costs behave differently:
 *
 *  - `TicketListCache` sits in FRONT of the provider (the route owns it) and
 *    makes the browser stop waiting on the tracker at all.
 *  - `ChildStatsCache` sits INSIDE the providers, because only they know how to
 *    ask, and the ask differs (Jira: one query for every epic; Switchyard: one
 *    per epic through a pool). It's shared rather than per-provider so the two
 *    can't drift on how long a completion ratio stays good for.
 *
 * Neither ever caches a failure. A tracker that goes down leaves the last-good
 * answer in place and records *why* it stopped moving, which is the whole
 * distinction DRY-55 rests on.
 */

/** What a cached list answer carries back to the route. */
export interface CachedTickets {
  tickets: Ticket[];
  /**
   * Set only when the last refresh FAILED — never merely because the entry is
   * older than the TTL.
   *
   * That distinction is load-bearing, and it is what keeps DRY-55 alive through
   * this change. Under stale-while-revalidate the browser's `catch` stops firing
   * for a tracker outage, because the daemon now answers 200 with the last-good
   * list instead of 502ing — so if the response didn't SAY so, the sidebar's
   * stale line would silently die and the desk would go back to presenting an
   * hour-old ticket as current. Age alone must not raise it: an entry is stale
   * by design for the fraction of a second between a poll noticing and the
   * background refresh landing, and a notice that flickers once every 20s is
   * worse than none.
   */
  stale?: { ageMs: number; error: string };
}

/**
 * Cap on the error text put on the wire, since it now rides along with EVERY
 * poll rather than appearing once in a 502 body.
 *
 * Both providers build their message as `${status} ${await res.text()}`, so a
 * tracker behind a proxy that answers with an HTML page puts the whole page in
 * there (DRY-55 case (e)). The sidebar caps again before rendering — that cap is
 * still the one that matters for the header — but there's no reason to ship
 * kilobytes of markup every 20s to something that will throw it away.
 */
const ERROR_MAX = 500;

function describe(err: unknown): string {
  const one = String(err).replace(/\s+/g, " ").trim();
  return one.length > ERROR_MAX ? `${one.slice(0, ERROR_MAX - 1)}…` : one;
}

interface Entry {
  /** Absent until the first successful fetch — see the cold path in `get`. */
  tickets?: Ticket[];
  /** When `tickets` came back from the tracker. 0 = never. */
  at: number;
  /** The refresh failure standing since `at`. Raw, so the route can `String()` it as before. */
  error?: unknown;
  /** In-flight refresh, i.e. the single-flight handle. Never rejects. */
  refreshing?: Promise<void>;
  /** Last time a client asked for this key; drives eviction only. */
  readAt: number;
}

/**
 * Stale-while-revalidate + single-flight for the sidebar's ticket pull.
 *
 * **A plain TTL cannot work here, and the reason is worth writing down.** The
 * shell polls on a fixed 20s interval, so a TTL shorter than that misses on
 * every single poll — one tab gets no benefit whatsoever — while a TTL longer
 * than it just makes the sidebar staler than DRY-17 intended without ever
 * removing the wait. SWR sidesteps the choice: a client is answered from memory
 * immediately and the refresh happens behind it, so the TTL sets how old the
 * data may be *without* setting how long anybody waits. The only request that
 * still blocks on the tracker is the first one after a daemon start.
 *
 * Single-flight is the other half, and it's what makes a second browser tab (or
 * a second person) free rather than double: concurrent misses on the same key
 * share one fan-out instead of racing two identical ones at a tracker that may
 * rate-limit.
 */
export class TicketListCache {
  private readonly entries = new Map<string, Entry>();

  /**
   * @param ttlMs   how old a list may get before a refresh is kicked off. 0
   *                disables the cache entirely — a passthrough, not a
   *                zero-length TTL, since the latter would leave every answer
   *                permanently stale-and-refreshing rather than off.
   * @param idleMs  how long an unread key survives. The key is the query, and
   *                the scope chips (DRY-30) mean a client can mint new ones, so
   *                without this the map grows for the daemon's lifetime.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly idleMs = 600_000,
  ) {}

  /**
   * @param force  bypass the TTL and WAIT for the refresh. This is the sidebar's
   *               Refresh button, and it is not optional politeness: that button
   *               exists to overrule the cadence, so a cached answer would make
   *               it a no-op that still spins. It stays single-flight — forcing
   *               joins a refresh already running rather than starting a second
   *               — and a forced refresh that FAILS still answers from
   *               last-good, marked stale, rather than throwing away a list that
   *               works.
   */
  async get(
    key: string,
    fetch: () => Promise<Ticket[]>,
    { force = false } = {},
  ): Promise<CachedTickets> {
    if (!this.ttlMs) return { tickets: await fetch() };

    const now = Date.now();
    this.evictIdle(now);

    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { at: 0, readAt: now }));
    e.readAt = now;

    if (force || now - e.at >= this.ttlMs) {
      const done = this.refresh(e, fetch);
      // Only a COLD key (or an explicit force) makes anybody wait. With a list
      // in hand we answer from it and let the refresh land behind the response —
      // which is the entire point, and why `await` is conditional here.
      if (force || !e.tickets) {
        await done;
        // `refresh` swallows so a background failure can't become an unhandled
        // rejection, so this path has to re-raise. Rethrowing the ORIGINAL error
        // keeps the route's 502 message byte-identical to what it said before
        // this cache existed.
        if (!e.tickets) throw e.error ?? new Error("tracker returned no tickets");
      }
    }

    return {
      tickets: e.tickets!,
      ...(e.error ? { stale: { ageMs: Date.now() - e.at, error: describe(e.error) } } : {}),
    };
  }

  private refresh(e: Entry, fetch: () => Promise<Ticket[]>): Promise<void> {
    // `??=` is the single-flight: the second caller through here gets the first
    // caller's promise rather than starting a second fan-out. Safe against the
    // IIFE's own `finally` clearing the field, because the assignment completes
    // synchronously and the clear can't run before a microtask.
    return (e.refreshing ??= (async () => {
      try {
        const tickets = await fetch();
        e.tickets = tickets;
        e.at = Date.now();
        e.error = undefined;
      } catch (err) {
        // Keep the last-good list and record why it stopped moving. Caching the
        // failure as data would blank a sidebar that was working, which DRY-55
        // is explicit is the worse of the two bugs.
        e.error = err;
      } finally {
        e.refreshing = undefined;
      }
    })());
  }

  private evictIdle(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.refreshing || now - e.readAt < this.idleMs) continue;
      this.entries.delete(k);
    }
  }
}

type Stats = NonNullable<Ticket["childStats"]>;

/**
 * An epic's child breakdown (DRY-13), cached well apart from the list it
 * decorates.
 *
 * This is the unbounded half of a sidebar pull: the child query spans EVERY
 * status — years of closed work — so it is not bounded by the open tickets on
 * screen, and on an ordinary corporate Jira it can reach the 2000-issue cap
 * (twenty sequential pages) only to be abandoned. Refetching that every 20s buys
 * nothing: a completion ratio is a number that moves over days, and the list
 * beside it goes on refreshing at the list's own cadence either way.
 *
 * Per-epic rather than per-pass, because the two providers need different things
 * from it. Jira asks for every epic in one query and so wants "are they ALL
 * fresh" (`all`); Switchyard pays one request per epic and so wants to skip them
 * individually (`get`).
 */
export class ChildStatsCache {
  private readonly entries = new Map<string, { stats: Stats; at: number }>();
  private sweptAt = 0;

  constructor(private readonly ttlMs: number) {}

  /** This epic's stats, if still fresh. */
  get(key: string): Stats | undefined {
    if (!this.ttlMs) return undefined;
    const now = Date.now();
    this.sweep(now);
    const e = this.entries.get(key);
    return e && now - e.at < this.ttlMs ? e.stats : undefined;
  }

  /**
   * Stats for EVERY key, or undefined if even one is missing or stale.
   *
   * All-or-nothing on purpose: where one query answers every epic, a partial hit
   * saves exactly nothing, so a newly-appeared epic correctly costs one refetch
   * for the whole set rather than a second query for itself.
   */
  all(keys: Iterable<string>): Map<string, Stats> | undefined {
    if (!this.ttlMs) return undefined;
    const out = new Map<string, Stats>();
    for (const k of keys) {
      const stats = this.get(k);
      if (!stats) return undefined;
      out.set(k, stats);
    }
    return out;
  }

  put(key: string, stats: Stats): void {
    if (!this.ttlMs) return;
    this.entries.set(key, { stats, at: Date.now() });
  }

  /**
   * Forget epics nobody has counted in a while — an epic that closes or leaves
   * the configured scope otherwise sits here for the daemon's lifetime. Rate-
   * limited to one pass per TTL so the common case stays a map lookup.
   */
  private sweep(now: number): void {
    if (now - this.sweptAt < this.ttlMs) return;
    this.sweptAt = now;
    for (const [k, e] of this.entries) {
      if (now - e.at >= this.ttlMs * 2) this.entries.delete(k);
    }
  }
}

/**
 * The child-stats cache both providers use.
 *
 * A module singleton rather than a constructor argument because exactly one
 * provider exists per daemon (`createTracker()` is called once) and the sharing
 * is the point: the value being cached is "what the tracker says about this
 * epic", which is a property of the tracker, not of the code asking. Keeping it
 * out of `JiraConfig`/`SwitchyardConfig` also keeps those shapes what they say
 * they are — credentials.
 */
export const childStatsCache = new ChildStatsCache(CONFIG.tracker.cache.childStatsMs);

/**
 * Cache key for a ticket query. Order-independent in the project list, since
 * the shell sends host defaults + user chips concatenated and two clients with
 * the same effective scope must share an entry rather than each keep their own.
 */
export function ticketQueryKey(q: {
  project?: string;
  projects?: string[];
  open?: boolean;
  includeBacklog?: boolean;
  text?: string;
}): string {
  return JSON.stringify([
    q.project ?? "",
    [...(q.projects ?? [])].sort(),
    !!q.open,
    !!q.includeBacklog,
    q.text ?? "",
  ]);
}
