import { log } from "./log.js";
import {
  PtySession,
  type GateEvent,
  type RunEndReason,
  type SpawnOptions,
} from "./session.js";

/** In-memory registry of live sessions. One per wrapped CLI / shell. */
export class SessionManager {
  private readonly sessions = new Map<string, PtySession>();

  /**
   * Subscribers to gate activity across *every* session (DRY-50). Kept on the
   * manager rather than per-session because the shell-wide stream must also
   * receive gates from sessions spawned after it connected — subscribing to
   * each session individually would silently miss exactly those.
   */
  private readonly gateListeners = new Set<(event: GateEvent) => void>();

  /** Subscribe to gate activity. Returns its own unsubscribe. */
  onGate(listener: (event: GateEvent) => void): () => void {
    this.gateListeners.add(listener);
    return () => this.gateListeners.delete(listener);
  }

  private emitGate(event: GateEvent): void {
    for (const listener of this.gateListeners) {
      // A subscriber that throws must not take down the gate that was being
      // announced — nor the sibling subscribers after it in the set. This
      // process is the lifetime of every live PTY (DRY-45).
      try {
        listener(event);
      } catch (err) {
        log.warn("gate listener threw", { type: event.type, err: String(err) });
      }
    }
  }

  /**
   * Subscribers to autonomous runs reaching a terminal state (DRY-49). Same
   * shape and the same reason as the gate listeners above: a run that ends has
   * to produce a durable artefact, and that work needs the tracker — which the
   * session must not import if it's to stay a thing that owns a PTY and
   * nothing else.
   */
  private readonly runEndListeners = new Set<(s: PtySession, r: RunEndReason) => void>();

  onRunEnd(listener: (session: PtySession, reason: RunEndReason) => void): () => void {
    this.runEndListeners.add(listener);
    return () => this.runEndListeners.delete(listener);
  }

  create(opts: SpawnOptions): PtySession {
    const session = new PtySession(
      opts,
      (event) => this.emitGate(event),
      (s, reason) => this.emitRunEnd(s, reason),
    );
    this.sessions.set(session.id, session);
    return session;
  }

  private emitRunEnd(session: PtySession, reason: RunEndReason): void {
    for (const listener of this.runEndListeners) {
      // Writing a handoff or reaching a tracker can fail in a dozen ways, none
      // of which may take down the process that owns every live PTY (DRY-45).
      try {
        listener(session, reason);
      } catch (err) {
        log.warn("run-end listener threw", { id: session.id, reason, err: String(err) });
      }
    }
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
