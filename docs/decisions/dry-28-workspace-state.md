# Verifying workspace state (DRY-28)

Workspace state has two backends behind one interface (`daemon/src/state/`),
picked solely by whether `DRYDOCK_DATABASE_URL` is set. **Verify both** — the
file store is what a fresh clone and the single-host profile run, and it's the
one that gets forgotten:

```sh
# file store (the default)
DRYDOCK_PORT=4399 DRYDOCK_STATE_FILE=/tmp/state.json node --import tsx src/index.ts
# postgres — same code path a central database uses. db:up generates a password
# into .env on first run and writes DRYDOCK_DATABASE_URL beside it, which the
# daemon reads on its own (env.ts walks up), so no credential is typed here.
bun run db:up      # loopback :5433, deploy/compose.db.yml
DRYDOCK_PORT=4399 node --import tsx src/index.ts
```

```sh
curl -s localhost:4399/healthz                       # store: {kind, ok}
curl -s localhost:4399/api/workspace                 # {workspace: null} when unsaved
curl -s -X PUT localhost:4399/api/workspace -H 'Content-Type: application/json' \
     -d '{"version":2,"layout":"tile","windows":[]}'
curl -s -X DELETE localhost:4399/api/workspace
```

Non-negotiable properties, all of them regressions waiting to happen:

1. **A dead database never costs a PTY.** Stop the container mid-session: the
   daemon stays up, sessions stay running, `/healthz` reports `store.ok:false`,
   `/api/workspace` answers 503. Start it again and the store heals *without a
   daemon restart* — a restart is precisely what kills every live agent.
   `PostgresStore` migrates lazily for this reason; nothing connects at boot.
2. **`docker stop` is NOT a sufficient outage test.** It frees the port, so
   every connect fails instantly with ECONNREFUSED and any latency bug hides.
   A real partition — host up, packets dropped — costs `connectionTimeoutMillis`
   per attempt instead. That distinction concealed a live bug: the store's retry
   cooldown keyed off "have we migrated yet", so once the first migration
   succeeded it never engaged again and every request re-dialled a dead
   database for 5s, with the shell's restore blocking on one before it could
   draw. Test with a proxy that accepts and then goes silent, and assert on
   *timings*, not just status codes. The cooldown must be driven by the last
   failure of ANY operation.

   Two more bugs of that exact shape surfaced in DRY-58, both invisible to
   `docker stop`. **The proxy must also freeze connections it has already
   established**, not just refuse new ones — the pool keeps clients idle for
   30s, so a partition that only blocks new connects never happens at all.
   And once it does: `connectionTimeoutMillis` bounds *acquiring* a connection,
   not a query issued on one the pool already holds. Without `query_timeout` the
   daemon waits on TCP retransmits for minutes, `/api/workspace` never returns,
   and the route can't 503 what never resolves — so the cooldown never engages
   and every later request queues behind it. Same class on the shell side:
   `putWorkspace` needs its own budget, because a push that never settles neither
   succeeds nor throws, and the retry loop that awaits it goes quiet forever.
3. **The `pool.on("error")` listener is load-bearing** (DRY-45's bug class): an
   idle client dying emits `error`, and an unhandled `error` event throws. Delete
   that line and stopping Postgres kills the daemon.
4. **The daemon never parses `windows`.** That shape is the shell's (`Win`), and
   mirroring it here would be the protocol.ts tax on a payload we hand back
   unread. Validation is structural only.
5. **Prove it at the surface, not with curl.** The claim is "the desk follows the
   person", so the tests that matter are: wipe `localStorage` → reload → desk
   intact; and a browser profile that has never seen the desk → same desk. Both
   pass under the old localStorage design only by accident. Use the `verify`
   skill.
6. **An outage has to END on its own** (DRY-58). The shell re-reads on a backoff
   and flushes what you arranged during the outage — no reload, no restart. Test
   both halves separately, because they are different code paths: an outage that
   starts *after* a good read (the push failed, `mayPush` is open) and one that
   starts *before* it (`mayPush` never latched, so the client doesn't know what
   it would be overwriting).
7. **Test the conflict rule as a PAIR, or it proves nothing.** When the outage
   predates the first read and the daemon turns out to hold a desk: a client
   that arranged nothing must ADOPT the daemon's desk live, and a client that
   dragged a window must KEEP its own. Check only the first and you can't tell
   the rule from "remote always wins"; check only the second and you've deleted
   the data-loss guard `mayPush` exists for. A window appearing because the
   session poll found a PTY is not arranging — that's the from-scratch cascade
   desk, and treating it as intent is the bug.
8. **The notice is a condition, not an event.** One line while it holds, cleared
   by whoever raised it, never dismissible, never stealing focus
   (`composables/notices.ts`). Assert it appears exactly once across repeated
   failures — and measure focus across the notice APPEARING, not across the drag
   that caused it, or you're only proving that clicking a title bar moves focus.
9. **Migration drift is an error, and only ever costs the desk.** Editing an
   applied `.sql` must 503 with the file named while live sessions keep running;
   reverting the file must clear it with no ledger surgery; and a ledger row
   with a null checksum (written before DRY-58) must be adopted and logged, not
   reported as drift.

Properties 6-9 have harnesses — `scripts/verify/` (see its README), which is
where the partition proxies live. Run them against **both** tiers. They aren't
wired into anything and never run on install; they exist because the claims are
about latency and recovery, which curl can't express. Before trusting a green
run, confirm the harness still discriminates by pointing it at the unpatched
file (the README shows how) — a harness that passes either way is worse than no
harness.

