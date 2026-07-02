<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import TerminalPane from "./components/TerminalPane.vue";
import WorkspacePane from "./components/WorkspacePane.vue";
import WindowFrame from "./components/WindowFrame.vue";
import TrackerSidebar from "./components/TrackerSidebar.vue";
import TicketDetail from "./components/TicketDetail.vue";
import QuickLaunch from "./components/QuickLaunch.vue";
import Dock from "./components/Dock.vue";
import { useWindowManager, type LayoutMode, type Win } from "./composables/useWindowManager.js";
import { DAEMON_HTTP, createSession, killSession, listSessions } from "./lib/daemon.js";
import { getTrackerInfo, listTickets, type Ticket } from "./lib/tracker.js";
import type { SessionInfo } from "./lib/protocol.js";

// Persist the workspace arrangement per daemon host (DRY-14) so a reload
// restores positions/sizes/dock/z-order/layout instead of resetting them.
const wm = useWindowManager({ persistKey: DAEMON_HTTP });

const tickets = ref<Ticket[]>([]);
const providerName = ref("Switchyard");
const sidebarOpen = ref(true);
const quickOpen = ref(false);
const selectedTicket = ref<Ticket | null>(null);
// Stacking order for the floating ticket detail (DRY-20). It's not a daemon
// session so it lives outside wm.windows, but it draws its z from the same
// counter so it layers against (and can be raised above) the terminals.
const ticketZ = ref(0);
const error = ref<string | null>(null);

// Live per-session state. Daemon poll discovers sessions + gives a status/pending
// fallback; TerminalPane emits override it instantly over the WebSocket.
const sessionsById = reactive<Record<string, SessionInfo>>({});
const live = reactive<
  Record<string, { status?: SessionInfo["status"]; attention?: boolean; idle?: boolean }>
>({});
const ticketById = reactive<Record<string, string>>({});
const initialInputById = reactive<Record<string, string>>({});

let poll: ReturnType<typeof setInterval> | null = null;
let ticketPoll: ReturnType<typeof setInterval> | null = null;
const refreshingTickets = ref(false);

// Re-pull tickets so the sidebar reflects external status changes (DRY-17).
// Replaces the data only — TrackerSidebar keeps its own search/filter/expand
// state, so a refresh doesn't disturb what the user is looking at. A tracker
// hiccup keeps the last-good list rather than blanking the sidebar.
async function loadTickets() {
  refreshingTickets.value = true;
  try {
    tickets.value = await listTickets(true);
  } catch {
    /* keep last-good list */
  } finally {
    refreshingTickets.value = false;
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

// Drop a window from the desk. For a workspace, its co-located shell PTY has no
// window of its own, so kill it here too rather than leaking an orphan session.
function dropWindow(id: string) {
  const w = wm.windows.find((x) => x.id === id);
  if (w?.kind === "workspace" && w.shellId) killSession(w.shellId).catch(() => {});
  wm.remove(id);
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
    else if (!ids.has(w.id)) dropWindow(w.id);
  }
}

async function refresh() {
  try {
    reconcile(await listSessions());
    error.value = null;
  } catch (e) {
    error.value = `Daemon unreachable — is it running on :4317? (${String(e)})`;
  }
}

// --- live status → dot color (ties the prototype's palette to real daemon state) ---
function winStatus(id: string) {
  const l = live[id];
  const s = sessionsById[id];
  const attention = l?.attention ?? (s ? s.pendingPermissions > 0 : false);
  const idle = l?.idle ?? s?.idle ?? false;
  const status = l?.status ?? s?.status ?? "running";
  // Permission gate wins (it's blocking a tool); then process-dead; then the
  // agent yielding its turn ("Your turn", DRY-18); else actively working.
  if (attention) return { c: "#d6a651", g: "#d6a65177", attention: true, tag: "" }; // needs you
  if (status === "exited") return { c: "#6a737f", g: "#6a737f55", attention: false, tag: "" }; // exited
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
  // The unmounted pane's WS can no longer update these overrides, and the `??`
  // in winStatus would let them shadow the daemon poll. Clear both so the 3s
  // poll (pendingPermissions / idle) drives the dock dot while docked.
  if (live[id]) {
    live[id].attention = undefined;
    live[id].idle = undefined;
  }
}

// --- spawning ---
async function spawnFresh(kind: "claude" | "shell") {
  wm.setLayout("float");
  try {
    const s = await createSession({ command: kind, title: kind === "claude" ? "claude-code" : "shell" });
    await refresh();
    wm.bringFront(s.id);
  } catch (e) {
    error.value = String(e);
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
      // Ticket-driven spawns can opt into hands-off "auto" permission mode.
      args: opts.auto ? ["--permission-mode", "auto"] : undefined,
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
      drawerOpen: !!opts.ticket, // pre-open the drawer for a ticket-bound workspace
      shellCollapsed: false,
      shellRatio: 0.2,
      w: 760,
      h: 620,
    });
    await refresh();
    wm.bringFront(agent.id);
  } catch (e) {
    error.value = String(e);
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
  quickOpen.value = false;
  selectedTicket.value = t;
  ticketZ.value = wm.allocZ(); // land it on top of the current windows
}

// Spawn an agent for the reviewed ticket: real repo cwd (daemon resolves the
// repo name → host path) and the ticket key (so the SessionStart hook injects
// the body as context). The editable prompt is pre-filled, not auto-submitted.
async function onSendTicket({
  ticket,
  prompt,
  cwd,
  worktree,
  branch,
  auto,
}: {
  ticket: Ticket;
  prompt: string;
  cwd: string;
  worktree: string | false;
  branch?: string;
  auto: boolean;
}) {
  selectedTicket.value = null;
  wm.setLayout("float");
  try {
    // cwd comes from the panel (resolved from the repo, possibly overridden); an
    // explicit cwd takes precedence over repo resolution on the daemon. When the
    // panel opts into isolation the daemon spawns in a per-ticket worktree (DRY-15).
    const s = await createSession({
      command: "claude",
      title: "claude-code",
      cwd,
      ticket: ticket.key,
      worktree,
      branch,
      // Auto mode → spawn claude hands-off; the daemon auto-approves its tools.
      args: auto ? ["--permission-mode", "auto"] : undefined,
    });
    ticketById[s.id] = ticket.key;
    initialInputById[s.id] = prompt;
    await refresh();
    wm.bringFront(s.id);
  } catch (e) {
    error.value = String(e);
  }
}

// "Open workspace" from the ticket detail: spawn the composite workspace
// instead of a plain agent window, with the ticket bound to the drawer.
function onOpenWorkspace({
  ticket,
  prompt,
  cwd,
  worktree,
  branch,
  auto,
}: {
  ticket: Ticket;
  prompt: string;
  cwd: string;
  worktree: string | false;
  branch?: string;
  auto: boolean;
}) {
  selectedTicket.value = null;
  spawnWorkspace({ ticket, prompt, cwd, worktree, branch, auto });
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
  // A workspace also owns a co-located shell PTY with no window of its own —
  // kill it alongside the agent so closing the window leaves nothing running.
  const w = wm.windows.find((x) => x.id === id);
  const shellId = w?.kind === "workspace" ? w.shellId : undefined;
  try {
    await killSession(id);
    if (shellId) await killSession(shellId);
  } catch (e) {
    error.value = String(e);
  }
  wm.remove(id);
  delete initialInputById[id];
  delete ticketById[id];
}

// --- visible windows + computed rects ---
const rects = computed(() => wm.computeRects());
const visible = computed(() => wm.windows.filter((w) => !w.minimized));

const dockItems = computed(() =>
  wm.windows
    .filter((w) => w.minimized)
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

const focusedRepo = computed(() => {
  const w = wm.windows.find((x) => x.id === wm.focusedId.value);
  return w ? `~/${w.repo}` : "no session";
});

const layouts: LayoutMode[] = ["float", "tile", "focus"];

// --- desktop sizing ---
const deskEl = ref<HTMLDivElement | null>(null);
let deskObs: ResizeObserver | null = null;

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    quickOpen.value = !quickOpen.value;
  }
  // Esc closes the ticket detail (it no longer dismisses on outside click).
  if (e.key === "Escape" && selectedTicket.value) {
    selectedTicket.value = null;
  }
}

onMounted(async () => {
  try {
    const info = await getTrackerInfo();
    providerName.value = info.name;
  } catch {
    /* provider name stays default if the tracker info call is unreachable */
  }
  await loadTickets();
  // Restore the saved arrangement before the first poll. reconcile() then keeps
  // restored windows whose sessions are still alive (at their saved geometry),
  // drops those whose session is gone, and cascade-adds any new ones. Rehydrate
  // ticket associations so dock sub-labels / badges survive the reload too.
  wm.hydrate();
  for (const w of wm.windows) if (w.ticket) ticketById[w.id] = w.ticket;

  await refresh();
  poll = setInterval(refresh, 3000);
  // Tickets change far less often than sessions and each fetch hits Switchyard
  // live, so poll them on a slower cadence (DRY-17). The sidebar refresh button
  // forces an immediate re-pull between ticks.
  ticketPoll = setInterval(loadTickets, 20000);

  if (deskEl.value) {
    const r = deskEl.value.getBoundingClientRect();
    wm.setDesk(r.width, r.height);
    deskObs = new ResizeObserver(() => {
      const b = deskEl.value!.getBoundingClientRect();
      wm.setDesk(b.width, b.height);
    });
    deskObs.observe(deskEl.value);
  }
  window.addEventListener("keydown", onKey);
});

onBeforeUnmount(() => {
  if (poll) clearInterval(poll);
  if (ticketPoll) clearInterval(ticketPoll);
  deskObs?.disconnect();
  window.removeEventListener("keydown", onKey);
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
        <div class="repo">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#5a636f" stroke-width="1.4">
            <path d="M2 4h4l1.5 2H14v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
          </svg>
          <span>{{ focusedRepo }}</span>
        </div>
        <button class="new" @click="quickOpen = true">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#9cc6ec" stroke-width="1.6">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New session
          <span class="kbd">Ctrl K</span>
        </button>
        <button class="ghost" @click="spawnFresh('claude')">+ claude</button>
        <button class="ghost" @click="spawnFresh('shell')">+ shell</button>
        <button class="ghost" title="Ticket drawer + agent + zsh in one window" @click="spawnWorkspace()">
          + workspace
        </button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <!-- BODY -->
    <div class="body">
      <TrackerSidebar
        v-if="sidebarOpen"
        :name="providerName"
        :tickets="tickets"
        :refreshing="refreshingTickets"
        @launch="openTicket"
        @refresh="loadTickets"
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
          @focus="wm.bringFront(w.id)"
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
          />
        </WindowFrame>

        <Dock :items="dockItems" @restore="wm.restore" />
      </div>
    </div>

    <QuickLaunch
      :open="quickOpen"
      :tickets="tickets"
      :provider-name="providerName"
      @close="quickOpen = false"
      @launch="openTicket"
      @spawn-blank="(quickOpen = false), spawnFresh('claude')"
    />

    <TicketDetail
      v-if="selectedTicket"
      :ticket="selectedTicket"
      :z="ticketZ"
      @focus="ticketZ = wm.allocZ()"
      @send="onSendTicket"
      @workspace="onOpenWorkspace"
      @close="selectedTicket = null"
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
.error {
  margin: 0;
  padding: 7px 14px;
  background: #2a1416;
  color: #f0c9c4;
  font-size: 12.5px;
  border-bottom: 1px solid #5c2b2b;
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
