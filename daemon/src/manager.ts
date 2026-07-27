import { log } from "./log.js";
import { PtySession, type SpawnOptions } from "./session.js";

/** In-memory registry of live sessions. One per wrapped CLI / shell. */
export class SessionManager {
  private readonly sessions = new Map<string, PtySession>();

  create(opts: SpawnOptions): PtySession {
    const session = new PtySession(opts);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): PtySession[] {
    return [...this.sessions.values()];
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.kill();
    this.sessions.delete(id);
    // This is the moment a session stops existing as far as /api/sessions is
    // concerned. Log it here, not just in kill(): "it vanished from the list"
    // is one of the disappearances DRY-45 has to be able to explain.
    log.info("session removed from registry", { id, remaining: this.sessions.size });
  }
}
