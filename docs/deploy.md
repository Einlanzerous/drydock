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
`:4318/api/sessions`. Rerun it to deploy a new ref — that's the whole update
story.

First run seeds `~/.drydock/prod/.env` from `.env.example` with
`DRYDOCK_PORT=4318`; put the real `DRYDOCK_SWITCHYARD_TOKEN` and any
`DRYDOCK_REPO_PATHS` overrides there. Secrets stay in that gitignored file on
the host — never in an image or the repo.

One-time, so the unit survives logout/reboot:

```sh
sudo loginctl enable-linger $USER
```

Logs: `journalctl --user -u drydock-daemon -f`

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
