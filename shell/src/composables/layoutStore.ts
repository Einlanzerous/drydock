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
import { deleteWorkspace, fetchWorkspace, putWorkspace } from "../lib/daemon.js";
import { clearNotice, setNotice } from "./notices.js";
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

function keyFor(host: string): string {
  return `${PREFIX}.${host}`;
}

/**
 * Forget everything this module holds about one account's desk (DRY-27).
 *
 * Called on sign-out, and every line of it is load-bearing rather than tidy —
 * all the state below is MODULE-scoped, which was correct while a page load
 * meant one person and is a data-loss bug the moment signing out and back in
 * can change who that is:
 *
 * - `unflushed` is a desk a degraded store never took. Left behind, the next
 *   account's first successful push flushes A's desk to B's row, under B's
 *   token. The daemon has no way to tell — it is a well-formed PUT from a
 *   signed-in client.
 * - `mayPush` latching open is the guard from DRY-58's conflict rule. Carried
 *   across a sign-in it says "we have read this account's desk" about an
 *   account whose desk we have never read, so B's empty from-scratch desk
 *   overwrites the one B actually had.
 * - the retry `timer` fires against whoever is signed in when it lands, which
 *   is the same bug with a delay on it.
 * - the mirror is keyed by DAEMON, not by account (it predates accounts), so
 *   leaving it hands B the last person's desk as their offline fallback —
 *   `hydrate` uses it whenever the daemon has no saved desk, which is exactly
 *   the state a new account is in.
 *
 * Keying the mirror by account instead would be the other fix and a worse one:
 * the key is fixed when the window manager is constructed, before anybody has
 * signed in. Signing out costs an offline fallback the daemon has a copy of
 * anyway — and the token went with it, so there was nothing to be offline with.
 */
export function forgetLocalLayout(host: string): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  hooks = null;
  recoveryHost = null;
  unflushed = null;
  attempt = 0;
  recovering = false;
  degraded = false;
  mayPush = false;
  clearNotice("workspace-store");
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(keyFor(host));
  } catch {
    /* storage blocked — nothing was mirrored either */
  }
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
 * What the store needs back from the window manager to recover in place
 * (DRY-58). Passed to `loadLayout`, because that is the moment recovery might
 * first be needed and there is no second entry point to forget.
 */
export interface RecoveryHooks {
  /**
   * Put a desk the daemon turned out to be holding onto the screen, live —
   * the same path a page load takes, so the two can't drift.
   */
  apply(layout: PersistedLayout): void;
  /**
   * Whether this client has ARRANGED the desk since it loaded: dragged,
   * resized, minimized, restored, changed layout mode, or moved a workspace
   * pane's own furniture. A window merely APPEARING because the session poll
   * found a new PTY is explicitly not arranging — see the conflict rule in
   * `recover()`, which turns on exactly this distinction.
   */
  arranged(): boolean;
}

/**
 * Recovery state. The store degrades in two distinguishable ways and both end
 * here: the load-time read failed (`mayPush` never latched, see below), or a
 * push failed after a good read (`unflushed` holds the desk that didn't land).
 */
let hooks: RecoveryHooks | null = null;
let recoveryHost: string | null = null;
/** The most recent desk that a degraded store never took. */
let unflushed: PersistedLayout | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
/**
 * An attempt is in flight. Two triggers can land on top of each other — a
 * wake-up firing while the backoff's own attempt is still awaiting a fetch —
 * and two concurrent recoveries would race to PUT the same desk twice.
 */
let recovering = false;

/**
 * 5s, then doubling to a 30s ceiling. The floor is short because the shell's
 * retry is cheap — a daemon whose Postgres is down fast-fails from its own
 * cooldown without dialling anything — and the ceiling is there because an
 * outage that lasts an hour shouldn't be probed 720 times to find out.
 */
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

/**
 * Latched once a daemon read or write fails, so the console gets one line per
 * transition rather than one per drag. Worth saying out loud at all: silently
 * writing to a mirror nobody reads is how you discover at the worst possible
 * moment that your layout stopped roaming.
 */
let degraded = false;

function noteDegraded(err: unknown): void {
  if (!degraded) {
    degraded = true;
    console.warn("[drydock] layout is not reaching the daemon — using this browser's copy", err);
    // The console line is for whoever is already debugging; the notice is for
    // whoever isn't. Phrased as where the desk IS rather than what broke,
    // because the actionable half is "this browser is the only copy" — the rest
    // of Drydock is fine and nothing here is worth interrupting for (DRY-58).
    setNotice(
      "workspace-store",
      "Desk changes aren't reaching the daemon — this browser is holding them",
      String(err),
    );
  }
  // Outside the `if` on purpose: the transition is what's worth SAYING once,
  // but every failure has to leave a retry armed. Arming it only on the
  // transition would mean a failure that arrives while already degraded — the
  // common case, a save failing during an outage the load already reported —
  // silently dropping the recovery this whole section exists for.
  scheduleRetry();
}

function noteRecovered(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  attempt = 0;
  if (!degraded) return;
  degraded = false;
  clearNotice("workspace-store");
  console.info("[drydock] layout persistence restored");
}

function scheduleRetry(): void {
  if (timer || !degraded || !hooks || !recoveryHost) return;
  const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  attempt += 1;
  timer = setTimeout(() => {
    timer = null;
    void recover();
  }, delay);
}

/**
 * Retry now rather than waiting out the backoff, because the two events this
 * hangs off both mean "the answer probably just changed": a laptop coming back
 * from sleep is on a different network than the one that failed, and a tab
 * being looked at again is the moment a stale desk starts to matter.
 *
 * Promptness only — recovery does NOT depend on either event firing, because
 * one that did would be recovery that silently doesn't happen on whatever
 * browser doesn't fire it.
 *
 * `attempt` deliberately isn't reset. A tab flipped back and forth would
 * otherwise poll on every flip, and the point of the ceiling is that a long
 * outage stays quiet.
 */
function wake(): void {
  // `recovering` guards the timer, not just the work: cancelling a scheduled
  // retry and then bailing out of the attempt would leave nothing armed.
  if (!degraded || recovering) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void recover();
}

function onVisible(): void {
  if (document.visibilityState === "visible") wake();
}

let listening = false;
function listen(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", onVisible);
}

/**
 * One attempt at ending the outage. Which half runs depends on how we got here.
 *
 * The interesting case is the first: we never read the daemon's copy, so we
 * don't know whether the desk on screen is a restore or something this browser
 * built from scratch at cascade positions — which is the whole reason `mayPush`
 * exists. Re-reading answers it, and then:
 *
 * - the daemon has nothing → there is nothing to lose, our desk goes up.
 * - the daemon has a desk and this client hasn't arranged anything → the
 *   daemon's copy is the newest thing a HUMAN arranged, so it wins and lands on
 *   screen. That is precisely what a reload used to do; the only change is that
 *   nobody has to know to perform it.
 * - the daemon has a desk and this client HAS arranged one → ours wins. Had the
 *   store been up the whole time, every one of those drags would already have
 *   overwritten the remote copy; losing them because the store blinked would be
 *   the outage costing work, which is the thing this ticket is about.
 */
async function recover(): Promise<void> {
  if (!degraded || !hooks || !recoveryHost || recovering) return;
  // It runs in a hidden tab too. Skipping there looked like an easy saving —
  // nobody arranges a desk they can't see — but what's being retried is the
  // desk this tab is ALREADY holding, and a background tab that never flushes
  // it and is eventually closed loses that arrangement outright. Browsers
  // throttle background timers on their own, so the polling goes sparse without
  // any help from here.
  recovering = true;
  try {
    if (!mayPush) {
      const remote = validate(await fetchWorkspace());
      // The read landed, so the latch opens whichever desk wins below.
      mayPush = true;
      if (remote && !hooks.arranged()) {
        writeLocal(recoveryHost, remote);
        hooks.apply(remote);
        unflushed = null;
        // `apply` mutates the reactive windows, so the deep watcher will push
        // this desk straight back out in 400ms — one redundant round trip per
        // heal. Left alone deliberately: it also re-persists whatever DRY-42's
        // duplicate-id healing fixed up on the way in.
      }
      // No probe below on this path — the read above IS the evidence.
    } else if (!unflushed) {
      // Nothing queued is NOT evidence the store is back, and `noteRecovered()`
      // is a few lines away. `clearLayout` raises a notice on a failed DELETE
      // and queues nothing at all, so this used to fall through to "layout
      // persistence restored" without touching the network — announcing the
      // opposite of what was true. A read is the cheapest thing that can fail.
      await fetchWorkspace();
    }
    // Anything queued NOW goes before this counts as recovered — including a
    // desk `saveLayout` parked while the await above was outstanding, which is
    // why this sits after every branch rather than inside one.
    if (!(await drain())) return scheduleRetry();
    noteRecovered();
  } catch (err) {
    noteDegraded(err);
  } finally {
    recovering = false;
  }
}

/**
 * Send the queued desk, and clear the slot only if it still holds what we sent.
 *
 * `saveLayout` runs while this await is outstanding, and that window is as wide
 * as `WRITE_TIMEOUT_MS`. Drag during it and the drag's own push fails fast,
 * queueing deskB behind the deskA already in flight; a bare `unflushed = null`
 * on deskA's success then drops deskB on the floor. That's the outage costing
 * work, which is the thing this ticket is about.
 *
 * Cleared after the await either way, never before: a push that fails again
 * must leave the desk queued rather than swallow it.
 */
async function flush(): Promise<void> {
  const pending = unflushed;
  if (!pending) return;
  await putWorkspace(pending);
  if (unflushed === pending) unflushed = null;
}

/**
 * Bound on `drain`'s passes. Each one is a real round trip, so a desk being
 * dragged continuously would otherwise keep this spinning inside a single
 * attempt; three is enough to settle the realistic case (one desk queued behind
 * one in flight) and anything past it is the backoff's problem, not this loop's.
 */
const MAX_FLUSH_PASSES = 3;

/**
 * Push until the slot is empty. Returns false if a desk is STILL waiting.
 *
 * Not-losing deskB isn't enough on its own: `recover` calls `noteRecovered()`
 * next, which cancels the timer deskB's own failure had just armed and clears
 * the notice. Keeping the desk while cancelling the only thing that would ever
 * send it leaves the daemon holding deskA and the UI claiming everything is
 * fine — the same bug, one step further along. So recovery isn't finished while
 * anything is queued: either this drains it, or the caller stays degraded and
 * re-arms.
 */
async function drain(): Promise<boolean> {
  for (let pass = 0; unflushed && pass < MAX_FLUSH_PASSES; pass++) await flush();
  return !unflushed;
}

/**
 * Whether we have successfully READ the daemon's copy this session, and so
 * whether we're entitled to overwrite it.
 *
 * This gates every push, and it exists to close a data-loss path that only
 * shows up in the scenario this whole feature is for. If the store is
 * unreachable at page load, the restore falls back to the local mirror — and
 * on a browser that has never been here, the mirror is empty. The desktop then
 * builds itself from live sessions at cascade positions, the watcher fires,
 * and the moment the store comes back that from-scratch layout is written
 * straight over the desk you arranged on the other machine.
 *
 * So: no read, no write. Nothing is lost — the mirror keeps working — and the
 * daemon's copy is only ever replaced by a client that knows what it's
 * replacing.
 *
 * DRY-58: it used to take a page reload to get that read in, which meant an
 * outage at page load cost roaming for the rest of the session and said so only
 * to the console. `recover()` below re-reads on a backoff instead, so the latch
 * opens on its own.
 */
let mayPush = false;

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
  recovery: RecoveryHooks,
): Promise<PersistedLayout | null> {
  // Armed before the first read, not after a failed one: this IS the call that
  // can fail, and a recovery path installed in the success branch would be
  // installed exactly when it isn't needed.
  hooks = recovery;
  recoveryHost = host;
  listen();
  try {
    const workspace = await fetchWorkspace();
    // The read succeeded, so we now know what the daemon holds — including
    // "nothing" — and may write over it.
    mayPush = true;
    noteRecovered();
    const remote = validate(workspace);
    if (remote) {
      writeLocal(host, remote); // keep the offline mirror current
      return remote;
    }
    // The daemon has nothing for us. If this browser does, it's a desk that
    // predates daemon-side storage (or a reset done elsewhere) — hand it up, so
    // upgrading to DRY-28 is a one-time migration instead of a silent reset.
    const local = readLocal(host);
    if (local) {
      void putWorkspace(local).catch((err) => {
        // Queue it: a one-time migration that lands in a blip and is never
        // retried is the DRY-14 desk quietly staying behind forever.
        unflushed = local;
        noteDegraded(err);
      });
      return local;
    }
    return null;
  } catch (err) {
    // Daemon unreachable, its store degraded (503), or the read timed out:
    // fall back to the mirror and, crucially, DON'T push (see `mayPush`). The
    // desktop still works, and `noteDegraded` arms the re-read that gets it
    // roaming again once the store comes back.
    noteDegraded(err);
    return readLocal(host);
  }
}

/**
 * Persist an arrangement. Fire-and-forget by design — the caller is a debounced
 * watcher on a drag, and saving a layout must never be something the UI waits
 * on. The local mirror is written synchronously first, so an unreachable daemon
 * (or a tab closed mid-request) can't lose the arrangement outright.
 *
 * A push that doesn't land is REMEMBERED, not queued (DRY-58). One slot, always
 * the newest desk: replaying every drag of an outage would just walk the
 * windows through positions nobody is waiting to see, and the last one is the
 * only one that was ever true.
 */
export function saveLayout(host: string, layout: LayoutMode, windows: Win[]): void {
  const data: PersistedLayout = { version: LAYOUT_VERSION, layout, windows };
  writeLocal(host, data);
  if (!mayPush) {
    // Never overwrite a copy we failed to read — but keep it, because the
    // re-read that opens the latch is going to need something to send.
    unflushed = data;
    return;
  }
  if (recovering) {
    // Hand it to the attempt already in flight rather than starting a second
    // writer. Two pushes racing to the same row is a last-write-wins the
    // client doesn't control: if the store heals mid-window, this desk can
    // succeed and mark everything recovered while the older one lands after it
    // at the daemon — which then keeps the older desk with nothing armed.
    // Narrow, but free to remove, and `drain` picks this up before the attempt
    // is allowed to call itself finished.
    //
    // Costs nothing on the healthy path: `recovering` can only be true while
    // `degraded` is, since that's the only way `recover` runs at all.
    unflushed = data;
    return;
  }
  putWorkspace(data).then(noteRecovered, (err) => {
    unflushed = data;
    noteDegraded(err);
  });
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
  // Drop anything the recovery loop was holding. A reset that raced an outage
  // would otherwise heal by pushing the desk you just asked to delete back up.
  // The DELETE itself isn't retried on purpose: the local copy is already gone,
  // so a retry can only resurrect state, never restore it.
  unflushed = null;
  try {
    await deleteWorkspace();
  } catch (err) {
    noteDegraded(err);
  }
}
