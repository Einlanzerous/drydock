<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  CATEGORY_COLOR,
  getTicket,
  tagColor,
  type Ticket,
  type TicketComment,
  type TicketDetail,
} from "../lib/tracker.js";
import { removeWorktree, resolveRepoCwd, WorktreeNotSafe } from "../lib/daemon.js";
import type { PermissionMode, SessionVisibility } from "../lib/protocol.js";
import { isMultiUser } from "../lib/auth.js";
import { renderMarkdown } from "../lib/markdown.js";
import { expandAgentPrompt, LEGACY_AGENT_PROMPT } from "../lib/agent-prompt.js";

// Ticket detail panel (DRY-9 ticket-spawn). Opened when a ticket is picked from
// the sidebar or Ctrl+K palette: shows the full description for *you* to read,
// then "Spawn Agent" opens the ticket as a composite WORKSPACE (DRY-36 made
// that the single spawn path — agent + ticket drawer + co-located zsh, drawer
// and shell starting minimized). The ticket body is delivered to the agent as
// context via the SessionStart hook (not typed in), so the editable prompt
// here is just your instruction. The working dir is pre-resolved from the
// ticket's repo and editable — projects with no repo (e.g. an ideas board)
// resolve to $HOME, which you can override here.
// DRY-20: this is a floating, draggable window rather than a modal — it stacks
// against the terminals via `z` (owned by the parent's window manager) and no
// longer dismisses on outside click, so you can work other windows with it open.
const props = defineProps<{
  ticket: Ticket;
  z: number;
  /** The host's autonomous policy, so the picker can name what "default" means. */
  hostMode?: PermissionMode;
  /**
   * The host's prompt template (DRY-94), `{key}`/`{repo}` unexpanded. Optional
   * so the panel still works standalone; App passes what /api/config served,
   * falling back to the pre-DRY-94 sentence for an older daemon.
   */
  agentPrompt?: string;
}>();
// DRY-15: a ticket spawn can isolate into a git worktree. `worktree` is the path
// to use, or `false` to run directly in `cwd`; `branch` overrides the branch name.
type SpawnPayload = {
  ticket: Ticket;
  prompt: string;
  cwd: string;
  worktree: string | false;
  branch?: string;
  // DRY-22: start the agent in auto (hands-off) permission mode.
  auto: boolean;
  /**
   * DRY-49: run unattended. No window — the run gets a card on the rail, the
   * daemon submits the prompt, and gates surface there instead of in a pane.
   */
  autonomous?: boolean;
  /** DRY-49: how much an autonomous run may do without asking. */
  permissionMode?: PermissionMode;
  /**
   * DRY-27: start it where everyone signed in can watch. Only offered on a
   * multi-user daemon, and only ever a widening — the daemon defaults a spawn
   * to private and takes the owner from the token, never from here.
   */
  visibility?: SessionVisibility;
};
const emit = defineEmits<{
  (e: "send", payload: SpawnPayload): void; // App opens a workspace (DRY-36)
  (e: "focus"): void;
  (e: "close"): void;
}>();

// Float position. `null` means "not dragged yet" → CSS centers it near the top;
// the first drag pins it to explicit pixels. Reset whenever the ticket changes.
const panelEl = ref<HTMLElement | null>(null);
const pos = ref<{ x: number; y: number } | null>(null);
let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;

function onHeaderDown(e: MouseEvent): void {
  emit("focus");
  const el = panelEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  pos.value = { x: r.left, y: r.top };
  drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);
  e.preventDefault();
}
/**
 * Clamped to the viewport on both axes (DRY-74). `Math.max(0, …)` alone only
 * held the top-left corner, so the panel could be dragged down until its footer
 * — and Spawn Agent with it — sat below the fold, where `.app { overflow:
 * hidden }` clips it and nothing scrolls it back: the ticket's own symptom by a
 * different route. The panel is capped at `82vh`/`92vw`, so the lower bound is
 * always above the upper one and the clamp can't invert.
 */
function onDragMove(e: MouseEvent): void {
  if (!drag) return;
  const el = panelEl.value;
  const maxX = Math.max(0, window.innerWidth - (el?.offsetWidth ?? 0));
  const maxY = Math.max(0, window.innerHeight - (el?.offsetHeight ?? 0));
  pos.value = {
    x: Math.min(Math.max(0, drag.ox + (e.clientX - drag.sx)), maxX),
    y: Math.min(Math.max(0, drag.oy + (e.clientY - drag.sy)), maxY),
  };
}
function onDragUp(): void {
  drag = null;
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragUp);
}
onBeforeUnmount(onDragUp);

const detail = ref<TicketDetail | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const prompt = ref("");
const cwd = ref("");
const cwdMatched = ref(true);
// Spawn the agent already in "auto" (hands-off) permission mode so tools run
// without approval prompts. Passed to claude as `--permission-mode auto`, which
// the daemon's PreToolUse hook treats as hands-off. On by default; toggle off
// for a ticket you want to babysit.
const auto = ref(true);

// DRY-27: start an unattended run where everyone signed in can watch it.
// Off by default and only rendered on a multi-user daemon — sharing has to be
// a thing somebody chose, since the run's terminal is its whole transcript.
const shared = ref(false);
const multiUser = isMultiUser;

// DRY-49: how much an UNATTENDED run may do without asking. "" means "whatever
// the host is configured for" — the common case, and the one that lets a policy
// change in one env var take effect without anybody re-picking it here.
const runMode = ref<PermissionMode | "">("");

const MODE_LABELS: Record<PermissionMode, string> = {
  manual: "ask about everything",
  acceptEdits: "edit freely, ask before running commands",
  auto: "never ask",
  bypassPermissions: "never ask",
  dontAsk: "never ask",
};

/** What the run will actually do, spelled out — including via the host default. */
const modeSummary = computed(() => {
  const effective = runMode.value || props.hostMode || "manual";
  const suffix = runMode.value ? "" : ` (host default: ${effective})`;
  return `${MODE_LABELS[effective]}${suffix}`;
});

// DRY-15 worktree isolation. `isGit` gates the whole feature (repo-less tickets
// can't isolate); `isolate` is the user's on/off toggle (default on for a git
// repo); `branch`/`worktreePath` are the editable targets; `worktreeExists`
// flags that a prior spawn's worktree will be reused (with a Reset affordance).
const isGit = ref(false);
const isolate = ref(true);
const branch = ref("");
const worktreePath = ref("");
const worktreeExists = ref(false);
const resetting = ref(false);
// What the daemon refused to discard, in its own words (DRY-90). Reset used to
// pass `--force` unconditionally, so this state could not arise: the button
// deleted uncommitted work without mentioning it. Null while nothing has been
// refused; a sentence once something has, which is what the second button is
// asking about.
const resetRefused = ref<string | null>(null);

/**
 * The pre-filled prompt for a ticket — the host's template, expanded (DRY-94).
 *
 * It was a literal here until then, which put every edit to it behind a shell
 * rebuild and a production promote, and gave every install whatever sentence
 * was baked into the image. Only the ticket's identity is substituted: the
 * description, thread and epic already reach the agent through DRY-53's brief,
 * against a budget this must not spend.
 */
function defaultPrompt(t: Ticket): string {
  return expandAgentPrompt(props.agentPrompt || LEGACY_AGENT_PROMPT, {
    key: t.key,
    repo: t.repo ?? "",
  });
}

/**
 * The last prompt this panel filled in by itself.
 *
 * /api/config is fetched asynchronously at startup, so a ticket opened in the
 * first moments of a page load can be composed from the fallback template and
 * then have the host's arrive a beat later. Re-applying it blindly would eat
 * whatever the human had started typing; re-applying it only when the box still
 * holds exactly what we put there cannot. The case is narrow and the failure is
 * not: the whole point of the host template is what an UNATTENDED run is told
 * to do, and that run is launched from this same box.
 */
const filledPrompt = ref("");

// Preview the spawn target (cwd + planned worktree/branch) for the current
// ticket. Also re-run after a Reset to refresh the reuse flag.
async function previewTarget(t: Ticket): Promise<void> {
  try {
    const r = await resolveRepoCwd(t.repo, t.key);
    cwd.value = r.cwd;
    cwdMatched.value = r.matched;
    isGit.value = !!r.git;
    branch.value = r.branch ?? `agent/${t.key}`;
    worktreePath.value = r.worktree ?? "";
    worktreeExists.value = !!r.worktreeExists;
  } catch {
    /* leave last-good preview */
  }
}

watch(
  () => props.ticket,
  async (t) => {
    detail.value = null;
    loading.value = true;
    loadError.value = null;
    prompt.value = filledPrompt.value = defaultPrompt(t);
    cwd.value = "";
    cwdMatched.value = true;
    isGit.value = false;
    isolate.value = true;
    branch.value = "";
    worktreePath.value = "";
    worktreeExists.value = false;
    resetRefused.value = null;
    auto.value = true;
    pos.value = null; // re-center each freshly opened ticket
    // The panel is a scroll container since DRY-74, and it isn't re-created
    // between tickets (no `:key` on it in App.vue), so without this a new
    // ticket opens at whatever offset the last one was left at.
    if (panelEl.value) panelEl.value.scrollTop = 0;
    // Resolve the spawn cwd + worktree in parallel with the description fetch.
    void previewTarget(t);
    // Is this still the ticket on screen? Checked after the await below, and in
    // the catch and finally beside it — which is why it is declared out here.
    //
    // The race predates DRY-76 — click one ticket, then another before the
    // first replies, and the first reply wins the assignment — but this ticket
    // widens it and sharpens it. Widens: a Switchyard open is 3 upstream GETs
    // where it was 1, with the walk's own 6s budget on top. Sharpens: the
    // losing payload now carries a comment thread and an epic, so a stale
    // answer is no longer an out-of-date description under the right title, it
    // is a THREAD under the wrong ticket — on the one panel whose whole premise
    // is telling you whether the description in front of you is still true.
    const mine = (): boolean => props.ticket === t;
    try {
      // `{thread: true}` (DRY-76): the comment thread and the resolved epic,
      // which the agent's brief has had since DRY-53 and this panel had not.
      // It rides the same request as the description rather than following it,
      // because the extra cost is small where it exists at all — on Jira the
      // thread is a FIELD of the issue GET (usually no extra request), and on
      // Switchyard the comments are inlined too, leaving only the bounded
      // ancestry walk. A second request behind the description would spend a
      // whole extra ticket GET to save that walk.
      const loaded = await getTicket(t.key, { thread: true });
      if (mine()) detail.value = loaded;
    } catch (e) {
      if (mine()) loadError.value = String(e);
    } finally {
      // Only the request the panel is still waiting on may clear the spinner —
      // otherwise a superseded reply lands "loaded" on a ticket still fetching.
      if (mine()) loading.value = false;
    }
  },
  { immediate: true },
);

// The host template landing after this panel opened (see `filledPrompt`).
// Untouched box only — never over an edit in progress.
watch(
  () => props.agentPrompt,
  () => {
    if (prompt.value !== filledPrompt.value) return;
    prompt.value = filledPrompt.value = defaultPrompt(props.ticket);
  },
);

const winStyle = computed(() => {
  const base = { zIndex: String(props.z) };
  return pos.value
    ? { ...base, left: `${pos.value.x}px`, top: `${pos.value.y}px`, transform: "none" }
    : base; // fall back to the CSS-centered default position
});

// Build the shared spawn payload. Isolation is only offered for git repos and
// when the toggle is on; otherwise `worktree: false` runs the agent in `cwd`.
function payload(): SpawnPayload {
  const on = isGit.value && isolate.value;
  return {
    ticket: props.ticket,
    prompt: prompt.value,
    cwd: cwd.value.trim(),
    // A path string overrides where the worktree lives; `false` opts out entirely.
    worktree: on ? worktreePath.value.trim() : false,
    branch: on ? branch.value.trim() || undefined : undefined,
    auto: auto.value,
  };
}

function send(): void {
  if (!prompt.value.trim() || !cwd.value.trim()) return;
  emit("send", payload());
}

/**
 * Send it off to run unattended (DRY-49).
 *
 * Two overrides, both deliberate:
 *
 * The supervised `auto` toggle does NOT carry over. An unattended run's posture
 * is its own decision, made in the picker beside this button and defaulting to
 * the host's policy — the two are different questions and sharing a checkbox
 * between them made the safer one an accident of whatever was ticked last.
 *
 * Worktree ON regardless of the toggle when the repo is a git work tree —
 * letting something nobody is watching write into the human's own checkout is
 * how you lose an afternoon.
 */
function sendAutonomous(): void {
  if (!prompt.value.trim() || !cwd.value.trim()) return;
  const on = isGit.value;
  emit("send", {
    ...payload(),
    auto: false,
    autonomous: true,
    // Omitted rather than resolved client-side when left on "host default", so
    // changing DRYDOCK_AUTONOMOUS_PERMISSION_MODE takes effect for everyone
    // without a browser having cached last week's answer.
    permissionMode: runMode.value || undefined,
    // Omitted when private, which is the daemon's default anyway — so a
    // single-account daemon never sends a field it has no use for.
    visibility: shared.value ? "public" : undefined,
    worktree: on ? worktreePath.value.trim() : false,
    branch: on ? branch.value.trim() || undefined : undefined,
  });
}

// Prune the existing worktree (DRY-15 "reset"): removes it + starts the branch
// fresh on the next spawn. The agent's branch is kept; only the checkout is
// dropped. Re-previews so the reuse badge clears.
async function resetWorktree(force = false): Promise<void> {
  if (resetting.value || !worktreePath.value) return;
  resetting.value = true;
  try {
    await removeWorktree({ repo: props.ticket.repo, worktree: worktreePath.value, force });
    resetRefused.value = null;
    await previewTarget(props.ticket);
  } catch (e) {
    // A refusal is the one failure here worth words: the worktree is still
    // there ON PURPOSE, and naming what is in it is the whole difference
    // between a second button and a mystery. Every other failure leaves the
    // panel on the reuse state, which is already the honest report.
    if (e instanceof WorktreeNotSafe) {
      resetRefused.value = e.safety?.reason ?? "uncommitted or unpushed work";
    }
  } finally {
    resetting.value = false;
  }
}

// --- the comment thread (DRY-76) ---

/**
 * What the panel is entitled to say about the thread.
 *
 * Four states rather than a list and a count, because "nobody has commented",
 * "there are eleven and none arrived" and "the tracker didn't answer that
 * question" are three different facts — and a panel that renders them
 * identically is the quiet failure DRY-55 spent a ticket removing one surface
 * over. The daemon's brief makes the same distinction in `windowLine`
 * (tracker/context.ts); this is the rendered half of it.
 */
type Thread =
  | { kind: "silent" }
  | { kind: "empty" }
  | { kind: "lost"; total: number }
  | { kind: "shown"; comments: RenderedComment[]; total: number };

/**
 * A comment with its markdown ALREADY rendered.
 *
 * Rendered here rather than as `v-html="renderMarkdown(c.body)"` in the
 * template, because that call would sit inside the `v-for` and so inside the
 * render function — re-running marked + DOMPurify once per comment on every
 * reactive change this panel has, not just when the ticket does. Two live ones
 * in this very component: `onDragMove` writes `pos` on every mousemove and
 * `pos` feeds `.panel`'s `:style`, and the prompt/cwd/branch inputs re-render
 * on every keystroke. That was one parse before DRY-76 and is up to forty
 * after it. The computed re-runs only when `detail` is replaced.
 */
type RenderedComment = TicketComment & { html: string };

/**
 * NEWEST FIRST — the one ordering decision here worth arguing about.
 *
 * Providers hand the thread over oldest-first and the brief keeps that order,
 * because an agent reads the whole thing. A human reads the top of a box and
 * scrolls if something looks interesting, and the comment that decides whether
 * this ticket still says what it says is the LAST one. Rendered in reading
 * order under a description long enough to need scrolling, that comment is the
 * one furthest from the eye. So the panel reverses, says it reverses on the
 * line above the first card, and badges the newest.
 */
const thread = computed<Thread | null>(() => {
  const d = detail.value;
  if (!d) return null;
  // Neither field set = the provider couldn't answer, which is NOT zero
  // comments (see the contract on TicketDetail.comments). Reachable: a Jira
  // whose issue GET returns no `comment` field at all.
  if (!d.comments && d.commentCount === undefined) return { kind: "silent" };
  const list = d.comments ?? [];
  // `commentCount` is the thread's true length and `list` may be a window of it
  // (Jira's tail fetch). Never let the window exceed the total it is a window
  // of — a provider disagreeing with itself must not produce "showing 20 of 3".
  const total = Math.max(d.commentCount ?? list.length, list.length);
  if (!total) return { kind: "empty" };
  if (!list.length) return { kind: "lost", total };
  return {
    kind: "shown",
    comments: [...list].reverse().map((c) => ({ ...c, html: renderMarkdown(c.body) })),
    total,
  };
});

/** The thread's true length, for the jump pill. 0 when there is nothing to jump to. */
const threadTotal = computed(() => {
  const t = thread.value;
  return t && (t.kind === "shown" || t.kind === "lost") ? t.total : 0;
});

/**
 * How much of the record is on screen, always stated. `commentCount` is not
 * `comments.length` whenever the provider capped its fetch — on Jira a long
 * thread arrives as its newest N — and implying otherwise is how a reader
 * concludes there is nothing after the comment they can see.
 */
const threadLine = computed(() => {
  const t = thread.value;
  if (!t) return "";
  if (t.kind === "silent") return "The tracker returned no comment thread for this ticket.";
  if (t.kind === "empty") return "No comments.";
  if (t.kind === "lost") {
    return `This ticket has ${count(t.total, "comment")}, but none could be retrieved — the description above may be out of date.`;
  }
  const shown = t.comments.length;
  if (shown >= t.total) return `${count(t.total, "comment")}, newest first.`;
  return `Showing the ${shown} most recent of ${t.total} comments, newest first.`;
});

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A comment's timestamp, for a reader rather than for a parser.
 *
 * Best-effort by contract: providers hand over whatever they wrote —
 * Switchyard `2026-07-01 10:00:00+00`, Jira `…+0000` — so an unparseable stamp
 * renders verbatim, and the raw string stays in the `title` either way.
 *
 * A stamp carrying NO zone is also shown verbatim rather than converted.
 * `new Date("2026-07-28 17:12:35")` is read as the BROWSER's local time, so
 * formatting it as local silently moves the comment by the viewer's offset —
 * the same trap tracker/context.ts documents on the daemon side, where it moved
 * a comment five hours. Neither provider emits that form today; one that does
 * gets its own words back instead of a confident lie.
 */
function whenText(raw?: string): string {
  if (!raw) return "";
  const t = raw.trim();
  if (!/(Z|[+-]\d{2}:?(\d{2})?)$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// The thread lives at the bottom of the description's scrollport, so on a long
// ticket it opens below the fold — the exact case this feature is for. The pill
// beside the title is what says it's there, and this is what it does.
const threadEl = ref<HTMLElement | null>(null);
function jumpToThread(): void {
  threadEl.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}
</script>

<template>
  <div ref="panelEl" class="panel" :style="winStyle" @mousedown="emit('focus')">
    <header class="phead" @mousedown="onHeaderDown">
      <span
        class="status"
        :style="{
          background: CATEGORY_COLOR[ticket.status.category].c,
          boxShadow: `0 0 6px ${CATEGORY_COLOR[ticket.status.category].g}`,
        }"
      ></span>
      <span class="key">{{ ticket.key }}</span>
      <span class="slabel">{{ ticket.status.label }}</span>
      <span class="repo">{{ ticket.repo }}</span>
      <span class="grow"></span>
      <button class="x" title="Close" @mousedown.stop @click="emit('close')">✕</button>
    </header>

    <h2 class="title">{{ ticket.title }}</h2>
    <div class="tagrow" v-if="ticket.tag">
      <span class="tag-dot" :style="{ background: tagColor(ticket.tag) }"></span>
      <span class="tag">{{ ticket.tag }}</span>
    </div>

    <!-- What the ancestry walk paid for, now that the panel asks for it
         (DRY-76): the epic this hangs off, and a count of the thread below.
         The pill is the only thing above the fold that says the thread is
         there at all — on a long description it is a scroll away. -->
    <div class="metarow" v-if="detail?.epic || threadTotal">
      <span v-if="detail?.epic" class="epic" :title="detail.epic.title ?? detail.epic.key">
        <span class="elabel">Epic</span>
        <span class="ekey">{{ detail.epic.key }}</span>
        <span class="etitle">{{ detail.epic.title }}</span>
      </span>
      <button
        v-if="threadTotal"
        class="cjump"
        title="Jump to the comment thread"
        @click="jumpToThread"
      >
        {{ threadTotal }} comment{{ threadTotal === 1 ? "" : "s" }}
      </button>
    </div>

    <div class="desc">
      <p v-if="loading" class="muted">Loading ticket…</p>
      <p v-else-if="loadError" class="muted err">Couldn't load description: {{ loadError }}</p>
      <template v-else>
        <!-- Rendered + sanitized markdown (DRY-35); shared .mdbody pipeline. -->
        <div class="mdbody" v-html="renderMarkdown(detail?.description ?? '')"></div>

        <!-- The comment thread (DRY-76). Inside the description's scrollport on
             purpose: `.desc` is the only region DRY-74 allows to give way, so a
             forty-comment ticket scrolls here instead of pushing Spawn Agent
             off the bottom of the panel. -->
        <section v-if="thread" ref="threadEl" class="thread">
          <h3 class="thead">Activity</h3>
          <p class="twindow" :class="{ warn: thread.kind === 'lost' || thread.kind === 'silent' }">
            {{ threadLine }}
          </p>
          <template v-if="thread.kind === 'shown'">
            <article v-for="(c, i) in thread.comments" :key="i" class="comment">
              <div class="cmeta">
                <span class="cauthor">{{ c.author || "unknown" }}</span>
                <span class="cwhen" :title="c.createdAt">{{ whenText(c.createdAt) }}</span>
                <span v-if="i === 0 && thread.comments.length > 1" class="cnew">newest</span>
              </div>
              <!-- `.comment-body` is not decoration: a comment carries its own
                   markdown headings (`## What the design adds` is a real one on
                   this project's tickets) and under the shared .mdbody scale an
                   h1 inside a comment outranks the panel's own title. The rules
                   that flatten them live in style.css, because scoped CSS does
                   not reach v-html content. -->
              <div class="mdbody comment-body" v-html="c.html"></div>
            </article>
          </template>
        </section>
      </template>
    </div>

    <label class="plabel">Working directory</label>
    <input v-model="cwd" class="cwd" :class="{ warn: !cwdMatched }" spellcheck="false" />
    <p v-if="!cwdMatched" class="cwd-note">
      No repo set for <strong>{{ ticket.repo }}</strong> — defaulting to your home dir. Set where the agent should run.
    </p>

    <!-- DRY-15: git worktree isolation. Off/absent for repo-less tickets. -->
    <div class="wt">
      <label v-if="isGit" class="wt-toggle">
        <input type="checkbox" v-model="isolate" />
        <span class="wt-label">Isolate in a git worktree</span>
        <span class="wt-sub">each ticket gets its own branch — agents don't clobber each other</span>
      </label>
      <p v-else class="wt-none">
        <strong>{{ ticket.repo }}</strong> isn't a git repo — the agent runs directly in the working directory.
      </p>

      <template v-if="isGit && isolate">
        <div class="wt-fields">
          <div class="wt-field">
            <label class="plabel">Branch</label>
            <input v-model="branch" class="cwd mono" spellcheck="false" />
          </div>
          <div class="wt-field">
            <label class="plabel">Worktree path</label>
            <input v-model="worktreePath" class="cwd mono" spellcheck="false" />
          </div>
        </div>
        <p v-if="worktreeExists" class="wt-reuse">
          A worktree already exists here — it'll be <strong>reused</strong> (its branch and any changes kept).
          <button class="wt-reset" :disabled="resetting" @click="resetWorktree(false)">
            {{ resetting ? "Resetting…" : "Reset" }}
          </button>
        </p>
        <!-- The daemon refused, and said why (DRY-90). Shown rather than
             swallowed because Reset now KEEPS work by default: without this the
             button would appear to do nothing at all. The second press is the
             `--force` this route used to apply to every press. -->
        <p v-if="resetRefused" class="wt-refused">
          Kept — it has <strong>{{ resetRefused }}</strong>.
          <button
            class="wt-reset"
            :disabled="resetting"
            :title="`Discard ${resetRefused} in ${worktreePath}. The branch stays.`"
            @click="resetWorktree(true)"
          >
            {{ resetting ? "Discarding…" : "Reset anyway" }}
          </button>
        </p>
      </template>
      <p v-else-if="isGit" class="wt-warn">
        Agent will share <strong>{{ ticket.repo }}</strong>'s working tree — a second agent here can clobber its edits.
      </p>
    </div>

    <label class="plabel">Your prompt to the agent</label>
    <textarea
      v-model="prompt"
      class="prompt"
      rows="2"
      spellcheck="false"
      @keydown.meta.enter="send"
      @keydown.ctrl.enter="send"
    ></textarea>

    <!-- Two stacked rows, not one (DRY-74). The single row this replaced held
         seven items with everything but the hint pinned `flex: 0 0 auto` and no
         `flex-wrap`, so it overran the panel by 50px at EVERY width — Spawn
         Agent, being last, was the part that left. Splitting the hint off buys
         back the width, and grouping the settings apart from the buttons stops
         Cancel sitting between the Auto toggle and the two run actions. -->
    <!-- Outside `.actions` on purpose: the pinned bar should be as short as it
         can be, and a static explanation is the one thing here that has no
         claim on permanent screen space. -->
    <span class="hint">The ticket body is attached as context via the SessionStart hook.</span>
    <div class="actions">
      <div class="actrow">
        <div class="opts">
          <label class="autotoggle" title="Start the agent in auto (hands-off) permission mode — tools run without approval prompts">
            <input type="checkbox" v-model="auto" />
            Auto
          </label>
          <!-- What an unattended run may do without asking (DRY-49). Separate
               from the supervised Auto toggle beside it on purpose: different
               question. -->
          <select
            v-model="runMode"
            class="runmode"
            :title="`Unattended runs will ${modeSummary}`"
          >
            <option value="">Host default</option>
            <option value="manual">Ask about everything</option>
            <option value="acceptEdits">Edit freely, ask to run</option>
            <option value="auto">Never ask</option>
          </select>
          <!-- Only where there is somebody to be public TO (DRY-27). On a
               single-account daemon this is a control with one meaningful
               setting, which is furniture. -->
          <label
            v-if="multiUser"
            class="autotoggle"
            title="Everyone signed in to this Drydock can see the run and watch its terminal. They cannot type into it, stop it, or answer its permission gates."
          >
            <input type="checkbox" v-model="shared" />
            Shared
          </label>
        </div>
        <div class="btns">
          <button class="cancel" @click="emit('close')">Cancel</button>
          <button
            class="auto-run"
            :title="`Run unattended: no window, a card on the rail. Always isolated in a worktree. Will ${modeSummary}.`"
            :disabled="!prompt.trim() || !cwd.trim()"
            @click="sendAutonomous"
          >
            Run autonomously
          </button>
          <button
            class="send"
            title="Open a workspace: agent + this ticket in a drawer + a co-located zsh shell (both minimized)"
            :disabled="!prompt.trim() || !cwd.trim()"
            @click="send"
          >
            Spawn Agent
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Floating window (DRY-20): positioned absolutely within the app, stacked via
   the inline z-index. The default (undragged) position centers it near the top;
   a drag switches to explicit left/top. No backdrop — it's non-modal. */
.panel {
  position: absolute;
  left: 50%;
  top: 56px;
  transform: translateX(-50%);
  width: min(620px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  /* The second axis of DRY-74. `.desc` is the designated flexible region, but
     it floors at `min-height: 80px` and everything below it is fixed, so under
     ~480px of viewport the sum exceeds 82vh — and with no `overflow` here that
     surplus rendered below the panel's own bottom edge, off-screen, taking
     Spawn Agent with it. Scrolling the panel is the backstop for a viewport
     too short to hold it however the row is arranged.

     `hidden` on the inline axis rather than letting it compute: a lone
     `overflow-y` makes `overflow-x` compute from `visible` to `auto`, and
     `position: sticky; bottom: 0` pins only the block axis — so a stray
     horizontal scrollbar would slide the pinned bar sideways out of view. */
  overflow: hidden auto;
  background: #11151a;
  border: 1px solid #2a3744;
  border-radius: 12px;
  box-shadow: 0 24px 60px #000000bb;
  /* No block padding: `.phead` and `.actions` are pinned and carry their own,
     so their opaque backgrounds cover the full strip to each edge. Left here,
     the panel's own padding would be a 16px band above and below the pinned
     rows that scrolling content shows through — padding is inside the
     scrollport, and content scrolls across it. */
  padding: 0 18px;
  --panel-bg: #11151a;
  background: var(--panel-bg);
}
/* Only `.desc` may give way. Every other region is a control or a label at its
   natural size, and flex's default `flex-shrink: 1` let them absorb the deficit
   instead — measured, the 2-row prompt textarea collapsed from 56px to 20px
   before the panel's own scrollbar had done anything. The scroll backstop has
   to engage BEFORE the form is crushed, not after. (DRY-74) */
.panel > *:not(.desc) {
  flex-shrink: 0;
}
/* Pinned alongside `.actions` (DRY-74). A scroll container that lets its header
   leave takes the drag handle and the ✕ with it, on precisely the short
   viewports that made it scroll — so the panel becomes one you can neither move
   nor close by pointer. Carries the panel's top padding for the same reason
   `.actions` carries the bottom. */
.phead {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--panel-bg);
  display: flex;
  align-items: center;
  gap: 9px;
  padding-top: 16px;
  cursor: grab;
  user-select: none;
}
.status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.key {
  font-family: "JetBrains Mono", monospace;
  font-size: 13px;
  font-weight: 600;
  color: #5b9bd5;
}
.slabel {
  font-size: 11px;
  color: #6b7682;
}
.repo {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #5a636f;
}
.grow {
  flex: 1;
}
.x {
  background: none;
  border: none;
  color: #6b7682;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.x:hover {
  background: #1b2531;
  color: #c3ccd6;
}
.title {
  margin: 12px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: #e6ecf2;
  line-height: 1.3;
}
.tagrow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}
.tag-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
}
.tag {
  font-size: 10.5px;
  color: #5a636f;
}
.desc {
  margin: 12px 0;
  flex: 1;
  min-height: 80px;
  overflow-y: auto;
  background: #0b0e12;
  border: 1px solid #ffffff0d;
  border-radius: 8px;
  padding: 10px 12px;
}
/* Description typography comes from the shared .mdbody rules (style.css, DRY-35). */
.muted {
  margin: 0;
  font-size: 12.5px;
  color: #6b7682;
}
.err {
  color: #d6a651;
}
/* --- epic + thread-count row (DRY-76) --- */
.metarow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
  min-width: 0;
}
.epic {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.elabel {
  font-size: 9.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #5a636f;
}
.ekey {
  font-family: "JetBrains Mono", monospace;
  font-size: 11px;
  color: #8b7fd6; /* the epic tag colour (lib/tracker.ts TAG_COLOR) */
}
.etitle {
  font-size: 11px;
  color: #6b7682;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cjump {
  flex: 0 0 auto;
  margin-left: auto;
  background: #131c26;
  border: 1px solid #2a3744;
  border-radius: 999px;
  color: #9cc6ec;
  font-size: 10.5px;
  padding: 2px 9px;
  cursor: pointer;
}
.cjump:hover {
  background: #1b2531;
  border-color: #3d6fa6;
}
/* --- comment thread (DRY-76) --- */
.thread {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #ffffff12;
}
.thead {
  margin: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7a8696;
}
.twindow {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: #6b7682;
}
/* A thread that exists and didn't arrive is amber, like every other kept-or-
   missing state in this panel — the reader has to be able to tell it from
   "nobody has commented", which is the same sentence in a different colour. */
.twindow.warn {
  color: #d6a651;
}
.comment {
  margin-top: 9px;
  background: #0f151c;
  border: 1px solid #ffffff0d;
  border-left: 2px solid #33506e;
  border-radius: 6px;
  padding: 8px 10px;
}
.cmeta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.cauthor {
  font-size: 11.5px;
  font-weight: 600;
  color: #9cc6ec;
}
.cwhen {
  font-size: 10.5px;
  color: #5a636f;
}
.cnew {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 9px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7fb59a;
  border: 1px solid #7fb59a44;
  border-radius: 999px;
  padding: 1px 6px;
}
.plabel {
  font-size: 11px;
  color: #7a8696;
  margin-bottom: 5px;
}
.cwd {
  width: 100%;
  background: #0b0e12;
  border: 1px solid #2a3744;
  border-radius: 8px;
  padding: 8px 11px;
  color: #c3ccd6;
  font-family: "JetBrains Mono", monospace;
  font-size: 12px;
  outline: none;
  margin-bottom: 10px;
}
.cwd:focus {
  border-color: #3d6fa6;
}
.cwd.warn {
  border-color: #6b5326;
}
.cwd-note {
  margin: -4px 0 10px;
  font-size: 10.5px;
  line-height: 1.4;
  color: #d6a651;
}
.cwd-note strong {
  font-family: "JetBrains Mono", monospace;
  color: #e0b566;
}
/* DRY-15 worktree isolation block */
.wt {
  margin-bottom: 10px;
}
.wt-toggle {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  column-gap: 8px;
  cursor: pointer;
  user-select: none;
}
.wt-toggle input {
  grid-row: span 2;
  margin: 0;
  accent-color: #2a6db0;
  cursor: pointer;
}
.wt-label {
  font-size: 12.5px;
  color: #c3ccd6;
  font-weight: 600;
}
.wt-sub {
  grid-column: 2;
  font-size: 10.5px;
  color: #5a636f;
}
.wt-none {
  margin: 0;
  font-size: 11px;
  line-height: 1.4;
  color: #6b7682;
}
.wt-none strong {
  font-family: "JetBrains Mono", monospace;
  color: #8a94a0;
}
.wt-fields {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) 1.4fr;
  gap: 8px;
  margin-top: 9px;
}
.wt-field {
  display: flex;
  flex-direction: column;
}
.wt-field .cwd {
  margin-bottom: 0;
}
.mono {
  font-family: "JetBrains Mono", monospace;
}
.wt-refused {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: #d6a651; /* the same amber .wt-warn uses — a kept thing, not an error */
}
.wt-refused strong {
  color: #edc178;
}
.wt-reuse {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: #7fb59a;
}
.wt-reuse strong {
  color: #9fd2b8;
}
.wt-reset {
  flex: 0 0 auto;
  margin-left: auto;
  background: #1b2531;
  border: 1px solid #33414f;
  border-radius: 6px;
  color: #c3ccd6;
  font-size: 10.5px;
  padding: 3px 9px;
  cursor: pointer;
}
.wt-reset:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.wt-warn {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: #d6a651;
}
.wt-warn strong {
  font-family: "JetBrains Mono", monospace;
  color: #e0b566;
}
.prompt {
  resize: vertical;
  background: #0b0e12;
  border: 1px solid #2a3744;
  border-radius: 8px;
  padding: 9px 11px;
  color: #d5dde6;
  font-family: "JetBrains Mono", monospace;
  font-size: 12.5px;
  line-height: 1.45;
  outline: none;
}
.prompt:focus {
  border-color: #3d6fa6;
}
/* Pinned to the bottom of the scrollport (DRY-74, the vertical axis). Letting
   the panel scroll alone already makes Spawn Agent reachable, but only after
   you scroll to it — on a short viewport the primary action opens below the
   fold with nothing saying it's there, which is the same complaint one step
   removed. Sticky costs nothing when the panel fits, because then it never
   scrolls. */
.actions {
  position: sticky;
  bottom: 0;
  z-index: 2;
  background: var(--panel-bg);
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-top: 10px;
  padding: 9px 0 16px;
  /* Without a rule, content passing under an opaque bar of the SAME colour as
     the panel just stops, at a seam that reads as the panel's own bottom edge —
     so a scrollable panel looks like a clipped one. */
  border-top: 1px solid #ffffff0d;
}
/* All three wrap (DRY-74). The controls are pinned `flex: 0 0 auto` and set
   `white-space: nowrap` individually — correct, since a button reading
   "Run auto\nnomously" is worse than a second line of buttons — which leaves
   wrapping as the ONLY way this row can give up width. Don't remove it on the
   grounds that the panel now clips: `overflow-x` is `hidden` there, so an
   unwrapped row wouldn't spill into view, it would be silently cut off, which
   is the same button unreachable with no symptom to notice. */
.actrow,
.opts,
.btns {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
/* `margin-left: auto` rather than `justify-content: space-between` on .actrow:
   auto margins are resolved per LINE, so the buttons stay right-aligned when
   they wrap onto one of their own. space-between would park them at the left
   edge in exactly that case. */
.btns {
  justify-content: flex-end;
  margin-left: auto;
}
.hint {
  /* Its own top margin now that it sits between the prompt and `.actions`
     rather than inside the latter (DRY-74). */
  margin-top: 10px;
  font-size: 10.5px;
  color: #5a636f;
}
.autotoggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: #8a94a0;
  cursor: pointer;
  user-select: none;
}
.autotoggle input {
  margin: 0;
  accent-color: #2a6db0;
  cursor: pointer;
}
/* One shared box model + explicit height so both action buttons render at the
   same size (DRY-36 collapsed the third, workspace, button into Spawn Agent). */
.cancel,
.send {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 14px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  border: none;
}
.cancel {
  background: #1b2531;
  color: #aeb8c4;
}
.send {
  background: #2a6db0;
  color: #eef5fb;
}
.runmode {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 6px;
  border-radius: 7px;
  border: 1px solid #ffffff14;
  background: #13171c;
  color: #9aa6b2;
  font-size: 11.5px;
  cursor: pointer;
}
/* Outlined, not filled: "Spawn Agent" stays the primary action. Launching
   something you then walk away from should be a deliberate second choice. */
.auto-run {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 32px;
  padding: 0 14px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  background: #13171c;
  border: 1px solid #2a557d;
  color: #9cc6ec;
}
.auto-run:hover:not(:disabled) {
  background: #16222e;
}
.auto-run:disabled {
  opacity: 0.5;
  cursor: default;
}
.send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
