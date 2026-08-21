# Expanding an epic to its children (DRY-83)

The sidebar's pull excludes the backlog bucket (DRY-30) and exempts only the
**epics** in it (DRY-13), not their children. So an epic whose work hasn't
started arrives as a heading with nothing under it: the row went inert, tooltip
"no children to expand here", and the only way to reach the work was the backlog
toggle — which changes the pull for the whole sidebar, ~29 tickets to 250+, to
see inside one epic.

Expanding now issues its own query: `TicketQuery.parent` (a ticket KEY),
`/api/tracker/tickets?parent=KEY`, fetched once per epic on an explicit expand.

1. **Fetched children go THROUGH `groupTickets`, not around it.** They are
   merged into an `augmented` list that everything downstream reads instead of
   `props.tickets`. Splicing them in inside `rowsOf` — downstream of the
   grouping — cost two bugs with one cause, because anything bypassing the
   grouping bypasses every rule it enforces: a filter term matching only a
   fetched child DELETED it (the epic had no surviving row in the filtered set,
   so the node was dropped with the child inside it), and a child whose repo
   differs from its epic's rendered under the wrong repo heading, twice, instead
   of staying in its own group with a parent chip. `repo` is what resolves to a
   working directory, so that second one spawns an agent in the wrong checkout.
2. **The trigger is `toggleEpic`, never the render path.** A filter force-opens
   every epic (`isEpicOpen`), so a fetch driven off "is it open" fires one
   request per epic on every keystroke in the search box — DRY-72's per-poll
   fan-out, back one gesture at a time. `epicOpenCount` exists so the augmented
   list can be keyed by epic KEY without splitting `epicNodeId`'s composite id,
   and so `openEpicKeys` doesn't have to read `groups` — which is built from
   the augmented list, and would close the loop.
3. **Ask for OPEN children, not all of them.** It keeps the query bounded by
   live work rather than by years of closed tickets — the thing that makes the
   child-stats query cappable — and makes the row count equal the rollup's
   non-done segments, so the bar and the list can be checked against each other.
4. **Expandable and fetchable are different questions.** Expandable is "is there
   anything to show"; fetchable is "is there anything to go and GET", i.e.
   `childStats.total - done > node.children.length`. An epic whose open children
   are all in the pull is expandable and needs no request — firing one anyway is
   a tracker query per epic per click that can only return rows already on
   screen. Both derive from `childStats` and only when it's authoritative: the
   fallback rollup counts loaded children, so it would say nothing new.
5. **A re-pull must KEEP the rows it has.** Refresh forces past the cache
   (DRY-72 trap 3 — otherwise the one button somebody presses when they've
   stopped trusting the screen is answered from the memory that made it stale),
   and a forced pull waits. The fallback while it's in flight is the pull's own
   children, which for this epic is the empty set that made it inert — so
   dropping first empties the epic for a round trip and fills it again. The
   corollary is that "already loaded" cannot be the only guard on re-entry: kept
   rows must not make the error note's retry a dead control, and a force must
   not be swallowed by an in-flight ordinary pull, which is trap 3 inverted.
   Hence the error and force exemptions plus a per-key epoch.
6. **A fetch that succeeds with zero rows still needs a note.** `childStats` is
   on a 5-minute TTL, so it can promise children that have since closed; without
   one, that renders as an epic opening onto nothing — the exact state this
   ticket exists to remove, and indistinguishable from a broken fetch.
7. **`stale` has to ride this response too** (DRY-72 trap 2). The daemon answers
   from last-good during a tracker outage, so a fetch that "succeeded" says
   nothing about whether the rows are current, and the header's stale marker is
   about the LIST. Dropping the field makes an expansion — and a Refresh —
   during an outage look like a clean success.
8. **The daemon must not project-scope a parent query, or fan it out per
   project.** Switchyard's `listTickets` fans out one call per key in scope, so
   a parent query that reached it would issue the same query N times and
   concatenate the same rows; and scoping can only wrongly hide a child that
   lives in another project. Handled before both. Pass the query through whole
   otherwise — rebuilding it dropped `text`, which Jira honours, so one
   `TicketQuery` returned different sets per provider and the cache kept two
   entries for it.
9. **Switchyard costs an extra hop.** Its list filter is `parent_id`, a UUID,
   and the shell only ever has keys, so the provider resolves one first. Jira
   takes the key in JQL directly — and `parent` is unsupported on older DC,
   where `attachChildStats` swallows it; here it must NOT, or the expansion
   presents as an epic that opens onto nothing. Jira also has to SKIP the
   child-stats pass on a parent query: `parent` matches subtasks too, so a
   nested hierarchy would pay a second `parent in (…)` search per expansion for
   a rollup no child row draws.
10. **The header count reads the augmented set, both halves.** Against the pull
   it reads "0/5" while a fetched child sits on screen matching the filter — a
   header contradicting the rows beneath it. So expanding moves it, on purpose;
   the control that must not move is the backlog toggle, which is what widens
   the pull, and that is what to assert on.

Known limit, accepted rather than missed: an epic with more than `MAX_TICKETS`
OPEN children renders a truncated list, warned about in the daemon's log only.
Unlike a capped child-STATS count — which is abandoned, because a partial total
wearing an authoritative badge is a wrong number presented as a right one — a
partial list is still a usable list, and reaching 2000 open children under one
epic is not a shape worth threading a flag through the cache for.

Harness: `scripts/verify/epic-children.mts`, rig in its README — it needs
`STUB_DORMANT_EPIC=1`, which is off by default because every epic in the stub
costs another child-stats request and `tracker-cache.mts` asserts on those
counts exactly. Confirm it discriminates: against the unpatched shell it fails
10 of 21, including the row's real tooltip and the filter deleting the rows it
matched. Note the anti-fan-out section shipped VACUOUS in review: it typed a
term matching only the fetched children, which emptied the sidebar of epic rows
— and nothing can fan out from rows that aren't rendered, so it passed against
a fan-out and against the bug that deleted those rows. Any check on this surface
has to keep epic rows on screen to mean anything.

