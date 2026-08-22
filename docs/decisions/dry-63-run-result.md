# The run's own output over HTTP (DRY-63)

`GET /api/sessions/{id}/transcript` hands back what a session printed, ANSI
stripped, tail-capped at 1 MiB.

```sh
curl -s localhost:4399/api/sessions/$id/transcript | jq -r .text |
  grep '"type":"result"' | jq '{cost: .total_cost_usd, turns: .num_turns, usage}'
# → {"cost":0.089832,"turns":1,"usage":{…}}
```

It exists for one payload. Claude Code's print mode ends a run with a
`{"type":"result",...}` event carrying `total_cost_usd`, `num_turns` and
`usage`, and writes it to **stdout only** — so it lands in the PTY, in our
scrollback, and in no file anybody keeps. Drydock holds the only copy.

The ticket that asked for this asked for something else, and the correction is
the interesting part, so it is recorded here rather than lost with the ticket.

## What was checked before anything was written

The upstream request said per-agent tokens and cost are unreachable to a
headless consumer. Half of that is wrong: Claude Code writes a JSONL transcript
per session under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<escaped-cwd>/`, and
every assistant record in it carries `message.usage` — input, output, both cache
counters, the ephemeral 5m/1h split, `service_tier`. Turns are derivable by
counting. A consumer on this host can read all of it today, in more detail than
the result event gives, and DRY-62's `transcripts.ts` already indexes those
files by agent session id.

What is genuinely absent is the result event, and that was **measured on the
mode that matters** rather than inferred. The ticket flagged its own evidence as
weak: the host's 109,496 records were 99.9% `entrypoint: cli` (interactive), and
"print mode doesn't persist a result record either" was a guess from a biased
sample. So:

Measured twice on v2.1.240 — standalone, and again on a run spawned through a
throwaway daemon so the whole chain was under test. Both runs, both streams:

| | result records | `total_cost_usd` | records persisted |
|---|---|---|---|
| run 1 (standalone) — **stdout** | 1 | 1 | — |
| run 1 — its persisted JSONL (`entrypoint: sdk-cli`) | 0 | 0 | 10 |
| run 2 (spawned through the daemon) — **stdout** | 1 | 1 | — |
| run 2 — its persisted JSONL (`entrypoint: sdk-cli`) | 0 | 0 | 11 |

The two record counts are two runs, not a contradiction — worth spelling out
because the first draft of this doc and the route's comment quoted one each
while both said "the same run", which review caught. The counts are context;
the zeros are the claim. The ticket said "if print
mode does write a result record, this ticket is empty and should be closed". It
does not. (A first pass appeared to find `total_cost_usd` in a transcript; it
was the draft of the ticket itself, echoed back into the session log. Anyone
re-checking this will hit that same false positive.)

## The traps

1. **The argument for a route is *transience*, not unreachability.** The bytes
   ARE on disk: the supervisor flushes its ring to
   `<sessions dir>/<id>.scrollback`. But `forget()` unlinks it as soon as the
   daemon has the session in memory (`sessions-dir.ts`), which in the normal
   case — daemon up, adopts immediately — is a window of milliseconds. Reading
   it means racing our own cleanup for an undocumented private format in a
   `0700` directory. "Unreachable" was the wishlist's word and it was wrong; the
   consumer is a process on this host and always could read *something*. It just
   could never rely on it. Keep the smaller claim — it is the true one, and it
   is still sufficient.
2. **What bounds the answer is the session registry, not the ring.** A session
   stays readable until the DRY-60 sweep clears it (five minutes past its ending
   by default), and `/kill` drops it synchronously. So the read belongs on the
   `session-exit` frame (DRY-64), not on a poll. Same reasoning that put
   `endReason` on that frame: the thing you want is gone before the next poll.
3. **`sessionFor(..., "see")`, not `"own"`** — deliberately looser than the
   `/file` route directly above it, which is the surprising direction. `/file`
   resolves an arbitrary relative path under the worktree and reads it: the
   agent need never have opened that file, so on a public run "own" is what
   keeps someone else's `.md` out of a spectator's hands. This route hands back
   what the session *printed at the screen*, which the WebSocket already replays
   in full to every viewer `visibleTo` admits — the same call, decided at the
   upgrade. Minus the escape codes, it is strictly less than a spectator already
   has. Same shape as DRY-64 trap 3.
4. **Strip the ANSI, or the payload does not parse.** The result event is one
   ~420-byte line; the PTY is 80 columns; a TUI wraps colour and cursor moves
   around everything it prints. `transcript()`'s `stripAnsi` is what makes the
   line `JSON.parse`-able at the other end, and the CR→LF fold it also does is
   harmless because a carriage return inside JSON content arrives escaped as
   `\r`. Verified by parsing, not by grepping for `total_cost_usd` — a wrapped
   or escape-poisoned record still contains that string.
5. **Truncate the HEAD, and say so.** `/file` answers 413 over its cap because
   its caller can go read the file another way. Nobody can read this another
   way, so a 413 would refuse exactly the long runs the route exists for. The
   tail is also the half worth keeping: the result event is emitted when a run
   *ends*, which makes it the payload most likely to survive both this cap and
   the ring above it. `truncated: true` rides along, and `bytes` describes what
   was returned rather than what was captured.
6. **Cut on a line boundary — but bound how far you look for one.** An
   arbitrary byte offset lands inside a UTF-8 sequence (cosmetic) and inside a
   JSON object (not cosmetic — it parses as nothing while still looking like a
   record), and `\n` cannot occur inside a multi-byte character, so a newline
   search settles both. Searching *unboundedly* then breaks the route on the
   one input it most obviously has to survive: output that is a single long
   line — `--output-format json` emits one object for the whole session — keeps
   its only newline at the very end, so the snap skips forward over everything
   the cap just decided to keep. **Measured: a 2.6 MB single-line run returned
   1 byte.** `LINE_SNAP_BYTES` (64 KiB) bounds it; past the window there is no
   whole line to be had at any price, and half a line of real bytes beats none.
   The fallback then steps off UTF-8 continuation bytes, because that case gets
   no line boundary and the comment above it would otherwise be true only of
   the common path.

   Found by re-reading the code after it was green — the first version's
   comment claimed a newline search "settles both", which was true of every
   input the harness had and false of the one it didn't. CLAUDE.md trap 7, on
   a comment I had written myself an hour earlier.
7. **`truncated` cannot answer "did I get the whole run", so something else
   has to.** This is the one way a route built for machines could actively
   mislead one, and it shipped in the first draft: `truncated` reports that the
   *response* hit the 1 MiB HTTP cap, and at default config
   `DRYDOCK_SCROLLBACK_BYTES` is the same 1 MiB and the ring trims to at or
   below it — `stripAnsi` then shrinks the buffer further. So on an ordinary
   daemon `full.byteLength > READ_CAP_BYTES` is false however much a run
   printed, and an agent that emitted 8 MiB gets `200`, `truncated: false`,
   `bytes: ~600000`, and no way to tell that 7.4 MiB is gone — `bytes` is
   comfortably under the cap, so the loss cannot be inferred from a short
   payload either. The comment beside the field said it was what reported
   dropped bytes. It was the opposite.

   Fixed by `complete`, computed from `PtySession.everythingSeen`: `true` is a
   guarantee that every byte the session printed is in `text`, `false` means
   something is or may be missing. One-directional and deliberately pessimistic
   — a session adopted a minute after it started lost nothing and still answers
   `false`, which is the safe direction for a completeness claim.

   The four places it goes false are the four places output leaves this daemon's
   sight: the ring dropping a chunk, and the three paths that install a buffer
   somebody else was keeping — `adopt`, `adoptExited`, and a link reattach. The
   last three are why `complete` is a "cannot promise" rather than a measurement:
   whether a supervisor's own ring had trimmed before this daemon attached is
   not knowable from here. It would take a `SessionMeta` field, and that means
   bumping `PROTOCOL_VERSION` — which strands every live session on the host
   (CLAUDE.md) to add a hint. Not worth it; saying so is.

8. **The cap is NOT `DRYDOCK_SCROLLBACK_BYTES`.** They default to the same
   1 MiB, which makes tying them together look free. Raising the ring is a
   decision about how much history a reattach gets; it must not silently become
   a decision about how large an HTTP response may be. This also has a testing
   consequence: at the default ring the truncation branch is **unreachable**,
   because the ring trims before the route ever sees a megabyte. The harness's
   rig raises the ring to 4 MiB for that reason, and *fails* rather than passes
   if it finds an untruncated response (CLAUDE.md trap 1).

## Folded in: `/file` serves the run's own handoff

`runs.ts` writes the handoff under `CONFIG.autonomous.runsRoot` and the daemon
advertises the absolute path as `SessionInfo.handoff` — but `/file` resolved
everything against `realpath(session.cwd)` and 403'd anything outside it. The
API published a link and refused every client that followed it.

`/file` now also serves a path **exactly equal** to that session's own `handoff`
value. The equality is the whole safety argument: the only string that gets
through is one the daemon itself produced and handed to this caller, so there is
no arithmetic to abuse — no join, no realpath, no prefix test a symlink could be
pointed through. The cost is that a client must send back what the API gave it
verbatim; one that normalises or expands the path first falls through to the
cwd-confined arm and gets its 403.

9. **A negative probe against a file that does not exist proves nothing.**
   `/file` cannot distinguish a traversal attempt from a missing file — realpath
   fails on both, and the catch answers 404 for both, deliberately. So "another
   `.md` in runsRoot is refused" is only a claim if that `.md` is really on
   disk. Found the hard way: the probe passed while pointed at a decoy left over
   from hand-testing, and went 404 — not 403 — the moment the rig was cleaned.
   The harness writes its own decoy now.
10. **Pick a session cwd that is not an ancestor of `runsRoot`.** The first run
   of these probes used `cwd: /tmp` with `DRYDOCK_RUNS_ROOT=/tmp/dry63-runs`,
   and "a different session's handoff is refused" came back 200 — correctly, by
   the ordinary confinement rule, because the file was under the cwd. Nothing
   about the new arm was being tested at all. The harness checks the two paths
   itself and **skips** rather than passing.

## Not built, and why

- **`?since=`.** An incremental read against a ~1 MiB ring is a promise that
  cannot be kept: the bytes an offset refers to may have been trimmed before the
  next call. The result event is the payload that survives a ring, which is what
  makes the whole-transcript read enough.
- **A second persisted transcript.** Claude Code already writes one, and it
  holds the token detail. Duplicating it to add one record would be the
  expensive way to get the cheap half.
- **A cost figure on the rail card.** Worth doing — it is a Drydock feature and
  it needs exactly these bytes — but it is a shell change, and this ticket is
  the daemon half that has to exist first.

## Verifying it

`scripts/verify/run-result.mts` — a throwaway daemon, no browser, about a
minute, and it needs TWO daemons — the ring has to sit on both sides of the
route's cap and no one daemon can. Thirty checks; its header carries the rig and
the discrimination run. **Against `main`'s `server.ts` 24 of the 30 fail**, and
the six that pass are the ones answered by code this ticket did not touch. Three more used to
join them: they were satisfied by an *empty* response and passed against the
bug until the `text.length` guards went in.

Sections 2b and 5 are the ones to keep if any of it is ever trimmed. They are
the two that caught shipped bugs rather than confirming decisions, and both
discriminate down to a single line: 2b reports `1 byte` where a megabyte was
asked for against the unbounded snap, and 5 turns red — alone, with section 2's
version of the same claim still green — when the one statement recording a ring
drop is removed from `session.ts`.
