# Drydock — Handoff Prompt

> Paste everything below the line into a fresh Claude Code session started in
> `~/projects/drydock`. It's written to be the agent's first message.

---

You are picking up **Drydock**, a web-based terminal multiplexer for AI CLI agents
("watch the agents work"). This repo (`~/projects/drydock`) already contains a working
proof-of-concept — you are **continuing** it, not starting from scratch. Read this whole
prompt, then read `README.md` and the existing source before changing anything.

## What Drydock is

A per-host **daemon that owns AI-CLI PTYs** (`claude`, `gemini-cli`, plain shells) plus a
**Vue 3 + xterm.js web shell** that attaches to them. The daemon — not any client — holds
the PTY master for the whole life of the child process, so sessions survive disconnects,
sleep, and multi-day gaps. The browser is just a viewer. The headline feature beyond
"ssh + tmux" is **hook-based in-place approval**: a pane lights up when its agent hits a
permission gate and you approve in the UI, pre-empting the CLI's own prompt.

**The wrapped CLI owns its own auth — Drydock never touches API keys.** The
subscription-billed CLI *is* the access model; that's why we wrap it.

## Current state (what already exists)

- `daemon/` — TS/Node backend. `src/session.ts` (PTY ownership, scrollback, approval
  gates), `src/server.ts` (HTTP + WS), `src/manager.ts`, `src/protocol.ts`, `src/config.ts`.
- `shell/` — Vue 3 viewer. `src/App.vue`, `src/components/TerminalPane.vue`,
  `src/lib/daemon.ts`, `src/lib/protocol.ts`.
- `hooks/settings.snippet.json` — the `PreToolUse` hook config to drop into a target
  repo's `.claude/settings.json`.
- `examples/demo-repo/` — a repo for exercising the approval loop.
- Bun monorepo (`daemon` + `shell` workspaces). **Note: the daemon runs on Node, not Bun**
  — `node-pty`'s native addon needs V8's C++ API, which Bun's JSC runtime lacks (it
  segfaults on first PTY spawn). `bun run daemon` invokes `node` explicitly; `node-pty` is
  compiled by Node's node-gyp via `scripts/build-native.mjs` in postinstall. Don't "fix"
  this by moving the daemon onto Bun.

Run it (two terminals):
```bash
bun install            # installs both workspaces + builds node-pty (Node)
bun run daemon         # → http://127.0.0.1:4317  (Node)
bun run shell          # → http://0.0.0.0:5320     (Bun/Vite)
```

## Locked decisions — do not relitigate

- **TypeScript daemon on Node + Bun toolchain.** (Revisit Go only if Drydock graduates to
  needing single-binary-per-host distribution — the daemon is the likely port target.)
- **Interactive PTY, not headless.** You type follow-ups and read full reports in the live
  terminal. Do **not** switch to `--output-format stream-json` / headless request-response.
- **Consequence: real token meters / progress bars are dropped** (DRY-5). They need the
  headless mode above, which kills watch-live. The color-on-attention signal is enough.
  (The design prototype *shows* token/seconds counters — treat them as decorative, or wire
  only where cheaply available. See the "tension" note below.)
- **Windows + Android only. No macOS / Apple / WebKit targets or test matrices.** The PoC
  iterates on Linux PTY; ConPTY parity is a separate verification, not a port.
- **No API-key handling, ever.** Auth is the wrapped CLI's job.

## Tracking — Switchyard project DRY

Work is tracked in Switchyard under the **DRY** project (use the `switchyard` MCP —
`get_ticket`, `list_tickets --project DRY`, `comment_on_ticket`, `transition_ticket`).
The epic is **DRY-1**. Children:

| Ticket | Title | Rough state |
|--------|-------|-------------|
| DRY-2  | Initial repo scaffolding & monorepo layout | largely done (PoC scaffolding) |
| DRY-3  | Backend daemon: detached, durable PTY sessions | core built; verify durability |
| DRY-4  | Vue 3 + xterm.js shell: always-on grid & window mgmt | in progress |
| DRY-5  | Ambient attention signaling & in-place approval (hooks) | hook PoC exists |
| DRY-6  | Embedded Chromium webview for app previews | not started |
| DRY-7  | Local git diff review UI (approve agent commits) | not started |
| DRY-8  | Spike: session-durability design | mostly answered in README |
| DRY-9  | Implement Drydock web UI shell (from design prototype) | not started — design ready |
| DRY-10 | Pluggable issue-tracker provider abstraction (Switchyard + Jira) | not started — NEW |

Before working a ticket, read its full description in Switchyard — they carry the real
design rationale (e.g. the per-agent approval matrix in DRY-5, the durability acceptance
test in DRY-3). Comment progress and transition status as you go.

## The design (DRY-9) — import it

A high-fidelity prototype defines the target UI. Import and follow it:

> Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via
> /design-login) to import this project:
> https://claude.ai/design/p/9bc146e4-ea49-4018-ab2f-27d29ecaf37f?file=Drydock.dc.html
>
> Implement: Drydock.dc.html

Use the `DesignSync` tool: `get_project` / `list_files` / `get_file` on project id
`9bc146e4-ea49-4018-ab2f-27d29ecaf37f`, path `Drydock.dc.html`. It's a React/`DCLogic`
mock — **port the structure, layout, and visual tokens to Vue 3, not the framework.**

What it establishes: a top bar with a **Float / Tile / Focus** layout switcher; a
collapsible tracker sidebar (labeled "SWITCHYARD") of tickets grouped by repo that spawn an
agent on click; draggable/resizable **agent / browser-preview / bash** windows; a
macOS-style **dock** for minimized (still-running) sessions; and a **Ctrl+K quick-launch
palette** that fuzzy-searches tickets and spawns an agent on Enter. Visual tokens:
bg `#0a0c0f`, panels `#0d1116`–`#11151a`, accent `#7aa6cc`/`#5b9bd5`; status thinking
`#d6a651`, running `#5fb98a`, idle `#6a737f`, review `#7f9fd6`; JetBrains Mono + system-ui.

**Tension to reconcile:** the prototype renders live token/seconds counters, but DRY-5
dropped real token meters (headless-only). Keep the visual but don't build a headless path
to feed it.

## This iteration's goals

1. **Bring the shell up to the prototype's fidelity (DRY-9 / DRY-4).** Float/Tile/Focus
   layout engines, window chrome, the dock, the sidebar, the Ctrl+K palette — wired to the
   real daemon sessions, not mock data, where the daemon already supports it.
2. **Make it usable at work (DRY-10).** Build the `TrackerProvider` abstraction with two
   backends — **Switchyard** (home) and **Jira** (work, Jira Cloud REST v3 + JQL, corp-network
   friendly, credentials on the host never the browser). Switch by config profile with no UI
   branching. This is what turns Drydock into a daily work driver.
3. **Hold the line on the locked decisions above** while doing both.

## Positioning vs Warp (a comparison the owner wants)

Warp (warp.dev) is the reference for terminal **UX polish** — block-structured output,
fast input, a strong command palette. Borrow that ergonomics. But Drydock is **not** trying
to be a better single terminal: it's a **multi-agent orchestrator** — an always-visible grid
of durable AI-CLI sessions you supervise and approve, with the issue tracker and git-diff
review built in. When you make UX calls, ask "what would Warp do for the input/output feel?"
but never collapse Drydock into a Warp clone. Where useful, jot Warp comparisons (blocks vs
our scrollback model, their palette vs our Ctrl+K, their workflows vs spawn-on-ticket) so
the owner can evaluate.

## Suggested first moves

1. `bun install`, then run the daemon + shell and confirm the PoC spawns a `claude` and a
   `bash` session and the approval loop fires (see `examples/demo-repo`).
2. Read DRY-3, DRY-4, DRY-5, DRY-9, DRY-10 in full from Switchyard.
3. Import the design (above) and diff it against the current `shell/` — list the gap.
4. Propose a short plan (which tickets, in what order) and confirm before large changes.
   DRY-9 (design fidelity) and DRY-10 (tracker abstraction) are the two highest-value next
   pieces; DRY-10's `TrackerProvider` interface is worth landing early since the sidebar +
   palette both depend on it.

## Housekeeping

- This folder is **not yet a git repo.** Initialize one early (`git init`, sensible first
  commit of the existing PoC) so changes are reviewable — but ask before any push/remote.
- Keep new code matching the existing style (the README documents intent well; follow it).
