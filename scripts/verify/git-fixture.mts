// A throwaway git repo for the worktree harnesses (DRY-90).
//
// Shared by `worktree-reap.mts` and `worktree-reap-ui.mts` because both need
// the SAME shape, and the shape is the part that is easy to get subtly wrong:
// a bare origin plus a clone. A plain `git init` has no upstream and no default
// branch, so every worktree of it reads as unsafe and a harness built on one
// passes against a reaper that never reaps anything.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * git, with identity and defaults forced on the command line.
 *
 * The fixture must not depend on the machine's ~/.gitconfig: a host with no
 * `user.email` cannot commit at all, and one with `init.defaultBranch=master`
 * would build a repo whose default branch the harness then names wrongly —
 * which presents as the merged case failing for a reason that has nothing to do
 * with what is under test.
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c", "user.email=harness@drydock.test",
      "-c", "user.name=drydock harness",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export interface Fixture {
  root: string;
  repo: string;
  origin: string;
  worktrees: string;
}

/**
 * Build (or REBUILD) the fixture at `root`, wiping whatever was there.
 *
 * The wipe is not tidiness. A worktree left dirty by a previous run is reused
 * by the next spawn of the same ticket (DRY-15 reuses rather than recreates),
 * so the case under test silently becomes "a dirty worktree" and the harness
 * reports a reap that was correctly refused as a feature that is broken. That
 * happened while this was being written.
 */
export function buildFixture(root: string): Fixture {
  const fixture: Fixture = {
    root,
    repo: path.join(root, "demo"),
    origin: path.join(root, "origin.git"),
    worktrees: path.join(root, "wt"),
  };
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "--bare", fixture.origin);
  git(root, "clone", fixture.origin, fixture.repo);
  fs.writeFileSync(path.join(fixture.repo, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(fixture.repo, ".gitignore"), "build/\n");
  git(fixture.repo, "add", "-A");
  git(fixture.repo, "commit", "-m", "initial");
  git(fixture.repo, "push", "-u", "origin", "HEAD:main");
  // A clone of an EMPTY bare repo sets no origin/HEAD, so it is set here rather
  // than assumed: `defaultBranchRef` falls back to origin/main when it is
  // missing, and a fixture leaning on the fallback would never exercise the
  // path a real clone takes.
  git(fixture.repo, "remote", "set-head", "origin", "main");
  git(fixture.repo, "fetch", "origin");
  fs.mkdirSync(fixture.worktrees, { recursive: true });
  return fixture;
}

/**
 * Add a worktree on a fresh branch, the way `ensureWorktree` does.
 *
 * The start point is the LOCAL `main`, not `origin/main`, and the difference is
 * not cosmetic: git's `branch.autoSetupMerge` default sets up tracking when a
 * branch starts from a remote-tracking ref, so branching off `origin/main`
 * gives every fixture worktree an upstream — and the "never pushed anywhere"
 * case then silently tests something else. DRY-15 branches off the human
 * checkout's HEAD, a local branch, so a real agent worktree has no upstream
 * until somebody pushes it.
 */
export function addWorktree(f: Fixture, name: string, branch: string, root?: string): string {
  const p = path.join(root ?? f.worktrees, name);
  git(f.repo, "worktree", "add", "-b", branch, p, "main");
  return p;
}

/** Commit a file inside a worktree (or the repo). */
export function commitIn(dir: string, file: string, text: string): void {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", `add ${file}`);
}
