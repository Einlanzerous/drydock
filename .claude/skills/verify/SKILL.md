---
name: verify
description: Use after changing daemon/src or shell/src in Drydock, and before claiming a fix works or opening a PR that touches them. Stands up a throwaway second daemon (spare port, own sessions dir, prod env stripped) plus Vite, drives the UI with headless Playwright, and cleans up the detached supervisors. Required whenever the tester is itself a Drydock-spawned agent. Never restart :4317 or :4318.
---

# Verifying Drydock changes at the surface

The surface is the browser UI (Vue shell + xterm) backed by the daemon's
HTTP/WS API. Never restart the live dev daemon (:4317) or prod (:4318) — they
own live PTYs. Stand up a throwaway pair instead:

```sh
# 0. A fresh worktree needs its own node_modules + node-pty build: `bun install` at its root.
# 1. Throwaway daemon. Real env beats .env (a fresh worktree has no .env).
cd daemon && DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts &

# 2. Dev shell on a spare port. VITE_DAEMON_URL is REQUIRED — it's baked in at
#    vite server start and is the only override that survives (see below).
VITE_DAEMON_URL=http://127.0.0.1:4399 bunx vite --port 5399 --strictPort &   # run from shell/

curl -s localhost:4399/healthz         # {status:"ok", ok:true, sessions:N} → ready
```

The sessions dir is per-port on purpose: a throwaway daemon sharing the dev
daemon's would adopt its live agents and reparent them to a process you are
about to Ctrl-C. Keep a unique `DRYDOCK_SESSIONS_DIR` for yours.

### When you are a Drydock-spawned agent: strip the inherited env

"Real env wins" bites here. The session inherits the daemon that started it, so
a "throwaway" started from inside one runs with the **prod**
`DRYDOCK_DATABASE_URL`, `DRYDOCK_AUTH_PASSWORD` and tracker token, and a fresh
worktree having no `.env` says nothing about it. The tell is `/healthz`
answering `store.kind: "postgres"` when you passed a state file, or an anonymous
request 401ing. Strip them all (the set is not fixed) rather than overriding one
at a time:

```sh
env $(env | grep -o '^DRYDOCK_[A-Z_0-9]*' | sed 's/^/-u /' | tr '\n' ' ') \
  DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 DRYDOCK_TRACKER=fixture \
  DRYDOCK_STATE_FILE=/tmp/s.json node --import tsx src/index.ts
```

## Driving the UI with Playwright

Install the library into a scratch dir (`npm i playwright`; if the launch
errors with "Executable doesn't exist", run `npx playwright install chromium`).
⚠️ Do NOT rely on `page.addInitScript` to set `window.__DRYDOCK__` — dev serves
`public/config.js`, which loads after any init script and resets it to `{}`,
silently pointing the page at the default :4317 — the LIVE daemon. The
`VITE_DAEMON_URL` on the vite command above is the override that works. Before
driving anything, spawn one session and confirm it landed on :4399.

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto("http://127.0.0.1:5399");
await page.waitForSelector(".topbar");
```

Useful handles:

- Spawning, all of it, goes through the palette since DRY-82 — the header's
  `+ claude` and `+ workspace` buttons are gone and `button.new` is the only
  spawn control left. Open it, filter to the row you want, click it:
  `button.new` → `page.fill(".palette .search input", "workspace")` →
  `.palette .row.pinrow`. The three pinned rows are `shell`, `claude` and
  `workspace`; `scripts/verify/prefill.mts` does exactly this if you want it
  written out.
- A live terminal exists once `.xterm-helper-textarea` appears; keyboard focus
  is in a terminal iff `document.activeElement` is that textarea. In a
  workspace, agent vs shell pane = `ae.closest(".agent")` / `ae.closest(".shell")`.
- Ground-truth session state from the daemon, not the DOM:
  `GET :4399/api/sessions`; kill with `POST /api/sessions/<id>/kill`.
- The 3s reconcile poll removes windows for dead sessions — wait ~3.5s after a
  kill before asserting on the DOM.
- The palette's `claude` row spawns a REAL `claude` CLI (takes a couple seconds
  to draw; may show its trust prompt depending on cwd). Fine for focus/window
  assertions; kill all sessions between scenarios. To assert on what a spawn
  ASKED for rather than on what it started, intercept it instead —
  `page.route("**/api/sessions", …)` answering POSTs with a session-shaped 201,
  as `desk-chrome.mts` does.

## Before/after comparison

Shell-only diffs hot-reload under Vite, so you can demonstrate the bug on the
unpatched tree without touching the daemon: `git stash && node test.mjs && git
stash pop` and diff the script's output.

## Teardown

Kill all sessions via the API, then stop the throwaway daemon and Vite. Leave
:4317/:4318 alone. Ctrl-C leaves the **detached supervisors** behind, so
cleaning up is a real step.

Supervisors first, then the sessions directory: `rm -rf` on a sessions dir with
live supervisors deletes the only handle anything has on them (the tell is a
supervisor whose log fd reads `(deleted)`). Both filters are load-bearing and
neither works alone. `pkill -f supervisor/main` matches the shell running it and
kills your own session. An exe-only loop is not enough either: every supervisor
on the host is the same `node` binary, so it kills live agents belonging to
daemons you are not testing, including the one holding your terminal. The
throwaway `DRYDOCK_SESSIONS_DIR` is unique to your daemon and is in every
supervisor's argv; the exe test excludes the shell running the loop (whose own
command line contains both literals).

```sh
for p in $(pgrep -f "supervisor/main"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    tr '\0' ' ' < /proc/$p/cmdline | grep -q "/tmp/d79/" && kill -9 "$p";;
  esac
done
```

The throwaway **daemon** needs exe AND cwd, because `pgrep -f "src/index.ts"`
also matches the cleanup's own shell, and other agents' worktrees run daemons
too:

```sh
for p in $(pgrep -f "src/index.ts"); do
  case "$(readlink /proc/$p/exe)" in *node*)
    case "$(readlink /proc/$p/cwd)" in *<your-worktree>*) kill "$p";; esac;;
  esac
done
```

Smoke checks against the throwaway: `curl -s localhost:4399/healthz` (status, ok,
sessions, faults), `/api/sessions` (list; POST spawns), `/api/tracker/info`
(active provider).

## Gotchas

- After `bun pull`/branch switch, a failing `vue-tsc` on missing modules
  usually means stale node_modules — `bun install` at the repo root (its
  postinstall rebuilds node-pty under real node-gyp).
- Typecheck/build is `bun run build` in `shell/` (`vue-tsc -b && vite build`)
  — necessary, never sufficient: drive the UI for behavior claims.
