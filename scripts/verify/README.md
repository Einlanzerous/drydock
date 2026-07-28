# Partition harnesses for the workspace store (DRY-58)

There are no automated tests in this repo; CLAUDE.md's curls are the regression
suite. These are the part of that suite the curls can't express, because the
claims they check are about **latency and recovery**, not status codes.

Nothing here runs in CI or on install. They are ad-hoc, they start throwaway
daemons, and they take a few minutes. Run them when touching
`daemon/src/state/` or `shell/src/composables/layoutStore.ts`.

## Why a proxy and not `docker stop`

`docker stop` frees the port, so every connect fails instantly with
ECONNREFUSED and every latency bug hides. A real partition is host-up,
packets-dropped: the connect ACKs and nothing comes back. Three separate bugs
were only visible under the latter — see CLAUDE.md, "Verifying workspace state".

`proxy-tcp.mjs` also **freezes connections it has already established** rather
than only refusing new ones. The pool keeps clients idle for 30s, so a proxy
that blocks new connects alone never partitions anything at all.

## Setup

```sh
# Throwaway daemon — file store (the default tier, the one that gets forgotten)
cd daemon && DRYDOCK_PORT=4370 DRYDOCK_HOST=127.0.0.1 \
  DRYDOCK_STATE_FILE=/tmp/dry58-state.json DRYDOCK_TRACKER=fixture \
  node --import tsx src/index.ts &

# HTTP partition proxy in front of it, and the dev shell pointed at the PROXY
node scripts/verify/proxy-http.mjs &                      # :4371 → :4370
cd shell && VITE_DAEMON_URL=http://127.0.0.1:4371 bunx vite --port 5370 --strictPort &

npm i playwright        # in this directory; not a repo dependency
```

For the Postgres tier, add a throwaway database behind the TCP proxy and a
second daemon in front of it:

```sh
docker run -d --name dry58-pg -e POSTGRES_PASSWORD=dry58 -e POSTGRES_DB=drydock \
  -p 127.0.0.1:5455:5432 postgres:16
node scripts/verify/proxy-tcp.mjs &                       # :5456 → :5455, control :5457

cd daemon && DRYDOCK_PORT=4372 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
  DRYDOCK_DATABASE_URL='postgres://postgres:dry58@127.0.0.1:5456/drydock' \
  node --import tsx src/index.ts &
```

Then point `proxy-http.mjs` at it (`TARGET_PORT=4372`) and pass
`DAEMON=http://127.0.0.1:4372` to the browser harnesses. **Run them against both
tiers** — the file store is what a fresh clone runs.

## The harnesses

| | asserts |
|---|---|
| `roam.mjs` | Roaming resumes with no reload, for an outage starting before *and* after the first read. Includes the conflict rule as a pair: an untouched client adopts the daemon's desk live, a client that dragged keeps its own. |
| `hang.mjs` | The accept-then-silence partition. A push that never settles must still raise the notice and leave recovery alive. |
| `surface.mjs` | DRY-28's surface claims (wipe localStorage → reload → desk intact; a fresh profile gets the same desk) plus how the notice presents: once, no focus steal, self-clearing, and a hidden tab still recovers. |
| `timings.mjs` | Postgres only. Timings, not status codes: one request per window pays the timeout, the rest return in ms, the window widens 10 → 20 → 30 and stops, `/healthz` answers instantly while cooling and resets after a heal. |
| `drift.sh` | Postgres only. An edited applied migration 503s naming the file while the live PTY keeps running; reverting clears it; a null checksum is adopted and backfilled. |

Each exits non-zero on failure and prints one line per check.

## Making sure a harness still discriminates

A green harness proves nothing if it would also be green against the bug. Check
it the way these were checked:

```sh
git checkout main -- shell/src/composables/layoutStore.ts \
  shell/src/composables/useWindowManager.ts shell/src/App.vue
node scripts/verify/roam.mjs        # expect 6 failures
git checkout HEAD -- shell/src/composables shell/src/App.vue
```

Vite hot-reloads, so no restart is needed between the two runs.

## Overrides

`SHELL_URL`, `DAEMON`, `PROXY` for the browser harnesses; `PROXY_PORT` /
`TARGET_PORT` for `proxy-http.mjs`; `PG_PROXY_PORT` / `PG_PORT` / `CONTROL_PORT`
for `proxy-tcp.mjs`; `PG_URL` / `PG_CONTAINER` for `drift.sh`.

**`DAEMON` must point at whatever `proxy-http.mjs` forwards to.** Getting that
wrong makes the harness assert against a different daemon than the browser is
driving, which looks exactly like a product failure and isn't one.
