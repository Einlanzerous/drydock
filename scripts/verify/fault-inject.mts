// Make a daemon under test take a REAL fault, on demand (DRY-48).
//
// Preloaded into the daemon rather than reached through a route, and that is
// the whole point of the file: the product must not grow a "crash yourself"
// endpoint. This port already runs arbitrary commands as the host user by
// design, so an endpoint wouldn't widen what an attacker can DO — but it would
// put a control whose only purpose is to break the daemon on the same
// unauthenticated surface every real deploy serves, and there is no version of
// that which is worth a harness's convenience. A signal needs process access,
// which is a permission the operating system already models.
//
// It is also a more honest fault than a route could raise. The throw happens in
// a timer callback with no `try` above it — the exact shape of the bug this
// whole area exists for — rather than inside an HTTP handler, where server.ts's
// own catch-all would turn it into a 500 and no `uncaughtException` would fire
// at all.
//
//   node --import tsx --import ../scripts/verify/fault-inject.mts src/index.ts
//
// then, per fault: write `exception` or `rejection` into $DRYDOCK_FAULT_FILE
// and `kill -USR2 <daemon pid>`. Both spellings matter — an uncaught exception
// and an unhandled rejection are counted separately by /healthz and only the
// first one is routed through DRYDOCK_EXIT_ON_UNCAUGHT.
//
// SIGUSR2 because SIGUSR1 is Node's own debugger-attach signal, and because a
// daemon with no listener for it dies on receipt — so a rig that forgets the
// preload fails loudly instead of quietly proving nothing.
import * as fs from "node:fs";

const file = process.env.DRYDOCK_FAULT_FILE ?? "";

process.on("SIGUSR2", () => {
  let kind = "exception";
  try {
    kind = fs.readFileSync(file, "utf8").trim() || "exception";
  } catch {
    /* no file written yet — an uncaught exception is the useful default */
  }
  if (kind === "rejection") {
    // No `await`, no `.catch`: this is what an unhandled rejection IS.
    void Promise.reject(new Error("injected unhandled rejection (DRY-48 harness)"));
    return;
  }
  // Out of the signal handler and into a plain timer callback, so nothing in
  // the daemon is on the stack when it throws.
  setTimeout(() => {
    throw new Error("injected uncaught exception (DRY-48 harness)");
  }, 0);
});

// Said on stdout rather than through the daemon's logger, which isn't loaded
// yet: a harness reading the daemon's output can wait for this line and know
// the preload took, instead of discovering it didn't when a signal kills it.
process.stdout.write(`[fault-inject] armed on SIGUSR2, reading ${file || "(no file — exceptions only)"}\n`);
