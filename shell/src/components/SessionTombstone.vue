<script setup lang="ts">
// A window whose PTY is gone (DRY-56).
//
// Before this, a session that ended took its window with it on the next poll:
// the desk roamed, the work didn't, and you got no record that a session had
// existed, what ticket it was on, or where it was running. This is what stands
// in that window's place — the ticket, the repo, the branch it was on, when it
// stopped and why, and a button that puts a working agent back in the same
// worktree.
//
// Note what it does NOT do: replay the scrollback. That died with the PTY —
// DRY-57 moved the ring buffer into the session's supervisor, which is exactly
// as mortal as the session. A tombstone is a place to start again from, not a
// transcript. (An unattended run's transcript survives as its handoff document,
// which is DRY-49's job and a different artefact.)
import { computed } from "vue";
import { canResumeConversation as resumable, type SessionRecord } from "../lib/daemon.js";

const props = defineProps<{ record: SessionRecord; busy?: boolean }>();
const emit = defineEmits<{
  (e: "resume", record: SessionRecord): void;
  (e: "dismiss", id: string): void;
}>();

/** Present tense where it's honest, past where it isn't. */
const outcome = computed(() => {
  switch (props.record.endReason) {
    case "stopped":
      return "stopped by request";
    case "failed":
      // The code is worth showing here and nowhere else on the desk: it's the
      // only triage available once the scrollback is gone.
      return props.record.exitCode !== undefined && props.record.exitCode >= 0
        ? `failed — exit ${props.record.exitCode}`
        : "failed";
    case "finished":
      return "exited cleanly";
    default:
      return "ended";
  }
});

const when = computed(() => {
  const at = props.record.endedAt;
  if (!at) return "";
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
});

/**
 * Resuming an agent's own conversation needs the CLI's session id AND the
 * transcript it points at. Without either the button still works — it just
 * starts the agent fresh in the same place — and says so, because a "Resume"
 * that quietly discards the conversation is worse than a "Start again" that
 * doesn't pretend.
 */
const canResumeConversation = computed(() => resumable(props.record));
const actionLabel = computed(() => (canResumeConversation.value ? "Resume" : "Start again"));

/**
 * Why this one can't be resumed, in the card's own terms.
 *
 * The two cases are worth separating: no id at all is ordinary (a shell, a
 * session whose hook never fired), while an id whose transcript is gone means
 * the conversation was never written down — the DRY-59 leak for old sessions,
 * or a pruned transcript for any of them. Saying "no agent session id was
 * recorded" for the second would be a small lie, and the one that sends
 * somebody looking in the wrong place.
 */
const freshStartReason = computed(() => {
  if (canResumeConversation.value || props.record.command !== "claude") return "";
  return props.record.transcriptMissing
    ? "Its transcript is no longer on disk, so this starts a fresh conversation in the same worktree."
    : "No agent session id was recorded, so this starts a fresh conversation in the same worktree.";
});
</script>

<template>
  <div class="tomb">
    <div class="head">
      <span class="dot" :class="record.endReason"></span>
      <span class="what">{{ record.ticket ?? record.title ?? record.command }}</span>
      <span class="when">{{ when }}</span>
    </div>

    <div class="meta">
      <span v-if="record.repo" class="chip">{{ record.repo }}</span>
      <span v-if="record.branch" class="chip branch">{{ record.branch }}</span>
      <span class="chip cmd">{{ record.command }}</span>
    </div>

    <p class="outcome">{{ outcome }}</p>
    <p class="path">{{ record.worktree ?? record.cwd }}</p>

    <div class="actions">
      <button class="primary" :disabled="busy" @click="emit('resume', record)">
        {{ busy ? "Starting…" : actionLabel }}
      </button>
      <button class="ghost" :disabled="busy" @click="emit('dismiss', record.id)">Dismiss</button>
    </div>
    <p v-if="freshStartReason" class="note">{{ freshStartReason }}</p>
  </div>
</template>

<style scoped>
.tomb {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  padding: 16px;
  overflow: auto;
  background: #0b0e12;
  color: #8b98a6;
  font-size: 12.5px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4a5561;
  flex: none;
}
.dot.failed {
  background: #d07a7a;
}
.dot.stopped {
  background: #c9a227;
}
.dot.finished {
  background: #6f9a6f;
}
.what {
  color: #c3ccd6;
  font-weight: 600;
}
.when {
  margin-left: auto;
  color: #5d6874;
  font-size: 11.5px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 1px 7px;
  border: 1px solid #232a33;
  border-radius: 999px;
  font-size: 11px;
  color: #8b98a6;
}
.chip.branch {
  font-family: "JetBrains Mono", monospace;
}
.chip.cmd {
  color: #5d6874;
}
.outcome {
  margin: 2px 0 0;
  color: #a6b2be;
}
.path {
  margin: 0;
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #5d6874;
  word-break: break-all;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
}
button {
  padding: 5px 12px;
  border-radius: 5px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.55;
  cursor: default;
}
.primary {
  border: 1px solid #2f6f9a;
  background: #16354a;
  color: #cfe3f2;
}
.primary:hover:not(:disabled) {
  background: #1b405a;
}
.ghost {
  border: 1px solid #232a33;
  background: transparent;
  color: #8b98a6;
}
.ghost:hover:not(:disabled) {
  border-color: #35404d;
}
.note {
  margin: 0;
  font-size: 11px;
  color: #5d6874;
}
</style>
