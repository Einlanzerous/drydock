# The daemon says when it is suspect (DRY-48)

`/healthz` was a one-line handler answering `{ok:true, sessions:N}`, which proved
that the event loop still turned and the HTTP server still answered. It could not
fail. So a daemon that had taken an uncaught exception and stayed up — DRY-45's
posture, still available as `DRYDOCK_EXIT_ON_UNCAUGHT=0` — looked exactly as
healthy from outside as one that hadn't, and prod's `Restart=always` unit had
nothing to act on either way.

It now reports a `status` of `ok` / `degraded` / `down` over four things
(`daemon/src/health.ts`): the faults this process has taken, the session registry
and the on-disk index behind it, the log sink, the tracker, plus the store it
already carried. `/readyz` is beside it for whatever polls on a timer.

```sh
curl -s localhost:4399/healthz | jq '{status, ok, faults, tracker: .tracker.state}'
curl -s -o /dev/null -w '%{http_code}\n' localhost:4399/readyz   # 200, or 503 when down
```

1. **`ok` had to keep its old meaning, and that is the whole of the ticket in one
   field.** It is false ONLY for `down`. Everything already watching this
   endpoint reads that boolean — the harnesses in `scripts/verify/`
   (`surface.mts` and `roam.mts` assert on it directly), docs/deploy.md,
   whatever a host has pointed at it — and a daemon that started
   answering `ok:false` because its tracker was unreachable would be this change
   making liveness less useful than the handler that could not fail. `degraded`
   is the new information, and it goes in a new field.
2. **Neither `degraded` nor `down` is an instruction to restart, and the second
   one is the surprise.** `degraded` covers a process holding five live agents
   after one uncaught exception, which is precisely what DRY-45 decided was worth
   more than a clean process. `down` means the daemon cannot enumerate its own
   sessions — and its usual cause is the sessions directory having vanished or
   lost its permissions, which a restart does not fix but MAKES PERMANENT: the
   supervisors are still running, and the index was the only handle on them
   (DRY-57 trap 1). Both say "a human", not "a bounce".
3. **The tracker is OBSERVED, never probed.** One sidebar pull against a
   corporate Jira is 5.7-6s of cursor pages (DRY-72), so a health endpoint that
   asked the tracker itself would reinstate that fan-out behind a timer nobody
   can see — the exact cost that ticket removed, on a route meant to be cheap.
   `TrackerWatch` records the outcome of the calls the daemon was making anyway,
   which is why `unknown` is a state: a daemon nobody has opened a browser at is
   unasked, not degraded.
4. **"The tracker answered no" is not "the tracker is down", and telling them
   apart needed a typed error.** Both providers threw a plain `Error` carrying
   the status in its MESSAGE, so a 404 for a key somebody mistyped in the palette
   would have marked the daemon degraded — and left it that way, since nothing
   else need ever poll. Hence `TrackerHttpError` (`tracker/types.ts`) and
   `CALLER_FAULT`; 401/403 deliberately do NOT get that treatment, since a
   credential the tracker rejects fails every call. Note the class does not set
   `name`: `String(err)` is rendered to a person in a 502 body and on every poll's
   `stale.error`, and "TrackerHttpError:" is a word of jargon in exchange for
   nothing. jira.ts's Cloud/DC probes still match `-> 404` on that string, and
   were left alone rather than converted — a probe that works against a real
   instance is not worth re-testing for tidiness.
5. **A live provider that fell back to fixture data is degraded on sight.**
   `createTracker` warns once at boot and serves five invented tickets forever
   after, which looks exactly like a working tracker — the same class of silence
   as the ticket itself. Reported by comparing `DRYDOCK_TRACKER` with the
   provider's own id, so it needs nobody to have asked anything.
6. **`faults.record` runs inside `process.on("uncaughtException")`, where a throw
   is fatal.** Node exits 7, and a crash handler with its own crash path is worse
   than no handler — the same constraint `log.ts`'s `describe` is written to.
   Hence a `try` around two counter increments, and a stringifier that survives
   `throw null` and a hostile `toString`.
7. **An unhandled rejection is COUNTED but not routed through the exit policy.**
   The knob is named for uncaught exceptions and only ever governed those; a
   rejection leaves a much narrower dent (one promise chain failed, rather than
   an arbitrary point in a synchronous run being abandoned mid-way), and making
   it exit the daemon would be a real behaviour change smuggled into a ticket
   about reporting. It still makes the process suspect, which is what was asked
   for.
8. **`/readyz` is a NARROWER question, not a summary of `/healthz`.** It never
   consults the store or the tracker, for two reasons that both matter: an
   outage in either costs nobody a PTY (DRY-28's first property), so a supervisor
   acting on one would restart a daemon that is serving perfectly; and
   `store.health()` can block for the pool's connect timeout, which is fine for a
   human reading a report and wrong for the endpoint something polls. That is
   also why it reports `suspect` rather than folding faults into `ready`.
9. **A probe must not repair what it is probing.** `indexHealth()` reads
   `expandHome(CONFIG.sessionsDir)` rather than calling `sessionsDir()`, which
   creates the directory on first use — a probe that created it would answer `ok`
   about a daemon whose live sessions are being recorded into a directory nothing
   will ever adopt them from. Note honestly that the two spellings agree TODAY:
   `sessionsDir()` latches on `ensured`, which `manager.reconcile()` sets before
   the port binds, so the mutation is undetectable and the harness's check on it
   is a latch rather than a discriminator. It is written the way that doesn't
   depend on a latch in another module (DRY-72 trap 12's rule).
10. **`when-idle` polls; it does not subscribe.** It arms inside a crash handler,
   in a process that is by definition suspect, so hanging the exit off a session-
   end listener means that if the thing that broke is what would have fired it,
   the daemon stays up forever and the policy is silently off. The timer is
   `unref`'d so it is never itself a reason to be alive, and "nothing left to
   lose" is `running`, not "attached": an autonomous run with nobody watching is
   the case the policy exists for and it has no client at all.
11. **An unrecognised value for the knob is a boot error**, which is `flag()`'s
   rule (DRY-27 trap 1) applied where it now has three values instead of two:
   `DRYDOCK_EXIT_ON_UNCAUGHT=Idle` reading as "exit immediately" is a crash
   policy quietly not being the one somebody configured. `0` still means what it
   always did.
12. **The fault the harness injects is a REAL fault, and it is not a route.** The
   product must not grow a "crash yourself" endpoint — that would not widen what
   an attacker can do on a port that already spawns commands, but it would put a
   control whose only purpose is to break the daemon on the same unauthenticated
   surface prod serves. It is a preload (`scripts/verify/fault-inject.mts`) that
   throws from a timer callback on SIGUSR2. A route would ALSO be the wrong test:
   server.ts wraps every handler in a catch-all, so a throw there becomes a 500
   and no `uncaughtException` ever fires.

Harness: `scripts/verify/health.mts` + `fault-inject.mts`, rig in its README — it
starts the six daemons it needs, no browser, no database, about ninety seconds.
Confirm it discriminates: against `main` it fails **45 of 57**, and the twelve
survivors are the useful part of that number rather than slack — four are the
legacy-compatibility checks (which are supposed to pass), four are premises this
ticket didn't change (`=0` stays up, the default exits, a broken store already
reported `ok:false`), one is rig setup, and three pass VACUOUSLY against a daemon
with no health payload at all — including "and exits once nothing is running",
which `main` satisfies by having exited a minute earlier. That last one is the
argument for the `when-idle` pair below. Per mutation against the finished tree:

| mutation | fails |
|---|---|
| `ok: status !== "down"` → `status === "ok"` | 3 of 57 |
| `readiness()` refusing a degraded tracker | 1 of 57 |
| the uncaught handler not calling `faults.record` | 7 of 57 |
| `when-idle` ignoring whether anything is running | 4 of 57 |
| `when-idle` never arming (i.e. `stay` by another name) | 3 of 57 |
| `TrackerWatch.failed` without its `CALLER_FAULT` arm | 1 of 57 |
| `indexHealth` calling `sessionsDir()` | **0 of 57** — see trap 9 |

Two things about that table. The `when-idle` rows are a PAIR and each covers the
other's blind spot — a policy that exits immediately passes "it exits once
nothing is running" on its own, and one that never exits passes "it stayed up
while a session was running". And the last row is recorded as zero rather than
dropped, because a harness's own vacuous check is worth naming: the reader who
finds it needs to know it was measured, not assumed.

**The rig's own trap, which cost eighteen false failures on the first run.** Six
postures share one port, so a daemon that outlives its section answers for the
next one — plausibly, since it is a real Drydock. `startDaemon` now refuses to
run while anything is listening, `stopDaemon` escalates to SIGKILL and says so
rather than giving up quietly, and a `process.on("exit")` kills the child however
the file ends: a harness that crashes halfway leaves a daemon holding the port,
which breaks the NEXT run rather than the one that made the mess. Same lesson as
DRY-81's — assert it is OUR daemon, never that something answered.
