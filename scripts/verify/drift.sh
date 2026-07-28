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

start() { # port logfile
  cd "$WT/daemon" || exit 1
  DRYDOCK_PORT=$1 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
    DRYDOCK_DATABASE_URL="$URL" setsid nohup node --import tsx src/index.ts \
    > "$2" 2>&1 < /dev/null &
  sleep 5
}
stop() { # port
  for p in $(pgrep -f "node --import tsx src/index.ts"); do
    tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -q "^DRYDOCK_PORT=$1$" && kill $p
  done
  sleep 2
}
psql() { docker exec "$PGC" psql -U postgres -d drydock -tAc "$1"; }

cp "$MIG" /tmp/dry58-mig.orig
trap 'cp /tmp/dry58-mig.orig "$MIG"' EXIT

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
echo "$([ $FAIL -eq 0 ] && echo ALL PASS || echo "$FAIL FAILURE(S)")  ($PASS passed)"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
