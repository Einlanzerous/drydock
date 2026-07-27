#!/usr/bin/env node
// One command to bring Drydock up (DRY-28).
//
//   bun run up              daemon (:4317) + shell (:5320)
//   bun run up --local      same, but the daemon binds 127.0.0.1 only
//   bun run up --db         also start the local Postgres container
//   bun run up --no-db      never start it, whatever .env says
//
// Whether the database comes up is a declaration in `.env` (DRYDOCK_DB_LOCAL=1),
// not a separate command to remember — the point of this script is that there
// is exactly one way to start the thing regardless of how much of it you're
// running today.
//
// It runs on Node, not Bun, for the same reason the daemon does (see
// daemon/package.json): it ends up as the parent of a process tree containing
// node-pty. It deliberately does NOT reimplement how each half starts — it
// hands off to `bun run --filter '*' dev`, so the daemon's "must be real node"
// invocation stays defined in one place.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = path.join(ROOT, "deploy", "compose.db.yml");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

/**
 * Load `.env` the same way the daemon does (daemon/src/env.ts): flat KEY=VALUE,
 * real environment wins. Duplicated rather than imported because that module is
 * TypeScript the daemon runs through tsx, and this launcher must work before
 * any of that is involved. ~15 lines is a cheaper dependency than a build step.
 */
function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  console.log(`[up] loaded env from ${file}`);
}

function composeCmd() {
  const probe = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (probe.status === 0) return ["docker", ["compose"]];
  const legacy = spawnSync("docker-compose", ["version"], { stdio: "ignore" });
  if (legacy.status === 0) return ["docker-compose", []];
  return null;
}

/**
 * Start the local Postgres and block until it reports healthy.
 *
 * Waiting is not politeness: the daemon's store connects lazily and retries, so
 * a race here would "only" cost a degraded first request — but that surfaces as
 * a connection error in the log at startup, which is indistinguishable from a
 * genuinely wrong DRYDOCK_DATABASE_URL. Better to be slow and unambiguous.
 */
function startDb() {
  const compose = composeCmd();
  if (!compose) {
    console.error(
      "[up] DRYDOCK_DB_LOCAL is set but no `docker compose` found.\n" +
        "     Install Docker, or unset it to use the file store, or point\n" +
        "     DRYDOCK_DATABASE_URL at a Postgres that already exists.",
    );
    process.exit(1);
  }
  const [bin, base] = compose;
  // --project-directory is not cosmetic: Compose takes the project directory
  // from the first -f file, so without it the project root is deploy/ and the
  // repo-root .env is never read — DRYDOCK_DB_PASSWORD and DRYDOCK_DB_PORT
  // would silently take their compose defaults while the daemon honoured the
  // real values, producing a container it cannot authenticate against.
  const composeArgs = [...base, "--project-directory", ROOT, "-f", COMPOSE_FILE, "up", "-d"];
  console.log(`[up] starting local postgres (${bin} ${composeArgs.join(" ")})`);
  const up = spawnSync(bin, composeArgs, { stdio: "inherit", cwd: ROOT, env: process.env });
  if (up.status !== 0) process.exit(up.status ?? 1);

  const deadline = Date.now() + 60_000;
  process.stdout.write("[up] waiting for postgres to accept connections");
  for (;;) {
    const health = spawnSync(
      "docker",
      ["inspect", "--format", "{{.State.Health.Status}}", "drydock-db"],
      { encoding: "utf8" },
    );
    const status = (health.stdout ?? "").trim();
    if (status === "healthy") {
      process.stdout.write(" ok\n");
      return;
    }
    if (Date.now() > deadline) {
      process.stdout.write("\n");
      console.error(
        `[up] postgres did not become healthy in 60s (last status: ${status || "unknown"}).\n` +
          `     Check: docker logs drydock-db`,
      );
      process.exit(1);
    }
    process.stdout.write(".");
    // Synchronous sleep — this script has nothing else to do, and a busy-wait
    // with an async timer would just add a layer to read through.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

loadEnv();

// --local narrows the daemon's bind address. The daemon defaults to 0.0.0.0 so
// it's reachable over Tailscale/LAN, and it has NO authentication (config.ts) —
// on an untrusted network, or a work laptop, this flag is the difference
// between "my shells" and "anyone's shells".
if (has("--local")) process.env.DRYDOCK_HOST = "127.0.0.1";

const wantDb = has("--db") || (process.env.DRYDOCK_DB_LOCAL === "1" && !has("--no-db"));
if (wantDb) {
  startDb();
  // Only fill this in if the operator hasn't. Someone who set both a local
  // container and an explicit URL means the URL — it's how you point at the
  // container from a different host, or at a central database while still
  // keeping the local one running.
  if (!process.env.DRYDOCK_DATABASE_URL) {
    // encodeURIComponent because this is a URL, not a string template: a
    // password containing @ : / ? # — all of them ordinary in a generated
    // password — otherwise produces a URL that parses to the wrong host, or
    // doesn't parse at all.
    const pw = encodeURIComponent(process.env.DRYDOCK_DB_PASSWORD ?? "drydock");
    const port = process.env.DRYDOCK_DB_PORT ?? "5433";
    process.env.DRYDOCK_DATABASE_URL = `postgres://drydock:${pw}@127.0.0.1:${port}/drydock`;
  }
} else if (!process.env.DRYDOCK_DATABASE_URL) {
  console.log("[up] no database configured — workspace state goes to a JSON file");
}

const child = spawn("bun", ["run", "--filter", "*", "dev"], {
  stdio: "inherit",
  cwd: ROOT,
  env: process.env,
});

// Same rule this repo keeps relearning (DRY-45, and the store's pool): an
// 'error' event with no listener THROWS. spawn() emits it when the binary
// isn't there, so without this a machine missing `bun` on PATH got a stack
// trace out of the launcher instead of the one sentence that fixes it.
child.on("error", (err) => {
  console.error(`[up] could not start \`bun\`: ${err.message}`);
  console.error("     Install Bun (https://bun.sh), or run the halves directly:");
  console.error("       bun run daemon   /   bun run shell");
  process.exit(1);
});

// Hand signals down rather than dying first: this process is the parent of the
// daemon, which owns live PTYs. Exiting out from under it would orphan that
// tree instead of letting the daemon log what it's about to destroy (DRY-45).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  // The database is deliberately left running: it holds a volume, takes seconds
  // to start, and the next `bun run up` wants it. Stop it explicitly.
  if (wantDb) console.log("[up] postgres is still running — `bun run db:down` to stop it");
  process.exit(signal ? 1 : (code ?? 0));
});
