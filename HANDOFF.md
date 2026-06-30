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

- **git:** Default branch `main`; public remote `https://github.com/Einlanzerous/drydock`.
  **PRs #1, #2, #3 are all merged** — `main` holds the full PoC. No open PRs.
- `daemon/` — TS/Node backend. `src/session.ts` (PTY ownership, scrollback, approval gates,
  spawn resolution: `shell`→`$SHELL -l`, `claude`→`claude --settings <hooks>`), `src/server.ts`
  (HTTP + WS + `/api/tracker/*` + `/api/repos/resolve` + `/hook/{pretooluse,sessionstart}`),
  `src/manager.ts`, `src/protocol.ts`, `src/config.ts`, `src/env.ts` (`.env` loader),
  `src/repos.ts` (ticket repo→cwd resolution), `src/hooks.ts` (daemon-injected Claude hooks),
  and `src/tracker/` (provider abstraction — `fixture` + `switchyard`).
- `shell/` — Vue 3 viewer (DRY-9). `src/App.vue`, `src/composables/useWindowManager.ts`
  (Float/Tile/Focus engines), `src/components/` (`WindowFrame`, `TerminalPane`, `TrackerSidebar`,
  `TicketDetail`, `QuickLaunch`, `Dock`), `src/lib/daemon.ts`, `src/lib/tracker.ts`.
- `hooks/settings.snippet.json` — reference/fallback only. The daemon now injects the
  `PreToolUse` + `SessionStart` hooks into every spawned `claude` via `--settings`
  (`daemon/src/hooks.ts`), so **no per-repo `.claude/settings.json` is required**.
- `.env` (gitignored; `.env.example` documents the shape) — host config incl. tracker creds.
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

For a **live tracker**, copy `.env.example` → `.env` (the daemon auto-loads it; real env vars
still win): `DRYDOCK_TRACKER=switchyard`, `DRYDOCK_SWITCHYARD_URL=http://localhost:4002`,
`DRYDOCK_SWITCHYARD_TOKEN=…`. With no `.env` it defaults to the built-in fixture tickets.

## What's REAL vs MOCKED right now (read before trusting the UI)

**Real, verified end-to-end:**
- PTY sessions — `+claude` / `+shell` spawn real processes via node-pty. `+shell`
  spawns the host owner's **own login shell** (`$SHELL` — e.g. zsh + oh-my-zsh;
  override with `DRYDOCK_SHELL`) as a login shell, not a hardcoded bash. The session
  keeps the logical command `"shell"`, so pane classification (agent vs shell) is
  unchanged; only the spawn target is resolved host-side in `session.ts`.
- Durability — detach/reattach, scrollback replay, close-tab-keeps-running.
- **PreToolUse approval loop** (the differentiator) — a real `claude` Bash call hits the hook,
  the daemon gates it, UI approve/deny round-trips as the real `permissionDecision`. The daemon
  **honors the agent's permission mode**: in hands-off modes (`bypassPermissions`/`auto`/`dontAsk`)
  it auto-allows without prompting — a gate there wouldn't hold the tool back anyway — while
  `default`/`acceptEdits` still gate. A session that hits a gate **while docked** lights its dock dot.
- Status dots — green/amber/grey derived from *live* daemon state (WS + 3s poll).
- Window manager — Float/Tile/Focus, drag/resize, minimize→dock→restore, Ctrl+K palette.
  **Minimize** keeps the session running (docked); the **X (close) kills the session**. Layout
  is **not persisted** — a reload resets positions/sizes/layout (DRY-14, the main daily-use gap).
- Tracker plumbing — daemon `/api/tracker/*` endpoints are real HTTP; shell fetches over them.
- **Sidebar search + filters (DRY-11)** — always-on search (key/title/repo/assignee), project/
  status/assignee filters with clear-all, collapsible groups (collapsed by default, with counts).
  The open list is fully **paginated** (follows the API cursor, capped at 2000), so all open
  tickets load — not just the first 100.
- **Ticket → agent spawn** (DRY-9 + DRY-12) — picking a ticket opens a detail panel with the
  full description and the **resolved working dir** (editable: daemon resolves repo→path via
  `DRYDOCK_REPOS_ROOT` default `~/projects` + `DRYDOCK_REPO_PATHS` overrides; a repo-less project
  like `IDEA` resolves to `$HOME` and is flagged so you can override before spawning). **Send to
  agent** spawns `claude` there; the ticket body is injected as context via a **`SessionStart`
  hook** (`/hook/sessionstart`), *not* typed into the prompt, which is pre-filled and **not**
  auto-submitted. **Hooks are injected by the daemon via `claude --settings <generated file>`
  (`daemon/src/hooks.ts`)** — both PreToolUse + SessionStart work in any cwd with **no per-repo
  `.claude/settings.json`** (that's why `IDEA-2` in `$HOME` previously injected nothing). The
  owner has confirmed the approval hook fires + gates in the live browser, so the `--settings`
  injection path works (SessionStart context rides the same path). Remaining polish: a full
  ticket→work→approve→commit pass, then **branch/worktree-per-ticket** isolation.

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

**Not built (leftovers):** **workspace layout persistence** (DRY-14 — resets on every reload; the
main gap before comfortable daily use), per-repo theming, **branch/worktree-per-ticket** (agent
runs in the repo's current branch, no isolation), **epic display/rollup** (DRY-13 — epics render
as plain rows), and Switchyard **comment/transition UI** (DRY-10 — server-side ready, no UI).

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
- **Hooks are daemon-injected via `claude --settings`, not per-repo.** The daemon writes a
  settings file (`daemon/src/hooks.ts`) and spawns `claude --settings <it>`, so the approval +
  ticket-context hooks work in any cwd. Don't reintroduce a per-repo `.claude/settings.json`
  install requirement (it would also double-fire).
- **Ticket-spawn pre-fills, never auto-submits.** The detail panel seeds an editable prompt and
  shows the (editable) working dir; you hit Send and review in the terminal. The ticket *body*
  is delivered as SessionStart context, not typed into the prompt.
- **Drydock honors the agent's permission mode.** Don't force a gate when the agent is hands-off
  — it's a no-op there and misleads the user.
- **Close (X) kills the session; minimize docks it (keeps running).** These are the two distinct
  verbs; don't collapse them.

## Tracking — Switchyard project DRY

Work is tracked in Switchyard under the **DRY** project (use the `switchyard` MCP —
`get_ticket`, `list_tickets` (project DRY), `comment_on_ticket`, `transition_ticket`).
The epic is **DRY-1** (In Progress). DRY-2/3/5/8 were reconciled to **Closed** on 2026-06-28;
DRY-9/10/11/12 work merged to `main` (PRs #1–#3) on 2026-06-30. The table matches the tracker:

| Ticket | Title | Switchyard status |
|--------|-------|-------|
| DRY-2  | Initial repo scaffolding & monorepo layout | **Closed** (done) |
| DRY-3  | Backend daemon: detached, durable PTY sessions | **Closed** (done — verified) |
| DRY-4  | Vue 3 + xterm.js shell: always-on grid & window mgmt | In Progress — layout persistence pulled out to DRY-14 |
| DRY-5  | Ambient attention signaling & in-place approval (hooks) | **Closed** (approval loop + permission-mode + docked-attention) |
| DRY-6  | Embedded Chromium webview for app previews | Backlog |
| DRY-7  | Local git diff review UI (approve agent commits) | Backlog |
| DRY-8  | Spike: session-durability design | **Closed** (answered; implemented in DRY-3) |
| DRY-9  | Implement Drydock web UI shell (from design prototype) | In Progress — **merged**; shell + ticket-spawn live. Remainder: worktree-per-ticket |
| DRY-10 | Pluggable issue-tracker provider abstraction (Switchyard + Jira) | In Progress — **merged**; Switchyard reads live + paginated. TODO: comment/transition UI, Jira |
| DRY-11 | Tracker sidebar: search, filters & collapsible groups | **Closed** (merged, PR #3) |
| DRY-12 | Robust hook delivery (`claude --settings`) + repo-less cwd selection | In Progress — **merged**; pending owner's final real-use sign-off |
| DRY-13 | Epics in the sidebar: distinct display + parent/child rollup | Backlog |
| DRY-14 | Persist & restore workspace layout across reloads/updates | Backlog — **the main gap before daily use** |

Before working a ticket, read its full description in Switchyard — they carry the real
design rationale. Comment progress and transition status as you go.

## Next steps (highest value first)

1. **Workspace layout persistence (DRY-14).** The daemon keeps sessions alive, but the shell's
   window state is in-memory, so every reload (dev HMR, deploy, refresh) wipes positions/sizes/
   minimized/z-order/layout-mode. This is **the main gap before comfortable daily use.** Plan:
   serialize `useWindowManager` state to `localStorage` (debounced), restore + reconcile against
   live daemon sessions on load, keyed per daemon host, versioned shape. See the ticket.
2. **Switchyard writes + UI (DRY-10).** Reads are live; what's left is the capability-gated
   **comment / transition** UI — and confirming those two request *bodies* against the API
   (paths right, field names not yet exercised).
3. **Epic display/rollup (DRY-13).** Epics render as plain rows; surface them distinctly with
   child rollup + progress. Builds on the DRY-11 sidebar; needs `parent_id` on the Ticket model.
4. **Branch/worktree-per-ticket (finishes DRY-9).** Spawn the ticket agent in an isolated
   worktree/branch instead of the repo's current branch.
5. **Jira backend (DRY-10).** Jira Cloud REST v3 + JQL; same `TrackerProvider` interface,
   selected by config — no UI branching.
6. **Daemon auth.** The daemon is **unauthenticated** and binds `0.0.0.0` by default — fine on a
   trusted LAN/Tailscale (the owner's setup) but the first thing to add past PoC.
7. **DRY-6 / DRY-7** (webview previews, git diff review) — larger, not started.

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
