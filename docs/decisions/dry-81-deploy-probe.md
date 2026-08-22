# A deploy that worked says so (DRY-81)

`install-prod.sh` ends by polling the daemon it has just restarted, and that
poll was `curl -fsS "http://127.0.0.1:$PORT/api/sessions"`. `-f` exits non-zero
on 4xx — so from the moment DRY-27 was configured, the route's **correct** 401
to an anonymous caller read as "daemon not answering on :4318 — check:
journalctl", and the script exited 1 over a daemon that was up and serving. The
probe now reads the status code and treats 200 and 401 alike.

The cost was never the wrong sentence. The exit status propagates, so anything
wrapping the script — a deploy step, a `set -e` caller — treated every
successful deploy as a failure; and the sentence sends somebody to go poking at
a prod daemon holding live agent PTYs, which is the one thing docs/deploy.md
tells them not to do. It only appears on a host that has turned auth ON, and
the FIRST install is clean because auth isn't configured yet — so it arrives
with the second deploy, on the host where a deploy is least casual.

1. **`/healthz` is the tempting fix and the wrong one.** It is unauthenticated,
   which is exactly the appeal, but it awaits `store.health()` and can block for
   the pool's connect timeout when a configured Postgres is down — its own
   comment in `server.ts` names this script as the reason nothing on the deploy
   path waits on it. Swapping to it trades a false failure under auth for a slow
   one under a database outage, and the daemon serves sessions fine in both.
   `/api/auth/info` is thin and anonymous but answers before the session
   registry is meaningfully up, which is most of what the probe is for.
   `/readyz` (DRY-48) is thin, anonymous AND doesn't wait on the store, so it
   answers the first objection — and the probe stayed where it is anyway,
   because the deploy's question is "is this daemon serving on this port" and
   `/api/sessions` answers it with a route the shell actually uses. Moving it
   would also retire the 401 case this whole section is about, which is a real
   posture and worth keeping under test.
2. **200 and 401, not "any HTTP response".** The overcorrection cures this
   ticket and then reports a healthy deploy while prod is down behind a proxy:
   502/503/504 is precisely what a reverse proxy with a dead upstream answers.
   The pair is exhaustive over this daemon's postures — anonymously
   `/api/sessions` is 200 with auth off and 401 with it on under `single` AND
   `multi`, because `Auth.identify` short-circuits on a missing credential
   before it reads the accounts store, so the 503 a store outage produces for a
   TOKEN-bearing caller is not reachable here. Check that if the route's
   anonymous answer ever moves; the harness asserts it directly rather than
   assuming it, for `single` — the `multi` half is reasoned from that
   short-circuit, since it needs Postgres.
3. **The status code alone is not enough, and saying otherwise was this
   change's own bug** (review, against the first version). Rejecting 5xx does
   nothing about a plain 200 page, which is what a stray web server on the port
   serves and which `curl -fsS` accepted too — so the comment claiming the pair
   made this "a test of is it OUR daemon" was measurably stronger than the code.
   It is now true instead: a 200 must carry `"sessions"` and a 401
   `"authRequired"`. And this is a deploy-path case rather than a lab one — if
   anything is already holding `:4318` the daemon loses the bind and exits, so
   the squatter is precisely what answers the probe.
4. **`-f` reproduces the ticket again, and only because of trap 3.** With
   `-w '%{http_code}'` and the body unread, the flag was harmless: it still
   printed 401 and merely exited 22, which the `|| true` swallows (measured,
   curl 8.5.0), so the guard against it was about idiom. Reading the body
   changed that in the same commit — `-f` DISCARDS the body on a 4xx, so
   `"authRequired"` cannot match and a healthy auth-on daemon is reported dead.
   The comment saying otherwise survived that commit and review caught it, which
   is the useful part: a note about why something is safe is only true of the
   code it was written against.
5. **The two budgets were wrong in opposite directions, both in the same two
   lines.** There was no per-attempt timeout at all, so a listener that accepts
   and never answers (a wedged event loop, a stale nginx in front of prod) hung
   the deploy forever with nothing on stdout — `-m 5`. And the poll as a whole
   was five one-second sleeps, which a refused connect burns instantly: prod
   reconciles its sessions BEFORE `listen()` (DRY-57), so time-to-bind grows
   with the number of live supervisors on the host, and enough of them produce
   this ticket's sentence again through a slow boot (review). Sixty seconds now,
   as a deadline rather than an attempt count. `DRYDOCK_DEPLOY_PROBE_BUDGET`
   exists for the harness, which has seven cases that are meant to fail and would
   otherwise wait out the full budget each — the right default being a terrible
   test, as ever.
6. **`prod_port` has to read the `.env` the way `env.ts` does**, and getting
   two of the three halves right was not enough. Prod's `.env` is hand-edited —
   the unit deliberately keeps every `DRYDOCK_*` in it — so every discrepancy
   here is this ticket again in a different spelling, and review found one on
   each pass. `env.ts` trims the value and strips a matching quote pair, so
   `cut` alone probes `:"4318"` while the daemon is on 4318. And it takes the
   **first** occurrence of a key (`key in process.env` skips the rest), so
   `tail -1` probes a port the daemon is not on — nastier than the quoted case,
   because appending is how this file gets edited and neither line looks wrong
   in it. And it has to find the same FILE: `env.ts` walks up from the
   daemon's cwd (`WorkingDirectory=<prod>/daemon`) and takes the first `.env`
   it sees, so a `daemon/.env` outranks the root one. Also needs `|| true`:
   under `set -eo pipefail` both a missing `.env` and one with no
   `DRYDOCK_PORT` line make the pipeline non-zero, taking the script down at
   its last step instead of falling back to the default. Five divergences
   between these two readers, five rounds, every one of them a false failure of
   exactly the kind this ticket is about.
7. **The failure line decides where somebody looks next, and both ways of
   getting it wrong shipped.** Three arms: nothing listening is a `journalctl`;
   a **5xx** is either a proxy with a dead upstream or this daemon's own
   catch-all (`server.ts` turns any unhandled throw into a 500), so also a
   journal; anything else means somebody has the port and the journal will only
   say the daemon could not bind. The first version appended one journal hint to
   every failure while its own comment argued the cases differed. The second
   split them and then asserted — here, in the comment, and in docs/deploy.md —
   that a non-200 answer means the daemon is not the answerer, which its own 500
   contradicts. Same mistake pointing in opposite directions.
8. **One probe, called twice** — same reasoning as DRY-87's one renderer.
   `DRYDOCK_DEPLOY_PROBE=1 deploy/install-prod.sh` runs it against this host's
   configured daemon and exits, touching nothing, which is both what the harness
   drives and a question worth being able to ask ("would this host's deploy call
   its daemon healthy?"). A harness with its own copy of the curl would verify
   the copy.

Harness: `scripts/verify/deploy-probe.mts`, rig in its README — two daemons it
starts itself, no browser, no systemd, about a minute. Its control runs the
literal old command against the auth-on daemon and requires it to fail, so a
posture that stopped being auth-on can't pass this file. Confirm it
discriminates with any of thirteen mutations, each failing a different section:
accept only 200 (**3 of 35**), accept any HTTP response (**8 of 35**), accept on
the status code alone (**2 of 35**), drop `-m 5` (**2 of 35**), put `-f` back
(**4 of 35**, and try it on the curl's second line — the static check folds
continuations, and did not before review), `prod_port` without its trim
(**2 of 35**), back to `tail -1` (**1 of 35**) or to a bare `^KEY=` anchor
(**2 of 35**), drop the 5xx arm (**2 of 35**), a journal hint on every arm
(**2 of 35**), the budget back to five seconds (**1 of 35**), a deploy tail
with its own inline port lookup (**2 of 35**), and `prod_port` reading only
`$PROD_DIR/.env` (**1 of 35**).

Three things about that table, all review's and all about the table rather than
the code. The 5xx mutations are a PAIR whose failures are disjoint, so naming the
wrong one sends the next person looking for a bug that isn't there. The
`.env`-shape checks failed **0 of 30** while they asserted only `exit 0`:
`prod_port` falls back to 4318, which on a dev box is the real prod daemon
answering 401, so the harness passed against the bug by finding somebody else's
daemon — they assert the reported PORT now, which is the DRY-27 section's "assert
on what arrived" rule turning up where nobody thought to apply it. And the last
two rows exist because every behavioural check drives `DRYDOCK_DEPLOY_PROBE`,
which calls these functions directly: a tail that grew its own inline lookup
would leave all of them green.

