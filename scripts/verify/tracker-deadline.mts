// DRY-61: one deadline for a whole tracker PULL, not just for each request in it.
//
// DRY-72 gave every request a backstop, and against a tracker that refuses
// connections that is enough — the first request fails, the pull fails, the
// route 502s. Against one that ACCEPTS and then goes silent (the partition
// shape, and the one `docker stop` can never reproduce) it is not: each request
// dies at its own deadline and the provider starts the next, so the operation
// runs for `requests × backstop` with nothing bounding it. A Switchyard pull is
// a list page, an epic-exemption page and then one cursor chain per epic; a
// Jira one can be twenty pages of list and twenty of child stats.
//
// Why the existing rigs can't see this:
//
//   proxy-tracker.mts  sits between the BROWSER and the daemon, so it never
//                      sees what the daemon does upstream — where all of this
//                      lives. Same reason DRY-72 needed a counting origin.
//   tracker-cache.mts  has a hang case, but its rig sets the per-request
//                      deadline to 3s, so the ONE request that pull makes ends
//                      at 3s either way. A pull dies at its request backstop and
//                      a pull dies at its operation deadline look identical when
//                      the pull is one request long. This file's rig separates
//                      the two numbers (8s request, 3s operation) so the clock
//                      says which one ended it.
//
// So every assertion here is a TIMING or an upstream socket count, never a
// status code: 502 was the answer before and after on the cases that 502 at all
// (CLAUDE.md trap 3). The four sections:
//
//   (a) a hung tracker, cold key — the route answers at the OPERATION deadline
//       rather than the request one, and the message names the tracker.
//   (b) a tracker that is merely SLOW — every request succeeding, none of them
//       near its own deadline — is still bounded. This is the case a per-request
//       timeout structurally cannot bound, and the reason this ticket exists.
//   (c) with a list already in hand, blowing the deadline costs the REFRESH and
//       not the sidebar: 200, rows intact, `stale` set (DRY-55/DRY-72's rule).
//   (d) the sockets stop accumulating — the half the browser cannot see, and
//       the reason this isn't just a nicer error message.
//
// Sections (a) and (d) each carry one GUARD that passes in both worlds and says
// so where it stands: "a 502, not a hang" (the pre-fix daemon 502s too, just
// later) and "no socket left behind". Don't read their green as evidence.
//
// Setup + overrides: see README.md. Run from `daemon/`, where tsx resolves:
//   (cd daemon && node --import tsx ../scripts/verify/tracker-deadline.mts)
import type { Detail, TicketsResponse } from "./api.mjs";
// The stub's own declaration of what it serves (DRY-80) — `import type` erases,
// so this does not start a second stub.
import type { StubState } from "./stub-tracker.mjs";

const DAEMON = process.env.DAEMON_URL ?? "http://127.0.0.1:4395";
const STUB = process.env.STUB_URL ?? "http://127.0.0.1:4396";

/**
 * The rig's two clocks, which the harness must know to say anything.
 *
 * Read from the environment rather than hardcoded because the whole file is an
 * argument about which of the two ended a pull, and a harness that assumed the
 * README's numbers while the daemon ran with others would report that argument
 * confidently and wrongly.
 */
const LIST_MS = Number(process.env.LIST_TIMEOUT_MS ?? 3000);
const REQUEST_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 8000);

let failures = 0;
function check(name: string, ok: boolean, extra: Detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? ` — ${extra}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Three control routes answering three different shapes, none of them read
// here; `unknown` says that rather than guessing one of the three (DRY-80).
const ctl = (p: string): Promise<unknown> =>
  fetch(`${STUB}${p}`, { method: "POST" }).then((r) => r.json());
const stubState = (): Promise<StubState> =>
  fetch(`${STUB}/__state`).then((r) => r.json() as Promise<StubState>);

/**
 * **Refuse to run against a rig that cannot discriminate.** The default
 * deadlines (10s operation, 20s request) are correct in prod and useless here:
 * with them a slow-tracker section would need a >10s pull to say anything, and
 * a run that passes by waiting is CLAUDE.md's trap 1. The two clocks must also
 * be far enough apart that a measured time attributes itself to one of them.
 */
if (!(LIST_MS >= 1000 && LIST_MS <= 5000 && REQUEST_MS >= LIST_MS * 2)) {
  console.error(
    `[tracker-deadline] rig not usable: list=${LIST_MS}ms request=${REQUEST_MS}ms. ` +
      `Needs a 1-5s operation deadline and a request backstop at least twice it, ` +
      `or the clock can't say which one ended a pull. See README.md.`,
  );
  process.exit(2);
}

interface PullResult {
  status: number;
  body: Partial<TicketsResponse> & { error?: string };
  ms: number;
}

/**
 * One sidebar pull.
 *
 * `scope` mints a distinct cache key, which sections (b)-(d) all depend on:
 * DRY-72 single-flights per key, so two pulls of the SAME query share one
 * upstream fan-out however many clients ask — that is the fix working, not the
 * bug. What still accumulates is one pull per distinct key, which is what a
 * second browser with its own scope chips (DRY-30) is.
 *
 * Budgeted at well over the request backstop, and that is not hygiene: an
 * unpatched daemon is exactly the one that might never answer, and an
 * unbudgeted probe there hangs the run rather than failing it — which reports
 * as nothing at all. A blown budget lands as status 0 so every later section
 * still gets to speak.
 */
async function pull({ scope = "", fresh = false } = {}): Promise<PullResult> {
  const params = new URLSearchParams({ open: "true" });
  params.set("projects", scope ? `DRY,${scope}` : "DRY");
  if (fresh) params.set("fresh", "true");
  const t0 = Date.now();
  try {
    const res = await fetch(`${DAEMON}/api/tracker/tickets?${params}`, {
      signal: AbortSignal.timeout(REQUEST_MS * 3),
    });
    const body = (await res.json().catch(() => ({}))) as PullResult["body"];
    return { status: res.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: String(e) }, ms: Date.now() - t0 };
  }
}

/** Did this pull end on OUR clock, or did something else end it? */
const atOperationDeadline = (ms: number): boolean =>
  ms >= LIST_MS * 0.7 && ms < (LIST_MS + REQUEST_MS) / 2;

/** Wait until the stub is holding nothing, or give up. Returns ms waited. */
async function drain(budgetMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if ((await stubState()).inflight === 0) return Date.now() - t0;
    await sleep(100);
  }
  return Date.now() - t0;
}

/** A fresh scope key per pull, so nothing joins a flight it didn't start. */
let keyCounter = 0;
const nextScope = (): string => `SCOPE${++keyCounter}`;

try {
  console.log("\n(a) a hung tracker: the route answers on the OPERATION clock");
  await ctl("/__heal");
  await ctl("/__latency?ms=0");
  await ctl("/__break?mode=hang");
  // Cold key: the cache has no last-good to serve, so this is the path that
  // holds a response open — before DRY-61, for as long as the partition lasted.
  const hung = await pull({ scope: nextScope() });
  check("it answers at all", hung.status !== 0, `${hung.status} after ${hung.ms}ms`);
  check("with a 502, not a hang", hung.status === 502, `${hung.status}`);
  check(
    `on the operation deadline (~${LIST_MS}ms), not the request one (${REQUEST_MS}ms)`,
    atOperationDeadline(hung.ms),
    `${hung.ms}ms`,
  );
  // The point of putting this budget UNDER the shell's: whatever the daemon
  // says here is what the sidebar renders. "signal timed out" — the browser's
  // own abort — names nothing.
  check(
    "and the message names the tracker and the deadline",
    /switchyard ticket list exceeded its \d+ms deadline/.test(hung.body.error ?? ""),
    (hung.body.error ?? "(none)").slice(0, 140),
  );

  console.log("\n(b) a tracker that is SLOW rather than broken is bounded too");
  // The case a per-request deadline structurally cannot bound: EVERY request
  // succeeds, comfortably inside its own backstop, and the pull is three of them
  // — list, epic exemption, child stats. Two of those already outlast the
  // operation deadline. Before DRY-61 this returned 200, late, and would go on
  // doing so for a pull of any length.
  await ctl("/__heal");
  await drain(2000);
  const perRequest = Math.round(LIST_MS * 0.7);
  await ctl(`/__latency?ms=${perRequest}`);
  const slowCold = await pull({ scope: nextScope() });
  check(
    "a slow pull ends on the operation clock",
    atOperationDeadline(slowCold.ms),
    `${slowCold.ms}ms at ${perRequest}ms/request`,
  );
  check(
    "and it says so rather than answering late",
    slowCold.status === 502 &&
      /switchyard ticket list exceeded/.test(slowCold.body.error ?? ""),
    `${slowCold.status} ${(slowCold.body.error ?? "").slice(0, 100)}`,
  );

  console.log("\n(c) …and with a list in hand it costs the refresh, not the sidebar");
  // The reassurance half. A deadline that blanked a working sidebar would be a
  // worse bug than the one being fixed (DRY-55's rule, and DRY-72 trap 4): the
  // cache keeps last-good and marks it stale.
  await ctl("/__latency?ms=0");
  const warmScope = nextScope();
  const warm = await pull({ scope: warmScope });
  check("the key is warm", warm.status === 200 && (warm.body.tickets?.length ?? 0) > 0, `${warm.status} ${warm.body.tickets?.length} tickets`);
  await ctl(`/__latency?ms=${perRequest}`);
  const stale = await pull({ scope: warmScope, fresh: true });
  check("a forced refresh that blows the deadline still answers 200", stale.status === 200, `${stale.status}`);
  check("keeping the rows", (stale.body.tickets?.length ?? 0) > 0, `${stale.body.tickets?.length} tickets`);
  check(
    "and marking them stale, naming the deadline",
    /exceeded its \d+ms deadline/.test(stale.body.stale?.error ?? ""),
    (stale.body.stale?.error ?? "(not stale)").slice(0, 140),
  );

  console.log("\n(d) the upstream sockets stop accumulating");
  // The half the desk cannot see, and the reason this is not just a nicer error
  // message. Each pull below is a DIFFERENT cache key, because that is what
  // still fans out per client: DRY-72 collapses same-key polls onto one flight,
  // so a second browser accumulates only when its scope chips differ — and the
  // sidebar mints keys per chip set, per epic expansion, per search.
  await ctl("/__heal");
  await drain(REQUEST_MS + 2000);
  await ctl("/__latency?ms=0");
  await ctl("/__break?mode=hang");
  const WAVE = 4;
  const wave1 = Promise.all(Array.from({ length: WAVE }, () => pull({ scope: nextScope() })));
  // Long enough for wave 1's requests to be parked upstream, short enough that
  // nothing has had time to give up.
  await sleep(Math.round(LIST_MS * 0.4));
  const held1 = (await stubState()).inflight;
  check(`wave 1 is parked upstream (${WAVE} scopes × 2 projects)`, held1 >= WAVE, `${held1} in flight`);

  // Wave 2 lands AFTER wave 1's deadline should have released it. That gap is
  // the entire test: an unbounded daemon is still holding wave 1's sockets when
  // wave 2 opens its own, and the peak is the sum.
  await sleep(LIST_MS);
  const wave2 = Promise.all(Array.from({ length: WAVE }, () => pull({ scope: nextScope() })));
  await sleep(Math.round(LIST_MS * 0.4));
  const held2 = (await stubState()).inflight;
  check(
    "wave 2 does not pile on top of wave 1",
    held2 <= held1,
    `${held1} in flight during wave 1, ${held2} during wave 2`,
  );

  const results = [...(await wave1), ...(await wave2)];
  check(
    "every pull in both waves ended",
    results.every((r) => r.status !== 0),
    JSON.stringify(results.map((r) => r.status)),
  );
  check(
    "each on the operation clock",
    results.every((r) => atOperationDeadline(r.ms)),
    JSON.stringify(results.map((r) => r.ms)),
  );
  // A GUARD, not a discriminator, and worth being explicit about since it sits
  // in the section whose numbers are the point: by the time both waves have
  // RETURNED, an unbounded daemon's requests have died at their own backstop
  // too, so this passes either way. What it holds down is a different way to
  // fail — giving up on the promise while leaving the socket open upstream,
  // which would leak exactly what the deadline was added to stop. The
  // accumulation claim is `held2 <= held1` above.
  const drained = await drain(LIST_MS * 2);
  const idle = (await stubState()).inflight;
  check("no socket is left behind by a pull that gave up", idle === 0, `${idle} in flight after ${drained}ms`);
} finally {
  await ctl("/__heal").catch(() => {});
  await ctl("/__latency?ms=0").catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
