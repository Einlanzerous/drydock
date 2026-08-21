# Verifying session history (DRY-56)

Database tier only, so **both backends have to be run** — the file store's
expected result is legible degradation, not parity.

```sh
docker run -d --name dry56-db -e POSTGRES_PASSWORD=… -e POSTGRES_USER=drydock \
  -e POSTGRES_DB=drydock -p 127.0.0.1:55440:5432 postgres:16-alpine
DRYDOCK_PORT=4392 DRYDOCK_DATABASE_URL=postgres://…@127.0.0.1:55440/drydock \
  node --import tsx src/index.ts
curl -s localhost:4392/healthz          # store.capabilities.sessionHistory
curl -s localhost:4392/api/sessions/history
```

Do NOT point a test daemon at the central Postgres on :5432 — provisioning a
role there is a construct-server change, deliberately out of scope (DRY-28/58).

1. **A tombstone needs the daemon to have FORGOTTEN the session, not just for
   it to have exited.** Killing a supervisor leaves the session listed with
   `status: exited`, and that pane is DRY-41's — its scrollback is still
   readable and a tombstone would hide it. The sequence is: kill the
   supervisor, *then* restart the daemon, which doesn't re-adopt a dead
   session. Getting this wrong renders a card over a live transcript.
2. **The inverse is the new regression.** Restart the daemon under a LIVE
   session: DRY-57 reattaches it, and it must not tombstone. A history row
   exists the moment a session ends, so any check that reads history without
   consulting the live session list will draw one.
3. **`exit_code` cannot say why.** A deliberate stop and a crash are both
   non-zero (129/137/143); `end_reason` is written while the daemon still
   knows. A tombstone reading "failed" for a window you closed is DRY-49's
   trap 2 in a new surface. Assert `stopped` from `/kill` and `failed` from a
   killed supervisor.
4. **The file tier must SAY so, and only when it costs something.** The notice
   is raised when a window is dropped for want of a record — not at startup,
   or a fresh no-database install carries a permanent line about a feature it
   never asked for. Check both: a fresh desk shows nothing; losing a session
   shows the line.
5. `agent_session_id` comes from the hook payload — verify against a real
   `claude` rather than assuming the field is there. It is captured before the
   ticket early-return in `/hook/sessionstart`, so a ticketless session records
   one too.
6. **An id is not a transcript** (DRY-62). That hook fires whether or not the
   CLI is persisting anything, so `agentSessionId` being set says only that a
   session started — every session a pre-DRY-59 daemon spawned recorded one
   against a transcript that was never written, and the card offered to reopen
   a conversation that doesn't exist. `/api/sessions/history` marks those
   `transcriptMissing` by looking (`daemon/src/transcripts.ts`), and the gate
   is one predicate in `lib/daemon.ts` because the card and the spawn both ask
   and had drifted apart once already.
   - **Scan for the id; do not derive the path from the record.** Claude Code
     names its project directories by escaping the cwd, and the record's `cwd`
     is not where a ticket session ran anyway — `worktree` is. Get either wrong
     and the flag is set for sessions that DO have a transcript, which takes
     Resume away instead of the reverse. Session ids are UUIDs; a flat index of
     them can't collide.
   - **"Couldn't look" is a third state, not a "no".** An unreadable transcript
     directory must leave the flag unset, or one bad permission strips Resume
     from every card on the desk. Test it by taking the directory away, not by
     reasoning about it.
   - Harness: `scripts/verify/tombstone.mts`, rig in its README. Assert the
     label AND the args the click sends — they're computed in different files,
     and a card that says "Start again" while still passing `--resume` is the
     same bug in better copy.

