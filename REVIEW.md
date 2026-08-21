# Review instructions

Review-only guidance, higher priority than `CLAUDE.md`. `CLAUDE.md` describes
how this repo works and what it has already learned by breaking; this file
describes what a review of it is *for*. Read both — but do not restate CLAUDE.md
here, and when the two disagree, this file wins.

## What this review is for

There are **no automated tests in this repo.** `pr-checks.yml` runs the daemon
typecheck, `vue-tsc -b && vite build`, the `scripts/` typecheck, and a diff
proving the two `protocol.ts` copies haven't drifted. That is the whole of CI.
Green means *it compiles* — it has never meant *it works*, and DRY-52 says so in
the workflow's own header.

So: assume type errors and drift are handled, and don't spend the review on
them. Spend it on the four things nothing else in this pipeline can see.

1. **Does the change do what its ticket asked?**
2. **Does it kill, strand, or silently degrade a session that is already
   running?** This repo's whole premise is that agents survive things — a daemon
   restart, a deploy, a disconnect. Almost every serious defect it has had was a
   promise of survival that one path didn't keep.
3. **Does it move who may see or drive a session?**
4. **Is the evidence real?** See the verification bar below. This repo's
   signature defect is not a broken feature; it is a check that passes against
   the bug.

## Ticket fidelity — check this first

When a Switchyard ticket is linked, read its description and comment thread
before the diff, and answer explicitly in the summary:

- Does the implementation satisfy what the ticket asked, or only the easy
  subset?
- Did a requirement get silently dropped, narrowed, or deferred without saying
  so?
- Does the PR claim something is done that the diff does not demonstrate?

A change that is clean code and wrong scope is a **🔴 Important** finding. Say
which requirement is unmet and quote it.

When no ticket is linked, say so in one line and review the diff on its own
terms. Do not invent intent from the branch name.

## Severity

- **🔴 Important** — ends or strands a live PTY, loses uncommitted work, widens
  who may read or drive a session, makes a failure silent, or does not do what
  the ticket asked.
- **🟡 Nit** — conventions, clarity, a comment that will mislead the next
  reader. Never blocking.
- **🟣 Pre-existing** — real, not introduced here. At most two per review.

Cap nits at five; say "plus N similar" in the summary beyond that. A review that
buries one Important finding under twelve nits has failed at its job.

## Always check

Each of these is a rule the repo learned by breaking something. `CLAUDE.md` has
the incidents; these are the review-time questions.

- **Does it end a session that is running?** Anything touching the supervisor,
  the sessions dir, `/kill`, the systemd unit, or a cleanup loop. The specific
  traps: a `pkill -f` pattern that also matches the shell running it; a
  supervisor filter on `/proc/<pid>/exe` alone, which matches every other
  daemon's agents on this host; `rm -rf` on a sessions dir *before* its
  supervisors are stopped, which leaves processes nothing can ever find; and a
  unit file without `KillMode=process`, which is DRY-87 — every deploy killing
  the agents DRY-57 promised would survive.
- **`PROTOCOL_VERSION` in `supervisor/wire.ts`.** Did a frame type or the meaning
  of a `SessionMeta` field change without a bump? Then a new daemon will
  misparse an old supervisor. Did it get bumped casually? Then every live
  session becomes undrivable until its agent finishes. Both directions are
  Important; the second one is the one that looks harmless in a diff.
- **Is a failure being inferred from an exit code?** Signalling a process exits
  it 129/137/143, so "non-zero means failed" reports every deliberate stop as a
  crash. This has now shipped four times in four different surfaces (DRY-49
  trap 2, DRY-56 trap 3, DRY-64 trap 4, DRY-79 trap 7). `failure` being SET, or
  `endReason`, is the verdict; the number never is.
- **Is a value dropped in transit instead of refused?** The house rule for the
  spawn route is 400 with the key named, not a silent filter (DRY-66) — a value
  that vanishes between the POST and the PTY is a run proceeding without the
  thing that was supposed to scope it. Related: a key the daemon overwrites
  *after* accepting it is the same bug wearing a 201.
- **Ownership and visibility.** `visibleTo` and `ownedBy` are deliberately
  different (DRY-64 trap 3): a gate goes only to its owner and carries tool
  input, an exit is three fields a spectator can already read. A new surface
  needs the right one, and a spectator must get no control that 404s when
  pressed. Ownership applies only under multi-user (DRY-27 trap 8) — both
  directions strand sessions.
- **The hooks are not the browser.** A session's own key opens `/hook/*` and
  nothing else, on purpose: the agent can read its own environment, and the one
  thing it would like to do with a credential is answer its own permission gate.
- **A new tracker query.** Is it fired from a render path or a poll (DRY-83
  trap 2 / DRY-72's fan-out)? Does it carry a deadline, ride the cache, and pass
  `stale` through (DRY-72 trap 2)? Is the cache key still exhaustive over
  `TicketQuery`?
- **Node, not Bun.** The daemon and `scripts/up.mts` run under `node --import
  tsx` deliberately — node-pty segfaults under Bun, and Bun's `.env` expansion
  disagrees with this repo's own parsers. A script "simplified" to `bun` is
  Important. Everything under `scripts/` is TypeScript (DRY-80), with two
  recorded exceptions.
- **`protocol.ts` mirrored.** CI catches drift, but a PR that changes one copy
  and not the other is still worth naming rather than leaving to a red check.
- **Does the diff invalidate something CLAUDE.md states as true?** That file is
  this repo's regression suite. A behaviour change that leaves a documented trap
  describing the old behaviour is a 🔴, not a nit — the next person will test
  against it.

## The verification bar

The repo's claims are verified by driving the real thing: a throwaway daemon on
a spare port, the `verify` skill, the harnesses in `scripts/verify/`. So when a
PR says it verified something, ask what it actually observed.

- **A 201 is not evidence, and neither is a healthy `/api/sessions`.** DRY-79
  lived from DRY-57 to DRY-79 behind exactly those two.
- **A harness has to discriminate.** CLAUDE.md asks every one of them to be run
  against the unpatched file and shown to fail. A check that passes either way
  is worse than no check: the DRY-27 harness selected two class names that exist
  nowhere in the shell, and DRY-83's anti-fan-out check emptied the sidebar of
  the rows it was measuring. Both shipped green.
- **Turned-down timeouts.** Five minutes is the right default and a terrible
  test. A harness that waits out the real delay is passing by patience.
- If the PR adds a harness, check that the README rig says how to make it fail.
