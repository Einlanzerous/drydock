import { computed, ref } from "vue";
import { answerGate, eventsUrl } from "../lib/daemon.js";
import type { EventMessage, PendingGate } from "../lib/protocol.js";

/**
 * Shell-wide registry of open permission gates (DRY-50).
 *
 * Why this exists at all: a minimized window is filtered out of `visible` in
 * App.vue, so its TerminalPane unmounts and `onBeforeUnmount` closes the only
 * WebSocket that session had. The daemon's broadcast then reached nobody, and
 * the gate sat until it timed out into the CLI's own prompt inside a PTY no
 * human was watching — minimizing a session made it unable to ask for anything.
 *
 * The fix is a subscription whose lifetime is the *shell's*, not a pane's. One
 * EventSource per tab carries every session's gates, so a gate survives its
 * window being minimized, and a tab opened after the gate was raised still
 * learns about it.
 *
 * Module-scoped singleton on purpose: two EventSources would double every gate
 * and race each other's answers.
 */

/** An open gate plus the session it belongs to. */
export interface OpenGate extends PendingGate {
  sessionId: string;
}

const gates = ref<OpenGate[]>([]);
const answering = ref<string[]>([]);
const connected = ref(false);

/**
 * Daemon clock minus browser clock. `requestedAt` is stamped daemon-side and
 * config.ts binds 0.0.0.0 precisely so the browser can be on another machine;
 * without this correction held-time reports the skew between two boxes, and
 * pins at 0:00 whenever the browser's clock is behind.
 */
const skewMs = ref(0);

let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;
let stopped = true;

/** Oldest first, matching the daemon's insertion order. */
export const openGates = computed(() => gates.value);

/** False while the stream is down — the UI has to say so; see startGateStream. */
export const gatesConnected = computed(() => connected.value);

/** Gates whose answer is in flight; their controls disable rather than vanish. */
export function isAnswering(requestId: string): boolean {
  return answering.value.includes(requestId);
}

/** How long a gate has waited, measured against the daemon's clock. */
export function heldMs(gate: OpenGate, now: number): number {
  return Math.max(0, now + skewMs.value - gate.requestedAt);
}

// --- which sessions currently have a pane -----------------------------------
// Observed, not derived. Inferring it from window state means restating every
// condition App.vue renders a pane under (visible, not minimized, not a
// collapsed workspace shell, session present in sessionsById…) and getting it
// silently wrong each time one is added — the failure being a gate suppressed
// from the tray with no pane showing it either. The pane itself is the only
// thing that knows. Refcounted because two can briefly overlap across a
// re-mount.
const paneRefs = ref<Record<string, number>>({});

export function claimPane(sessionId: string): void {
  paneRefs.value = { ...paneRefs.value, [sessionId]: (paneRefs.value[sessionId] ?? 0) + 1 };
}

export function releasePane(sessionId: string): void {
  const next = { ...paneRefs.value };
  const count = (next[sessionId] ?? 0) - 1;
  if (count > 0) next[sessionId] = count;
  else delete next[sessionId];
  paneRefs.value = next;
}

/** Gates no mounted pane is showing — precisely what the tray is for. */
export const orphanGates = computed(() => gates.value.filter((g) => !paneRefs.value[g.sessionId]));

function onEvent(event: EventMessage): void {
  switch (event.type) {
    case "gate-snapshot":
      // REPLACE, never merge. Every reconnect delivers one of these, and the
      // gates it omits are gates resolved while the stream was down — their
      // gate-resolved events went to a socket that no longer existed. Merging
      // strands them here forever, held-time climbing, attached to sessions the
      // poll has already dropped.
      skewMs.value = event.serverNow - Date.now();
      gates.value = event.gates.map((g) => ({ sessionId: g.sessionId, ...g.gate }));
      return;
    case "gate-open":
      if (gates.value.some((g) => g.requestId === event.gate.requestId)) return;
      gates.value = [...gates.value, { sessionId: event.sessionId, ...event.gate }];
      return;
    case "gate-resolved":
      gates.value = gates.value.filter((g) => g.requestId !== event.requestId);
      answering.value = answering.value.filter((id) => id !== event.requestId);
      return;
  }
}

/**
 * Open the stream, and keep it open. Idempotent.
 *
 * EventSource only retries when a live connection *drops*. Per spec it FAILS
 * the connection — readyState CLOSED, no retry timer, ever — when the response
 * is non-2xx or isn't `text/event-stream`. Both are reachable: a shell newer
 * than its daemon (independent GHCR image vs. pinned checkout) hits the
 * daemon's `404 {error}` fallthrough, which is application/json, and a fronting
 * proxy's 502 does the same. Left to the browser, that tab silently never sees
 * another gate — DRY-50's exact failure, restored.
 */
export function startGateStream(): void {
  stopped = false;
  if (source) return;
  const es = new EventSource(eventsUrl());
  source = es;

  es.onopen = () => {
    connected.value = true;
    backoffMs = 1000;
  };
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as EventMessage);
    } catch {
      /* a frame we can't parse is not worth killing the stream over */
    }
  };
  es.onerror = () => {
    connected.value = false;
    // CLOSED means the browser has given up permanently; any other state is its
    // own retry already in flight, which must not be duplicated.
    if (es.readyState !== EventSource.CLOSED || stopped) return;
    es.close();
    if (source === es) source = null;
    if (retry) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = null;
      if (!stopped) startGateStream();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  };
}

export function stopGateStream(): void {
  stopped = true;
  if (retry) clearTimeout(retry);
  retry = null;
  source?.close();
  source = null;
  connected.value = false;
  gates.value = [];
  answering.value = [];
}

/**
 * Answer a gate from outside a pane.
 *
 * The row is marked in-flight rather than removed. Removing it optimistically
 * unmounts the prompt and destroys any deny reason typed into it, so a failed
 * answer brought the row back blank — the user's words gone, with nothing but a
 * console line to show for it. Removal on success is immediate because
 * answerGate treats 404/409 as "already gone"; otherwise the daemon's
 * gate-resolved is the authority.
 */
export async function resolveGate(
  gate: OpenGate,
  decision: "allow" | "deny",
  reason?: string,
  /** "Always allow <Tool>" — tool- and session-scoped, expires with the run. */
  always?: boolean,
): Promise<void> {
  if (isAnswering(gate.requestId)) return;
  answering.value = [...answering.value, gate.requestId];
  try {
    await answerGate(gate.sessionId, gate.requestId, decision, reason, always);
    gates.value = gates.value.filter((g) => g.requestId !== gate.requestId);
  } finally {
    answering.value = answering.value.filter((id) => id !== gate.requestId);
  }
}
