# The agent's opening prompt, and where a run stops (DRY-94)

Two halves. The prompt a ticket spawn pre-fills is host config now
(`DRYDOCK_AGENT_PROMPT`, served over `/api/config`, expanded by the desk); and
the built-in default tells the agent to see a change through REVIEW rather than
stopping at "implement it".

The second half is the point. A DRY-49 run is premised on nobody watching, so a
prompt that ends at "implement it" ends the run the moment a PR exists — and
DRY-92's reviewer then posts its findings to that PR with nobody there to read
them. Every autonomous run had to be prodded by hand to finish, which is the
thing an unattended run was for.

The first half is what made the second cheap: the sentence was a string literal
in `TicketDetail.vue`, so editing it cost a shell rebuild, a GHCR publish, a
`promote.yml` dispatch and a human approving the production gate.

## Where each part lives

| | |
|---|---|
| `daemon/src/agent-prompt.ts` | the default, the placeholder set, the boot check |
| `daemon/src/config.ts` | `desk.agentPrompt`, and the refusal |
| `daemon/src/server.ts` | `/api/config` serves the template, unexpanded |
| `shell/src/lib/agent-prompt.ts` | `expandAgentPrompt`, and the pre-DRY-94 fallback |
| `shell/src/components/TicketDetail.vue` | fills the composer with the expanded result |

The daemon never expands anything: the desk does, because the supervised half of
a spawn puts the sentence in front of a human who may edit it before pressing
return (DRY-88 trap 3 — the two paths differ by the RETURN, not by the text).
One config value feeds both buttons, which is why the default has to stay
readable rather than becoming a wall of instructions.

## The review loop needs a bound, and "satisfied" cannot be it

1. **The reviewer is advisory and usually declines.** DRY-92's check goes GREY on
   a `synchronize` unless the PR carries `review:always` or somebody comments
   `@claude review`. So "address the comments until the review passes" is a
   condition that is never reached on a PR nobody reviews, and an unattended run
   would sit on it forever. The default bounds it twice: **at most 3 rounds**,
   and **stop waiting 20 minutes after a push**.
2. **20 minutes is measured, not picked.** PR opened → reviewer's comment posted:
   **6m04s** (PR #71) and **7m46s** (#72); a `@claude review` comment →
   **9m46s** / **10m34s**. A declined triage finishes in ~7s. Twenty clears all
   four with room for a queued self-hosted runner.
3. **"Hand back" is the termination, and it is a real event.** A `claude` that
   finishes doesn't exit — it ends its TURN, the Stop hook calls `markIdle`, and
   that is what announces `ended-turn`, writes the handoff and posts the tracker
   comment (`session.ts`, `runs.ts`). So telling the agent to stop waiting and
   report is telling it to produce the artefacts; telling it to "keep checking"
   is telling it to produce none, and DRY-60's sweep never clears the card
   because the session never exits.

## DRY-49's timeout is safe, for a reason worth knowing

The ticket's first worry was that a run waiting on CI would idle past
`DRYDOCK_AUTONOMOUS_PERMISSION_TIMEOUT_MS` and be failed mid-wait. It won't,
because **that hour is a per-GATE hold timer, not a run clock**: the only
`setTimeout` it feeds is armed inside `requestPermission` and cleared when the
gate is answered (`session.ts`). Nothing anywhere ends an autonomous run for
being slow.

Measured rather than read: a daemon at `DRYDOCK_AUTONOMOUS_PERMISSION_TIMEOUT_MS=8000`
with an autonomous run that raises no gate still reports `status: running`,
`failure: null` and no handoff 40 seconds later.

**What WOULD break it is the posture, and `acceptEdits` is not the escape hatch
it looks like.** `server.ts` waves a tool through for `HANDS_OFF_MODES`
(`bypassPermissions` / `auto` / `dontAsk`), and under `acceptEdits` only for
`EDIT_TOOLS` (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`). **`Bash` is in
neither set** — `config.ts` says so in as many words: *"acceptEdits — file edits
pass silently; Bash and WebFetch still gate."* So under `manual` (the shipped
default) or `acceptEdits`, every `gh pr view`, every `sleep`, every `git push`
raises a Drydock gate; on a run nobody is watching one of them eventually goes
unanswered, and an hour later `failUnanswered` records a run that was doing
exactly what it was told as **failed**, with a handoff and a tracker comment
saying nobody was watching.

That is not new with this prompt — such a run was already gate-bound at its
first Bash call, which is why an unattended run is only really unattended under
a hands-off posture — but this prompt does LENGTHEN the exposure, deliberately,
by 20 minutes and up to three rounds. So, plainly: **the review wait is safe
under `auto` / `bypassPermissions` / `dontAsk`, or with `Bash` on "Always allow"
for the run. Under `manual` or `acceptEdits` it is not, and the fix is the
posture, not a bigger number.** (Found in review; the first version of this
section claimed `acceptEdits` covered it, which was simply false.)

## The agent can actually do what it is told

Item 3 of the ticket, and the failure mode it names is real: a prompt describing
work the agent cannot do is worse than the old one, because it loops trying.
Checked from inside a PTY the daemon spawned, not from a developer's shell —

```
/usr/bin/gh · gh version 2.45.0
✓ Logged in to github.com account Einlanzerous (~/.config/gh/hosts.yml)
  Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
gh api user -q .login → Einlanzerous
```

`repo` covers reading a PR's comments and posting to it. The credential arrives
through `HOME` rather than the environment, which is why it survives: DRY-59
strips only the `CLAUDE_*`/`DRYDOCK_*` markers, and DRY-66 refuses `HOME` as a
per-spawn override precisely so it stays the daemon's.

## Placeholders

`{key}` and `{repo}`, and nothing else — deliberately the ticket's IDENTITY.
DRY-53's brief already carries the description, thread and epic in through the
SessionStart hook against a 10000-character budget, so a `{summary}` here would
deliver all of it twice and spend that budget on the copy.

1. **An unknown placeholder stops the daemon.** `{tickets}` expanding to nothing
   ships a prompt missing the one thing it was about, and on an unattended run
   nobody is looking at the composer to notice — DRY-66's argument for refusing
   over filtering, one surface along. The message names every bad key and lists
   the good ones. It is checked against the EFFECTIVE value, so the built-in
   default is checked too: a placeholder added to it without being added to
   `AGENT_PROMPT_KEYS` fails every daemon on the first boot rather than only the
   hosts that override it.
2. **Which forces an escape, because a prompt is prose.** `{{status}}` is a
   literal `{status}` — without it, a perfectly reasonable instruction about
   some other system's braces would refuse to boot with no way out. Bare `{`,
   `}` and `{two words}` are not placeholder-shaped and pass through untouched.
3. **`{repo}` is "" for a ticket that has none** (an ideas board resolves to
   `$HOME`). That is a known key with an empty value rather than a dropped one,
   but a template using it still has to read correctly without it — said in
   `.env.example`, since nothing can catch it at boot.
4. **`||`, not `??`.** An empty `DRYDOCK_AGENT_PROMPT=` is a knob somebody
   half-commented out, which is exactly the case `msOrOff` was written for
   (DRY-60 trap 9). Read as a deliberate value it would spawn agents with an
   empty composer.
5. **A `.env` value is ONE LINE, and that is why the default is one line and
   `\n` is an escape.** `env.ts` reads that file line by line and skips any line
   without an `=`, so a prompt written across two lines arrives as its first
   line alone — no placeholder missing, nothing for the boot check to catch, the
   daemon boots, and the agent is told to address the reviewer's comments *with
   the bound gone*: the unbounded loop this ticket exists to prevent, restored
   in silence, on the surface where nobody reads the composer. Since `.env` is
   the documented surface and on prod the only one (`install-prod.sh` seeds
   `$PROD_DIR/.env`), the fix is both halves: the shipped default is a single
   line so copying it to reword can't lose anything, and `normalizeAgentPrompt`
   turns a two-character `\n` into a real newline so a multi-line prompt is
   expressible at all. Multi-line payloads themselves are safe —
   `flushInitialInput` sends one as a bracketed paste — which round 5 of the
   harness now exercises through that escape. The cost, said out loud: a prompt
   cannot contain a literal backslash-n in its text. (Found in review, along
   with the fact that the ticket's own refuse-don't-drop rule was being applied
   to placeholders and not to this.)
6. **A `\r` is dropped, and the reason is the CLI rather than the parse.** The
   daemon TYPES this, so a carriage return is Enter pressed mid-prompt: the
   composer submits a fragment and the rest lands wherever the agent goes next.
   Note where one can actually come from — a value set DIRECTLY in the
   environment (a systemd `Environment=`, a shell heredoc), never a CRLF `.env`,
   because `env.ts` trims each line before splitting it. (The first version of
   this note named the `.env` path, which review caught: CLAUDE.md trap 7, a
   justification that describes the wrong file.) Normalised rather than refused,
   because a stray CR is never an intent.

## The shell's fallback is the OLD sentence on purpose

`LEGACY_AGENT_PROMPT` is what shipped *before* this ticket, not a second copy of
the new default. A daemon that doesn't serve `desk.agentPrompt` is one built
before the field existed, and the honest thing to hand it is the prompt it was
built alongside. Repeating the new default in the browser would make the shipped
policy live in two places, and the two would drift the first time somebody
edited the good one.

**The fallback has a wider door than it looks.** `fetchConfig` gives the daemon
`AbortSignal.timeout(3000)` and treats anything else as "no opinion", so a
`/api/config` slower than three seconds leaves the desk on the legacy sentence —
best-effort by design (DRY-49/DRY-60 read `permissionMode` and the sweep delay
the same way, and the panel must never stop you launching a run), but the
consequence here is a prompt rather than a countdown. Measured, with the answer
delayed behind a route: at 2.2s the composer fills from the fallback and then
updates to the host's template when it lands; at 6s it stays on the fallback.
That update happens only while the box still holds exactly what the panel put
there (`filledPrompt`), so a prompt somebody has started editing is never
overwritten.

Same reasoning against the `protocol.ts` arrangement (a verbatim copy plus a CI
drift check) for the expander: that is a WIRE format, where a disagreement is a
parse error. Here the halves share a regex and a key list, and the cost of a
drift is a token left standing in a composer — which is why the shell's expander
leaves an unknown placeholder LITERAL rather than dropping it. A shell older
than its daemon shows you `{branch}`; it doesn't quietly hand you a sentence
with a hole in it.

## Verifying

`scripts/verify/prefill.mts` rounds 5 and 6, rig in
[the README](../../scripts/verify/README.md). Round 5 is the whole chain with
nothing stubbed — env var → `/api/config` → desk → the daemon types it → the
stub CLI echoes it back — and it is the multi-line case too, its template
carrying the `\n` escape so what arrives has a real newline in it. Round 6 starts a SECOND daemon with the variable empty
and relays its real config body into the page, because a desk's daemon URL is
baked in by Vite and cannot be re-pointed from inside a running browser.

Six things that cost time, all of them in the harness rather than the feature:

1. **A round that doesn't `reset()` reads the PREVIOUS round's session.** The
   desk restores its saved arrangement, so round 6 opened onto round 5's
   workspace and asserted against that pane — failing against correct code, and
   passing three other checks vacuously while it did.
2. **`server.address()` is null after `close()`.** Read the port first. The port
   is asked of the kernel rather than computed, because this host runs several
   agents at once with a throwaway daemon each in the 43xx range.
3. **A throwaway daemon runs DRY-90's boot sweep over the developer's
   worktrees.** It only removes work that is clean and merged, so nothing was
   lost — but a test daemon that deletes anything on the way up is not a thing
   to leave on. `DRYDOCK_WORKTREE_REAP_MS=0` in the rig and in the harness's own
   child.
4. **The second daemon is killed in a `finally`.** Two selector waits sit
   between the spawn and the kill, and a throw in either would leave a daemon
   listening on a kernel-assigned port nobody can guess afterwards. It holds no
   PTY, so there is no supervisor to strand — but a stray daemon on this host is
   its own problem. (Found in review.)
5. **The second daemon gets `DRYDOCK_AGENT_PROMPT=""`, not an absent key.**
   `env.ts` skips any key already present in the environment, so an empty value
   is what stops a `.env` above the checkout from quietly supplying one. Absent,
   round 6 would report whatever the developer's host is configured with and
   call it the built-in default. Every other `DRYDOCK_*` is stripped for the
   reason CLAUDE.md gives at length.

6. **The harness must decode the way the daemon does.** `CONFIGURED` was built
   with `String.prototype.replace` and a string pattern, which replaces the
   FIRST occurrence, against a `normalizeAgentPrompt` that uses `/g`. One `\n`
   in the rig template is a template where those cannot be told apart; a second
   makes the harness refuse (exit 2) and send whoever ran it to fix a rig that
   was already right. `replaceAll`, and the template carries two escapes now so
   the difference is testable. (Found in review, and confirmed by putting
   `replace` back.) Its refusal message prints both strings JSON-escaped for the
   same reason: an undecoded `\n` and a real one print identically otherwise,
   which reads as "set it to the thing it already is".

Discrimination: `perl -0pi -e 's/props\.agentPrompt \|\| LEGACY_AGENT_PROMPT/LEGACY_AGENT_PROMPT/'`
on `TicketDetail.vue` — the pre-DRY-94 behaviour exactly — fails **3 of 33**.
Dropping `agentPrompt` from `/api/config` makes the harness REFUSE (exit 2)
rather than fall back to asserting the default, which is the one thing rounds 5
and 6 exist to find out.

One thing this ticket measured about the OLD half, since a doc that states a
count is a doc somebody runs: DRY-88's recipe (revert `App.vue` to before it,
expect 8 of 17) can no longer reach that number — round 3 clicks the DRY-82
palette that checkout never had, so the run aborts there having failed 4 of the
10 checks it gets to. Said in `dry-88-initial-prompt.md` and in the README's
discrimination section rather than left for the next person to rediscover as a
mystery abort.
