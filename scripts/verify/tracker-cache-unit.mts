// DRY-72, the cache's own semantics — in-process, no daemon, about a second.
//
// The end-to-end harness (tracker-cache.mjs) proves the claims that need a real
// daemon and a real browser: upstream request counts, the sidebar's stale marker.
// It is a poor instrument for the things below, which are about ORDERING and
// TIMING inside one class — "does a forced refresh return data taken after the
// call", "is an un-refreshed list eventually called stale", "does a flight that
// throws synchronously wedge the entry forever". Reproducing those through HTTP
// means minute-long waits and races; reproducing them here means a stub fetch and
// TTLs measured in tens of milliseconds.
//
// DRY-84 added the sharpest one of those: whether the clock behind "stale" runs
// while NOBODY IS ASKING. The difference between the two sections that make that
// claim — (g) and (l) — is only whether the harness keeps calling `get` during
// the aging, which is a distinction no HTTP harness can draw cheaply and this
// one draws in 200ms.
//
// Same in-process shape as ticket-brief.mts, and run the same way:
//   (cd daemon && node --import tsx ../scripts/verify/tracker-cache-unit.mts)
import {
  ChildStatsCache,
  TicketListCache,
  ticketQueryKey,
  type CacheDiagnostic,
  type CachedTickets,
} from "../../daemon/src/tracker/cache.js";
// Section (m) checks a boot refusal, which is config's half of DRY-84's
// constraint. Importing config evaluates the env — harmless here, and cheaper
// than a daemon per case.
import { staleWindowError } from "../../daemon/src/config.js";
import type { Ticket } from "../../daemon/src/tracker/types.js";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ticket = (key: string): Ticket => ({
  key,
  title: key,
  status: { category: "in_progress", label: "In Progress" },
  repo: "dry",
});

/**
 * A stub provider whose latency and outcome are under the test's control, and
 * which counts its calls. `calls` is the whole point: every claim about
 * coalescing is a claim about a number that didn't go up.
 */
function stub() {
  const s = {
    calls: 0,
    latency: 0,
    fail: null as string | null,
    /** Bumped so a test can tell WHICH flight's data it got back. */
    generation: 0,
    throwSynchronously: false,
    fetch: async (): Promise<Ticket[]> => {
      s.calls++;
      if (s.latency) await sleep(s.latency);
      if (s.fail) throw new Error(s.fail);
      return [ticket(`GEN-${s.generation}`)];
    },
    // Deliberately NOT an async function: an async fn converts a synchronous
    // throw into a rejected promise, which is precisely the thing that made the
    // old single-flight bug unreachable. This is the shape that reaches it.
    //
    // The explicit return annotation is load-bearing for a second reason: both
    // of these close over `s` inside its own initializer, and without one
    // TypeScript cannot break the inference cycle.
    fetchMaybeSync: (): Promise<Ticket[]> => {
      if (s.throwSynchronously) throw new Error("sync boom");
      return s.fetch();
    },
  };
  return s;
}

console.log("\n(a) single-flight: concurrent misses share one fetch");
{
  const s = stub();
  s.latency = 30;
  const cache = new TicketListCache(1000);
  const all = await Promise.all(Array.from({ length: 5 }, () => cache.get("k", s.fetch)));
  check("one fetch for five callers", s.calls === 1, `calls=${s.calls}`);
  check("all five got the list", all.every((r) => r.tickets.length === 1));
  check("none marked stale", all.every((r) => !r.stale));
}

console.log("\n(b) stale-while-revalidate: the caller isn't made to wait");
{
  const s = stub();
  const cache = new TicketListCache(20);
  await cache.get("k", s.fetch); // warm
  await sleep(40); // past the TTL
  s.latency = 200;
  s.generation = 1;
  const t0 = Date.now();
  const hit = await cache.get("k", s.fetch);
  const waited = Date.now() - t0;
  check("answered without waiting for the refresh", waited < 50, `${waited}ms of a 200ms fetch`);
  check("and answered with the PREVIOUS list", hit.tickets[0]!.key === "GEN-0", hit.tickets[0]!.key);
  check("while a refresh was actually started", s.calls === 2, `calls=${s.calls}`);
  await sleep(250);
  const after = await cache.get("k", s.fetch);
  check("which then lands", after.tickets[0]!.key === "GEN-1", after.tickets[0]!.key);
}

console.log("\n(c) force waits, and gets data taken AFTER the call");
{
  const s = stub();
  const cache = new TicketListCache(20);
  await cache.get("k", s.fetch);
  await sleep(40);
  // A background flight is now in progress and carries generation 0 data...
  s.latency = 120;
  const background = cache.get("k", s.fetch);
  await sleep(20);
  // ...and the user changes something in the tracker and presses Refresh.
  s.generation = 1;
  const forced = await cache.get("k", s.fetch, { force: true });
  check(
    "force does NOT return the pre-click snapshot",
    forced.tickets[0]!.key === "GEN-1",
    forced.tickets[0]!.key,
  );
  check("it queued a second flight rather than joining", s.calls === 3, `calls=${s.calls}`);
  await background;
}

console.log("\n(d) several rapid forces queue at most one extra flight");
{
  const s = stub();
  s.latency = 60;
  const cache = new TicketListCache(20);
  await cache.get("k", s.fetch);
  await sleep(40);
  const bg = cache.get("k", s.fetch); // flight #2 in progress
  await sleep(10);
  const before = s.calls;
  await Promise.all([
    cache.get("k", s.fetch, { force: true }),
    cache.get("k", s.fetch, { force: true }),
    cache.get("k", s.fetch, { force: true }),
  ]);
  check("three clicks cost one extra fetch, not three", s.calls - before === 1, `+${s.calls - before}`);
  await bg;
}

console.log("\n(e) a failure is never cached as data");
{
  const s = stub();
  const cache = new TicketListCache(20);
  await cache.get("k", s.fetch);
  await sleep(40);
  s.fail = "tracker down";
  const broken = await cache.get("k", s.fetch, { force: true });
  check("the last-good list survives", broken.tickets[0]!.key === "GEN-0", broken.tickets[0]!.key);
  check("and is marked stale", !!broken.stale, JSON.stringify(broken.stale));
  check("as FAILED — something threw (DRY-84)", broken.stale?.reason === "failed", broken.stale?.reason);
  check("quoting the reason", /tracker down/.test(broken.stale?.error ?? ""), broken.stale?.error);
  s.fail = null;
  s.generation = 2;
  const healed = await cache.get("k", s.fetch, { force: true });
  check("recovery clears it", !healed.stale && healed.tickets[0]!.key === "GEN-2");
}

console.log("\n(f) a cold key propagates the failure instead of inventing a list");
{
  const s = stub();
  s.fail = "tracker down";
  const cache = new TicketListCache(20);
  let threw: unknown = null;
  await cache.get("k", s.fetch).catch((e) => (threw = e));
  check("it throws", threw !== null, String(threw));
  check("with the original error", /tracker down/.test(String(threw)), String(threw));
}

console.log("\n(g) a list nobody can refresh, while somebody IS asking, goes stale");
{
  // The signal the cache would otherwise have REMOVED: a tracker that is slow
  // rather than broken used to trip the browser's 12s budget and report. Now the
  // browser is answered instantly and nothing fails, so age is the only evidence
  // left that what's on screen has stopped tracking reality.
  //
  // Polled THROUGHOUT the aging, and that is the half DRY-84 added: the same
  // 120ms of aging with nobody asking is section (l), and must not report. Read
  // the two together — either one alone can be satisfied by a cache that is
  // simply wrong in the other direction.
  const s = stub();
  // The watch gap is STATED rather than inherited. Derived it would be floored
  // at 30s (WATCH_GAP_FLOOR_MS, which is what keeps it above a real client's
  // poll interval), and this section polls every 15ms — so a section that let
  // it default would be asserting against a number three orders of magnitude
  // away from the one it depends on.
  const cache = new TicketListCache(20, { staleAfterMs: 80, watchedGapMs: 40 });
  await cache.get("k", s.fetch);
  const fresh = await cache.get("k", s.fetch);
  check("not stale while it's young", !fresh.stale, JSON.stringify(fresh.stale));
  s.latency = 10_000; // every later refresh is in flight and never lands
  let aged: CachedTickets | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(15); // well inside the gap that counts as somebody watching
    aged = await cache.get("k", s.fetch);
    if (aged.stale) break;
  }
  check("stale once it's old", !!aged?.stale, JSON.stringify(aged?.stale));
  check("as STALLED, not failed — nothing threw", aged?.stale?.reason === "stalled", aged?.stale?.reason);
  check(
    "and it quotes the refresh rather than inventing an error",
    /a refresh has been running/.test(aged?.stale?.error ?? ""),
    aged?.stale?.error,
  );
  check("carrying the age", (aged?.stale?.ageMs ?? 0) >= 80, `${aged?.stale?.ageMs}ms`);
}

console.log("\n(h) a flight that throws SYNCHRONOUSLY doesn't wedge the key");
{
  // If the handle is cleared from inside the flight, a synchronous throw clears
  // it before the caller assigns it — latching a settled promise, so the key
  // never refreshes again and eviction (which skips in-flight entries) can never
  // reclaim it. Unreachable through today's providers, which is exactly why it
  // needs a test rather than a comment.
  const s = stub();
  const cache = new TicketListCache(20);
  await cache.get("k", s.fetchMaybeSync);
  await sleep(40);
  s.throwSynchronously = true;
  const first = await cache.get("k", s.fetchMaybeSync, { force: true });
  check("the throw is absorbed", !!first.stale, JSON.stringify(first.stale));
  s.throwSynchronously = false;
  s.generation = 3;
  const recovered = await cache.get("k", s.fetchMaybeSync, { force: true });
  check(
    "and the key can still refresh afterwards",
    recovered.tickets[0]!.key === "GEN-3" && !recovered.stale,
    `${recovered.tickets[0]!.key} stale=${JSON.stringify(recovered.stale)}`,
  );
}

console.log("\n(i) idle keys are evicted, in-flight ones are not");
{
  const s = stub();
  const cache = new TicketListCache(20, { idleMs: 60 }); // idle after 60ms
  await cache.get("dead", s.fetch);
  await sleep(90);
  const before = s.calls;
  await cache.get("dead", s.fetch);
  check("an evicted key refetches from cold", s.calls === before + 1, `calls=${s.calls}`);
}

console.log("\n(j) ChildStatsCache: counts, the capped verdict, and expiry");
{
  const c = new ChildStatsCache(60);
  check("unknown epics say ask", c.peek("E-1") === undefined);
  c.put("E-1", { total: 3, byCategory: { done: 1, in_progress: 2 } });
  // Narrowed rather than optional-chained: `peek` returns the counts, the
  // string "capped", or undefined, and `?.total` silently reads as a miss for
  // the capped case — which is the one distinction this section exists to draw.
  const counted = c.peek("E-1");
  check(
    "counted epics come back",
    counted !== undefined && counted !== "capped" && counted.total === 3,
    JSON.stringify(counted),
  );
  c.putCapped("E-2");
  check("a capped epic is a HIT, not a miss", c.peek("E-2") === "capped", String(c.peek("E-2")));
  await sleep(90);
  check("both expire", c.peek("E-1") === undefined && c.peek("E-2") === undefined);
  const off = new ChildStatsCache(0);
  off.put("E-3", { total: 1, byCategory: {} });
  check("a disabled cache never hits", off.peek("E-3") === undefined);
}

console.log("\n(k) ticketQueryKey");
{
  const a = ticketQueryKey({ projects: ["SRE", "DRY"], open: true });
  const b = ticketQueryKey({ projects: ["DRY", "SRE"], open: true });
  check("project order doesn't split the entry", a === b, `${a} vs ${b}`);
  check(
    "the backlog toggle does",
    ticketQueryKey({ open: true }) !== ticketQueryKey({ open: true, includeBacklog: true }),
  );
  check(
    "and so does a limit",
    ticketQueryKey({ open: true }) !== ticketQueryKey({ open: true, limit: 50 }),
  );
}

console.log("\n(l) DRY-84: time in which nobody asked is not time the list rotted");
{
  // The tab was hidden. The shell stops polling then, deliberately (DRY-72 trap
  // 9) — a Drydock tab left open overnight would otherwise be a refresh against
  // a corporate Jira every 20s until morning. But that is precisely a state in
  // which the entry ages with nothing able to refresh it, so the age test of
  // trap 3a read the first pull on coming back as an outage: nothing had
  // failed, nothing had even been ASKED, and the desk said the tracker was in
  // trouble. Same 200ms of aging as (g), same cache, only nobody polling.
  const s = stub();
  const seen: CacheDiagnostic[] = [];
  const cache = new TicketListCache(20, {
    staleAfterMs: 80,
    watchedGapMs: 40, // stated, as in (g) — the silence below is 200ms, five times it
    onDiagnose: (d) => seen.push(d),
  });
  await cache.get("k", s.fetch);
  // Nothing will land from here on, so the age clock is the ONLY thing that
  // could speak — which is what makes the silence below mean something.
  s.latency = 10_000;
  await sleep(200); // > the 80ms window and > the 40ms watch gap, five times over
  const woke = await cache.get("k", s.fetch);
  check("the pull after the silence is not stale", !woke.stale, JSON.stringify(woke.stale));
  check(
    "and nothing was reported to the client at all",
    !seen.some((d) => d.event === "stalled" || d.event === "failed"),
    JSON.stringify(seen.map((d) => d.event)),
  );
  // The positive control, and this section is vacuous without it: `!stale` is
  // also what a cache that quietly refreshed the entry returns. The daemon has
  // to have SEEN an entry old enough to have been flagged and declined to flag
  // it — which is the whole measurement DRY-84 asked for, since it is the only
  // evidence distinguishing "the tab stopped polling" from "the tracker did".
  const noted = seen.find((d) => d.event === "unwatched");
  check("the daemon records that the list really was old", (noted?.ageMs ?? 0) >= 80, JSON.stringify(noted));
  check("naming how long nobody asked", (noted?.gapMs ?? 0) >= 200, `${noted?.gapMs}ms`);
  // The clock RESTARTS; it does not stop. Keep asking, with the tracker still
  // landing nothing, and the window still reports — trap 3a intact.
  let late: CachedTickets | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(15);
    late = await cache.get("k", s.fetch);
    if (late.stale) break;
  }
  check(
    "and once somebody IS asking again, it still reports (trap 3a survives)",
    late?.stale?.reason === "stalled",
    JSON.stringify(late?.stale),
  );
}

console.log("\n(m) the watch gap is squeezed from both sides, and the pair is checked");
{
  // The property the whole fix rests on, and the one a behavioural test can't
  // reach — thirty seconds of polling to observe what is two comparisons:
  //
  //   above the client's poll interval   or every poll of a live tab reads as a
  //                                      hole, `watchedSince` restarts on every
  //                                      read, and the age test can never fire
  //                                      (DRY-72's trap 3a, off by arithmetic).
  //   below the window MINUS a TTL       or a tab hidden for less than the gap
  //                                      has that time counted as attention and
  //                                      the wake trips the notice — this
  //                                      ticket's own bug, at a shorter
  //                                      duration. The TTL is in it because a
  //                                      healthy cycle already leaves an entry
  //                                      un-refreshed for up to one before any
  //                                      hidden stretch begins.
  //
  // Half the window holds the first at the shipping numbers by coincidence
  // (60s / 2 = 30s > a 20s poll) and the second with 10s to spare. Both stop
  // holding as soon as the window is turned down, in opposite directions, which
  // is why each is asserted rather than the one that was in front of me.
  const POLL_MS = 20_000; // TICKET_POLL_MS, shell/src/lib/tracker.ts
  const TTL_MS = 20_000; // the shipping DRYDOCK_TRACKER_CACHE_MS
  const shipped = new TicketListCache(TTL_MS);
  check(
    "the shipping gap clears the shell's poll",
    shipped.watchedGapMs > POLL_MS,
    `${shipped.watchedGapMs}ms vs a ${POLL_MS}ms poll`,
  );
  check(
    "and leaves a TTL of room under the window",
    shipped.watchedGapMs + TTL_MS < 60_000,
    `${shipped.watchedGapMs} + ${TTL_MS} vs a 60000ms window`,
  );
  const stated = new TicketListCache(20, { staleAfterMs: 80, watchedGapMs: 40 });
  check("an explicit gap bypasses the floor, for harnesses", stated.watchedGapMs === 40, `${stated.watchedGapMs}ms`);

  // The windows that can't satisfy both are refused at boot rather than clamped:
  // below about twice the poll interval there is no value that satisfies them,
  // so there is nothing to fall back TO. `staleWindowError` is what index.ts
  // prints; here it is called directly, since standing a daemon up to read one
  // sentence is a minute per case.
  const cases: Array<[string, ReturnType<typeof staleWindowError>, boolean]> = [
    ["the shipping pair boots", staleWindowError({ staleAfterMs: 60_000, ttlMs: 20_000 }), false],
    ["a 45s window is refused (gap 30s + TTL 20s ≥ 45s)", staleWindowError({ staleAfterMs: 45_000, ttlMs: 20_000 }), true],
    ["so is 30s — 'tell me sooner', the way in", staleWindowError({ staleAfterMs: 30_000, ttlMs: 20_000 }), true],
    ["0 is off, not incoherent", staleWindowError({ staleAfterMs: 0, ttlMs: 20_000 }), false],
    ["an explicit gap is the caller's promise", staleWindowError({ staleAfterMs: 5_000, watchGapMs: 2_500, ttlMs: 4_000 }), false],
  ];
  for (const [name, got, shouldRefuse] of cases) {
    check(name, shouldRefuse === !!got, got ? `${got.slice(0, 60)}…` : "accepted");
  }
}

console.log("\n(n) the age test switches off; a failure still speaks");
{
  // 0 is a posture, not a typo: a tracker known to be slow, where the only
  // thing worth a notice is a refresh that actually threw. What it must not do
  // is take DRY-55 with it.
  const s = stub();
  const cache = new TicketListCache(20, { staleAfterMs: 0 });
  await cache.get("k", s.fetch);
  s.latency = 10_000;
  let aged: CachedTickets | undefined;
  for (let i = 0; i < 10; i++) {
    await sleep(15);
    aged = await cache.get("k", s.fetch);
  }
  check("age alone raises nothing", !aged?.stale, JSON.stringify(aged?.stale));
}
{
  const s = stub();
  const cache = new TicketListCache(20, { staleAfterMs: 0 });
  await cache.get("k", s.fetch);
  await sleep(40);
  s.fail = "tracker down";
  const broken = await cache.get("k", s.fetch, { force: true });
  check("a refresh that threw still does", broken.stale?.reason === "failed", JSON.stringify(broken.stale));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
