import { CONFIG } from "../config.js";
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
  const kind = CONFIG.tracker.kind;

  if (kind === "switchyard") {
    const { url, token } = CONFIG.tracker.switchyard;
    if (!url) {
      console.warn(
        "[drydock] DRYDOCK_TRACKER=switchyard but DRYDOCK_SWITCHYARD_URL is unset — falling back to fixture data.",
      );
      return new FixtureProvider();
    }
    return new SwitchyardProvider({ baseUrl: url, token });
  }

  if (kind === "jira") {
    const { url, email, token } = CONFIG.tracker.jira;
    if (!url || !token) {
      console.warn(
        "[drydock] DRYDOCK_TRACKER=jira but DRYDOCK_JIRA_URL/DRYDOCK_JIRA_TOKEN are unset — falling back to fixture data.",
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
