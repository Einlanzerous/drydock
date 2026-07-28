// What an autonomous run leaves behind (DRY-49).
//
// A supervised session needs none of this: the record of what happened is the
// scrollback in the window you were looking at. An unattended run has no
// window, and its scrollback is a ~1 MiB ring buffer inside a process that
// dies with the daemon — so if the run is to be worth starting, its ending has
// to survive it.
//
// Two artefacts, in strict priority order:
//
//   1. A handoff document on disk. Always written. This is the durable one,
//      and the thing the tracker comment points at — telling somebody "pick
//      this up" while linking them to a dead session's memory would be worse
//      than saying nothing.
//   2. A tracker comment. Best-effort, and capability-gated: the fixture
//      provider advertises `comment: false`, and any provider can be
//      unreachable. The rail's terminal state must stand on its own, so this
//      is an enhancement to the record and never the record itself.
//
// Both are written when the run ENDS, not when a human acknowledges it —
// nothing is lost if you never look.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import { expandHome } from "./repos.js";
import type { PtySession, RunEndReason } from "./session.js";
import type { TrackerProvider } from "./tracker/index.js";

/** Long enough that a transcript containing its own code fences can't close it. */
const FENCE = "``````";

/** `2026-07-28T02-14-55` — sortable, and safe in a filename on every platform. */
function stamp(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
}

/** One line per outcome, reused by the document header and the comment. */
function outcomeLine(session: PtySession, reason: RunEndReason): string {
  const info = session.info();
  const failure = session.runFailure;
  if (reason === "failed") {
    return `failed — ${failure?.reason ?? `exited ${info.exitCode ?? "?"}`}`;
  }
  if (reason === "finished") return "finished — the process exited cleanly";
  if (reason === "stopped") return "stopped — ended by request";
  // Deliberately not "done". The Stop hook means the agent handed the turn
  // back; whether that was a sign-off or a question is not something we know,
  // and the UI must never spend the word on a guess (DRY-18).
  return "ended its turn — it may have finished, or may be waiting on a reply";
}

/**
 * Write the handoff document and return its path.
 *
 * Deliberately synchronous. This runs from a run-end notification inside the
 * PTY's exit handler, and an `await` here would let the process — and with it
 * the scrollback this document is made of — be torn down mid-write on a daemon
 * shutdown. The file is a few hundred KB at worst, written once per run.
 */
function writeHandoff(session: PtySession, reason: RunEndReason, at: number): string {
  const info = session.info();
  const root = expandHome(CONFIG.autonomous.runsRoot);
  fs.mkdirSync(root, { recursive: true });
  // Named for when the run STARTED, not when it ended — so a run that reaches
  // more than one terminal state rewrites one document instead of leaving a
  // trail of near-identical ones. (It does happen: a denied gate makes the CLI
  // end its turn, which is a second ending a beat after the first.) The ticket
  // key leads so the directory is browsable by what a human remembers; the
  // timestamp keeps re-runs of one ticket apart.
  const name = `${info.ticket ?? info.id.slice(0, 8)}-${stamp(info.createdAt)}.md`;
  const file = path.join(root, name);

  const header = [
    `# ${info.ticket ?? info.title} — autonomous run`,
    "",
    `- Outcome: ${outcomeLine(session, reason)}`,
    `- Started: ${new Date(info.createdAt).toISOString()}`,
    `- Ended: ${new Date(at).toISOString()} (${elapsed(at - info.createdAt)})`,
    `- Command: ${[info.command, ...info.args].join(" ")}`,
    `- Working dir: ${info.cwd}`,
    info.worktree ? `- Worktree: ${info.worktree} (branch \`${info.branch}\`)` : null,
    info.failure?.lastLine ? `- Last output line: \`${info.failure.lastLine}\`` : null,
    `- Session: ${info.id}`,
    "",
    "The agent ran unattended, so the transcript below is the only account of",
    "what it did. The worktree above still holds its work — nothing was reverted.",
    "",
    "## Transcript",
    "",
    FENCE,
  ].filter((l): l is string => l !== null);

  // The transcript content goes in VERBATIM. An agent that printed a fenced
  // code block would close a three-backtick fence and render the rest of its
  // own output as markdown — hence the long fence, rather than escaping the
  // content. Getting the bytes right matters more here than getting the
  // rendering right: this document is the only account of what the run did.
  //
  // The one liberty taken is collapsing runs of blank lines. A TUI redraws its
  // whole frame constantly and every carriage return became a newline on the
  // way here, so an untouched capture is mostly vertical whitespace — which
  // costs nothing to lose and buries everything that matters.
  const transcript = session.transcript().replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(file, `${header.join("\n")}\n${transcript}\n${FENCE}\n`, "utf8");
  return file;
}

/**
 * The tracker comment. PLAIN TEXT on purpose.
 *
 * It has to read correctly on both providers this daemon supports, and Jira is
 * the one that constrains the format: jira.ts talks to `/rest/api/2/*`, where a
 * comment body is a plain string (v3 would demand an ADF document). Markdown
 * would render on Switchyard and arrive as literal asterisks in Jira, so it
 * gets none — just lines a human can act on.
 */
function commentBody(session: PtySession, reason: RunEndReason, at: number, handoff: string): string {
  const info = session.info();
  const lines = [
    `Drydock ran this ticket autonomously and ${outcomeLine(session, reason)}.`,
    `Ended at ${clock(at)} after ${elapsed(at - info.createdAt)}.`,
    "",
    `Handoff: ${handoff}`,
  ];
  if (info.worktree) lines.push(`Worktree: ${info.worktree} (branch ${info.branch})`);
  if (info.failure?.lastLine) lines.push(`Last output: ${info.failure.lastLine}`);
  // Only when the host was told where the shell lives. See CONFIG.autonomous.
  if (CONFIG.autonomous.shellUrl) lines.push(`Drydock: ${CONFIG.autonomous.shellUrl}`);
  if (reason === "failed") {
    lines.push("", "Nobody was watching when this stopped — please pick it up from the handoff above.");
  }
  return lines.join("\n");
}

/**
 * Build the run-end handler. Wired once in server.ts via manager.onRunEnd().
 *
 * The tracker is injected rather than imported so this module stays testable
 * against a stub and so the daemon keeps exactly one provider instance.
 */
export function runEndHandler(tracker: TrackerProvider) {
  /**
   * At most one comment per run, EXCEPT that a failure always gets through.
   *
   * Both can happen to one run: the agent hands its turn back (comment), you
   * don't notice, and an hour later an unanswered gate kills it (comment). The
   * second is the one that matters, so it is not allowed to be suppressed by
   * the first — while a chatty taken-over session still can't spam the ticket.
   */
  const commented = new Set<string>();

  /**
   * Bound it. This daemon is meant to run for weeks (restarting it destroys
   * every live PTY), so a set that only ever grows is a leak with a very long
   * fuse. Dropping the oldest keys is safe: they belong to runs that ended long
   * ago, and the thing they guard against is a *second* comment moments later.
   */
  const remember = (key: string): void => {
    commented.add(key);
    while (commented.size > 500) commented.delete(commented.values().next().value!);
  };

  return (session: PtySession, reason: RunEndReason): void => {
    const at = Date.now();
    const info = session.info();

    let handoff: string;
    try {
      handoff = writeHandoff(session, reason, at);
      session.noteHandoff(handoff);
      log.info("autonomous run ended — handoff written", {
        id: info.id,
        ticket: info.ticket,
        reason,
        handoff,
      });
    } catch (err) {
      // No document means no comment: the comment's entire value is the pointer
      // to it, and "continue from a file that isn't there" is worse than the
      // rail card alone.
      log.warn("could not write the run handoff", { id: info.id, err: String(err) });
      return;
    }

    // A run somebody stopped on purpose still gets its transcript kept, but no
    // comment: the tracker is for things that happened while you weren't
    // looking, and you were looking — you pressed the button.
    if (reason === "stopped") return;
    // Only a run spawned FOR a ticket has anywhere to comment. One launched
    // without one still got its handoff above and still shows its terminal
    // state on the rail — that path is not degraded, it just has no ticket.
    if (!info.ticket) return;
    if (!tracker.capabilities.comment || !tracker.comment) return;
    const key = `${info.id}:${reason === "failed" ? "failed" : "ended"}`;
    if (commented.has(key)) return;
    remember(key);

    // Fire-and-forget: the run is already over and its durable record is on
    // disk. A tracker that is down must not throw into a PTY exit handler.
    void tracker
      .comment(info.ticket, commentBody(session, reason, at, handoff))
      .then(() => log.info("run outcome posted to the tracker", { id: info.id, ticket: info.ticket }))
      .catch((err) => {
        commented.delete(key); // a later terminal state may still get through
        log.warn("could not comment the run outcome — the handoff still stands", {
          id: info.id,
          ticket: info.ticket,
          err: String(err),
        });
      });
  };
}
