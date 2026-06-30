// localStorage persistence for the window-manager layout (DRY-14).
//
// The daemon keeps PTY sessions alive across reloads, but the shell's window
// state is in-memory, so a refresh/HMR/deploy wipes positions, sizes, dock
// state, z-order, and layout mode. This persists that arrangement so it comes
// back on reload and reattaches to the still-running sessions.
//
// Keyed per daemon host so pointing the shell at a different daemon doesn't
// cross-contaminate arrangements. The stored shape carries a `version`: an
// incompatible/unknown shape is discarded (not migrated) for this PoC, so an
// old blob can never crash the restore path. Server-side storage (layout
// follows you across browsers, in keeping with the daemon-owns-state model) is
// the eventual upgrade path; localStorage is the v1.
import type { LayoutMode, Win } from "./useWindowManager.js";

const PREFIX = "drydock.layout";
export const LAYOUT_VERSION = 1;

export interface PersistedLayout {
  version: number;
  layout: LayoutMode;
  windows: Win[];
}

function keyFor(host: string): string {
  return `${PREFIX}.${host}`;
}

const LAYOUTS = new Set<LayoutMode>(["float", "tile", "focus"]);

/** Load + validate the saved layout for a host, or null if absent/incompatible. */
export function loadLayout(host: string): PersistedLayout | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyFor(host));
  } catch {
    return null; // storage blocked (private mode / disabled) — best-effort only
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedLayout;
    if (
      !data ||
      data.version !== LAYOUT_VERSION ||
      !Array.isArray(data.windows) ||
      !LAYOUTS.has(data.layout)
    ) {
      return null; // unknown/incompatible shape — discard rather than crash
    }
    return data;
  } catch {
    return null;
  }
}

export function saveLayout(host: string, layout: LayoutMode, windows: Win[]): void {
  if (typeof localStorage === "undefined") return;
  const data: PersistedLayout = { version: LAYOUT_VERSION, layout, windows };
  try {
    localStorage.setItem(keyFor(host), JSON.stringify(data));
  } catch {
    /* quota exceeded / storage disabled — layout persistence is best-effort */
  }
}

export function clearLayout(host: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(keyFor(host));
  } catch {
    /* ignore */
  }
}
