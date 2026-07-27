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
import * as crypto from "node:crypto";
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

/** Append `KEY=value` to the root `.env`, creating the file if it isn't there. */
function appendEnv(key, value) {
  const file = path.join(ROOT, ".env");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const sep = !existing || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${sep}${key}=${value}\n`, { mode: 0o600 });
  process.env[key] = value;
}

/**
 * Make sure the local database has a password, generating one on first use.
 *
 * Nothing in this repo ships a default. A committed fallback would mean every
 * Drydock install on earth shares one password on a port that anything else on
 * the host can reach — "it's only window positions" and "it's only bound to
 * loopback" are both true and neither is a reason to hand out the same
 * credential to everyone. It also, correctly, trips secret scanners.
 *
 * The generated value lands in the gitignored `.env` alongside a
 * DRYDOCK_DATABASE_URL, so every way of starting the daemon agrees about where
 * state lives — `bun run up`, `bun run daemon`, and a manually launched
 * verification instance included.
 */
function ensureDbCredentials() {
  const port = process.env.DRYDOCK_DB_PORT ?? "5433";
  let generated = false;
  if (!process.env.DRYDOCK_DB_PASSWORD) {
    // base64url so the value needs no escaping in a URL, a .env line, or YAML.
    appendEnv("DRYDOCK_DB_PASSWORD", crypto.randomBytes(24).toString("base64url"));
    generated = true;
    console.log("[up] generated a database password into .env");
  }
  if (!process.env.DRYDOCK_DATABASE_URL) {
    // encodeURIComponent even though generated values are URL-safe: this also
    // runs over a password a human chose, where @ : / # are ordinary.
    const pw = encodeURIComponent(process.env.DRYDOCK_DB_PASSWORD);
    appendEnv("DRYDOCK_DATABASE_URL", `postgres://drydock:${pw}@127.0.0.1:${port}/drydock`);
    console.log("[up] wrote DRYDOCK_DATABASE_URL into .env");
  }
  // Postgres only reads POSTGRES_PASSWORD at initdb, so an existing volume
  // keeps whatever it was created with — a freshly generated password would
  // then fail to authenticate against it, which reads as a config error.
  if (generated && volumeExists()) {
    console.warn(
      "[up] NOTE: an existing drydock database volume was found. It keeps the\n" +
        "     password it was created with, so the new one may not authenticate.\n" +
        "     Reset it with: bun run db:down -- -v   (destroys saved workspaces)",
    );
  }
}

function volumeExists() {
  // Project name is pinned to `drydock` in the compose file, so the volume is
  // predictable rather than derived from whatever directory this checkout is in.
  const out = spawnSync("docker", ["volume", "inspect", "drydock_drydock_pgdata"], {
    stdio: "ignore",
  });
  return out.status === 0;
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
function compose(...argv) {
  const cmd = composeCmd();
  if (!cmd) {
    console.error(
      "[up] no `docker compose` found.\n" +
        "     Install Docker, unset DRYDOCK_DB_LOCAL to use the file store, or\n" +
        "     point DRYDOCK_DATABASE_URL at a Postgres that already exists.",
    );
    process.exit(1);
  }
  const [bin, base] = cmd;
  // --project-directory is not cosmetic: Compose takes the project directory
  // from the first -f file, so without it the project root is deploy/ and the
  // repo-root .env is never read — DRYDOCK_DB_PASSWORD and DRYDOCK_DB_PORT
  // would silently take their compose defaults while the daemon honoured the
  // real values, producing a container it cannot authenticate against.
  const args = [...base, "--project-directory", ROOT, "-f", COMPOSE_FILE, ...argv];
  return spawnSync(bin, args, { stdio: "inherit", cwd: ROOT, env: process.env });
}

function startDb() {
  ensureDbCredentials();
  console.log("[up] starting local postgres");
  const up = compose("up", "-d");
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

// `bun run db:up` / `db:down` route through here rather than calling docker
// compose directly, so the project directory, the pinned project name and the
// credential bootstrap are defined once. Extra argv is passed through, which is
// what makes `bun run db:down -- -v` (drop the volume) work.
const passthrough = args.filter((a) => a !== "--db-only" && a !== "--db-down");
if (has("--db-only")) {
  startDb();
  process.exit(0);
}
if (has("--db-down")) {
  process.exit(compose("down", ...passthrough).status ?? 0);
}

// --local narrows the daemon's bind address. The daemon defaults to 0.0.0.0 so
// it's reachable over Tailscale/LAN, and it has NO authentication (config.ts) —
// on an untrusted network, or a work laptop, this flag is the difference
// between "my shells" and "anyone's shells".
if (has("--local")) process.env.DRYDOCK_HOST = "127.0.0.1";

const wantDb = has("--db") || (process.env.DRYDOCK_DB_LOCAL === "1" && !has("--no-db"));
if (wantDb) {
  // startDb() writes DRYDOCK_DATABASE_URL into .env if it isn't set, so the
  // daemon picks it up on its own — including when started some other way.
  startDb();
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
