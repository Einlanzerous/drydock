# A reloaded desk comes back as it was left (DRY-101)

Four windows became thirteen. The daemon and every agent were fine — the desk was
being restored wrongly, and all three of the ticket's symptoms had one cause: **the
saved desk is shared, and every browser that has it open saves its own view of it
back.** There is no merge. Whoever wrote last wins, and a device that has been
sitting in a drawer for a week still holds — and, the moment anything on it is
clicked, writes — the desk as it was a week ago.

| what came back | why |
|---|---|
| five `stopped by request` cards, closed 3–7 days earlier | the closing tab drops its window in the same tick as the kill and never draws a card. **Every other tab** still holds the window, finds its session gone, draws the DRY-56 card, and saves the window back into the shared desk |
| each workspace's zsh, in a window of its own | the only record of which zsh belonged to which agent was the workspace's window entry in that same desk. A browser that had never heard of the workspace saved the agent as a bare terminal and the zsh as a window, over the entry that knew |
| stacked prompts, split lines, a stray `%` | not the shells only: any pane restored into a window of a different width than its PTY last drew at (see [render](#the-replay-is-written-at-the-width-it-was-drawn-at)) |

Reproduced before anything was changed, on both tiers (see the rig below): the
closed window came back as a card on the second device, was written into the
shared desk (3 windows saved for 2 open), and *both* devices then reloaded with it.

## What changed

| | |
|---|---|
| `daemon/src/protocol.ts` (+ shell copy) | `SessionInfo.companionOf`; `replay` carries `cols`/`rows` |
| `daemon/src/supervisor/wire.ts`, `session.ts` | `companionOf` in the index, so it survives a daemon restart with the rest of `SessionMeta` |
| `daemon/src/server.ts` | the spawn route keeps `companionOf` only when it names a session the caller owns; `/kill` records the dismissal |
| `daemon/src/state/migrations/004_session_dismissed.sql`, `postgres.ts`, `history.ts` | `pty_sessions.dismissed_at`, `SessionHistory.dismiss` |
| `shell/src/lib/daemon.ts` | `closedOnPurpose`, `SessionRecord.dismissedAt`, `createSession({ companionOf })` |
| `shell/src/App.vue` | `workspacePairs`, `closedIds`, `dismissTombstone`, the reconcile changes |
| `shell/src/composables/useWindowManager.ts` | `promoteToWorkspace` |
| `shell/src/components/TerminalPane.vue` | replay at the recorded size, and the guard that keeps a fit out of it |

## The traps

1. **A card is drawn for a session that died with nobody looking, and "closed on
   purpose" is two different facts.** `end_reason = stopped` is a live session that
   was killed. It says nothing about one that had *already* ended and was then
   cleared: its row still reads `finished` or `failed`, exactly as it does for a run
   that died unattended — and that is the case the rail's dismiss, the sweep and the
   ✕ on an exited window all produce. So the daemon now records the request itself
   (`dismissed_at`), and `closedOnPurpose` is `stopped || dismissedAt`. Neither
   alone: old rows carry the first and not the second. `exitCode` is not an input —
   129/137/143 is DRY-49's trap 2 in a third surface.
2. **`/kill` is idempotent and answers 200 for a session it has forgotten, and that
   is precisely how a dismissed *card* arrives.** The PTY is long gone; the shell is
   asking to be rid of the card. The route stamps the history row for that case
   too, owner-scoped (`id::text = $1 and owner_id = $2`) so an id that is not the
   caller's marks nothing — and cast on the column, because a non-uuid path segment
   would otherwise be a 22P02 and turn a kill into a 500.
3. **A card that is already on screen used to be the end of the conversation with
   the daemon.** Reconcile drew it once and never asked again, so a Dismiss on
   another device never reached this one. It now re-checks history while any card
   is on the desk — *not forced*, so the 15s floor still stops one card costing a
   round trip per poll. The price is that a dismissal can take up to that long to
   arrive, which the harness budgets for (`CARD_RECHECK_MS`).
4. **The rule must not swallow real cards.** Everything above passes for a fix that
   drops *every* window whose session has gone. S2's control puts a session that
   died on its own and was forgotten (`failed`, not dismissed) on the desk and
   requires its card. Nothing over HTTP can produce that state — a daemon has to
   restart to forget an exited session — so it is one `UPDATE` through
   `docker exec psql`, labelled in the harness as modelling a state rather than
   bypassing a path.
5. **The pairing belongs to the daemon, not to a window entry.** `companionOf` is
   set on the *shell*; a client claims a zsh whose agent is listed
   (`workspacePairs`). Three details each avoid a bug:
   - **Only while the agent is listed.** With the agent gone there is no window for
     the zsh to live in, and hiding a live PTY behind a window that cannot exist is
     the orphan DRY-51 spent a review removing. It falls back to being an ordinary
     shell.
   - **First shell wins.** Two claiming one agent cannot both vanish into a window
     that has a single lower pane.
   - **Dropped, not refused, when it names something the caller doesn't own.** The
     field's only effect is to stop desks giving the session a window. Accepting an
     arbitrary id would let a spawn hide behind somebody else's; failing the spawn
     over a layout hint would cost a live PTY for a cosmetic. The route drops it
     silently — the second `curl` in the manual check below.
6. **Claiming the zsh obliges reconcile to build the window that shows it.** A bare
   terminal for the agent would leave the zsh claimed and invisible. So an agent
   with a pair is added as a workspace, with `spawnWorkspace`'s own numbers
   (`workspaceWindow` — one definition, so a rebuilt workspace and a spawned one are
   the same window), and an existing bare-terminal window for it is **promoted in
   place** — the repair for a desk an old browser already split.
7. **The repair must not be `updateWin`.** That latches `arranged`, the flag DRY-58
   reads as *a human shaped this desk*, and DRY-93 already had to remove three calls
   for latching it from a spawn. Nobody arranged anything; a reconcile noticed a
   fact. `promoteToWorkspace` sets only the workspace fields and leaves geometry
   alone (S5 asserts the window stays where it was and at its size).
8. **`companionOf` is not a `PROTOCOL_VERSION` bump, and the reason is the one
   `owner` and `visibility` already give.** An absent value has exactly one honest
   reading. Bumping would strand every live agent on the host to add a hint. It also
   means **a session spawned before this change has no pairing on record, and
   nothing here can heal it** — its only memory is the window entry. The shells a
   desk already has stray windows for stay windows until closed by hand.
9. **The harness's second device has to WRITE.** A stale device that never saves is
   harmless, and a version of S1 that only watched it passed against the bug. The
   write is provoked with the one gesture that always causes it — a click on a
   window (`bringFront` → z changes → the deep watcher pushes the whole desk).

## The replay is written at the width it was drawn at

A pane replays the PTY's raw byte history into an xterm that `onopen` had already
fitted to the pane. Those bytes are cursor movements as much as text: a prompt that
redraws itself with "up two lines, clear, rewrite" means the numbers for the width it
ran at. Written into a terminal of another width they land on the wrong rows —
which is the ticket's stacked powerline prompts, the truncated `✓ at 1`, and (for an
Ink TUI) a stray `● main` under the input box.

**It did not resolve on its own once the zsh windows were fixed**, which the ticket
half-expected: fixing the pairing restores each window at its own recorded
geometry, but any restore into a window of a different width (Tile derives its
cells from the browser window, which after a reboot may not be the size it was)
draws the same damage. Measured with a fresh zsh per (recorded → restored) pair, dirt
being stray `%` lines, prompt lines twice running and a right-hand segment glued to
a command, counted **on top of what the live pane already showed** — the shell's
first prompt is drawn before the pane has resized the PTY from its 80×24 default and
redrawn after, so some of it is zsh's and is on screen before anything is replayed:

| recorded → restored | before | after |
|---|---|---|
| 632 → 632 | 0 | 0 |
| 632 → 420 | 4 | 0 |
| 632 → 1000 | 0 | 0 |
| 1000 → 632 | 6 | 0 |
| 420 → 632 | 0 | 1 |
| 1000 → 420 | 5 | 0 |

The daemon now says what size the bytes were drawn at, on the same frame, and the
pane replays at that size and *then* fits — which is what resizing a live terminal
is, and what an application already knows how to answer. (The "after" column was
measured before trap 1 below existed; that guard removes an intermittent way of
getting the "before" column back, and is why the harness is run in full, not just
alone.)

1. **A fit between the resize and the parse undoes it.** `write` is asynchronous;
   the bytes are parsed on a later task. The mount-time frame callback, a
   ResizeObserver or a layout change can `fit()` the terminal back to the pane in
   that gap, and the replay is then drawn at the new width after all — the old
   behaviour, intermittently. It failed the harness's render check in both full runs
   on the database tier and in none of the four run alone, which is what made it
   look like noise. `replaying` (a counter, so a reconnect's second replay cannot
   release it early) holds every other fit off; the write's own callback fits once.
2. **An empty replay still has to release it.** A session that has printed nothing
   replays `""`; had xterm not called back for it, the pane would sit at the recorded
   size for good and no window count would notice. S7 asserts a 1000px window's pane
   is ~976px, not the 608px of 80 columns.
3. **A right-hand segment wrapping onto its own line is reflow, not dirt.** A first
   cut of the metric counted it and scored a shrink that was rendering correctly as
   five artifacts, which made the fix look like it did nothing for the narrow case.
   The metric also has to be a *difference*: the same probe measured against the raw
   screen reported two units of dirt for an identical-width reload, all of it the
   live pane's own.
4. **Not fixed, deliberately: a history that spans several widths.** The ring is a
   byte log with no record of when the size changed, so a session that was resized
   several times replays its tail exactly and its older lines approximately. Exact
   would mean resize markers in the supervisor's ring — a change to the durable
   process DRY-57 exists to leave alone — or `windowOptions.setWinSizeChars`, which
   lets any program on the PTY resize the pane. The `420 → 632` row above is the one
   pair that got worse (by one).

## Not fixed: last write still wins

The rules above make the shared desk *converge* — every device that sees the daemon's
record drops the window, claims the zsh, or repairs the pair, and the desk it then
writes is right. They do not make concurrent writes merge. A stale device that
saves still carries **its** view of layout mode and of the geometry and pane state of
windows it did not create, and that view wins until somebody rearranges. Closing a
window does not count as arranging (`arranged` is deliberately human-shaped-only), so
DRY-58's heal after an outage that began before the first read will still let the
daemon's copy put a closed window back on screen; the drop rule above is what then
removes it. A real fix is a compare-and-swap on `updatedAt` with a set-level merge on
conflict, and is its own ticket.

## Verifying

Runs against **either tier and should be run on both.** Only the database tier can
fail S1–S3 — the file store keeps no history, so it has no card to resurrect and
simply drops the window — and the harness says so. Rig, the ports, and the
discrimination recipe are in
[scripts/verify/README.md](../../scripts/verify/README.md#reloading-the-desk-dry-101).

Against the pre-fix tree it fails **13 of 37** on the file tier and **26 of 46** on
the database tier; against this tree, 0 of 37 and 0 of 46. S6 — count,
layout mode and geometry surviving a plain reload on one device — passes both ways:
it is a guard on what must not regress, not evidence of the fix.

Also run, as regression checks for the paths this touched, and all green: `sweep.mts`
(DRY-60) on both tiers, `spawn-layout.mts` (DRY-93, 80 of 80) and `tombstone.mts`
(DRY-62). **`tombstone.mts` had to change**: it made its card by `/kill`ing a
session, and a kill is now — by design — the one thing that no longer leaves a card.
Anything else that asserts a `stopped` card exists must learn the same.

**`sweep.mts` no longer guards the client-side removal, and this was found by
mutation rather than by reading** (the PR review caught the stale sentence; the
mutation showed how far it went). With `endWindow`'s `forgetWindow` deleted it fails 1
of 27 on the database tier and 0 of 27 on the file tier — the daemon now records a
kill, so a window left for reconcile is dropped a poll later instead of drawn as a
card, and that harness looks only after waiting out the sweep. S1 asserts the ✕'s
window is gone within 1.5s and fails against the same mutation; DRY-60's doc says so.

By hand, the two things a page cannot show:

```sh
# the pairing survives a daemon restart (DRY-57), and an unknown parent is dropped
curl -s -X POST :4401/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"shell","companionOf":"<an agent id>"}'       # → companionOf set
curl -s -X POST :4401/api/sessions -H 'Content-Type: application/json' \
  -d '{"command":"shell","companionOf":"00000000-0000-4000-8000-000000000000"}'  # → absent
# stop ONLY the daemon (SIGTERM detaches; supervisors stay), start it again:
curl -s :4401/api/sessions        # the zsh still says which agent it belongs to
```
