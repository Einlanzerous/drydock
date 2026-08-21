// DRY-90: worktrees are reaped when their work is FINISHED, and never otherwise.
//
// Everything here is a negative claim wearing a positive one's clothes. It is
// easy to write a reaper that deletes the four stale checkouts on a host and
// impossible to notice, until months later, that it also deleted the one
// holding two commits nobody had pushed. So every case below is a pair: a
// worktree that must go, and a worktree that differs from it in exactly one
// respect and must stay.
//
// The two triggers are asserted separately because they are different code
// paths to the same policy: `POST /api/worktrees/reap` (what a closed window
// calls) and the scheduled sweep (what actually catches a merge). And the
// dependency this ticket rests on gets its own pair — `POST
// /api/worktrees/remove` passed `--force` unconditionally until now, so the
// primitive underneath the reaper ignored the safety check that IS the feature.
//
// Assert on the DIRECTORY, never on the response. The route can only report
// what it believes; whether a checkout is still on disk is the claim.
//
// RIG (three terminals; the harness builds its own git fixture, so nothing here
// touches a real repo):
//
//   (cd daemon && STUB_PORT=4396 node --import tsx ../scripts/verify/stub-tracker.mts)
//
//   cd daemon
//   DRYDOCK_PORT=4390 DRYDOCK_HOST=127.0.0.1 \
//     DRYDOCK_SESSIONS_DIR=/tmp/dry90-sessions/sessions-4390 \
//     DRYDOCK_STATE_FILE=/tmp/dry90-state.json \
//     DRYDOCK_WORKTREES_ROOT=/tmp/dry90/wt DRYDOCK_REPO_PATHS=demo=/tmp/dry90/demo \
//     DRYDOCK_WORKTREE_REAP_MS=4000 \
//     DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4396 \
//     DRYDOCK_SWITCHYARD_TOKEN=stub node --import tsx src/index.ts
//
//   (cd daemon && node --import tsx ../scripts/verify/worktree-reap.mts)
//
// DRYDOCK_WORKTREES_ROOT is not optional and neither is DRYDOCK_REPO_PATHS:
// unset, the first points at ~/.drydock/worktrees — the root the dev and prod
// daemons share, full of real work — and this harness deletes worktrees for a
// living. It asks the DAEMON where its root is and refuses to run if that isn't
// the fixture's; comparing its own constant against a drydock-looking string,
// which is what it did until review, cannot fail whatever the daemon is doing.
//
// DRYDOCK_SESSIONS_DIR is nested one level (`…/sessions-4390`) on purpose: the
// cross-daemon case writes a sibling `sessions-4999` next to it, which is how a
// daemon discovers that ANOTHER daemon has a live agent in a worktree it can
// see. Point it somewhere flat like /tmp and that sibling lands in /tmp.
//
// DRYDOCK_WORKTREE_REAP_MS must match REAP_MS below (default 4000). Six hours
// is the right default and a terrible test — the same trap DRY-49's timeout and
// DRY-60's sweep delay have — so this refuses a value it would have to wait out.
//
// Afterwards, kill the supervisor the in-use case leaves behind (CLAUDE.md's
// loop over /proc/<pid>/exe, never `pkill -f supervisor/main`) and `rm -rf
// /tmp/dry90 /tmp/dry90-sessions`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";
import {
  addWorktree as addWt,
  assertDaemonRoot,
  buildFixture,
  commitIn,
  git,
  mergeToDefault,
  type Fixture,
} from "./git-fixture.mjs";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4390";
const ROOT = process.env.DRY90_ROOT ?? "/tmp/dry90";
const REPO = path.join(ROOT, "demo");
const WT_ROOT = path.join(ROOT, "wt");
/** Must equal the daemon's DRYDOCK_WORKTREE_REAP_MS. See the rig above. */
const REAP_MS = Number(process.env.REAP_MS ?? 4000);
/**
 * Must equal the daemon's DRYDOCK_SESSIONS_DIR. Its PARENT is what matters: the
 * cross-daemon case below writes a sibling `sessions-4999` next to it, which is
 * how the daemon discovers another daemon's live sessions.
 */
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? "/tmp/dry90-sessions/sessions-4390";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n: string, ok: boolean, d: Detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) failures++;
};

interface ReapResponse {
  removed?: boolean;
  verdict?: string;
  reason?: string;
  branch?: string;
  error?: string;
}
interface RemoveResponse {
  ok?: boolean;
  error?: string;
  safety?: { clean?: boolean; unpushed?: number; merged?: boolean; reason?: string };
}

async function post<T>(route: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${DAEMON}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const wt = (name: string) => path.join(WT_ROOT, name);
const there = (p: string) => fs.existsSync(p);
/** Assigned by `buildFixture` before anything below runs. */
let fixture: Fixture;
const addWorktree = (name: string, branch: string, root?: string) => addWt(fixture, name, branch, root);

/**
 * A worktree whose branch has been genuinely merged — committed, pushed, and
 * `--no-ff` into main.
 *
 * Most cases here need this rather than a bare `git worktree add`, because a
 * freshly added branch sits exactly ON origin/main and that is what a branch
 * that has never committed anything looks like. Pairing "kept because dirty"
 * against a worktree that was never finished in the first place proves nothing
 * about the dirt.
 */
function mergedWorktree(name: string, branch: string, file: string): string {
  const p = addWorktree(name, branch);
  commitIn(p, file, `work for ${branch}\n`);
  git(p, "push", "-u", "origin", branch);
  mergeToDefault(fixture, branch);
  return p;
}

async function main(): Promise<void> {
  if (!Number.isFinite(REAP_MS) || REAP_MS <= 0 || REAP_MS > 30_000) {
    console.error(
      `REAP_MS is ${REAP_MS}. This harness waits out a scheduled sweep, so run the\n` +
        `daemon with DRYDOCK_WORKTREE_REAP_MS at a few seconds and pass the same value\n` +
        `here. Passing against a six-hour interval by never reaching it is not a pass.`,
    );
    process.exit(2);
  }
  const health = await fetch(`${DAEMON}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`no daemon on ${DAEMON} — see the rig at the top of this file`);
    process.exit(2);
  }

  console.log("building the git fixture…");
  fixture = buildFixture(ROOT);
  // AFTER the fixture and BEFORE a single worktree is created: the daemon can
  // only answer this once repo "demo" exists, and what it protects is the step
  // that follows. Review found the guard this replaces could never fire — it
  // compared the harness's own constant with a drydock-looking string, so the
  // one thing it claimed to catch (DRYDOCK_WORKTREES_ROOT missing from the rig,
  // leaving the daemon sweeping ~/.drydock/worktrees every 4s) walked straight
  // past it.
  await assertDaemonRoot(DAEMON, WT_ROOT);

  // --- 1. the policy, one worktree at a time -------------------------------
  //
  // Every case reaches the daemon through the same route a closed window uses,
  // so this is the policy AND the explicit trigger. The scheduled trigger is
  // section 3.
  console.log("\npolicy (POST /api/worktrees/reap)");

  // Merged and clean: the case the whole ticket is about. A REAL merge —
  // commit, push, then `--no-ff` into main — so the branch tip is contained in
  // origin/main without BEING it.
  //
  // This used to be a bare `git worktree add`, i.e. a branch sitting exactly on
  // origin/main, and review was right that it tested the wrong thing: that
  // shape is what a branch that has never committed anything looks like, which
  // the reaper now refuses to call finished. `DRY-100` is in no tracker, so if
  // the merge stopped counting this case would fail rather than pass by another
  // route.
  const merged = mergedWorktree("demo-DRY-100", "agent/DRY-100", "feature.txt");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: merged });
    check("merged + clean is reaped", json.removed === true && !there(merged), json.reason);
    check(
      "…on the strength of the MERGE, not a tracker lookup",
      json.reason === "merged into origin/main",
      json.reason,
    );
    // Trap 3: the branch is not the worktree. Reaping a branch is a different
    // and much less safe decision, and out of scope.
    const branches = git(REPO, "branch", "--list", "agent/DRY-100");
    check("its branch survives", branches.includes("agent/DRY-100"), branches || "(gone)");
    // Trap 1: `rm -rf` would leave admin metadata in .git/worktrees/, so the
    // branch stays "checked out somewhere" and a later re-spawn of the same
    // ticket cannot re-add it. Proved by re-adding it, which is the operation
    // that would fail.
    let readded = "";
    try {
      git(REPO, "worktree", "add", merged, "agent/DRY-100");
      readded = "ok";
    } catch (err) {
      readded = String(err);
    }
    check("the same worktree can be re-added afterwards", readded === "ok", readded);
    git(REPO, "worktree", "remove", "--force", merged);
  }

  // Merged, but with a tracked file modified. Everything the reaper looks at
  // says go except the one thing that matters.
  const dirty = mergedWorktree("demo-DRY-101", "agent/DRY-101", "a.txt");
  fs.writeFileSync(path.join(dirty, "README.md"), "# demo\nlocal edit nobody committed\n");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: dirty });
    check(
      "merged but MODIFIED is kept",
      json.removed === false && json.verdict === "unsafe" && there(dirty),
      json.reason,
    );
    check("…and says what it found", /uncommitted/.test(json.reason ?? ""), json.reason);
  }

  // Merged, clean by every other measure, one untracked file. This is the case
  // a "git status is clean" shortcut gets wrong, and the file it deletes is
  // somebody's scratch note.
  const untracked = mergedWorktree("demo-DRY-102", "agent/DRY-102", "b.txt");
  fs.writeFileSync(path.join(untracked, "notes.md"), "half an idea\n");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: untracked });
    check(
      "merged but UNTRACKED file is kept",
      json.removed === false && json.verdict === "unsafe" && there(untracked),
      json.reason,
    );
  }

  // The inverse, and the reason `--porcelain` is read rather than `--ignored`:
  // build output is reproducible, and counting it would make every worktree of
  // every real project permanently unreapable.
  const ignored = mergedWorktree("demo-DRY-103", "agent/DRY-103", "c.txt");
  fs.mkdirSync(path.join(ignored, "build"));
  fs.writeFileSync(path.join(ignored, "build/out.js"), "// generated\n");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: ignored });
    check("an IGNORED file doesn't block it", json.removed === true && !there(ignored), json.reason);
  }

  // Clean, pushed once, then two commits git alone would happily delete. This
  // is the half `git worktree remove` has no opinion about at all — it removes
  // a clean worktree holding unpushed commits without a murmur.
  const unpushed = addWorktree("demo-DRY-104", "agent/DRY-104");
  git(unpushed, "push", "-u", "origin", "agent/DRY-104");
  commitIn(unpushed, "a.txt", "one\n");
  commitIn(unpushed, "b.txt", "two\n");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: unpushed });
    check(
      "clean but UNPUSHED commits is kept",
      json.removed === false && json.verdict === "unsafe" && there(unpushed),
      json.reason,
    );
    check("…and counts them", /2 unpushed commits/.test(json.reason ?? ""), json.reason);
  }

  // A branch that was never pushed anywhere. Nothing can say whether this is
  // finished, so nothing may delete it.
  const noUpstream = addWorktree("demo-DRY-105", "agent/DRY-105");
  commitIn(noUpstream, "c.txt", "three\n");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: noUpstream });
    check(
      "no upstream and not merged is kept",
      json.removed === false && json.verdict === "unsafe" && there(noUpstream),
      json.reason,
    );
    // The reason has to name the missing upstream rather than count commits
    // against one: a branch that has never been pushed is unsafe because
    // nothing can say where its work went, not because of how much of it there
    // is. This read "1 unpushed commit" while every fixture branch was being
    // started from origin/main and quietly inheriting a tracking ref.
    check(
      "…because there is no upstream, not because of a count",
      /no upstream branch/.test(json.reason ?? ""),
      json.reason,
    );
  }

  // --- 2. the tracker's half ------------------------------------------------
  //
  // Pushed but not merged is SAFE — every commit is on the remote — so the
  // predicate has nothing left to say and the question becomes whether the work
  // is finished. That is the squash-merge case in real life: the squashed
  // commit is a different object, so containment says no while the ticket has
  // been closed for a week. The stub tracker has DRY-2 in progress and DRY-3
  // closed.
  console.log("\nthe tracker decides what git can't");
  const open = addWorktree("demo-DRY-2", "agent/DRY-2");
  commitIn(open, "open.txt", "wip\n");
  git(open, "push", "-u", "origin", "agent/DRY-2");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: open });
    check(
      "safe but its ticket is OPEN → kept",
      json.removed === false && json.verdict === "unfinished" && there(open),
      json.reason,
    );
  }
  const closed = addWorktree("demo-DRY-3", "agent/DRY-3");
  commitIn(closed, "done.txt", "shipped\n");
  git(closed, "push", "-u", "origin", "agent/DRY-3");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: closed });
    check(
      "safe and its ticket is CLOSED → reaped",
      json.removed === true && !there(closed),
      json.reason,
    );
  }

  // --- 2b. a branch that has never committed anything -----------------------
  //
  // Review's find, and the sharpest case in this file. A freshly added worktree
  // sits exactly ON origin/main, so `merge-base --is-ancestor` says yes and the
  // obvious reading — "merged, therefore finished" — reaps it without ever
  // asking the tracker. That is evidence of nothing having happened being read
  // as evidence the work is done, and it is not a hypothetical: it is the shape
  // of every worktree between `git worktree add` and the agent's first commit.
  //
  // Both halves are checked, because only the pair distinguishes "asks the
  // tracker" from "never reaps a fresh worktree".
  const fresh = addWorktree("demo-DRY-4", "agent/DRY-4");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: fresh });
    check(
      "a branch with NO commits and an open ticket is kept",
      json.removed === false && json.verdict === "unfinished" && there(fresh),
      json.reason,
    );
    check("…named as the open ticket, not as a merge", /DRY-4 is still open/.test(json.reason ?? ""), json.reason);
  }
  // The same shape with a CLOSED ticket must still go — otherwise this rule is
  // just "never reap a fresh worktree", which would leave exactly the litter
  // the ticket is about. `agent/DRY-3` is recreated from scratch so it sits on
  // origin/main again.
  git(fixture.repo, "branch", "-D", "agent/DRY-3");
  const freshClosed = addWorktree("demo-DRY-3", "agent/DRY-3");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: freshClosed });
    check(
      "…and with a CLOSED ticket it is reaped",
      json.removed === true && !there(freshClosed),
      json.reason,
    );
  }

  // --- 2c. a detached HEAD --------------------------------------------------
  //
  // What a removal promises is that the work is kept on the branch. Detached
  // there is no branch, so that is a promise this cannot make — whatever the
  // commit's containment says.
  const detached = addWorktree("demo-DRY-109", "agent/DRY-109");
  git(detached, "checkout", "--detach", "HEAD");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: detached });
    check(
      "a detached HEAD is kept",
      json.removed === false && json.verdict === "unsafe" && there(detached),
      json.reason,
    );
    check("…and says why", /detached HEAD/.test(json.reason ?? ""), json.reason);
  }

  // --- 3. a live session outranks everything --------------------------------
  //
  // Trap 2, and the one failure here that would cost somebody an agent rather
  // than a directory. The worktree is created by the daemon's own spawn path,
  // so it is merged and clean — every other test in this file says reap it —
  // and the only thing standing in the way is that something is running in it.
  console.log("\na session in the worktree");
  const spawn = await post<SpawnResponse & { error?: string }>("/api/sessions", {
    command: "/bin/sh",
    args: ["-c", "sleep 300"],
    repo: "demo",
    ticket: "DRY-106",
  });
  const inUsePath = spawn.json.session?.worktree ?? wt("demo-DRY-106");
  check("the spawn isolated into a worktree", !!spawn.json.session?.worktree, inUsePath);
  // Merged while the session runs in it, so that every other test in this file
  // says remove it and the ONLY thing in the way is the session. Without this
  // the worktree would be held back by having no commits, and the check would
  // pass against a reaper that had never heard of the registry.
  commitIn(inUsePath, "busy.txt", "an agent is working here\n");
  git(inUsePath, "push", "-u", "origin", "agent/DRY-106");
  mergeToDefault(fixture, "agent/DRY-106");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: inUsePath });
    check(
      "a worktree with a live session is NOT reaped",
      json.removed === false && json.verdict === "in-use" && there(inUsePath),
      json.reason,
    );
  }

  // --- 3b. a session belonging to ANOTHER daemon ----------------------------
  //
  // The registry is per-process; `~/.drydock/worktrees` is per HOST. So the
  // prod daemon on :4318 can see the dev daemon's worktrees, and its own
  // registry answers "not in use" about them perfectly truthfully — after which
  // a live agent loses its checkout mid-run, because `git worktree remove` does
  // not care that a process is cwd'd inside. Review found this; nothing in the
  // single-daemon rig could have.
  //
  // Simulated the way it actually presents: a sibling sessions directory beside
  // this daemon's, holding one session record that names the worktree. That is
  // exactly what another daemon's DRY-57 index looks like from here.
  const sibling = path.join(path.dirname(SESSIONS_DIR), "sessions-4999");
  const foreign = mergedWorktree("demo-DRY-110", "agent/DRY-110", "e.txt");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(
    path.join(sibling, "11111111-2222-3333-4444-555555555555.json"),
    JSON.stringify({ id: "11111111-2222-3333-4444-555555555555", cwd: foreign, worktree: foreign }),
  );
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: foreign });
    check(
      "another daemon's live session protects it too",
      json.removed === false && json.verdict === "in-use" && there(foreign),
      json.reason,
    );
  }
  fs.rmSync(sibling, { recursive: true, force: true });
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: foreign });
    check(
      "…and it goes once that daemon has forgotten it",
      json.removed === true && !there(foreign),
      json.reason,
    );
  }

  // --- 4. the route's blast radius -----------------------------------------
  //
  // The reap route is the one a client calls with no human reading a
  // confirmation first, so it may only act on worktrees this daemon manages.
  console.log("\nscope");
  const outside = addWorktree("outside-DRY-107", "agent/DRY-107", ROOT);
  {
    const res = await fetch(`${DAEMON}/api/worktrees/reap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktree: outside }),
    });
    check(
      "a worktree outside the managed root is refused",
      res.status === 404 && there(outside),
      `${res.status}`,
    );
  }

  // --- 5. the dependency: remove without --force ----------------------------
  //
  // `removeWorktree` passed `--force` unconditionally until DRY-90, so the
  // panel's Reset button deleted uncommitted work without mentioning it — and
  // the reaper would have been a scheduled job on top of a primitive that
  // ignored its own safety check.
  console.log("\nPOST /api/worktrees/remove");
  const resettable = addWorktree("demo-DRY-108", "agent/DRY-108");
  fs.writeFileSync(path.join(resettable, "README.md"), "# demo\nunsaved\n");
  {
    const { status, json } = await post<RemoveResponse>("/api/worktrees/remove", {
      repo: "demo",
      worktree: resettable,
    });
    check(
      "a dirty worktree is refused (409), not deleted",
      status === 409 && there(resettable),
      `${status} ${json.error ?? ""}`,
    );
    check("…with the safety report attached", json.safety?.clean === false, JSON.stringify(json.safety));
  }
  {
    const { status } = await post<RemoveResponse>("/api/worktrees/remove", {
      repo: "demo",
      worktree: resettable,
      force: true,
    });
    check("force: true still discards it", status === 200 && !there(resettable), `${status}`);
  }

  // --- 6. the scheduled sweep ----------------------------------------------
  //
  // The trigger that actually matters: a merge happens with the daemon down or
  // with nobody telling it, so the only thing that ever notices is a sweep. The
  // boot sweep and this one are the same call; this is the one a harness can
  // reach without restarting a daemon that holds live sessions.
  console.log(`\nthe scheduled sweep (waiting out ${REAP_MS}ms)`);
  const sweepable = mergedWorktree("demo-DRY-200", "agent/DRY-200", "d.txt");
  const keepable = addWorktree("demo-DRY-201", "agent/DRY-201");
  fs.writeFileSync(path.join(keepable, "README.md"), "# demo\nstill editing\n");
  await sleep(REAP_MS * 2 + 1500);
  check("the sweep reaps a finished worktree on its own", !there(sweepable), sweepable);
  check("…and leaves the dirty one where it is", there(keepable), keepable);
  // The live session must survive a sweep as well as a request — they are the
  // same policy, and this is the one that runs with nobody present.
  check("…and does not touch the one with a session in it", there(inUsePath), inUsePath);

  const list = (await (await fetch(`${DAEMON}/api/sessions`)).json()) as SessionsResponse;
  const stillRunning = list.sessions.find((s) => s.id === spawn.json.session?.id);
  check("…and the session is still running", stillRunning?.status === "running", stillRunning?.status);

  console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
  process.exit(failures ? 1 : 0);
}

await main();
