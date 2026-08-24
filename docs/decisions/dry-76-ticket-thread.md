# The comment thread in the ticket panel (DRY-76)

The panel showed a description and nothing else, and the sharp version of the
problem is that **the agent already saw the thread and the human didn't**:
`server.ts` has called `tracker.getTicket(key, { thread: true })` for the
SessionStart brief since DRY-53, while the panel's own route called
`getTicket(key)` with no options. So you could spawn an agent from a panel
reading "do X" while the agent started from a brief whose newest comment said
"actually do Y".

The change is small — `?thread=true` on `/api/tracker/ticket/<KEY>`, and a
thread block in `TicketDetail.vue`. Everything below is what it costs, what it
had to be careful about, and what would silently undo it.

## The shape of the decision

1. **`?thread=true`, not always-on.** The route has two callers. The panel wants
   the thread; the workspace drawer (`WorkspacePane.vue`) renders the
   description alone and would otherwise pay Switchyard's ancestry walk — up to
   two extra GETs, because that endpoint hands back a bare parent UUID with
   `parent: null` beside it (DRY-53 trap 5) — on every drawer open, for data it
   throws away. Measured at the route: **1 upstream GET without the flag, 3
   with**, on both providers.

2. **On one request, not two.** The ticket left the door open to fetching the
   thread behind the description if the cost hurt. It doesn't, and the second
   request would cost more than it saved: on **Jira** the thread is a FIELD of
   the issue GET, so the common case is no extra request at all (a long thread
   adds one tail fetch, and the epic walk runs in parallel with it); on
   **Switchyard** the comments are inlined too, leaving only the bounded,
   deadline-capped walk. Fetching separately would have spent a whole extra
   ticket GET — the expensive part — to avoid the cheap part.

3. **Still uncached.** DRY-72 cached `/api/tracker/tickets` and deliberately
   left this route alone, because the brief needs a live thread. A panel opened
   to find out whether somebody corrected the ticket wants exactly the same
   thing, so nothing here caches either — and `ticket-thread.mts` asserts that
   two opens in a row both reach the tracker, so a future cache has to be a
   decision rather than a side effect.

## The traps

Numbered because each is a bug that either shipped or was one commit away.

1. **`commentCount` is not `comments.length`.** They differ exactly when the
   provider capped its fetch, which is the entire reason both fields exist.
   Jira pages `comment` oldest-first and the provider re-fetches from the tail,
   so a 63-comment thread arrives as its newest 20 — and a panel rendering 20
   cards under a bare "20 comments" tells the reader there is nothing after the
   last one they can see. The panel says "Showing the 20 most recent of 63
   comments, newest first." (Switchyard counts what it kept, so the two agree
   there; the divergent case is Jira's, and it is stubbed rather than hoped for.)

2. **Newest FIRST, against the order the data arrives in.** Providers hand the
   thread over oldest-first and the brief keeps that order, because an agent
   reads all of it. A human reads the top of a box. The comment that decides
   whether the description is still true is the LAST one, so in reading order,
   under a description long enough to need scrolling, it is the furthest thing
   from the eye — the panel would technically show the thread and still lose the
   correction. Reversed, labelled ("newest first" is on the count line), and the
   first card is badged.

3. **A comment carries its own markdown headings, pitched against the panel's
   own.** `## What the design adds` is a real comment on this project's own
   tickets; under the shared `.mdbody` scale that `h2` renders at 15px bold
   against the panel's 16px title — and an `h1` in a comment, at 16.9px with a
   rule under it, is simply larger than the title. Either way one comment
   restyles the panel around it and reads as a section OF the ticket rather
   than as somebody talking. (The numbers matter: 15px is the one a reader is
   most likely to check, and "bigger than the title" would not survive it.) The brief solves
   this with `<comment author= at=>` tags (DRY-53 trap 4); a rendered surface
   can't use a delimiter, so `.mdbody.comment-body` collapses every heading
   level to the body's own size and drops `h1`'s rule and `hr`'s prominence. The
   byline stays the most senior thing in the block.

   **Those rules live in `shell/src/style.css`, not in the component.** Vue's
   scoped CSS never reaches `v-html` content — which is why `.mdbody` itself is
   global. A "tidy-up" that moves them into `TicketDetail.vue`'s `<style
   scoped>` compiles, renders, and silently restores the bug.

4. **Three different facts must not render as one sentence.** "Nobody has
   commented", "there are 63 and none of them arrived", and "the tracker never
   answered that question" are distinct, and only the first is calm. Rendered
   identically the last two read as the first — DRY-55's failure on a second
   surface — so the panel has four states (`silent` / `empty` / `lost` /
   `shown`), names each, and warns in amber on two. The daemon's brief makes the
   same distinction in `windowLine` (`tracker/context.ts`); this is the rendered
   half of it.

5. **Tombstones are the provider's problem, and stay that way.** Switchyard
   ships deleted comments with the body redacted; `toComments` drops them
   *before* counting, so "showing 2 of 4" against a two-comment thread can't
   arise. The panel resurrects nothing because it never receives them —
   asserted at the route, not assumed.

6. **A bare timestamp is not a local timestamp.** `new Date("2026-07-28
   17:12:35")` is read as the BROWSER's local time, so formatting a zone-less
   stamp as local silently moves the comment by the viewer's offset — the same
   trap `tracker/context.ts` documents on the daemon side, where it moved a
   comment five hours. `whenText` renders a zone-less stamp verbatim and keeps
   the provider's raw string in the `title` either way.

7. **The panel is DRY-74's fixed-height float, and a thread is the largest
   thing ever put in it.** The block goes inside `.desc` — the only region that
   ticket allows to give way, since everything else is a control at its natural
   size and flex would otherwise crush the prompt textarea before the panel
   scrolled. Forty comments scroll inside the description box; **Spawn Agent**
   stays pinned. Asserted on all four edges plus the viewport, because DRY-74's
   symptom was a button that had left a panel which itself looked fine.

8. **Switching tickets mid-fetch repaints the panel from the request that
   loses.** Older than this ticket — the panel is reused between tickets and its
   fetch never checked that the answer belonged to the ticket still on screen —
   but DRY-76 both widens the window (a Switchyard open is 3 upstream GETs where
   it was 1, with the walk's own 6s budget on top) and changes what a stale
   reply paints: not an out-of-date description under the right title, but a
   comment THREAD under the wrong ticket, on the one surface whose whole job is
   telling you whether what you are reading is still current. Guarded by
   comparing `props.ticket` after the await, in the catch and in the `finally` —
   the last one because a superseded reply clearing `loading` leaves a ticket
   that is still fetching looking loaded.

9. **The comment that justified the old behaviour outlived it.** The route's own
   comment said the panel "renders none of it", `tracker/types.ts` said only the
   brief reads it, and `shell/src/lib/tracker.ts` said the route "does not
   populate these" — three claims, all true when written, all false the moment
   the argument was passed. CLAUDE.md's recurring trap 7, and worth noting that
   the shell's copy was accurate enough to name the fix.

## Verifying it

`scripts/verify/ticket-thread.mts` (route, both providers, its own stub tracker
and its own daemons — no browser, ~15s) and `scripts/verify/ticket-panel.mts`
(the panel, a browser, ~1 minute). Rig and discrimination counts are in
[scripts/verify/README.md](../../scripts/verify/README.md#the-ticket-panels-comment-thread-dry-76);
they fail 21 of 37 and 31 of 40 respectively against the unpatched tree, and the
race in trap 8 has its own narrower recipe there (2 of 40).

The one thing neither can catch on its own is the reason there are two: a route
that hands the thread over proves nothing about a panel that stopped asking for
it, and a panel rendering a thread it was handed proves nothing about the
daemon. `ticket-panel.mts` asserts the request URL carried `thread=true`, which
is the seam between them.
