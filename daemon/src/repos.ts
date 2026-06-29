// Ticket repo → working-directory resolution (DRY-9 ticket-spawn).
//
// When an agent is spawned from a ticket, it should start in that ticket's
// real repo on this host — not the daemon's home dir. The browser only knows
// the repo *name* (e.g. "argosy"); the filesystem layout is host-specific, so
// resolution lives here on the daemon where the host config does.
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "./config.js";

/** Expand a leading `~` / `~/` to the host home dir. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a tracker repo name to a real directory on this host. Explicit
 * DRYDOCK_REPO_PATHS overrides win; otherwise it's `${reposRoot}/${repo}`. If
 * the resolved path isn't an existing directory we fall back to $HOME so the
 * spawn still succeeds — `matched` tells the caller whether we actually found
 * the repo (so it can warn rather than silently pretend).
 */
export function resolveRepoCwd(repo: string | undefined): { cwd: string; matched: boolean } {
  const home = os.homedir();
  if (!repo) return { cwd: home, matched: false };

  const override = CONFIG.repos.overrides[repo];
  const candidate = override
    ? expandHome(override)
    : path.join(expandHome(CONFIG.repos.root), repo);

  try {
    if (fs.statSync(candidate).isDirectory()) return { cwd: candidate, matched: true };
  } catch {
    /* path doesn't exist — fall through to home */
  }
  return { cwd: home, matched: false };
}
