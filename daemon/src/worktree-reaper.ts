// Reaping finished worktrees (DRY-90).
//
// DRY-15 gave every ticket-spawned agent its own git worktree and a policy that
// said, correctly, that closing a window must not delete one. What it never
// gave was the other half: nothing reaped, `POST /api/worktrees/remove` had
// exactly one caller (the panel's Reset button), and a host accumulated a full
// checkout per ticket forever. Five worktrees on the prod host when this was
// written, four of them finished work — one five weeks old.
//
// Why this is reconciliation and not an event handler
// ---------------------------------------------------
// A merge is the honest "this is finished" signal, and the association is
// already there: the PR hangs off the ticket, the worktree is `<repo>-<TICKET>`.
// But a merge happens whenever it happens, which is usually with Drydock not
// running and otherwise with nobody telling it. So there is no moment to catch.
// This works out the current state on a schedule instead — and at boot, which is
// when a merge that happened while the daemon was down gets noticed.
//
// Why NOT on window close
// -----------------------
// Closing a window means "I'm done looking", not "the work is finished" — the
// branch may be uncommitted, unpushed or unmerged, which is the whole reason
// DRY-15 keeps worktrees on close. Worse, DRY-60's sweep closes windows with
// nobody present: a finished run clears itself after a delay and `Clear
// finished` takes a pile at once, so deletion hung off close would quietly
// destroy worktrees overnight. The automatic sweep must never delete a
// worktree, under any policy. The one thing a close may do is ask this module
// whether the worktree is ALREADY reapable (`reapOne`), which applies the same
// predicate as the timer and refuses for the same reasons — a trigger, never a
// bypass.
//
// Age is not a reason either. A five-week-old worktree is reapable because its
// ticket is DONE, not because it is old; a stale-but-dirty one is the likeliest
// of all to hold something nobody has looked at.
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import {
  listManagedWorktrees,
  removeWorktree,
  worktreeSafety,
  type ManagedWorktree,
  type WorktreeSafety,
} from "./worktree.js";

/** What the reaper decided about one worktree, and why. */
export type ReapVerdict =
  /** Gone: the checkout was removed (the branch is kept). */
  | "reaped"
  /** A session in the registry runs here — never reaped, whatever else says. */
  | "in-use"
  /** Holds something that exists only here. */
  | "unsafe"
  /** Safe to remove, but the work isn't finished. */
  | "unfinished"
  /** git or the repo said no. Logged and skipped; never fatal. */
  | "error";

export interface ReapDecision {
  worktree: ManagedWorktree;
  verdict: ReapVerdict;
  /** One phrase explaining the verdict, for the log line and the route body. */
  reason: string;
  safety?: WorktreeSafety;
  /** Whether reaching this verdict cost a tracker request (see the budget below). */
  askedTracker?: boolean;
  /** Left for the next sweep because this one's tracker budget was spent. */
  deferred?: boolean;
}

export interface ReapDeps {
  /**
   * Is any session on this HOST pointed at this path?
   *
   * Three widenings, each of which was a way to reap a worktree somebody was
   * working in:
   *
   *  - "in the registry", not "running": a session that has EXITED is still on
   *    somebody's desk with its scrollback readable, and DRY-62's Resume spawns
   *    straight back into this worktree.
   *  - the registry also covers sessions the daemon reattached after a restart
   *    (DRY-57); the ticket being closed says nothing about whether an agent is
   *    in there right now.
   *  - and the host, not this process. Worktrees are NOT per-port the way the
   *    sessions index is: every daemon on the machine shares one
   *    `~/.drydock/worktrees` by default, so this daemon's registry is a
   *    truthful answer to the wrong question — it says "not mine", the reaper
   *    hears "nobody's", and the dev daemon's live agent loses its checkout to
   *    the prod daemon's sweep (review, DRY-92).
   */
  inUse(wtPath: string): boolean;
  /**
   * Has the tracker closed this ticket? `undefined` means it couldn't be
   * asked — an outage, an unknown key, no tracker worth asking. Undefined is
   * NOT false: it decides nothing, and the worktree is kept.
   */
  ticketDone(key: string): Promise<boolean | undefined>;
}

/**
 * How many tracker lookups one sweep will make.
 *
 * Only worktrees that are already safe and not already merged reach the
 * tracker, which on any real host is a handful — but "a handful" is a fact
 * about the host, not a bound, and this runs in the process that holds every
 * live PTY. Announced when it bites rather than silently truncated (DRY-83):
 * the remainder is simply considered on the next sweep.
 */
const MAX_TICKET_LOOKUPS = 50;

export class WorktreeReaper {
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(private readonly deps: ReapDeps) {}

  /**
   * Decide about one worktree. The order is deliberate and is cheapest-first as
   * well as safest-first: the registry is a map lookup, the predicate is two
   * local git commands, and only what survives both is worth a tracker request.
   */
  async consider(
    wt: ManagedWorktree,
    opts: { mayAskTracker?: boolean } = {},
  ): Promise<ReapDecision> {
    if (this.deps.inUse(wt.path)) {
      return { worktree: wt, verdict: "in-use", reason: "a session is using it" };
    }
    const safety = worktreeSafety(wt.path);
    if (!safety.safe) {
      return {
        worktree: wt,
        verdict: safety.unreadable ? "error" : "unsafe",
        reason: safety.reason ?? "holds work that exists only here",
        safety,
      };
    }
    // Merged into the repo's default branch is the finished case answered
    // locally, with no tracker involved at all — which is what makes this work
    // on a host with `DRYDOCK_TRACKER=fixture`, i.e. no tracker configured.
    //
    // Except when HEAD is the default branch's own tip, which is what a branch
    // that has never committed anything looks like — an agent that was spawned
    // and did nothing, or one that is running right now and hasn't written a
    // file yet. Treating that as "merged" would answer the finished question
    // with evidence of nothing having happened, and it short-circuits the
    // tracker, so the ticket's state stops mattering at all. It is asked about
    // properly instead (review, DRY-92). A fast-forward merge lands here too
    // and pays one tracker lookup for the privilege; that is the price of a
    // distinction the repo genuinely does not contain.
    if (safety.merged && !safety.atDefaultTip) {
      return {
        worktree: wt,
        verdict: "reaped",
        reason: `merged into ${safety.defaultBranch}`,
        safety,
      };
    }
    if (!wt.ticket) {
      const why = safety.atDefaultTip
        ? `nothing has been committed on ${safety.defaultBranch}, and no ticket to ask about`
        : "not merged, and no ticket to ask about";
      return { worktree: wt, verdict: "unfinished", reason: why, safety };
    }
    if (opts.mayAskTracker === false) {
      return {
        worktree: wt,
        verdict: "unfinished",
        reason: "deferred — this sweep's tracker budget is spent",
        safety,
        deferred: true,
      };
    }
    // Squash-merges land here: the squashed commit is a different object, so
    // containment says no while the ticket has been closed for a week.
    const done = await this.deps.ticketDone(wt.ticket);
    if (done === undefined) {
      return { worktree: wt, verdict: "unfinished", reason: `couldn't ask the tracker about ${wt.ticket}`, safety, askedTracker: true };
    }
    if (!done) {
      return { worktree: wt, verdict: "unfinished", reason: `${wt.ticket} is still open`, safety, askedTracker: true };
    }
    return { worktree: wt, verdict: "reaped", reason: `${wt.ticket} is closed`, safety, askedTracker: true };
  }

  /**
   * Apply a decision. Split from `consider` so the two triggers (the timer and
   * an explicit close) share one policy and one removal, and so a caller that
   * only wants to KNOW can ask without acting.
   */
  private remove(decision: ReapDecision): ReapDecision {
    const wt = decision.worktree;
    try {
      // Never `rm -rf`, and never `--force`. Deleting the directory would leave
      // admin metadata in the parent repo's `.git/worktrees/`, so the branch
      // stays "checked out somewhere" and re-spawning this ticket later fails
      // to re-add it — `removeWorktree` follows up with `git worktree prune`
      // for trees git lost that way, and this must not create more of them.
      removeWorktree(wt.repoDir, wt.path);
      // Said out loud, always: a checkout disappearing with no record is
      // indistinguishable from losing work, which is precisely the anxiety this
      // feature must not create. The branch line is not decoration — it is the
      // answer to "where did my changes go".
      log.info("worktree reaped", {
        worktree: wt.path,
        repo: wt.repoDir,
        branch: wt.branch,
        ticket: wt.ticket,
        why: decision.reason,
        kept: wt.branch ? `branch ${wt.branch}` : "nothing to keep",
      });
      return decision;
    } catch (err) {
      // A repo that has moved, a worktree on an unmounted disk, a git that
      // errors. This runs in the daemon that holds every live PTY and
      // DRYDOCK_EXIT_ON_UNCAUGHT defaults ON since DRY-57 — nothing here is
      // worth taking the desk down for.
      log.warn("worktree reap failed", { worktree: wt.path, err: String(err) });
      return { ...decision, verdict: "error", reason: String(err) };
    }
  }

  /**
   * Consider one worktree by path and remove it if the policy says so.
   *
   * The entry point for an explicit trigger — a window somebody closed. It goes
   * through `consider`, so it can refuse for any of the same reasons; a caller
   * reads the verdict rather than assuming.
   */
  async reapOne(wt: ManagedWorktree): Promise<ReapDecision> {
    const decision = await this.consider(wt);
    return decision.verdict === "reaped" ? this.remove(decision) : decision;
  }

  /**
   * Consider every managed worktree once.
   *
   * Sequential rather than parallel: the git commands are cheap but they are
   * `execFileSync`, and a fan-out of them across a directory of stale checkouts
   * would block the event loop of the process holding the PTYs for as long as
   * the slowest disk takes. Nothing here is in a hurry.
   */
  async sweep(trigger: "boot" | "timer" | "request"): Promise<ReapDecision[]> {
    // One at a time. The boot sweep and the first interval tick can otherwise
    // overlap on a host where the first one is slow, and two `git worktree
    // remove`s racing on the same path make one of them an error line about a
    // worktree that was already gone.
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const managed = listManagedWorktrees();
      const decisions: ReapDecision[] = [];
      let lookups = 0;
      let deferred = 0;
      for (const wt of managed) {
        let decision: ReapDecision;
        try {
          // The budget is enforced by `consider`, which is the only thing that
          // knows whether this worktree needs the tracker at all — most don't,
          // because the merged case is answered by git and the dirty case never
          // gets that far. Counting intentions here instead would spend the
          // budget on worktrees that never made a request.
          decision = await this.consider(wt, { mayAskTracker: lookups < MAX_TICKET_LOOKUPS });
        } catch (err) {
          log.warn("worktree reap check failed", { worktree: wt.path, err: String(err) });
          decision = { worktree: wt, verdict: "error", reason: String(err) };
        }
        if (decision.askedTracker) lookups++;
        else if (decision.deferred) deferred++;
        decisions.push(decision.verdict === "reaped" ? this.remove(decision) : decision);
      }
      const reaped = decisions.filter((d) => d.verdict === "reaped").length;
      if (deferred) {
        log.warn("worktree sweep hit its tracker-lookup budget", {
          budget: MAX_TICKET_LOOKUPS,
          deferred,
          note: "the rest are considered on the next sweep",
        });
      }
      if (reaped || trigger === "boot") {
        log.info("worktree sweep", { trigger, managed: managed.length, reaped, kept: managed.length - reaped });
      }
      return decisions;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Sweep at boot and then on the configured interval.
   *
   * Boot is not a nicety: it is the only trigger that can notice a merge that
   * happened while the daemon was down, which on a laptop is most of them.
   * Deliberately NOT awaited by the caller and deliberately after `listen` —
   * it walks git repos, and DRY-57's reconcile has already taught this file's
   * neighbours that nothing may delay the port coming up.
   */
  start(): void {
    const everyMs = CONFIG.worktrees.reapEveryMs;
    if (!everyMs) {
      log.info("worktree reaper is off", { knob: "DRYDOCK_WORKTREE_REAP_MS=0" });
      return;
    }
    void this.sweep("boot").catch((err) => log.warn("worktree sweep threw", { err: String(err) }));
    this.timer = setInterval(() => {
      void this.sweep("timer").catch((err) => log.warn("worktree sweep threw", { err: String(err) }));
    }, everyMs);
    // The HTTP server keeps the loop alive on its own; this timer should never
    // be the reason a process that wants to exit can't.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
