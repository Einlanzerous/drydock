# The event stream carries exits (DRY-64)

`GET /api/events` (DRY-50) carried gates and nothing else, so a session ending
was WebSocket-only — and anything that merely wanted to know a run had finished
either held a socket per session purely to hear it, or polled `/api/sessions` on
a timer and read one field off every record. It now also carries `session-exit`:
`sessionId`, `status`, `exitCode`, `endReason`.

```sh
curl -sN localhost:4399/api/events &          # leave it running
curl -s -X POST localhost:4399/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"/bin/sh","args":["-c","sleep 1; exit 3"]}'
# → data: {…,"status":"exited","exitCode":3,"endReason":"failed"}
```

1. **It hangs off `SessionEndNotifier`, never `onRunEnd`.** That one is gated on
   `autonomous` inside `announceRunEnd`, by design — DRY-49's artefacts are for
   the runs nobody watched — so an exit event wired there fires for a fraction of
   sessions and looks like it works. Exactly the trap DRY-56 named when history
   took this notifier instead.
2. **Don't look the session up in order to filter it.** `/kill` drops it from the
   registry the moment it signals (DRY-60 trap 8), so by the time the child
   actually goes, `manager.get(id)` is undefined — and that exit is precisely the
   one somebody is waiting on. The notifier hands the session over; ask it. The
   check is a killed session emitting at all (`exitCode: 129`), not a clean one.
3. **`visibleTo`, not `ownedBy`** — deliberately looser than the gate filter
   beside it. A gate is a question only its owner can answer and it carries the
   tool's input; an exit is three fields a spectator on a public run can already
   read off `/api/sessions`, and withholding it leaves their card marching
   forever. Test both halves under multi-user, since only one of them is a leak:
   a stranger's private run must stay silent, a public one must arrive.
4. **`endReason` rides along, because `exitCode` is not a verdict.** Signalling a
   process exits it 129/137/143, so a consumer inferring failure from the number
   reports every deliberate stop as a crash — DRY-49's trap 2 and DRY-56's trap
   3, which is now this surface's too and worse here: `/kill` has already
   dropped the session, so unlike a card or a tombstone there is no record left
   to correct the impression. It comes from `ending()`, the accessor that exists
   for exactly this, and the wire type is `SessionEndOutcome` — the persisted
   `SessionEndReason` minus `unknown`, which a live ending cannot be. One
   definition, in protocol.ts, with `state/types.ts` extending it.
5. **There is no catch-up frame, and the reason is not that nothing is missed.**
   `gate-snapshot` exists because a resolution that fires while the stream is
   down is gone; an ordinary exit leaves the session in the registry, so a
   consumer that missed the frame still finds it terminal in `/api/sessions`.
   The exception is worth saying out loud rather than papering over: a KILLED
   session is dropped synchronously, so that frame is everything the stream and
   the list will ever say — miss it and the session is merely absent next poll,
   with no code to be had. A database tier still files a history row; the file
   tier has no such surface, so don't lean on it. Tolerable only because a kill
   is something a client asked for.
6. **"Reconcile can't reach a stream" is true of one path, not of reconcile.**
   Boot records history directly for a session rebuilt by `adoptExited`, which
   is finished before the port binds. The `meta.killedAt` re-kill branch is the
   counterexample: it leaves its link OPEN by design, so its exit can land well
   after the port is up and does emit — for an id no client has ever listed.
   That frame is correct, not stray, and any similar claim here needs checking
   against that branch before it is written down.
7. `GET /api/sessions/{id}` was folded into this ticket and deliberately **not**
   built. The only reason anything polled it was to learn about exits, so the
   event retires the route with the loop; adding it would be a second surface
   answering a question that no longer needs asking. Note the stream carries no
   session-*start* either, and needn't: a consumer learns the id of the session
   it spawned from the 201, which is the wishlist's whole loop ("spawn an agent,
   wait for it to exit"). Watching for OTHER clients' spawns is still a poll —
   a different feature, and nobody has asked for it.

