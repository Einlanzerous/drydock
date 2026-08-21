# Deploying Drydock (prod) — DRY-19

Prod is deliberately split in two, because the two halves have opposite
constraints:

| component | packaging | why |
|---|---|---|
| **daemon** | systemd **user unit** on the host, from a pinned checkout | it spawns `claude` and `$SHELL` PTYs *as you, on your machine* — agents need your repos, toolchain, dotfiles, and `~/.claude` auth. A container would strip all of that or mount most of the host back in. |
| **shell** | nginx container from GHCR (`ghcr.io/einlanzerous/drydock/shell`) | static Vite build; containerizes trivially, Watchtower keeps it fresh. |

Prod runs alongside dev on separate ports, so hacking on Drydock can never
kill a prod session (the original point of this ticket):

| | daemon | shell |
|---|---|---|
| dev | `:4317` (`bun run daemon`, `--watch`) | `:5320` (Vite) |
| **prod** | **`:4318`** (systemd, pinned checkout) | **`:5321`** (nginx container) |

## Daemon (host systemd unit)

```sh
deploy/install-prod.sh            # deploy origin/main
deploy/install-prod.sh v0.1.0     # or pin a tag/sha
```

The script maintains a separate checkout at `~/.drydock/prod` (override:
`DRYDOCK_PROD_DIR`), runs `bun install` (postinstall compiles node-pty with
real node-gyp), renders `deploy/drydock-daemon.service` into
`~/.config/systemd/user/`, restarts the unit, and health-checks
`:4318/api/sessions` — treating **401 as a healthy answer**, since that is what
that route correctly tells an anonymous caller once auth is on (DRY-81; before
it, every deploy onto an auth-configured host ended by reporting a failure it
had not caused, and exited 1). Rerun it to deploy a new ref — that's the whole
update story. **A deploy no longer kills the agents that are running** — see
[below](#a-deploy-does-not-kill-the-running-agents-dry-87), which is also where
to look if prod won't start after a reboot.

First run seeds `~/.drydock/prod/.env` from `.env.example` with
`DRYDOCK_PORT=4318`; put the real `DRYDOCK_SWITCHYARD_TOKEN` and any
`DRYDOCK_REPO_PATHS` overrides there. Secrets stay in that gitignored file on
the host — never in an image or the repo.

Workspace state (DRY-28) defaults to `~/.drydock/state-4318.json`, which needs
no extra infrastructure and runs a complete Drydock. For a host you actually
depend on, point `DRYDOCK_DATABASE_URL` at a Postgres in that same `.env` — the
README's two tiers, and this is the tier that side is written for. The daemon
migrates its own schema on first use and treats an unreachable database as
degraded rather than fatal, so adding one cannot turn a database outage into a
daemon that won't start; it recovers on its own, without needing you to bounce a
host full of running agents. Note prod and dev must not share a state file: the
default carries the port for exactly that reason.

Two operational notes if you do point it at a database:

- **`/healthz` now tells a down store from one waiting to retry** —
  `store.cooling` with `retryInMs`, answered immediately instead of holding your
  monitor for the connect timeout. `ok` is still an answer about the daemon,
  which serves sessions perfectly well with a dead store.
- **Migrations are checksummed.** Editing an already-applied migration file is
  an error rather than a silent divergence, which matters here specifically:
  prod, dev and any throwaway instance can all be pointed at one database. Add a
  new numbered file instead; the store 503s until the edited one is restored,
  and live sessions are unaffected while it does.

One-time, so the unit survives logout/reboot:

```sh
sudo loginctl enable-linger $USER
```

Logs: `journalctl --user -u drydock-daemon -f` for the unit's view, and
`~/.drydock/daemon-4318.log` for the daemon's own (DRY-45) — session and client
lifecycle plus crash traces, one line each, rotating one generation at 8 MiB.
Prefer the file when working out why sessions died: it survives restarts of both
the daemon and journald, and the last line before a gap names the sessions that
went with it. Override with `DRYDOCK_LOG_FILE` in `~/.drydock/prod/.env`.

### A deploy does not kill the running agents (DRY-87)

It used to, every time. The unit set no `KillMode`, so systemd's default
`control-group` applied and the `systemctl --user restart` at the end of a deploy
SIGTERMed **every process in the unit's cgroup** — the detached supervisors along
with the daemon, and every `claude`, login shell and MCP server under them.
`setsid` gives a process its own session, not its own cgroup, so DRY-57's
durability was real and the deploy went round it. The unit now sets
`KillMode=process`: the signal goes to the daemon alone, the supervisors keep
holding their PTYs, and the daemon that comes back re-adopts them.

What that means in practice, and its limits:

- **Deploying mid-run is now an ordinary thing to do.** Agents keep working, and
  the pane reconnects on its own. An in-flight permission gate is still re-raised
  rather than preserved (the hook curl retries), and the rail's action line
  resets — so it is not literally free, just no longer destructive.
- **A few journal lines per deploy are expected**: `Unit process N remains
  running after unit stopped`. Those are the supervisors. They are the point.
- **`systemctl --user stop` is not `restart`.** Stopping leaves the supervisors
  running with nothing to adopt them until the unit starts again. That is the
  right behaviour — it is what makes a deploy safe — but a host being shut down
  for real wants the agents stopped first, not orphaned.
- Verified rather than reasoned about: `scripts/verify/prod-restart.mts` deploys
  over a live session on a throwaway unit and asserts the agent never noticed,
  with a control that puts the old behaviour back and asserts the opposite.

### Deploying from inside a Drydock session

Which is the obvious place to deploy from, since the sessions are right there.
The deploying shell is itself in the cgroup being restarted, so before this it
died partway through its own deploy — after the daemon restarted, before anything
that follows it ran, and with no error, because the shell was signalled rather
than failed.

`install-prod.sh` now detects this (it reads its own `/proc/self/cgroup`) and
re-execs itself under `systemd-run --user`, which gives it a cgroup of its own.
It still looks like an ordinary foreground command — same output, same exit
status — and prints one line saying it did so. Nothing to remember, and nothing
to arrange when deploying an OLD ref, which is the case that still needs it: the
unit installed comes from the ref being deployed, so `install-prod.sh v0.1.0`
puts a pre-DRY-87 unit in place and restarts under it.

### If prod won't start after a reboot: the node path

The unit pins an absolute path to `node`, and `install-prod.sh` used to render
whatever `command -v node` answered in the deploying shell. Under fnm that is
`/run/user/1000/fnm_multishells/<pid>_<ts>/bin/node` — a directory created for
that one shell and reaped with it. The unit on this host was pinned to a shell
that had exited days earlier and survived only because nothing had cleaned the
directory up yet; the next reboot would have left prod unable to start, with a
deploy log from days before saying it was healthy.

The path is now resolved through `/proc/self/exe` (node's own `process.execPath`)
to the version's real installation directory, and a path under `/run`, `/tmp` or
`/dev/shm` is refused rather than rendered. `Environment=PATH` gets the same
treatment, and it matters more: every spawned agent and shell inherits it, so a
deploy from an odd shell used to change what `claude`, `git` or `bun` resolve to
inside every session, silently. An fnm directory there is mapped onto the
resolved node's directory rather than dropped, since that is where the toolchain
lives; anything else ephemeral is dropped, and the drop is announced.

To see what this host would install, without installing it:

```sh
DRYDOCK_DEPLOY_PRINT_UNIT=1 deploy/install-prod.sh    # prints the unit, exits
```

Note the version is pinned deliberately, alias and all: node-pty is compiled
against this Node's ABI at install time, so a host that moves its default node
underneath prod should get a rebuild — rerun the script — rather than a segfault
on the first PTY spawn.

### If a deploy says the daemon isn't answering

Ask the probe on its own, without deploying anything:

```sh
DRYDOCK_DEPLOY_PROBE=1 deploy/install-prod.sh   # probes the configured port, exits
```

The deploy gives the restarted daemon 60 seconds to answer, which matters on a
host with many live agents: prod reconciles its sessions before it binds
(DRY-57), so time-to-bind grows with the number of supervisors.
`DRYDOCK_DEPLOY_PROBE_BUDGET` overrides it in seconds and exists for the
verification harness — a deploy should not need it.

It resolves the port from the prod `.env` the same way the deploy does — quoted
values and all, since that file is hand-edited — and prints what it saw.

- `HTTP 200` and `HTTP 401` are both a healthy daemon; the second is auth being
  on.
- `no HTTP response` means nothing is listening, and says so with the
  `journalctl` line to run.
- `answered HTTP 5xx` is either the daemon itself erroring — its catch-all
  turns any unhandled throw into a 500 — or a proxy with a dead upstream. Both
  leave something worth reading in the journal, so that line names it too.
- `answered HTTP <code>, but not as a Drydock daemon` means something ELSE is on
  that port, including when it answers 200, because the probe checks the body
  and not just the code. The journal is the wrong place for this one: if
  anything is already holding `:4318` the daemon loses the bind and exits, so
  find out what took the port.

## Who may use it (DRY-27)

The prod daemon binds `0.0.0.0:4318` and spawns commands as you. With no
credential configured that is exactly as open as it sounds — fine behind
Tailscale or a LAN you trust, and not fine on anything reachable more widely.
The daemon logs a warning at boot when it is bound to a non-loopback address
with no password, so a host in that state says so rather than being discovered.

Turning it on is one line in `~/.drydock/prod/.env` and a restart:

```sh
# generate one rather than putting a plaintext password in a unit's environment
node --import tsx scripts/hash-password.mts        # → DRYDOCK_AUTH_PASSWORD_HASH=...
```

```ini
DRYDOCK_AUTH_PASSWORD_HASH=scrypt$16384$8$1$...
# DRYDOCK_AUTH_USER=owner                     # the login name; defaults to `owner`
```

Restarting prod costs live sessions a reattach, not their lives (DRY-57, and
DRY-87 for the deploy path specifically) — but an in-flight gate's rail line
resets, so prefer a moment when nothing is mid-run.

The signing key lands in `~/.drydock/auth-key-4318` on first use and is what
makes a restart (or a deploy, or a crash under `Restart=always`) not sign
everybody out. Back it up with the rest of `~/.drydock`, or set
`DRYDOCK_AUTH_SECRET` explicitly; deleting it is the blunt "sign everyone out
everywhere" lever.

**Accounts** need Postgres — `DRYDOCK_MULTI_USER=1` alongside
`DRYDOCK_DATABASE_URL`. Without the URL the daemon refuses to start rather than
running single-user in silence, so a half-applied config fails visibly on the
deploy rather than quietly on the security posture. The first account is seeded
from `DRYDOCK_AUTH_USER`/`_PASSWORD*` and adopts the desk and session history
already saved under `DRYDOCK_OWNER`; everyone else is added from the shell's
Accounts panel.

## Shell (container)

Built and pushed by `.github/workflows/publish-shell.yml` on every `main` push
that touches `shell/**` (tags: `latest` + commit sha). The image serves the
static bundle and regenerates `/config.js` from env at container start, so the
same image works for any deployment:

- `DRYDOCK_DAEMON_PORT` (default `4318`) — daemon on the *same host the page
  was loaded from*, the normal setup. Works from localhost, LAN, or Tailscale
  without baked hostnames.
- `DRYDOCK_DAEMON_URL` — full URL for a daemon somewhere else entirely.

### construct-server stack

Add to `~/construct-server/docker-compose.yml` (no Watchtower label — default
means auto-update):

```yaml
  # --- DRYDOCK SHELL (web terminal multiplexer for AI CLIs) ---
  drydock-shell:
    image: ghcr.io/einlanzerous/drydock/shell:latest
    container_name: drydock-shell
    restart: unless-stopped
    ports:
      - "5321:80"
    environment:
      - DRYDOCK_DAEMON_PORT=4318
    networks:
      - construct_net
```

Then `docker compose up -d drydock-shell` and open `http://<host>:5321`.

The daemon is *not* in compose on purpose: it must run on the host (see table
above). The shell container only serves static files — the browser talks to
the daemon directly on `:4318`, so nothing needs to cross the docker network
boundary.

## Local smoke test of the image

```sh
docker build -f shell/Dockerfile -t drydock-shell:local .
docker run --rm -p 5321:80 -e DRYDOCK_DAEMON_PORT=4318 drydock-shell:local
# http://localhost:5321 — check /config.js reflects the env
```
