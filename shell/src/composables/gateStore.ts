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
 * learns about it (the daemon replays what's pending on connect).
 *
 * Module-scoped singleton on purpose: two EventSources would double every gate
 * and race each other's answers.
 */

/** An open gate plus the session it belongs to. */
export interface OpenGate extends PendingGate {
  sessionId: string;
}

const gates = ref<OpenGate[]>([]);
const connected = ref(false);
let source: EventSource | null = null;

/** Oldest first, matching the daemon's insertion order. */
export const openGates = computed(() => gates.value);

export const gatesConnected = computed(() => connected.value);

/** Every open gate for one session, oldest first. */
export function gatesForSession(sessionId: string): OpenGate[] {
  return gates.value.filter((g) => g.sessionId === sessionId);
}

function onEvent(event: EventMessage): void {
  if (event.type === "gate-open") {
    // The daemon replays pending gates on every (re)connect, so the same gate
    // arrives again after a dropped stream. Keyed by requestId rather than
    // appended blindly — otherwise a flaky connection multiplies one gate into
    // a stack of identical prompts.
    if (gates.value.some((g) => g.requestId === event.gate.requestId)) return;
    gates.value = [...gates.value, { sessionId: event.sessionId, ...event.gate }];
    return;
  }
  gates.value = gates.value.filter((g) => g.requestId !== event.requestId);
}

/**
 * Open the stream. Idempotent — safe to call from more than one component.
 *
 * EventSource reconnects on its own, which is most of why SSE was chosen here;
 * `onerror` fires on every transient drop as well as a dead daemon, so it only
 * flags the connection state rather than tearing anything down.
 */
export function startGateStream(): void {
  if (source) return;
  source = new EventSource(eventsUrl());
  source.onopen = () => {
    connected.value = true;
  };
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as EventMessage);
    } catch {
      /* a frame we can't parse is not worth killing the stream over */
    }
  };
  source.onerror = () => {
    connected.value = false;
  };
}

export function stopGateStream(): void {
  source?.close();
  source = null;
  connected.value = false;
  gates.value = [];
}

/**
 * Answer a gate from outside a pane.
 *
 * Drops it locally before the request settles: the click has to feel decided,
 * and the daemon's gate-resolved event removes it again idempotently. If the
 * POST fails the gate is still open daemon-side and the next reconnect replays
 * it, so an optimistic removal can't strand a real gate.
 */
export async function resolveGate(
  gate: OpenGate,
  decision: "allow" | "deny",
  reason?: string,
): Promise<void> {
  gates.value = gates.value.filter((g) => g.requestId !== gate.requestId);
  await answerGate(gate.sessionId, gate.requestId, decision, reason);
}
