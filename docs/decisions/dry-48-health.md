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
   `unref`'d so it is never itself a reason to be alive. Note "nothing left to
   lose" is not about clients either: an autonomous run with nobody watching is
   the case the policy exists for and it has no client at all.
11. **"Nothing left to lose" is the WHOLE registry, not the running sessions —
   and the first cut got this wrong under a comment asserting it didn't.** That
   comment said an exited session was a card "a fresh daemon rebuilds (see
   `adoptExited`)", which is false by two independent routes review found:
   `session.ts` calls `forget(this.id)` as a session ends while this daemon is
   up, so there are no index files for the next boot to read; and on the path
   where `adoptExited` IS reached (it ended while the daemon was down) it
   deliberately does not put the session back in the registry. So the sequence
   was: two autonomous runs finish, one of them failed, an uncaught exception
   lands, `arm()`'s immediate check sees nothing running, and the daemon exits —
   discarding both cards, their scrollback, and (on the file tier) raising
   DRY-56's "a window that closes can't be resumed" for windows the daemon threw
   away on purpose. DRY-60 spent an entire ticket keeping a finished run on
   screen until somebody has SEEN it, measured in VISIBLE time; this posture
   waited for the moment those cards were the only thing left and then deleted
   them. The predicate is `manager.list().length === 0`.
   - **The daemon cannot tell a read card from an unread one**, because that
     clock is the shell's — only the browser knows what is on screen. So the
     honest reading of "nothing to lose" is "no sessions at all", and the cost
     is that a desk nobody is watching keeps the daemon alive indefinitely.
     That is the conservative direction and never worse than the `0` posture
     such a host would otherwise be running. A desk somebody IS watching empties
     itself: the ✕, DRY-60's sweep and `Clear finished` all go through `/kill`,
     which drops the session synchronously.
   - **The harness has to let a session END, not kill one.** `/kill` leaves the
     registry synchronously (DRY-60 trap 8), so a check built on it never
     produces the exited-but-listed state and passes against the bug. Section
     (i) spawns a `sleep 8` and waits it out.
12. **The unauthenticated payload is a decision, not an inheritance.** On a
   daemon with auth ON this is the only route besides `/api/auth/{info,login}`
   that answers a stranger, and it now serves two host paths, live/exited counts
   and `faults.last`. Those are kept — they are the answer to "what is this
   daemon and what happened to it", which is the ticket, and the store's error
   has carried a path here since DRY-28. What is NOT kept is somebody ELSE's
   text: both providers build a message as `${status} ${await res.text()}`, so a
   tracker behind a proxy puts that proxy's error page in it, and `TrackerWatch`
   reports `the tracker answered 500` instead. A non-HTTP failure reports its
   CLASS for the same reason and not for tidiness: `JSON.parse` embeds the first
   characters of what it was handed in its `SyntaxError`, so a tracker answering
   an HTML page with a 200 would put upstream text here by a second door. The body still reaches the two
   places it is useful and already gated — the route's 502 and `stale.error`
   (DRY-72) — which is why the harness asserts it as a PAIR. (Review's: the
   comment defending this route originally said it served "nothing a caller
   couldn't learn by watching the port", which stopped being true the moment the
   endpoint grew an opinion.)
13. **An unrecognised value for the knob is a boot error**, which is `flag()`'s
   rule (DRY-27 trap 1) applied where it now has three values instead of two:
   `DRYDOCK_EXIT_ON_UNCAUGHT=Idle` reading as "exit immediately" is a crash
   policy quietly not being the one somebody configured. `0` still means what it
   always did.
14. **The fault the harness injects is a REAL fault, and it is not a route.** The
   product must not grow a "crash yourself" endpoint — that would not widen what
   an attacker can do on a port that already spawns commands, but it would put a
   control whose only purpose is to break the daemon on the same unauthenticated
   surface prod serves. It is a preload (`scripts/verify/fault-inject.mts`) that
   throws from a timer callback on SIGUSR2. A route would ALSO be the wrong test:
   server.ts wraps every handler in a catch-all, so a throw there becomes a 500
   and no `uncaughtException` ever fires.

Harness: `scripts/verify/health.mts` + `fault-inject.mts`, rig in its README — it
starts the eight daemons it needs (plus a ninth that must refuse to start) and a
stub tracker of its own, no browser, no database, about two minutes.
Confirm it discriminates: against `main` it fails **49 of 63**, and the fourteen
survivors are the useful part of that number rather than slack — four are the
legacy-compatibility checks (which are supposed to pass), five are premises this
ticket didn't change (`=0` stays up, the default exits, a broken store already
reported `ok:false`, the route's 502 already quoted the tracker), one is rig
setup, and four pass VACUOUSLY against a daemon with no health payload at all —
including "exits once the desk is empty", which `main` satisfies by having
exited a minute earlier. That last one is the argument for checking `idle` from
three sides. `scripts/verify/README.md` names all fourteen. Per mutation against
the finished tree:

| mutation | fails |
|---|---|
| `ok: status !== "down"` → `status === "ok"` | 3 of 63 |
| `readiness()` refusing a degraded tracker | 1 of 63 |
| the uncaught handler not calling `faults.record` | 7 of 63 |
| `idle` counting only RUNNING sessions (review's bug) | 1 of 63 |
| `idle` ignoring whether anything is running | 6 of 63 |
| `idle` never arming (i.e. `stay` by another name) | 3 of 63 |
| `TrackerWatch.failed` without its `CALLER_FAULT` arm | 1 of 63 |
| `TrackerWatch.failed` quoting the tracker verbatim | 3 of 63 |
| `TrackerWatch.failed` never reporting the status | 1 of 63 |
| `indexHealth` calling `sessionsDir()` | **0 of 63** — see trap 9 |

Three things about that table. The three `idle` rows are one property seen from
three sides, and each covers the others' blind spot: a policy that exits
immediately passes "it exits once the desk is empty" on its own, one that never
exits passes "it stayed up while a session was running", and the one review found
passes BOTH. That middle row can only ever fail a single check — once the daemon
has exited early everything after it in the section passes — which is the whole
reason the check that catches it is placed while the finished card is still on
the desk rather than after it is dismissed. The three `TrackerWatch` rows are
disjoint, and the last two are here because the first attempt at that mutation
was wrong in an instructive way: neutering only the ternary's HTTP arm leaves the
else-branch, which is itself half the fix, so it measured 1 rather than 3 and
would have entered this table as evidence for a property it never tested. And the
zero is
recorded rather than dropped, because a harness's own vacuous check is worth
naming: the reader who finds it needs to know it was measured, not assumed.

**The rig's own trap, which cost eighteen false failures on the first run.** Six
postures share one port, so a daemon that outlives its section answers for the
next one — plausibly, since it is a real Drydock. `startDaemon` now refuses to
run while anything is listening, `stopDaemon` escalates to SIGKILL and says so
rather than giving up quietly, and a `process.on("exit")` kills the child however
the file ends: a harness that crashes halfway leaves a daemon holding the port,
which breaks the NEXT run rather than the one that made the mess. Same lesson as
DRY-81's — assert it is OUR daemon, never that something answered.
