// Session history (DRY-56) — what a database buys you.
//
// DRY-28 landed the desk roaming and reserved `pty_sessions` with every column
// this needs and no writer. This is the writer, plus the debounce and the
// failure posture around it.
//
// THE RULE THIS MODULE EXISTS TO KEEP: history is a record of the product, not
// the product. Live PTYs are the product. Every call here is fire-and-forget
// with its rejection swallowed into a log line, because the alternative — a
// database hiccup propagating into a spawn or an exit handler — would let a
// convenience take down the thing it is a record of. That is the same posture
// `/api/workspace` takes (503 → the shell keeps its local copy) and the same one
// DRY-45 argued for around the PTY.
//
// Deliberately NOT the DRY-57 rediscovery index. That is a pidfile beside the
// supervisor's socket, deleted the instant a session ends; this starts mattering
// exactly where that stops existing. They overlap on most fields and must never
// share storage — their lifetimes are opposites.
import { CONFIG } from "./config.js";
import { log } from "./log.js";
import type { PtySession } from "./session.js";
import type { SessionHistory } from "./state/types.js";

/**
 * How long a session must go quiet before another `last_active_at` write.
 *
 * The activity signal is the same one feeding the rail's action line, which
 * fires on every gated tool call and (for autonomous runs) every Read, Glob and
 * Grep — the most frequent thing an agent does. Writing per event would put a
 * database round trip on the hot path of a feature whose whole point is that it
 * costs the agent nothing. A minute's resolution is plenty for "when was this
 * last doing something", which is all a tombstone renders.
 */
const TOUCH_DEBOUNCE_MS = 60_000;

/**
 * Records sessions for the tiers that can keep them.
 *
 * Holds no store of its own: it is handed the port, which is `undefined` on the
 * file store, and every method is then a no-op. That is why the capability is
 * derived from the port's existence rather than a boolean — there is no state
 * here that could disagree with what the backend actually does.
 */
export class SessionHistoryRecorder {
  /** Last time we wrote last_active_at, per session id. */
  private readonly touched = new Map<string, number>();
  /** Sessions whose agent id is already on record; see noteAgentSessionId. */
  private readonly agentIdRecorded = new Set<string>();

  constructor(
    private readonly history: SessionHistory | undefined,
    private readonly owner: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.history);
  }

  started(session: PtySession): void {
    if (!this.history) return;
    const row = session.historyStart();
    this.fire("record a session start", row.id, this.history.start(this.owner, row));
    // Prune on spawn rather than on a timer: it is the one moment we know the
    // daemon is awake and doing something anyway, and a host that never spawns
    // anything has no history to trim. A timer would be a wakeup on an idle
    // laptop for a table nobody is adding to.
    this.fire("prune session history", row.id, this.pruneQuietly());
  }

  /**
   * Debounced. The caller is the rail's activity path, which is deliberately
   * high-frequency; see TOUCH_DEBOUNCE_MS.
   */
  active(session: PtySession): void {
    if (!this.history) return;
    const now = Date.now();
    const last = this.touched.get(session.id) ?? 0;
    if (now - last < TOUCH_DEBOUNCE_MS) return;
    this.touched.set(session.id, now);
    this.fire("stamp session activity", session.id, this.history.touch(this.owner, session.id));
  }

  /**
   * Record an ending — from the live exit handler OR from boot reconciliation
   * for a session that ended while the daemon was down (DRY-57).
   *
   * `start` is REPLAYED first, and that is not belt-and-braces. Every write here
   * is fire-and-forget, so a store outage at spawn drops the insert silently; a
   * bare UPDATE would then match zero rows and the session would end with no
   * history at all — no row, no tombstone, exactly the silent loss this feature
   * exists to prevent, on the tier that is supposed to fix it. The insert is
   * `on conflict do nothing`, so replaying it costs one statement and makes the
   * ending self-sufficient regardless of what happened at spawn.
   *
   * One path for both cases on purpose: the boot path used to do this and the
   * live path didn't, which is precisely the asymmetry that let an outage at
   * spawn erase a session.
   */
  ended(session: PtySession): void {
    if (!this.history) return;
    const row = session.historyStart();
    this.touched.delete(row.id);
    this.agentIdRecorded.delete(row.id);
    this.fire(
      "record a session ending",
      row.id,
      this.history
        .start(this.owner, row)
        .then(() => this.history!.end(this.owner, row.id, session.ending())),
    );
  }

  /**
   * The wrapped CLI told us its own session id, via a hook.
   *
   * Recorded ONCE per session. Claude Code sends `session_id` on every hook, and
   * the UPDATE is `where agent_session_id is null` — so without this, every hook
   * after the first would be a guaranteed-zero-row round trip on the rail's
   * hottest path, which is the exact cost the debounce beside it exists to
   * avoid. Cleared when the session ends, with the debounce entry.
   */
  noteAgentSessionId(sessionId: string, agentSessionId: string): void {
    if (!this.history || this.agentIdRecorded.has(sessionId)) return;
    this.agentIdRecorded.add(sessionId);
    this.fire(
      "record an agent session id",
      sessionId,
      this.history.noteAgentSessionId(this.owner, sessionId, agentSessionId),
    );
  }

  recent(limit: number) {
    return this.history?.recent(this.owner, limit);
  }

  private async pruneQuietly(): Promise<void> {
    const dropped = await this.history!.prune(this.owner);
    if (dropped > 0) {
      log.info("pruned session history", {
        dropped,
        keepDays: CONFIG.state.history.days,
        keepMax: CONFIG.state.history.max,
      });
    }
  }

  /**
   * Run a write without letting it reach the caller.
   *
   * Every call site is a PTY lifecycle moment — a spawn returning 201, an exit
   * handler mid-teardown — and none of them may fail because a database is
   * unreachable. A store outage costs history a log line and nothing else; the
   * cooldown in PostgresStore already bounds how often it pays for the attempt.
   */
  private fire(what: string, id: string, work: Promise<unknown>): void {
    void work.catch((err) => {
      log.warn(`could not ${what} — history is degraded, the session is not`, {
        id,
        err: String(err),
      });
    });
  }
}
