# ⚓ Drydock

A per-host **daemon that owns AI-CLI PTYs** (`claude`, `gemini-cli`, plain shells)
plus a **Vue 3 + xterm.js web shell** that attaches to them. The daemon — not any
client — holds the PTY master for the whole life of the child process, so sessions
survive disconnects, sleep, and multi-day gaps. The browser is just a viewer.

> PoC for [IDEA-3]. Scope here is the **thin magic slice**: durable PTY sessions,
> a multi-pane xterm grid, and the `PreToolUse` hook-based in-place approval loop —
> enough to decide whether this beats just using warp/tmux.

## Architecture

```
┌──────────────────────────┐         WebSocket (attach/detach, replay)
│  shell/  (Vue 3 + xterm)  │◀───────────────────────────────────────┐
│  multi-pane grid, viewer  │         HTTP (session list / spawn)     │
└──────────────────────────┘                                         │
                                                                     ▼
                                       ┌──────────────────────────────────────┐
                                       │  daemon/  (Node + node-pty + ws)       │
   claude PreToolUse  hook ─ HTTP ────▶│  • owns PTY master per session         │
   (curl → /hook/pretooluse)           │  • ring-buffer scrollback + replay     │
   claude SessionStart hook ─ HTTP ───▶│  • holds approval gates open for a UI  │
   (curl → /hook/sessionstart)         │  • injects ticket body as context      │
                                       │  • resolves ticket repo → spawn cwd    │
                                       │  • localhost-only; one per host        │
                                       └──────────────────────────────────────┘
                                                        │ spawns  claude --settings <hooks>
                                                        ▼  (PTY in the ticket's cwd,
                                                           DRYDOCK_SESSION_ID in env)
                                              claude / gemini-cli / shell
```

The wrapped CLI owns its own auth — Drydock never touches API keys. The
subscription-billed CLI *is* the access model; that's why we wrap it.

## Why a daemon (not ssh + tmux)

Durability is table stakes — a tmux *server* already owns the PTY independent of
client attach/detach. The point of building our own is the layer on top: an
always-visible multi-agent grid and **hook-based in-place approval** — a pane
lights up when its agent hits a permission gate and you approve in the UI, the
decision pre-empting the CLI's own prompt. That's the part nothing else gives you.

## Backend language decision (IDEA-4)

**TypeScript** for the daemon, **Bun** as package manager / task runner, with the
daemon process on **Node** (node-pty's V8 dependency — see caveat above). Trade-off:

| | Go | TypeScript (chosen) |
|---|---|---|
| PTY/process control | strong; ConPTY direct | `node-pty` wraps ConPTY + Unix |
| Distribution | single static binary | Node runtime (or `bun build --compile` for the non-PTY parts) |
| Shared types w/ Vue shell | no | **yes** (one protocol type) |
| Time-to-PoC | slower | **fastest vertical slice** |

For the PoC, time-to-slice and shared types win. Bun gives fast installs and runs
the shell; the daemon runs on Node because node-pty needs V8's C++ API. If Drydock
graduates, revisit Go — its single-binary-per-host story is genuinely cleaner here
than a Node + native-addon deploy, so the daemon is the most likely thing to port.

## Run it

Two terminals (this is a PoC; no packaging yet). [Bun](https://bun.sh) is the
package manager + task runner; `bun install` also compiles the `node-pty` addon
(via `scripts/build-native.mjs`):

```bash
bun install            # installs both workspaces + builds node-pty

bun run daemon         # → http://127.0.0.1:4317  (runs on Node, see below)
bun run shell          # → http://0.0.0.0:5320  (runs on Bun; binds LAN by default)
```

### Bun + node-pty caveat (why the daemon runs on Node)

The daemon process runs on **Node**, not Bun: `node-pty`'s native addon uses the
**V8 C++ API** (`v8::Value::ToString`), which Bun's JavaScriptCore runtime doesn't
provide — it loads but segfaults on the first PTY spawn. Two consequences baked
into the scripts:

- The `bun run daemon` script invokes `node` explicitly (`node --import tsx ...`).
  Bun honors an explicit `node` and routes to the real Node binary, so the command
  still works — it just doesn't run the daemon *on* Bun.
- `node-pty` must be compiled by **Node's** node-gyp. Bun's own install-time build
  (and `bun x node-gyp`) compiles against Bun and produces a binary that crashes.
  The `postinstall` runs `node scripts/build-native.mjs` to build it correctly.

Everything else — dependency install, the Vue shell, task orchestration — is pure
Bun. If `node-pty` ever ships a clean N-API build (no V8 C++ API), the daemon can
move onto Bun too.

Open <http://127.0.0.1:5320>, set a working dir, and spawn a `claude` or `bash`
session. See [`examples/demo-repo`](examples/demo-repo/README.md) to exercise the
approval loop.

## Layout

- `daemon/` — PTY-owning backend. `session.ts` is the core (PTY ownership,
  scrollback, approval gates); `server.ts` is the HTTP + WS surface; `repos.ts`
  resolves a ticket's repo name to its real working directory on this host.
- `shell/` — Vue 3 viewer. `components/TerminalPane.vue` is the core pane;
  `components/TicketDetail.vue` is the read-then-spawn ticket panel.
- `daemon/src/hooks.ts` — the `PreToolUse` + `SessionStart` hooks the daemon
  injects into every spawned `claude` via `--settings` (no per-repo install).
- `hooks/` — the same hook config as a standalone snippet (reference / manual
  fallback only; the daemon injects it automatically).

## Ticket-driven sessions

Picking a ticket (sidebar or `Ctrl K`) opens its description; the panel shows
the resolved **working directory** (editable — projects with no repo default to
`$HOME`, which you can override). **Send to agent** spawns `claude` there and the
ticket body rides into the agent's context via a `SessionStart` hook (`curl →
/hook/sessionstart`) — not typed into the prompt. The prompt is pre-filled with
your instruction and left for you to send (no auto-submit). The hooks are
injected by the daemon (`claude --settings`), so they work regardless of cwd —
no per-repo `.claude/settings.json` needed.

Repo→directory mapping is host config on the daemon: `DRYDOCK_REPOS_ROOT`
(default `~/projects`, so repo `argosy` → `~/projects/argosy`) with per-repo
overrides via `DRYDOCK_REPO_PATHS="construct-server=~/construct-server,imperium-loop=~/imperium-loop"`.
A name that resolves to no existing directory falls back to `$HOME`.

## Tracker config

The sidebar/palette default to a built-in fixture set. Point at a live tracker
with host config (copy `.env.example` → `.env`, which the daemon auto-loads;
real env vars win over the file). For Switchyard:

```bash
DRYDOCK_TRACKER=switchyard
DRYDOCK_SWITCHYARD_URL=http://localhost:4002   # REST API base; provider adds /v1
DRYDOCK_SWITCHYARD_TOKEN=sw_…                   # sent as a Bearer token, host-side only
```

The token never reaches the browser — the shell only ever calls the daemon's
`/api/tracker/*`. Credentials live in `.env` (gitignored), never in the repo.

## Not in this PoC

Tauri packaging, per-repo theming, side-by-side diff review, embedded webview,
Windows/ConPTY validation, daemon-restart journaling, gemini-cli approval
fallback. Tracked under [IDEA-3]'s other children.

## Targets

Windows desktop + home server + Android. **No macOS.** (PoC iterates on Linux PTY;
ConPTY parity is a separate verification.)

[IDEA-3]: switchyard IDEA-3
