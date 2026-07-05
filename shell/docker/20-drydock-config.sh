#!/bin/sh
# Regenerates /config.js from env at container start (nginx runs every
# executable /docker-entrypoint.d/*.sh before serving). DRYDOCK_DAEMON_URL
# (full URL, for a daemon on a different host) wins over DRYDOCK_DAEMON_PORT
# (same host as the page — the normal prod setup, daemon systemd unit on :4318).
set -eu
OUT=/usr/share/nginx/html/config.js
{
  echo "// generated at container start by 20-drydock-config.sh"
  echo "window.__DRYDOCK__ = {"
  if [ -n "${DRYDOCK_DAEMON_URL:-}" ]; then
    echo "  daemonUrl: \"${DRYDOCK_DAEMON_URL}\","
  fi
  echo "  daemonPort: \"${DRYDOCK_DAEMON_PORT:-4318}\","
  echo "};"
} > "$OUT"
