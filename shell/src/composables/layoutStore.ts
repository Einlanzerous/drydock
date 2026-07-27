// Workspace-layout persistence (DRY-14, moved daemon-side in DRY-28).
//
// The daemon now owns the saved arrangement (`/api/workspace`), so it follows
// the person rather than the browser that drew it: arrange windows on the
// desktop, open the shell on a laptop, get the same desk back. localStorage
// survives as a MIRROR, not the source of truth — it covers the two cases the
// daemon can't, namely "the daemon is unreachable right now" and "this daemon
// has never been told about my layout" (the one-time hand-off from DRY-14
// storage, so upgrading doesn't reset everyone's desk).
//
// The stored shape carries a `version`: an incompatible/unknown shape is
// discarded, not migrated, so an old blob can never crash the restore path.
// That rule stays in the CLIENT on purpose — the daemon stores the version but
// cannot know which shapes this build of the UI is able to read.
import { DAEMON_HTTP } from "../lib/daemon.js";
import type { LayoutMode, Win } from "./useWindowManager.js";

const PREFIX = "drydock.layout";
// v2 (DRY-21): Win gained `kind` + workspace fields (shellId / drawerOpen /
// shellCollapsed / shellRatio). A v1 blob has no `kind`, so it's discarded on
// load rather than restoring workspace windows with a dangling agent-only PTY.
export const LAYOUT_VERSION = 2;

export interface PersistedLayout {
  version: number;
  layout: LayoutMode;
  windows: Win[];
}

/** Where a restored layout came from — lets a caller tell "this desk roams"
 *  apart from "I'm running on this browser's copy". */
export type LayoutSource = "daemon" | "local" | "none";

function keyFor(host: string): string {
  return `${PREFIX}.${host}`;
}

const LAYOUTS = new Set<LayoutMode>(["float", "tile", "focus"]);

/** Structural check applied to both sources — neither is trusted more. */
function validate(data: unknown): PersistedLayout | null {
  const d = data as PersistedLayout | null;
  if (!d || d.version !== LAYOUT_VERSION || !Array.isArray(d.windows) || !LAYOUTS.has(d.layout)) {
    return null; // unknown/incompatible shape — discard rather than crash
  }
  return { version: d.version, layout: d.layout, windows: d.windows };
}

// ---- local mirror ----

function readLocal(host: string): PersistedLayout | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(keyFor(host));
    return raw ? validate(JSON.parse(raw)) : null;
  } catch {
    return null; // storage blocked (private mode / disabled) — best-effort only
  }
}

function writeLocal(host: string, data: PersistedLayout): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(keyFor(host), JSON.stringify(data));
  } catch {
    /* quota exceeded / storage disabled — the mirror is best-effort */
  }
}

// ---- daemon ----

/**
 * Latched once a daemon write fails, so the console gets one line per
 * transition rather than one per drag. Worth saying out loud at all: silently
 * writing to a mirror nobody reads is how you discover at the worst possible
 * moment that your layout stopped roaming.
 */
let degraded = false;

function noteDegraded(err: unknown): void {
  if (degraded) return;
  degraded = true;
  console.warn("[drydock] layout is not reaching the daemon — using this browser's copy", err);
}

function noteRecovered(): void {
  if (!degraded) return;
  degraded = false;
  console.info("[drydock] layout persistence restored");
}

async function pushRemote(data: PersistedLayout): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP}/api/workspace`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`daemon returned ${res.status}`);
}

/**
 * Restore the saved arrangement.
 *
 * The daemon's copy wins whenever it HAS one, and no timestamps are compared.
 * That is deliberate: a "newest wins" rule spans two unrelated clocks, so a
 * laptop running a few minutes slow would let its stale mirror clobber the desk
 * you just arranged on the desktop — precisely the failure this ticket exists
 * to remove. The cost is losing at most one debounce window (400ms) of dragging
 * if the tab is closed mid-write, which is not worth a clock war.
 */
export async function loadLayout(
  host: string,
): Promise<{ layout: PersistedLayout | null; source: LayoutSource }> {
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/workspace`);
    if (!res.ok) throw new Error(`daemon returned ${res.status}`);
    const body = await res.json();
    noteRecovered();
    const remote = validate(body.workspace);
    if (remote) {
      writeLocal(host, remote); // keep the offline mirror current
      return { layout: remote, source: "daemon" };
    }
    // The daemon has nothing for us. If this browser does, it's a desk that
    // predates daemon-side storage (or a reset done elsewhere) — hand it up, so
    // upgrading to DRY-28 is a one-time migration instead of a silent reset.
    const local = readLocal(host);
    if (local) {
      void pushRemote(local).catch(noteDegraded);
      return { layout: local, source: "local" };
    }
    return { layout: null, source: "none" };
  } catch (err) {
    // Daemon unreachable, or its store is degraded (503): fall back to the
    // mirror. The desktop still works, it just stops roaming until it's back.
    noteDegraded(err);
    const local = readLocal(host);
    return { layout: local, source: local ? "local" : "none" };
  }
}

/**
 * Persist an arrangement. Fire-and-forget by design — the caller is a debounced
 * watcher on a drag, and saving a layout must never be something the UI waits
 * on. The local mirror is written synchronously first, so an unreachable daemon
 * (or a tab closed mid-request) can't lose the arrangement outright.
 */
export function saveLayout(host: string, layout: LayoutMode, windows: Win[]): void {
  const data: PersistedLayout = { version: LAYOUT_VERSION, layout, windows };
  writeLocal(host, data);
  pushRemote(data).then(noteRecovered, noteDegraded);
}

/** Reset the saved arrangement in both places. */
export async function clearLayout(host: string): Promise<void> {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(keyFor(host));
    } catch {
      /* ignore */
    }
  }
  try {
    await fetch(`${DAEMON_HTTP}/api/workspace`, { method: "DELETE" });
  } catch (err) {
    noteDegraded(err);
  }
}
