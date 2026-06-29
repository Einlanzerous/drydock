# Drydock — Handoff Prompt

> Paste everything below the line into a fresh Claude Code session started in
> `~/projects/drydock`. It's written to be the agent's first message.

---

You are picking up **Drydock**, a web-based terminal multiplexer for AI CLI agents
("watch the agents work"). This repo (`~/projects/drydock`) contains a working
proof-of-concept with the shell rewritten to design fidelity — you are **continuing** it,
not starting from scratch. Read this whole prompt, then read `README.md` and the existing
source before changing anything.

## What Drydock is

A per-host **daemon that owns AI-CLI PTYs** (`claude`, `gemini-cli`, plain shells) plus a
**Vue 3 + xterm.js web shell** that attaches to them. The daemon — not any client — holds
the PTY master for the whole life of the child process, so sessions survive disconnects,
sleep, and multi-day gaps. The browser is just a viewer. The headline feature beyond
"ssh + tmux" is **hook-based in-place approval**: a pane lights up when its agent hits a
permission gate and you approve in the UI, pre-empting the CLI's own prompt.

**The wrapped CLI owns its own auth — Drydock never touches API keys.** The
subscription-billed CLI *is* the access model; that's why we wrap it.

**Owner's workflow:** desktop browser → remote Claude Code instances running on a server.
The daemon + shell both run **on the server**; the owner watches/approves from the desktop.
The shell auto-targets the daemon on the same host it was served from (`window.location.hostname`),
so this works with no hardcoded IP.

## Current state (what already exists)

- **git:** initialized. Default branch `main`. Public remote at
  `https://github.com/Einlanzerous/drydock`. DRY-9/10 work is on branch
  `dry-9-10-shell-tracker` with open **PR #1**.
- `daemon/` — TS/Node backend. `src/session.ts` (PTY ownership, scrollback, approval
  gates), `src/server.ts` (HTTP + WS + `/api/tracker/*`), `src/manager.ts`,
  `src/protocol.ts`, `src/config.ts`, and `src/tracker/` (provider abstraction — see below).
- `shell/` — Vue 3 viewer, rewritten to prototype fidelity (DRY-9). `src/App.vue`,
  `src/composables/useWindowManager.ts` (Float/Tile/Focus engines), `src/components/`
  (`WindowFrame`, `TerminalPane`, `TrackerSidebar`, `QuickLaunch`, `Dock`),
  `src/lib/daemon.ts`, `src/lib/tracker.ts`.
- `hooks/settings.snippet.json` — the `PreToolUse` hook config to drop into a target
  repo's `.claude/settings.json`.
- `examples/demo-repo/` — a repo for exercising the approval loop.
- Bun monorepo (`daemon` + `shell` workspaces). **Note: the daemon runs on Node, not Bun**
  — `node-pty`'s native addon needs V8's C++ API, which Bun's JSC runtime lacks (it
  segfaults on first PTY spawn). `bun run daemon` invokes `node` explicitly; `node-pty` is
  compiled by Node's node-gyp via `scripts/build-native.mjs` in postinstall. Don't "fix"
  this by moving the daemon onto Bun.

Run it (single command — runs both workspaces in parallel, prefixed output):
```bash
bun install            # installs both workspaces + builds node-pty (Node)
bun run dev            # daemon → 0.0.0.0:4317  +  shell → 0.0.0.0:5320 (vite --host)
```
Split across two terminals instead: `bun run daemon` (or `bun run daemon:local` for
localhost-only) and `bun run shell`.

## What's REAL vs MOCKED right now (read before trusting the UI)

**Real, verified end-to-end:**
- PTY sessions — `+claude` / `+shell` spawn real processes via node-pty. `+shell`
  spawns the host owner's **own login shell** (`$SHELL` — e.g. zsh + oh-my-zsh;
  override with `DRYDOCK_SHELL`) as a login shell, not a hardcoded bash. The session
  keeps the logical command `"shell"`, so pane classification (agent vs shell) is
  unchanged; only the spawn target is resolved host-side in `session.ts`.
- Durability — detach/reattach, scrollback replay, close-tab-keeps-running.
- **PreToolUse approval loop** (the differentiator) — real `claude -p` hits the hook,
  daemon gates it, UI approve/deny round-trips as the real `permissionDecision`.
- Status dots — green/amber/grey derived from *live* daemon state (WS + 3s poll).
- Window manager — Float/Tile/Focus, drag/resize, minimize→dock→restore, Ctrl+K palette.
- Tracker plumbing — daemon `/api/tracker/*` endpoints are real HTTP; shell fetches over them.
- **Ticket → agent spawn** (DRY-9, finished) — picking a ticket opens a detail panel with the
  full description; **Send to agent** spawns `claude` in the ticket's **real repo cwd** (daemon
  resolves repo→path: `DRYDOCK_REPOS_ROOT` default `~/projects`, plus `DRYDOCK_REPO_PATHS`
  overrides for repos that live elsewhere; unknown → `$HOME`) and the ticket body is injected
  into the agent's context via a **`SessionStart` hook** (`/hook/sessionstart`), *not* typed
  into the prompt. The prompt is pre-filled with your instruction and **not** auto-submitted.
  The daemon path is verified headless; the **hook must be installed in the target repo's
  `.claude/settings.json`** (it's in `hooks/settings.snippet.json` alongside the approval hook).
  Still to do: **browser-verify** the panel + live hook against a real `claude` session.

**Mocked / default-to-fake:**
- **Tracker data defaults to `FixtureProvider`** — 8 hardcoded tickets ported from the
  design prototype, served through the real endpoints so they *look* live but are static.
  Set `DRYDOCK_TRACKER=switchyard` (+ creds, see below) to go live.
- **`SwitchyardProvider` — now verified live (reads).** Talks to the Switchyard REST API at
  `DRYDOCK_SWITCHYARD_URL` (the API is under **`/v1`** and listens on `:4002`; from the host use
  `http://localhost:4002` — the `switchyard` docker hostname doesn't resolve there) with a
  `Bearer DRYDOCK_SWITCHYARD_TOKEN`. `listProjects`/`listTickets`/`searchTickets`/`getTicket`
  were exercised end-to-end through the daemon against real data. Two fixes were needed vs the
  original draft: base path `/api`→`/v1`, and there's **no `open` flag** — "open" is sent as
  `status=backlog,planning,in_progress,blocked` (a closed-excluding category list). Creds load
  from a gitignored **`.env`** at the repo root (`.env.example` documents it; loader is
  `daemon/src/env.ts`, real env vars still win).
- **Jira backend** — not implemented; silently falls back to fixture.
- **comment / transition** — server-side + paths verified live, but the request *bodies* are
  unverified (no UI calls them yet). Confirm field names when wiring the capability-gated UI.

**Not built (leftovers):** layout persistence (resets on reload), per-repo theming, and
**branch/worktree-per-ticket** — a ticket-spawned agent runs in the repo's *current* branch
with no isolation yet (the obvious next increment on top of the now-real cwd resolution).

## Locked decisions — do not relitigate

- **TypeScript daemon on Node + Bun toolchain.** (Revisit Go only if Drydock graduates to
  needing single-binary-per-host distribution — the daemon is the likely port target.)
- **Interactive PTY, not headless.** You type follow-ups and read full reports in the live
  terminal. Do **not** switch to `--output-format stream-json` / headless request-response.
- **Consequence: real token meters / progress bars are dropped** (DRY-5). They need headless
  mode, which kills watch-live. The color-on-attention signal is enough. The design prototype
  *shows* token/seconds counters — they were deliberately **not built** (decorative only).
- **Windows + Android only. No macOS / Apple / WebKit targets or test matrices.** The PoC
  iterates on Linux PTY; ConPTY parity is a separate verification, not a port.
- **No API-key handling, ever.** Auth is the wrapped CLI's job. Tracker credentials live in
  daemon/host config, **never** in the browser.

## Tracking — Switchyard project DRY

Work is tracked in Switchyard under the **DRY** project (use the `switchyard` MCP —
`get_ticket`, `list_tickets` (project DRY), `comment_on_ticket`, `transition_ticket`).
The epic is **DRY-1** (In Progress). Switchyard status was reconciled with shipped
code on 2026-06-28 — the four foundational tickets are now **Closed**; the table below
matches the tracker:

| Ticket | Title | Switchyard status |
|--------|-------|-------|
| DRY-2  | Initial repo scaffolding & monorepo layout | **Closed** (done) |
| DRY-3  | Backend daemon: detached, durable PTY sessions | **Closed** (done — verified) |
| DRY-4  | Vue 3 + xterm.js shell: always-on grid & window mgmt | In Progress — see leftovers below |
| DRY-5  | Ambient attention signaling & in-place approval (hooks) | **Closed** (done — approval loop verified) |
| DRY-6  | Embedded Chromium webview for app previews | Backlog |
| DRY-7  | Local git diff review UI (approve agent commits) | Backlog |
| DRY-8  | Spike: session-durability design | **Closed** (answered; implemented in DRY-3) |
| DRY-9  | Implement Drydock web UI shell (from design prototype) | In Progress — shell browser-verified; ticket-spawn now real (cwd + SessionStart-hook context), pending browser-verify of the panel + live hook |
| DRY-10 | Pluggable issue-tracker provider abstraction (Switchyard + Jira) | In Progress — abstraction + fixture done; **Switchyard verified live (reads)**; Jira TODO |

Before working a ticket, read its full description in Switchyard — they carry the real
design rationale. Comment progress and transition status as you go.

## Next steps (highest value first)

1. **Browser-verify ticket-spawn (finishes DRY-9).** The mechanism is built and the daemon
   path is headless-verified: detail panel → Send → spawn in the ticket's real repo cwd →
   ticket body injected via the `SessionStart` hook (decided: leave-pre-filled, no auto-submit).
   What's left is driving it in a browser against a real `claude` in a repo that has the
   `SessionStart` hook installed, and confirming the injected context lands. Next increment:
   **branch/worktree-per-ticket** (the agent currently runs in the repo's current branch).
2. **Switchyard writes + UI (DRY-10).** Reads are verified live; what's left is the
   capability-gated **comment / transition** UI — and confirming those two request *bodies*
   against the API (paths are right, field names aren't yet exercised). Browser-verify the live
   sidebar/palette/detail-panel against real tickets while you're at it.
3. **Jira backend (DRY-10).** Jira Cloud REST v3 + JQL, corp-network friendly, credentials
   host-side. Same `TrackerProvider` interface, selected by config — no UI branching.
4. **DRY-4 leftovers.** Layout persistence across restarts (serialize window manager state)
   + per-repo theming.
5. **Daemon auth.** The daemon is **unauthenticated** and binds `0.0.0.0` by default — fine
   on a trusted LAN/Tailscale (the owner's setup) but the first thing to add past PoC.
6. **DRY-6 / DRY-7** (webview previews, git diff review) — larger, not started.

## The design (DRY-9) — reference

The shell is already built to this, but keep it as the source of truth for visual changes.
Use the `DesignSync` tool: `get_project` / `list_files` / `get_file` on project id
`9bc146e4-ea49-4018-ab2f-27d29ecaf37f`, path `Drydock.dc.html`. It's a React/`DCLogic`
mock — **port structure/layout/tokens to Vue 3, not the framework.** Visual tokens:
bg `#0a0c0f`, panels `#0d1116`–`#11151a`, accent `#7aa6cc`/`#5b9bd5`; status thinking
`#d6a651`, running `#5fb98a`, idle `#6a737f`, review `#7f9fd6`; JetBrains Mono + system-ui.

## Positioning vs Warp (a comparison the owner wants)

Warp (warp.dev) is the reference for terminal **UX polish** — block-structured output,
fast input, a strong command palette. Borrow that ergonomics. But Drydock is **not** trying
to be a better single terminal: it's a **multi-agent orchestrator** — an always-visible grid
of durable AI-CLI sessions you supervise and approve, with the issue tracker and git-diff
review built in. When you make UX calls, ask "what would Warp do for the input/output feel?"
but never collapse Drydock into a Warp clone.

## Verification recipe (no playwright binary installed)

Browser-verify the shell with Playwright via the npx cache: import
`playwright-core/index.mjs` by absolute path from `~/.npm/_npx/.../node_modules`, launch
with `executablePath: '/usr/bin/google-chrome'`. The Google-Fonts `@import` 404s in the
sandbox (no network) → harmless system-mono fallback.

## Housekeeping

- `HANDOFF.md` is committed and **public** in the repo — it references internal Switchyard
  ticket IDs and a claude.ai/design link (auth-gated). No secrets. Owner is aware.
- Keep new code matching the existing style (the README documents intent well; follow it).
- Ask before any push/force-push beyond the current branch, or any new remote.
