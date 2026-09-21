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

// The parts every built-in prompt is made of. Here, above the prompts, because a
// `const` is not readable before its declaration — and separate at all (DRY-99)
// because they carry the BOUND on the review loop, which is the one thing that
// must not exist in four copies: a bound in four places is one somebody tightens
// in three. Read `DEFAULT_AGENT_PROMPT` for why each half of it is the way it is.
const LEAD = "Work ticket {key}. Its full description is attached as context";
const REVIEW_LOOP =
  "open a PR, attach it to the ticket, and address the CI reviewer's comments until it " +
  "reports nothing blocking. Bound that loop: at most 3 review rounds, and stop waiting " +
  "if none has landed 20 minutes after a push — the reviewer is advisory and declines " +
  "most re-reviews, so comment \"@claude review\" on the PR if you want another.";
const HAND_BACK = "Then hand back with whatever is still outstanding.";

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
 * text), so it stays four sentences and ~485 characters — something a person
 * can scan before sending rather than a wall. If you reword it, keep it that
 * order of size; a prompt nobody reads is one nobody edits before launching.
 *
 * **One line, deliberately.** A `.env` is parsed line by line (`env.ts` skips
 * any line without an `=`), so a two-line default is one an operator copies in
 * to reword and silently loses the second half of — and the second half is the
 * BOUND. Losing it restores the unbounded loop this ticket exists to prevent,
 * on the surface where nobody is reading the composer. A prompt that wants real
 * newlines writes `\n`; see `normalizeAgentPrompt`.
 */
export const DEFAULT_AGENT_PROMPT = `${LEAD} — implement it, then see it through review: ${REVIEW_LOOP} ${HAND_BACK}`;

// --- One prompt per review mode (DRY-99) ---------------------------------------
//
// Switchyard says, per ticket, what an agent may finish alone (`review_mode`),
// and one host-wide sentence cannot honour that: it launched a `decision` ticket
// with instructions to run it to completion. So the default is now a small set,
// chosen by the desk from the ticket it is about to spawn. `evidence` IS the
// prompt above, unchanged — a host that never sees a mode behaves exactly as
// before.
//
// Each still resolves to ONE line, for the reason given on `DEFAULT_AGENT_PROMPT`:
// an operator copies it into a `.env` to reword it, and a second line would be
// silently lost — and the second line is where the bound lives. They are longer
// than the four-sentence original (727 and 804 characters for `decision` and
// `full`, against 485) because the plan clause is real policy; the composer is
// still something a person can read before pressing return, but that is the
// ceiling, not a starting point.
//
// **All of them STOP; none of them wait.** A run that idles on an approval under
// `manual`/`acceptEdits` is failed by its own gate timeout (DRY-96), and a session
// that never hands its turn back is one DRY-60's sweep never clears. "Stop and
// hand back" ends the TURN, which is what fires `markIdle` and writes the handoff
// — so asking a human for a decision is expressed as ending the turn with the
// question, and the decision arrives as a new spawn (or, supervised, as the
// person typing in the pane they are already looking at).

/**
 * Plan before code, and put the human's decisions IN the plan.
 *
 * `get_plan` first, so a respawn after the plan was approved implements it rather
 * than opening a second draft: a Switchyard plan is approved only by a person (an
 * agent cannot approve its own, and cannot lower the ticket's mode either), which
 * makes "is it approved yet" the one fact this prompt has to make the agent go and
 * read rather than assume. Names Switchyard's plan tools because `review_mode` is
 * a Switchyard field — no other provider reaches this text (see
 * `Ticket.reviewMode`).
 */
const PLAN_FIRST =
  "Plan first: check the ticket's plan (get_plan). If none is approved, write one " +
  "(open_plan_draft, then submit_plan) that sets out every decision you need from me, " +
  "then stop and hand back — write no code until it is approved.";

/**
 * Which prompt a ticket gets. `unclassified` is Switchyard's `review_mode: null`,
 * and is NOT the same as a provider that has no modes at all — see
 * `Ticket.reviewMode`; that case takes the host's ordinary prompt and never
 * reaches this table.
 */
export const AGENT_PROMPT_MODES = ["evidence", "decision", "full", "unclassified"] as const;
export type AgentPromptMode = (typeof AGENT_PROMPT_MODES)[number];

export const DEFAULT_AGENT_PROMPTS: Record<AgentPromptMode, string> = {
  evidence: DEFAULT_AGENT_PROMPT,
  decision: `${LEAD}. ${PLAN_FIRST} Once it is approved, implement it and see it through review: ${REVIEW_LOOP} ${HAND_BACK}`,
  // `full` is `decision` plus the merge. The agent never merges under any mode —
  // the human presses the button — so this is less a new restriction than the one
  // the mode is FOR, said out loud: sign-off is asked for, not assumed.
  full:
    `${LEAD}. ${PLAN_FIRST} Once it is approved, implement it and see it through review: ${REVIEW_LOOP} ` +
    "Do not merge it: when it is ready, ask me to sign off on the merge, then stop and hand back " +
    "with whatever is still outstanding.",
  // Switchyard's own rule for an unset mode: ask, never assume — "unset is not
  // evidence". Every ticket in a project with no `default_review_mode` lands here
  // (DRY's is null), which is a behaviour change for those tickets and is why it
  // has a knob of its own.
  unclassified:
    `${LEAD}. It has no review mode, so nothing says how much you may do alone: read it and ` +
    "tell me what you would do, then ask which applies — evidence (run it through unattended), " +
    "decision (plan first, and I decide before any code) or full (I stay in the loop, merge " +
    "included) — and change nothing until I answer.",
};

/** The env var that overrides each mode's prompt. */
export const AGENT_PROMPT_ENV: Record<AgentPromptMode, string> = {
  evidence: "DRYDOCK_AGENT_PROMPT_EVIDENCE",
  decision: "DRYDOCK_AGENT_PROMPT_DECISION",
  full: "DRYDOCK_AGENT_PROMPT_FULL",
  unclassified: "DRYDOCK_AGENT_PROMPT_UNCLASSIFIED",
};

export interface ResolvedAgentPrompts {
  /** The ordinary prompt: a tracker with no review modes, and any shell older than DRY-99. */
  agentPrompt: string;
  agentPrompts: Record<AgentPromptMode, string>;
  /** Every effective template and what to call it in a boot error — see config.ts. */
  sources: { name: string; template: string }[];
}

/**
 * Read the host's prompt config out of `env`.
 *
 * Precedence, and it is deliberate that it is asymmetric:
 *
 *   1. `DRYDOCK_AGENT_PROMPT_<MODE>` — an explicit word about that mode.
 *   2. `DRYDOCK_AGENT_PROMPT`, for `evidence` ONLY. It has always meant "the
 *      run-it-through prompt", and an operator who wrote one wrote it for that.
 *      It also stays the prompt for a tracker with no review modes, which is what
 *      keeps a host that set it exactly as it was.
 *   3. The built-in default for the mode.
 *
 * It does NOT stand in for `decision`/`full`/`unclassified`. Those exist to make
 * an agent stop for a human, and a run-it-through prompt applied to them would
 * put back the failure DRY-99 is fixing — silently, for exactly the hosts that
 * customised the knob. The cost is that such an operator's tickets in those modes
 * get the built-in text rather than theirs; `.env.example` says so.
 *
 * `||`-style reads, not `??`: a blank value is a knob somebody half-commented out
 * (DRY-94 trap 4), and it must mean "unset", not "spawn with an empty composer".
 */
export function resolveAgentPrompts(env: NodeJS.ProcessEnv): ResolvedAgentPrompts {
  const set = (name: string): string | undefined => env[name]?.trim() || undefined;
  const base = set("DRYDOCK_AGENT_PROMPT");

  const agentPrompt = normalizeAgentPrompt(base ?? DEFAULT_AGENT_PROMPT);
  const sources = [
    { name: base ? "DRYDOCK_AGENT_PROMPT" : "the built-in default prompt", template: agentPrompt },
  ];

  const agentPrompts = {} as Record<AgentPromptMode, string>;
  for (const mode of AGENT_PROMPT_MODES) {
    const own = set(AGENT_PROMPT_ENV[mode]);
    const raw = own ?? (mode === "evidence" ? base : undefined) ?? DEFAULT_AGENT_PROMPTS[mode];
    const template = normalizeAgentPrompt(raw);
    agentPrompts[mode] = template;
    // `evidence` without its own knob is the ordinary prompt, already listed —
    // reporting it twice would name one bad placeholder under two variables.
    if (own) sources.push({ name: AGENT_PROMPT_ENV[mode], template });
    else if (mode !== "evidence") sources.push({ name: `the built-in ${mode} default`, template });
  }
  return { agentPrompt, agentPrompts, sources };
}

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
