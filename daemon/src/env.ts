// Minimal .env loader (DRY-10). Imported first in index.ts, before config.ts
// reads process.env. Walks up from the daemon's cwd to the repo root looking for
// a `.env`, and applies only the keys NOT already set — so a real environment
// variable always wins over the file. Flat KEY=VALUE lines (optionally quoted);
// no dependency, which is all a PoC host config needs. Keep secrets here, not in
// the repo — `.env` is gitignored; `.env.example` documents the shape.
import * as fs from "node:fs";
import * as path from "node:path";

function findEnvFile(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const file = findEnvFile();
if (file) {
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  console.log(`[drydock] loaded env from ${file}`);
}
