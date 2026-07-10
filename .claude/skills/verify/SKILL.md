---
name: verify
description: Verify shell (Vue UI) or daemon changes end-to-end by driving the real app — throwaway daemon + Vite + headless-chromium Playwright.
---

# Verifying Drydock changes at the surface

The surface is the browser UI (Vue shell + xterm) backed by the daemon's
HTTP/WS API. Never restart the live dev daemon (:4317) or prod (:4318) — they
own live PTYs. Stand up a throwaway pair instead:

```sh
# 1. Throwaway daemon (second-instance pattern, CLAUDE.md). Real env beats .env.
cd daemon && DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts &

# 2. Dev shell on a spare port. VITE_DAEMON_URL is baked at server start, but
#    the Playwright script below overrides it at runtime anyway.
bunx vite --port 5399 --strictPort &   # run from shell/

curl -s localhost:4399/healthz         # {ok:true, sessions:N} → ready
```

## Driving the UI with Playwright

Install the library into a scratch dir (`npm i playwright`; if the launch
errors with "Executable doesn't exist", run `npx playwright install chromium`).
Point the page at the throwaway daemon with an init script — this beats every
other config source (see `shell/src/lib/daemon.ts`):

```js
import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => { window.__DRYDOCK__ = { daemonPort: 4399 }; });
await page.goto("http://127.0.0.1:5399");
await page.waitForSelector(".topbar");
```

Useful handles:

- Header spawn buttons: `button:has-text("+ claude")`, `button:has-text("+ workspace")`.
- A live terminal exists once `.xterm-helper-textarea` appears; keyboard focus
  is in a terminal iff `document.activeElement` is that textarea. In a
  workspace, agent vs shell pane = `ae.closest(".agent")` / `ae.closest(".shell")`.
- Ground-truth session state from the daemon, not the DOM:
  `GET :4399/api/sessions`; kill with `POST /api/sessions/<id>/kill`.
- The 3s reconcile poll removes windows for dead sessions — wait ~3.5s after a
  kill before asserting on the DOM.
- `+ claude` spawns a REAL `claude` CLI (takes a couple seconds to draw; may
  show its trust prompt depending on cwd). Fine for focus/window assertions;
  kill all sessions between scenarios.

## Before/after comparison

Shell-only diffs hot-reload under Vite, so you can demonstrate the bug on the
unpatched tree without touching the daemon: `git stash && node test.mjs && git
stash pop` and diff the script's output.

## Teardown

Kill all sessions via the API, then stop the throwaway daemon and Vite. Leave
:4317/:4318 alone.

## Gotchas

- After `bun pull`/branch switch, a failing `vue-tsc` on missing modules
  usually means stale node_modules — `bun install` at the repo root (its
  postinstall rebuilds node-pty under real node-gyp).
- Typecheck/build is `bun run build` in `shell/` (`vue-tsc -b && vite build`)
  — necessary, never sufficient: drive the UI for behavior claims.
