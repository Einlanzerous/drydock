// Who is asking (DRY-27).
//
// The daemon's whole job is spawning arbitrary commands on the host, so
// `POST /api/sessions` with a `command` is remote code execution by design.
// That is acceptable on a loopback port and unacceptable on anything else,
// which is why this exists and why DRY-70 is blocked on it: TLS encrypts the
// channel, it does not decide who may open one.
//
// THE POSTURE THIS MODULE KEEPS, which is the same one DRY-28 and DRY-45 keep
// one layer down: identity may never cost a PTY. A token proves itself by its
// own signature, so a database that is down cannot log anybody out, cannot
// strand an open gate, and cannot stop the rail reaching the run it is
// watching. The only thing an outage costs is a NEW login, and it says so.
import { CONFIG } from "../config.js";
import { log } from "../log.js";
import type { StateStore, UserRecord } from "../state/types.js";
import { hashPassword, isHash, verifyPassword, verifyPlaintext } from "./password.js";
import { bearerFrom, mintToken, verifyToken, type Audience, type Identity } from "./tokens.js";

/** Life of a stream credential — see Audience in tokens.ts for why it's short. */
const STREAM_TTL_MS = 60_000;

/**
 * How long an identity is reused before the users table is consulted again
 * (multi-user only).
 *
 * The trade this number is: how stale a revocation may be, against how many
 * round trips a busy desk pays. The shell polls sessions every 3s and the
 * tracker every 20s per tab, so an uncached lookup would put a query on a
 * cadence measured in seconds per browser, forever. Ten seconds bounds the
 * staleness to about one poll — and a deletion is still immediate for every
 * request that isn't already inside the window.
 */
const IDENTITY_CACHE_MS = 10_000;

/** Login names, deliberately narrow: this becomes a directory-ish key elsewhere. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * Minimum password length, and nothing else.
 *
 * No character-class rules: they are known not to work, and here they would be
 * actively silly — the realistic deployment is one person on a Tailscale
 * network protecting a daemon from the internet, not a public signup form.
 */
const MIN_PASSWORD = 8;

export type AuthFailure =
  /** No credential presented at all. */
  | "anonymous"
  /** A credential was presented and it isn't good. */
  | "invalid"
  /** We could not find out — the users table is unreachable. NOT a 401. */
  | "unavailable";

export type AuthResult = { ok: true; identity: Identity } | { ok: false; reason: AuthFailure };

export interface LoginOutcome {
  ok: boolean;
  token?: string;
  identity?: Identity;
  /** Set when !ok — already human-readable, it goes into the response body. */
  error?: string;
  /** Distinguishes "wrong password" (401) from "no database" (503). */
  status?: number;
}

/** What an unauthenticated client is told, so the shell knows what to draw. */
export interface AuthInfo {
  mode: typeof CONFIG.auth.mode;
  /** True when more than one account is possible — the Users panel's gate. */
  multiUser: boolean;
  /**
   * The daemon has multi-user on but no account exists and none can be seeded.
   * The shell renders the instruction rather than a login box nothing can
   * satisfy — a password prompt on a daemon with no accounts is a puzzle with
   * no answer, and it looks identical to a forgotten password.
   */
  needsSetup?: boolean;
}

export class Auth {
  /** Cached user records for multi-user identity checks. See IDENTITY_CACHE_MS. */
  private readonly cache = new Map<string, { user: UserRecord; at: number }>();
  /** Single-flight latch for the bootstrap — two logins must not both seed. */
  private seeding: Promise<UserRecord | null> | null = null;

  constructor(private readonly store: StateStore) {}

  get mode(): typeof CONFIG.auth.mode {
    return CONFIG.auth.mode;
  }

  get enabled(): boolean {
    return CONFIG.auth.enabled;
  }

  /**
   * The identity every request has when nothing is authenticated.
   *
   * `CONFIG.state.owner`, NOT the login name, and that is what stops an upgrade
   * losing your desk: the workspace and history rows written before DRY-27 are
   * owned by that constant, and in `off` and `single` they still are.
   */
  private get localIdentity(): Identity {
    return { id: CONFIG.state.owner, name: CONFIG.auth.user };
  }

  async info(): Promise<AuthInfo> {
    const info: AuthInfo = { mode: this.mode, multiUser: this.mode === "multi" };
    if (this.mode === "multi" && !this.seedCredential()) {
      // Only asked on the tier that can answer, and failure is not a setup
      // problem — a database that is down must not present as "this Drydock
      // has no accounts", which would invite somebody to go looking for a
      // bootstrap that already happened.
      const count = await this.store.users?.count().catch(() => null);
      if (count === 0) info.needsSetup = true;
    }
    return info;
  }

  /** The credential host config seeds an account from, if any. */
  private seedCredential(): { hash?: string; plaintext?: string } | null {
    if (CONFIG.auth.passwordHash) return { hash: CONFIG.auth.passwordHash };
    if (CONFIG.auth.password) return { plaintext: CONFIG.auth.password };
    return null;
  }

  /**
   * Create the seeded account, once, and hand it everything the pre-accounts
   * owner id held.
   *
   * Idempotent in two directions, because both races are real: the latch stops
   * two concurrent logins seeding twice in one process, and the unique index on
   * `lower(name)` stops two DAEMONS pointed at one database doing it — which is
   * the setup CLAUDE.md actively recommends for verification. A lost race
   * re-reads rather than failing, so the second daemon logs the same person in.
   */
  private bootstrap(): Promise<UserRecord | null> {
    if (this.seeding) return this.seeding;
    const attempt = this.seedOwner().catch((err) => {
      // Cleared so a database that comes back later can still be bootstrapped
      // without a daemon restart — a restart is cheap for sessions now (DRY-57)
      // but there is no reason to need one to log in for the first time.
      this.seeding = null;
      throw err;
    });
    this.seeding = attempt;
    return attempt;
  }

  private async seedOwner(): Promise<UserRecord | null> {
    const users = this.store.users;
    const seed = this.seedCredential();
    if (!users || !seed) return null;
    const existing = await users.byName(CONFIG.auth.user);
    if (existing) return existing;
    if ((await users.count()) > 0) return null; // somebody else's instance, already set up
    const passwordHash = seed.hash ?? (await hashPassword(seed.plaintext!));
    let created: UserRecord;
    try {
      created = await users.create({ name: CONFIG.auth.user, passwordHash });
    } catch (err) {
      // 23505: the other daemon won. Re-read rather than fail — the account we
      // were about to create is the one that now exists.
      const again = await users.byName(CONFIG.auth.user);
      if (again) return again;
      throw err;
    }
    const adopted = await users
      .adoptOwner(CONFIG.state.owner, created.id)
      .catch((err) => {
        // Non-fatal: the account is real and usable, it just starts with an
        // empty desk. Loud, because "where did my workspace go" is exactly the
        // question this call exists to prevent and the answer is recoverable
        // (one UPDATE) only if somebody knows to ask it.
        log.warn("could not hand the pre-accounts desk to the first account", {
          from: CONFIG.state.owner,
          to: created.id,
          err: String(err),
        });
        return 0;
      });
    log.info("seeded the owner account from host config", {
      user: created.name,
      id: created.id,
      adoptedRows: adopted,
    });
    return created;
  }

  /**
   * Exchange a name and password for a token.
   *
   * The failure message is the same for an unknown name and a wrong password,
   * which matters more here than on a public form: this daemon's account list
   * is one person and their colleagues, so "no such user" would confirm a
   * name to anyone who can reach the port.
   */
  async login(name: unknown, password: unknown): Promise<LoginOutcome> {
    if (!this.enabled) {
      return { ok: false, status: 400, error: "this Drydock has no accounts — auth is off" };
    }
    if (typeof password !== "string" || !password) {
      return { ok: false, status: 400, error: "password is required" };
    }
    const given = typeof name === "string" ? name.trim() : "";
    const wrong: LoginOutcome = { ok: false, status: 401, error: "wrong name or password" };

    if (this.mode === "single") {
      const seed = this.seedCredential();
      if (!seed) return wrong;
      // An OMITTED name means the configured account, because on this tier
      // there is only one and the login form doesn't ask for it — the name is
      // host config, so demanding it would be a quiz about somebody's `.env`.
      // Note `||` rather than `??`: the browser sends an empty string for a
      // field it never showed, and `??` passes that straight through to a
      // comparison that can only fail. (It did, once.)
      const nameOk = (given || CONFIG.auth.user).toLowerCase() === CONFIG.auth.user.toLowerCase();
      const passwordOk = seed.hash
        ? await verifyPassword(password, seed.hash)
        : verifyPlaintext(password, seed.plaintext!);
      // Both halves are evaluated before the decision, so a wrong NAME costs
      // the same scrypt as a wrong password. Short-circuiting on the name
      // makes the response time say which of the two was wrong.
      if (!nameOk || !passwordOk) return wrong;
      const identity = this.localIdentity;
      return {
        ok: true,
        identity,
        token: mintToken({ id: identity.id, name: identity.name }, "api", CONFIG.auth.sessionTtlMs),
      };
    }

    const users = this.store.users;
    if (!users) {
      // Unreachable in practice — config refuses to boot multi-user without a
      // database — but the port is optional in the type, and a login route that
      // dereferences undefined would answer 500 to a configuration problem.
      return { ok: false, status: 503, error: "this Drydock cannot keep accounts" };
    }
    // No defaulting here, unlike the single-account branch above: with several
    // accounts, "whoever the host configured" is not a sensible reading of a
    // blank field — it is a guess at which of them you meant.
    if (!given) return { ok: false, status: 400, error: "name is required" };
    try {
      await this.bootstrap();
      const user = await users.byName(given);
      if (!user || !(await verifyPassword(password, user.passwordHash))) return wrong;
      this.remember(user);
      return {
        ok: true,
        identity: { id: user.id, name: user.name, epoch: user.tokenEpoch },
        token: mintToken(user, "api", CONFIG.auth.sessionTtlMs),
      };
    } catch (err) {
      // A database outage is not a failed login, and saying so is the whole
      // difference between "check your password" and "wait a minute".
      log.warn("could not check a login — the accounts store is unreachable", {
        err: String(err),
      });
      return { ok: false, status: 503, error: `accounts unavailable: ${String(err)}` };
    }
  }

  /** A short-lived credential for the two transports that can't carry a header. */
  streamToken(identity: Identity): string {
    return mintToken(
      { id: identity.id, name: identity.name, tokenEpoch: identity.epoch },
      "stream",
      STREAM_TTL_MS,
    );
  }

  /**
   * Who is making this request.
   *
   * The audience follows the credential's ROUTE OF ARRIVAL rather than being
   * chosen per endpoint, which is what makes the split safe to rely on: a
   * header is an `api` token, a URL parameter is a `stream` token, and the only
   * two routes that pass `streamToken` are the two transports that cannot carry
   * a header. Everything else literally has no way to accept the short-lived
   * credential that ends up in proxy logs — not by policy, by plumbing.
   */
  async identify(
    header: string | undefined,
    opts: { streamToken?: string } = {},
  ): Promise<AuthResult> {
    if (!this.enabled) return { ok: true, identity: this.localIdentity };
    const bearer = bearerFrom(header);
    const [raw, aud]: [string, Audience] | [undefined, undefined] = bearer
      ? [bearer, "api"]
      : opts.streamToken
        ? [opts.streamToken, "stream"]
        : [undefined, undefined];
    if (!raw) return { ok: false, reason: "anonymous" };
    const result = verifyToken(raw, aud);
    if (!result.ok) return { ok: false, reason: "invalid" };
    if (this.mode !== "multi") return { ok: true, identity: result.identity };
    return this.stillValid(result.identity);
  }

  /**
   * Confirm a multi-user token against the account it names.
   *
   * The cache is what lets this be on every request, and the fallback to a
   * STALE entry when the store is unreachable is deliberate rather than lazy:
   * the alternative is that a database blip signs out a desk full of live
   * agents. An outage is allowed to prevent a new login; it is not allowed to
   * end one that already happened.
   */
  private async stillValid(identity: Identity): Promise<AuthResult> {
    const users = this.store.users;
    if (!users) return { ok: false, reason: "unavailable" };
    const cached = this.cache.get(identity.id);
    if (cached && Date.now() - cached.at < IDENTITY_CACHE_MS) {
      return this.compare(identity, cached.user);
    }
    try {
      const user = await users.byId(identity.id);
      if (!user) {
        // A deleted account, or a token from another Drydock that happens to
        // share a signing key. Both are "this token names nobody".
        this.cache.delete(identity.id);
        return { ok: false, reason: "invalid" };
      }
      this.remember(user);
      return this.compare(identity, user);
    } catch (err) {
      if (cached) return this.compare(identity, cached.user);
      log.warn("could not confirm an identity — the accounts store is unreachable", {
        err: String(err),
      });
      return { ok: false, reason: "unavailable" };
    }
  }

  private compare(identity: Identity, user: UserRecord): AuthResult {
    // A token minted before the epoch moved was minted before a password
    // change or a deliberate sign-out-everywhere.
    if ((identity.epoch ?? 0) < user.tokenEpoch) return { ok: false, reason: "invalid" };
    // The NAME comes from the record, not the token: a rename has to show up on
    // the desk without demanding a fresh login.
    return { ok: true, identity: { id: user.id, name: user.name, epoch: user.tokenEpoch } };
  }

  private remember(user: UserRecord): void {
    this.cache.set(user.id, { user, at: Date.now() });
  }

  /** Drop a cached identity so a change to it takes effect on the next request. */
  forget(id: string): void {
    this.cache.delete(id);
  }

  // --- account management (multi-user only) ---------------------------------
  // Flat capability model (the ticket's own non-goal list): anybody logged in
  // can add or remove an account. That is honest rather than lax — every user
  // here can already spawn a process as the host user, so a permission system
  // over the account list would be guarding the shed next to the open house.

  async listUsers(): Promise<{ id: string; name: string; createdAt: number }[]> {
    const users = this.requireUsers();
    return (await users.list()).map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt }));
  }

  async createUser(name: string, password: string): Promise<{ id: string; name: string }> {
    const users = this.requireUsers();
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new BadRequest("name must be 1-32 chars of [A-Za-z0-9._-] and start alphanumeric");
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw new BadRequest(`password must be at least ${MIN_PASSWORD} characters`);
    }
    const passwordHash = await hashPassword(password);
    try {
      const created = await users.create({ name, passwordHash });
      log.info("account created", { user: created.name, id: created.id });
      return { id: created.id, name: created.name };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new BadRequest(`there is already an account named ${name}`);
      }
      throw err;
    }
  }

  async setPassword(id: string, password: string): Promise<void> {
    const users = this.requireUsers();
    if (typeof password !== "string" || password.length < MIN_PASSWORD) {
      throw new BadRequest(`password must be at least ${MIN_PASSWORD} characters`);
    }
    await users.setPassword(id, await hashPassword(password));
    this.forget(id);
    log.info("account password changed — its other sessions are signed out", { id });
  }

  async removeUser(id: string, actor: Identity): Promise<void> {
    const users = this.requireUsers();
    if (id === actor.id) {
      // Not paternalism: this is the account whose token is making the request,
      // and on a one-account instance removing it locks everybody out of a
      // daemon that is still holding live agents.
      throw new BadRequest("you cannot remove the account you are signed in as");
    }
    if ((await users.count()) <= 1) throw new BadRequest("this is the last account");
    await users.remove(id);
    this.forget(id);
    log.info("account removed", { id, by: actor.name });
  }

  private requireUsers() {
    const users = this.store.users;
    if (this.mode !== "multi" || !users) {
      throw new NotSupported(
        "this Drydock has one account — set DRYDOCK_DATABASE_URL and DRYDOCK_MULTI_USER=1",
      );
    }
    return users;
  }
}

/** 400: the request is wrong. Thrown by the account routes, caught in server.ts. */
export class BadRequest extends Error {}
/** 501: this tier can't do that at all — the file store's answer to accounts. */
export class NotSupported extends Error {}

export { hashPassword, isHash };
export type { Identity };
