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
// Same in-process shape as ticket-brief.mts, and run the same way:
//   (cd daemon && node --import tsx ../scripts/verify/tracker-cache-unit.mts)
import {
  ChildStatsCache,
  TicketListCache,
  ticketQueryKey,
} from "../../daemon/src/tracker/cache.js";
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
  };
  // Deliberately NOT an async function: an async fn converts a synchronous throw
  // into a rejected promise, which is precisely the thing that made the old
  // single-flight bug unreachable. This is the shape that reaches it.
  s.fetchMaybeSync = ((): Promise<Ticket[]> => {
    if (s.throwSynchronously) throw new Error("sync boom");
    return s.fetch();
  }) as () => Promise<Ticket[]>;
  return s as typeof s & { fetchMaybeSync: () => Promise<Ticket[]> };
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

console.log("\n(g) an un-refreshed list is eventually called stale with nothing failing");
{
  // The signal the cache would otherwise have REMOVED: a tracker that is slow
  // rather than broken used to trip the browser's 12s budget and report. Now the
  // browser is answered instantly and nothing fails, so age is the only evidence
  // left that what's on screen has stopped tracking reality.
  const s = stub();
  const cache = new TicketListCache(20, 80); // stale-by-age after 80ms
  await cache.get("k", s.fetch);
  const fresh = await cache.get("k", s.fetch);
  check("not stale while it's young", !fresh.stale, JSON.stringify(fresh.stale));
  s.latency = 10_000; // every later refresh is in flight and never lands
  await sleep(120);
  const aged = await cache.get("k", s.fetch);
  check("stale once it's old", !!aged.stale, JSON.stringify(aged.stale));
  check(
    "and says so without inventing an error",
    /no successful refresh/.test(aged.stale?.error ?? ""),
    aged.stale?.error,
  );
  check("carrying the age", (aged.stale?.ageMs ?? 0) >= 80, `${aged.stale?.ageMs}ms`);
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
  const cache = new TicketListCache(20, 0, 60); // idle after 60ms
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
  check("counted epics come back", c.peek("E-1")?.total === 3, JSON.stringify(c.peek("E-1")));
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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
