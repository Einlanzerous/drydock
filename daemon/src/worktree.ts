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
//
// DRY-90 built the other half of that policy, which had never existed: nothing
// reaped, so a host accumulated a full checkout per ticket forever. Removal is
// still never triggered by a window closing (see worktree-reaper.ts for why
// that is the wrong signal), but a worktree whose work is FINISHED and whose
// checkout holds nothing unrecoverable is now removed on a schedule. The
// predicate that decides "nothing unrecoverable" is `worktreeSafety` below, and
// `removeWorktree` enforces it rather than trusting its callers — it used to
// pass `--force` unconditionally, which would have made the reaper a scheduled
// job whose primitive ignored its own safety check.
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

/** Run git in `cwd`, returning trimmed stdout — or null if git said no. */
function gitTry(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

/** Does `cwd` satisfy this git command (exit 0)? For `--is-ancestor` and friends. */
function gitOk(cwd: string, ...args: string[]): boolean {
  return gitTry(cwd, ...args) !== null;
}

/** What `worktreeSafety` found in a worktree. */
export interface WorktreeSafety {
  /** Nothing modified, staged or untracked (ignored files don't count). */
  clean: boolean;
  /** Commits on HEAD that its upstream doesn't have; -1 when there is no upstream. */
  unpushed: number;
  /** HEAD is an ancestor of the repo's default branch — the merged case. */
  merged: boolean;
  /** The default branch that was compared against, when one was found. */
  defaultBranch?: string;
  /** Nothing here exists only here: the checkout may be removed. */
  safe: boolean;
  /** Why not, as a sentence — for the route's 409 and the reaper's log line. */
  reason?: string;
}

/**
 * The remote-tracking ref this repo treats as its default branch.
 *
 * `origin/HEAD` is the honest answer and is what a clone sets up, but it is
 * absent on plenty of real checkouts (`git remote set-head` was never run, or
 * the repo was created locally), so the two conventional names are tried after
 * it. Nothing is guessed beyond that: an unfound default branch makes `merged`
 * false, which can only ever make this MORE conservative.
 */
function defaultBranchRef(cwd: string): string | undefined {
  const head = gitTry(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (head) return head;
  for (const name of ["origin/main", "origin/master"]) {
    if (gitOk(cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/${name}`)) return name;
  }
  return undefined;
}

/**
 * Whether a worktree holds anything that only exists here (DRY-90).
 *
 * The whole of the reaper is this predicate; everything else is a trigger for
 * evaluating it, and no trigger may bypass it. Two questions, both cheap and
 * both local:
 *
 *  - is the checkout clean — nothing modified, nothing staged, nothing
 *    untracked. IGNORED files don't count and shouldn't: a `node_modules` or a
 *    `dist` is reproducible, and counting it would make every worktree of every
 *    real project permanently unreapable. An untracked file is the opposite —
 *    a scratch note or a half-written module nobody has committed is exactly
 *    the thing this must not throw away.
 *  - is every commit somewhere else — pushed to the branch's upstream, or
 *    already contained in the repo's default branch (the merged case, which is
 *    what makes a finished ticket reapable at all).
 *
 * A question git can't answer is answered NO. No upstream and not merged is
 * unsafe, a detached or unborn HEAD is unsafe, a repo that has moved out from
 * under the worktree is unsafe — because the alternative to "leave it alone" is
 * deleting the only copy of something.
 */
export function worktreeSafety(wtPath: string): WorktreeSafety {
  const cwd = expandHome(wtPath);
  const status = gitTry(cwd, "status", "--porcelain");
  if (status === null) {
    // Not a work tree any more — an unmounted disk, a repo that moved, a
    // directory somebody deleted by hand. Never our business to remove.
    return { clean: false, unpushed: -1, merged: false, safe: false, reason: "git can't read it" };
  }
  const clean = status === "";
  const dirtyCount = status === "" ? 0 : status.split("\n").length;

  const defaultBranch = defaultBranchRef(cwd);
  // `merge-base --is-ancestor` is the containment test, and it answers for a
  // squash-merge with a NO — the squashed commit is a different object, so the
  // branch tip is not an ancestor of anything. That case is caught by the
  // upstream test below (the commits are still on the remote) or, failing that,
  // by the ticket being closed; it is never caught by pretending this said yes.
  const merged = !!defaultBranch && gitOk(cwd, "merge-base", "--is-ancestor", "HEAD", defaultBranch);

  const upstream = gitTry(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  let unpushed = -1;
  if (upstream) {
    const count = gitTry(cwd, "rev-list", "--count", `${upstream}..HEAD`);
    unpushed = count === null ? -1 : Number(count);
    if (!Number.isFinite(unpushed)) unpushed = -1;
  }

  const safe = clean && (merged || unpushed === 0);
  if (safe) return { clean, unpushed, merged, defaultBranch, safe };

  const why: string[] = [];
  if (!clean) why.push(`${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"}`);
  if (!merged && unpushed > 0) why.push(`${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`);
  if (!merged && unpushed === -1) {
    why.push(
      upstream
        ? "git couldn't compare it with its upstream"
        : defaultBranch
          ? `no upstream branch, and not merged into ${defaultBranch}`
          : "no upstream branch and no default branch to compare with",
    );
  }
  return { clean, unpushed, merged, defaultBranch, safe, reason: why.join(" and ") };
}

/**
 * Refusal to remove a worktree that holds something unrecoverable (DRY-90).
 *
 * Its own class so the route can answer 409 with the safety report attached,
 * rather than turning every git failure into the same 500. A caller that means
 * it passes `force`.
 */
export class WorktreeNotSafe extends Error {
  constructor(
    readonly worktree: string,
    readonly safety: WorktreeSafety,
  ) {
    super(`${worktree} has ${safety.reason ?? "work that only exists here"}`);
    this.name = "WorktreeNotSafe";
  }
}

/**
 * Remove a worktree (prune). The branch itself is left intact for the human to
 * merge or delete — reaping a branch is a different and much less safe decision.
 *
 * `--force` used to be passed UNCONDITIONALLY (DRY-15), which was defensible
 * while the only caller was a button somebody pressed and indefensible the
 * moment anything scheduled called it: DRY-90's reaper would have been a cron
 * job whose primitive ignored the safety check that is the entire feature. So
 * the predicate runs first and refuses, and `force` is the explicit opt-out for
 * a human who has been told what they are discarding.
 *
 * Plain `git worktree remove` refuses a dirty checkout on its own, which makes
 * the check above look redundant. It isn't: git has no opinion about UNPUSHED
 * COMMITS — a clean worktree holding three commits nobody has ever seen is
 * removed without a murmur — and `WorktreeNotSafe` says which of the two it is,
 * where git says "contains modified or untracked files" or nothing at all.
 */
export function removeWorktree(
  repoCwd: string,
  wtPath: string,
  opts: { force?: boolean } = {},
): void {
  const expanded = expandHome(wtPath);
  if (!opts.force) {
    const safety = worktreeSafety(expanded);
    if (!safety.safe) throw new WorktreeNotSafe(expanded, safety);
  }
  git(repoCwd, "worktree", "remove", ...(opts.force ? ["--force"] : []), expanded);
  // Tidy the admin metadata for any worktrees deleted out from under git.
  try {
    git(repoCwd, "worktree", "prune");
  } catch {
    /* best-effort */
  }
}

/** A drydock-managed worktree found on disk, with the repo it belongs to. */
export interface ManagedWorktree {
  /** Absolute path of the worktree itself. */
  path: string;
  /** The MAIN worktree of the repo it was added from — where git commands run. */
  repoDir: string;
  /** Branch checked out in it, or undefined when HEAD is detached. */
  branch?: string;
  /** Tracker key this worktree belongs to, when one can be read off it. */
  ticket?: string;
}

/** `agent/DRY-90` → `DRY-90`; also matches a bare `<repo>-DRY-90` directory name. */
const TICKET_RE = /([A-Za-z][A-Za-z0-9]*-\d+)$/;

/**
 * The main worktree of the repo `wtPath` was added from.
 *
 * Read off `git worktree list`, whose first entry is always the main worktree,
 * rather than resolving the ticket's repo name through `resolveRepoCwd`: the
 * host's repo mapping can change (or never have covered this repo), and the
 * only checkout entitled to remove this worktree is the one that added it.
 */
function mainWorktreeOf(wtPath: string): string | undefined {
  const listing = gitTry(wtPath, "worktree", "list", "--porcelain");
  const first = listing?.split("\n").find((line) => line.startsWith("worktree "));
  return first?.slice("worktree ".length).trim() || undefined;
}

/**
 * Read one managed worktree off disk, or undefined if that isn't what it is.
 *
 * The scoping rule lives here, and it is the parent directory rather than a
 * string prefix: `worktreesRoot()` is where this daemon puts things, and
 * `/api/worktrees/reap` — the route a client calls with no human reading a
 * confirmation first — may act on nothing else. (`/api/worktrees/remove` will
 * still act on any path it is handed; it always has, and it is somebody
 * pressing a button.)
 */
export function describeManagedWorktree(wtPath: string): ManagedWorktree | undefined {
  const expanded = expandHome(wtPath);
  if (!samePath(path.dirname(expanded), worktreesRoot())) return undefined;
  if (!worktreeExists(expanded)) return undefined;
  const repoDir = mainWorktreeOf(expanded);
  if (!repoDir) return undefined;
  const head = gitTry(expanded, "rev-parse", "--abbrev-ref", "HEAD");
  const branch = head && head !== "HEAD" ? head : undefined;
  // The branch is the better source — it is what `ensureWorktree` derived the
  // key from — but the panel can override it, so the directory name (which it
  // can override too) is the fallback and neither is required.
  const ticket = branch?.match(TICKET_RE)?.[1] ?? path.basename(expanded).match(TICKET_RE)?.[1];
  return { path: expanded, repoDir, branch, ticket };
}

/**
 * Every drydock-managed worktree currently on disk (DRY-90).
 *
 * Scoped to `worktreesRoot()` and nothing else, so a repo the human keeps a
 * worktree of by hand is not something the reaper can ever have an opinion
 * about.
 */
export function listManagedWorktrees(): ManagedWorktree[] {
  const root = worktreesRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no root yet, or unreadable — nothing managed, nothing to do
  }
  const out: ManagedWorktree[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const described = describeManagedWorktree(path.join(root, entry.name));
    if (described) out.push(described);
  }
  return out;
}

/** True when `a` and `b` name the same directory, `~` and symlinks aside. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => {
    const e = expandHome(p);
    try {
      return fs.realpathSync(e);
    } catch {
      return path.resolve(e);
    }
  };
  return norm(a) === norm(b);
}
