# A deploy keeps the agents (DRY-87)

Everything in [dry-57-session-durability.md](dry-57-session-durability.md) about
sessions surviving a restart was true of the daemon PROCESS dying and false of
the way prod is redeployed. `deploy/drydock-daemon.service`
set no `KillMode`, so systemd's default `control-group` applied: `systemctl --user
restart` — the last line of `install-prod.sh`, so this is what EVERY deploy did —
SIGTERMed every process in the unit's cgroup. Measured on the prod host
mid-deploy, that cgroup held the supervisors, their `zsh -l`s, a live `claude`,
its MCP server, and an `amber serve` from a worktree. `KillMode=process` in
`[Service]` is the fix.

1. **`setsid` does not leave a cgroup, and that is the one hole in DRY-57's
   design.** Detaching is about process trees — its own session, its own process
   group, `unref`ed — and cgroup membership is inherited across fork regardless.
   So every reassurance in the DRY-57 section is about the wrong axis from
   systemd's point of view: the daemon is not the supervisors' PARENT, and they
   are still in its cgroup. Anything else that reasons about "detached" as
   though it meant "out of reach" is worth re-checking against this.
2. **NOT `mixed`, which is the tempting middle.** It SIGTERMs the main process
   only but still SIGKILLs the whole cgroup once `TimeoutStopSec` expires — so
   it costs exactly the agent that is slow to exit, which is the one most likely
   to be mid-task.
3. **"The first deploy is already safe" is a systemd claim, so measure it.**
   `install-prod.sh` runs `daemon-reload` BEFORE `restart`, and the whole story
   depends on whether a changed `KillMode` reaches an ALREADY-RUNNING unit on
   reload or waits for the next start. Measured on systemd 255 with a transient
   unit that forks a detached child: the reload applies, the pre-reload child
   survives the restart, and subsequent restarts spare it too. Expect journal
   lines saying `Unit process N remains running after unit stopped` — those are
   the supervisors, and they are the point.
4. **`stop` is not `restart`.** Stopping the unit now leaves supervisors running
   with nothing to adopt them until it starts again. Right for a deploy, wrong
   for a host being shut down for real — stop the agents first.
5. **The unit pinned an ephemeral node path, and it is a divergence rather than
   a host-wide fact.** `install-prod.sh` rendered `$(command -v node)`, which
   under fnm is `/run/user/1000/fnm_multishells/<pid>_<ts>/bin/node` — a
   directory made for the shell that ran the deploy and reaped with it. The
   supervisors were never affected: `SupervisorLink.spawn` uses
   `process.execPath`, which is `/proc/self/exe` and so fully resolved. The unit
   now resolves the same way (`node -p process.execPath`) and REFUSES a `/run`,
   `/tmp` or `/dev/shm` result rather than rendering it. Prod was pinned to a
   shell that had exited days earlier and survived only because nothing had
   reaped the directory; the tell would have been a host that came back from a
   reboot with no daemon and a deploy log saying it was healthy.
6. **`Environment=PATH` is the same bug and worse in kind**, because every
   spawned agent and shell inherits it: a deploy from an odd shell quietly
   changes what `claude`, `git` or `bun` resolve to inside every session. An fnm
   directory there is MAPPED onto the resolved node's directory rather than
   dropped — that is where the toolchain lives, so dropping it would take
   `npm`/`corepack` with it — and anything else ephemeral is dropped with a line
   saying so.
   - **The loop that does it is fed `printf '%s\n'`, and the `\n` is the whole
     thing.** Without it `read` sets `entry` on the final field — which has no
     delimiter after it — and then returns non-zero, so the body never runs and
     the LAST directory on PATH is dropped. Silently, because the announcement
     lives in the body that was skipped. This shipped in the first version of
     the fix and review caught it: `~/.local/bin`, `~/.bun/bin` and `/snap/bin`
     are all common last entries, so it was this section's own bug, arriving
     through the change that adds this section. The harness now ends its
     doctored PATH with something distinctive and asserts it survives — and note
     WHY it missed the first time: that PATH ended in the duplicate `/usr/bin`,
     so the entry the bug ate was the one the dedupe check watched, and
     `duplicates collapse` passed whether or not any dedupe existed. **Two
     properties need two entries.**
7. **A deploy is run from inside the cgroup it restarts**, because a Drydock
   session is the obvious place to run one from. `install-prod.sh` re-execs
   itself under `systemd-run --user` when it finds `drydock-daemon.service` in
   its own `/proc/self/cgroup`. Note this does NOT become unnecessary once the
   fix is in: the unit installed is rendered from the ref being DEPLOYED, so
   `install-prod.sh v0.1.0` puts a pre-DRY-87 unit in place and then restarts
   under it. The forwarded PATH is deliberately verbatim — sanitising is the
   renderer's job, and a stripped PATH would take node and bun away from the
   deploy itself.
8. **A failed render must not truncate the unit it was refusing to replace.**
   `render_unit >"$UNIT_FILE"` truncates before the render can fail, so the
   guard added in trap 5 would leave a host holding a zero-byte unit — unable to
   start its daemon ever again, arrived at by a script declining to make things
   worse. Rendered to `.new` and moved into place; the harness asserts a refusal
   prints nothing on stdout, which is the property that makes the redirect
   dangerous in the first place.
9. **One renderer, called twice.** `DRYDOCK_DEPLOY_PRINT_UNIT=1
   deploy/install-prod.sh` prints the unit this host would get and exits,
   touching nothing — it exists because the fragile values come from the
   deploying shell's environment, so "what would this shell install?" is worth
   being able to ask before finding out at the next reboot, and because a
   harness that substituted the template itself would be verifying its own copy
   of the logic.

Harness: `scripts/verify/prod-restart.mts`, rig in its README — it owns a
throwaway systemd unit, needs no browser or database, and takes about thirty
seconds. Its control case runs every time and asserts the OLD behaviour still
kills supervisors; confirm it discriminates by commenting out `KillMode=process`
in the template, against which it fails 8 of 40. Note what still passes in that
run: the daemon is up, healthy and answering with every agent on the host
destroyed. That is why this needed a harness and not a curl, and why it hid
behind a "healthy on :4318" line for the whole of DRY-19 to DRY-87.

