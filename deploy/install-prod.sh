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
#   DRYDOCK_DEPLOY_PROBE      probe the configured daemon, and exit (DRY-81)
#   DRYDOCK_DEPLOY_PROBE_BUDGET  seconds to wait for the daemon (default 60; for
#                             the harness — a deploy should not need it)
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
  #
  # The `\n` in the printf feeding this loop is load-bearing. Without it `read`
  # sets `entry` on the
  # final field — which has no delimiter after it — and then returns non-zero, so
  # the body never runs for it and the LAST directory on PATH is dropped.
  # Silently, too, since the announcement below lives in the body that was
  # skipped: this change's own bug, arriving through this change. A deploying
  # shell whose PATH ends in ~/.local/bin, ~/.bun/bin or /snap/bin would have
  # that directory stop resolving inside every spawned session.
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
  done < <(printf '%s\n' "$PATH" | tr ':' '\n')
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

# The port this host's prod daemon is configured on.
#
# A function for the same reason render_unit is one: the probe mode below has to
# ask the same question the deploy does, and a second copy of the lookup would
# be a probe that can check a different daemon than the one just restarted.
prod_port() {
  local port
  # `|| true` because both halves of this can legitimately fail and the script
  # runs under `set -eo pipefail`: a .env that has not been seeded yet, and a
  # .env with no DRYDOCK_PORT line in it. Either way the answer is the default,
  # not an aborted deploy — and the original inline version of this line would
  # have taken the script down on a hand-edited prod .env.
  # `head -1`, not `tail -1`: `env.ts` skips a key already in the environment
  # (`key in process.env`), so the FIRST occurrence in the file is the one the
  # daemon uses. Last-wins put the probe on a port the daemon was not on — the
  # ticket's own failure again, reached by editing this .env the way people
  # actually edit it, which is to append (review).
  # The anchor allows what `env.ts` allows on the KEY side: it trims the whole
  # line and then the key, so an indented entry or spaces around the `=` are
  # ordinary config to the daemon and were invisible to a bare `^DRYDOCK_PORT=`.
  # The daemon bound the configured port and the probe went to :4318 — and on a
  # dev box that is not a miss, it is a healthy verdict about the REAL prod
  # daemon (review). Third spelling of the same gap; hence the anchor rather
  # than another special case.
  port="$(grep -E '^[[:space:]]*DRYDOCK_PORT[[:space:]]*=' "$PROD_DIR/.env" 2>/dev/null \
            | head -1 | cut -d= -f2- || true)"
  # Then read it the way the DAEMON reads it. `env.ts` trims the value and
  # strips a matching quote pair; `cut` does neither. So a prod .env holding
  # DRYDOCK_PORT="4318" — and that file is hand-edited, since the unit keeps all
  # prod config in it — put the daemon on 4318 and the probe on :"4318", which
  # is this ticket's own failure in a different spelling (review). Whitespace
  # goes wholesale rather than end-anchored: a port with a space in the middle
  # is not a port, and this also takes the \r off a CRLF-edited file.
  port="$(printf '%s' "$port" | tr -d '[:space:]')"
  case "$port" in
    \"*\") port="${port#\"}"; port="${port%\"}" ;;
    \'*\') port="${port#\'}"; port="${port%\'}" ;;
  esac
  printf '%s\n' "${port:-4318}"
}

# Wait for the daemon to answer on $1. Prints the last HTTP status seen.
#
# "Answered" and "authorized" are DIFFERENT QUESTIONS, and conflating them made
# every deploy onto an auth-configured host report a failure it had not caused
# (DRY-81). This used to be `curl -fsS .../api/sessions`, and `-f` exits
# non-zero on 4xx — so once DRYDOCK_AUTH_PASSWORD was set, the route's correct
# 401 to an anonymous caller read as "daemon not answering", the script exited
# 1, and anything wrapping it treated a good deploy as a broken one. The daemon
# was up and serving the whole time. The natural next move on reading that error
# is to go poking at a prod daemon holding live agent PTYs, which is the real
# cost.
#
# 200 and 401 are exhaustive over this daemon's postures. Anonymously,
# /api/sessions answers 200 with auth off and 401 with it on — under `single`
# AND `multi`, because `Auth.identify` short-circuits on a missing credential
# (reason "anonymous") before it reads the accounts store, so the 503 that a
# store outage produces for a TOKEN-bearing caller is not reachable here.
#
# THE STATUS CODE IS NOT ENOUGH ON ITS OWN, which is review's find on the first
# version of this and the reason the body is read. The hazard this probe has to
# survive is that something ELSE is on the port: if anything is already holding
# :4318 the daemon loses the bind and exits, and the squatter answers instead.
# Rejecting 5xx catches a proxy with a dead upstream; it does nothing about a
# plain 200 page, which is what a stray web server on that port serves and which
# the old `curl -fsS` accepted too. So a 200 must carry `"sessions"` and a 401
# must carry `"authRequired"` — one field each, both from this daemon's own
# routes, and cheap enough to check with a glob. Without this the probe tells a
# live port from a dead one, which is a weaker claim than "prod is up".
#
# -m bounds an attempt: a daemon can accept a connection and then never answer
# (a wedged event loop, a stale nginx in front of it), and the old probe had no
# timeout at all — so that case hung the deploy forever with nothing on stdout.
probe_daemon() {
  local port="$1" out="" code="" body="" budget deadline
  # A BUDGET IN SECONDS, not a count of attempts, and 60 rather than 5. The loop
  # was `for _ in 1 2 3 4 5; do sleep 1`, and a refused loopback connect returns
  # instantly, so a daemon that has not bound yet got five seconds flat. Prod's
  # boot reconciles its sessions BEFORE `listen()` (DRY-57), so time-to-bind
  # grows with the number of live supervisors on the host — and a host with
  # enough agents to push it past five seconds gets this ticket's sentence
  # again, reached through a slow boot instead of through auth (review). "Five
  # attempts" reads generous in a way "five seconds" does not.
  #
  # The knob is for the harness, which has six cases that are SUPPOSED to fail
  # and would otherwise wait out the full budget each: the right default here is
  # a terrible test, same as DRY-49's timeout and DRY-60's sweep delay. A deploy
  # should never set it. 0 is one attempt, which is a coherent thing to ask for
  # rather than an off switch, so no msOrOff.
  budget="${DRYDOCK_DEPLOY_PROBE_BUDGET:-60}"
  case "$budget" in ''|*[!0-9]*) budget=60 ;; esac
  deadline=$((SECONDS + budget))
  while :; do
    sleep 1
    # `-w` appends the status as the last three characters of stdout — always
    # three, `000` when nothing answered — so one curl yields both halves
    # without a temp file.
    out="$(curl -s -m 5 -w '%{http_code}' \
             "http://127.0.0.1:$port/api/sessions" 2>/dev/null || true)"
    if [ "${#out}" -ge 3 ]; then code="${out: -3}"; body="${out%???}"; else code="000"; body=""; fi
    case "$code" in
      200) case "$body" in *'"sessions"'*) printf '%s\n' "$code"; return 0 ;; esac ;;
      401) case "$body" in *'"authRequired"'*) printf '%s\n' "$code"; return 0 ;; esac ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || break
  done
  printf '%s\n' "${code:-000}"
  return 1
}

# What a FAILING probe saw, and where to look next.
#
# Three arms, because they point at three different problems and only two of
# them are a journal. Nothing listening is `journalctl`. A 5xx is either this
# daemon throwing (`server.ts` turns any unhandled error into a 500) or a proxy
# with a dead upstream, and both leave something in the journal worth reading.
# Everything else — a 404, a plain 200 page, a redirect — means somebody else
# has the port, the journal will only say the daemon could not bind, and what is
# needed is the name of whatever took it.
#
# Both halves of this were wrong once. The first version appended one
# `journalctl` hint to every failure while the comment above it argued they
# differed; the second split them and then asserted, here and in two documents,
# that a non-200 answer means the daemon is not the answerer — which its own
# catch-all 500 contradicts. Both found in review, and they are the same
# mistake pointing in opposite directions: a failure line is read by somebody
# deciding where to look, so being confidently wrong costs more than being
# vague.
probe_failure() {
  case "${1:-}" in
    000|"") printf 'no HTTP response — check: journalctl --user -u drydock-daemon -n 50' ;;
    5??) printf 'answered HTTP %s — this daemon erroring, or a proxy with a dead upstream; check: journalctl --user -u drydock-daemon -n 50' "$1" ;;
    *) printf 'answered HTTP %s, but not as a Drydock daemon — find out what else is bound to :%s' "$1" "${2:-}" ;;
  esac
}

# Render and stop — no clone, no install, no systemctl. Deliberately ahead of the
# relaunch below: printing a unit cannot restart anything, so it needs no cgroup
# of its own.
if [ -n "${DRYDOCK_DEPLOY_PRINT_UNIT:-}" ]; then
  render_unit
  exit 0
fi

# Probe the daemon this host is configured to run and stop — no clone, no
# install, no systemctl, nothing restarted. Same argument as PRINT_UNIT above:
# the health check is the one thing on this path that has been WRONG (DRY-81),
# and it depends on a posture (auth on) that a harness reimplementing the curl
# would only be verifying its own copy of. scripts/verify/deploy-probe.mts drives
# this mode. Deliberately ahead of the relaunch guard: probing restarts nothing,
# so it needs no cgroup of its own.
if [ -n "${DRYDOCK_DEPLOY_PROBE:-}" ]; then
  probe_port="$(prod_port)"
  if probe_code="$(probe_daemon "$probe_port")"; then
    echo "drydock prod daemon answering on :$probe_port (HTTP $probe_code)"
    exit 0
  fi
  echo "error: daemon not answering on :$probe_port ($(probe_failure "$probe_code" "$probe_port"))" >&2
  exit 1
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

PORT="$(prod_port)"
if CODE="$(probe_daemon "$PORT")"; then
  # HTTP $CODE is already in hand, and it is worth printing: on a host that has
  # turned auth on, a `healthy … (HTTP 200)` where 401 was expected is the
  # visible tell that DRYDOCK_AUTH_PASSWORD has fallen out of the prod .env and
  # the deploy has just reported a daemon that is up AND wide open (review).
  echo "drydock prod daemon healthy on :$PORT (HTTP $CODE, $(git -C "$PROD_DIR" rev-parse --short HEAD), ref '$REF')"
  echo "note: to survive logout/reboot, enable lingering once: sudo loginctl enable-linger $USER"
  exit 0
fi
echo "error: daemon not answering on :$PORT ($(probe_failure "$CODE" "$PORT"))" >&2
exit 1
