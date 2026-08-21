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
//   (cd daemon && node --import tsx ../scripts/verify/stub-tracker.mts)
//
//   cd daemon
//   DRYDOCK_PORT=4390 DRYDOCK_HOST=127.0.0.1 DRYDOCK_SESSIONS_DIR=/tmp/d90 \
//     DRYDOCK_STATE_FILE=/tmp/dry90-state.json \
//     DRYDOCK_WORKTREES_ROOT=/tmp/dry90/wt DRYDOCK_REPO_PATHS=demo=/tmp/dry90/demo \
//     DRYDOCK_WORKTREE_REAP_MS=4000 \
//     DRYDOCK_TRACKER=switchyard DRYDOCK_SWITCHYARD_URL=http://127.0.0.1:4386 \
//     DRYDOCK_SWITCHYARD_TOKEN=stub node --import tsx src/index.ts
//
//   (cd daemon && node --import tsx ../scripts/verify/worktree-reap.mts)
//
// DRYDOCK_WORKTREES_ROOT is not optional and neither is DRYDOCK_REPO_PATHS:
// unset, the first points at ~/.drydock/worktrees — the root the dev and prod
// daemons share, full of real work — and this harness deletes worktrees for a
// living. It refuses to run against the default root for that reason.
//
// DRYDOCK_WORKTREE_REAP_MS must match REAP_MS below (default 4000). Six hours
// is the right default and a terrible test — the same trap DRY-49's timeout and
// DRY-60's sweep delay have — so this refuses a value it would have to wait out.
//
// Afterwards, kill the supervisor the in-use case leaves behind (CLAUDE.md's
// loop over /proc/<pid>/exe, never `pkill -f supervisor/main`) and `rm -rf
// /tmp/dry90`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Detail, SessionsResponse, SpawnResponse } from "./api.mjs";
import { addWorktree as addWt, buildFixture, commitIn, git, type Fixture } from "./git-fixture.mjs";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4390";
const ROOT = process.env.DRY90_ROOT ?? "/tmp/dry90";
const REPO = path.join(ROOT, "demo");
const WT_ROOT = path.join(ROOT, "wt");
/** Must equal the daemon's DRYDOCK_WORKTREE_REAP_MS. See the rig above. */
const REAP_MS = Number(process.env.REAP_MS ?? 4000);

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

async function main(): Promise<void> {
  if (!Number.isFinite(REAP_MS) || REAP_MS <= 0 || REAP_MS > 30_000) {
    console.error(
      `REAP_MS is ${REAP_MS}. This harness waits out a scheduled sweep, so run the\n` +
        `daemon with DRYDOCK_WORKTREE_REAP_MS at a few seconds and pass the same value\n` +
        `here. Passing against a six-hour interval by never reaching it is not a pass.`,
    );
    process.exit(2);
  }
  if (WT_ROOT.includes(".drydock/worktrees")) {
    console.error("refusing to run against the real worktrees root — see the rig above");
    process.exit(2);
  }
  const health = await fetch(`${DAEMON}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`no daemon on ${DAEMON} — see the rig at the top of this file`);
    process.exit(2);
  }

  console.log("building the git fixture…");
  fixture = buildFixture(ROOT);

  // --- 1. the policy, one worktree at a time -------------------------------
  //
  // Every case reaches the daemon through the same route a closed window uses,
  // so this is the policy AND the explicit trigger. The scheduled trigger is
  // section 3.
  console.log("\npolicy (POST /api/worktrees/reap)");

  // Merged and clean: the case the whole ticket is about. `agent/DRY-100` sits
  // exactly on origin/main, which is what a branch looks like after its PR was
  // merged and the branch was not advanced since.
  const merged = addWorktree("demo-DRY-100", "agent/DRY-100");
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: merged });
    check("merged + clean is reaped", json.removed === true && !there(merged), json.reason);
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
  const dirty = addWorktree("demo-DRY-101", "agent/DRY-101");
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
  const untracked = addWorktree("demo-DRY-102", "agent/DRY-102");
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
  const ignored = addWorktree("demo-DRY-103", "agent/DRY-103");
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
  {
    const { json } = await post<ReapResponse>("/api/worktrees/reap", { worktree: inUsePath });
    check(
      "a worktree with a live session is NOT reaped",
      json.removed === false && json.verdict === "in-use" && there(inUsePath),
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
  const sweepable = addWorktree("demo-DRY-200", "agent/DRY-200");
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
