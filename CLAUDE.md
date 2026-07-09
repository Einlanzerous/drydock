# CLAUDE.md

Drydock is a per-host daemon that owns AI-CLI PTYs (`claude`, plain shells) plus a
Vue 3 + xterm.js web shell that attaches to them. Sessions survive disconnects
because the daemon — not any client — holds the PTY master. See README.md for
architecture and features; docs/deploy.md for prod.

## Build & run

```sh
bun install        # installs both workspaces; postinstall builds node-pty under REAL node-gyp
bun run daemon     # dev daemon  → :4317 (node --import tsx --watch)
bun run shell      # dev shell   → :5320 (Vite)
```

- **The daemon runs on Node, never Bun.** node-pty's addon uses the V8 C++ API;
  under Bun it loads and then segfaults on the first PTY spawn. The scripts
  already invoke `node` explicitly — don't "simplify" them to `bun`.
- Likewise node-pty must be compiled by **Node's** node-gyp; `postinstall` runs
  `node scripts/build-native.mjs` to do this. If PTY spawns crash after a
  dependency change, rebuild with that script — not `bun x node-gyp`.
- Typecheck: `bun run --filter '@drydock/daemon' typecheck` (and the shell build
  runs `vue-tsc`).
- `daemon/src/protocol.ts` is duplicated **verbatim** in
  `shell/src/lib/protocol.ts`. If you touch one, mirror the other.

## ⚠️ The dev daemon kills sessions on edit

`bun run daemon` runs `--watch`: **any save under `daemon/src/` restarts the
daemon and destroys every live agent PTY it owns** — including the session you
may be running in. Rules:

1. Never edit `daemon/src/` in a checkout whose daemon has live sessions. Work
   in a git worktree (ticket-spawned agents get one automatically, branch
   `agent/<TICKET>`).
2. Never test daemon changes by restarting a daemon that has live sessions —
   dev (`:4317`) or prod (`:4318`, systemd unit `drydock-daemon`). Spin up a
   second instance instead (next section).

## Verifying daemon changes: second-instance pattern

Run your changed code as a throwaway daemon on a spare port, with config passed
as env vars (real env always wins over `.env`; a fresh worktree has no `.env`):

```sh
cd <your-worktree>
bun install                       # worktree needs its own node_modules + node-pty build
cd daemon
DRYDOCK_PORT=4399 DRYDOCK_HOST=127.0.0.1 node --import tsx src/index.ts
```

Smoke-test against it (`curl` from another terminal):

```sh
curl -s localhost:4399/healthz                 # {ok:true, sessions:N}
curl -s localhost:4399/api/sessions            # list; POST spawns (see server.ts)
curl -s localhost:4399/api/tracker/info        # active tracker provider
```

## Verifying a tracker provider (Switchyard / Jira)

The tracker is host config; the browser only ever sees `/api/tracker/*`.
Checklist, using the second-instance pattern above with the provider's env:

```sh
# Jira Cloud: email + API token → Basic auth
DRYDOCK_PORT=4399 DRYDOCK_TRACKER=jira \
  DRYDOCK_JIRA_URL=https://yourco.atlassian.net \
  DRYDOCK_JIRA_EMAIL=you@yourco.com DRYDOCK_JIRA_TOKEN=... \
  DRYDOCK_TRACKER_PROJECTS=SRE,SREREV,SREDESK \
  node --import tsx src/index.ts

# Jira Server/DC: personal access token ALONE (Bearer) — no email
```

Always set `DRYDOCK_TRACKER_PROJECTS` against a corporate tracker (DRY-30) —
unscoped, the sidebar query pulls every open ticket in the instance. Note the
boolean params are literal `true`, not `1`.

1. `curl -s localhost:4399/api/tracker/info` — provider id/name/capabilities +
   the configured default `projects`.
2. `curl -s "localhost:4399/api/tracker/tickets?open=true"` — the sidebar
   query: scoped to the default projects, backlog excluded; exercises search
   pagination (Cloud `/search/jql` + nextPageToken vs DC `/search` + startAt —
   the probe/fallback and every other Cloud/DC divergence is documented in
   `daemon/src/tracker/jira.ts`'s comments; read them before debugging).
3. `curl -s "localhost:4399/api/tracker/tickets?open=true&backlog=true"` — now
   backlog-bucket tickets appear too (the sidebar's `backlog` toggle).
4. `curl -s "localhost:4399/api/tracker/tickets?open=true&projects=SRE,FOO"` —
   explicit scope overrides the env default (the sidebar's added chips).
5. `curl -s "localhost:4399/api/tracker/search?q=<text>"` — palette/search
   query; project-scoped, but spans all statuses.
6. `curl -s "localhost:4399/api/tracker/tickets?project=<KEY>&open=true"` —
   single-project JQL clause.
7. `curl -s "localhost:4399/api/tracker/ticket/<KEY>"` for a ticket that HAS a
   component — `repo` must be the component slug (lowercase, spaces→dashes,
   DRY-31), not the project key; a component-less ticket falls back to the
   lowercased project key.
8. End-to-end: point a browser at the dev shell, switch it to the throwaway
   daemon port, open a ticket, **Send to agent** — verifies repo→cwd resolution
   (`DRYDOCK_REPOS_ROOT` / `DRYDOCK_REPO_PATHS`, keyed by component slug for
   Jira) and the SessionStart context injection.

There are no automated tests yet — these curls plus a ticket-spawn are the
regression suite. Don't claim a provider works until they all pass against a
real instance.

## Config

All host config is env vars, optionally via a gitignored `.env` at the checkout
root (`daemon/src/env.ts` walks up from cwd; real env wins). `.env.example`
documents every knob; `daemon/src/config.ts` is the source of truth. Secrets
never go in the repo or an image.

## Prod

`deploy/install-prod.sh` maintains a pinned checkout at `~/.drydock/prod` and a
systemd **user** unit `drydock-daemon` on `:4318`; the shell is an nginx
container from GHCR on `:5321`. Deploy = rerun the script with a ref. Details in
docs/deploy.md. Treat the prod daemon like dev: it owns live PTYs, so don't
restart it to test things.

## Conventions

- Branch `dry-NN-short-slug` off `main`; PR to `main` on
  `Einlanzerous/drydock` (public).
- **Conventional Commits** (DRY-38): release-please computes versions from
  them, so commit subjects must be `feat:` / `fix:` / `docs:` / `chore:` /
  `refactor:` (optionally scoped: `feat(daemon): …`) with the ticket in the
  subject tail — e.g. `feat(daemon): resolve repo from Jira component (DRY-31)`.
  Breaking change → `feat!:` or a `BREAKING CHANGE:` footer. Non-CC subjects
  are invisible to release math.
- Tickets live in the DRY project (Switchyard at home; fixture data otherwise).
  When the tracker is reachable, attach the PR URL to its DRY ticket on open —
  the poller auto-closes the ticket on merge, so don't close it by hand.
- Comment style: explain *why* and the non-obvious constraint (see
  `daemon/src/tracker/jira.ts` for the house style); reference the DRY-NN
  ticket that introduced a behavior.
