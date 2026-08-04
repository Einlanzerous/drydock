// Signed session tokens for DRY-27.
//
// STATELESS ON PURPOSE, and the reason is the same one that shapes the rest of
// this daemon: a token the daemon has to look up is a token a database outage
// can invalidate. DRY-28's non-negotiable property is "a dead database never
// costs a PTY" — and an auth table consulted per request would turn a partition
// into every browser being logged out, every open gate unanswerable, and the
// rail unable to reach the run it is watching. So a token proves itself by its
// own signature and nothing is read to check it.
//
// What that costs is instant revocation, which is bought back partially with
// `e` (the user's token epoch) below — a number that is read through a cache and
// therefore degrades to last-known-good rather than to "logged out".
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG } from "../config.js";
import { log } from "../log.js";
import { expandHome } from "../repos.js";

/**
 * Format marker. Bumped only if the payload's MEANING changes — an old token
 * with a new meaning is exactly the failure a version prefix exists to stop, and
 * unlike PROTOCOL_VERSION (which strands live agents, see CLAUDE.md) bumping
 * this costs one login.
 */
const VERSION = "dd1";

/**
 * What a token is FOR.
 *
 * `api` is the ordinary bearer: it spawns sessions, answers gates, writes the
 * desk. `stream` exists because two of the shell's transports cannot carry a
 * header at all — `EventSource` has no way to set one, and a browser
 * `WebSocket` has no way either — so those two carry their credential in the
 * URL, which is the one place a credential is routinely copied somewhere it
 * outlives the request: a proxy access log, a screenshot of a devtools panel.
 *
 * Hence a separate audience with a 60s life. A leaked `stream` token buys a
 * minute of one connection; it cannot spawn a command. The `api` token never
 * appears in a URL.
 */
export type Audience = "api" | "stream";

/** Claims. Short keys because this rides in a URL for the stream audience. */
interface Claims {
  /** User id — the value that becomes `owner_id` on a workspace or a session. */
  u: string;
  /** Display name at mint time, so the shell can render it without a round trip. */
  n: string;
  /** Expiry, epoch ms. */
  exp: number;
  aud: Audience;
  /**
   * The user's token epoch when this was minted (multi-user only).
   *
   * Revocation without a session table: bumping the column invalidates every
   * token issued before the bump. Deleting a user and changing a password both
   * do it. Read through a cache on the way in, so a database that is down
   * degrades to the last known epoch rather than to a locked-out desk.
   */
  e?: number;
}

export interface Identity {
  id: string;
  name: string;
  /** Epoch this token was minted against; the caller compares it to the user's. */
  epoch?: number;
}

/**
 * The signing key, resolved once.
 *
 * Persisted rather than generated per boot, and that is not a convenience: a
 * restart is ROUTINE here. `bun run daemon` runs under `node --watch`, so every
 * save under daemon/src/ restarts the process, and DRY-57 made that survivable
 * for the agents on purpose. A key that changed with it would sign everybody out
 * on every save — and in prod, on every deploy and every crash-restart of a unit
 * that is Restart=always.
 */
let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = CONFIG.auth.secret;
  if (configured) {
    // Hashed rather than used raw so any length of passphrase is a 32-byte key.
    cachedKey = crypto.createHash("sha256").update(configured, "utf8").digest();
    return cachedKey;
  }
  const file = expandHome(CONFIG.auth.keyFile);
  try {
    const existing = fs.readFileSync(file);
    if (existing.byteLength >= 32) {
      cachedKey = existing.subarray(0, 32);
      return cachedKey;
    }
    log.warn("auth key file is too short — regenerating", { file });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("could not read the auth key file — using an in-memory key", {
        file,
        err: String(err),
      });
    }
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 0600 and write-then-rename: this file is the whole of the daemon's ability
    // to tell one of its own tokens from a forgery, so a half-written one must
    // never be readable as a valid key.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, key, { mode: 0o600 });
    fs.renameSync(tmp, file);
    log.info("generated an auth signing key", { file });
  } catch (err) {
    // Not fatal. The daemon works perfectly with a key that lives only in
    // memory; the cost is that a restart signs everybody out, which is a
    // nuisance rather than an outage — and it is announced rather than
    // discovered.
    log.warn("could not persist the auth signing key — a restart will sign everyone out", {
      file,
      err: String(err),
    });
  }
  cachedKey = key;
  return cachedKey;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string): string {
  return b64url(crypto.createHmac("sha256", signingKey()).update(payload).digest());
}

/**
 * Mint a token. `ttlMs` defaults to the api session length; the stream audience
 * passes its own much shorter one.
 */
export function mintToken(
  user: { id: string; name: string; tokenEpoch?: number },
  aud: Audience,
  ttlMs: number,
): string {
  const claims: Claims = {
    u: user.id,
    n: user.name,
    exp: Date.now() + ttlMs,
    aud,
    ...(user.tokenEpoch === undefined ? {} : { e: user.tokenEpoch }),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${VERSION}.${payload}.${sign(payload)}`;
}

export type TokenFailure = "malformed" | "bad-signature" | "expired" | "wrong-audience";

export type TokenResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: TokenFailure };

/**
 * Check a token and say what it proves.
 *
 * The audience is checked HERE rather than by the caller, because the whole
 * value of splitting the two is that no route can forget: a `stream` token
 * reaching `POST /api/sessions` has to be as good as no token at all, and the
 * only way to guarantee that is for the verifier to refuse it.
 */
export function verifyToken(token: string, aud: Audience): TokenResult {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, payload, signature] = parts;
  const expected = sign(payload);
  // Both are base64url of a 32-byte digest, so they are the same length unless
  // the token is malformed — which timingSafeEqual would throw on rather than
  // report, hence the guard.
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return { ok: false, reason: "bad-signature" };
  }
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Claims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims?.u !== "string" || !claims.u) return { ok: false, reason: "malformed" };
  // Expiry after the signature check, deliberately: an expired token is a fact
  // about a token we have already proved is ours, and answering "expired" to an
  // unsigned guess would confirm the guess was otherwise well-formed.
  if (!Number.isFinite(claims.exp) || claims.exp <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (claims.aud !== aud) return { ok: false, reason: "wrong-audience" };
  return {
    ok: true,
    identity: { id: claims.u, name: typeof claims.n === "string" ? claims.n : claims.u, epoch: claims.e },
  };
}

/** Bearer token out of an Authorization header, if there is one. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}
