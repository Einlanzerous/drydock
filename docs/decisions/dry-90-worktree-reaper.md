# Reaping finished worktrees (DRY-90)

DRY-15 gave every ticket-spawned agent its own worktree and a policy that said,
correctly, that closing a window must not delete one. The other half was never
built: nothing reaped, `POST /api/worktrees/remove` had exactly one caller (the
panel's Reset button), and a host accumulated a full checkout per ticket
forever — five on prod when this was written, four of them long-finished work,
the oldest five weeks old.

A worktree is now removed when it holds **nothing unrecoverable** AND its work
is **finished**. Both halves, always, whatever the trigger. The branch is always
kept — reaping a branch is a different and much less safe decision, and is out
of scope.

```sh
DRYDOCK_PORT=4390 DRYDOCK_WORKTREES_ROOT=/tmp/dry90/wt \
  DRYDOCK_REPO_PATHS=demo=/tmp/dry90/demo DRYDOCK_WORKTREE_REAP_MS=4000 \
  node --import tsx src/index.ts        # then watch for `worktree sweep`
```

1. **Window close is the wrong trigger, and DRY-60 is why.** Closing a window
   means "I'm done looking", not "the work is finished" — which is the whole
   reason DRY-15 keeps worktrees on close. Worse, the sweep closes windows with
   nobody present, and `Clear finished` takes a pile at once, so deletion hung
   off close would destroy worktrees overnight. **The automatic sweep must never
   delete a worktree, under any policy.** That is enforced structurally rather
   than by a flag: the call sits in `closeWindow` and `dismissRun` in `App.vue`,
   NOT in `endWindow` — which is the shared path the sweep and the button also
   go through. Anything moved up into `endWindow` to "tidy it up" reintroduces
   exactly the bug.
2. **A merge is the right signal and cannot be an event.** It happens whenever it
   happens, usually with Drydock not running and otherwise with nobody telling
   it. So this is reconciliation, not a handler or a webhook — and the sweep at
   BOOT is the one that matters, because that is when a merge that landed while
   the daemon was down gets noticed.
3. **The predicate is the whole design, and it had to be fixed before any of it
   could be built.** `removeWorktree` passed `--force` UNCONDITIONALLY (DRY-15),
   which was defensible while the only caller was a button and indefensible the
   moment anything scheduled called it — the reaper would have been a cron job
   whose primitive ignored its own safety check. It is now enforced in two
   places and both are load-bearing: `WorktreeReaper.consider` (which the timer
   and the reap route share) and `removeWorktree` itself (which the panel's
   Reset reaches directly, going nowhere near `consider`).
4. **git has no opinion about unpushed commits.** `git worktree remove` refuses
   a dirty checkout on its own, which makes the predicate look redundant — and
   it removes a CLEAN worktree holding three commits nobody has ever pushed
   without a murmur. That half is ours, and it is the half that loses work.
5. **Ignored files must not count and untracked files must.** `--porcelain`
   gets this right for free: a `node_modules` or a `dist` is reproducible, and
   counting it would make every worktree of every real project permanently
   unreapable, while an untracked `notes.md` is exactly the thing nothing may
   throw away.
6. **A branch started from a remote-tracking ref inherits an upstream**, which
   is how the "never pushed anywhere" case silently stops being tested.
   `branch.autoSetupMerge` defaults to true, so `git worktree add -b x <path>
   origin/main` gives `x` an upstream of `origin/main` — and the harness's
   no-upstream worktree then reported "1 unpushed commit". DRY-15 branches off
   the human checkout's HEAD, a LOCAL branch, so a real agent worktree has no
   upstream until somebody pushes it. Fixtures must do the same.
7. **"In use" means in the REGISTRY, not running — and on the HOST, not in this
   process.** An exited session is still a card on somebody's desk with readable
   scrollback, and DRY-62's Resume spawns straight back into that worktree; a
   session the daemon reattached after a restart (DRY-57) counts too.
   The second half is the one review found, and it is the worst bug this feature
   had: the sessions index is per-PORT by design, worktrees are per HOST
   (`DRYDOCK_WORKTREES_ROOT` defaults to one `~/.drydock/worktrees` for
   everybody), so the prod daemon on :4318 can see the dev daemon's worktrees
   and its own registry answers "not in use" about them perfectly truthfully.
   A live agent then loses its checkout mid-run — `git worktree remove` does not
   care that a process is cwd'd inside, and takes the ignored files with it.
   Liveness is therefore read from every daemon's on-disk index
   (`occupiedDirs()` in sessions-dir.ts), not from `manager.list()` alone. Any
   throwaway daemon started per the second-instance pattern lands on the default
   root too, so this is not a prod-only concern.
8. **`merged` is true for a branch that has never committed anything**, and no
   amount of git can tell that from a real merge — a fast-forward leaves the
   tips equal too. Which matters because it is the shape of EVERY worktree
   between `git worktree add` and the agent's first commit: read as "merged,
   therefore finished", a freshly spawned agent's checkout is reapable
   immediately and the ticket's state never gets asked about at all. So
   `atDefaultTip` is reported by the predicate and refused as evidence by
   `consider`, which falls through to the tracker instead. A fast-forward merge
   pays one tracker lookup for the privilege; that is the price of a distinction
   the repo does not contain.
9. **A detached HEAD is refused outright rather than measured.** Everything in
   the predicate reasons about HEAD, but what a removal PROMISES is that the
   work is kept on the branch — and detached there is no branch, so the one
   guarantee this makes is the one it cannot make. (The comment said so before
   the code did; review caught the two disagreeing.)
10. **Never `rm -rf`.** Deleting the directory leaves admin metadata in the parent
   repo's `.git/worktrees/`, so the branch stays "checked out somewhere" and a
   later re-spawn of the same ticket cannot re-add it. The harness proves this by
   re-adding the worktree afterwards, which is the operation that would fail.
11. **A tracker that can't answer has not said no.** An outage, an unknown key, a
   provider with no such ticket all mean "couldn't tell", and the worktree is
   kept. This is also where a SQUASH merge is caught: the squashed commit is a
   different object, so `merge-base --is-ancestor` says no while the ticket has
   been closed for a week.
12. **Age alone is not a reason.** The five-week-old worktree was reapable
   because its ticket was done, not because it was old. A stale-but-dirty one is
   the likeliest of all to hold something nobody has looked at.
13. **The interval goes through `msOrOff`, not `num()`** — DRY-60's trap 9 and
   DRY-72's trap 6, on a knob whose off switch guards deletion. A deliberate 0
   must mean "never reap"; through `num()` it would silently restore the 6h
   default.
14. **Say what was reaped.** A checkout disappearing with no record is
   indistinguishable from losing work, which is precisely the anxiety this
   feature must not create — so the daemon logs the path, the branch it kept and
   why, and the shell raises a line for the close-triggered case. That line is a
   FOURTH banner (`actionNote`, sticky and dismissible like `actionError`) and
   deliberately not a DRY-58 notice: a notice is a condition its owner clears
   when it stops holding, and a removal is over the moment it happens, so
   nothing would ever take it down again.
15. **`/api/worktrees/reap` can only see the managed root**, by identity rather
   than string prefix. `/api/worktrees/remove` will act on any path it is given
   and always has; the reap route is the one a client calls with no human
   reading a confirmation first, so `describeManagedWorktree` refuses anything
   whose parent directory isn't `DRYDOCK_WORKTREES_ROOT`.
16. **The reaper's own failures are harmless by construction.** A repo that has
   moved, a worktree on an unmounted disk, a git that errors: logged and
   skipped. This runs in the process that holds every live PTY and
   `DRYDOCK_EXIT_ON_UNCAUGHT` has defaulted ON since DRY-57.

Harnesses: `scripts/verify/worktree-reap.mts` (31 checks) for the policy and
`worktree-reap-ui.mts` (17) for which gesture may trigger it, rigs in their
README — a throwaway daemon, the DRY-72 stub tracker, and for the second a
browser and a vite server. Fifteen seconds and about a minute. They build their
own bare-origin-plus-clone fixture, so nothing they do touches a real repo, and
they **ask the daemon** where its worktrees root is and refuse to run if it
isn't the fixture's. (The guard that compared the harness's own constant against
a drydock-looking string could not fire — review's find, and the case it claimed
to cover is dropping `DRYDOCK_WORKTREES_ROOT` from an eight-variable rig line,
which leaves a 4-second sweep pointed at the real root.)

Confirm they discriminate, and note the two enforcement points need two
mutations:

- `removeWorktree` back to an unconditional `--force`: **3 of 31**, the whole
  `/api/worktrees/remove` section. The reaper's own cases survive, correctly —
  `consider` refuses before the primitive is reached.
- `consider` with its safety check deleted: **12 of 31**, including the
  scheduled sweep deleting a dirty worktree.
- the three pre-review reaper behaviours at once (registry-only liveness,
  `merged` short-circuiting the tracker, a measured detached HEAD): **6 of 31**,
  one pair per trap 7/8/9.
- the browser one fails **2 of 17** when the reap call moves from `closeWindow`
  into the shared `endWindow`, and those two are trap 1.

