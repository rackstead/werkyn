import { apiPrefixUrl } from "./api-url";

// Sign-outs the user asked for that the server has not confirmed yet.
//
// A sign-out clears the session in every tab at once, then asks the server to
// revoke it. If that request fails (offline, a 5xx, the tab closed first), the
// server session stays valid and this browser still holds its refresh cookie,
// so a later page load would quietly restore it. The auth store therefore
// records the sign-out here *before* sending anything, and removes the record
// once the server has settled it, or once a sign-in has replaced the cookie
// (this browser can then no longer restore that session). While a record
// remains, a page load in any tab completes the revocation first and restores
// no session.
//
// A record names the session by its id: the `sid` claim of its access tokens,
// which is the id of its refresh-token family. The id only selects a session;
// it is not a credential, and no token is ever stored. It is also what keeps a
// record from ending a newer sign-in: every sign-in starts a new family, and
// the server revokes only when the cookie the browser sends belongs to the
// recorded family.
//
// Each record has its own localStorage key, under the API's absolute base URL
// (the cookie belongs to that API) and the session id, so tabs never overwrite
// each other's records. The value holds the account id and the time recorded.
//
// Storage is bounded:
// - at most MAX_PENDING_SIGN_OUTS records per API; recording another drops the
//   oldest. Signing out again needs a session again, and while a record is
//   pending none is restored, so a newer record follows a new sign-in, which
//   replaced the cookie: older records can no longer match it.
// - a record expires PENDING_SIGN_OUT_TTL_MS after it was written. Refresh
//   tokens expire 7 days after they are issued, and no tab renews a session
//   that has a record, so by then the session cannot be used from here.

const PREFIX = "pm-auth-signout:v1:";

/** The 7-day refresh-token lifetime, plus a day of margin. */
export const PENDING_SIGN_OUT_TTL_MS = 8 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_SIGN_OUTS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PendingSignOut {
  sessionId: string;
  userId: string | null;
  /** When it was recorded; null when the stored value cannot be read. */
  at: number | null;
}

/**
 * The session id (`sid` claim) an access token carries, or null. The token is
 * not verified: the id only names the session to end.
 */
export function sessionIdOf(
  accessToken: string | null | undefined,
): string | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    );
    const sid = (claims as { sid?: unknown } | null)?.sid;
    if (typeof sid !== "string") return null;
    const id = sid.toLowerCase();
    return UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keys of this API's records: the API's absolute base URL, then the id. */
function scopePrefix(): string {
  const base = new URL(apiPrefixUrl(), window.location.href);
  base.search = "";
  base.hash = "";
  return `${PREFIX}${base.href}#`;
}

function parse(sessionId: string, raw: string | null): PendingSignOut {
  try {
    const value = JSON.parse(raw ?? "") as { userId?: unknown; at?: unknown };
    return {
      sessionId,
      userId: typeof value.userId === "string" ? value.userId : null,
      at: Number.isSafeInteger(value.at) ? (value.at as number) : null,
    };
  } catch {
    return { sessionId, userId: null, at: null };
  }
}

const expired = (record: PendingSignOut, now: number) =>
  record.at !== null && now - record.at > PENDING_SIGN_OUT_TTL_MS;

/**
 * This API's records, newest first. Expired records, and keys that name no
 * session, are removed. A record whose value cannot be read is kept (its key
 * names the session) and counts as the oldest.
 */
export function pendingSignOuts(now = Date.now()): PendingSignOut[] {
  const store = storage();
  if (!store) return [];
  const records: PendingSignOut[] = [];
  try {
    const prefix = scopePrefix();
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      const sessionId = key.slice(prefix.length);
      const record = UUID.test(sessionId)
        ? parse(sessionId, store.getItem(key))
        : null;
      if (!record || expired(record, now)) store.removeItem(key);
      else records.push(record);
    }
  } catch {
    // Storage unavailable: nothing recorded can be read.
  }
  return records.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
}

/**
 * Records that the session `sessionId` is to be signed out, or renews the time
 * of its record. Returns whether the record was stored.
 */
export function recordPendingSignOut(
  sessionId: string,
  userId: string | null,
  now = Date.now(),
): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const others = pendingSignOuts(now).filter(
      (record) => record.sessionId !== sessionId,
    );
    for (const old of others.slice(MAX_PENDING_SIGN_OUTS - 1)) {
      store.removeItem(scopePrefix() + old.sessionId);
    }
    store.setItem(
      scopePrefix() + sessionId,
      JSON.stringify({ userId, at: now }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Removes the record of `sessionId`, once the server has settled it. */
export function clearPendingSignOut(sessionId: string): void {
  try {
    storage()?.removeItem(scopePrefix() + sessionId);
  } catch {
    // Storage unavailable: the record is settled again on a later load.
  }
}

/**
 * Removes the records of every session but `sessionId`, after a sign-in has
 * replaced the cookie they would need.
 */
export function clearPendingSignOutsExcept(sessionId: string): void {
  for (const record of pendingSignOuts()) {
    if (record.sessionId !== sessionId) clearPendingSignOut(record.sessionId);
  }
}

/** Whether a sign-out of `sessionId` is recorded and not yet settled. */
export function hasPendingSignOut(
  sessionId: string | null,
  now = Date.now(),
): boolean {
  if (!sessionId) return false;
  try {
    const raw = storage()?.getItem(scopePrefix() + sessionId) ?? null;
    return raw !== null && !expired(parse(sessionId, raw), now);
  } catch {
    return false;
  }
}
