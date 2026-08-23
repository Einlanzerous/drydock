/**
 * Expanding the host's agent-prompt template (DRY-94).
 *
 * The template is host config (`DRYDOCK_AGENT_PROMPT`, served in
 * /api/config's `desk` block); the expansion happens HERE because the
 * supervised half of a ticket spawn puts the result in a composer for a human
 * to read and edit before pressing return. The daemon holds the string and
 * refuses one with an unfillable placeholder at boot — see
 * `daemon/src/agent-prompt.ts`, which this file is the other half of.
 */

/**
 * `{{name}}` — a literal `{name}` — or `{name}`, a placeholder.
 *
 * Must stay the same shape as the daemon's `AGENT_PROMPT_TOKEN`, which is what
 * the boot check scans with. Not the `protocol.ts` arrangement (a verbatim copy
 * plus a CI drift check): that is a wire format where a disagreement is a parse
 * error, while here the halves share one regex and one key list and the cost of
 * a drift is a token left standing in a prompt.
 */
const TOKEN = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * What a template may refer to. The ticket's IDENTITY and nothing else — its
 * description, thread and epic already reach the agent through DRY-53's brief,
 * and putting any of it here would deliver it twice against that budget.
 */
export interface AgentPromptVars {
  key: string;
  /** "" for a ticket with no repo (an ideas board). See the note in .env.example. */
  repo: string;
}

/**
 * The prompt this shell falls back to when the daemon doesn't serve one.
 *
 * Deliberately the sentence that shipped BEFORE this ticket rather than a
 * second copy of the daemon's default. A daemon with no `desk.agentPrompt` is a
 * daemon older than DRY-94, and the honest thing to give it is the prompt it
 * was built alongside — repeating the new default here would be a second place
 * the shipped policy lives, and the two would drift the first time somebody
 * edited the good one.
 */
export const LEGACY_AGENT_PROMPT =
  "Work ticket {key}. Its full description is attached as context — implement it.";

/**
 * Fill in `{key}` / `{repo}`.
 *
 * An unknown placeholder is left STANDING, not dropped. It cannot normally get
 * this far — the daemon refuses to boot on one — but the rule matters for the
 * case that can: a shell older than the daemon serving it, where a placeholder
 * this build has never heard of is better read as a visible `{branch}` in the
 * composer than as a sentence with a hole in it (DRY-66's argument for refusing
 * over filtering; leaving it literal is the loudest thing a browser can do).
 */
export function expandAgentPrompt(template: string, vars: AgentPromptVars): string {
  return template.replace(TOKEN, (whole, escaped: string | undefined, key: string | undefined) => {
    if (escaped) return `{${escaped}}`;
    if (key === "key") return vars.key;
    if (key === "repo") return vars.repo;
    return whole;
  });
}
