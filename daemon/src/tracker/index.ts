import { CONFIG } from "../config.js";
import { watchTracker } from "../health.js";
import { log } from "../log.js";
import { ChildStatsCache } from "./cache.js";
import { FixtureProvider } from "./fixture.js";
import { JiraProvider } from "./jira.js";
import { SwitchyardProvider } from "./switchyard.js";
import type { TrackerInfo, TrackerProvider } from "./types.js";

export type { Ticket, TicketDetail, Project, TicketQuery, TrackerProvider } from "./types.js";

/**
 * Build the active tracker from host config. `DRYDOCK_TRACKER` selects the
 * provider; each live provider needs its own credentials (host-side only). If a
 * live provider is selected but unconfigured, we fall back to the fixture and
 * log loudly rather than crash the daemon — the shell stays usable.
 */
export function createTracker(): TrackerProvider {
  // Wrapped on the way out, every path, so what /healthz says about the tracker
  // is the outcome of the calls the daemon actually made (DRY-48). Here rather
  // than at the six call sites because the seventh would be added by somebody
  // who had never read health.ts.
  return watchTracker(buildTracker());
}

function buildTracker(): TrackerProvider {
  const kind = CONFIG.tracker.kind;
  // Built here and handed to whichever provider is selected (DRY-72). One
  // instance because what it caches — "what the tracker says about this epic" —
  // is a property of the tracker rather than of the code asking, and because the
  // two providers must not drift on how long that stays good for. Injected
  // rather than reached for as a module singleton so a provider stays
  // constructible in isolation, same rule as `repoOverrides`.
  const childStats = new ChildStatsCache(CONFIG.tracker.cache.childStatsMs);
  // 0 means "no deadline" (see config.ts); the providers read absent that way.
  const requestTimeoutMs = CONFIG.tracker.requestTimeoutMs || undefined;
  // The bound on a whole pull rather than on one request (DRY-61). Same 0-means-
  // off reading, and passed to both providers so neither can drift into being
  // the one a partitioned tracker hangs.
  const listTimeoutMs = CONFIG.tracker.listTimeoutMs || undefined;

  if (kind === "switchyard") {
    const { url, token } = CONFIG.tracker.switchyard;
    if (!url) {
      log.warn(
        "DRYDOCK_TRACKER=switchyard but DRYDOCK_SWITCHYARD_URL is unset — falling back to fixture data",
      );
      return new FixtureProvider();
    }
    return new SwitchyardProvider({
      baseUrl: url,
      token,
      requestTimeoutMs,
      listTimeoutMs,
      childStats,
    });
  }

  if (kind === "jira") {
    const { url, email, token } = CONFIG.tracker.jira;
    if (!url || !token) {
      log.warn(
        "DRYDOCK_TRACKER=jira but DRYDOCK_JIRA_URL/DRYDOCK_JIRA_TOKEN are unset — falling back to fixture data",
      );
      return new FixtureProvider();
    }
    return new JiraProvider({
      baseUrl: url,
      email,
      token,
      // For multi-component tickets: prefer the component this host has an
      // explicit repo path for (DRY-31).
      repoOverrides: Object.keys(CONFIG.repos.overrides),
      requestTimeoutMs,
      listTimeoutMs,
      childStats,
    });
  }

  return new FixtureProvider();
}

export function trackerInfo(t: TrackerProvider): TrackerInfo {
  return {
    id: t.id,
    name: t.name,
    capabilities: t.capabilities,
    projects: CONFIG.tracker.projects,
  };
}
