// Drydock daemon entry point. Owns AI-CLI PTYs per host; the browser is a viewer.
import "./env.js"; // load .env before anything reads process.env (config, tracker)
import { CONFIG, CONFIG_ERRORS } from "./config.js";

/**
 * Refuse to start on a configuration that cannot mean what it says (DRY-27).
 *
 * Multi-user needs somewhere to keep accounts, and the only somewhere is
 * Postgres. Asked for without one, the honest options are to fail or to quietly
 * run single-user — and quietly running a WEAKER posture than the one somebody
 * configured is the failure mode a security setting must never have. Nobody
 * re-reads a log line that says "ignoring DRYDOCK_MULTI_USER".
 *
 * Checked here rather than in config.ts because this exits the process, and a
 * module every other module imports is the wrong place to do that. It is a
 * static contradiction — no network, no database — so it can be answered before
 * anything else loads. A database that is merely DOWN is a different thing
 * entirely and must not stop a boot: DRY-28's whole posture is that a dead
 * database never costs a PTY.
 */
if (CONFIG.auth.multiUser && !CONFIG.state.databaseUrl) {
  CONFIG_ERRORS.push(
    "DRYDOCK_MULTI_USER is set but DRYDOCK_DATABASE_URL is not.\n" +
      "  Accounts live in Postgres — there is no file-backed multi-user mode.\n" +
      "  Set DRYDOCK_DATABASE_URL, or unset DRYDOCK_MULTI_USER to run single-user\n" +
      "  (which still supports a password: see DRYDOCK_AUTH_PASSWORD).",
  );
}

if (CONFIG_ERRORS.length) {
  // Every one of these is a static contradiction — no network, no database — so
  // they are all answerable before anything loads. Printed together rather than
  // one per run: fixing four config errors in four restarts, on a daemon that
  // adopts live sessions each time, is four chances to give up halfway.
  process.stderr.write(
    `drydock: refusing to start — ${CONFIG_ERRORS.length} configuration ` +
      `problem${CONFIG_ERRORS.length > 1 ? "s" : ""}:\n` +
      CONFIG_ERRORS.map((e) => `  • ${e}`).join("\n") +
      "\n",
  );
  process.exit(1);
}

// Dynamic, and it has to be: static imports are hoisted above the check above,
// so the daemon would bind its port and adopt every live session before
// deciding it shouldn't have started.
await import("./server.js");
