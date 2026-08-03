<script setup lang="ts">
// The permission panel that rises out of the rail (DRY-49).
//
// It is the FULL decision surface — nothing in here is a pointer to somewhere
// else. That is the whole claim of autonomous mode: answering a gate at 3am
// must not require opening a terminal. "Open the terminal instead" is therefore
// a text link rather than a button, because taking over should feel like a
// choice you had to make.
//
// Distinct from PermissionPrompt.vue, which stays exactly as it is: that one
// renders inside a live terminal pane, where the terminal is right there and
// the argument is already on screen above it. This one is what you get when
// there is no terminal, so it has to show the argument itself, say honestly
// what it truncated, and carry the run-scoped controls.
import { computed, nextTick, ref, watch } from "vue";
import type { OpenGate } from "../composables/gateStore.js";

const props = defineProps<{
  gate: OpenGate;
  /** Position in the queue of answerable gates, for the "1 of 2" counter. */
  index: number;
  total: number;
  busy: boolean;
  label: string;
  cwd: string;
  held: string;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "resolve", decision: "allow" | "deny", reason?: string, always?: boolean): void;
  (e: "terminal"): void;
}>();

const denying = ref(false);
const reason = ref("");
const expanded = ref(false);

// A new gate is a different decision. Without this the reason typed for one
// tool would still be sitting there when the next prompt advanced into view —
// and "Send denial" would send it.
watch(
  () => props.gate.requestId,
  () => {
    denying.value = false;
    reason.value = "";
    expanded.value = false;
    // The panel is NOT re-created between gates — `v-if="activeGate"` keeps one
    // instance and swaps the prop — so a gate answered half-scrolled would hand
    // the next one a panel already scrolled past its own header (DRY-74 hit
    // this on the ticket panel, which is reused between tickets the same way).
    if (panelEl.value) panelEl.value.scrollTop = 0;
  },
);

/** The scrollport, for the reset above. */
const panelEl = ref<HTMLElement | null>(null);

/**
 * The argument, as text. Bash is the only tool the daemon gates today, so its
 * command is the case worth rendering well; anything else falls back to its
 * JSON, which is at least complete.
 */
const argument = computed(() => {
  const input = props.gate.input as Record<string, unknown> | null | undefined;
  const command = input?.command;
  if (typeof command === "string") return command;
  const path = input?.file_path ?? input?.path;
  if (typeof path === "string") return path;
  return JSON.stringify(props.gate.input ?? {}, null, 2);
});

/**
 * Clamped to five lines, and the footer states exactly what is hidden — lines
 * and bytes. That distinction is the point: it lets you tell "two more flags"
 * from "a 40KB heredoc" before deciding, which is precisely the judgement a
 * truncated blob otherwise takes away from you.
 */
const MAX_LINES = 5;
const lines = computed(() => argument.value.split("\n"));
const clamped = computed(() => !expanded.value && lines.value.length > MAX_LINES);
const shown = computed(() =>
  clamped.value ? lines.value.slice(0, MAX_LINES).join("\n") : argument.value,
);
const hiddenLines = computed(() => Math.max(0, lines.value.length - MAX_LINES));
const hiddenBytes = computed(() =>
  Math.max(0, new Blob([argument.value]).size - new Blob([shown.value]).size),
);

function bytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

const reasonEl = ref<HTMLInputElement | null>(null);
const denyBtn = ref<HTMLButtonElement | null>(null);

// Deny opens a field rather than firing immediately: a bare denial usually just
// makes the agent retry the identical call, so the reason is what turns "no"
// into a redirect. It goes back as the tool result.
function deny() {
  if (!denying.value) {
    denying.value = true;
    // Focus is MOVED, not left to `autofocus` (DRY-73). Entering deny mode
    // swaps the whole action row, which destroys the button that was just
    // clicked — and a destroyed activeElement drops focus to <body>, stranding
    // a keyboard user mid-decision with no way to reach Send denial. `autofocus`
    // is unreliable on a dynamically inserted element, so it isn't relied on.
    void nextTick(() => reasonEl.value?.focus());
    return;
  }
  emit("resolve", "deny", reason.value.trim() || undefined);
}

/**
 * Back out of a denial without answering the gate (DRY-73).
 *
 * There was no way to do this: opening the field left the approve buttons up
 * beside it, so the only exits from a denial you'd started were to send it or to
 * approve — and approving out of a half-typed denial is not a way back, it's the
 * opposite answer. The gate stays open and held either way; nothing here
 * resolves it.
 */
function cancelDeny() {
  denying.value = false;
  reason.value = "";
  // Same reason as above, in reverse: leaving deny mode destroys the button that
  // was clicked, so focus is handed back to the control that opened the field.
  void nextTick(() => denyBtn.value?.focus());
}

/**
 * Escape, routed from App.vue via the rail rather than handled here (DRY-73).
 *
 * A local `@keydown.esc` fires on the bubble phase, and App.vue's Escape handler
 * is on window/capture — so it runs FIRST and closes the ticket detail on the
 * way to a keystroke the user meant for this field. One key, two layers, and the
 * typed reason discarded as a side effect. Returns whether it consumed the key.
 */
function cancelDenialIfOpen(): boolean {
  if (!denying.value) return false;
  cancelDeny();
  return true;
}
defineExpose({ cancelDenialIfOpen });
</script>

<template>
  <div ref="panelEl" class="panel">
    <div class="head">
      <span class="bang">!</span>
      <span class="title">PERMISSION NEEDED</span>
      <span v-if="total > 1" class="counter">{{ index + 1 }} of {{ total }}</span>
      <span v-if="label" class="ticket">{{ label }}</span>
      <span class="held">held {{ held }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="ask">
      wants to run <code>{{ gate.tool }}</code>
    </div>

    <pre class="blob" :class="{ clamped, expanded }">{{ shown }}</pre>
    <div v-if="clamped || expanded" class="truncation">
      <span v-if="clamped">+{{ hiddenLines }} more lines · {{ bytes(hiddenBytes) }} hidden</span>
      <span v-else>showing all {{ lines.length }} lines</span>
      <button class="link" @click="expanded = !expanded">
        {{ expanded ? "Show less" : "Show all" }}
      </button>
    </div>

    <div class="where">in {{ cwd }}</div>

    <div v-if="denying" class="reason">
      <!-- No `@keydown.esc` and no `autofocus`: both are handled in script, and
           the comments on `cancelDenialIfOpen` / `deny` say why. -->
      <input
        ref="reasonEl"
        v-model="reason"
        placeholder="Tell the agent why — it goes back as a tool result"
        @keydown.enter="deny"
      />
    </div>

    <!-- Asking for a reason changes what the panel is FOR, so it changes what it
         offers (DRY-73). Leaving the approve buttons up beside the reason field
         put three answers on screen for a decision already made, two of them the
         opposite of the one being composed — and "Deny…" turning into "Send
         denial" while "Approve ↵" stayed put made the primary button the one
         that discards what you just typed. -->
    <!-- The escape hatch is grouped AWAY from the answers rather than separated
         from them by a flex spacer (DRY-78). A spacer is a flex item, so once
         the row is allowed to wrap it takes a slot on a line like anything else
         — and the answers it was holding apart can wrap to the far side of it.
         An auto margin on the group does the same job per LINE. -->
    <div class="actions">
      <!-- A link, deliberately: it ends autonomy. It stays in both modes — it's
           the way out of the decision, not an answer to it. -->
      <button class="link escape" @click="emit('terminal')">Open the terminal instead</button>
      <div class="answers">
        <template v-if="denying">
          <button class="ghost" :disabled="busy" @click="cancelDeny">Cancel</button>
          <button class="danger" :disabled="busy" @click="deny">
            {{ busy ? "Sending…" : "Send denial" }}
          </button>
        </template>
        <template v-else>
          <button ref="denyBtn" class="ghost" :disabled="busy" @click="deny">Deny…</button>
          <!-- Session-scoped AND tool-scoped, and the button says which tool
               rather than "Always" — it never persists past this run.
               The only control here whose width is DATA (DRY-78): an MCP tool
               name is one unbreakable token, so `overflow-wrap` has nothing to
               work with and the button simply becomes as wide as the name. The
               name is therefore its own element, free to ellipsize, so what
               gives way is the part already written in full two lines above —
               not the words that say what the button does. -->
          <button
            class="ghost always"
            :disabled="busy"
            :title="`Always allow ${gate.tool} for the rest of this run`"
            @click="emit('resolve', 'allow', undefined, true)"
          >
            Always allow <span class="tool">{{ gate.tool }}</span>
          </button>
          <button class="approve" :disabled="busy" @click="emit('resolve', 'allow')">
            {{ busy ? "Sending…" : "Approve ↵" }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  position: absolute;
  left: 12px;
  /* The panel grows UPWARD out of the rail; the rail never moves. */
  bottom: calc(100% + 8px);
  width: 604px;
  /* Against the RAIL, not the viewport (DRY-78). `100vw` was measured from the
     window's left edge while the panel hangs off `.rail`, which starts after
     the 266px sidebar — so the cap was ~266px too generous and the panel ran
     off the right of the screen rather than off the right of the desk.
     Measured at a 560px viewport: the panel spanned 278..798, putting 238px of
     itself past the edge with `Approve ↵` entirely outside, and `.desk` is
     `overflow: hidden`, so nothing scrolled it back. No arrangement of the
     action row can fix that — the row was already inside the panel. 24px keeps
     the gutter on the right equal to the `left: 12px` anchor. */
  max-width: calc(100% - 24px);
  /* The vertical axis (DRY-78). Wrapping the action row buys reachability with
     height, and this panel spends height UPWARD into a desk that clips — so at
     a 560px viewport a wrapped row plus a fully expanded argument put the
     panel's top 10px past the desk's edge, cutting the header off a decision.
     The room comes from RunRail, which is the only place that can see it; see
     the comment on `gateRoom`. The fallback is `none` because an unmeasured cap
     must not be a guessed one — worst case it renders as it did before. */
  max-height: var(--gate-room, none);
  /* A cap without this is not a fix, it is the same overflow pointed downward:
     the panel is anchored by its BOTTOM, so surplus content renders past that
     edge and under the rail's lanes, putting `Approve ↵` right back out of
     reach. `hidden auto` rather than `overflow-y`, because `overflow-y: auto`
     computes `overflow-x` to `auto` too, and a stray horizontal scrollbar would
     slide the sticky row below sideways (both lessons are DRY-74's — this panel
     took the cap from that fix without the backstop that makes it safe). */
  overflow: hidden auto;
  /* No bottom padding: `.actions` is sticky and carries its own, so its opaque
     background covers the strip down to the border. Left here, this would be a
     13px band below the sticky row that scrolling content shows through —
     padding is inside the scrollport. */
  padding: 12px 14px 0;
  border-radius: 12px;
  /* The rail is pointer-events:none so it doesn't swallow clicks in the bottom
     of the desk; anything that must be clickable takes them back. */
  pointer-events: auto;
  background: #141b22f8;
  border: 1px solid #33506e;
  box-shadow: 0 16px 40px #000000aa;
  backdrop-filter: blur(14px);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bang {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #e0a33c;
  color: #16110a;
  font-size: 11px;
  font-weight: 800;
  line-height: 16px;
  text-align: center;
}
.title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #e0a33c;
}
.counter {
  font-size: 10px;
  color: #7c8693;
  font-family: "JetBrains Mono", monospace;
}
.ticket {
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  font-weight: 600;
  color: #5b9bd5;
}
.held {
  margin-left: auto;
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: #e0a33c;
}
.error {
  margin: 8px 0 0;
  padding: 6px 9px;
  border-radius: 7px;
  background: #3a1e1ecc;
  border: 1px solid #7a3a34;
  color: #f0c9c4;
  font-size: 11.5px;
}
.ask {
  margin-top: 9px;
  font-size: 12.5px;
  color: #d5dde6;
  /* The same unbreakable token, on the line that carries it in full (DRY-78).
     Measured at a 560px viewport: `mcp__switchyard__transition_ticket_by_category`
     ran 67px past the panel and 55px off the screen — so the name was cut on
     the one surface that shows it whole. That matters more than it looks,
     because it is what licenses the button below to ellipsize: truncate both
     and the tool's identity is nowhere on a panel whose entire job is to say
     what you are approving.
     `overflow-wrap: anywhere` rather than `.blob`'s `word-break: break-all`
     because this line is prose around the token — break-all would also split
     "wants" and "run", which have perfectly good break opportunities beside
     them. */
  overflow-wrap: anywhere;
}
.ask code {
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  color: #e0a33c;
}
/* Note the argument does NOT shrink to absorb the cap, though making it the
   panel's one flexible region is the obvious move and was the first attempt
   here (DRY-78). It squeezes silently: `.blob.clamped` is `overflow: hidden`
   with a fade, so the box loses lines with no scrollbar and no signal, while
   the footer below goes on reporting "+N more lines" counted from the 5-line
   clamp — an undercount, on the one element whose entire job is to say exactly
   what is being hidden. Measured at a 420px viewport: 101px of content in an
   81px box. The panel scrolls instead. */
.blob {
  margin: 7px 0 0;
  padding: 9px 10px;
  border-radius: 8px;
  background: #0b0f14;
  border: 1px solid #ffffff0d;
  color: #b9c3cf;
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
  line-height: 1.45;
  /* break-all, so a 900-character one-liner wraps into five lines instead of
     growing a horizontal scrollbar nobody will drag at 3am. */
  white-space: pre-wrap;
  word-break: break-all;
  overflow: hidden;
}
.blob.clamped {
  max-height: 104px;
  /* A gradient fade rather than an ellipsis: it never cuts mid-word, and it
     reads as "there is more" instead of as the end of the command. */
  mask-image: linear-gradient(180deg, #000 62%, transparent 100%);
}
.blob.expanded {
  max-height: 186px;
  overflow: auto;
}
.truncation {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  font-size: 10.5px;
  color: #6b7684;
}
.where {
  margin-top: 7px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10.5px;
  color: #5a636f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reason {
  margin-top: 9px;
}
.reason input {
  width: 100%;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid #4a3030;
  background: #0e1319;
  color: #e6ecf2;
  font-size: 12px;
}
.reason input::placeholder {
  color: #6b7684;
}
/* Wrapping is the only way this row can give up width (DRY-78), because every
   control below is pinned `flex: 0 0 auto` and `white-space: nowrap` — every
   one but `.always`, whose label is data rather than copy. That pinning is half
   the fix rather than an afterthought: nothing here was pinned
   before, so instead of overflowing, the controls SHRANK past their labels and
   the text wrapped inside them — measured at a 604px panel, the escape hatch
   collapsed to 39px and rendered as "Open / terminal / instead" stacked three
   deep, and `Always allow …` went to two lines. A row of word-columns is not a
   row that fits; it is the same overflow spent on height instead. */
.actions {
  /* Pinned to the bottom of the scrollport (DRY-74's other half). Letting the
     panel scroll alone already keeps the answers reachable, but only after you
     scroll to them — on a short desk the decision would open below the fold
     with nothing saying it was there, which is this ticket's complaint one step
     removed. Sticky costs nothing when the panel fits, because then it never
     scrolls. Opaque, and the panel's own translucency is deliberately not
     inherited: content passing UNDER a see-through bar is worse than content
     hidden by it. */
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: #141b22;
  /* So content doesn't stop at a seam that reads as the panel's bottom edge. */
  border-top: 1px solid #ffffff0d;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
  padding: 9px 0 13px;
}
/* `margin-left: auto` rather than `justify-content: space-between` on .actions:
   auto margins resolve per LINE, so the answers stay right-aligned when they
   wrap onto one of their own, where space-between would park them at the left
   edge (DRY-74 landed on the same rule for the spawn panel). */
.answers {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
  /* The group is itself a flex item, so `min-width: auto` floors it at its own
     min-content — which the cap on `.always` sets, not the widest button. It
     therefore stayed 260px wide on a 240px line and put all three answers 5px
     outside the panel: the cap that stops one button eating the row was, one
     level up, a floor stopping the row from fitting. It wraps internally, so
     it has no need of a floor. */
  min-width: 0;
}
/* `:not(.always)` rather than letting the exception below override, because it
   couldn't: `.actions button` is the more specific selector, so a bare `.always`
   rule loses to it and the cap goes quietly missing. */
.actions button:not(.always) {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* The one exception, and the reason the rest are pinned: this button's width is
   the tool's name. It may shrink — but only the name does, and only down to the
   cap, past which the row wraps instead. Capped rather than merely shrinkable
   so a long name can't take a whole line to itself while there is room beside
   it; at the panel's full width the entire row still fits on one line. */
.always {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  max-width: 260px;
  /* "Always allow" is an anonymous flex item in here and would otherwise break
     across the space; only `.tool` is meant to give way. */
  white-space: nowrap;
  /* Both are load-bearing: a flex item's `min-width: auto` floors it at its
     min-content size, which for one unbreakable token is the whole token — so
     without these the max-width above is quietly ignored. */
  min-width: 0;
  overflow: hidden;
}
.always .tool {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* Mono, matching how the same name is rendered in `.ask` above — the button
     is showing an identifier, and the ellipsis is honest only if it's legible
     as the head of the one already on screen. */
  font-family: "JetBrains Mono", monospace;
  font-size: 11.5px;
}
.link {
  background: none;
  border: none;
  padding: 0;
  color: #6b7684;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
.link:hover {
  color: #9aa6b2;
}
.ghost {
  padding: 7px 11px;
  border-radius: 7px;
  border: 1px solid #ffffff14;
  background: #13171c;
  color: #b9c3cf;
  font-size: 12px;
  cursor: pointer;
}
.ghost:hover:not(:disabled) {
  background: #1a1f26;
}
/* Send denial is the commit button while the reason field is open (DRY-73), so it carries
   .approve's weight rather than sitting there as a third ghost — a row where
   nothing is primary reads as though no decision has been reached. Red because
   it is the one button here that answers "no". */
.danger {
  padding: 7px 14px;
  border-radius: 7px;
  border: none;
  background: #a33a30;
  color: #fdeceb;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.danger:hover:not(:disabled) {
  background: #b8443a;
}
/* Approve is the only filled button on the panel. */
.approve {
  padding: 7px 14px;
  border-radius: 7px;
  border: none;
  background: #2a6db0;
  color: #eef5fb;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.actions button:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
