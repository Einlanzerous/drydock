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
#   DRYDOCK_PROD_DIR    override the prod checkout dir
#   DRYDOCK_PROD_REPO   override the clone source (default: this repo's origin)
set -euo pipefail

REF="${1:-main}"
PROD_DIR="${DRYDOCK_PROD_DIR:-$HOME/.drydock/prod}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
mkdir -p "$UNIT_DIR"
sed -e "s|__APP_DIR__|$PROD_DIR|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    -e "s|__PATH__|$PATH|g" \
    "$SCRIPT_DIR/drydock-daemon.service" >"$UNIT_DIR/drydock-daemon.service"

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
