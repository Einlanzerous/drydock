#!/usr/bin/env bash
# Install or update the Drydock PROD daemon on this host (DRY-19).
#
# Maintains a pinned checkout at $DRYDOCK_PROD_DIR (default ~/.drydock/prod),
# fully separate from any dev checkout so dev's `--watch` restarts can never
# kill prod PTYs. Installs deps (postinstall compiles node-pty under real
# node-gyp), renders the systemd user unit, and (re)starts it. Idempotent —
# rerun with a new ref to deploy.
#
# Usage: deploy/install-prod.sh [git-ref]      (default: main)
#   DRYDOCK_PROD_DIR          override the prod checkout dir
#   DRYDOCK_PROD_REPO         override the clone source (default: this repo's origin)
#   DRYDOCK_DEPLOY_PRINT_UNIT print the unit this host would get, and exit (DRY-87)
#   DRYDOCK_DEPLOY_DETACHED   set by the script on itself; see the relaunch below
set -euo pipefail

REF="${1:-main}"
PROD_DIR="${DRYDOCK_PROD_DIR:-$HOME/.drydock/prod}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Render the systemd unit this host should get, on stdout.
#
# A function, and called from two places, because the two values it resolves come
# from the environment of whichever shell ran the deploy (DRY-87) — so "what unit
# would this shell install?" is a question worth being able to ask before finding
# out at the next reboot. `DRYDOCK_DEPLOY_PRINT_UNIT=1 deploy/install-prod.sh`
# answers it and exits, touching nothing; scripts/verify/prod-restart.mts renders
# its throwaway unit through this same function rather than a copy of it.
render_unit() {
  local node_bin node_dir unit_path entry unit

  # Neither value below may point into /run/user. fnm gives each shell its own
  # symlink directory there — /run/user/1000/fnm_multishells/<pid>_<ts>/bin —
  # and that is what `command -v node` answers inside one. It is reaped with the
  # session that made it, so a unit rendered from it keeps working until prod
  # next has to START (a deploy, a crash under Restart=always, a reboot) and
  # then cannot start at all. The unit on this host was pinned to a directory
  # belonging to a shell that had exited days earlier; it survived only because
  # nothing had reaped it yet.
  #
  # /proc/self/exe is the honest answer, and node reports it as process.execPath:
  # fnm's per-shell directory resolves through to the version's own installation.
  # Pinning the VERSION rather than fnm's `default` alias is deliberate —
  # postinstall compiles node-pty against this Node's ABI, so a host that moves
  # its default node underneath prod should get a rebuild (rerun this script),
  # not a segfault on the first PTY spawn.
  node_bin="$(node -p 'process.execPath' 2>/dev/null || true)"
  case "${node_bin:-}" in
    /*) ;;
    *) echo "error: could not resolve a node binary path (got '${node_bin:-}')" >&2; return 1 ;;
  esac
  case "$node_bin" in
    /run/*|/tmp/*|/dev/shm/*)
      echo "error: node resolves to an ephemeral path: $node_bin" >&2
      echo "       it would be reaped with the shell that ran this deploy, leaving prod" >&2
      echo "       unable to start on its next restart or reboot. Install node somewhere" >&2
      echo "       durable (fnm: ~/.local/share/fnm/node-versions/<v>/installation/bin)." >&2
      return 1 ;;
  esac
  node_dir="$(dirname "$node_bin")"

  # The same problem for Environment=PATH, and worse in kind: spawned agents and
  # shells inherit it, so a deploy run from an odd shell quietly changes what
  # `claude`, `git` or `bun` resolve to inside every session. Map fnm's per-shell
  # directory onto the node just resolved, drop anything else ephemeral (loudly —
  # a tool that silently stops resolving is how this would present), and dedupe:
  # a PATH assembled by nested shells repeats itself, and the unit is read by
  # people.
  unit_path=""
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    case "$entry" in
      */fnm_multishells/*) entry="$node_dir" ;;
    esac
    case "$entry" in
      /run/*|/tmp/*|/dev/shm/*)
        echo ">>> dropping ephemeral PATH entry from the unit: $entry" >&2
        continue ;;
    esac
    case ":$unit_path:" in *":$entry:"*) continue ;; esac
    unit_path="${unit_path:+$unit_path:}$entry"
  done < <(printf '%s' "$PATH" | tr ':' '\n')
  case ":$unit_path:" in *":$node_dir:"*) ;; *) unit_path="$node_dir${unit_path:+:$unit_path}" ;; esac

  # Substituted with bash expansion rather than sed: these are paths, and `&`,
  # `|` and `\` all mean something to sed's replacement text and nothing here.
  # systemd expands `%` specifiers in unit values, so a literal one is doubled.
  unit="$(cat "$SCRIPT_DIR/drydock-daemon.service")"
  unit="${unit//__APP_DIR__/${PROD_DIR//%/%%}}"
  unit="${unit//__NODE__/${node_bin//%/%%}}"
  unit="${unit//__PATH__/${unit_path//%/%%}}"
  printf '%s\n' "$unit"
}

# Render and stop — no clone, no install, no systemctl. Deliberately ahead of the
# relaunch below: printing a unit cannot restart anything, so it needs no cgroup
# of its own.
if [ -n "${DRYDOCK_DEPLOY_PRINT_UNIT:-}" ]; then
  render_unit
  exit 0
fi

# Deploying from inside a Drydock session means deploying from inside the cgroup
# this script is about to restart (DRY-87) — which is the obvious place to run a
# deploy from, since the sessions are right there.
#
# The KillMode=process this ships spares us, but only once the unit carrying
# that line is the one systemd has loaded, and this script renders the template
# from the ref it is DEPLOYING: `install-prod.sh v0.1.0` installs a unit from
# before the fix and then restarts under it. The failure is a partial deploy —
# the script dies after the daemon restarts and before anything else runs, with
# no error, because the shell running it was signalled rather than failing.
#
# So don't make the outcome depend on which template is about to be installed.
# A transient unit gets its own cgroup, and --pipe/--wait keep this looking like
# an ordinary foreground command: same stdout, same stderr, same exit status.
if [ -z "${DRYDOCK_DEPLOY_DETACHED:-}" ] && grep -qs 'drydock-daemon\.service' /proc/self/cgroup; then
  if command -v systemd-run >/dev/null; then
    echo ">>> deploying from inside a Drydock session — relaunching in a cgroup of our own"
    # PATH is forwarded deliberately: a transient unit starts from the user
    # manager's environment, which has neither node nor bun, and it is also what
    # gets rendered into the unit below. This must be the PATH you deployed with.
    run_args=(--user --pipe --wait --collect --quiet
              --description="drydock prod deploy"
              --setenv=DRYDOCK_DEPLOY_DETACHED=1
              "--setenv=PATH=$PATH")
    if [ -n "${DRYDOCK_PROD_DIR:-}" ]; then run_args+=("--setenv=DRYDOCK_PROD_DIR=$DRYDOCK_PROD_DIR"); fi
    if [ -n "${DRYDOCK_PROD_REPO:-}" ]; then run_args+=("--setenv=DRYDOCK_PROD_REPO=$DRYDOCK_PROD_REPO"); fi
    exec systemd-run "${run_args[@]}" -- "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" "$@"
  fi
  echo "warning: no systemd-run — this deploy may be killed partway by its own restart" >&2
fi

SRC_REPO="${DRYDOCK_PROD_REPO:-$(git -C "$SCRIPT_DIR" remote get-url origin)}"

command -v node >/dev/null || { echo "error: node is required on the prod host" >&2; exit 1; }
command -v bun >/dev/null || { echo "error: bun is required on the prod host" >&2; exit 1; }

if [ ! -d "$PROD_DIR/.git" ]; then
  git clone "$SRC_REPO" "$PROD_DIR"
fi
git -C "$PROD_DIR" fetch --tags origin
# Detached checkout: prod is pinned to exactly what you asked for; branch names
# resolve to the remote's tip, tags/shas resolve directly.
git -C "$PROD_DIR" checkout --detach "origin/$REF" 2>/dev/null \
  || git -C "$PROD_DIR" checkout --detach "$REF"

(cd "$PROD_DIR" && bun install --frozen-lockfile)

# First run: seed prod .env. Port 4318 keeps prod clear of the dev daemon
# (:4317) so both run concurrently on the same host.
if [ ! -f "$PROD_DIR/.env" ]; then
  cp "$PROD_DIR/.env.example" "$PROD_DIR/.env"
  printf '\n# --- prod instance (seeded by install-prod.sh) ---\nDRYDOCK_PORT=4318\n' >>"$PROD_DIR/.env"
  echo ">>> Seeded $PROD_DIR/.env — set DRYDOCK_SWITCHYARD_TOKEN (and any repo"
  echo ">>> overrides) there, then rerun this script or restart the unit."
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/drydock-daemon.service"
mkdir -p "$UNIT_DIR"
# Written aside and moved into place. A plain `render_unit >"$UNIT_FILE"`
# truncates the installed unit BEFORE the render can fail on it — an
# unresolvable node would leave prod holding a zero-byte unit, which is a host
# that cannot start its daemon again, arrived at by a script that was refusing
# to make things worse. `.new` does not match `*.service`, so a leftover is
# invisible to systemd.
if ! render_unit >"$UNIT_FILE.new"; then
  rm -f "$UNIT_FILE.new"
  exit 1
fi
mv -f "$UNIT_FILE.new" "$UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable drydock-daemon.service >/dev/null 2>&1 || true
systemctl --user restart drydock-daemon.service

PORT="$(grep -E '^DRYDOCK_PORT=' "$PROD_DIR/.env" | tail -1 | cut -d= -f2)"
PORT="${PORT:-4318}"
for _ in 1 2 3 4 5; do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/api/sessions" >/dev/null 2>&1; then
    echo "drydock prod daemon healthy on :$PORT ($(git -C "$PROD_DIR" rev-parse --short HEAD), ref '$REF')"
    echo "note: to survive logout/reboot, enable lingering once: sudo loginctl enable-linger $USER"
    exit 0
  fi
done
echo "error: daemon not answering on :$PORT — check: journalctl --user -u drydock-daemon -n 50" >&2
exit 1
