# Verifying the tracker sidebar (DRY-55)

The quietest failure the desk has. `/api/tracker/tickets` 502s when the daemon
can't reach the tracker, `loadTickets` keeps the last-good list — right on a
refresh — but on a FIRST load there is no last-good list, so the sidebar used
to render its ordinary "No tickets match.", which is also exactly what a
healthy tracker with nothing in scope says. Harness:
`scripts/verify/sidebar.mts`, rig in its README.

1. **The two halves are separate tests.** An outage that starts before the
   first pull and one that starts after a good pull are different paths through
   the same `catch`, and only the first was ever silent. The second must KEEP
   its rows and merely mark them stale: replacing a working list with an error
   panel is a worse bug than the one being fixed, and a list that quietly stops
   updating is how somebody spawns an agent against a ticket that closed an
   hour ago.
2. **`.row` is not a DOM assertion you can use here.** Repo groups render
   collapsed, so a full sidebar and an empty one both report zero rows — a
   check built on it passes against the bug. Assert on `.grp` or the header
   count.
3. The line above the desk is DRY-58's notice, so its rules hold: raised once
   however many polls fail, cleared by whoever raised it, never dismissible.
   A tracker outage must NOT reach the red banner — that one belongs to the
   session poll, and the daemon is fine.

