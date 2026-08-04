// Password hashing for DRY-27.
//
// scrypt from node:crypto, not bcrypt/argon2 from npm. The daemon's dependency
// list is deliberately short and every native module in it has to be compiled by
// Node's own node-gyp (see CLAUDE.md on node-pty) — adding a second one to check
// a password that is typed a handful of times a day would be a real cost for no
// security gain. scrypt is memory-hard, in the standard library, and needs no
// build step.
import * as crypto from "node:crypto";

/**
 * scrypt cost parameters, stored in the hash string rather than assumed at
 * verify time. They are written down so raising them later doesn't invalidate
 * every password already on record: an old hash carries the parameters it was
 * made with and keeps verifying.
 *
 * N=16384 costs ~16 MiB and ~50ms on this class of hardware, which is the usual
 * interactive-login compromise. Node's default `maxmem` is 32 MiB, so raising N
 * past this needs `maxmem` raised with it or scrypt throws — the failure is at
 * hash time and loud, but worth knowing before reaching for a bigger number.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Marks a string as one of ours; also the field separator. */
const SCHEME = "scrypt";

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      KEY_LEN,
      { N: params.N, r: params.r, p: params.p },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>` — self-describing, one line, env-safe. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, { N, r: R, p: P });
  return [SCHEME, N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Does `password` match `stored`?
 *
 * Never throws on a malformed `stored` — a hash somebody hand-edited into the
 * env, or a column written by something else, has to read as "wrong password"
 * rather than as a 500. A stack trace on the login route is a way to distinguish
 * a real account from a missing one without knowing either credential.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) {
    return false;
  }
  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
    if (expected.byteLength === 0) return false;
    const actual = await scrypt(password, Buffer.from(saltB64, "base64"), params);
    // Length check first: timingSafeEqual THROWS on a length mismatch rather
    // than returning false, and an exception escaping here would be the same
    // information leak the doc comment above is about.
    if (actual.byteLength !== expected.byteLength) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Compare against a password held in host config as PLAINTEXT
 * (DRYDOCK_AUTH_PASSWORD), which is the low-ceremony way to turn auth on.
 *
 * Constant-time over SHA-256 digests rather than a `===` on the strings. The
 * digests are equal-length whatever the inputs are, which is what lets
 * timingSafeEqual be used at all here — and it means the comparison doesn't leak
 * the password's length, which a short-circuiting `===` does.
 */
export function verifyPlaintext(password: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(password, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** True when a string looks like one of ours, so config can tell the two apart. */
export function isHash(value: string): boolean {
  return value.startsWith(`${SCHEME}$`);
}
