// Does a dead agent's conversation still exist on disk? (DRY-62)
//
// A tombstone offers "Resume" on `command === "claude" && agentSessionId`, and
// that pair is not enough to promise one. `agent_session_id` comes from the
// SessionStart hook, which fires whether or not the CLI is persisting anything
// — so every session a pre-DRY-59 daemon spawned recorded an id whose
// transcript was never written. The card promised to resume a conversation and
// the click produced a fresh pane with the CLI's own "no conversation found".
//
// So the daemon looks. It is the only party that can: whether a transcript
// exists is a filesystem fact on the host, and the browser is not on it.
//
// The answer is deliberately three-valued — see `knownTranscripts`. "I could
// not look" must not read as "it is gone", or an unreadable config directory
// would silently downgrade every Resume on the desk to Start again, which is
// the failure this module was written to prevent, inverted.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "./log.js";

/**
 * Where Claude Code keeps transcripts: `<config dir>/projects/<cwd>/<id>.jsonl`.
 *
 * Reading the daemon's OWN `CLAUDE_CONFIG_DIR` is correct rather than lucky:
 * DRY-59 strips the launching session's markers from a spawned agent's
 * environment but deliberately passes this one through, because it is host
 * config. Daemon and agent therefore always agree on it. If that ever stops
 * being true, this lookup silently answers for the wrong directory.
 */
function projectsDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configured || path.join(os.homedir(), ".claude"), "projects");
}

/**
 * A whole scan, cached briefly.
 *
 * The shell already floors history refreshes at 15s per tab, so this is really
 * insurance against tab count: five open desks reconciling at once should cost
 * one directory walk, not five. Staleness is harmless here — the records being
 * checked belong to sessions that have already ended, so their transcripts
 * stopped changing before the question was asked.
 */
const CACHE_TTL_MS = 5_000;
let cache: { at: number; ids: Set<string> | undefined } | undefined;
/** Whether the "couldn't read it" line has already been said. See scan(). */
let warned = false;

/**
 * Every agent session id with a transcript on this host, or `undefined` if the
 * directory could not be read at all.
 *
 * Scanning for the id rather than deriving the path from the record's cwd is
 * the point of doing it this way. Claude Code names each project directory by
 * escaping the cwd (`/` and `.` both become `-`, among others), and a fix built
 * on reimplementing that escaping would report "no transcript" for every
 * session whose path contained a character guessed wrong — i.e. it would fail
 * in exactly the direction that takes Resume away from sessions that have one.
 * Session ids are UUIDs, so a flat index of them cannot collide.
 */
export function knownTranscripts(): Set<string> | undefined {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ids;
  const ids = scan();
  cache = { at: now, ids };
  return ids;
}

function scan(): Set<string> | undefined {
  const root = projectsDir();
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // Once per daemon, not once per poll: on a host with no Claude Code install
    // this is the normal state of the world, and it is being asked every few
    // seconds. The consequence — tombstones keep offering Resume — is the
    // pre-DRY-62 behaviour, which is a degradation and not a fault.
    if (!warned) {
      warned = true;
      log.warn("could not read the transcript directory — tombstones cannot check for one", {
        dir: root,
        err: String(err),
      });
    }
    return undefined;
  }

  const ids = new Set<string>();
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, project.name));
    } catch {
      // A project directory that vanished mid-walk costs its own sessions their
      // Resume button and nothing else. Failing the whole scan over one would
      // cost every session on the desk theirs.
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) ids.add(entry.slice(0, -".jsonl".length));
    }
  }
  return ids;
}
