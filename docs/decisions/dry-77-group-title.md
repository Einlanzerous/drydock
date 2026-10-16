# DRY-77 — a filter holds every group open, and now the group says so

A filter force-opens both of the sidebar's collapse idioms, so matches can't hide
behind a chevron (`isOpen` and `isEpicOpen` in `TrackerSidebar.vue`). A click on
a header while a filter is active still writes its map (`expanded` /
`epicExpanded`), and the display ignores the map until the filter lifts. That is
deliberate and unchanged.

DRY-75 explained the deferred effect on the epic row's tooltip and gave the repo
group header no `title` at all. The group is the more prominent of the two and
the one people hit first, so it read as a header that ignores clicks. It now
carries the same sentence, built in the `rendered` computed beside its rows
rather than called from the template.

1. **Name the gesture, not the state.** A `title` is painted when the pointer
   arrives and doesn't repaint under a click, so "Collapse" would be wrong the
   moment it's acted on. Same rule as `epicRowTitle`.
2. **No inert branch.** `groupTickets` drops empty groups, so a rendered group
   always has rows. The epic row's inert case exists because an epic can match a
   filter with every child filtered out. Don't port that half.
3. **The copy follows `isOpen`, not the map.** The chevron reads open while
   filtering whatever the stored value, and the tooltip has to agree with what
   is on screen.

Not decided here: whether a click during a filter should record anything at all.
Making both idioms inert while filtering would mean lifting the filter restores
exactly the arrangement you had. That is a bigger call than a tooltip, and the
ticket asks that it be made once for both idioms.

Harness: `scripts/verify/group-title.mts` (README, "The group header's tooltip").
