<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import TerminalPane from "./components/TerminalPane.vue";
import SessionTombstone from "./components/SessionTombstone.vue";
import WorkspacePane from "./components/WorkspacePane.vue";
import MarkdownPane from "./components/MarkdownPane.vue";
import WindowFrame from "./components/WindowFrame.vue";
import TrackerSidebar from "./components/TrackerSidebar.vue";
import TicketDetail from "./components/TicketDetail.vue";
import QuickLaunch from "./components/QuickLaunch.vue";
import RunRail from "./components/RunRail.vue";
import { openGates, startGateStream, stopGateStream } from "./composables/gateStore.js";
import { askToNotify, notifyGate, useAttention } from "./composables/attention.js";
import { isFinished, runState } from "./composables/runState.js";
import { clearNotice, noticeList, setNotice } from "./composables/notices.js";
import { useWindowManager, type LayoutMode, type Win } from "./composables/useWindowManager.js";
import {
  DAEMON_HTTP,
  canResumeConversation,
  createSession,
  fetchConfig,
  fetchSessionHistory,
  killSession,
  listSessions,
  takeOverRun,
  type SessionRecord,
} from "./lib/daemon.js";
import type { PermissionMode } from "./lib/protocol.js";
import { TICKET_POLL_MS, getTrackerInfo, listTickets, type Ticket } from "./lib/tracker.js";
import type { SessionInfo } from "./lib/protocol.js";

// Persist the workspace arrangement per daemon host (DRY-14) so a reload
// restores positions/sizes/dock/z-order/layout instead of resetting them.
const wm = useWindowManager({ persistKey: DAEMON_HTTP });

const tickets = ref<Ticket[]>([]);
const providerName = ref("Switchyard");
/**
 * Did /api/tracker/info actually answer? (DRY-55)
 *
 * `providerName`'s default is optimistic on purpose (DRY-51: the name stays at
 * its default when the call doesn't produce one), which is harmless for a
 * header LABEL and not harmless at all in an error, where it becomes a claim
 * about which system is down. A Jira host whose daemon is unreachable would
 * otherwise be told "Can't reach Switchyard" — naming a tracker it has never
 * been configured with, and sending whoever reads it somewhere that doesn't
 * exist. When we haven't confirmed the name, the outage copy says "the tracker".
 */
const providerNamed = ref(false);

// The host's autonomous-run policy (DRY-49). Only the launch panel uses it, and
// only to say what "host default" actually means; a daemon that doesn't serve
// /api/config leaves it undefined and the panel names `manual`.
const hostRunMode = ref<PermissionMode | undefined>(undefined);

/**
 * How long a finished session stays on the desk before clearing itself (DRY-60).
 *
 * Host config, read from /api/config, with the daemon's own default repeated
 * here as the fallback for a daemon too old to serve it — NOT 0. A missing
 * field means "that daemon has no opinion", and reading it as "off" would make
 * the feature silently absent on exactly the hosts nobody thought to look at.
 */
const clearFinishedAfterMs = ref(300_000);

// Tracker pull scope (DRY-30). Host defaults come from /api/tracker/info
// (DRYDOCK_TRACKER_PROJECTS — fixed chips); user-added keys and the backlog
// toggle are per-browser, persisted per daemon host like the layout. The
// effective list rides on every tickets fetch so the daemon only pulls what's
// scoped — against a corporate tracker "everything" is not an option.
const SCOPE_KEY = `drydock:tracker-scope:${DAEMON_HTTP}`;
const scopeProjects = ref<string[]>([]);
const userProjects = ref<string[]>([]);
const showBacklog = ref(false);

function loadScope(): void {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Array.isArray(s.projects)) userProjects.value = s.projects.filter((p: unknown) => typeof p === "string");
    showBacklog.value = !!s.backlog;
  } catch {
    /* corrupt scope state → defaults */
  }
}
function saveScope(): void {
  localStorage.setItem(
    SCOPE_KEY,
    JSON.stringify({ projects: userProjects.value, backlog: showBacklog.value }),
  );
}

function addScopeProject(key: string): void {
  if (scopeProjects.value.includes(key) || userProjects.value.includes(key)) return;
  userProjects.value = [...userProjects.value, key];
  saveScope();
  void loadTickets();
}
function removeScopeProject(key: string): void {
  userProjects.value = userProjects.value.filter((k) => k !== key);
  saveScope();
  void loadTickets();
}
function toggleBacklog(show: boolean): void {
  showBacklog.value = show;
  saveScope();
  void loadTickets();
}
const sidebarOpen = ref(true);
const quickOpen = ref(false);
const selectedTicket = ref<Ticket | null>(null);
// Stacking order for the floating ticket detail (DRY-20). It's not a daemon
// session so it lives outside wm.windows, but it draws its z from the same
// counter so it layers against (and can be raised above) the terminals.
const ticketZ = ref(0);
// Two different things wear the same banner and they must not clobber each
// other. `error` is a CONTINUING condition owned by the 3s poll: set while the
// daemon won't answer, cleared the moment it does. An action failure is a past
// event that nothing will re-raise — a kill that didn't take, a spawn that
// failed — so the poll's next success must not erase it. Sharing one ref gave
// every action error a ≤3s life, and the one dismissRun raises was wiped by the
// refresh() on its very next line, in the same task that set it (DRY-51).
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);

// Markdown doc viewer (DRY-35): opened by Ctrl/Cmd-clicking a file token in
// any terminal pane. Like the ticket detail it's a floating non-window (no
// daemon session), drawing z from the same counter to stack correctly.
const doc = ref<{ sessionId: string; path: string } | null>(null);
const docZ = ref(0);
function openSessionFile(sessionId: string, path: string) {
  doc.value = { sessionId, path };
  docZ.value = wm.allocZ();
}

// Live per-session state. Daemon poll discovers sessions + gives a status/pending
// fallback; TerminalPane emits override it instantly over the WebSocket.
const sessionsById = reactive<Record<string, SessionInfo>>({});
const live = reactive<
  Record<string, { status?: SessionInfo["status"]; attention?: boolean; idle?: boolean }>
>({});
const ticketById = reactive<Record<string, string>>({});
const initialInputById = reactive<Record<string, string>>({});

/**
 * Poll-driven clock, for the one label that has to count DOWN (DRY-60).
 *
 * 3s granularity, which is why the window's countdown is rendered in whole
 * minutes: a mm:ss that only moves every third second reads as a stopwatch
 * that's broken. The rail has its own 1s tick and shows mm:ss off that.
 */
const now = ref(Date.now());

let poll: ReturnType<typeof setInterval> | null = null;
let ticketPoll: ReturnType<typeof setInterval> | null = null;
const refreshingTickets = ref(false);

/**
 * Why the last ticket pull failed, or null while they're working (DRY-55).
 *
 * A tracker outage was the one daemon failure the desk absorbed in silence.
 * Keeping the last-good list (below) is right on a REFRESH — a hiccup must not
 * blank the sidebar — but on the first load there is no last-good list, so
 * `tickets` stays `[]` and the sidebar renders its ordinary "No tickets match.",
 * which is indistinguishable from a tracker that is up and genuinely has
 * nothing in scope. With the scope chips (DRY-30) making "no tickets" a
 * plausible state, that sends you hunting through filters and project keys for
 * tickets that were never fetched.
 *
 * Owned by the 20s poll, so it's a CONDITION in the DRY-51 sense — cleared by
 * the next success, never dismissible — which is why it also raises a notice
 * rather than reusing `actionError`.
 */
const trackerError = ref<string | null>(null);

// Re-pull tickets so the sidebar reflects external status changes (DRY-17).
// Replaces the data only — TrackerSidebar keeps its own search/filter/expand
// state, so a refresh doesn't disturb what the user is looking at. A tracker
// hiccup keeps the last-good list rather than blanking the sidebar — and since
// DRY-55, says so, instead of letting it pass for current.
// Epoch guard: scope changes (backlog toggle, chips) refetch immediately, so a
// slow older request can resolve AFTER a newer one — without the guard it
// overwrites the fresh list and the sidebar looks "stuck" on the old scope.
// Only the latest in-flight load may commit its result or clear the spinner
// (the sidebar disables the scope controls while refreshing is true).
let loadEpoch = 0;
async function loadTickets() {
  const epoch = ++loadEpoch;
  refreshingTickets.value = true;
  try {
    const list = await listTickets(true, {
      projects: [...scopeProjects.value, ...userProjects.value],
      backlog: showBacklog.value,
    });
    if (epoch === loadEpoch) {
      tickets.value = list;
      trackerError.value = null;
      clearNotice("tracker");
    }
  } catch (e) {
    // Keep the last-good list, but SAY that's what's on screen (DRY-55). The
    // two cases are worded apart on purpose: an empty sidebar is a claim to
    // correct, whereas a populated one is real data that has merely stopped
    // being current — and only the second is how somebody spawns an agent
    // against a ticket that closed an hour ago.
    //
    // Epoch-guarded like the success path, which the old bare `catch` didn't
    // need: a slow pull failing after a newer one succeeded must not raise an
    // outage over a list that just arrived.
    if (epoch === loadEpoch) {
      trackerError.value = String(e);
      // Never the optimistic default — see providerNamed.
      const who = providerNamed.value ? providerName.value : "the tracker";
      setNotice(
        "tracker",
        tickets.value.length
          ? `Tickets aren't refreshing from ${who} — the sidebar is showing the last list it returned`
          : `Tickets aren't loading from ${who} — the sidebar is empty because of that, not because nothing matched`,
        String(e),
      );
    }
  } finally {
    if (epoch === loadEpoch) refreshingTickets.value = false;
  }
}

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "~";
}

// A workspace window (DRY-21) owns a second, "claimed" PTY — its bottom zsh
// shell — that must never get its own standalone window. Collect those ids so
// reconcile skips them (and cleans up any stray window that raced onto one).
function claimedShellIds(): Set<string> {
  const s = new Set<string>();
  for (const w of wm.windows) if (w.kind === "workspace" && w.shellId) s.add(w.shellId);
  return s;
}

/**
 * The window the USER last put focus in — which is not `wm.focusedId` (DRY-60).
 *
 * That ref is also assigned synthetically: `remove()` hands focus to the first
 * non-minimized window in array order when the focused one goes, `add()` claims
 * it for every window reconcile cascades in, and `minimize()` leaves it pointing
 * at a window that is now in the dock. Any of those is enough to make the
 * sweep's focus exemption land on a finished window nobody has ever clicked —
 * which exempts it permanently, so the desk quietly keeps one dead window
 * forever and the pile this ticket is about starts growing again.
 *
 * So the exemption reads intent instead: set only where somebody acted, cleared
 * when the window is minimized or forgotten. Restoring a saved desk does NOT
 * set it — on a reload you haven't touched anything yet, and the countdown
 * showing is the honest answer.
 */
const userFocusedId = ref<string | null>(null);

/** Raise a window because somebody clicked it. */
function focusWindow(id: string): void {
  userFocusedId.value = id;
  wm.bringFront(id);
}

/** Bring one back from the dock, likewise on purpose. */
function restoreWindow(id: string): void {
  userFocusedId.value = id;
  wm.restore(id);
}

// Everything this desk remembers about a window, forgotten in one place. No
// kill: the PTY side is the caller's business (some callers have already killed
// it, some have nothing to kill), and every one of them used to reclaim a
// different subset of these maps.
//
// `tombstones` is merged rather than replaced on each fetch, so this is where
// its entries are reclaimed. `live` is here too: it is fed by a mounted pane's
// WebSocket and nothing else ever removes an entry, so on a desk that spawns
// and clears all day it is the one map that only grows — and a workspace's
// co-located shell has an entry under an id no window is keyed by, which is why
// the window has to be read before it is spliced out.
//
// `finishedSeenAt` is deliberately NOT reclaimed here. It is keyed by SESSION,
// not by window — an autonomous run has a stamp and no window at all — and the
// sweep prunes it against the session list each tick. Clearing it here would
// restart the countdown on a run whose window you merely closed.
function forgetWindow(id: string) {
  const w = wm.windows.find((x) => x.id === id);
  if (w?.kind === "workspace" && w.shellId) delete live[w.shellId];
  wm.remove(id);
  delete tombstones[id];
  awaitingHistory.delete(id);
  delete initialInputById[id];
  delete ticketById[id];
  delete live[id];
  // A window nobody can see is not a window somebody is in (DRY-60).
  if (userFocusedId.value === id) userFocusedId.value = null;
}

// Drop a window from the desk. For a workspace, its co-located shell PTY has no
// window of its own, so kill it here too rather than leaking an orphan session.
function dropWindow(id: string) {
  const w = wm.windows.find((x) => x.id === id);
  if (w?.kind === "workspace" && w.shellId) killSession(w.shellId).catch(() => {});
  forgetWindow(id);
}

/**
 * End a window's session(s) and take the window off the desk.
 *
 * The one path for it, shared by the ✕, the rail's dismiss and the sweep. They
 * had three near-identical copies of this block, differing only in their error
 * copy — and, after DRY-60, in whether they took the `clearing` guard, which
 * meant the ✕ kept a race the sweep had just been taught to avoid.
 *
 * Returns the failures, empty when it worked, or `null` when another caller is
 * already ending this window (which is not success, and must not be reported as
 * one). Both PTYs are killed independently and the window only goes once both
 * are actually dead: killing is what the ✕ promises, so if it didn't happen the
 * window is the only handle left on a live PTY and keeping it is the lesser
 * failure (DRY-51 review).
 */
async function endWindow(id: string): Promise<string[] | null> {
  if (clearing.has(id)) return null;
  clearing.add(id);
  try {
    const w = wm.windows.find((x) => x.id === id);
    const shellId = w?.kind === "workspace" ? w.shellId : undefined;
    const outcomes = await Promise.allSettled([
      killSession(id),
      ...(shellId ? [killSession(shellId)] : []),
    ]);
    const failed = outcomes
      .filter((o) => o.status === "rejected")
      .map((o) => String((o as PromiseRejectedResult).reason));
    if (!failed.length) forgetWindow(id);
    return failed;
  } finally {
    clearing.delete(id);
    // The guard is down; anything already in flight predates it. See deskEpoch.
    deskEpoch++;
  }
}

// --- clearing finished sessions (DRY-60) ------------------------------------

/**
 * When each finished session first had a chance to be READ — not when it ended.
 *
 * The distinction is the whole safety story. A run that finishes at 3am while
 * the tab is closed (or behind another tab) must still be there to be seen at
 * 9am, so the clock starts when the desk is actually in front of somebody and
 * starts over whenever it stops being. Keyed by session id, which is also the
 * window id for everything that has one.
 */
const finishedSeenAt = reactive<Record<string, number>>({});

/**
 * Clears in flight. Re-entry guard for the 3s sweep — a kill takes a round trip
 * and the poll doesn't wait — and, just as importantly, read by `reconcile`:
 * between the kill landing and the window being removed there is a poll in
 * which the session is gone and its window isn't, which reconcile would
 * otherwise read as a session lost and answer with a tombstone (DRY-56) or the
 * file tier's "a window that closes can't be resumed" notice. Neither is true
 * of a window somebody asked to be cleared.
 */
const clearing = new Set<string>();

/**
 * Epoch guards for the session poll, the pair that makes `clearing` airtight.
 *
 * `clearing` only covers the span between the kill being issued and the window
 * being forgotten. A `listSessions()` issued BEFORE that span and landing after
 * it sees neither: the guard has already been released, and the list it carries
 * still has the session in it. `refreshEpoch` retires a superseded refresh (two
 * run concurrently whenever `clearFinished` fires between poll ticks);
 * `deskEpoch` retires a list that a teardown has invalidated under it.
 *
 * Same shape as `loadTickets`' guard above, for the same reason — the newest
 * answer is the only one entitled to commit.
 */
let refreshEpoch = 0;
let deskEpoch = 0;

/**
 * What may be cleared at all — by the button, by the sweep, by anything.
 *
 * Takes the whole list rather than one session because both exemptions need an
 * index of the desk, and building `claimedShellIds()` plus a `windows.find()`
 * per session made this quadratic in a function the 3s poll and a computed both
 * call. One pass, two maps.
 *
 * The exemptions, each a thing that would otherwise be destroyed:
 *
 *  - a FAILURE. The ticket's one hard constraint: clearing must never be how you
 *    lose a failed run. `isFinished` carries this, so it holds for the button
 *    and the sweep alike, and a failed card keeps its ✕ and its pulse.
 *  - a workspace's co-located zsh, which has no window of its own. Sweeping it
 *    on its own account would kill a PTY its window is still rendering.
 *  - a workspace whose agent exited while that zsh is still alive. Clearing the
 *    window kills both, and the shell is where somebody's half-finished command
 *    line lives. Half a workspace is not a finished session.
 *
 * The window is handed back alongside because the SWEEP needs it for two
 * further exemptions the button deliberately doesn't take (see sweepFinished).
 */
function clearable(list: SessionInfo[]): { session: SessionInfo; win?: Win }[] {
  const claimed = claimedShellIds();
  const byId = new Map(wm.windows.map((w) => [w.id, w]));
  const out: { session: SessionInfo; win?: Win }[] = [];
  for (const session of list) {
    if (!isFinished(session) || claimed.has(session.id)) continue;
    const win = byId.get(session.id);
    if (win?.kind === "workspace" && win.shellId) {
      const shell = sessionsById[win.shellId];
      if (shell && shell.status !== "exited") continue;
    }
    out.push({ session, win });
  }
  return out;
}

/** What "Clear finished" would take right now. Also the button's count. */
const clearableIds = computed(() => clearable(sessionList.value).map((c) => c.session.id));

/**
 * Kill a finished session and take its window with it.
 *
 * A failure re-stamps the clock as well as reporting itself: without that, an
 * auto-clear that cannot succeed retries on every 3s poll and rewrites the
 * banner each time.
 */
async function clearSession(id: string): Promise<boolean> {
  const failed = await endWindow(id);
  if (failed === null) return false; // already going; not ours to report on
  if (failed.length) {
    finishedSeenAt[id] = Date.now();
    actionError.value = `Couldn't clear a finished session — it may still be listed: ${failed.join("; ")}`;
    return false;
  }
  return true;
}

/**
 * "Clear finished" — every ending at once, which is the escape hatch the sweep's
 * policy needs for when it guesses wrong (either way: too slow, or turned off).
 *
 * Deliberately ignores every restraint the sweep works under — the clock, the
 * focused window, the docked ones. Those exist to stop the desk throwing
 * something away on its own; this is somebody saying to.
 */
async function clearFinished(): Promise<void> {
  const ids = clearableIds.value;
  if (!ids.length) return;
  await Promise.all(ids.map((id) => clearSession(id)));
  await refresh();
}

/**
 * Retire finished sessions that have been on screen long enough (DRY-60).
 *
 * Runs on the session poll, off the list it just fetched. What it does NOT do
 * is measure time since the run ended: `finishedSeenAt` is stamped here, only
 * while the tab is in front of somebody, so twenty runs that finished overnight
 * get their full five minutes starting from the moment you look at them.
 */
function sweepFinished(list: SessionInfo[]): void {
  const at = Date.now();
  const visible = document.visibilityState === "visible";
  const candidates = clearable(list);
  const stamped = new Set<string>();
  for (const { session, win } of candidates) {
    // Two exemptions the BUTTON doesn't take, because both mark a window
    // somebody placed deliberately — and only the automatic path is at risk of
    // taking one out from under them:
    //
    //  - the window they are in. It gets no clock at all, not a restarting one:
    //    the latter also survives the sweep, but renders a window sitting there
    //    promising to close for as long as you keep looking at it. Clicking
    //    away stamps it fresh on the next poll, so it still counts down in full.
    //  - a DOCKED window. The rail's contract for that lane is "you put them
    //    here and you're coming back; they never change unless you touch them",
    //    and a dock item has nowhere to render a countdown — so sweeping one is
    //    the only removal on this desk that could happen with no warning
    //    anywhere. `Clear finished` still takes them, and still counts them.
    if (userFocusedId.value === session.id || win?.minimized) continue;
    stamped.add(session.id);
    if (visible) finishedSeenAt[session.id] ??= at;
  }
  // A stamp outlives its session by one poll at most: the id is gone from the
  // list once the kill lands, and a stale entry would be a countdown on a card
  // that no longer exists. Keyed off what may be SWEPT, so focusing or docking
  // a window drops its countdown rather than freezing it mid-number.
  for (const id of Object.keys(finishedSeenAt)) if (!stamped.has(id)) delete finishedSeenAt[id];

  if (!visible || !clearFinishedAfterMs.value) return;
  for (const id of stamped) {
    const seen = finishedSeenAt[id];
    if (seen === undefined || at - seen < clearFinishedAfterMs.value) continue;
    // Announced only once the clear ACTUALLY happened. Raising it first would
    // put a line about lost sessions on screen for a kill that then failed and
    // lost nothing.
    void clearSession(id).then((cleared) => {
      if (cleared) void announceSweepLoss();
    });
  }
}

/**
 * Say, once, that the sweep is discarding sessions this Drydock keeps no record
 * of (DRY-60).
 *
 * The same fact reconcile raises when a window is lost, so it reuses that
 * notice's key: raised once however many sessions get swept, cleared by whoever
 * raised it, exactly as DRY-58 requires.
 *
 * Only the AUTOMATIC path announces. The ✕ and "Clear finished" are somebody
 * choosing to discard something, and a line explaining what they just chose is
 * noise. And it has to ASK rather than assume — `historyKept` is demand-driven,
 * so on a desk that has never lost a window it is still null at the first sweep,
 * and a bare `=== false` test would stay quiet on precisely the tier the notice
 * exists for.
 */
async function announceSweepLoss(): Promise<void> {
  if (historyKept.value === null) await refreshHistory(true);
  if (historyKept.value !== false) return;
  setNotice(
    "session-history",
    "Sessions aren't being recorded — a window that closes can't be resumed.",
    "Set DRYDOCK_DATABASE_URL to keep session history.",
  );
}

/**
 * Away from the desk: every countdown starts over when you come back.
 *
 * The alternative — letting stamps age while the tab is hidden — means a run
 * that finished four minutes before you switched tabs is swept a few seconds
 * after you return, having shown its countdown to nobody. The cost is that a
 * ten-second glance at another tab restarts the clock, which is invisible
 * unless you were watching the number.
 *
 * Note the limit of what this can see: `visibilitychange` covers a hidden tab
 * and a minimized browser, not a visible window sitting behind an editor. The
 * countdown on the card is what covers the rest.
 */
function onVisibility(): void {
  if (document.visibilityState === "visible") return;
  for (const id of Object.keys(finishedSeenAt)) delete finishedSeenAt[id];
}

// --- session discovery / reconciliation ---
function reconcile(list: SessionInfo[]) {
  const ids = new Set(list.map((s) => s.id));
  const claimed = claimedShellIds();
  for (const k of Object.keys(sessionsById)) if (!ids.has(k)) delete sessionsById[k];
  for (const s of list) sessionsById[s.id] = s;

  for (const s of list) {
    // A workspace's shell PTY is rendered inside its workspace window, not as a
    // window of its own — don't cascade-add a standalone terminal for it.
    if (claimed.has(s.id)) continue;
    // An autonomous run's home is the rail, not the desk (DRY-49). Without this
    // the very next poll would hand every unattended run a window, which is the
    // one thing the whole feature exists to avoid. Watching one adds a window
    // deliberately (openRun); reconcile then leaves it alone, because a window
    // for it already exists.
    if (s.autonomous && !wm.windows.find((w) => w.id === s.id)) continue;
    // Being cleared right now (DRY-60). This list may predate the kill — it is
    // fetched at the top of refresh() and a clear can land while it is in
    // flight — and re-adding here would put the window back at a CASCADE
    // position and steal focus (wm.add sets focusedId), for a session that is
    // already gone. The next poll would then drop it again: a window that
    // flickers back onto the desk on its way out.
    if (clearing.has(s.id)) continue;
    if (!wm.windows.find((w) => w.id === s.id)) {
      wm.add({
        id: s.id,
        type: s.command === "claude" ? "agent" : "bash",
        title: s.command === "claude" ? "claude-code" : s.command,
        // Prefer client-side spawn intent, but fall back to the daemon's record
        // so a ticket badge survives a page reload / reattach.
        ticket: ticketById[s.id] ?? s.ticket,
        repo: basename(s.cwd),
      });
    }
  }
  for (const w of [...wm.windows]) {
    // A plain window that landed on a now-claimed shell id (spawn/poll race):
    // drop the duplicate, but leave the PTY alive — its workspace owns it.
    if (w.kind !== "workspace" && claimed.has(w.id)) wm.remove(w.id);
    // Being cleared right now (DRY-60). The kill has landed and the window
    // hasn't gone yet, which is indistinguishable from a session that died —
    // and answering it as one draws a tombstone over a window somebody asked to
    // be rid of, or raises the file tier's lost-session notice for a loss that
    // was deliberate. clearSession removes it a tick later.
    else if (clearing.has(w.id)) continue;
    else if (!ids.has(w.id)) {
      // Its PTY is gone. On a tier that records sessions the window STAYS, as a
      // tombstone you can resume from (DRY-56) — before this it simply vanished
      // on the next poll, taking with it any record that the session had
      // existed, what ticket it was on, or where it was running.
      //
      // Only when we actually hold a record. No record means either the file
      // tier (which says so once, via the notice below) or a session older than
      // whatever history retains, and inventing a tombstone from the window
      // alone would offer a resume that can't say where to resume.
      if (tombstones[w.id]) {
        awaitingHistory.delete(w.id);
        // A workspace's co-located zsh has no window of its own, and
        // `claimedShellIds()` keeps reconcile from ever giving it one. Turning
        // the window into a tombstone skips dropWindow — the only thing that
        // kills it — so without this the shell PTY (and its supervisor) keeps
        // running, invisible to the desk and unreachable from it. Release it
        // and demote the window to a plain terminal, which is what a tombstone
        // is: there is no live pane left for the workspace split to show.
        if (w.kind === "workspace" && w.shellId) {
          killSession(w.shellId).catch(() => {});
          wm.updateWin(w.id, { kind: "terminal", shellId: undefined });
        }
        continue;
      }
      // We haven't asked about this one yet. Ask, keep the window for one more
      // pass, and let the next poll decide — the alternative is dropping it
      // now and re-adding a tombstone a moment later, which is a window
      // flickering out of and back into the desk.
      if (historyKept.value !== false && !awaitingHistory.has(w.id)) {
        awaitingHistory.add(w.id);
        void refreshHistory(true);
        continue;
      }
      awaitingHistory.delete(w.id);
      // This is the moment the missing tier costs something: a window is going
      // away and nothing will be left to say it existed. DRY-58 built this
      // surface for exactly this class of quiet condition; it's raised here
      // rather than at startup so it only ever appears to somebody who just
      // lost a session they might have wanted back.
      if (historyKept.value === false) {
        setNotice(
          "session-history",
          "Sessions aren't being recorded — a window that closes can't be resumed.",
          "Set DRYDOCK_DATABASE_URL to keep session history.",
        );
      }
      dropWindow(w.id);
    }
  }
}

/**
 * Session history, keyed by the id whose window it belongs to (DRY-56).
 *
 * Deliberately NOT persisted into the workspace blob. A tombstone is derived
 * state — the daemon is the authority on whether a session is alive, and a
 * cached "this is dead" surviving a reload is how you get a tombstone drawn
 * over a session that came back (which DRY-57 made the common case). Re-fetched
 * instead, so the answer is always the daemon's.
 */
const tombstones = reactive<Record<string, SessionRecord>>({});
const resuming = ref<string | null>(null);
/** Null until asked; false once we know this tier keeps no history. */
const historyKept = ref<boolean | null>(null);
/** Windows whose session vanished and whose history answer we're still waiting on. */
const awaitingHistory = new Set<string>();

/**
 * Demand-driven, not per-poll.
 *
 * The session poll runs every 3s; a `select … limit 50` behind each one is a
 * database round trip per tab per 3s to answer a question that changes only
 * when a session ends. So: a floor between refreshes, and `force` for the one
 * moment the answer actually matters — reconcile noticing a window whose
 * session has gone.
 */
let historyFetchedAt = 0;
let historyInFlight: Promise<void> | null = null;
const HISTORY_MIN_INTERVAL_MS = 15_000;

/**
 * Drop a previous `--resume <id>` pair from recorded args.
 *
 * Recorded args are verbatim, so a resumed session's are already
 * `["--resume", "<old id>"]`. Removing the flag alone leaves the id as a
 * trailing positional, which Claude Code reads as the initial prompt.
 */
function withoutResume(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i++; // and its value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function refreshHistory(force = false): Promise<void> {
  // One fetch at a time. A reconcile pass that finds three windows missing
  // would otherwise fire three identical requests at a store that may be the
  // slow thing in the first place.
  if (historyInFlight) return historyInFlight;
  if (!force && Date.now() - historyFetchedAt < HISTORY_MIN_INTERVAL_MS) return Promise.resolve();
  historyFetchedAt = Date.now();
  historyInFlight = doRefreshHistory().finally(() => {
    historyInFlight = null;
  });
  return historyInFlight;
}

async function doRefreshHistory(): Promise<void> {
  try {
    const records = await fetchSessionHistory();
    // The tier speaking, not a fault. Recorded, but NOT announced here: a
    // fresh no-database install would then carry a permanent line about a
    // feature it never asked for, and the "spin it up and look" tier is the one
    // that must not nag. The notice is raised at the moment it costs somebody
    // something — see reconcile, where a window is dropped for want of a record.
    if (records === null) {
      historyKept.value = false;
      return;
    }
    historyKept.value = true;
    clearNotice("session-history");
    // MERGED, not replaced. `recent` is a capped list, so a tombstone we
    // already hold can fall out of a later page and would otherwise be dropped
    // silently — taking its window with it, which is the loss this feature
    // exists to prevent. Entries are cleaned up when their window goes.
    for (const r of records) if (r.endedAt) tombstones[r.id] = r;
  } catch (e) {
    // A store outage degrades the desk rather than blanking it: keep whatever
    // tombstones we already had and let the next poll try again. Same rule as
    // the workspace read.
    console.warn("session history unavailable", e);
  }
}

/**
 * Put a working session back where a dead one was.
 *
 * `--resume` only when the CLI's own session id was captured AND its transcript
 * is still on disk; otherwise this is an honest fresh start in the same
 * worktree, and the card says so rather than offering a "Resume" that silently
 * discards the conversation. One predicate, shared with the card, so its label
 * and its behaviour cannot drift apart (DRY-62).
 */
async function resumeSession(record: SessionRecord) {
  if (resuming.value) return;
  resuming.value = record.id;
  try {
    const resumeArgs = canResumeConversation(record) ? ["--resume", record.agentSessionId!] : [];
    const session = await createSession({
      command: record.command,
      // Strip any PREVIOUS --resume and the id that follows it. Filtering the
      // flag alone leaves its value behind, so a second resume spawns
      // `claude --resume <new> <old>` — and that trailing positional is what
      // Claude Code takes as the initial prompt, i.e. the agent starts by being
      // asked to do something about a UUID.
      args: [...resumeArgs, ...withoutResume(record.args)],
      // The recorded worktree, not the repo name: re-resolving `repo` would put
      // the agent in the plain checkout, which is not where its work is.
      cwd: record.worktree ?? record.cwd,
      ticket: record.ticket,
      repo: record.repo,
      // The recorded worktree PATH, not `false`. Opting out skips the daemon's
      // worktree branch entirely, which also skips RECORDING one — so each
      // resume would produce a session with no worktree and no branch, and the
      // next tombstone would say less than the one before it. Passing the path
      // hits `ensureWorktree`'s reuse case (`worktreeExists` → same dir, real
      // branch), so nothing is nested and the record survives the generation.
      worktree: record.worktree ?? false,
      branch: record.branch,
      title: record.title,
    });
    // Swap the window onto the new session in place, so the desk doesn't
    // rearrange under someone who just pressed a button in that window.
    // Reap the corpse if the daemon still lists it. A session that exited but
    // stayed in the registry keeps its id in the poll, so once the window has
    // moved to the new session reconcile would hand the dead one a brand new
    // window — a second pane for something already resumed.
    void killSession(record.id).catch(() => {});
    wm.replaceId(record.id, session.id);
    if (record.ticket) ticketById[session.id] = record.ticket;
    delete tombstones[record.id];
    sessionsById[session.id] = session;
    focusWindow(session.id);
  } catch (e) {
    actionError.value = `Could not resume: ${String(e)}`;
  } finally {
    resuming.value = null;
  }
}

async function refresh() {
  const epoch = ++refreshEpoch;
  const desk = deskEpoch;
  try {
    // NOT awaited, and not called per tick — reconcile forces a fetch at the
    // one moment the answer matters (a window whose session has gone), and the
    // two-pass `awaitingHistory` handshake means nothing here needs to block on
    // it. Awaiting a store that is slow or partitioned would delay every pane
    // attaching and the poll behind it, which is DRY-58's bug class exactly.
    const list = await listSessions();
    // This list describes a desk that no longer exists (DRY-60). Two ways:
    // a NEWER refresh has already committed off a fresher list, or a teardown
    // finished while this one was in flight — and `clearing` was the only thing
    // stopping reconcile re-adding those windows, so by now that guard is down
    // and the session is still in this list. Re-adding it puts the window back
    // at a cascade position WITH FOCUS, for a PTY that is already dead; the
    // next poll drops it again, so it reads as a window flickering onto the
    // desk on its way out. Narrow on loopback, ordinary against a remote
    // daemon — and clearFinished() calls refresh() itself while the 3s poll may
    // already have one in flight, so two are genuinely concurrent.
    if (epoch !== refreshEpoch || desk !== deskEpoch) return;
    reconcile(list);
    now.value = Date.now();
    // AFTER reconcile, off the same list: the sweep decides using window state
    // (focus, a workspace's live shell) that reconcile has just brought up to
    // date, and a window added this tick must not be swept before it exists.
    sweepFinished(list);
    error.value = null;
  } catch (e) {
    // Names the daemon it actually tried, not the dev default: this banner is
    // what you read during a version skew, and a prod shell pointed at :4318
    // telling you to check :4317 sends you to the wrong machine (DRY-51).
    //
    // It also stops asserting the daemon is unreachable. Since listSessions()
    // checks its status, this throw now covers daemons that answered perfectly
    // well — a 404 from a missing route, a 500 — and the getJson message that
    // follows carries the code that tells the two apart.
    error.value = `Can't list sessions from ${DAEMON_HTTP} (${String(e)})`;
  }
}

// --- live status → dot color (ties the prototype's palette to real daemon state) ---
function winStatus(id: string) {
  const l = live[id];
  const s = sessionsById[id];
  // A session the daemon no longer lists has no status to fall back on, so the
  // "running" default at the bottom would paint a tombstone's frame with a live
  // green dot over a card that says "failed". Answer from the record instead.
  const tomb = tombstones[id];
  if (!s && tomb) {
    const dead = tomb.endReason === "failed";
    return {
      c: dead ? "#a06a6a" : "#6a737f",
      g: dead ? "#a06a6a55" : "#6a737f55",
      attention: false,
      tag: "",
    };
  }
  // `live` is fed by a mounted pane's WebSocket, so a MINIMIZED window has no
  // source for it and used to fall back to the 3s poll — the dock dot went
  // amber up to 3s after the tray already showed the gate, and stayed amber
  // just as long after it was answered. The gate stream is instant and covers
  // exactly the windows that have no pane, so consult it first (DRY-50).
  const gated = openGates.value.some((g) => g.sessionId === id);
  const attention = gated || (l?.attention ?? (s ? s.pendingPermissions > 0 : false));
  const idle = l?.idle ?? s?.idle ?? false;
  const status = l?.status ?? s?.status ?? "running";
  // Permission gate wins (it's blocking a tool); then process-dead; then the
  // agent yielding its turn ("Your turn", DRY-18); else actively working.
  if (attention) return { c: "#d6a651", g: "#d6a65177", attention: true, tag: "" }; // needs you
  // Exited, and on its way out (DRY-60). A window closing itself is startling
  // in a way a rail card isn't — it's a thing you placed — so the frame says so
  // for the whole countdown rather than at the end of it. Whole minutes: this
  // is driven by the 3s poll, and a seconds display would visibly skip.
  // Absent means it isn't going anywhere: a failure, a workspace whose shell is
  // still alive, the window you have focused, or a host with the sweep off.
  //
  // Under a minute it says "<1m" rather than rounding up to "1m", because the
  // rail card beside it is counting real seconds: a frame reading "clears in
  // 1m" for the whole of an 8s countdown contradicts a card reading "0:05" on
  // the same desk. Rounding UP is right for the 5-minute default; it was the
  // max(1, …) floor that manufactured a wrong number instead of a vague one.
  if (status === "exited") {
    const seen = finishedSeenAt[id];
    const left = seen !== undefined ? seen + clearFinishedAfterMs.value - now.value : 0;
    const tag = left > 0 ? `clears in ${left < 60_000 ? "<1" : Math.ceil(left / 60_000)}m` : "";
    return { c: "#6a737f", g: "#6a737f55", attention: false, tag }; // exited
  }
  if (idle) return { c: "#d6a651", g: "#d6a65177", attention: true, tag: "Your turn" }; // yielded
  return { c: "#5fb98a", g: "#5fb98a77", attention: false, tag: "" }; // running
}

function onStatus(id: string, status: SessionInfo["status"]) {
  (live[id] ??= {}).status = status;
}
function onAttention(id: string, pending: boolean) {
  (live[id] ??= {}).attention = pending;
}
function onIdle(id: string, idle: boolean) {
  (live[id] ??= {}).idle = idle;
}

// Minimizing unmounts the pane (its WS closes), so the live attention override
// can no longer update and would shadow the daemon poll via the `??` in
// winStatus. Clear it so a session that hits an approval gate *while docked*
// still lights its dock dot (driven by the 3s pendingPermissions poll).
function minimizeWindow(id: string) {
  wm.minimize(id);
  // `wm.minimize` deliberately leaves `wm.focusedId` alone; this ref tracks
  // where somebody IS, and they just put this one away (DRY-60).
  if (userFocusedId.value === id) userFocusedId.value = null;
  // The unmounted pane's WS can no longer update these overrides, and the `??`
  // in winStatus would let them shadow the daemon poll. Clear both so the 3s
  // poll (pendingPermissions / idle) drives the dock dot while docked.
  if (live[id]) {
    live[id].attention = undefined;
    live[id].idle = undefined;
  }
}

// --- spawning ---
// DRY-40: a clicked spawn button keeps keyboard focus, so an Enter meant for
// the new pane's CLI (e.g. its trust prompt) re-clicked the button and spawned
// a duplicate. Blur on click; the new pane's terminal takes focus on mount.
function blurSpawn(e: Event) {
  (e.currentTarget as HTMLElement | null)?.blur();
}

async function spawnFresh(kind: "claude" | "shell") {
  wm.setLayout("float");
  try {
    const s = await createSession({ command: kind, title: kind === "claude" ? "claude-code" : "shell" });
    await refresh();
    focusWindow(s.id);
  } catch (e) {
    actionError.value = String(e);
  }
}

// Spawn a composite workspace (DRY-21): one managed window binding a ticket +
// two PTYs — the agent (claude) and a co-located zsh shell sharing its cwd. The
// window is registered *before* the next poll so reconcile claims the shell PTY
// instead of giving it a standalone window. Ticket-bound spawns pre-open the
// drawer and pre-fill the agent prompt (typed once by TerminalPane).
async function spawnWorkspace(
  opts: {
    ticket?: Ticket;
    prompt?: string;
    cwd?: string;
    worktree?: string | false;
    branch?: string;
    auto?: boolean;
  } = {},
) {
  wm.setLayout("float");
  try {
    const agent = await createSession({
      command: "claude",
      title: "workspace",
      cwd: opts.cwd,
      repo: opts.ticket?.repo,
      ticket: opts.ticket?.key,
      // DRY-15: isolate the agent in its own worktree (or opt out via `false`).
      worktree: opts.worktree,
      branch: opts.branch,
      // Ticket-driven spawns can opt into hands-off "auto" permission mode
      // (DRY-22). Sent as `permissionMode` rather than raw args since DRY-49,
      // so the value is whitelisted daemon-side before it becomes part of a
      // command line — same behaviour, one validated path.
      permissionMode: opts.auto ? "auto" : undefined,
    });
    // Co-locate the human's shell in the agent's *resolved* cwd — which is the
    // worktree when isolated — so both panes start in exactly the same directory.
    // It passes no ticket, so it just runs there and never makes a second worktree.
    const shell = await createSession({ command: "shell", title: "shell", cwd: agent.cwd });
    if (opts.ticket) ticketById[agent.id] = opts.ticket.key;
    if (opts.prompt) initialInputById[agent.id] = opts.prompt;
    wm.add({
      id: agent.id,
      kind: "workspace",
      type: "agent",
      title: "workspace",
      ticket: opts.ticket?.key,
      repo: basename(agent.cwd),
      shellId: shell.id,
      // DRY-36: a ticket spawn opens in its most-agent state — drawer closed
      // and shell collapsed, each one click away. The bare "+ workspace"
      // (no ticket) keeps the shell visible; it exists to pair agent + zsh.
      drawerOpen: false,
      shellCollapsed: !!opts.ticket,
      shellRatio: 0.2,
      w: 760,
      h: 620,
    });
    await refresh();
    focusWindow(agent.id);
  } catch (e) {
    actionError.value = String(e);
  }
}

// Persist the workspace pane's own UI state (drawer/shell collapse, split ratio)
// back onto the Win so the DRY-14 layout watcher writes it through.
function onWorkspacePatch(id: string, patch: Partial<Win>) {
  wm.updateWin(id, patch);
}

// Picking a ticket (sidebar or palette) opens its detail panel; the actual
// spawn happens from there once you've read it and hit "Send to agent".
function openTicket(t: Ticket) {
  closePalette();
  selectedTicket.value = t;
  ticketZ.value = wm.allocZ(); // land it on top of the current windows
}

// "Spawn Agent" from the ticket detail (DRY-36: the single ticket-spawn path):
// open the composite workspace — agent in the resolved cwd/worktree, ticket
// bound to the (closed) drawer, shell collapsed. The panel's prompt is
// pre-filled by TerminalPane, not auto-submitted.
function onSendTicket(payload: {
  ticket: Ticket;
  prompt: string;
  cwd: string;
  worktree: string | false;
  branch?: string;
  auto: boolean;
  autonomous?: boolean;
  permissionMode?: PermissionMode;
}) {
  selectedTicket.value = null;
  if (payload.autonomous) void spawnAutonomous(payload);
  else void spawnWorkspace(payload);
}

/**
 * Launch a run with no window (DRY-49).
 *
 * Deliberately NOT spawnWorkspace with a flag. A workspace is a window binding
 * two PTYs — an agent and a co-located zsh for the human sitting in front of
 * it. An unattended run has neither a human nor a window, so the second PTY
 * would be a shell nobody can reach, kept alive for the length of the run.
 *
 * The prompt goes to the DAEMON rather than into `initialInputById`: that seed
 * is typed by TerminalPane when its socket opens, and there is no pane here to
 * open one. This is the one spawn path where the agent's first message is the
 * daemon's job.
 */
async function spawnAutonomous(opts: {
  ticket: Ticket;
  prompt: string;
  cwd: string;
  worktree: string | false;
  branch?: string;
  permissionMode?: PermissionMode;
}) {
  try {
    await createSession({
      command: "claude",
      title: opts.ticket.key,
      cwd: opts.cwd,
      repo: opts.ticket.repo,
      ticket: opts.ticket.key,
      worktree: opts.worktree,
      branch: opts.branch,
      autonomous: true,
      origin: "you",
      // Undefined means "let the host decide" — the daemon applies
      // DRYDOCK_AUTONOMOUS_PERMISSION_MODE rather than the shell guessing.
      permissionMode: opts.permissionMode,
      input: opts.prompt,
    });
    await refresh();
    // AFTER the spawn, and not awaited. Notification.requestPermission()
    // resolves only when the user answers, and Chrome's permission chip can sit
    // there unanswered indefinitely — awaited before createSession, the
    // first-ever autonomous launch in a browser profile simply never happened
    // and the button looked broken.
    void askToNotify();
  } catch (e) {
    actionError.value = String(e);
  }
}

// Seed consumed once: TerminalPane fires this after typing the pre-filled prompt,
// so a re-mount (restore from dock, poll re-add) doesn't retype it.
function onInitialSent(id: string) {
  delete initialInputById[id];
}

// Closing a window terminates its session. Without the kill the 3s poller sees
// the still-alive daemon session and re-adds the window (and the pane re-typed
// the seed) — minimize→dock is the "keep running" path, the X means done.
async function closeWindow(id: string) {
  // Closing a WATCHED run's window stops watching it; it does not end the run
  // (DRY-49). The X means "done with this window", and for an autonomous run
  // the window was only ever a viewport onto something whose home is the rail —
  // killing the session here would make looking at a run the way you destroy
  // it. Take over first if you want the X to mean what it usually means.
  if (sessionsById[id]?.autonomous) {
    forgetWindow(id);
    return;
  }
  // A workspace also owns a co-located shell PTY with no window of its own, so
  // both are killed — independently, and the window only goes once both are
  // actually dead. Sequential awaits meant a failed agent kill skipped the
  // shell entirely; removing the window regardless then left a live PTY with no
  // window, no dock entry and no way back to it — an orphan you can only find
  // from the API (DRY-51 review). Killing is what the X promises, so if it
  // didn't happen the window is the only handle you have left: keep it.
  //
  // Via endWindow since DRY-60, which is also where the `clearing` guard lives:
  // there is a poll between the kill landing and the window going, and this path
  // has always had it — long enough for reconcile to answer a deliberate close
  // with a DRY-56 tombstone, or with the file tier's lost-session notice.
  const failed = await endWindow(id);
  if (failed?.length) {
    actionError.value = `Couldn't stop that session — it may still be running: ${failed.join("; ")}`;
  }
}

// --- visible windows + computed rects ---
const rects = computed(() => wm.computeRects());
const visible = computed(() => wm.windows.filter((w) => !w.minimized));
const sessionList = computed(() => Object.values(sessionsById));

// NB which sessions have a pane is NOT computed here. TerminalPane claims and
// releases its own session id (gateStore), so the tray observes the fact rather
// than re-deriving it from window state — every v-if a pane hides behind would
// otherwise have to be restated here, and be wrong until it was (DRY-50).

// The tray knows session ids; wm.restore() matches window ids. Those differ for
// a workspace's shell PTY, which has no window of its own — restore(shellId)
// would find nothing and the button would silently do nothing.
function openSessionWindow(sessionId: string): void {
  const w = wm.windows.find((x) => x.id === sessionId || x.shellId === sessionId);
  if (w) restoreWindow(w.id);
}

// --- the rail (DRY-49) ------------------------------------------------------
// UNDERWAY is derived from the DAEMON's session list, not from anything the
// desk remembers. That's what makes a run survive a reload without being in the
// workspace payload: it is autonomous because /api/sessions says so.
const autonomousRuns = computed(() => sessionList.value.filter((s) => s.autonomous));

/** Autonomous runs that also have a window open — "watched", per the design. */
const watchedIds = computed(() =>
  autonomousRuns.value.filter((s) => wm.windows.some((w) => w.id === s.id)).map((s) => s.id),
);

/**
 * When each finished run's card will clear itself, epoch ms (DRY-60).
 *
 * Sent as an ABSOLUTE deadline rather than a remaining duration because the rail
 * ticks its own 1s clock and this map is rebuilt on the 3s poll — handing it a
 * countdown would make the number stall for three seconds and then jump.
 * Empty while the sweep is off, so the rail has nothing to render.
 */
const sweepAt = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  if (!clearFinishedAfterMs.value) return out;
  for (const [id, seen] of Object.entries(finishedSeenAt)) {
    out[id] = seen + clearFinishedAfterMs.value;
  }
  return out;
});

/** Watch: a window, while the run stays autonomous and keeps its rail card. */
function watchRun(sessionId: string): void {
  const s = sessionsById[sessionId];
  if (!s) return;
  wm.setLayout("float");
  wm.add({
    id: s.id,
    type: s.command === "claude" ? "agent" : "bash",
    title: s.command === "claude" ? "claude-code" : s.command,
    ticket: s.ticket,
    repo: basename(s.cwd),
  });
  focusWindow(s.id);
}

/**
 * Take over: the run stops being autonomous and becomes an ordinary session.
 * The daemon owns that fact, so it goes first — if the call fails the run is
 * still autonomous and the rail must keep saying so rather than showing a card
 * that has quietly stopped matching the session behind it.
 */
async function takeOver(sessionId: string): Promise<void> {
  try {
    await takeOverRun(sessionId);
    await refresh();
  } catch (e) {
    actionError.value = `Couldn't take over that run: ${String(e)}`;
    return;
  }
  // restore(), not bringFront(): bringFront only bumps z and focus, so a run
  // whose window was minimized stayed hidden and both "Take over" and the
  // panel's "Open the terminal instead" appeared to do nothing at all.
  if (!wm.windows.some((w) => w.id === sessionId)) watchRun(sessionId);
  else restoreWindow(sessionId);
}

/**
 * Acknowledge a finished/failed card. The daemon keeps exited sessions listed
 * so a terminal state survives until somebody sees it; removing it from the
 * registry is what clears the card — no separate acknowledged-state to persist.
 */
async function dismissRun(sessionId: string): Promise<void> {
  // endWindow handles the no-window case (an unwatched run has no window to
  // find, so it just kills the session), and brings the `clearing` guard with
  // it — this path raced reconcile exactly as closeWindow did.
  const failed = await endWindow(sessionId);
  if (failed?.length) {
    // Keep the card: dismissing it is only meaningful once the daemon has
    // actually dropped the session, and the next poll would re-add it anyway.
    actionError.value = `Couldn't dismiss that run: ${failed.join("; ")}`;
    return;
  }
  await refresh();
}

const dockItems = computed(() =>
  wm.windows
    // A watched run belongs to UNDERWAY; minimizing its window returns it
    // there rather than adding a second card in DOCKED. A run can't be in
    // both lanes.
    .filter((w) => w.minimized && !sessionsById[w.id]?.autonomous)
    .map((w) => {
      const st = winStatus(w.id);
      const sub =
        w.kind === "workspace"
          ? "workspace"
          : w.type === "bash"
            ? "shell session"
            : ticketById[w.id]
              ? "agent session"
              : "claude session";
      return { win: w, statusColor: st.c, statusGlow: st.g, attention: st.attention, sub };
    }),
);

// --- being in another tab (DRY-49) ------------------------------------------
// Counted off the same derived state the rail renders, so the tab can never
// disagree with the card: one source, two surfaces.
const runCards = computed(() =>
  autonomousRuns.value.map((s) => ({
    session: s,
    state: runState(s, openGates.value.some((g) => g.sessionId === s.id)),
  })),
);
const failedRuns = computed(() => runCards.value.filter((r) => r.state === "failed"));

useAttention({
  // Gates from ANY session, not just autonomous ones: a minimized ordinary
  // window's gate is equally invisible from another tab, and DRY-50 exists
  // precisely because that one used to reach nobody.
  gates: () => openGates.value.length,
  gateLabel: () => {
    const g = openGates.value[0];
    return (g && sessionsById[g.sessionId]?.ticket) || "A session";
  },
  failed: () => failedRuns.value.length,
  failedLabel: () => failedRuns.value[0]?.session.ticket ?? "A run",
  running: () => runCards.value.filter((r) => r.state === "running" || r.state === "starting").length,
  finished: () => runCards.value.filter((r) => r.state === "finished").length,
});

// One notification per gate, fired as gates arrive. Watching the list rather
// than the count so a gate that opens as another closes still announces itself.
watch(openGates, (gates) => {
  for (const g of gates) {
    const label = sessionsById[g.sessionId]?.ticket ?? "A session";
    notifyGate(g.requestId, `${label} needs you`, `Waiting to run ${g.tool}`);
  }
});

const focusedRepo = computed(() => {
  const w = wm.windows.find((x) => x.id === wm.focusedId.value);
  return w ? `~/${w.repo}` : "no session";
});

const layouts: LayoutMode[] = ["float", "tile", "focus"];

// --- desktop sizing ---
const deskEl = ref<HTMLDivElement | null>(null);
let deskObs: ResizeObserver | null = null;

// DRY-43. The palette shortcut never fired while a terminal had focus: xterm's
// textarea handler calls cancel() (preventDefault + stopPropagation) for Ctrl+K,
// so a bubble-phase window listener never saw the event. Since DRY-40 focuses a
// freshly spawned pane, "focus is inside a terminal" is the normal state, which
// made the shortcut the header advertises effectively dead.
//
// Claiming the chord in the CAPTURE phase fixes it for every focused element at
// once — terminals today, any other key-swallowing widget later — rather than
// per Terminal instance. Stopping propagation there is also what keeps xterm
// from turning the chord into readline's ^K for the PTY: it never reaches the
// textarea at all.
//
// The cost is deliberate: Ctrl+K no longer reaches any shell, so kill-to-
// end-of-line is gone in every pane. The palette is what the UI advertises, so
// it wins the chord (documented in README).
function isPaletteChord(e: KeyboardEvent): boolean {
  // altKey is excluded because AltGr reports ctrlKey AND altKey on Windows and
  // Linux layouts — without this, AltGr+K stops typing its real character.
  // shiftKey is excluded because Ctrl+Shift+K is the browser's console and the
  // UI never advertised it. toLowerCase (rather than matching "K") keeps the
  // chord working under CapsLock, which reports "K" with shiftKey false.
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** What had the keyboard when the palette opened, to hand it back on dismiss. */
let focusBeforePalette: HTMLElement | null = null;

function openPalette() {
  focusBeforePalette = document.activeElement as HTMLElement | null;
  quickOpen.value = true;
}

/**
 * Close the palette. `restore` hands the keyboard back to whatever had it when
 * the palette opened — the other half of DRY-43, since the chord is now normally
 * pressed from inside a terminal and landing back on <body> costs a click before
 * you can type. Spawning does NOT restore: the new pane claims focus on mount
 * (DRY-40).
 */
function closePalette(restore = false) {
  quickOpen.value = false;
  const el = focusBeforePalette;
  focusBeforePalette = null; // never retain a detached pane's DOM
  // Text entry only, never a button: DRY-40's duplicate-spawn bug was a retained
  // button focus turning the next Enter into a second click. A terminal's
  // xterm-helper-textarea IS a <textarea>, so this covers panes without
  // depending on xterm's private class name, and covers real inputs too.
  // preventScroll matches xterm's own focus() — .desk is overflow:hidden, so a
  // scroll caused here has no scrollbar to undo it.
  if (restore && el?.isConnected && el.matches?.("textarea, input")) {
    el.focus({ preventScroll: true });
  }
}

function onKey(e: KeyboardEvent) {
  if (isPaletteChord(e)) {
    // Swallow every repeat, but toggle only on the first: holding the chord
    // would otherwise thrash focus between the terminal and the palette input.
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (quickOpen.value) closePalette(true);
    else openPalette();
    return;
  }
  // Esc closes the ticket detail (it no longer dismisses on outside click).
  // While the palette is open, Esc belongs to the palette, which closes itself —
  // we run in the capture phase, so quickOpen is still true here and this bails
  // before one keystroke collapses both layers and discards a typed prompt.
  if (e.key === "Escape") {
    if (quickOpen.value) return;
    if (selectedTicket.value) selectedTicket.value = null;
  }
}

onMounted(async () => {
  loadScope();
  // Opened before anything else awaits: a gate raised while the tracker call is
  // still in flight has to land somewhere, and the daemon replays whatever is
  // already pending on connect anyway (DRY-50). Guarded because everything
  // below — hydrate, the session poll, the keybindings — is downstream of it,
  // and a constructor throw here would take the whole desk with it.
  try {
    startGateStream();
  } catch (e) {
    actionError.value = `Gate stream unavailable: ${String(e)}`;
  }
  try {
    const info = await getTrackerInfo();
    providerName.value = info.name;
    providerNamed.value = true;
    scopeProjects.value = info.projects ?? [];
  } catch {
    // The name stays at its default when the call doesn't produce one. That
    // only became true in DRY-51: a daemon answering 404/502 with an error body
    // resolved this promise instead of rejecting it, so the catch never ran and
    // `undefined` reached a template that uppercases it.
  }
  // Best-effort and never awaited-on for anything that blocks the desk: an
  // older daemon 404s here and the launch panel just names `manual`.
  void fetchConfig().then((c) => {
    if (c) hostRunMode.value = c.autonomous.permissionMode;
    // Absent on a daemon older than DRY-60; the desk keeps its own default
    // rather than reading a missing field as "never sweep".
    if (c?.desk) clearFinishedAfterMs.value = c.desk.clearFinishedAfterMs;
  });
  await loadTickets();
  // Restore the saved arrangement before the first poll. reconcile() then keeps
  // restored windows whose sessions are still alive (at their saved geometry),
  // drops those whose session is gone, and cascade-adds any new ones. Rehydrate
  // ticket associations so dock sub-labels / badges survive the reload too.
  //
  // AWAITED since DRY-28 — the arrangement is fetched from the daemon now, and
  // letting the first refresh() run before it lands would reconcile against an
  // empty window list: every live session re-added at a cascade position, the
  // restored desk overwritten a beat later by the debounced save. The visible
  // symptom would be "my layout resets itself on reload, sometimes".
  await wm.hydrate();
  for (const w of wm.windows) if (w.ticket) ticketById[w.id] = w.ticket;

  await refresh();
  poll = setInterval(refresh, 3000);
  // Tickets change far less often than sessions and each fetch hits Switchyard
  // live, so poll them on a slower cadence (DRY-17). The sidebar refresh button
  // forces an immediate re-pull between ticks.
  // The interval is imported rather than written here because the pull's own
  // budget is chosen against it — see LIST_TIMEOUT_MS, where the two being
  // equal silently disables the reporting this feature is.
  ticketPoll = setInterval(loadTickets, TICKET_POLL_MS);

  if (deskEl.value) {
    const r = deskEl.value.getBoundingClientRect();
    wm.setDesk(r.width, r.height);
    deskObs = new ResizeObserver(() => {
      const b = deskEl.value!.getBoundingClientRect();
      wm.setDesk(b.width, b.height);
    });
    deskObs.observe(deskEl.value);
  }
  // Capture phase: see isPaletteChord — xterm cancels the chord before it can
  // bubble, so we have to claim it on the way down (DRY-43).
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
  if (ticketPoll) clearInterval(ticketPoll);
  stopGateStream();
  deskObs?.disconnect();
  window.removeEventListener("keydown", onKey, true);
  document.removeEventListener("visibilitychange", onVisibility);
});
</script>

<template>
  <div class="app">
    <!-- TOP BAR -->
    <header class="topbar">
      <div class="brand">
        <svg width="30" height="30" viewBox="0 0 48 34">
          <g stroke="#3f5468" stroke-width="1" fill="none" stroke-linecap="round">
            <path d="M5 6 V20 H2 V28 H46 V20 H43 V6" />
            <line x1="2" y1="28" x2="46" y2="28" />
          </g>
          <g fill="#5b7794">
            <rect x="13" y="25" width="3" height="3" />
            <rect x="22" y="25" width="3" height="3" />
            <rect x="31" y="25" width="3" height="3" />
          </g>
          <path fill="#7aa6cc" d="M9 15 L9 21 Q9 25 13 25 L34 25 L41 18 L41 16 L13 16 Z" />
          <path fill="#7aa6cc" d="M19 16 L19 9 L22 9 L22 16 Z M24 16 L24 11 L29 11 L29 16 Z" />
          <line x1="20.5" y1="9" x2="20.5" y2="4" stroke="#7aa6cc" stroke-width="1" />
        </svg>
        <div class="word">
          <span class="name">Drydock</span>
          <span class="tagline">watch the agents work</span>
        </div>
      </div>

      <div class="grow"></div>

      <div class="switcher">
        <button
          v-for="m in layouts"
          :key="m"
          :class="{ active: wm.layout.value === m }"
          @click="wm.setLayout(m)"
        >
          {{ m[0].toUpperCase() + m.slice(1) }}
        </button>
      </div>

      <div class="grow"></div>

      <div class="controls">
        <!-- Only when there is something to clear, so the desk isn't carrying a
             permanently dead control. Says the number it would take, because
             the count IS the decision: "3" is a tidy-up and "27" is why this
             button exists (DRY-60). -->
        <button
          v-if="clearableIds.length"
          class="ghost sweep"
          title="Close the sessions that ended cleanly — their windows and their rail cards. Failed runs stay, and so does a workspace whose shell is still running."
          @click="blurSpawn($event), clearFinished()"
        >
          Clear finished
          <span class="sweep-n">{{ clearableIds.length }}</span>
        </button>
        <div class="repo">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5a636f" stroke-width="1.4">
            <path d="M2 4h4l1.5 2H14v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
          </svg>
          <span>{{ focusedRepo }}</span>
        </div>
        <button class="new" @click="openPalette()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#9cc6ec" stroke-width="1.6">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New session
          <span class="kbd">Ctrl K</span>
        </button>
        <!-- Plain shells spawn from the palette (⇧↵) — a header button here
             duplicated the "New session (Ctrl K)" pill (DRY-39). -->
        <button class="ghost" title="Bare claude agent" @click="blurSpawn($event), spawnFresh('claude')">
          + claude
        </button>
        <button
          class="ghost"
          title="Ticket drawer + agent + zsh in one window"
          @click="blurSpawn($event), spawnWorkspace()"
        >
          + workspace
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <!-- Sticky: nothing re-raises a failed action, so it waits to be read. -->
    <p v-if="actionError" class="error">
      {{ actionError }}
      <button class="banner-x" title="Dismiss" @click="actionError = null">✕</button>
    </p>
    <!-- Continuing conditions (DRY-58): something still works, just not the way
         you'd assume. Muted rather than red, and NOT dismissible — whoever
         raised it clears it when it stops being true, so an ✕ would only hide a
         fact that's still the case. -->
    <p v-for="n in noticeList" :key="n.key" class="notice">
      {{ n.text }}<span v-if="n.detail" class="notice-detail">{{ n.detail }}</span>
    </p>

    <!-- BODY -->
    <div class="body">
      <TrackerSidebar
        v-if="sidebarOpen"
        :name="providerName"
        :tickets="tickets"
        :refreshing="refreshingTickets"
        :pull-error="trackerError"
        :name-confirmed="providerNamed"
        :scope-projects="scopeProjects"
        :user-projects="userProjects"
        :show-backlog="showBacklog"
        @launch="openTicket"
        @refresh="loadTickets"
        @add-project="addScopeProject"
        @remove-project="removeScopeProject"
        @toggle-backlog="toggleBacklog"
      />

      <div ref="deskEl" class="desk">
        <p v-if="!wm.windows.length" class="hint">
          No sessions yet. Spawn one above, or pick a ticket from the sidebar —
          it keeps running in the daemon even if you close this tab.
        </p>

        <WindowFrame
          v-for="w in visible"
          :key="w.id"
          :win="w"
          :rect="rects[w.id]"
          :layout="wm.layout.value"
          :focused="wm.focusedId.value === w.id"
          :status-color="winStatus(w.id).c"
          :status-glow="winStatus(w.id).g"
          :attention="winStatus(w.id).attention"
          :status-tag="winStatus(w.id).tag"
          :dragging="wm.isDragging()"
          @focus="focusWindow(w.id)"
          @drag-start="(e) => wm.startDrag(e, w.id)"
          @resize-start="(e) => wm.startResize(e, w.id)"
          @minimize="minimizeWindow(w.id)"
          @close="closeWindow(w.id)"
        >
          <WorkspacePane
            v-if="w.kind === 'workspace' && sessionsById[w.id]"
            :win="w"
            :agent-session="sessionsById[w.id]"
            :shell-session="w.shellId ? sessionsById[w.shellId] : undefined"
            :active="wm.focusedId.value === w.id"
            :initial-input="initialInputById[w.id]"
            @status="onStatus"
            @attention="onAttention"
            @idle="onIdle"
            @initial-sent="onInitialSent"
            @patch="onWorkspacePatch"
            @open-file="openSessionFile"
          />
          <TerminalPane
            v-else-if="sessionsById[w.id]"
            :session="sessionsById[w.id]"
            :active="wm.focusedId.value === w.id"
            :initial-input="initialInputById[w.id]"
            @status="onStatus"
            @attention="onAttention"
            @idle="onIdle"
            @initial-sent="onInitialSent"
            @open-file="openSessionFile"
          />
          <!-- DRY-56: the PTY is gone AND the daemon no longer lists it.
               Deliberately LAST, so a session the daemon still knows about
               keeps its pane: an exited-but-listed session is DRY-41's
               territory, and its scrollback is the whole reason that pane
               stays on screen. A history row exists the moment a session ends,
               so ordering this first hid a readable transcript behind a card
               that can't show one. -->
          <SessionTombstone
            v-else-if="tombstones[w.id]"
            :record="tombstones[w.id]"
            :busy="resuming === w.id"
            @resume="resumeSession"
            @dismiss="dropWindow"
          />
        </WindowFrame>

        <!-- One rail owning the bottom edge: unattended runs on the left,
             minimized windows on the right, and the only surface that can
             answer a gate no pane is showing (DRY-49, absorbing DRY-50's
             tray and the dock). -->
        <RunRail
          :runs="autonomousRuns"
          :sessions="sessionList"
          :docked="dockItems"
          :watched-ids="watchedIds"
          :sweep-at="sweepAt"
          :sweep-after-ms="clearFinishedAfterMs"
          @watch="watchRun"
          @take-over="takeOver"
          @dismiss="dismissRun"
          @restore="restoreWindow"
          @focus="openSessionWindow"
        />
      </div>
    </div>

    <QuickLaunch
      :open="quickOpen"
      :tickets="tickets"
      :provider-name="providerName"
      @close="closePalette(true)"
      @launch="openTicket"
      @spawn-shell="closePalette(), spawnFresh('shell')"
    />

    <TicketDetail
      v-if="selectedTicket"
      :ticket="selectedTicket"
      :z="ticketZ"
      :host-mode="hostRunMode"
      @focus="ticketZ = wm.allocZ()"
      @send="onSendTicket"
      @close="selectedTicket = null"
    />

    <MarkdownPane
      v-if="doc"
      :session-id="doc.sessionId"
      :path="doc.path"
      :z="docZ"
      @focus="docZ = wm.allocZ()"
      @close="doc = null"
    />
  </div>
</template>

<style scoped>
.app {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #0a0c0f;
  color: #d5dde6;
  overflow: hidden;
}
.topbar {
  height: 54px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  background: #0e1116;
  border-bottom: 1px solid #ffffff10;
  z-index: 50;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.word {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.name {
  font-size: 17px;
  font-weight: 680;
  letter-spacing: -0.01em;
  color: #eaf0f6;
}
.tagline {
  font-size: 12px;
  color: #5a636f;
}
.grow {
  flex: 1;
}
.switcher {
  display: flex;
  background: #0a0c0f;
  border: 1px solid #ffffff12;
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}
.switcher button {
  padding: 5px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  background: transparent;
  color: #7a8593;
}
.switcher button.active {
  background: #1d2a38;
  color: #cfe3f5;
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.repo {
  display: flex;
  align-items: center;
  gap: 7px;
  background: #0a0c0f;
  border: 1px solid #ffffff12;
  border-radius: 8px;
  padding: 0 10px;
  height: 34px;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #9aa6b2;
}
.new {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  background: #16314a;
  border: 1px solid #2a557d;
  border-radius: 8px;
  color: #cfe3f5;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}
.kbd {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #7fa8cf;
  background: #0e2236;
  padding: 1px 5px;
  border-radius: 4px;
}
.ghost {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 11px;
  background: #13171c;
  border: 1px solid #ffffff14;
  border-radius: 8px;
  color: #b9c3cf;
  font-size: 12.5px;
  font-family: "JetBrains Mono", monospace;
  line-height: 1;
  cursor: pointer;
}
/* Quieter than the two spawn buttons beside it and not proportional-font: this
   is housekeeping, and it appears unannounced when sessions end. It must not
   read as the primary action on a desk somebody just came back to. */
.sweep {
  gap: 7px;
  color: #8b95a2;
  font-family: inherit;
}
.sweep:hover {
  color: #d5dde6;
  border-color: #2c3742;
}
.sweep-n {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #7a8593;
  background: #0a0c0f;
  border-radius: 4px;
  padding: 2px 5px;
}
.error {
  margin: 0;
  padding: 7px 14px;
  background: #2a1416;
  color: #f0c9c4;
  font-size: 12.5px;
  border-bottom: 1px solid #5c2b2b;
}
/* Deliberately quieter than .error: amber-on-slate, one line, no dismiss
   affordance. It reports a condition you should know about while you keep
   working — not a fault to go and deal with (DRY-58). */
.notice {
  margin: 0;
  padding: 6px 14px;
  background: #21201a;
  color: #d8c9a3;
  font-size: 12px;
  border-bottom: 1px solid #4a4130;
  /* One line, always. A notice that grows with its error message pushes the
     desk down under the cursor, which is the opposite of unobtrusive. The text
     is already capped in notices.ts; this is the backstop for a long unbroken
     token (a URL, a path) that no character limit would split. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.notice-detail {
  margin-left: 8px;
  opacity: 0.6;
  font-size: 11.5px;
}
.banner-x {
  float: right;
  padding: 0 2px;
  border: 0;
  background: none;
  color: #f0c9c4;
  font-size: 12px;
  line-height: 1;
  opacity: 0.6;
  cursor: pointer;
}
.banner-x:hover {
  opacity: 1;
}
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.desk {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #0a0c0f;
  background-image: radial-gradient(#ffffff09 1px, transparent 1px);
  background-size: 26px 26px;
}
.hint {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translateX(-50%);
  max-width: 420px;
  text-align: center;
  color: #5a636f;
  font-size: 13px;
  line-height: 1.5;
}
</style>
