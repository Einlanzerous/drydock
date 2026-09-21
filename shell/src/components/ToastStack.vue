<script setup lang="ts">
import type { Toast } from "../composables/toasts.js";

// The desk's status messages, overlaid rather than in the flow (DRY-100). What
// each one MEANS — condition or event, who clears it — is decided in
// `composables/toasts.ts`; this only draws the result and reports a ✕.
defineProps<{ toasts: Toast[] }>();
const emit = defineEmits<{ (e: "dismiss", key: string): void }>();
</script>

<template>
  <!-- Anchored at the TOP and appended to at the bottom, so an arrival never
       moves a toast that is already there. Top rather than bottom because the
       bottom edge is spoken for: the rail owns it, a pending gate lifts above
       it, and the bottom rows of a terminal are where its prompt is.

       `role` carries the two meanings: an error is `alert` (assertive), a note
       or a notice is `status` (polite). Nothing here takes focus, ever. -->
  <div class="toasts">
    <div
      v-for="t in toasts"
      :key="t.key"
      class="toast"
      :class="t.kind"
      :data-toast="t.kind"
      :role="t.kind === 'error' ? 'alert' : 'status'"
    >
      <p class="toast-body">
        <span class="toast-text">{{ t.text }}</span>
        <span v-if="t.detail" class="toast-detail">{{ t.detail }}</span>
      </p>
      <!-- `mousedown.prevent` keeps a click on the ✕ from moving focus onto it:
           the button is removed a moment later and focus would fall to <body>,
           taking the terminal's keyboard with it. Keyboard activation is
           unaffected — Tab still lands here and Enter/Space still click.

           The glyph is drawn by CSS, not written here, so a toast's text is its
           message and nothing else: a screen reader hears "Dismiss" rather than
           a stray symbol, and `textContent` doesn't grow a trailing ✕ that every
           assertion on a toast's wording would have to strip. -->
      <button
        class="toast-x"
        type="button"
        title="Dismiss"
        aria-label="Dismiss"
        @mousedown.prevent
        @click="emit('dismiss', t.key)"
      ></button>
    </div>
  </div>
</template>

<style scoped>
/* Out of the flow: this is the entire point. `.body` is `position: relative`
   for it, and nothing here takes part in any layout but its own. */
.toasts {
  position: absolute;
  top: 10px;
  right: 14px;
  /* Above the rail (9000) and the palette / users panel (10000): a failure
     raised from inside a modal has to be readable over it. */
  z-index: 10500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(400px, calc(100% - 28px));
  /* The stack is click-through — it spans a strip of the desk that has
     terminals under it — and each toast takes pointer events back. */
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  border: 1px solid;
  border-left-width: 3px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.4;
  box-shadow: 0 8px 24px #000000aa;
}
.toast-body {
  flex: 1;
  min-width: 0;
  margin: 0;
  /* A toast can wrap, but a paragraph is still an alarm (DRY-58 capped the
     detail at 140 characters for this reason and that cap stands). An action
     error is the one that can still be long — `String(e)` of a daemon 500 — so
     it scrolls rather than growing down over the desk. */
  max-height: 7.5em;
  overflow-y: auto;
  overflow-wrap: anywhere;
}
.toast-detail {
  display: block;
  margin-top: 2px;
  opacity: 0.6;
  font-size: 11.5px;
}
.toast-x {
  flex: 0 0 auto;
  padding: 0 4px;
  border: 0;
  background: none;
  color: inherit;
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.6;
  cursor: pointer;
}
.toast-x::before {
  content: "✕";
}
.toast-x:hover,
.toast-x:focus-visible {
  opacity: 1;
}

/* Red: something failed, or the daemon won't answer. */
.error {
  background: #2a1416;
  color: #f0c9c4;
  border-color: #5c2b2b;
}
/* Slate-and-green: an outcome that is not a failure (DRY-90) — the commonest
   one says a finished worktree was tidied away, which is the thing working. */
.note {
  background: #15211b;
  color: #b6d8c4;
  border-color: #2c4a39;
}
/* Amber: a condition worth knowing about while you keep working, not a fault to
   go and deal with (DRY-58). Quieter than red on purpose. */
.notice {
  background: #21201a;
  color: #d8c9a3;
  border-color: #4a4130;
}

/* Fades IN and does nothing on the way out, on purpose. This is a plain
   keyframe on the element and not a <TransitionGroup>: Vue's leave hook waits
   a double requestAnimationFrame before it even reads the styles (runtime-dom's
   `nextFrame`, 3.5), so a group holds a leaving node for at least two frames
   whether or not a leave transition is defined, and an earlier cut with a 160ms
   leave fade made a toast outlive its owner's clear by ~190ms. `roam.mts` asserts "notice
   cleared" the moment the store recovers and failed on every run for it.
   Removal is now synchronous, so what is in the DOM is exactly what the owners
   hold — which is also the property that makes a zero-count assertion mean
   something. The cost is that the stack snaps closed when a toast above one
   leaves instead of sliding, which changes how the shift looks and not where a
   ✕ ends up. */
.toast {
  animation: toast-in 0.16s ease;
}
@keyframes toast-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
</style>
