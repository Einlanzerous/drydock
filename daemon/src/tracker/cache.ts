import type { Ticket, TicketQuery } from "./types.js";

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
 *  - `ChildStatsCache` is handed TO the providers, because only they know how to
 *    ask and the ask differs (Jira: one query for every epic; Switchyard: one per
 *    epic through a pool). One instance is shared between them so the two can't
 *    drift on how long a completion ratio stays good for.
 *
 * Neither ever caches a failure. A tracker that goes down leaves the last-good
 * answer in place and records *why* it stopped moving, which is the whole
 * distinction DRY-55 rests on.
 */

/** What a cached list answer carries back to the route. */
export interface CachedTickets {
  tickets: Ticket[];
  /**
   * Set when what's being served has stopped being current — either a refresh
   * FAILED, or none has succeeded in long enough that the list can't be passed
   * off as live (see `staleAfterMs`).
   *
   * This field is what keeps DRY-55 alive through the cache. Under
   * stale-while-revalidate the browser's `catch` stops firing for a tracker
   * outage, because the daemon now answers 200 with the last-good list instead
   * of 502ing — so if the response didn't SAY so, the sidebar's stale line would
   * silently die and the desk would go back to presenting an hour-old ticket as
   * current.
   *
   * What must NOT raise it is ordinary aging: an entry is stale by design for
   * the moment between a poll noticing and the background refresh landing, and a
   * notice that flickers once every 20s is worse than none. Hence a threshold
   * well clear of the TTL rather than the TTL itself.
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
  /**
   * Timestamp at or after which `refreshing`'s data is guaranteed to have been
   * taken. A caller that asked LATER than this can't be answered by that flight.
   */
  freshAfter?: number;
  /** At most one further refresh queued behind `refreshing` — see `refresh`. */
  queued?: Promise<void>;
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
  private readonly staleAfterMs: number;

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
    /**
     * When to call an un-refreshed list stale even though nothing failed. 0 =
     * derive it from the TTL, which is what the daemon does; it's a parameter at
     * all so the property is testable in a second rather than in a minute.
     */
    staleAfterMs = 0,
    private readonly idleMs = 600_000,
  ) {
    // Well clear of the TTL, so a healthy refresh cycle never trips it: a normal
    // pull is seconds and this is a minute at the shipping default.
    //
    // It exists because the cache REMOVED a signal that used to be free. A
    // tracker that is slow rather than broken — a page-walk where every request
    // succeeds but the whole pull takes minutes — used to hit the browser's 12s
    // budget and report. Now the browser is answered instantly from cache and
    // nothing fails, so without an age test the sidebar would present an
    // arbitrarily old list as live, which is the exact dishonesty DRY-55 exists
    // to prevent.
    this.staleAfterMs = staleAfterMs || Math.max(ttlMs * 3, 60_000);
  }

  /**
   * @param force  bypass the TTL and WAIT for a refresh that was started no
   *               earlier than this call. This is the sidebar's Refresh button,
   *               and it is not optional politeness: that button exists to
   *               overrule the cadence, so a cached answer would make it a no-op
   *               that still spins. A forced refresh that FAILS still answers
   *               from last-good, marked stale, rather than throwing away a list
   *               that works.
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
      const done = this.refresh(e, fetch, force ? now : 0);
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

    const ageMs = Date.now() - e.at;
    const why = this.staleReason(e, ageMs);
    return { tickets: e.tickets!, ...(why ? { stale: { ageMs, error: why } } : {}) };
  }

  /** Why this answer isn't current, or undefined while it is. */
  private staleReason(e: Entry, ageMs: number): string | undefined {
    if (e.error) return describe(e.error);
    if (ageMs >= this.staleAfterMs) {
      // No failure to quote — the tracker is answering, just not in time to keep
      // this list live. Say that rather than inventing an error.
      return `no successful refresh in ${Math.round(ageMs / 1000)}s`;
    }
    return undefined;
  }

  /**
   * The refresh a caller should wait on.
   *
   * @param after  the caller will only accept data taken at or after this
   *               instant (0 = anything current enough for the TTL will do).
   *
   * A poll happily joins whatever is already talking to the tracker. A FORCE
   * can't always: a flight that began before the button was pressed may have
   * queried the tracker before whatever the user just changed, so joining it
   * returns pre-change data and Refresh looks like it did nothing. With a ~6s
   * fan-out against a 20s poll that is roughly a third of clicks, so the flight
   * is queued behind the current one instead — at most one deep, so a fistful of
   * clicks still costs the tracker one extra fan-out rather than one each.
   */
  private refresh(e: Entry, fetch: () => Promise<Ticket[]>, after = 0): Promise<void> {
    if (e.refreshing) {
      if ((e.freshAfter ?? 0) >= after) return e.refreshing;
      return (e.queued ??= this.queueAfter(e, fetch));
    }
    return this.start(e, fetch);
  }

  /** Run a fresh flight once the current one is out of the way. */
  private async queueAfter(e: Entry, fetch: () => Promise<Ticket[]>): Promise<void> {
    await e.refreshing; // never rejects; `run` swallows
    e.queued = undefined;
    await this.start(e, fetch);
  }

  private start(e: Entry, fetch: () => Promise<Ticket[]>): Promise<void> {
    // Stamped BEFORE the fetch is issued, so the guarantee this makes to joiners
    // ("data no older than this") errs towards claiming less than is true.
    e.freshAfter = Date.now();
    const p = this.run(e, fetch);
    e.refreshing = p;
    // Cleared through a `.finally` ATTACHED HERE rather than from inside `run`,
    // and this is not style. A `finally` in the flight body runs synchronously
    // when the body throws synchronously — before the caller has assigned the
    // handle — which would latch `refreshing` on an already-settled promise:
    // that key would then never refresh again AND never be evicted, since
    // `evictIdle` skips anything in flight. A `.finally` callback is always a
    // microtask, so the clear cannot outrun the assignment above however `run`
    // ends. (Today `run` is an async method and cannot throw synchronously, so
    // the old form was accidentally safe. That is not a property to depend on.)
    void p.finally(() => {
      if (e.refreshing === p) e.refreshing = undefined;
    });
    return p;
  }

  /** One trip to the tracker. Never rejects; the outcome lands on the entry. */
  private async run(e: Entry, fetch: () => Promise<Ticket[]>): Promise<void> {
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
    }
  }

  private evictIdle(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.refreshing || e.queued || now - e.readAt < this.idleMs) continue;
      this.entries.delete(k);
    }
  }
}

type Stats = NonNullable<Ticket["childStats"]>;

/** Cached knowledge that an epic has more children than either provider will count. */
const CAPPED = "capped";

interface StatsEntry {
  /** null = counted and found uncountable; see CAPPED. */
  stats: Stats | null;
  at: number;
}

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
 * from it: Jira asks for every epic in one query, Switchyard one per epic.
 */
export class ChildStatsCache {
  private readonly entries = new Map<string, StatsEntry>();
  private sweptAt = 0;

  constructor(private readonly ttlMs: number) {}

  /**
   * What is known about this epic: its stats, `CAPPED` if counting it has
   * already been found futile, or undefined for "ask".
   *
   * Caching the capped verdict is the point of the third state, and it is not
   * caching an error — it's a determinate fact about the epic. Without it the
   * single most expensive query in the system (a full cursor chain over every
   * status, abandoned on arrival) re-ran on every list refresh, which is the
   * "maximum cost, zero value" pathology DRY-72 exists to remove, merely made
   * less frequent. It expires like any other entry, so an epic that gets
   * archived down under the cap starts counting again on its own.
   */
  peek(key: string): Stats | typeof CAPPED | undefined {
    if (!this.ttlMs) return undefined;
    const now = Date.now();
    this.sweep(now);
    const e = this.entries.get(key);
    if (!e || now - e.at >= this.ttlMs) return undefined;
    return e.stats ?? CAPPED;
  }

  put(key: string, stats: Stats): void {
    if (!this.ttlMs) return;
    this.entries.set(key, { stats, at: Date.now() });
  }

  /** Record that this epic's children exceed what we're willing to page through. */
  putCapped(key: string): void {
    if (!this.ttlMs) return;
    this.entries.set(key, { stats: null, at: Date.now() });
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
 * Cache key for a ticket query. Order-independent in the project list, since
 * the shell sends host defaults + user chips concatenated and two clients with
 * the same effective scope must share an entry rather than each keep their own.
 */
export function ticketQueryKey(q: TicketQuery): string {
  // Typed as a TOTAL map over TicketQuery's keys, so adding a field to that
  // interface fails the build right here. The route builds this object in a
  // variable, which means TypeScript's excess-property check can't see an
  // omission — and a field missing from the key doesn't degrade, it makes two
  // genuinely different queries share one entry and serves the answer to a
  // question nobody asked.
  const parts: { [K in keyof Required<TicketQuery>]: unknown } = {
    project: q.project ?? "",
    projects: [...(q.projects ?? [])].sort(),
    open: !!q.open,
    includeBacklog: !!q.includeBacklog,
    parent: q.parent ?? "",
    text: q.text ?? "",
    limit: q.limit ?? 0,
  };
  return JSON.stringify(parts);
}
