/**
 * The prompt a ticket spawn starts an agent with (DRY-94).
 *
 * It used to be a string literal in `TicketDetail.vue`, which put every edit to
 * it behind a shell rebuild, a GHCR publish, a promote dispatch and a human
 * approving the production gate — the wrong cost for a sentence people want to
 * iterate on, and it meant every install ran with whatever prompt was in the
 * image. It is host config now, served over /api/config and expanded by the
 * desk: the same shape DRY-60's sweep delay has, and for the same reason
 * (the daemon has no opinion about it, it just holds it).
 *
 * The template is NOT where ticket content goes. DRY-53's brief already carries
 * the description, the comment thread and the epic in through the SessionStart
 * hook, against a 10000-character budget — a `{summary}` here would deliver all
 * of it twice and eat that budget, so the placeholder set is deliberately the
 * ticket's IDENTITY and nothing else.
 */

/** What a `{name}` may be. `{repo}` is "" for a ticket with no repo — see below. */
export const AGENT_PROMPT_KEYS = ["key", "repo"] as const;
export type AgentPromptKey = (typeof AGENT_PROMPT_KEYS)[number];

/**
 * The built-in default: implement the ticket, then see the change through
 * review rather than stopping at "opened a PR".
 *
 * The second half is the point of this ticket. An autonomous run (DRY-49) is
 * premised on nobody watching, so a prompt that ends at "implement it" ends the
 * run the moment a PR exists — and DRY-92's reviewer then posts its findings to
 * that PR with nobody there to read them. The run has to be prodded by hand to
 * finish, which is the thing an unattended run was for.
 *
 * Three things make the review loop terminate, all of them load-bearing:
 *
 *   - **A round cap, not "until it passes".** DRY-92's reviewer is ADVISORY and
 *     its check goes grey when triage declines — which is the common case on a
 *     `synchronize` — so "until the review is satisfied" is a condition that can
 *     never be reached on a PR nobody reviews. An unattended run would sit on it
 *     forever, and the DRY-60 sweep would never clear it, because a session that
 *     never hands its turn back never reaches a terminal state at all.
 *   - **A wait bound sized against a measured round trip.** PR open → review
 *     comment posted measured 6m04s and 7m46s on this repo (PRs #71 and #72),
 *     and 9m46s / 10m34s for a `@claude review` comment. 20 minutes clears all
 *     four with room for a queued self-hosted runner.
 *   - **"Hand back", not "exit".** In Drydock a run ENDS when the agent ends its
 *     turn — the Stop hook calls `markIdle`, which is what writes the handoff
 *     and posts the tracker comment (`session.ts`). Telling it to stop waiting
 *     is telling it to produce those artefacts.
 *
 * This is typed into a supervised composer too, where a human reads it before
 * pressing return (DRY-88 trap 3: the paths differ by the RETURN, not by the
 * text), so it stays two sentences a person can scan rather than a wall.
 */
export const DEFAULT_AGENT_PROMPT =
  "Work ticket {key}. Its full description is attached as context — implement it, " +
  "then see it through review: open a PR, attach it to the ticket, and address the " +
  "CI reviewer's comments until it reports nothing blocking.\n" +
  "Bound that loop: at most 3 review rounds, and stop waiting if none has landed " +
  "20 minutes after a push — the reviewer is advisory and declines most re-reviews, " +
  'so comment "@claude review" on the PR if you want another. Then hand back with ' +
  "whatever is still outstanding.";

/**
 * `{{name}}` — a literal `{name}` — or `{name}`, a placeholder.
 *
 * The escape exists because this is free prose. A prompt is entitled to contain
 * `{status}` because it is telling an agent about some other system's braces,
 * and without a way to write that, the boot check below would refuse a
 * perfectly good prompt with no way out. `{`, `}`, `{}` and `{two words}` don't
 * match either arm and pass through untouched — only the placeholder SHAPE has
 * to be escaped.
 *
 * Kept in step with `expandAgentPrompt` in `shell/src/lib/agent-prompt.ts`,
 * which is where the expansion actually happens: the daemon only ever holds
 * and validates this string. Deliberately not the `protocol.ts` arrangement
 * (verbatim copy + a CI drift check) — that is a WIRE format, where a
 * disagreement is a parse error. Here the two halves share a shape and a key
 * list, and the failure mode of a drift is a token left standing in a prompt.
 */
export const AGENT_PROMPT_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * The placeholders in `template` that nothing will ever expand.
 *
 * Refused at boot rather than filtered at expansion, which is DRY-66's argument
 * one surface over: a `{tickets}` typo that expands to nothing ships a prompt
 * missing the one thing it was about, and for an unattended run nobody is
 * looking at the composer to notice. The daemon that would serve it doesn't
 * start, and the message names the key.
 */
export function unknownAgentPromptKeys(template: string): string[] {
  const bad: string[] = [];
  for (const m of template.matchAll(AGENT_PROMPT_TOKEN)) {
    const key = m[2]; // m[1] is the escaped form — a literal, not a placeholder
    if (key && !AGENT_PROMPT_KEYS.includes(key as AgentPromptKey) && !bad.includes(key)) {
      bad.push(key);
    }
  }
  return bad;
}

/**
 * A carriage return is dropped, and only a carriage return.
 *
 * The daemon TYPES this at a CLI (DRY-88). A `\r` in it is Enter pressed
 * mid-prompt: the composer submits a fragment and the rest is typed at whatever
 * the agent does next. A `\r` reaching an env var means a .env with CRLF line
 * endings and never an intent, which is why this one control character is
 * normalised away instead of being refused — a host whose editor writes CRLF
 * would otherwise have a daemon that won't boot and no readable reason why.
 *
 * `\n` is fine and is passed through: `flushInitialInput` wraps a multi-line
 * payload in bracketed paste so it lands as one block.
 */
export function normalizeAgentPrompt(raw: string): string {
  return raw.replace(/\r/g, "");
}
