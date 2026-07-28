// The brief a spawned agent starts with (DRY-53).
//
// Ticket-spawn's whole claim over pasting a prompt is that the agent begins
// knowing what the team knows. It briefed from `description` alone, which on
// any ticket with history is the one document that has stopped being updated:
// decisions, design reviews and handoffs are recorded as COMMENTS. An agent
// briefed from a stale description confidently rebuilds work that already
// merged — the failure this module exists to prevent.
//
// Kept apart from the providers (they fetch; this decides what fits) and from
// server.ts (which does I/O around it). It's a pure TicketDetail → string, so
// what an agent will see can be printed without spawning one.

import type { TicketComment, TicketDetail } from "./types.js";

/**
 * Claude Code truncates a SessionStart hook's `additionalContext` past this
 * many characters — measured, not documented, against v2.1.220: a payload of
 * exactly 10000 arrives whole and 10001 does not. What survives is the FRONT,
 * so everything past the cut is silently absent; the agent is told a file holds
 * the rest, and in practice doesn't go read it.
 *
 * This is why the whole brief is budgeted rather than concatenated. Note it
 * also means the pre-DRY-53 brief was already lossy on a long ticket — a 10 KB
 * description was being cut mid-sentence with nothing said about it. Appending
 * comments to that would have put the newest information past the cut, i.e.
 * shipped this feature in a form that reliably delivered none of it. (Observed:
 * a spawned agent on DRY-56 answered "zero comments shown" while the daemon had
 * dutifully sent all of them.)
 */
export const CONTEXT_LIMIT = 10_000;

/** Our ceiling, held under CONTEXT_LIMIT so a small miscount can't cost the tail. */
export const BRIEF_BUDGET = 9_500;

/**
 * Characters held back for the comment thread when a ticket has one, so a long
 * description can't crowd it out. This is the specific failure DRY-53 exists to
 * fix, and an unreserved budget reproduces it exactly: descriptions are written
 * first and are usually the longest thing on the ticket.
 *
 * It is a floor, not an allocation — a short description hands its slack to the
 * thread, and a ticket with no comments spends the whole budget on prose.
 */
export const COMMENT_RESERVE = 4_000;

/**
 * Ceiling on a single comment, so one design dump can't eat the thread around
 * it. Deliberately well under COMMENT_RESERVE: a per-comment cap equal to the
 * reserve is the same as no cap at all.
 */
export const PER_COMMENT_CAP = 2_000;

/**
 * Comments in a brief, regardless of budget. A thread of forty one-liners fits
 * easily, and shipping all forty buries the three that matter — recency is the
 * proxy for relevance, and past ~10 it stops paying.
 */
export const MAX_COMMENTS = 10;

/** `<comment author="…" at="…">` + `</comment>` + blank lines, near enough. */
const COMMENT_WRAPPER = 70;

/**
 * Truncation is always announced, and always names the ticket. An agent that
 * knows it holds an excerpt can go read the rest; one that doesn't will act on
 * a sentence that stops mid-clause.
 */
function truncated(text: string, keep: number, what: string, key: string): string {
  if (text.length <= keep) return text;
  return (
    text.slice(0, keep) +
    `\n\n[… ${what} truncated: ${keep} of ${text.length} characters shown. ` +
    `Read ${key} in the tracker for the rest.]`
  );
}

/** `2026-07-27 22:51 UTC`, or the raw string when it doesn't parse. */
function formatWhen(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Pick the window of comments that fits `budget`, newest first, then restore
 * reading order. Newest-wins because the newest comment is the one most likely
 * to be the handoff — this is the choice that decides whether the brief is
 * current.
 *
 * The newest comment is always included even when it alone busts the budget: an
 * activity section that drops the most recent comment for being long is worse
 * than no activity section, because it looks complete.
 */
function selectComments(
  all: TicketComment[],
  budget: number,
  key: string,
): { kept: TicketComment[]; bodies: string[] } {
  const kept: TicketComment[] = [];
  const bodies: string[] = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < MAX_COMMENTS; i--) {
    const c = all[i]!;
    const capped = truncated(c.body, PER_COMMENT_CAP, "comment", key);
    // `kept.length` guards the first one: the budget applies from the second
    // comment onward, which is what "always include the newest" means.
    if (kept.length && spent + capped.length + COMMENT_WRAPPER > budget) break;
    spent += capped.length + COMMENT_WRAPPER;
    kept.push(c);
    bodies.push(capped);
  }
  kept.reverse();
  bodies.reverse();
  return { kept, bodies };
}

/**
 * How much of the record the agent is looking at. Always stated, even when it's
 * all of it: an agent that can't tell a window from a whole thread has to
 * assume the worst of every brief, which costs a tracker round trip it can't
 * make from inside a session.
 */
function windowLine(shown: number, total: number): string {
  if (shown >= total) return `${total} comment${total === 1 ? "" : "s"}, oldest first.`;
  return `Showing the ${shown} most recent of ${total} comments, oldest first.`;
}

const ACTIVITY_PREAMBLE =
  "Decisions and handoffs are recorded here, so the description above can " +
  "predate this thread — where the two disagree, prefer the thread.";

/**
 * The SessionStart brief. Everything but the ticket itself is optional, so a
 * provider that answers with less produces a shorter brief rather than an
 * error — the same posture the hook takes when the tracker is down entirely.
 */
export function ticketContext(t: TicketDetail): string {
  const head: string[] = [
    `You are working on tracker ticket ${t.key}.`,
    "",
    `# ${t.key}: ${t.title}`,
    `Status: ${t.status.label} · Repo: ${t.repo}`,
  ];

  // Keys, not bodies: enough for the agent to look the epic up and check its
  // work against the plan it belongs to, without paying for that plan on every
  // spawn. Titles ride along because both providers hand them over for free.
  //
  // The parent line is suppressed when the parent IS the epic — the common
  // shape by far (task under epic), where printing both says one thing twice.
  const parentIsEpic = !!t.epic && t.parent?.key === t.epic.key;
  if (t.parent && !parentIsEpic) head.push(`Parent: ${describe(t.parent)}`);
  if (t.epic) head.push(`Epic: ${describe(t.epic)}`);

  const all = (t.comments ?? []).filter((c) => c.body.trim());
  const headText = head.join("\n");

  // Split what's left between the two bodies. The description is the primary
  // document and gets everything EXCEPT the thread's reserve; the thread then
  // gets whatever the description didn't spend, so the reserve is a floor and
  // not a cap. Section scaffolding is charged up front so the arithmetic can't
  // be quietly wrong by the size of its own headings.
  const scaffolding = all.length ? ACTIVITY_PREAMBLE.length + 120 : 40;
  let room = BRIEF_BUDGET - headText.length - scaffolding;
  const reserve = all.length ? Math.min(COMMENT_RESERVE, Math.max(0, room)) : 0;
  const description = truncated(
    t.description?.trim() || "(This ticket has no description.)",
    Math.max(0, room - reserve),
    "description",
    t.key,
  );
  room -= description.length;

  const lines = [headText, "", "## Description", "", description];

  if (all.length) {
    const { kept, bodies } = selectComments(all, room, t.key);
    lines.push("", "## Recent activity", "", ACTIVITY_PREAMBLE, windowLine(kept.length, t.commentCount ?? all.length));
    for (const [i, c] of kept.entries()) {
      // Tagged rather than given a markdown heading, because comment bodies
      // carry their OWN headings — a real one on this project opens with
      // `## What the design adds`, which under a `###` byline outranks the
      // byline and reads as a new section of the brief rather than as somebody
      // talking. The delimiter also keeps authorship attached to the words:
      // "claude said this" and "the ticket says this" carry different weight.
      const when = formatWhen(c.createdAt);
      lines.push(
        "",
        `<comment author="${attr(c.author ?? "unknown")}"${when ? ` at="${attr(when)}"` : ""}>`,
        bodies[i]!,
        "</comment>",
      );
    }
  }

  // Belt and braces. Everything above is budgeted, but the claim being made is
  // "this always arrives whole" — so it's enforced at the exit rather than
  // inferred from arithmetic elsewhere in the file. Losing the tail silently is
  // the exact failure mode this module was rewritten to remove.
  const out = lines.join("\n");
  return out.length <= BRIEF_BUDGET
    ? out
    : truncated(out, BRIEF_BUDGET - 120, "brief", t.key);
}

function describe(ref: { key: string; title?: string }): string {
  return ref.title ? `${ref.key} — ${ref.title}` : ref.key;
}

/** Keep an attribute value from closing its own tag. Display names are free text. */
function attr(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "");
}
