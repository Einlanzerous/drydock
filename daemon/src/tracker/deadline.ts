import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A deadline on a whole tracker OPERATION, rather than on one HTTP request
 * (DRY-61).
 *
 * DRY-72 gave every request a backstop, which bounds a request and nothing
 * larger. One `listTickets` is many requests — a cursor chain for the list, a
 * second chain for the epic exemption, then the child-stats pass, which on
 * Switchyard is one chain PER EPIC through a pool — so a tracker that answers
 * every request just under the backstop leaves the pull running for
 * `requests × backstop` with nothing to stop it. Against a partitioned tracker
 * (accepts the connection, then silence) that is the shape the daemon actually
 * meets: not a refusal it can report, but an operation with no end.
 *
 * The cost is not the wait. It is that `/api/tracker/tickets` is polled every
 * 20s **per browser tab**, so each poll starts another pull on top of the ones
 * still running — a socket and a pending promise each — and none of it is
 * visible from the desk, which goes on being served last-good from the cache.
 *
 * ## Why the signal is ambient rather than a parameter
 *
 * The obvious shape is to thread an `AbortSignal` through every private method
 * down to `req()`. It was rejected, and the reason is the recurring trap this
 * repo keeps rediscovering: the forgotten call site is always the one that
 * matters. Threading means five signatures per provider and a rule that every
 * FUTURE request must remember to carry the budget — a rule nothing enforces,
 * whose failure mode is silent (that one request runs unbounded) and which is
 * invisible in review because the call reads perfectly well.
 *
 * `AsyncLocalStorage` inverts that: the deadline is a property of the operation
 * in progress, `req()` reads it at the single chokepoint both providers already
 * funnel through, and a request added later is bounded without its author
 * knowing this file exists. It propagates across `await`, `Promise.all` and the
 * child-stats pool for free, which a parameter only does if every intermediate
 * remembers to pass it on.
 *
 * The trade is that a call made OUTSIDE `withDeadline` is silently unbounded
 * beyond its per-request backstop — which is deliberate for `getTicket`, see
 * below.
 *
 * ## What is wrapped, and what deliberately is not
 *
 * `listTickets` and `searchTickets`, each under its OWN name. The second
 * delegates into the first, so it would inherit the budget anyway — it is
 * wrapped for the label, because a nested `withDeadline` is a passthrough and
 * the outer name is what a blown budget reports. The palette's search route is
 * the one tracker path with no cache in front of it, so that message is read
 * directly by a person, and "ticket list exceeded its deadline" would name an
 * operation they never asked for.
 *
 * `getTicket` — the SessionStart brief (DRY-53). Its optional decorations
 * already carry tighter budgets of their own (`extrasDeadline`,
 * `ANCESTRY_TIMEOUT_MS`) that degrade a line of the brief rather than the
 * brief, and the caller waiting on it is a `curl -s -m 25` with no retry. A
 * list budget sized against a 20s sidebar poll would cut briefs a slow tracker
 * is still delivering, to fix an accumulation that path doesn't have: a brief
 * is one spawn, not a poll.
 *
 * It has a SECOND caller since DRY-76 — the ticket panel, which now asks for
 * the same thread and so takes the same decorations — and the conclusion is
 * unchanged for the same reason: a panel open is a click. Neither caller
 * repeats on a clock, so neither can pile pulls on top of pulls, which is the
 * failure this file exists to end. What both rely on instead is that the
 * decorations degrade rather than block: the walk's own budget costs the epic
 * line, not the description and the comments.
 */

/**
 * The deadline governing the operation on this async stack, if there is one.
 *
 * Read by both providers' `req()`. Undefined means "no operation deadline" —
 * a caller outside `withDeadline`, or a daemon that turned the knob off.
 */
const operation = new AsyncLocalStorage<AbortSignal>();

/**
 * A blown operation deadline, named.
 *
 * The whole point of pairing this budget UNDER the shell's (see
 * `LIST_TIMEOUT_MS` in shell/src/lib/tracker.ts) is that the daemon gets to
 * explain itself first: the sidebar renders whatever the 502 says, and
 * "switchyard ticket list exceeded its 10000ms deadline" tells somebody where
 * to look in a way "signal timed out" — which is what the browser's own abort
 * produces — never will. Raised in place of the bare `AbortError`/`TimeoutError`
 * that `fetch` rejects with, which names nothing.
 *
 * **`name` IS set here, where `TrackerHttpError` deliberately leaves it alone**
 * (see types.ts), and the two are not inconsistent. That class suppresses its
 * name because nothing reads it and `String(err)` reaches a person, so the
 * prefix was pure jargon. This one is read: `TrackerWatch.failed` in
 * ../health.ts reports the NAME rather than the message on purpose, so upstream
 * text cannot reach an endpoint that answers strangers — and the two deadlines
 * this daemon can blow have different fixes (DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS
 * vs DRYDOCK_TRACKER_LIST_TIMEOUT_MS). A plain `Error` here would have /healthz
 * say "the tracker call failed (Error)".
 */
export class TrackerTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(what: string, timeoutMs: number) {
    super(`${what} exceeded its ${timeoutMs}ms deadline (tracker did not answer in time)`);
    this.name = "TrackerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `fn` under an operation-wide deadline.
 *
 * @param ms    the budget; 0/undefined runs `fn` unbounded (the pre-DRY-61
 *              behaviour, kept reachable by `DRYDOCK_TRACKER_LIST_TIMEOUT_MS=0`).
 * @param what  what to call the operation in the error — it reaches a user, via
 *              the route's 502 and the sidebar's outage header.
 *
 * **Nesting does not restart the clock.** Both providers reach `listTickets`
 * from `searchTickets`, and the Switchyard one calls itself once per project in
 * scope (DRY-30) to fan a multi-project pull out. A nested wrap that minted a
 * fresh budget would give an N-project pull N times the budget it advertises
 * while still reporting the same number in the error — so an already-running
 * deadline wins and this is a passthrough.
 */
export async function withDeadline<T>(
  ms: number | undefined,
  what: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ms || operation.getStore()) return fn();
  const signal = AbortSignal.timeout(ms);
  return operation.run(signal, async () => {
    try {
      return await fn();
    } catch (err) {
      // `signal.aborted` and not the error's name: what ends the operation is
      // OUR deadline firing, and by the time the rejection surfaces it may have
      // been rewritten — a provider's `catch` around a swallowed decoration can
      // rethrow something else entirely, and `fetch` rejects an aborted request
      // with a DOMException whose name differs between "aborted" and "timed
      // out". If the budget is gone, the operation is over, whatever it says.
      if (signal.aborted) throw new TrackerTimeoutError(what, ms);
      throw err;
    }
  });
}

/**
 * The signal one outbound request should carry.
 *
 * Three budgets can apply and the tightest must win, so they are composed
 * rather than chosen between:
 *
 *  - `own` — a caller with its own, tighter budget for a request it can afford
 *    to lose (the brief's extras). It REPLACES the per-request backstop rather
 *    than joining it, which is DRY-72's rule: the backstop is a floor under
 *    callers that brought nothing, not an override of one that did.
 *  - the per-request backstop (`DRYDOCK_TRACKER_REQUEST_TIMEOUT_MS`).
 *  - the operation deadline in scope, which always applies on top. It can only
 *    ever make a request tighter, and a decoration that outlived the operation
 *    it decorates would be exactly the accumulation DRY-61 is about.
 *
 * Returns undefined when nothing applies. `fetch` reads an undefined `signal`
 * as no signal, which is what this path already did before it was a function.
 */
export function requestSignal(
  own: AbortSignal | undefined | null,
  perRequestMs: number | undefined,
): AbortSignal | undefined {
  const budgets: AbortSignal[] = [];
  if (own) budgets.push(own);
  else if (perRequestMs) budgets.push(AbortSignal.timeout(perRequestMs));
  const op = operation.getStore();
  if (op) budgets.push(op);
  if (!budgets.length) return undefined;
  return budgets.length === 1 ? budgets[0]! : AbortSignal.any(budgets);
}
