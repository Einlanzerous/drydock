# Discarding a worktree from the panel (DRY-89)

DRY-15's panel had a **Reset** button for a worktree a prior spawn left behind,
and it deleted whatever the checkout held: `removeWorktree` passed `--force`
unconditionally, and the button asked nothing. It was offered in exactly the
state that has work to lose — an earlier agent, most likely an unattended one
(DRY-49), left a checkout behind.

DRY-90 fixed the primitive because the reaper needed it (`force` is opt-in, the
safety predicate runs first, the route answers 409 with a report, the panel
offers a second press). What this ticket added is the residue: the refusal now
says what it found in numbers, the failures that are not refusals are shown, and
the control says what it does.

1. **The button is called Discard, and the internals were renamed with it.**
   "Reset" reads as "start over from a clean branch", which is what the old
   comment said it did. What it does to an uncommitted file is delete it, and
   the label was the last place that reassuring reading survived. The state
   (`discarding`, `discardRefused`, `discardError`), the handler and the CSS
   class (`.wt-discard`) moved too, rather than leaving a `resetWorktree` behind
   a "Discard" label — the mismatch is how the original misreading got in.
   The first press is `Discard`, the override is `Discard anyway`.
2. **The count is part of `reason`, not a new field the panel formats.** The
   refusal reads `2 uncommitted changes (1 modified, 1 untracked)`. Putting it
   in the sentence keeps every consumer of `reason` working unchanged — the
   reaper's log line, the harnesses that match `/uncommitted/`, and a shell
   that is one version behind the daemon (the shell ships through a GHCR image
   and the daemon through `install-prod.sh`, so skew is normal) — where a new
   `modified` field would have left an old shell showing the old sentence with
   no way to tell.
3. **The counts are ENTRIES, and a wholly untracked directory is one.** git
   collapses it to a single `?? dir/` line. Reading it file by file (`-uall`)
   would be more honest about a new module of forty files, but `git()` in
   `worktree.ts` is an `execFileSync` with the default 1 MiB `maxBuffer`, and a
   worktree whose un-ignored untracked tree overflowed it would come back as
   `unreadable` — "git can't read it" for a checkout git reads fine. So the
   number understates a directory rather than mislabelling a big tree. If this
   ever needs to be exact, raise `maxBuffer` for that one call first.
4. **`git()` trims, and a porcelain line starts with a space.** ` M file` comes
   back as `M file` for the FIRST line only. Counting `??` (which the trim
   can't touch) and calling everything else modified is what makes that
   irrelevant; parsing the two status columns would have been wrong for exactly
   one line in the output.
5. **A refusal and a failure are different states with different remedies.**
   A refusal offers `Discard anyway`; a failure (a locked worktree, a repo that
   moved, a daemon that isn't answering) shows the error in red with NO button,
   because forcing past something git did not refuse over fails the same way.
   Before, the catch swallowed everything but the refusal on the theory that
   "the panel staying on the reuse state" was the report. It isn't: that is also
   what a worktree that WAS discarded looks like when the re-preview fails, and
   a button that does nothing and says nothing reads as broken.
6. **The 500 carries git's sentence, not node's.** `String(err)` on an
   `execFileSync` failure is `Error: Command failed: git worktree remove <path>`
   with the reason underneath; the panel shows the body verbatim now, so the
   route extracts `stderr` and falls back to `String(err)` only when there is
   none (a spawn error has no stderr).
7. **The tooltip claims only what is always true.** It says the branch, and any
   commits on it, stay — not "Discard 3 unpushed commits". Unpushed commits are
   on the local branch and survive removing the checkout, so a title that
   called them lost would be false; what a forced removal destroys is the
   uncommitted and untracked files, and the title says exactly that. (The one
   exception is a detached HEAD, where there is no branch and commits made on it
   do go — which is why the predicate refuses it outright and the refusal text
   sitting beside the button says so.)
8. **A locked worktree is the failure to test with**, because it is a real one
   the predicate cannot see: clean and merged is `safe`, and `git worktree
   remove` then declines. It needs `-f -f` even with a force, which is also why
   the panel offers no override for it.

Harnesses: `worktree-reap.mts` (35 checks, was 31) and `worktree-reap-ui.mts`
(28, was 17) — rigs in their headers, notes in
[scripts/verify/README.md](../../scripts/verify/README.md). The pre-DRY-89
`worktree.ts` and `server.ts` fail **2 of 35**; an unconditional `--force` in
`removeWorktree` fails **4 of 35**; swallowing the non-refusal error in the
panel fails **1 of 28**.
