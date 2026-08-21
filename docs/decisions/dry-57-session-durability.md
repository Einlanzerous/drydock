# Verifying session durability (DRY-57)

The whole feature is a negative claim — "killing this does not kill that" — so
every test is: break something, then prove an agent didn't notice.

```sh
# short path: these are unix sockets, and the ABSOLUTE path must fit in ~100 bytes
DRYDOCK_PORT=4391 DRYDOCK_SESSIONS_DIR=/tmp/d57 node --import tsx src/index.ts
```

`kill -9` the daemon (not SIGTERM — SIGKILL is the case with no cleanup path),
then restart and watch for `session adopted after a daemon restart`. The
supervisor's `sid == pid` (`ps -o sid,pid`) is the proof it detached.

The traps, all found the hard way:

1. **A socket file outlives the process that bound it.** `fs.exists` cannot tell
   a live supervisor from a corpse; the only honest probe is to connect and
   treat ECONNREFUSED/ENOENT as stale. Getting this wrong either abandons a
   running agent or unlinks the one handle anything has on it.
2. **A liveness probe must cost nothing.** The supervisor stays silent until the
   client sends `Attach`; before that it greeted every connection, so each probe
   serialized the whole scrollback to a socket about to be dropped — paid twice
   per session on every boot, and logged as EPIPE.
3. **Reconcile BEFORE binding the port.** Otherwise the first `/api/sessions`
   of a restart honestly reports zero sessions, the shell reconciles away the
   windows for agents that are alive, and every retrying hook gets a 404.
4. **A replay is the WHOLE buffer**, so the pane must `term.reset()` before
   writing one or a reconnect prints the session's history twice. Assert on the
   count of a marker, not its presence.
5. **`--retry-connrefused` does not cover a held gate.** That connection is
   established, so a killed daemon RESETS it (curl exit 56), which plain
   `--retry` ignores. `--retry-all-errors` does cover it and also retries the
   `-m 590` timeout — which an autonomous gate is *supposed* to outlive, so it
   would raise a second gate for one tool call. Hence the hand-rolled loop over
   7|52|55|56 in hooks.ts. Test it with a server that accepts, holds, then
   closes with SO_LINGER 0.
6. **Buffer the hook body before retrying.** `--data-binary @-` reads stdin, and
   stdin is a pipe that can only be consumed once.
7. **A signalled child reports exitCode 0** with the signal alongside, so
   passing the raw code on tells the daemon a killed run finished cleanly — and
   for an autonomous run that is the difference between silence and a handoff.
8. **`pkill -f supervisor/main` kills your own shell**, because the command
   string contains the pattern. Filter on `/proc/<pid>/exe`.
9. **A killed session whose child ignores the signal is the resurrection case.**
   `/kill` drops it from the registry immediately and depends on the child
   dying for the index to be cleaned; a child that traps SIGHUP breaks that
   chain, and the next boot would adopt it back. `meta.killedAt` is written
   BEFORE the signal so reconciliation finishes the job, and the supervisor
   escalates to SIGKILL after a grace period so "kill" can't leave an
   unreachable orphan. Reproduce with
   `{"command":"/bin/sh","args":["-c","trap \"\" HUP TERM INT; while :; do sleep 1; done"]}`.
10. **A close with no preceding `error` is a different path from a reset.** A
   `destroy()`ed peer EPIPEs the outgoing write first, and that error disposes
   the link before `close` fires — so a test built on `destroy()` passes even
   against a link that mishandles `close`. Use a clean `end()` to exercise it.

## Resource cost, so nobody discovers it from `top`

One Node process per session (with the tsx loader) replaces N PTYs in a single
process — tens of MB RSS each — and scrollback is now double-buffered, once in
the supervisor's ring and once in the daemon's, each capped by
`DRYDOCK_SCROLLBACK_BYTES` (~1 MiB default). Both are the right trade for
sessions that survive a restart, but a host running twenty agents is running
twenty extra Node processes.

The reconciliation branch that is easy to forget: a run that ENDS while the
daemon is down. Kill the daemon, then `kill -9` the agent, then restart — the
supervisor flushed its transcript and exit record on the way out, so boot must
write DRY-49's handoff from them and then clean up. `meta.handoff` being set is
what stops the next boot writing a second one; the invariant is that an exit
record still on disk at boot means, and only means, that nobody was home.

