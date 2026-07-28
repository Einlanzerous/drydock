// DRY-58 items 4+5, asserted on TIMINGS rather than status codes — the thing
// CLAUDE.md says to do, because a partitioned database and a refused one give
// identical status codes and wildly different latency, and it's the latency
// that tells you whether the cooldown is engaged at all.
//
// Claims under test:
//   1. Inside the cooldown, /api/workspace fast-fails in ms (no dial).
//   2. Inside the cooldown, /healthz answers in ms too, says `cooling:true`,
//      and carries a retryInMs — where it used to hold the caller for the
//      pool's 5s connect timeout or lie about having probed.
//   3. One request per window pays the ~5s connect timeout, and the window
//      widens 10s → 20s → 30s and then stops.
//   4. Healing restores service with no daemon restart, and the backoff resets.
const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4372";
const PGCTL = "http://127.0.0.1:5457";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

async function timed(path) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${DAEMON}${path}`, { signal: AbortSignal.timeout(45_000) });
    const body = await res.json().catch(() => null);
    return { ms: Date.now() - t0, status: res.status, body };
  } catch (err) {
    // A request the daemon never answers is itself a result — and the one this
    // harness exists to catch, so it must not take the harness down with it.
    return { ms: Date.now() - t0, status: 0, body: null, err: String(err) };
  }
}

console.log("\nBaseline (database reachable)");
{
  const ws = await timed("/api/workspace");
  const hz = await timed("/healthz");
  check("workspace 200 and quick", ws.status === 200 && ws.ms < 1000, `${ws.ms}ms`);
  check("healthz reports the store ok", hz.body?.store?.ok === true, `${hz.ms}ms`);
  check("no `cooling` field while healthy", hz.body?.store?.cooling === undefined);
}

console.log("\nPartition: accept the connection, then silence");
await fetch(`${PGCTL}/__break`, { method: "POST" });

// First request after the partition is the one that pays. ~5s = the pool's
// connectionTimeoutMillis. If this came back instantly the proxy would be
// refusing rather than partitioning, and the whole test would be worthless.
const first = await timed("/api/workspace");
check(
  "the first request pays the connect timeout (a real partition, not a refusal)",
  first.status === 503 && first.ms >= 4000,
  `${first.ms}ms, ${first.status}`,
);

// ...and every request behind it in that window returns immediately.
const inWindow = [];
for (let i = 0; i < 4; i++) inWindow.push(await timed("/api/workspace"));
check(
  "the rest of the window fast-fails without dialling",
  inWindow.every((r) => r.status === 503 && r.ms < 300),
  inWindow.map((r) => `${r.ms}ms`).join(" "),
);

const hzCool = await timed("/healthz");
check(
  "healthz answers immediately inside the cooldown",
  hzCool.ms < 300,
  `${hzCool.ms}ms (was up to 5000ms — it went through guard())`,
);
check(
  "healthz distinguishes cooling from down",
  hzCool.body?.store?.cooling === true && typeof hzCool.body?.store?.retryInMs === "number",
  JSON.stringify(hzCool.body?.store),
);
check("the daemon itself is still ok", hzCool.body?.ok === true);
check(
  "retryInMs is inside the first window",
  hzCool.body.store.retryInMs > 0 && hzCool.body.store.retryInMs <= 10_000,
  `${hzCool.body.store.retryInMs}ms`,
);

// The window has to WIDEN. Poll until a request pays the connect timeout again
// (the probe at the end of a window), and measure the gaps between probes.
console.log("\nBackoff: the window widens 10s → 20s → 30s");
const probes = [];
const t0 = Date.now();
while (probes.length < 3 && Date.now() - t0 < 130_000) {
  const r = await timed("/api/workspace");
  if (r.ms >= 4000) probes.push(Date.now());
  await sleep(400);
}
const gaps = probes.slice(1).map((t, i) => Math.round((t - probes[i]) / 1000));
check("three probes observed", probes.length === 3, `${probes.length}`);
// Each gap = the window + the 5s the probe itself costs.
check(
  "the second window is wider than the first",
  gaps[0] >= 20 && gaps[0] <= 32,
  `gap ${gaps[0]}s (expect ~20-25: a 20s window plus the 5s probe)`,
);
check(
  "the third is wider again and near the ceiling",
  gaps[1] >= 30 && gaps[1] <= 42,
  `gap ${gaps[1]}s (expect ~30-35: the 30s ceiling plus the 5s probe)`,
);

console.log("\nHeal (no daemon restart)");
await fetch(`${PGCTL}/__heal`, { method: "POST" });
let healed = null;
for (let i = 0; i < 90; i++) {
  const r = await timed("/api/workspace");
  if (r.status === 200) {
    healed = r;
    break;
  }
  await sleep(1000);
}
check("the store healed without a restart", healed !== null, healed ? `${healed.ms}ms` : "never");
const hzWell = await timed("/healthz");
check("healthz green again", hzWell.body?.store?.ok === true && !hzWell.body.store.cooling);
check("and it probes for real again", hzWell.ms < 1000, `${hzWell.ms}ms`);

// Backoff must RESET, or the next outage inherits a 30s window it didn't earn.
await fetch(`${PGCTL}/__break`, { method: "POST" });
const again = await timed("/api/workspace");
check("a fresh outage pays one connect timeout", again.ms >= 4000, `${again.ms}ms`);
const hzAgain = await timed("/healthz");
check(
  "the backoff reset — first window is 10s again, not 30s",
  hzAgain.body?.store?.retryInMs <= 10_000,
  `${hzAgain.body?.store?.retryInMs}ms`,
);
await fetch(`${PGCTL}/__heal`, { method: "POST" });

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
