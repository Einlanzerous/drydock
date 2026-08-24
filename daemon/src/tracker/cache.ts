import type { Ticket, TicketQuery } from "./types.js";

/**
 * Tracker caching (DRY-72).
 *
 * Until this existed there was none anywhere in the tracker path: every
 * `/api/tracker/tickets` went straight at the provider, and the sidebar polls
 * that route every 20s **per browser tab**. Against a corporate Jira one pull
 * measured 5.7-6s — three cursor pages for the list plus a `parent in (…)` child
 * query spanning every status — so the browser's own budget (`LIST_TIMEOUT_MS`,
 * 12s at the time and 15s since DRY-61) was being tripped by ordinary load
 * rather than by an outage, and each abort left the daemon still walking pages
 * for a client that had stopped listening.
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

/**
 * Why a served list has stopped being current (DRY-84).
 *
 *  - `failed`   the last refresh threw. Something is wrong at the tracker, or
 *               between here and it, and the error says what.
 *  - `stalled`  nothing failed. Refreshes are being asked for and are not
 *               landing — the slow-rather-than-broken tracker trap 3a exists
 *               for — and the useful number is how long the current one has
 *               been running, not how old the list is. Narrower than it sounds
 *               since DRY-61 gave the whole pull a deadline: a merely slow
 *               tracker now ends as `failed`, quoting that deadline, well
 *               before a 60s window closes. What's left here is a refresh still
 *               running when the window shuts — the operation deadline off
 *               (a documented posture) or set longer than the window.
 *
 * There used to be no distinction on the wire: both arrived as a sentence built
 * at read time, so "no successful refresh in 74s" was printed both for a
 * refresh that had genuinely been running for 74s and for an entry nobody had
 * asked about for 74s. Those are opposite diagnoses — a tracker to fix versus a
 * clock that shouldn't have been running — and the desk's notice could not tell
 * you which one you were looking at. The second case no longer reaches here at
 * all (see `watchedSince`); this field is what separates the two that do.
 */
export type StaleReason = "failed" | "stalled";

/** What a cached list answer carries back to the route. */
export interface CachedTickets {
  tickets: Ticket[];
  /**
   * Set when what's being served has stopped being current — either a refresh
   * FAILED, or none has landed for long enough, WHILE SOMEBODY WAS ASKING, that
   * the list can't be passed off as live (see `staleAfterMs`).
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
   * well clear of the TTL rather than the TTL itself — and, since DRY-84, a
   * clock that only runs while a client is actually polling the entry.
   */
  stale?: { ageMs: number; error: string; reason: StaleReason };
}

/**
 * An entry's own account of itself, for the log (DRY-84).
 *
 * The notice above the desk said "no successful refresh in Ns" against a
 * corporate Jira with no outage behind it, and the two candidate causes — a tab
 * that had stopped polling, versus refreshes that were failing or too slow to
 * land — presented identically in the browser while calling for completely
 * different fixes. The daemon knew which and did not say. Now it says, once per
 * onset rather than once per poll, and `unwatched` is emitted for the case that
 * no longer raises anything: it is the only evidence that cause (a) happened.
 */
export interface CacheDiagnostic {
  /** The query key, i.e. which scope's list this is about. */
  key: string;
  event: StaleReason | "unwatched" | "clear";
  /** Age of the list being served. */
  ageMs: number;
  /** How long it has been asked-for without a refresh landing. */
  watchedMs: number;
  /** How long the refresh in flight has been running, if one is. */
  runningMs?: number;
  /** How long the last COMPLETED refresh took — the number that says how close a slow tracker is to the request deadline. */
  lastRefreshMs?: number;
  refreshes: number;
  failures: number;
  /** `unwatched` only: how long nobody asked. */
  gapMs?: number;
  error?: string;
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

/**
 * A duration somebody reads. Sub-second is spelled in ms rather than rounded to
 * "0s": in prod every one of these is tens of seconds, but the harnesses run the
 * whole window in 200ms, and a sentence that says a refresh has been running 0s
 * reads as a broken field rather than as a fast clock.
 */
const dur = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`);

/**
 * Floor on the watch gap (DRY-84), and the reason it is a floor rather than a
 * derivation.
 *
 * The gap has one job: be longer than the interval its CLIENT polls at. The
 * paired shell polls every `TICKET_POLL_MS` (20s, `shell/src/lib/tracker.ts`)
 * and arms the next poll only once the previous one has SETTLED, so a real
 * tab's gaps run a little over 20s; 30s clears that with margin. Deriving the
 * gap from the staleness window alone satisfies that at the shipping numbers by
 * arithmetic coincidence (60s / 2 = 30s) and stops satisfying it the moment
 * somebody turns the window down — at `DRYDOCK_TRACKER_STALE_AFTER_MS=30000`,
 * a perfectly reasonable "tell me sooner", every poll of an ordinary tab reads
 * as a hole, `watchedSince` restarts on every read, and the age test can never
 * fire again. Asking for a notice EARLIER would have switched it off, silently,
 * with only `0` documented as the off switch.
 *
 * An explicit `watchedGapMs` (the env knob, and the harnesses) is allowed under
 * this floor: a harness that runs the whole window in 200ms needs a gap to
 * match, and saying so out loud is different from arriving there by accident.
 */
const WATCH_GAP_FLOOR_MS = 30_000;

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
  /** Last time a client asked for this key. Drives eviction, and `watchedSince`. */
  readAt: number;
  /**
   * When the stretch began in which somebody has been asking for this entry and
   * no refresh has landed — the clock the age test runs on, and the whole of
   * DRY-84 (DRY-72's trap 3a runs it off `at`, which is wrong for the reason
   * below).
   *
   * It is reset by a successful refresh, and ALSO by a read that arrives more
   * than `watchedGapMs` after the previous one — a hole in the read stream,
   * meaning nobody was there. Time nobody asked about is not time this list was
   * allowed to rot: the shell deliberately stops polling a hidden tab (DRY-72
   * trap 9), so a tab left open in the background ages an entry that nothing can
   * refresh, and the first pull on coming back read as an outage when nothing
   * had failed.
   */
  watchedSince: number;
  /** Refreshes that landed, for the log line. */
  refreshes: number;
  /** Refreshes that threw since the last one that landed. */
  failures: number;
  /** How long the last COMPLETED refresh took, whichever way it ended. */
  lastRefreshMs?: number;
  /** What was last reported for this entry, so onset is logged once and not once per poll. */
  reported?: StaleReason;
  /**
   * Whether the `unwatched` line has already been said for the current stretch
   * of not-refreshing, cleared by a refresh that lands. Same reason `reported`
   * exists: with a watch gap deliberately tuned below the client's cadence (a
   * harness, or a host that has turned the knob right down) EVERY read is a
   * hole, and the line meant to be the rare trace of a tab that stopped polling
   * would otherwise print once per poll.
   */
  noticedUnwatched?: boolean;
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
   * Readable so the property that matters can be asserted directly (DRY-84).
   * The floor below only holds if something checks it, and checking it through
   * behaviour means a test that polls for longer than the client's poll
   * interval — a 30s test for a one-line `Math.max`.
   */
  readonly watchedGapMs: number;
  private readonly idleMs: number;
  private readonly onDiagnose?: (d: CacheDiagnostic) => void;

  /**
   * @param ttlMs   how old a list may get before a refresh is kicked off. 0
   *                disables the cache entirely — a passthrough, not a
   *                zero-length TTL, since the latter would leave every answer
   *                permanently stale-and-refreshing rather than off.
   */
  constructor(
    private readonly ttlMs: number,
    {
      staleAfterMs,
      idleMs = 600_000,
      watchedGapMs,
      onDiagnose,
    }: {
      /**
       * When to call a list stale even though nothing failed.
       *
       * Undefined derives it from the TTL, which is what the daemon does with
       * the knob unset. An explicit **0 switches the age test off**, leaving
       * failures as the only thing that can raise `stale` — a real posture for a
       * tracker that is honestly just slow. The two must not collide, which is
       * why this is `?? ` on undefined and not `||` on 0: a knob whose zero
       * means "off" landing on a default instead is DRY-60's trap 9, and the
       * knob in front of this one goes through `msOrOff` for the same reason.
       */
      staleAfterMs?: number;
      /**
       * How long an unread key survives. The key is the query, and the scope
       * chips (DRY-30) mean a client can mint new ones, so without this the map
       * grows for the daemon's lifetime.
       */
      idleMs?: number;
      /**
       * The longest hole in the read stream that still counts as somebody
       * watching (DRY-84) — see `watchedSince`. Defaults to half the staleness
       * window, floored at `WATCH_GAP_FLOOR_MS`, which is what keeps it above
       * the interval its client polls at however the window is tuned.
       *
       * Passing one BYPASSES that floor, which is the point: a harness runs the
       * whole window in milliseconds and needs a gap to match. In prod it is
       * `DRYDOCK_TRACKER_WATCH_GAP_MS`, and setting it under the shell's 20s
       * poll turns the age test off for an ordinary tab — deliberate there,
       * silent if it had been arrived at by arithmetic.
       */
      watchedGapMs?: number;
      /** Where an entry's account of itself goes (DRY-84); the daemon logs it. */
      onDiagnose?: (d: CacheDiagnostic) => void;
    } = {},
  ) {
    // Well clear of the TTL, so a healthy refresh cycle never trips it: a normal
    // pull is seconds and this is a minute at the shipping default.
    //
    // It exists because the cache REMOVED a signal that used to be free. A
    // tracker that is slow rather than broken — a page-walk where every request
    // succeeds but the whole pull takes minutes — used to hit the browser's
    // budget (12s at the time) and report. Now the browser is answered instantly
    // from cache and nothing fails, so without an age test the sidebar would
    // present an
    // arbitrarily old list as live, which is the exact dishonesty DRY-55 exists
    // to prevent.
    this.staleAfterMs = staleAfterMs ?? Math.max(ttlMs * 3, 60_000);
    // Half the window, but never under the floor — see WATCH_GAP_FLOOR_MS for
    // why the second half of that is load-bearing rather than belt-and-braces.
    // An explicit value (harnesses, and the knob they set) is taken as given.
    this.watchedGapMs =
      watchedGapMs ?? Math.max(Math.round(this.staleAfterMs / 2), WATCH_GAP_FLOOR_MS);
    this.idleMs = idleMs;
    this.onDiagnose = onDiagnose;
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
    const isNew = !e;
    if (!e) {
      this.entries.set(
        key,
        (e = { at: 0, readAt: now, watchedSince: now, refreshes: 0, failures: 0 }),
      );
    }
    // Taken BEFORE the read is stamped: the hole between two reads is the only
    // evidence the daemon has about whether anybody was there to be told (DRY-84).
    const gapMs = now - e.readAt;
    e.readAt = now;
    const unwatched = !isNew && gapMs > this.watchedGapMs;
    // Whether the pre-DRY-84 daemon would have called this read an outage —
    // taken before the clock restarts, because that is the whole measurement.
    // Nothing about it reaches the client; it goes to the log, and it is the
    // only evidence distinguishing "the tab stopped polling" from "the tracker
    // stopped answering", which present identically at the desk.
    const wouldHaveFlagged =
      unwatched && !e.error && this.staleAfterMs > 0 && e.at > 0 && now - e.at >= this.staleAfterMs;
    if (unwatched) e.watchedSince = now;

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

    // `Date.now()` again rather than `now`: a cold key or a force waited on a
    // fetch above, and the age has to be of the answer being returned.
    const settled = Date.now();
    const ageMs = settled - e.at;
    if (wouldHaveFlagged && !e.noticedUnwatched) {
      e.noticedUnwatched = true;
      this.diagnose(e, "unwatched", key, ageMs, settled, gapMs);
    }
    const reason = this.staleReason(e, settled);
    // Once per onset, not once per poll: at a 20s poll the alternative is 180
    // identical lines an hour for one outage, which is how a log stops being read.
    if (reason !== e.reported) {
      this.diagnose(e, reason ?? "clear", key, ageMs, settled);
      e.reported = reason;
    }
    return {
      tickets: e.tickets!,
      ...(reason
        ? { stale: { ageMs, error: this.staleMessage(e, reason, settled), reason } }
        : {}),
    };
  }

  /** Why this answer isn't current, or undefined while it is. */
  private staleReason(e: Entry, now: number): StaleReason | undefined {
    if (e.error) return "failed";
    // Measured from `watchedSince`, not from `at` (DRY-84). An entry only counts
    // as rotting while a client is actually asking for it: the age test exists
    // because a slow tracker no longer trips anybody's budget (trap 3a), and a
    // tab that has stopped polling is not a slow tracker. 0 turns the test off.
    if (this.staleAfterMs > 0 && now - e.watchedSince >= this.staleAfterMs) return "stalled";
    return undefined;
  }

  /**
   * The sentence that rides on the wire.
   *
   * The stalled wording quotes the REFRESH, not the list, and that is the
   * distinction DRY-84 was opened over: "no successful refresh in 74s" was the
   * sentence for a refresh that had been running 74s and for an entry nobody had
   * looked at in 74s alike, so the notice above the desk read as a tracker
   * outage in a case where the tracker was never asked anything. The second no
   * longer produces a sentence at all; this one says what is actually happening.
   */
  private staleMessage(e: Entry, reason: StaleReason, now: number): string {
    if (reason === "failed") return describe(e.error);
    const running = e.refreshing && e.freshAfter ? now - e.freshAfter : 0;
    return running
      ? `a refresh has been running ${dur(running)} without landing`
      : `no successful refresh in ${dur(now - e.at)}`;
  }

  /** Hand the entry's state to whoever is logging (DRY-84). Never on the hot path when nobody is. */
  private diagnose(
    e: Entry,
    event: CacheDiagnostic["event"],
    key: string,
    ageMs: number,
    now: number,
    gapMs?: number,
  ): void {
    if (!this.onDiagnose) return;
    this.onDiagnose({
      key,
      event,
      ageMs,
      watchedMs: now - e.watchedSince,
      refreshes: e.refreshes,
      failures: e.failures,
      ...(e.refreshing && e.freshAfter ? { runningMs: now - e.freshAfter } : {}),
      ...(e.lastRefreshMs === undefined ? {} : { lastRefreshMs: e.lastRefreshMs }),
      ...(gapMs === undefined ? {} : { gapMs }),
      ...(e.error ? { error: describe(e.error) } : {}),
    });
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
    const started = Date.now();
    try {
      const tickets = await fetch();
      e.tickets = tickets;
      e.at = Date.now();
      e.lastRefreshMs = e.at - started;
      // Nothing is owed any more, so the age clock starts over from the data
      // rather than from whenever somebody last asked (DRY-84).
      e.watchedSince = e.at;
      e.noticedUnwatched = undefined;
      e.refreshes++;
      e.failures = 0;
      e.error = undefined;
    } catch (err) {
      // Keep the last-good list and record why it stopped moving. Caching the
      // failure as data would blank a sidebar that was working, which DRY-55
      // is explicit is the worse of the two bugs.
      e.lastRefreshMs = Date.now() - started;
      e.failures++;
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
