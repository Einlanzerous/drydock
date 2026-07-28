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
let source: EventSource | null = null;

/** Oldest first, matching the daemon's insertion order. */
export const openGates = computed(() => gates.value);

function onEvent(event: EventMessage): void {
  switch (event.type) {
    case "gate-snapshot":
      // REPLACE, never merge. Every reconnect delivers one of these, and the
      // gates it omits are gates that were resolved while the stream was down
      // — their gate-resolved events went to a socket that no longer existed.
      // Merging would strand them here forever, held-time climbing, attached
      // to sessions the poll has already dropped. Under the dev daemon's
      // --watch restarts that is the normal path, not an edge case.
      gates.value = event.gates.map((g) => ({ sessionId: g.sessionId, ...g.gate }));
      return;
    case "gate-open":
      // Deduped by requestId: a gate present in the snapshot must not double
      // if a gate-open for it also races in.
      if (gates.value.some((g) => g.requestId === event.gate.requestId)) return;
      gates.value = [...gates.value, { sessionId: event.sessionId, ...event.gate }];
      return;
    case "gate-resolved":
      gates.value = gates.value.filter((g) => g.requestId !== event.requestId);
      return;
  }
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
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as EventMessage);
    } catch {
      /* a frame we can't parse is not worth killing the stream over */
    }
  };
  // EventSource reconnects on its own — nothing to do here but decline to tear
  // the stream down over a transient drop. The gate-snapshot on the next
  // successful connect is what puts this client back in sync.
  source.onerror = () => {};
}

export function stopGateStream(): void {
  source?.close();
  source = null;
  gates.value = [];
}

/**
 * Answer a gate from outside a pane.
 *
 * Drops it locally before the request settles so the click feels decided, then
 * puts it back if the answer never landed. The gate must reappear: a failed
 * POST does not drop the SSE stream, so there is no reconnect coming to replay
 * it — the gate would simply vanish from the UI while the agent stayed blocked
 * for the full permissionTimeoutMs with nothing to explain why.
 *
 * Restored at its original index so a pending queue keeps its order (the UI
 * numbers gates "1 of 2").
 */
export async function resolveGate(
  gate: OpenGate,
  decision: "allow" | "deny",
  reason?: string,
): Promise<void> {
  const index = gates.value.findIndex((g) => g.requestId === gate.requestId);
  if (index === -1) return; // already resolved by another surface
  gates.value = gates.value.filter((g) => g.requestId !== gate.requestId);
  try {
    await answerGate(gate.sessionId, gate.requestId, decision, reason);
  } catch (err) {
    if (!gates.value.some((g) => g.requestId === gate.requestId)) {
      const restored = [...gates.value];
      restored.splice(index, 0, gate);
      gates.value = restored;
    }
    throw err;
  }
}
