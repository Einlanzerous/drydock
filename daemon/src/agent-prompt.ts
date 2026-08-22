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
 *
 * **One line, deliberately.** A `.env` is parsed line by line (`env.ts` skips
 * any line without an `=`), so a two-line default is one an operator copies in
 * to reword and silently loses the second half of — and the second half is the
 * BOUND. Losing it restores the unbounded loop this ticket exists to prevent,
 * on the surface where nobody is reading the composer. A prompt that wants real
 * newlines writes `\n`; see `normalizeAgentPrompt`.
 */
export const DEFAULT_AGENT_PROMPT =
  "Work ticket {key}. Its full description is attached as context — implement it, " +
  "then see it through review: open a PR, attach it to the ticket, and address the " +
  "CI reviewer's comments until it reports nothing blocking. Bound that loop: at most " +
  "3 review rounds, and stop waiting if none has landed 20 minutes after a push — the " +
  "reviewer is advisory and declines most re-reviews, so comment \"@claude review\" on " +
  "the PR if you want another. Then hand back with whatever is still outstanding.";

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
 *
 * Module-private, deliberately: a shared `/g` regex whose `lastIndex` a caller
 * can advance with `.test()` is a classic alternating-result bug, and the
 * `matchAll` below (which works off a clone) is the only thing that needs it.
 */
const AGENT_PROMPT_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g;

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
 * Turn a two-character `\n` into a real newline, and drop carriage returns.
 *
 * **The escape is the only way a multi-line prompt can be configured at all.**
 * Host config is documented as a `.env` and on prod that is the only surface
 * (`install-prod.sh` seeds `$PROD_DIR/.env`), and `env.ts` reads it line by
 * line: a value's second line has no `=` and is skipped, so a prompt written
 * across two lines arrives as its first line alone — silently, and with no
 * placeholder missing for the boot check to catch. Multi-line payloads are
 * safe once they get here; `flushInitialInput` wraps one in bracketed paste so
 * it lands as a block rather than submitting a fragment per newline.
 *
 * The cost, said out loud: a prompt that wants a literal backslash-n in its
 * text can't have one. Prose about an escape sequence is a stranger thing to
 * put in a prompt than a paragraph break, so this is the right way round.
 *
 * The `\r` strip is separate and is about the CLI rather than the parse: the
 * daemon TYPES this (DRY-88), so a carriage return is Enter pressed mid-prompt
 * — the composer submits a fragment and the rest is typed at whatever the agent
 * does next. Note this can only ever fire for a value set DIRECTLY in the
 * environment (a systemd `Environment=`, a shell heredoc): `env.ts` trims each
 * line before splitting it, so a CRLF `.env` never delivers one. It is
 * normalised rather than refused because a stray CR is never an intent.
 */
export function normalizeAgentPrompt(raw: string): string {
  return raw.replace(/\\n/g, "\n").replace(/\r/g, "");
}
