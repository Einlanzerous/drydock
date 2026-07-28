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

/**
 * Ceiling on the title, and on the parent/epic titles beside it (DRY-53).
 *
 * The head is the one part of the brief a tracker controls and this module
 * doesn't: it is charged against the budget but was not itself bounded, so a
 * long enough title drove the remaining room negative and the exit clamp — which
 * cuts the TAIL — took the description and the whole comment thread with it. A
 * 9400-character title produced a brief with no activity section at all.
 */
const TITLE_CAP = 200;

/**
 * Truncation is always announced, and always names the ticket. An agent that
 * knows it holds an excerpt can go read the rest; one that doesn't will act on
 * a sentence that stops mid-clause.
 */
function truncated(text: string, keep: number, what: string, key: string): string {
  if (text.length <= keep) return text;
  const cut = clip(text, keep);
  return (
    cut +
    `\n\n[… ${what} truncated: ${cut.length} of ${text.length} characters shown. ` +
    `Read ${key} in the tracker for the rest.]`
  );
}

/**
 * `slice`, minus the dangling half of a surrogate pair. JS string indices are
 * UTF-16 code units, so cutting a thread mid-emoji emits an unpaired surrogate
 * into a JSON hook response — reproducible with any odd-length prefix before an
 * emoji run. Dropping the orphan costs one character and one glyph.
 */
function clip(text: string, keep: number): string {
  const end = keep > 0 && isHighSurrogate(text.charCodeAt(keep - 1)) ? keep - 1 : keep;
  return text.slice(0, end);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Same, for text that just needs shortening — a title, not a document. */
function ellipsis(text: string, keep: number): string {
  return text.length <= keep ? text : `${clip(text, keep)}…`;
}

/**
 * Neutralize our own delimiter inside a comment body (DRY-53).
 *
 * Comment bodies are attacker-adjacent text: a body containing `</comment>`
 * closed the element early, and everything after it read as brief-level prose —
 * including a forged `<comment author="admin">` block, under a preamble that
 * tells the agent to prefer the thread over the description. Confirmed: a
 * single comment rendered as two attributed blocks while the window line above
 * still said "1 comment".
 *
 * Not a theoretical channel. Drydock writes comments to tickets itself
 * (DRY-49's autonomous handoffs), and any tracker account can write one.
 *
 * The escape is deliberately visible rather than clever — `<\/comment>` cannot
 * be mistaken for the delimiter by a reader or a parser, and it leaves the text
 * legible, which a stripped or replaced tag would not.
 */
function fence(body: string): string {
  return body.replace(/<(\/?)(comments?\b)/gi, "<\\$1$2");
}

/**
 * `2026-07-27 22:51 UTC`, or the raw string when it doesn't parse.
 *
 * Only relabelled as UTC when the provider's timestamp actually carried a zone
 * — Switchyard writes `+00`, Jira writes `+0000`. A bare `2026-07-28 17:12:35`
 * is parsed by JS as the DAEMON HOST's local time, so converting it and
 * stamping "UTC" on the result silently moves the comment by the host's offset
 * (verified: five hours, on a host in America/Chicago). Neither provider emits
 * that form today; a future one that does gets its string passed through
 * unlabelled rather than confidently mislabelled.
 */
function formatWhen(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  if (!/(Z|[+-]\d{2}:?(\d{2})?)$/.test(raw.trim())) return raw;
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
function selectComments(all: TicketComment[], budget: number, key: string): RenderedComment[] {
  const kept: RenderedComment[] = [];
  let spent = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < MAX_COMMENTS; i--) {
    const c = all[i]!;
    // Fenced BEFORE capping, so the escape is inside the budget rather than
    // added to it — otherwise a body full of `</comment>` grows past the cap
    // it was just measured against.
    const block = render(c, truncated(fence(c.body), PER_COMMENT_CAP, "comment", key));
    // `kept.length` guards the first one: the budget applies from the second
    // comment onward, which is what "always include the newest" means.
    if (kept.length && spent + block.cost > budget) break;
    spent += block.cost;
    kept.push(block);
  }
  return kept.reverse();
}

/**
 * A comment as it will appear, carrying its own real cost. Rendering here
 * rather than at the call site is what lets the budget charge the exact wrapper
 * — the byline is variable-width, and a fixed estimate for it is a fudge factor
 * that the exit clamp pays for later, at the tail, which is where the newest
 * comments are.
 */
interface RenderedComment {
  lines: string[];
  cost: number;
}

function render(c: TicketComment, body: string): RenderedComment {
  const when = formatWhen(c.createdAt);
  // Tagged rather than given a markdown heading, because comment bodies carry
  // their OWN headings — a real one on this project opens with `## What the
  // design adds`, which under a `###` byline outranks the byline and reads as a
  // new section of the brief rather than as somebody talking. The delimiter
  // also keeps authorship attached to the words: "claude said this" and "the
  // ticket says this" carry different weight.
  const lines = [
    "",
    `<comment author="${attr(c.author ?? "unknown")}"${when ? ` at="${attr(when)}"` : ""}>`,
    body,
    "</comment>",
  ];
  return { lines, cost: lines.join("\n").length };
}

/**
 * How much of the record the agent is looking at. Always stated, even when it's
 * all of it: an agent that can't tell a window from a whole thread has to
 * assume the worst of every brief, which costs a tracker round trip it can't
 * make from inside a session.
 */
function windowLine(shown: number, total: number): string {
  // The thread exists and none of it arrived. Saying so is the point: this is
  // the difference between "nobody has commented" and "you are missing the
  // part of the record where the decisions are".
  if (shown === 0) {
    return `This ticket has ${total} comment${total === 1 ? "" : "s"}, but none could be retrieved — treat the description above as possibly out of date.`;
  }
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
  // Capped: see TITLE_CAP. The head is charged against the budget, so anything
  // unbounded in it comes out of the description and the thread.
  const head: string[] = [
    `You are working on tracker ticket ${t.key}.`,
    "",
    `# ${t.key}: ${ellipsis(t.title, TITLE_CAP)}`,
    `Status: ${ellipsis(t.status.label, TITLE_CAP)} · Repo: ${ellipsis(t.repo, TITLE_CAP)}`,
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
  const headText = head.join("\n");

  const all = (t.comments ?? []).filter((c) => c.body.trim());
  const total = t.commentCount ?? all.length;
  // A thread the provider counted but couldn't deliver still gets a section
  // saying so. Silence here is the module's own documented failure mode: a
  // ticket with 63 comments and no bodies rendered byte-identical to a ticket
  // with none, which is "looks complete" — worse than saying nothing. Reachable
  // whenever a comment fetch comes back empty.
  const hasSection = all.length > 0 || total > 0;

  // Split what's left between the two bodies. The description is the primary
  // document and gets everything EXCEPT the thread's reserve; the thread then
  // gets whatever the description didn't spend, so the reserve is a floor and
  // not a cap. Section scaffolding is charged up front so the arithmetic can't
  // be quietly wrong by the size of its own headings.
  const scaffolding = hasSection ? ACTIVITY_PREAMBLE.length + 120 : 40;
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

  if (hasSection) {
    const kept = selectComments(all, room, t.key);
    lines.push("", "## Recent activity", "", ACTIVITY_PREAMBLE, windowLine(kept.length, total));
    for (const c of kept) lines.push(...c.lines);
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
  return ref.title ? `${ref.key} — ${ellipsis(ref.title, TITLE_CAP)}` : ref.key;
}

/** Keep an attribute value from closing its own tag. Display names are free text. */
function attr(s: string): string {
  return s.replace(/"/g, "'").replace(/[<>]/g, "");
}
