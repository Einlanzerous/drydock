# Verifying the ticket brief (DRY-53)

What a spawned agent is told about its ticket: `tracker/context.ts` turns a
`TicketDetail` into the `additionalContext` the SessionStart hook returns. It
carries the description, the comment thread, and the nearest epic's key.

**Claude Code truncates `additionalContext` past 10000 characters and says
nothing about it.** Measured against v2.1.220 — 10000 arrives whole, 10001 does
not — and what survives is the FRONT. This is the single fact the feature is
designed around, so re-measure it before assuming a brief arrives:

```sh
# hook that emits N chars with a marker at the very end
claude -p --settings <hook.json> "Answer in one word: is TAILTOKEN present in \
  your session-start context?"
```

The traps:

1. **Appending is the bug.** Comments after a description put the newest
   information past the cut, so the feature ships delivering exactly none of
   what it was built for. It presents as total success: the daemon sends the
   whole brief, the hook returns 200, and only the agent knows. Caught by
   asking a spawned agent to quote its newest comment — it answered "zero
   comments shown" while the daemon had sent four. Hence the budget, the
   thread's reserved slice, and the announced truncations.
2. **Note this predates DRY-53**: a >10 KB description was already being cut
   mid-sentence with nothing said. Any change that grows the brief inherits
   this.
3. **A brief-shaped test is not an agent-shaped test.** curl against
   `/hook/sessionstart` shows a perfect payload at any size. The only honest
   probe is a real `claude` that has to answer *from* the brief — spawn one and
   ask for the epic key, the comment count, and a verbatim quote of the newest
   comment.
4. **Comment bodies carry their own markdown headings**, several of which
   outrank any byline you could give them (`## What the design adds` is a real
   one here). They're wrapped in `<comment author=… at=…>` tags for that reason;
   a `###` byline reads as a new section of the brief instead of as somebody
   talking.
5. **Switchyard's single-ticket GET does not hydrate `parent`** — it returns
   `parent_id` as a bare UUID with `parent: null` beside it, while the LIST
   endpoint inlines the whole thing. So the one path that feeds an agent is the
   one that has to resolve the chain itself, one GET per rung.
6. **Jira pages the `comment` field oldest-first.** A deployment that returns a
   short page hands back the wrong end of the thread — worse than none, because
   it looks complete. The provider detects it via `total` and re-fetches from
   `startAt = total - N` rather than using `orderBy=-created`, which Cloud
   supports and older DC does not.

Both halves have harnesses (`scripts/verify/ticket-brief.mts`,
`tracker-getticket.mts`, in-process and seconds), because the failure is silent
by construction and curl can't see it. Neither replaces trap 3.

