// The browser's half of DRY-27.
//
// Holds the token, puts it on every request, and owns the one question the desk
// is gated on: may this browser be here at all? Everything reactive here is
// module-scoped rather than provided — like gateStore, and for the same reason:
// two copies of "am I signed in" is a desk that renders while a login form is
// also on screen.
import { computed, ref } from "vue";
import { DAEMON_HTTP } from "./daemonUrl.js";

/** How the daemon decides who is asking. Mirrors AuthMode in daemon/src/config.ts. */
export type AuthMode = "off" | "single" | "multi";

export interface AuthUser {
  id: string;
  name: string;
}

/**
 * Keyed by daemon, because one browser talks to several (dev :4317, prod
 * :4318, a throwaway on :4399) and a token minted by one is refused by another.
 * A single shared key would mean switching ports silently signs you out of the
 * one you came back to.
 */
const TOKEN_KEY = `drydock:token:${DAEMON_HTTP}`;

function readStored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode Safari and a locked-down profile both throw here. The desk
    // still works for this tab; it just won't be signed in tomorrow.
    return null;
  }
}

const token = ref<string | null>(readStored());
const mode = ref<AuthMode>("off");
const user = ref<AuthUser | null>(null);
const needsSetup = ref(false);
/** True once /api/auth/info has answered — the desk mustn't draw before then. */
const ready = ref(false);
/** Set when a sign-in is what's missing, so the login view can say something. */
const message = ref<string | null>(null);

export const authMode = computed(() => mode.value);
export const authUser = computed(() => user.value);
export const authNeedsSetup = computed(() => needsSetup.value);
export const authReady = computed(() => ready.value);
export const authMessage = computed(() => message.value);
/** Can this daemon have more than one account? Gates the Users panel. */
export const isMultiUser = computed(() => mode.value === "multi");
/** The desk may render. Either there is no door, or we are through it. */
export const signedIn = computed(() => mode.value === "off" || Boolean(token.value));

function store(value: string | null): void {
  token.value = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* see readStored — a tab that can't persist still works */
  }
}

/**
 * Learn what kind of daemon this is, before drawing anything.
 *
 * Unauthenticated on the daemon side, so this is also the probe that tells a
 * shell newer than its daemon what it's talking to: a daemon from before
 * DRY-27 404s here, which is indistinguishable from "no auth" and is treated as
 * exactly that — the shell degrades to the behaviour that daemon has, rather
 * than demanding a password it cannot issue.
 */
export async function loadAuthInfo(): Promise<void> {
  try {
    const res = await fetch(`${DAEMON_HTTP}/api/auth/info`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = await res.json();
      mode.value = body?.mode === "single" || body?.mode === "multi" ? body.mode : "off";
      needsSetup.value = Boolean(body?.needsSetup);
    } else {
      mode.value = "off";
    }
  } catch {
    // A daemon that can't be reached at all is the session poll's problem to
    // report (it raises the red banner). Assuming "off" here means the desk
    // renders and says so, rather than showing a login form for a daemon that
    // may not even require one.
    mode.value = "off";
  }
  if (mode.value !== "off" && token.value) await confirmToken();
  ready.value = true;
}

/** Ask the daemon who the stored token is, so the header can name them. */
async function confirmToken(): Promise<void> {
  try {
    const res = await authFetch(`${DAEMON_HTTP}/api/auth/me`);
    if (res.ok) {
      const body = await res.json();
      if (body?.user) user.value = body.user;
    }
    // A 401 has already been handled inside authFetch (token dropped). A 503 is
    // deliberately left alone: the accounts store being unreachable must not
    // sign anybody out — the token is still good and the daemon says so as soon
    // as it can reach the database again.
  } catch {
    /* offline: keep the token, let the poll report the daemon being down */
  }
}

export async function signIn(name: string, password: string): Promise<void> {
  const res = await fetch(`${DAEMON_HTTP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `daemon returned ${res.status}`);
  if (!body?.token) throw new Error("daemon returned no token");
  store(body.token);
  user.value = body.user ?? null;
  message.value = null;
  needsSetup.value = false;
}

/**
 * Drop the credential. `why` is shown on the login view — the difference
 * between choosing to leave and being put out, which is the difference between
 * a form and a form with an explanation of where your desk went.
 */
export function signOut(why?: string): void {
  store(null);
  user.value = null;
  message.value = why ?? null;
}

/** The header the daemon reads, when there is one. */
export function authHeaders(): Record<string, string> {
  return token.value ? { Authorization: `Bearer ${token.value}` } : {};
}

/**
 * Every request the shell makes to the daemon, so the 401 is handled in ONE
 * place.
 *
 * A 401 anywhere means the token is finished — expired, revoked, or minted by a
 * daemon that has since had its key rotated — and the only correct response is
 * to stop pretending: drop it and let the desk fall back to the login view. The
 * alternative is what every one of the ~15 call sites would otherwise do on its
 * own, which is surface a red banner about tickets or workspaces while the real
 * answer is "sign in again".
 *
 * A 503 is emphatically NOT that. It means the daemon could not reach the
 * accounts store — DRY-58's condition, one layer up — and throwing the token
 * away on it would turn a database blip into a password prompt that cannot be
 * satisfied until the database returns. So it passes straight through to the
 * caller, which already knows how to degrade.
 */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...authHeaders() },
  });
  if (res.status === 401 && token.value) {
    signOut("Your session expired — sign in again.");
  }
  return res;
}

/**
 * A one-minute credential for the two transports that cannot carry a header:
 * `EventSource` (no API for one at all) and the browser `WebSocket`
 * constructor. Both take it in the query string, which is why it is minted
 * fresh per connection and expires in a minute rather than being the real
 * token — a URL is the one place a credential reliably gets copied into a proxy
 * log.
 *
 * Returns null when there is nothing to mint (auth off), which is also the
 * signal to build the URL without one.
 */
export async function streamToken(): Promise<string | null> {
  if (mode.value === "off" || !token.value) return null;
  const res = await authFetch(`${DAEMON_HTTP}/api/auth/stream-token`, {
    method: "POST",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`could not mint a stream token (${res.status})`);
  const body = await res.json();
  if (!body?.token) throw new Error("daemon returned no stream token");
  return body.token as string;
}

/** Append a freshly minted stream token to a URL, when one is needed. */
export async function withStreamToken(url: string): Promise<string> {
  const t = await streamToken();
  if (!t) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

// --- accounts (multi-user only) ---------------------------------------------

export interface AccountRow {
  id: string;
  name: string;
  createdAt: number;
}

export async function listAccounts(): Promise<AccountRow[]> {
  const res = await authFetch(`${DAEMON_HTTP}/api/users`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `daemon returned ${res.status}`);
  return Array.isArray(body.users) ? body.users : [];
}

export async function createAccount(name: string, password: string): Promise<void> {
  const res = await authFetch(`${DAEMON_HTTP}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `daemon returned ${res.status}`);
}

export async function removeAccount(id: string): Promise<void> {
  const res = await authFetch(`${DAEMON_HTTP}/api/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `daemon returned ${res.status}`);
}

export async function changePassword(id: string, password: string): Promise<void> {
  const res = await authFetch(`${DAEMON_HTTP}/api/users/${encodeURIComponent(id)}/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `daemon returned ${res.status}`);
  // Changing your own password moves your token epoch, so the token in this tab
  // is already dead. Say so rather than letting the next poll 401 out of
  // nowhere — the daemon tells us which case this was.
  if (body?.signedOut) signOut("Password changed — sign in with the new one.");
}
