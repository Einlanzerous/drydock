# Who types a spawned agent's first prompt (DRY-88)

The daemon, for every spawn path, since this ticket. Before it, only an
autonomous run's prompt went that way (DRY-49) and a supervised workspace's was
seeded into `TerminalPane`, which typed it **700ms after its socket opened** —
and that prompt never arrived. A ticket-driven workspace came up with an empty
composer and the instruction had to be retyped by hand.

Nothing about that was visible from the outside, which is why it survived so
long: the route answered 201, the pane sent its `{type:"input"}` frame, the
daemon delivered it to the PTY, and Claude Code discarded it — a CLI that has
not started reading stdin does not error, and there is no surface anywhere that
says a keystroke was dropped.

Measured against v2.1.238, from the pane's own attach:

| after attach | what the CLI does |
|---|---|
| 330-400ms | escape-only writes — save cursor, scroll region, bracketed paste, DA1 |
| ~1270ms | the banner: the first write with printable text in it |
| ~1400ms | input starts being accepted (1200ms was still discarded) |

So the pane's 700ms was never near enough, and the comment justifying it — that
the CLI had "been booting for a while" by the time a socket opened — was the
whole error. DRY-79 measured that gap at **5-47ms**: the pane attaches at
essentially t=0 of the process.

1. **A fixed delay cannot be the rule, in either direction.** Long enough for
   this host is a guess about the next one, and being late costs nothing on this
   path (the human is watching a composer fill in) while being early costs the
   whole feature. `scheduleInitialInput` waits for the CLI to PAINT, then for
   output to go quiet (1.2s), never sooner than a floor (2s past that first
   paint), capped at 15s for a CLI that never stops redrawing.
2. **"It printed something" is not "it painted something", and that distinction
   is the bug in miniature.** The four writes a CLI opens with are it
   *configuring* a terminal; arming the settle on those fires at ~1.6s, which is
   what DRY-49's rule was doing and why an autonomous run could lose its prompt
   too. `paintsSomething` strips escapes (CSI, OSC, the DCS family, and the
   two-character forms) and asks whether anything is left. Note the two-character
   rule has to be a RANGE: spelled as a hand-listed set it misses `ESC 7`, which
   is the first thing Claude Code writes, and the stray `7` reads as a paint.
   **It can still be fooled, by design rather than by oversight**: a chunk
   boundary through an escape leaves printable residue behind it, so a stream
   cut badly enough arms the clock at the CLI's first write. That is what the
   floor is sized for — 2000ms measured from a paint that early still clears the
   1400ms the CLI needs — so this predicate is allowed to be approximate and the
   floor is not.
3. **The RETURN is the only difference between the two paths, and it hangs off
   `autonomous`.** A supervised spawn pre-fills and stops; the reason is in
   `flushInitialInput` and it is not "the shell asked for it" — it is that
   somebody is sitting there who may want to edit the prompt first. Test the
   PAIR: delete the submit outright and the supervised half still passes while
   every unattended run sits at a full composer nobody sends.
4. **The prompt must not live in the browser at all.** That was the second half
   of this ticket's report — `initialInputById`, `initial-sent` and `sentInitial`
   are all gone, along with the races they were exposed to: `forgetWindow`
   deleting the seed for a window reconcile dropped, the parent clearing it
   700ms before the write went out, and a re-mount losing it with nothing to
   retype from. A prompt held in a component is a prompt with a lifetime shorter
   than the session's.
5. **A poll landing mid-spawn is now uninteresting, and the harness's check on
   it does not discriminate on its own.** Widening the gap between the two
   spawns (which is what makes reconcile cascade-add a plain window, DRY-42)
   also moves the OLD code's 700ms write about four seconds later, i.e. past the
   point the CLI starts listening — so every timing assertion in that round
   passes against the bug. What fails is "the browser never typed it".
6. **`cat` cannot test any of this.** It reads from its first instant, so a
   prompt typed at 700ms lands and a harness built on it passes against the bug.
   `stub-cli.mts` drops what arrives before it is listening and prints the count;
   it also goes raw at t=0, because a tty left in canonical mode ECHOES what is
   typed at it and the prompt then appears in the pane's rows having reached
   nothing at all. Both of those were live false passes while this was written.

Harness: `scripts/verify/prefill.mts` + `stub-cli.mts`, rig in its README — a
browser, about a minute. Confirm it discriminates: against the unpatched tree it
fails 8 of 17 — **which that recipe can no longer reach**: it reverts `App.vue`
to before DRY-88, and round 3 now clicks the DRY-82 palette that checkout has
never had, so the run aborts there having failed 4 of the 10 checks it gets to
(measured under DRY-94, which added rounds 5-6). The README's discrimination
section carries the current numbers and a mutation-based recipe that does still
run. The stub is a MODEL of a measured CLI, so when Claude Code is
upgraded, re-measure rather than trusting it — spawn a real one through
`POST /api/sessions` with `input`, and read `typing initial prompt`'s
`paintedAfterMs` and `waitedMs` against the table above.

