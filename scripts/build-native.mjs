// Compiles node-pty's native addon with REAL node-gyp under Node.
//
// Why this exists: node-pty ships no prebuilt for this toolchain, so it must be
// compiled. Bun's own install-time build (and `bun x node-gyp`) compiles the
// addon against Bun instead of Node, producing a binary that crashes at load
// (uv_version_string / oven-sh/bun#18546) — under *both* runtimes. A binary
// built by node-gyp running under Node, however, loads fine under Bun AND Node.
//
// Bun runs an explicit `node` command in a script with the real Node binary, so
// wiring this as `"postinstall": "node scripts/build-native.mjs"` builds the
// addon correctly even though Bun drives the install.
//
// WHY THIS IS STILL `.mjs` (DRY-80). Every other script in this directory is
// TypeScript; this one can't be, and the reason is the moment it runs rather
// than anything about what it does. It is the postinstall, so it executes while
// the dependency tree is still being assembled — and the TypeScript loader it
// would need is a *daemon workspace* dependency: there is no
// `node_modules/.bin/tsx` at the repo root, so `node --import tsx` from here
// fails outright (verified, not assumed). Nor can it be handed to `bun`: Bun
// compiling node-pty is the exact failure this file exists to route around.
// A postinstall that breaks a fresh clone is a worse outcome than a file that
// doesn't match the house style, so it stays JavaScript on plain Node.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

const ptyDir = path.resolve("daemon/node_modules/node-pty");

if (!existsSync(ptyDir)) {
  console.log("[build-native] node-pty not installed yet, skipping");
  process.exit(0);
}
if (process.versions.bun) {
  // Should never happen (Bun honors explicit `node`), but fail loud if it does:
  // a Bun-built addon is broken.
  console.error("[build-native] refusing to build under Bun — run with Node");
  process.exit(1);
}

console.log("[build-native] compiling node-pty with node-gyp (Node " + process.version + ")");
execFileSync("npx", ["--yes", "node-gyp", "rebuild"], {
  cwd: ptyDir,
  stdio: "inherit",
});
console.log("[build-native] node-pty built");
