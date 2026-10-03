# A window's bar says what it is with a shape, not a word (DRY-102)

Every window's bar opened with a kind word — `shell`, `workspace`, `claude-code`
— ahead of the ticket badge and `~/repo`. It repeated on every tile and told two
windows apart far less often than the two things beside it. The word is gone
from the bar. The status dot carries the kind instead: **a plain shell is a
square, anything with an agent in it is a circle.**

1. **Shape, because colour was taken.** The dot's colour, glow and pulse already
   mean status and attention, and they are unchanged. Shape was the free
   channel. The rule keys off `Win.type` (`"bash"` → square), not `Win.kind`, so
   a **workspace is a circle**: it is an agent window that happens to carry a
   zsh, and its zsh's own dot — the small one on the inner shell head in
   `WorkspacePane.vue` — is the square.
2. **`win.title` left the bar, not the model.** It is still what the rail prints
   for a window with no ticket (`RunRail.vue`: the gate label, the card label,
   the docked chip), so deleting the field would have blanked a docked shell.
   It is also now the dot's `title` attribute, which keeps the word one hover
   away and gives `desk-restore.mts` S4 something to read: DRY-101's "a rebuilt
   workspace is titled as the spawned one" is still a real invariant — the
   tooltip and the docked label flip with whoever saved last if it breaks — and
   a check that reads a `.title` element that no longer exists would have passed
   on `"" === ""` had the other half of that assertion not pinned
   the literal.
3. **With no ticket the repo is the only text in the bar**, so `.repo.lead` gives
   it the weight the word had rather than leaving a bar that reads as empty.
   With a ticket, the badge leads and the repo stays the footnote it was.
4. **An autonomous run's window used to print its ticket key twice** — once as
   the title (`spawnAutonomous` titles the session with the key) and once as the
   badge. That went away as a side effect; nothing was changed there.
5. **The docked chip follows the same rule** (`RunRail.vue`), so a window keeps
   its shape when it is lowered into the rail. Rail *cards* are autonomous runs,
   which are always agents, so they have no square to draw.

Verified by `scripts/verify/window-bar.mts` (all three layouts plus the docked
chip), and by re-running `desk-restore.mts` after moving its title read to the
tooltip.
