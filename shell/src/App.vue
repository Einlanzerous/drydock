<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import TerminalPane from "./components/TerminalPane.vue";
import WindowFrame from "./components/WindowFrame.vue";
import TrackerSidebar from "./components/TrackerSidebar.vue";
import TicketDetail from "./components/TicketDetail.vue";
import QuickLaunch from "./components/QuickLaunch.vue";
import Dock from "./components/Dock.vue";
import { useWindowManager, type LayoutMode } from "./composables/useWindowManager.js";
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
const error = ref<string | null>(null);

// Live per-session state. Daemon poll discovers sessions + gives a status/pending
// fallback; TerminalPane emits override it instantly over the WebSocket.
const sessionsById = reactive<Record<string, SessionInfo>>({});
const live = reactive<Record<string, { status?: SessionInfo["status"]; attention?: boolean }>>({});
const ticketById = reactive<Record<string, string>>({});
const initialInputById = reactive<Record<string, string>>({});

let poll: ReturnType<typeof setInterval> | null = null;

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "~";
}

// --- session discovery / reconciliation ---
function reconcile(list: SessionInfo[]) {
  const ids = new Set(list.map((s) => s.id));
  for (const k of Object.keys(sessionsById)) if (!ids.has(k)) delete sessionsById[k];
  for (const s of list) sessionsById[s.id] = s;

  for (const s of list) {
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
  for (const w of [...wm.windows]) if (!ids.has(w.id)) wm.remove(w.id);
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
  const status = l?.status ?? s?.status ?? "running";
  if (attention) return { c: "#d6a651", g: "#d6a65177", attention: true }; // needs you
  if (status === "exited") return { c: "#6a737f", g: "#6a737f55", attention: false }; // idle
  return { c: "#5fb98a", g: "#5fb98a77", attention: false }; // running
}

function onStatus(id: string, status: SessionInfo["status"]) {
  (live[id] ??= {}).status = status;
}
function onAttention(id: string, pending: boolean) {
  (live[id] ??= {}).attention = pending;
}

// Minimizing unmounts the pane (its WS closes), so the live attention override
// can no longer update and would shadow the daemon poll via the `??` in
// winStatus. Clear it so a session that hits an approval gate *while docked*
// still lights its dock dot (driven by the 3s pendingPermissions poll).
function minimizeWindow(id: string) {
  wm.minimize(id);
  if (live[id]) live[id].attention = undefined;
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

// Picking a ticket (sidebar or palette) opens its detail panel; the actual
// spawn happens from there once you've read it and hit "Send to agent".
function openTicket(t: Ticket) {
  quickOpen.value = false;
  selectedTicket.value = t;
}

// Spawn an agent for the reviewed ticket: real repo cwd (daemon resolves the
// repo name → host path) and the ticket key (so the SessionStart hook injects
// the body as context). The editable prompt is pre-filled, not auto-submitted.
async function onSendTicket({ ticket, prompt, cwd }: { ticket: Ticket; prompt: string; cwd: string }) {
  selectedTicket.value = null;
  wm.setLayout("float");
  try {
    // cwd comes from the panel (resolved from the repo, possibly overridden); an
    // explicit cwd takes precedence over repo resolution on the daemon.
    const s = await createSession({
      command: "claude",
      title: "claude-code",
      cwd,
      ticket: ticket.key,
    });
    ticketById[s.id] = ticket.key;
    initialInputById[s.id] = prompt;
    await refresh();
    wm.bringFront(s.id);
  } catch (e) {
    error.value = String(e);
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
  try {
    await killSession(id);
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
      const sub = w.type === "bash" ? "shell session" : ticketById[w.id] ? "agent session" : "claude session";
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
}

onMounted(async () => {
  try {
    const info = await getTrackerInfo();
    providerName.value = info.name;
    tickets.value = await listTickets(true);
  } catch {
    /* sidebar/palette just stay empty if the tracker is unreachable */
  }
  // Restore the saved arrangement before the first poll. reconcile() then keeps
  // restored windows whose sessions are still alive (at their saved geometry),
  // drops those whose session is gone, and cascade-adds any new ones. Rehydrate
  // ticket associations so dock sub-labels / badges survive the reload too.
  wm.hydrate();
  for (const w of wm.windows) if (w.ticket) ticketById[w.id] = w.ticket;

  await refresh();
  poll = setInterval(refresh, 3000);

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
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <!-- BODY -->
    <div class="body">
      <TrackerSidebar
        v-if="sidebarOpen"
        :name="providerName"
        :tickets="tickets"
        @launch="openTicket"
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
          :dragging="wm.isDragging()"
          @focus="wm.bringFront(w.id)"
          @drag-start="(e) => wm.startDrag(e, w.id)"
          @resize-start="(e) => wm.startResize(e, w.id)"
          @minimize="minimizeWindow(w.id)"
          @close="closeWindow(w.id)"
        >
          <TerminalPane
            v-if="sessionsById[w.id]"
            :session="sessionsById[w.id]"
            :active="wm.focusedId.value === w.id"
            :initial-input="initialInputById[w.id]"
            @status="onStatus"
            @attention="onAttention"
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
      @send="onSendTicket"
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
  display: flex;
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
  height: 34px;
  padding: 0 11px;
  background: #13171c;
  border: 1px solid #ffffff14;
  border-radius: 8px;
  color: #b9c3cf;
  font-size: 12.5px;
  font-family: "JetBrains Mono", monospace;
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
