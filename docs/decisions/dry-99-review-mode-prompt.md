# The spawn prompt follows the ticket's review mode (DRY-99)

Switchyard says, on every ticket, what an agent may finish alone: `review_mode` —
`evidence`, `decision`, `full`, or `null` for *not classified*. Drydock ignored it.
`toTicket()` dropped the field, so the shell never saw it, and every spawn got the
one prompt DRY-94 made host config — which runs a ticket to completion. A
`decision` ticket was launched with instructions that contradicted it.

The prompt is now chosen by the ticket's mode, and the ticket panel does the
choosing.

| `review_mode` | the prompt tells the agent to |
|---|---|
| `evidence` | today's DRY-94 default, **byte-for-byte** (485 chars): implement, PR, bounded review loop, hand back |
| `decision` | plan first and put the decisions it needs to a human, then stop; once the plan is approved, implement and run through as for `evidence` (727 chars) |
| `full` | as `decision`, and do not merge — ask for sign-off on the merge, then stop (804 chars) |
| `null` | Switchyard's rule for an unset mode — *ask, never assume; unset is not evidence*: say so, and ask which mode applies before changing anything (365 chars) |
| absent | the host's ordinary prompt, unchanged. A tracker with no such concept is not an unclassified ticket |

## Where each part lives

| | |
|---|---|
| `daemon/src/tracker/types.ts` | `ReviewMode`, and `Ticket.reviewMode` with its three states |
| `daemon/src/tracker/switchyard.ts` | `toReviewMode` — the one place the wire is read |
| `daemon/src/agent-prompt.ts` | the four defaults, the shared parts, `resolveAgentPrompts` (precedence) |
| `daemon/src/config.ts` | `desk.agentPrompts`, and the boot check over every effective template |
| `daemon/src/server.ts` | `/api/config` serves `agentPrompts` beside the unchanged `agentPrompt` |
| `shell/src/lib/agent-prompt.ts` | `pickAgentPrompt` — where absent and `null` are told apart in the browser |
| `shell/src/components/TicketDetail.vue` | fills the composer from it; re-fills when the fresh mode arrives |

## Absent is not `null`, and that is the whole ticket

`Ticket.reviewMode` has **three** states and collapsing any two is the bug.

- `undefined` — the provider has no such concept (Jira, the fixture) or is a
  Switchyard older than the field. Nothing was said; the ordinary prompt applies.
- `null` — the tracker has the concept and this ticket is not classified. The
  mode's own doc is unambiguous that this must not be treated as permission.
- a mode.

`JSON.stringify` keeps them apart (`undefined` drops the key, `null` stays), which
is what carries the distinction to the browser without a new field. Treating
absent as `null` makes every Jira spawn interrogate you; treating `null` as absent
runs an unclassified ticket unattended, which is the exact failure Switchyard's
docs name.

**A mode this build has never heard of reads as `null`, not absent.** Switchyard
could grow a fourth, and the safe reading of a mode we cannot interpret is the one
Switchyard gives an unset one. Falling through to absent would spawn it under the
run-it-unattended prompt, silently, on the day the server upgraded before Drydock
did.

## Precedence, and why it is asymmetric

1. `DRYDOCK_AGENT_PROMPT_<MODE>` — an explicit word about that mode.
2. `DRYDOCK_AGENT_PROMPT`, for `evidence` **only** — it has always meant "the
   run-it-through prompt", and it stays the prompt for a tracker with no modes, so
   a host that set it and never sees a mode behaves exactly as before.
3. The built-in default for the mode.

`DRYDOCK_AGENT_PROMPT` does **not** stand in for `decision`, `full` or
`unclassified`. Those exist to make an agent stop for a human; a run-it-through
prompt applied to them would put back the failure this fixes, silently, for
exactly the hosts that customised the knob. The cost, said out loud: such an
operator's `decision` tickets get the built-in text, not theirs. `.env.example`
says so beside the knob.

## Every prompt STOPS; none of them waits

`decision` and `full` end by saying *stop and hand back*, never *wait for
approval*. A run that idles on a human under `manual`/`acceptEdits` is failed by
its own gate timeout (DRY-96), and a session that never hands its turn back is one
DRY-60's sweep never clears. Ending the TURN is what fires `markIdle` → handoff →
tracker comment (DRY-94 §3), so asking a human for a decision *is* ending the turn
with the question. The answer arrives as a new spawn — or, supervised, as the
person typing into the pane they are already looking at.

That is also why the plan clause starts with `get_plan`: a Switchyard plan is
approved only by a person (an agent can neither approve its own nor lower the
ticket's mode), so "is it approved yet" is the one fact the prompt has to send the
agent to *read*. A respawn after approval then implements instead of opening a
second draft. The tool names (`get_plan`, `open_plan_draft`, `submit_plan`) are
Switchyard's, and only a Switchyard ticket can reach that text.

Nothing in Drydock transitions a ticket on spawn (there is no caller of
`transition()` anywhere in `daemon/src`), so Switchyard's `plan_required` 422 on a
`decision` ticket cannot fire from here.

## `null` is a behaviour change for every existing DRY ticket

DRY's `default_review_mode` is `null`, so **every ticket in this project is
unclassified** and now asks which mode applies instead of running. That is the
doctrine-faithful reading, and it is deliberate, but it is the first thing a
person firing off a spawn will notice. Three ways back to fire-and-forget:
classify the tickets, set the project's `default_review_mode` (a human action —
lowering it is a 403 for agent tokens), or set `DRYDOCK_AGENT_PROMPT_UNCLASSIFIED`.

## The mode comes from the fresh fetch when there is one

The sidebar's row is up to a poll stale (the daemon caches the list, DRY-72), and a
ticket lifted into `decision` in that gap must not be spawned as `evidence`. The
panel reads the mode off its own detail fetch — which is uncached — and falls back
to the row until that lands. The composer is re-filled **only while it still holds
exactly what the panel put there** (`filledPrompt`, the same guard DRY-94 built for
the host template arriving late), so nobody's edit is overwritten by a mode that
arrives half a second after they started typing.

## Skew, both ways

- **New shell, older daemon:** no `agentPrompts` is served, `pickAgentPrompt` falls
  back to the ordinary prompt for every ticket, which is what that daemon has
  always served. The policy is deliberately not invented in the browser — a copy
  there would drift the first time somebody edited the real one.
- **Old shell, new daemon:** still reads `desk.agentPrompt`, which is unchanged.

## Things that cost time

1. **A `const` is not readable before its declaration.** The first draft called a
   function at module top, above the `const` parts it was built from, and would
   have thrown a temporal-dead-zone error on the first import — from a comment
   that claimed the function existed to avoid exactly that. Caught by reading it
   back, before anything ran. The shared parts now sit *above* the prompts.
2. **The evidence default was checked, not trusted, to be unchanged.** It is built
   from shared parts now, so "I didn't touch the sentence" is a claim about a
   refactor. It was compared against `main`'s exported string: identical, 485
   characters. Do the same if you split it further.
3. **A rig in a long directory cannot spawn.** `DRYDOCK_SESSIONS_DIR` inside a
   deep scratch path put the session socket at 115 bytes, over the ~100-byte unix
   limit, and the spawn failed with a message that named the fix. Round 1 timed
   out waiting for a pane instead, which reads as the feature's bug. Read the
   daemon's log before the harness's.
4. **The harness must be registered in BOTH `scripts/` tsconfigs.** It reads the
   DOM in a `page.evaluate`, so it belongs in `tsconfig.browser.json` and must be
   in `tsconfig.json`'s `exclude`; forgotten, it fails loudly in the wrong half
   (`Cannot find name 'document'`) rather than passing.
5. **`/api/tracker/ticket/<KEY>` wraps its answer as `{ ticket }`.** A smoke test
   that read the envelope reported the single-ticket route as dropping the field —
   a false alarm about the one route the panel actually reads.
6. **The two prompt variables in the rig have to differ.** Otherwise absent and
   `evidence` are the same sentence and a build that conflated them passes.

## Not done

- Whether the autonomous ("Run") button should be offered at all on a `decision`
  or `full` ticket. The prompt stops in the right places, but a hands-off posture
  on a `full` ticket is a decision of its own.
- The mode as a chip in the sidebar or panel, so a person can see *why* the
  composer says what it says.
- Anything for Jira. It has no such concept; it takes the ordinary prompt.

## Verifying

`scripts/verify/review-mode-prompt.mts`, rig in
[the README](../../scripts/verify/README.md#the-prompt-follows-the-tickets-review-mode-dry-99).
56 checks, every one on what *arrived* at the PTY (CLAUDE.md trap 3) or on what a
daemon started a particular way *serves*. It covers both tracker providers (a
Switchyard-shaped stub, and the fixture). Of the two skew directions, round 4
measures **new shell, older daemon** by relaying that daemon's real config minus
`agentPrompts` into the page; **old shell, new daemon** is `prefill.mts` rounds 5
and 6, which read the unchanged `desk.agentPrompt` and still pass unmodified
(33 checks).

Discrimination, one mutation at a time (recipes in the README):

| mutation | fails |
|---|---|
| shell ignores the mode (pre-DRY-99) | **16 of 56** — everything but the absent-key ticket, which correctly still passes |
| panel trusts the sidebar row over its own fetch | 2 of 56 |
| a late mode overwrites an edit in progress | 3 of 56 |
| absent reads as `null` *and* unknown reads as absent | 14 of 56 |
| `DRYDOCK_AGENT_PROMPT` speaks for every mode | 1 of 56 |
| boot check validates only the first template | 4 of 56 |
| a daemon serving no per-mode prompts leaves the panel with nothing | 1 of 56 |
