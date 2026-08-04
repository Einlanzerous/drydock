import { log } from "./log.js";
import type { SessionHistoryRecorder } from "./history.js";
import { forget, listMeta, readExitRecord, readScrollback } from "./sessions-dir.js";
import { ProtocolMismatch, SupervisorLink } from "./supervisor/link.js";
import type { SessionMeta } from "./supervisor/wire.js";
import {
  PtySession,
  type GateEvent,
  type GateNotifier,
  type RunEndNotifier,
  type RunEndReason,
  type SessionEndNotifier,
  type SpawnOptions,
} from "./session.js";

/** In-memory registry of live sessions. One per wrapped CLI / shell. */
export class SessionManager {
  private readonly sessions = new Map<string, PtySession>();

  /**
   * Session history, when the tier keeps any (DRY-56).
   *
   * Injected rather than constructed here for the same reason the tracker is
   * injected into runs.ts: this class owns PTYs and must not grow an opinion
   * about databases. A no-op recorder on the file tier means no call site needs
   * a conditional.
   */
  private history?: SessionHistoryRecorder;

  useHistory(recorder: SessionHistoryRecorder): void {
    this.history = recorder;
  }

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
    const session = await PtySession.spawn(opts, ...this.listeners());
    this.sessions.set(session.id, session);
    this.history?.started(session);
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

    // In PARALLEL, because this runs before the port is bound and the daemon
    // answers nothing at all until it finishes. A supervisor that accepts but
    // never completes its handshake costs the full handshake timeout, and
    // sequentially that is N × 5s of a daemon that appears simply not to be
    // running. Bounded by the slowest single entry instead.
    //
    // The registry is filled afterwards, in the index's own createdAt order:
    // Promise.all preserves result order, but resolution order is a race, and
    // `list()` is Map insertion order — so building the map inside the tasks
    // would shuffle the desk on every restart.
    const adopted = await Promise.all(metas.map((meta) => this.reclaim(meta)));
    for (const session of adopted) {
      if (session) this.sessions.set(session.id, session);
    }

    log.info("reconciliation complete", { adopted: this.sessions.size });
  }

  /**
   * Work out what became of one indexed session, and hand back a live one if
   * there is a live one to hand back.
   *
   * Never throws: a daemon that refuses to boot because one index entry is
   * malformed abandons every other agent on the host.
   */
  private async reclaim(meta: SessionMeta): Promise<PtySession | undefined> {
    try {
      const link = await SupervisorLink.connect(meta.id);
      if (link) {
        const session = PtySession.adopt(meta, link, ...this.listeners());
        // Somebody killed this before we went down, and the child evidently
        // didn't go — it ignored the signal, or we died inside the window
        // between sending it and seeing the exit. Finish what was asked for
        // rather than putting it back on the desk. Killing it again (rather
        // than just unlinking the files) matters: forgetting the socket would
        // strand the supervisor with nothing able to reach it ever again.
        if (meta.killedAt) {
          log.warn("adopted a session that was already killed — finishing the job", {
            id: meta.id,
            command: meta.command,
            killedAgoSec: Math.round((Date.now() - meta.killedAt) / 1000),
          });
          session.kill();
          // The link is deliberately LEFT OPEN. `detachSupervisor()` here would
          // destroy the socket in the same tick as the Kill frame was queued on
          // it, which can discard it unflushed — the one message this branch
          // exists to deliver. Keeping it means the Exit frame still arrives and
          // the session's own exit path removes the index files, finishing the
          // cleanup properly; the session object is simply never handed back to
          // the registry, so nothing renders it in the meantime.
          return undefined;
        }
        return session;
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
        return undefined;
      }

      // It ended while we were down. `handoff` already set means a previous
      // daemon got there first, so there is nothing owed and re-announcing
      // would post a second tracker comment for one run.
      //
      // A deliberate kill deliberately does NOT short-circuit here. It reaches
      // adoptExited as `stoppedByRequest` instead, so it ends up with exactly
      // what the live path gives it: the transcript kept, no tracker comment
      // (runs.ts returns before commenting on a `stopped` run). Skipping it
      // here instead would mean a run you stopped by hand keeps its handoff if
      // the daemon happened to see the exit and loses it if the daemon was down
      // for those few seconds — the same action, two outcomes, decided by
      // something nobody can observe.
      if (meta.handoff) {
        log.info("session ended while the daemon was down — artefacts already written", {
          id: meta.id,
          exitCode: exit.exitCode,
          handoff: meta.handoff,
        });
        forget(meta.id);
        return undefined;
      }

      log.info("session ended while the daemon was down", {
        id: meta.id,
        command: meta.command,
        ticket: meta.ticket,
        exitCode: exit.exitCode,
        autonomous: meta.autonomous || undefined,
        stopped: meta.killedAt ? true : undefined,
      });
      const session = PtySession.adoptExited(
        meta,
        exit.exitCode,
        exit.endedAt,
        readScrollback(meta.id),
        ...this.listeners(),
      );
      // History has to learn about this one too, or it has a hole exactly where
      // the daemon was absent — which is the case a tombstone exists for.
      this.history?.ended(session);
      // Not returned to the registry. It is a dead session with no PTY behind
      // it, so putting it in `/api/sessions` would draw a pane for something
      // that can never produce another byte; the durable record of a run is its
      // handoff document, which is exactly what this call writes.
      // (DRY-56's tombstones are the surface that changes this.)
      session.announceMissedEnding();
      forget(meta.id);
      return undefined;
    } catch (err) {
      // Defence in depth. A build mismatch is normally caught a layer earlier,
      // when the metadata is parsed (see sessions-dir.ts) — the supervisor
      // refuses to start on foreign metadata, so the two always agree in
      // practice. If it ever does reach the wire, the rule is the same: the
      // supervisor keeps holding its PTY, and its files are LEFT ALONE because
      // they are the only handle anything has on that process.
      if (err instanceof ProtocolMismatch) {
        log.error("cannot adopt a session from a different Drydock build — leaving it running", {
          id: meta.id,
          err: err.message,
        });
        return undefined;
      }
      log.warn("could not reconcile a session — skipping it", { id: meta.id, err: String(err) });
      return undefined;
    }
  }

  /** The three notifiers every PtySession factory takes, in order. */
  private listeners(): [GateNotifier, RunEndNotifier, SessionEndNotifier] {
    return [
      (event) => this.emitGate(event),
      (s, reason) => this.emitRunEnd(s, reason),
      (s) => this.history?.ended(s),
    ];
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
   * The sessions `viewer` is allowed to know about (DRY-27).
   *
   * Every client-facing surface goes through this rather than `list()` —
   * /api/sessions, the gate stream's snapshot, the sweep. `list()` survives for
   * the ones whose audience is the HOST rather than a browser: the crash
   * inventory and /healthz's count, where filtering by an account would make an
   * operator's census depend on who asked.
   */
  listFor(viewer: string): PtySession[] {
    return this.list().filter((s) => s.visibleTo(viewer));
  }

  /** How many live sessions this account owns — see Auth.removeUser (DRY-27). */
  liveSessionsFor(owner: string): number {
    return this.list().filter((s) => s.running && s.ownedBy(owner) && s.owner === owner).length;
  }

  /**
   * Hand every live session owned by `from` to `to`. Returns how many moved.
   *
   * The runtime half of `adoptOwner` (DRY-27): that one moves database rows
   * when the first account is seeded, and this one moves the PTYs that are
   * still running. Without it, turning multi-user on strands every session
   * spawned before it — they carry the pre-accounts owner, which is a real
   * string that matches nobody, so they become invisible and unkillable rather
   * than merely unowned.
   */
  adoptSessions(from: string, to: string, toName?: string): number {
    let moved = 0;
    for (const session of this.sessions.values()) {
      if (session.owner === from) {
        // The NAME moves with the id, or every adopted card goes on labelling
        // itself with the pre-accounts login name — which is nobody, on a desk
        // that now has real ones.
        session.adoptOwner(to, toName);
        moved += 1;
      }
    }
    return moved;
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
