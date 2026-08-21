# Verifying who may use the daemon (DRY-27)

Three postures, and **all three have to be run** — they are different code
paths, not settings of one:

| `DRYDOCK_MULTI_USER` | `DRYDOCK_AUTH_PASSWORD` | `DRYDOCK_DATABASE_URL` | mode |
|---|---|---|---|
| unset | unset | either | `off` — every request is `DRYDOCK_OWNER`, what shipped before |
| unset | set | either | `single` — one account, no database needed |
| set | set | **required** | `multi` — accounts in Postgres, a desk each |

```sh
PW=whatever-you-like-8-plus       # a throwaway daemon, so any string will do
DRYDOCK_PORT=4394 DRYDOCK_HOST=127.0.0.1 DRYDOCK_AUTH_PASSWORD="$PW" \
  DRYDOCK_STATE_FILE=/tmp/s.json node --import tsx src/index.ts
curl -s localhost:4394/api/auth/info            # {mode, multiUser, needsSetup?}
curl -s localhost:4394/api/sessions              # 401 + authRequired
TOK=$(curl -s -X POST localhost:4394/api/auth/login -H 'Content-Type: application/json' \
        -d "{\"password\":\"$PW\"}" | jq -r .token)
curl -s -H "Authorization: Bearer $TOK" localhost:4394/api/sessions
```

The traps:

1. **`off` is the default and has to stay the default.** A fresh clone, `bun run
   up`, and the isolated single-host profile all run with no credential — so the
   first thing to check after touching this is that a daemon with nothing set
   still answers anonymously and the shell still draws its desk. A login form on
   a daemon that has no accounts is a prompt nobody can satisfy.
2. **No database means no multi-user, and asking anyway must FAIL THE BOOT.**
   Accounts live in `store.users`, which is undefined on the file tier — the
   same derived-capability trick as `SessionHistory` (DRY-56), so there is no
   branch anywhere that could grant a second account without Postgres. The
   check is in `index.ts` before `server.js` is even imported, because a static
   import is hoisted: the daemon would otherwise bind its port and adopt every
   live session before deciding it shouldn't have started. Degrading to
   single-user instead would be worse than the error — nobody re-reads a log
   line that says "ignoring DRYDOCK_MULTI_USER".
3. **A database outage may not sign anybody out.** This is DRY-28's
   non-negotiable property applied to identity: tokens are stateless HMAC
   (`auth/tokens.ts`), so nothing is read to verify one, and the multi-user
   epoch check falls back to a cached record rather than to a locked desk. Test
   it by stopping the container mid-session — `/api/sessions` keeps answering,
   spawns keep working, and only a NEW login 503s (with a message saying so, not
   "wrong password"). Note the store's retry cooldown means recovery takes up to
   30s after the database returns; that is DRY-58's, not this ticket's.
4. **Two transports cannot carry a header, and they are the two that matter.**
   `EventSource` has no API for one and the browser `WebSocket` constructor has
   none either, so both take a short-lived `stream` token in the query string.
   That audience is refused on every other route — check it, because the whole
   reason for the split is that a URL is where a credential ends up in a proxy
   log:
   ```sh
   ST=$(curl -s -X POST -H "Authorization: Bearer $TOK" localhost:4394/api/auth/stream-token | jq -r .token)
   curl -s -H "Authorization: Bearer $ST" localhost:4394/api/sessions   # must 401
   curl -s -m 1 "localhost:4394/api/events?token=$ST"                   # must stream
   ```
5. **The hooks are not the browser.** A spawned CLI curls back into a daemon
   that now refuses anonymous requests, so each session carries its own key
   (`DRYDOCK_SESSION_KEY`, injected into the PTY env and recorded in the
   sessions-dir metadata). It opens `/hook/*` and NOTHING else — deliberately,
   because the agent can read its own environment, and the one thing it would
   most like to do with a credential is answer its own permission gate. Verify
   both halves: a hook POST without the key 401s, and the key does not work on
   `/api/sessions/<id>/permission`. A session with NO key recorded is let
   through on purpose — that can only be one spawned by an older daemon, and
   refusing it would mean an upgrade silently breaks every live agent's gates.
6. **The failed-login delay is a DELAY, not a lockout.** A lockout on a daemon
   holding somebody's live agents is a denial of service anybody can trigger
   from outside — the owner is locked out of their own running work by a
   stranger typing the wrong password. Note also that the plaintext credential
   is hashed with scrypt at first use rather than compared as a digest: a
   `DRYDOCK_AUTH_PASSWORD` checked with two SHA-256s made the DEFAULT way of
   turning auth on the cheapest to brute-force, and made the concurrency cap on
   the route — justified out loud by scrypt's cost — guard a path that wasn't
   paying it.
7. **Rotating the credential must end the sessions it issued.** There is no
   users table on the single tier to hold a token epoch, so the CONFIGURED
   credential is its own epoch (`credentialEpoch`). Derive it from the env value
   and never from the scrypt hash computed at boot — that hash has a fresh salt
   each time, so it would sign everybody out on every `--watch` restart. Test
   both directions: same password across a restart keeps you in, a changed one
   does not.
8. **Ownership only applies under multi-user.** Both directions strand things
   otherwise, and only one of them is obvious. Turning it ON: every session
   spawned under `off`/`single` recorded `owner: DRYDOCK_OWNER` — a real value,
   so the "no owner means yours" heal doesn't cover it — and becomes invisible
   AND unkillable. Hence `adoptSessions`, the runtime twin of `adoptOwner`.
   Turning it OFF again: sessions carry uuid owners and the viewer is the
   constant, same result. Hence `ownershipApplies()`.
9. **Removing an account must not strand its agents.** An account id is the only
   handle anything has on its sessions, so deleting one mid-run leaves live
   agents nothing can list, attach to or kill. Refused with a count.
10. **Setting somebody else's password is takeover, not administration.** The
   flat model means anybody can add or remove an account — a removal is
   something you NOTICE. A password change is silent, and afterwards their desk,
   their history and their agents' transcripts are yours. Own account only, and
   the current password is required even then: a token in a browser somebody
   left open must not be enough to lock the owner out.
11. **An empty string is not an absent field.** The single-account login form
   doesn't show a name (it is host config), so the browser posts `name: ""` —
   and `body.name ?? CONFIG.auth.user` passes that straight through to a
   comparison that can only fail. It read as "wrong name or password" for the
   correct password. `||`, and only on the tier where defaulting makes sense.
12. **Turning multi-user on must not lose the desk you had.** Everything saved
   before accounts is owned by the constant `DRYDOCK_OWNER` ("local"), so the
   first account ADOPTS those rows (`adoptOwner`) at bootstrap. Skip it and the
   feature presents as "my workspace and all my session history are gone" — the
   rows are still there, just under a name nobody logs in as. Test the upgrade
   path specifically: save a desk with auth off, restart with multi-user on, log
   in, and the desk must be the same one.
13. **Seeding the owner from env, not from a first-run screen.** This port is
   reachable from the LAN by default, and a "claim this Drydock" form on an
   unclaimed instance is a race whoever finds it first wins.
14. **Public runs are watchable, not controllable.** They are also not
   BROWSABLE: `/api/sessions/:id/file` reads an arbitrary path under the
   session's working directory, which the agent need never have opened, so it is
   gated on ownership rather than visibility. `visibility: "public"` puts
   a session on everyone's rail; the attach socket opens for them and every
   frame that would CHANGE the session is dropped (`mayDrive` in server.ts).
   Gates are the exception that isn't: they go only to the owner, since a panel
   whose buttons 404 is worse than no panel, and the tool input rides along with
   them. Check that a spectator gets no ✕ on the card and a `read only` tag on
   the pane — a control that reports a failure every time it is pressed is how
   this feature would actually ship broken.
15. **`kill` stayed idempotent.** An unknown id still answers `{ok:true}`
   (DRY-60's sweep and the ✕ race each other by design); only a session that
   exists and isn't yours is refused, and it is refused as "unknown" so this
   doesn't become a way to enumerate other people's sessions.

**Assert on what ARRIVED, never on what rendered.** Both of this harness's
central claims shipped in a form that could not fail: the SSE check selected two
class names that exist nowhere in the shell (the real banner is `.offline`) and
ran before anything was on the rail, where that banner is suppressed anyway; and
the WebSocket check waited for an `.xterm` element, which `term.open()` creates
on mount whether or not a socket ever opened. Both now assert on bytes that only
the transport under test could have delivered — a gate raised through the hook
endpoint appearing as a panel, and a marker the PTY prints appearing in the
terminal's rows. (This used to add "use output that CONTINUES", because a
spawn's replay was always empty — the daemon's ring started when it bound the
supervisor and only an adopt pulled the earlier buffer across, so a one-shot
echo looked like a broken socket. **That was the bug, not a rule**: DRY-79 has
the spawn path take the replay too, and a marker printed once now arrives.
Output that continues is still the safer probe for a check about auth, since it
does not depend on this.)

Harness: `scripts/verify/auth.mts`, rig in its README — a browser, three
daemons, about a minute. Run it when touching `daemon/src/auth/`, the route
guard in `server.ts`, or `shell/src/lib/auth.ts`. The claims it holds down are
all about what the SHELL does with a 401, which curl cannot see: a shell that
ignored auth entirely would render its desk, poll every three seconds, and show
a banner about the daemon being unreachable.

