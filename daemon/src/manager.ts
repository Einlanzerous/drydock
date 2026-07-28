import { log } from "./log.js";
import { forget, listMeta, readExitRecord, readScrollback } from "./sessions-dir.js";
import { ProtocolMismatch, SupervisorLink } from "./supervisor/link.js";
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

  /**
   * Async since DRY-57: a spawn now waits for a detached supervisor to bind its
   * socket before the session is real. Callers must await it — answering 201
   * before the socket exists makes every attach a race.
   */
  async create(opts: SpawnOptions): Promise<PtySession> {
    const session = await PtySession.spawn(
      opts,
      (event) => this.emitGate(event),
      (s, reason) => this.emitRunEnd(s, reason),
    );
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Find the sessions this daemon owned before it stopped (DRY-57).
   *
   * Runs once at boot, before the port is listening, so the first `GET
   * /api/sessions` a browser makes already tells the truth. Every session in
   * the index is in one of three states, and the third is the one that used to
   * be silently lost:
   *
   *   supervisor alive        → adopt it; the agent never noticed we were gone
   *   ended, no daemon home   → rebuild it from the flushed transcript just far
   *                             enough to write the artefacts DRY-49 promised
   *   supervisor vanished     → nothing to recover; say so and clean up
   *
   * Failures here are per-session and never fatal: a daemon that refuses to
   * boot because one index entry is malformed abandons all the others.
   */
  async reconcile(): Promise<void> {
    const metas = listMeta();
    if (metas.length === 0) return;
    log.info("reconciling sessions from the index", { found: metas.length });

    for (const meta of metas) {
      try {
        const link = await SupervisorLink.connect(meta.id);
        if (link) {
          const session = PtySession.adopt(
            meta,
            link,
            (event) => this.emitGate(event),
            (s, reason) => this.emitRunEnd(s, reason),
          );
          this.sessions.set(session.id, session);
          continue;
        }

        const exit = readExitRecord(meta.id);
        if (!exit) {
          // No socket and no parting note: the supervisor was killed outright
          // (SIGKILL, an OOM, a host that lost power). Whatever it was holding
          // went with it — the child's PTY master died in the same instant.
          log.warn("session supervisor vanished without an exit record — nothing to recover", {
            id: meta.id,
            command: meta.command,
            ticket: meta.ticket,
            ageSec: Math.round((Date.now() - meta.createdAt) / 1000),
          });
          forget(meta.id);
          continue;
        }

        // It ended while we were down. `handoff` already set means a previous
        // daemon got there first, so there is nothing owed and re-announcing
        // would post a second tracker comment for one run.
        if (meta.handoff) {
          log.info("session ended while the daemon was down — artefacts already written", {
            id: meta.id,
            exitCode: exit.exitCode,
            handoff: meta.handoff,
          });
          forget(meta.id);
          continue;
        }

        log.info("session ended while the daemon was down", {
          id: meta.id,
          command: meta.command,
          ticket: meta.ticket,
          exitCode: exit.exitCode,
          autonomous: meta.autonomous || undefined,
        });
        const session = PtySession.adoptExited(
          meta,
          exit.exitCode,
          exit.endedAt,
          readScrollback(meta.id),
          (event) => this.emitGate(event),
          (s, reason) => this.emitRunEnd(s, reason),
        );
        // Not added to the registry. It is a dead session with no PTY behind
        // it, so putting it in `/api/sessions` would draw a pane for something
        // that can never produce another byte; the durable record of a run is
        // its handoff document, which is exactly what this call writes.
        // (DRY-56's tombstones are the surface that changes this.)
        session.announceMissedEnding();
        forget(meta.id);
      } catch (err) {
        // A supervisor from another build keeps holding its PTY — it just
        // isn't drivable from here. Say which, and leave its files ALONE: they
        // are the only handle anything has on that process.
        if (err instanceof ProtocolMismatch) {
          log.error("cannot adopt a session from a different Drydock build — leaving it running", {
            id: meta.id,
            err: err.message,
          });
          continue;
        }
        log.warn("could not reconcile a session — skipping it", {
          id: meta.id,
          err: String(err),
        });
      }
    }

    log.info("reconciliation complete", { adopted: this.sessions.size });
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

  /**
   * Let go of every supervisor WITHOUT killing anything (DRY-57).
   *
   * Called on shutdown. The distinction this method exists to make is the whole
   * ticket: closing our end of a socket is not the same as ending a session,
   * and the agents on the other side keep working while we're away.
   */
  detachAll(): void {
    for (const session of this.sessions.values()) session.detachSupervisor();
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
