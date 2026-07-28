#!/usr/bin/env bash
# DRY-58 item 6: does an edited migration become an error, and does that error
# stay confined to the workspace store?
#
# Drift is detected when a daemon migrates, which is at start or after a failed
# migration — so the realistic shape is "someone edited 001 and a daemon
# restarted", and that's what this does. Each phase starts its own throwaway
# daemon against the SAME database, which is exactly the dev/prod/throwaway
# arrangement CLAUDE.md encourages and the one drift silently breaks.
set -u
# Repo-relative, so this works from any checkout or worktree.
WT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MIG=$WT/daemon/src/state/migrations/001_workspace.sql
# Straight at Postgres, NOT through the partition proxy — this test is about the
# ledger, and a partition in the middle of it would only add noise.
URL=${PG_URL:-postgres://postgres:dry58@127.0.0.1:5455/drydock}
PGC=${PG_CONTAINER:-dry58-pg}
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
no()  { echo "  FAIL  $1 — $2"; FAIL=$((FAIL+1)); }

# Each phase gets its own daemon, so start/stop have to be exact. An earlier
# version matched processes by reading DRYDOCK_PORT out of /proc/<pid>/environ,
# which fails silently on a permission error — leaving the old daemon listening,
# the new one dead on EADDRINUSE (config.ts keeps it alive, serving nothing), and
# every check below quietly asserting against the PREVIOUS phase's state. Track
# the pid we started and wait on the port instead of sleeping and hoping.
DAEMON_PID=""
start() { # port logfile
  if curl -s -m 1 "localhost:$1/healthz" > /dev/null 2>&1; then
    echo "  something is already listening on :$1 — refusing to test against it"
    exit 1
  fi
  ( cd "$WT/daemon" || exit 1
    DRYDOCK_PORT=$1 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
      DRYDOCK_DATABASE_URL="$URL" nohup node --import tsx src/index.ts \
      > "$2" 2>&1 < /dev/null &
    echo $! > /tmp/dry58-daemon.pid )
  DAEMON_PID=$(cat /tmp/dry58-daemon.pid)
  # A drifted migration makes /api/workspace 503 while /healthz stays 200, so
  # poll the endpoint that answers either way.
  for _ in $(seq 1 40); do
    curl -s -m 2 "localhost:$1/healthz" > /dev/null 2>&1 && return 0
    sleep 1
  done
  echo "  daemon on :$1 never came up — see $2"
  exit 1
}
stop() { # port
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 20); do
    curl -s -m 1 "localhost:$1/healthz" > /dev/null 2>&1 || { DAEMON_PID=""; return 0; }
    sleep 1
  done
  echo "  WARNING: daemon on :$1 is still listening — later phases are unreliable"
}
psql() { docker exec "$PGC" psql -U postgres -d drydock -tAc "$1"; }

cp "$MIG" /tmp/dry58-mig.orig
SLOW=$(dirname "$MIG")/002_slow_probe.sql
trap 'cp /tmp/dry58-mig.orig "$MIG"; rm -f "$SLOW"; [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null' EXIT
# Clear a probe left behind by a previous run that died past its trap (kill -9,
# a crashed terminal). It matters more than the usual stale-tempfile grumble:
# this directory is real migration input, so anything left here is applied by
# the next daemon to boot against that database — including the dev and prod
# ones, which is the very arrangement §1 is about. Also gitignored, so it can't
# be committed by accident.
rm -f "$SLOW"

# Wait for the database before starting anything. Not hygiene: every check below
# asserts on a SPECIFIC 503 (the drift message), and a store that is merely
# still connecting 503s too — so a cold container turns this whole file red for
# a reason that has nothing to do with what it tests. Caught exactly that way.
for _ in $(seq 1 30); do
  psql "select 1" > /dev/null 2>&1 && break
  sleep 1
done
psql "select 1" > /dev/null 2>&1 || { echo "  database at $URL never came up"; exit 1; }

echo
echo "0. baseline — the migrations apply cleanly first"
# Everything below turns on 001 being ALREADY APPLIED with its original bytes.
# Against a fresh database it isn't, and §1 then applies the *edited* file as a
# first-time migration: no drift, 200, three red checks and a §2 that fails the
# other way because the ledger now holds the edited checksum. The README hands
# you a brand-new container, so this phase is what makes the rest mean anything.
start 4377 /tmp/dry58-base.log
CODE=$(curl -s -m 60 -o /dev/null -w '%{http_code}' localhost:4377/api/workspace)
[ "$CODE" = "200" ] && ok "migrations applied against a clean database" \
  || no "baseline migrate" "got $CODE — $(tail -2 /tmp/dry58-base.log)"
stop 4377

echo
echo "1. an applied migration edited on disk"
printf '\n-- an edit made after this migration was applied\n' >> "$MIG"
start 4373 /tmp/dry58-drift.log
SESSION=$(curl -s -X POST localhost:4373/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"bash","title":"survivor"}' | grep -o '"id":"[^"]*' | head -1 | cut -d'"' -f4)
BODY=$(curl -s -m 20 localhost:4373/api/workspace)
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' localhost:4373/api/workspace)
echo "$BODY" | grep -q "changed after it was applied" \
  && ok "the store refuses and names the file" \
  || no "the store refuses and names the file" "$BODY"
[ "$CODE" = "503" ] && ok "it degrades (503), it does not 500" || no "503" "got $CODE"
echo "$BODY" | grep -q "add a new" \
  && ok "the message says what to do instead" \
  || no "the message says what to do instead" "$BODY"

HZ=$(curl -s -m 20 localhost:4373/healthz)
echo "$HZ" | grep -q '"ok":true' && ok "the DAEMON is still healthy" || no "daemon healthy" "$HZ"
echo "$HZ" | grep -q '"kind":"postgres","ok":false' \
  && ok "the store reports itself not ok" || no "store not ok" "$HZ"

SESS=$(curl -s localhost:4373/api/sessions)
echo "$SESS" | grep -q "\"id\":\"$SESSION\"" && echo "$SESS" | grep -q '"status":"running"' \
  && ok "the live PTY is untouched — drift costs the desk, never a session" \
  || no "live PTY untouched" "$SESS"
stop 4373

echo
echo "2. the same daemon once the edit is reverted"
cp /tmp/dry58-mig.orig "$MIG"
start 4374 /tmp/dry58-clean.log
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' localhost:4374/api/workspace)
[ "$CODE" = "200" ] && ok "reverting the file clears it — no manual ledger surgery" \
  || no "reverting clears it" "got $CODE"
stop 4374

echo
echo "3. a ledger row from before checksums existed"
psql "update drydock_schema_migrations set checksum = null where name = '001_workspace.sql'" > /dev/null
start 4375 /tmp/dry58-adopt.log
CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' localhost:4375/api/workspace)
[ "$CODE" = "200" ] && ok "a null checksum is adopted, not treated as drift" || no "adopted" "got $CODE"
grep -q "adopted checksum" /tmp/dry58-adopt.log \
  && ok "and it says so once, in the log" \
  || no "logged the adoption" "$(tail -2 /tmp/dry58-adopt.log)"
CHK=$(psql "select coalesce(checksum,'NULL') from drydock_schema_migrations where name='001_workspace.sql'")
[ "$CHK" != "NULL" ] && [ -n "$CHK" ] \
  && ok "the checksum is backfilled, so the NEXT edit is caught" \
  || no "checksum backfilled" "$CHK"
stop 4375

echo
echo "4. a migration slower than the ordinary query ceiling still applies"
# The pool caps a normal query at 10s so a sick database can't hold a request
# open. Applied to schema changes that is a trap with a long fuse: the first
# migration that builds an index over a table with real history would be
# cancelled, roll back, and retry forever with nothing but a 57014 to explain
# it. migrate() exempts the DDL (MIGRATION_TIMEOUT_MS) — this proves it, because
# nothing else here would notice it being taken away.
#
# NB this writes a real file into daemon/src/state/migrations for ~20s. The trap
# removes it on any normal exit or Ctrl-C, and the top of this script clears a
# leftover before anything starts — but a kill -9 in this window leaves a 13s
# sleep and a junk table for the next daemon that boots against this database.
# It's gitignored, so it shows up as nothing worse than a stale local file.
cat > "$SLOW" <<'SQL'
do $$ begin perform pg_sleep(13); end $$;
create table if not exists dry58_slow_probe (x int);
SQL
start 4376 /tmp/dry58-slow.log
CODE=$(curl -s -m 60 -o /dev/null -w '%{http_code}' localhost:4376/api/workspace)
[ "$CODE" = "200" ] && ok "a 13s migration applies under a 10s query ceiling" \
  || no "slow migration applies" "got $CODE — $(grep -o 'statement timeout' /tmp/dry58-slow.log | head -1)"
HAS=$(psql "select count(*) from information_schema.tables where table_name='dry58_slow_probe'")
[ "$HAS" = "1" ] && ok "and its DDL really landed" || no "DDL landed" "count=$HAS"
stop 4376
psql "drop table if exists dry58_slow_probe" > /dev/null
psql "delete from drydock_schema_migrations where name = '002_slow_probe.sql'" > /dev/null
rm -f "$SLOW"

echo
echo "$([ $FAIL -eq 0 ] && echo ALL PASS || echo "$FAIL FAILURE(S)")  ($PASS passed)"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
