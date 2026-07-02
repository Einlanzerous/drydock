// Per-ticket git worktree isolation (DRY-15).
//
// A ticket-spawned agent used to run `claude` in the repo's *current* working
// tree (see repos.ts). Two agents on the same repo then clobber each other's
// files. Instead, each ticket gets its own git worktree on a dedicated branch
// (`agent/<TICKET>`) under `~/.drydock/worktrees/<repo>-<TICKET>`, so their
// edits never touch the human's checkout or each other's.
//
// Cleanup policy: worktrees are *kept on session close*. The agent's branch may
// hold commits or uncommitted work the human still wants to inspect/merge, and
// re-spawning the same ticket reuses the existing worktree. Removal is explicit
// ("prune on demand") via removeWorktree — never automatic on close.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";
import { expandHome } from "./repos.js";

/** Root that holds every drydock-managed worktree, `~`-expanded once here. */
export function worktreesRoot(): string {
  return expandHome(CONFIG.worktrees.root);
}

/** Run git in `cwd`, returning trimmed stdout. Throws on non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Is `dir` inside a git work tree? False for repo-less projects (→ no worktree). */
export function isGitWorkTree(dir: string): boolean {
  try {
    return git(dir, "rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}

/** The top-level of the work tree containing `dir` (its repo root). */
function topLevel(dir: string): string {
  return git(dir, "rev-parse", "--show-toplevel");
}

export interface WorktreePlan {
  /** Absolute path the worktree lives (or will live) at. */
  path: string;
  /** Branch checked out in it. */
  branch: string;
}

/**
 * Compute — without touching disk — where a ticket's worktree and branch would
 * live for the given repo checkout. Deterministic so the panel's preview and
 * the real spawn agree. Returns null when `repoCwd` isn't a git work tree.
 * `opts` lets a caller override the derived path/branch (panel edits).
 */
export function planWorktree(
  repoCwd: string,
  ticket: string,
  opts: { path?: string; branch?: string } = {},
): WorktreePlan | null {
  if (!isGitWorkTree(repoCwd)) return null;
  const repoName = path.basename(topLevel(repoCwd));
  const branch = opts.branch?.trim() || `agent/${ticket}`;
  const wtPath = opts.path?.trim()
    ? expandHome(opts.path.trim())
    : path.join(worktreesRoot(), `${repoName}-${ticket}`);
  return { path: wtPath, branch };
}

/** Does a registered git worktree already sit at `wtPath`? */
export function worktreeExists(wtPath: string): boolean {
  try {
    // A worktree has a `.git` *file* (a gitdir pointer), not a directory.
    return fs.existsSync(path.join(wtPath, ".git")) && isGitWorkTree(wtPath);
  } catch {
    return false;
  }
}

/** True if `branch` already exists as a local branch in `repoCwd`'s repo. */
function branchExists(repoCwd: string, branch: string): boolean {
  try {
    git(repoCwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

export interface EnsuredWorktree extends WorktreePlan {
  cwd: string; // == path; the session's spawn cwd
  reused: boolean;
}

/**
 * Create the ticket's worktree (or reuse an existing one) and return where the
 * session should spawn. Idempotent: a second spawn for the same ticket reattaches
 * to the same worktree/branch. Throws if the repo isn't git or git refuses —
 * the caller falls back to the plain repo cwd so a spawn never hard-fails.
 *
 * `git worktree add` branches from the repo's committed HEAD, so a dirty human
 * checkout is fine — uncommitted changes there simply don't come along.
 */
export function ensureWorktree(
  repoCwd: string,
  ticket: string,
  opts: { path?: string; branch?: string } = {},
): EnsuredWorktree {
  const plan = planWorktree(repoCwd, ticket, opts);
  if (!plan) throw new Error(`${repoCwd} is not a git repository`);

  // Already there from a prior spawn → reuse it, honoring its actual branch.
  if (worktreeExists(plan.path)) {
    let branch = plan.branch;
    try {
      branch = git(plan.path, "rev-parse", "--abbrev-ref", "HEAD");
    } catch {
      /* detached or odd state — keep the planned name for display */
    }
    return { ...plan, branch, cwd: plan.path, reused: true };
  }

  fs.mkdirSync(worktreesRoot(), { recursive: true });

  // Reuse the branch if it already exists (worktree was pruned but branch kept);
  // otherwise create it off the current HEAD.
  if (branchExists(repoCwd, plan.branch)) {
    git(repoCwd, "worktree", "add", plan.path, plan.branch);
  } else {
    git(repoCwd, "worktree", "add", "-b", plan.branch, plan.path);
  }
  return { ...plan, cwd: plan.path, reused: false };
}

/**
 * Remove a worktree on demand (prune). `--force` drops it even with uncommitted
 * changes, so this is deliberately explicit — never called on session close.
 * The branch itself is left intact for the human to merge or delete.
 */
export function removeWorktree(repoCwd: string, wtPath: string): void {
  const expanded = expandHome(wtPath);
  git(repoCwd, "worktree", "remove", "--force", expanded);
  // Tidy the admin metadata for any worktrees deleted out from under git.
  try {
    git(repoCwd, "worktree", "prune");
  } catch {
    /* best-effort */
  }
}
