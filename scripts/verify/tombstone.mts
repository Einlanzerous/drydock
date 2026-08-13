// A tombstone's button tells the truth about the conversation behind it (DRY-62).
//
// The gate used to be `command === "claude" && agentSessionId`, and that pair
// cannot answer the question it was standing in for. `agent_session_id` comes
// from the SessionStart hook, which fires whether or not the CLI is persisting
// anything — so every session a pre-DRY-59 daemon spawned recorded an id whose
// transcript was never written, and the card offered to reopen a conversation
// that was never on disk. The click produced a fresh pane with the CLI's own
// "no conversation found".
//
// Browser, because the claim IS the button: which word it shows and which args
// the click sends. `curl /api/sessions/history` shows the flag either way.
//
// The rig is in this directory's README. Two things it deliberately does NOT
// need: no SQL (the agent session id is planted through the daemon's own
// SessionStart hook, exactly as a real agent reports it), and no API tokens
// (the spawned `claude` is never prompted — it sits at its composer and is
// killed). What it does need is a database tier, since tombstones are drawn
// from history and only Postgres retains it.
//
// Run from `daemon/`, where tsx resolves (DRY-80) — note CLAUDE_CONFIG_DIR has
// to be the same value the daemon was started with:
//   (cd daemon && CLAUDE_CONFIG_DIR=/tmp/dry62-claude \
//      node --import tsx ../scripts/verify/tombstone.mts)
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright";
import type { HistoryResponse, SessionRecord, SessionsResponse, SpawnResponse } from "./api.mjs";

const DAEMON = process.env.DRY62_DAEMON ?? "http://127.0.0.1:4392";
const SHELL = process.env.DRY62_SHELL ?? "http://127.0.0.1:5392";
// Must match the CLAUDE_CONFIG_DIR the daemon was started with; the daemon
// resolves transcripts from its own environment (see daemon/src/transcripts.ts).
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? "/tmp/dry62-claude";

const AGENT_ID = "00000000-dead-4000-8000-00000000d62a";
const TRANSCRIPT = path.join(CONFIG_DIR, "projects", "-dry62-probe", `${AGENT_ID}.jsonl`);

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

/**
 * The 204/unparseable case really does yield null, and the cast folds it in —
 * one deliberate assertion at the boundary rather than a `!` at every call
 * site. Every caller below either names the route's real response type (which
 * IS checked, against the daemon's own) or ignores the result entirely.
 */
const api = async <T,>(p: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${DAEMON}${p}`, init);
  if (!res.ok && res.status !== 404) throw new Error(`${p} -> ${res.status}`);
  return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
};

/** A dead `claude` session in history, carrying an agent id we chose. */
async function deadSessionWithAgentId(): Promise<string> {
  const spawned = await api<SpawnResponse>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // No `input`: an unprompted claude costs nothing and still records a
    // session. Its own hook may report a real id first, so ours is planted
    // after — `agent_session_id` is written `where agent_session_id is null`,
    // which means FIRST writer wins and a later plant would be dropped.
    body: JSON.stringify({ command: "claude", cwd: "/tmp", title: "dry62-probe" }),
  });
  const id = spawned.session.id;
  await api("/hook/sessionstart", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-drydock-session": id },
    body: JSON.stringify({ session_id: AGENT_ID }),
  });
  await api(`/api/sessions/${id}/kill`, { method: "POST" });
  return id;
}

/** A desk holding one window for that session, so restore has to render it. */
async function seedDesk(sessionId: string): Promise<void> {
  await api("/api/workspace", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      version: 2,
      layout: "float",
      windows: [
        {
          id: sessionId,
          kind: "terminal",
          type: "agent",
          title: "dry62-probe",
          repo: "drydock",
          x: 60,
          y: 60,
          w: 900,
          h: 560,
          z: 1,
          minimized: false,
        },
      ],
    }),
  });
}

function setTranscript(present: boolean): Promise<void> {
  if (present) {
    fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
    fs.writeFileSync(TRANSCRIPT, "");
  } else {
    fs.rmSync(TRANSCRIPT, { force: true });
  }
  // The daemon caches a whole scan for a few seconds; outlast it rather than
  // reaching into the daemon to invalidate one.
  return new Promise((r) => setTimeout(r, 6000));
}

/** The tombstone's primary button and the note under it. */
interface Card {
  label: string;
  note: string;
}

async function readCard(page: Page): Promise<Card> {
  await page.goto(SHELL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar");
  await page.waitForSelector(".tomb", { timeout: 20000 });
  return page.evaluate(() => {
    const tomb = document.querySelector(".tomb");
    return {
      label: tomb?.querySelector("button.primary")?.textContent?.trim() ?? "(none)",
      note: tomb?.querySelector(".note")?.textContent?.trim() ?? "",
    };
  });
}

const sessionId = await deadSessionWithAgentId();
await seedDesk(sessionId);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => console.log("  PAGE ERROR:", e.message));

await setTranscript(true);
let card = await readCard(page);
check(
  "transcript on disk -> offers to reopen the conversation",
  card.label === "Resume" && card.note === "",
  `label=${JSON.stringify(card.label)} note=${JSON.stringify(card.note)}`,
);

await setTranscript(false);
card = await readCard(page);
check(
  "transcript gone -> says so, rather than promising a resume",
  card.label === "Start again" && card.note.includes("transcript is no longer on disk"),
  `label=${JSON.stringify(card.label)} note=${JSON.stringify(card.note)}`,
);

// The label is only half of it. A card that SAYS "Start again" and still sends
// `--resume <id>` is the same bug wearing better copy, and the two verdicts are
// computed in different files — hence the shared predicate they both call.
const before = await api<SessionsResponse>("/api/sessions");
await page.click(".tomb button.primary");
await page.waitForTimeout(4000);
const after = await api<SessionsResponse>("/api/sessions");
const fresh = after.sessions.filter((s) => !before.sessions.some((b) => b.id === s.id));
check(
  "and the click agrees with the label — no --resume for a missing transcript",
  fresh.length > 0 && fresh.every((s) => !s.args.includes("--resume")),
  fresh.length ? `args=${JSON.stringify(fresh[0].args)}` : "the button spawned nothing",
);
for (const s of fresh) await api(`/api/sessions/${s.id}/kill`, { method: "POST" });

// Assert on OUR record, not on a count: clicking the button above spawned a
// second session, and whether its own hook lands before the kill is a race. A
// count makes this harness fail on the timing of something it isn't testing.
const ours = (records: SessionRecord[]) => records.find((r) => r.agentSessionId === AGENT_ID);
check(
  "the dangling record is the one carrying the flag",
  ours((await api<HistoryResponse>("/api/sessions/history")).sessions)?.transcriptMissing === true,
  "with the transcript still deleted",
);

// "Could not look" must not read as "it is gone". A daemon that cannot read the
// transcript directory has to leave every Resume alone rather than strip the
// button from every conversation on the desk — the failure this whole change
// exists to prevent, inverted and applied to all of them at once. Take the
// directory away underneath it rather than mocking anything.
const projects = path.join(CONFIG_DIR, "projects");
const mode = fs.statSync(projects).mode;
fs.chmodSync(projects, 0o000);
try {
  await new Promise((r) => setTimeout(r, 6000)); // outlast the scan cache
  const blind = ours((await api<HistoryResponse>("/api/sessions/history")).sessions);
  check(
    "an unreadable transcript directory says nothing, rather than 'all gone'",
    blind !== undefined && blind.transcriptMissing === undefined,
    `transcriptMissing=${JSON.stringify(blind?.transcriptMissing)} (want undefined)`,
  );
} finally {
  fs.chmodSync(projects, mode);
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
