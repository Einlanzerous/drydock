# A session's first output (DRY-79)

Everything a PTY printed between starting and its pane attaching used to be
lost — not in the pane, not in the daemon's scrollback, and so not in any later
reattach either. `PtySession.adopt` took the supervisor's buffered replay;
`PtySession.spawn` bound the link without reading it. The two paths had differed
since DRY-57, and `spawn` now seeds the same way.

The window is real and it is the daemon's, not the supervisor's. `pty.spawn`
runs before `listen()` in `supervisor/main.ts`, and the daemon then polls for
that socket every `SPAWN_POLL_MS` (25ms) before it can dial and send Attach.
Measured here: spawn→listen **1-2ms**, listen→attach **5-47ms**. So reordering
the supervisor to bind first — the obvious fix, and the one the ticket asked to
consider — would close about a twentieth of it. Left alone deliberately; the
daemon's poll is the term that dominates, and a socket bound before the PTY
exists gives `greet()` a `child` to report that isn't there yet.

1. **How much is in that window is not "a few frames".** A quiet session leaves
   11 bytes; five concurrent chatty spawns measured 57-193 KB each; a session
   printing 300 KB in a burst can finish entirely inside it, which presented as
   a pane that was empty and stayed empty. `session spawned` logs `replayBytes`
   now, so this is answerable from a log rather than by instrumenting.
2. **Take the replay, not the sizes.** `adopt` also takes `hello.cols`/`rows`
   because the last client negotiated them; at spawn the request's own
   dimensions are the newest thing anybody has said. Copying that half across is
   invisible today — the supervisor initialises its size from the meta the
   daemon just handed it, so the hello echoes the request back — which is
   exactly why it needs saying rather than testing.
3. **A 201 was never evidence, and neither is a busy session.** The route
   answered 201 and `/api/sessions` listed a healthy session throughout. A
   command that keeps printing also looks fine, because the socket catches it
   live; only output that STOPS distinguishes the two. That is why this survived
   DRY-57 to DRY-79 and why the DRY-27 harness note in
   [dry-27-auth-tiers.md](dry-27-auth-tiers.md) worked around it instead of
   reporting it.
4. **Seed the ring in `bind`, not in its callers.** The bug WAS a caller that
   forgot — `adopt` seeded, `spawn` didn't — so the fix that only adds the line
   back leaves the same hole open for a third construction path. `bind` is the
   one thing both do.
5. **A seeded buffer has to be CHUNKED before it enters the ring.** `onData`'s
   trim is whole-chunk and guarded by `scrollback.length > 1`, so a seed
   installed as one buffer survives until the first live byte pushes the ring
   over cap and then goes entirely, in a single `shift()`. Measured on a 200 KB
   ring seeded to ~199 KB and then sent 50 KB: **51,010 bytes retained as one
   buffer against 186,006 chunked**. It bites hardest on an adopt, and the
   pre-attach block is always the oldest chunk there is.
6. **`replayBytes` is the SEEDED count, not `scrollbackBytes`.** `bind` flushes
   the link's `pendingData` on its way past — output that shared a TCP segment
   with Ready — so reading the ring after it reports the window plus some live
   output, on the log line the sizing decision above is made from.
7. **The exit CODE goes missing in the same window, and costs more.** A session
   that ends before the daemon dials broadcast its Exit frame to an empty client
   set; the socket the daemon then dialled closes 250ms later with nothing left
   to say, and the daemon concluded `-1`. So a `printf` that exited 0 was a
   FAILED run: a failure card, DRY-49's handoff, a tracker comment saying nobody
   was watching, and `endReason: failed` on DRY-64's stream. `SupervisorLink`
   now reads the exit record the supervisor flushes BEFORE it broadcasts, and
   keeps `-1` only for a supervisor that left nothing behind. Same misreading as
   DRY-49's trap 2 and DRY-56's trap 3, reached from the other side.
8. **DRY-49's settle timer can't see seeded output either.** It is driven from
   `onData`, which a seed never passes through, so a CLI whose banner finished
   inside the window and then went quiet waits out the 15s ceiling instead of
   the 1.2s settle. `scheduleInitialInput` arms it off the ring — off a chunk in
   the ring that PAINTED, since DRY-88; the escape-only writes a CLI opens with
   are not a banner and must not start that clock.

Harness: `scripts/verify/spawn-replay.mts`, rig in its README — a throwaway
daemon, no browser, under a minute. Confirm it discriminates: against the
unpatched `spawn` it fails 7 or 8 of 17, the variance being whether the attach
lands inside the bulk case's burst or after it.

