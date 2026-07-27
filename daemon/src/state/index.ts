// Workspace-state store selection (DRY-28).
//
// One knob decides the backend: DRYDOCK_DATABASE_URL set → Postgres (anywhere —
// a container on this laptop, a database on your server; the URL is the whole
// difference), unset → a JSON file next to the daemon's log. The file store is
// the default because a fresh clone has to work with nothing else installed.
import { CONFIG } from "../config.js";
import { log } from "../log.js";
import { FileStore } from "./file.js";
import { PostgresStore } from "./postgres.js";
import type { StateStore } from "./types.js";

export type { StateStore, StoreHealth, StoreKind, WorkspaceState, WorkspaceWrite } from "./types.js";

/**
 * Strip credentials from a connection URL before it goes anywhere a human can
 * read it. The daemon log is a file on disk that outlives the process (DRY-45)
 * and gets pasted into tickets — a password must not ride along in it.
 * Unparseable input degrades to a constant rather than falling back to the raw
 * string, because the one case where parsing fails is the one where we can't
 * prove there's no password in there.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable connection url)";
  }
}

export function createStore(): StateStore {
  const url = CONFIG.state.databaseUrl;
  if (url) {
    // Nothing connects here — PostgresStore migrates lazily on first use, so a
    // database that's down (or not up YET, which is the normal case when a
    // compose stack starts both at once) can't stop the daemon from booting.
    log.info("workspace state: postgres", { url: redactUrl(url), owner: CONFIG.state.owner });
    return new PostgresStore(url);
  }
  log.info("workspace state: file", { file: CONFIG.state.file, owner: CONFIG.state.owner });
  return new FileStore(CONFIG.state.file);
}
