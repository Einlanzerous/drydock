# CLAUDE.md

Drydock is a per-host daemon that owns AI-CLI PTYs (`claude`, plain shells) plus a
Vue 3 + xterm.js web shell that attaches to them. Sessions survive disconnects
because the daemon, not any client, holds the PTY master. README.md has
architecture and features; docs/deploy.md has prod.

This file holds what you need before touching code. Per-ticket detail lives in
`docs/decisions/` (`ls` it; read the matching file before changing that
surface). When you finish a ticket, add a doc there rather than growing this file.

## Build & run

```sh
bun install        # installs both workspaces; postinstall builds node-pty under REAL node-gyp
bun run up         # daemon + shell together (+ Postgres when DRYDOCK_DB_LOCAL=1)
bun run daemon     # dev daemon  → :4317 (node --import tsx --watch)
bun run shell      # dev shell   → :5320 (Vite)
```

- **The daemon runs on Node, never Bun.** node-pty's addon uses the V8 C++ API;
  under Bun it loads and then segfaults on the first PTY spawn. The scripts
  already invoke `node` explicitly — don't "simplify" them to `bun`.
- Likewise node-pty must be compiled by **Node's** node-gyp; `postinstall` runs
  `node scripts/build-native.mjs` to do this. If PTY spawns crash after a
  dependency change, rebuild with that script — not `bun x node-gyp`.
- Typecheck: `bun run --filter '@drydock/daemon' typecheck` (the shell build runs
  `vue-tsc`) and `bun run typecheck:scripts`. `scripts/` is two projects on
  purpose (`tsconfig.json` Node half, `tsconfig.browser.json` Playwright half):
  one combined project would check `tracker/cache.ts` against two `fetch` types.
- `daemon/src/protocol.ts` is duplicated **verbatim** in
  `shell/src/lib/protocol.ts`. If you touch one, mirror the other.

## The load-bearing invariants

Read these before touching `daemon/src/`.

**Sessions survive a daemon restart (DRY-57).** Each PTY is held by its own
detached supervisor process (`daemon/src/supervisor/`), so the daemon is a client
of its own sessions rather than their parent. A save under `daemon/src/` restarts
the `--watch` daemon and the agents keep running; on boot it reconciles them from
a per-port index of small files (`daemon/src/sessions-dir.ts`,
`~/.drydock/sessions-<port>/`) and reattaches, scrollback included.
`DRYDOCK_EXIT_ON_UNCAUGHT` defaults ON because a restart is cheap; its third
value, `idle`, stays up while the daemon still holds sessions and exits once the
process has taken a fault and holds none (`/healthz` says whether it has).

- **Never bump `PROTOCOL_VERSION` in `supervisor/wire.ts` casually.** A daemon
  refuses to drive a supervisor from a different build rather than misparse it,
  which strands live sessions until that supervisor's agent finishes. Change a
  frame type or the meaning of a `SessionMeta` field and you must bump it — and
  expect running sessions to become undrivable.
- **The sessions dir is per-port on purpose.** A throwaway daemon on :4399
  sharing it would adopt the dev daemon's live agents and reparent them to a
  process you're about to Ctrl-C.
- **Still don't restart prod (`:4318`) casually**, even though a deploy no longer
  kills the agents (DRY-87). Reattach is very good, not free: an in-flight gate is
  re-raised and the rail's action line resets.
- **Test daemon changes on a second instance**, never by restarting :4317/:4318.

## Verifying daemon changes: second-instance pattern

Run your change as a throwaway daemon on a spare port (`DRYDOCK_PORT=4399`), never
by restarting :4317/:4318. The procedure is the repo skill
`.claude/skills/verify/SKILL.md`: the rig, the `env -u` sweep, driving the UI and
cleanup. Two rules it enforces, stated here because they bite silently:

- **Real env wins over `.env`, and an agent Drydock spawned inherits prod's
  `DRYDOCK_*`** (database URL, auth password, tracker token). Strip them; a
  fresh worktree having no `.env` proves nothing.
- **Cleanup needs two filters.** Ctrl-C leaves detached supervisors behind. Kill
  them before removing the sessions dir, matching the sessions dir in argv AND
  the `node` exe; `pkill -f supervisor/main` kills your own session.

## Recurring traps

Numbered because docs and harnesses cite them by number.

1. **The right default is a terrible test.** Prod timeouts, sweep delays and cache
   TTLs are useless in a harness. Turn the knob down and make the harness refuse
   to run above a threshold rather than pass by waiting.
2. **An exit code is not a verdict.** A signalled process exits 129/137/143. Only
   `failure` being set, or `endReason`, means failed.
3. **Assert on what arrived, not on what rendered or on a status code.** Assert on
   bytes only the thing under test could have produced.
4. **A knob whose `0` means "off" goes through `msOrOff`, not `num()`.** `num()`
   rejects 0, so a deliberate 0 silently restores the default.
5. **Confirm a harness discriminates before trusting green.** Run it against the
   unpatched file (each README records the expected failure count).
6. **Run every tier and posture**: both state backends, all three auth modes, all
   three permission modes, both tracker providers. The forgotten one is the default.
7. **A comment saying why something is safe is only true of the code it was
   written against.** Re-read the justification when you touch the thing it justifies.

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

- Branch `dry-NN-short-slug` (or `{type}/{slug}-{key}`) off `main`; PR to `main`
  on `Einlanzerous/drydock`.
- Squash merge: the **PR title** is the commit subject and the body is empty. It
  must be Conventional Commits with the ticket in the tail (PRINCIPLES §3), e.g.
  `feat(daemon): resolve repo from Jira component (DRY-31)`. A breaking change is
  `feat!:` in the title; a `BREAKING CHANGE:` footer never reaches `main`.
- Tickets live in the DRY project (Switchyard at home; fixture data otherwise).
  When the tracker is reachable, attach the PR URL to its DRY ticket on open; the
  poller auto-closes the ticket on merge, so don't close it by hand.
- CI (`pr-checks.yml`) is a compile gate only: typechecks, the shell build, and
  the two-copy `protocol.ts` drift check. There are no automated tests, so green
  means it compiles; everything else is verified by hand. The `pr-review.yml`
  reviewer is advisory, not required: grey means triage declined (push a fix and
  it goes grey unless the PR has the `review:always` label or you comment
  `@claude review`), green means a reviewer ran, red means it failed or found
  something blocking. `REVIEW.md` holds its judgement; don't copy it here.
- Everything under `scripts/` is TypeScript, except `build-native.mjs` (postinstall)
  and `verify/drift.sh`. Two traps: a Playwright `page.evaluate` body may not bind
  a **name** to a function (tsx wraps it in a `__name(...)` helper that does not
  exist in the page; anonymous inline arrows are fine), and `scripts/up.mts` runs
  on Node, not Bun (Bun `$`-expands `.env` values and silently wins over this
  repo's literal parsers, so the database gets a different password than the daemon).
- Comments explain why and the non-obvious constraint (house style:
  `daemon/src/tracker/jira.ts`); reference the DRY-NN ticket that introduced a behaviour.

## Where the detail lives

`ls docs/decisions` (one file per ticket, named `dry-NN-topic.md`; these are
post-mortems, so nearly every numbered item is a bug that shipped), harness rigs
in `scripts/verify/README.md`, prod operations in `docs/deploy.md`.
