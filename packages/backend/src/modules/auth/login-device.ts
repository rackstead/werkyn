import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Trusted-device tokens for sign-in (OWASP "device cookies"; see
 * docs/remediation/r31-login-backoff.md).
 *
 * A successful password sign-in sets an HttpOnly cookie, sent only to the
 * sign-in route. It holds one token per address that signed in from this
 * browser (at most MAX_TOKENS, each expiring after DEVICE_DAYS). A token is
 * `<device id>.<expiry>.<credential tag>.<mac>`, where the MAC binds the
 * device id, expiry and tag to the normalized address under a key derived
 * from COOKIE_SECRET, and the tag is a keyed hash of the account's stored
 * password hash when the token was minted. A token is minted only after the
 * account's password signed in, so an address without an account never has
 * one; it is valid only for the address it was minted for, and only while
 * the account keeps that password (a change or reset ends every token).
 *
 * A sign-in that presents a valid token for its address is counted in that
 * device's own backoff lane instead of the address's shared one, so an
 * attacker who keeps the address in its wait cannot hold off a browser that
 * signed in before. The token grants no access by itself: the password is
 * still checked, and the lane backs off like the address does.
 */
export const LOGIN_DEVICE_COOKIE = "login_device";
export const LOGIN_DEVICE_COOKIE_PATH = "/api/auth/login";
const DEVICE_DAYS = 30;
export const LOGIN_DEVICE_MAX_AGE_SECONDS = DEVICE_DAYS * 24 * 60 * 60;
const MAX_TOKENS = 5;
const MAX_COOKIE_LENGTH = 1024;
const TOKEN = /^([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;

let deviceKey: Buffer | undefined;

function key(): Buffer {
  deviceKey ??= createHmac("sha256", env.COOKIE_SECRET)
    .update("werkyn login device v1")
    .digest();
  return deviceKey;
}

function mac(email: string, id: string, expires: number, tag: string): string {
  return createHmac("sha256", key())
    .update(`${email}\n${id}\n${expires}\n${tag}`, "utf8")
    .digest("base64url");
}

/** A keyed tag of the account's stored password hash (its credential). */
export function credentialTag(passwordHash: string): string {
  return createHmac("sha256", key())
    .update(`credential\n${passwordHash}`, "utf8")
    .digest("base64url")
    .slice(0, 16);
}

interface Token {
  id: string;
  expires: number;
  tag: string;
  mac: string;
  raw: string;
}

function tokens(cookie: string | undefined): Token[] {
  if (!cookie || cookie.length > MAX_COOKIE_LENGTH) return [];
  return cookie
    .split("~")
    .slice(0, MAX_TOKENS)
    .flatMap((raw) => {
      const match = TOKEN.exec(raw);
      return match
        ? [{ id: match[1]!, expires: Number(match[2]), tag: match[3]!, mac: match[4]!, raw }]
        : [];
    });
}

export interface DeviceToken {
  id: string;
  /** The credential tag it was minted under; see credentialMatches. */
  tag: string;
}

/**
 * An unexpired token minted for this normalized address, from the cookie,
 * or null. Decided without the database: only a sign-in to this address can
 * mint one, so someone probing other addresses never gets past this check.
 */
export function deviceToken(
  cookie: string | undefined,
  email: string,
  now = Date.now(),
): DeviceToken | null {
  for (const token of tokens(cookie)) {
    if (token.expires * 1000 <= now) continue;
    const expected = Buffer.from(mac(email, token.id, token.expires, token.tag));
    const given = Buffer.from(token.mac);
    if (expected.length === given.length && timingSafeEqual(expected, given))
      return { id: token.id, tag: token.tag };
  }
  return null;
}

/** Whether a token was minted under the account's current password hash. */
export function credentialMatches(token: DeviceToken, passwordHash: string | null | undefined) {
  if (!passwordHash) return false;
  const expected = Buffer.from(credentialTag(passwordHash));
  const given = Buffer.from(token.tag);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The cookie value after this address signed in with the account whose
 * stored hash is `passwordHash`: its token first (renewed, keeping the
 * device id it had in this browser under the same password), then the other
 * addresses' unexpired tokens, at most MAX_TOKENS in all.
 */
export function deviceCookieAfterSignIn(
  cookie: string | undefined,
  email: string,
  passwordHash: string,
  now = Date.now(),
): string {
  const previous = deviceToken(cookie, email, now);
  const id =
    previous && credentialMatches(previous, passwordHash)
      ? previous.id
      : randomBytes(16).toString("base64url");
  const expires = Math.floor(now / 1000) + LOGIN_DEVICE_MAX_AGE_SECONDS;
  const tag = credentialTag(passwordHash);
  const own = `${id}.${expires}.${tag}.${mac(email, id, expires, tag)}`;
  // This address's earlier tokens are replaced; other addresses' are kept.
  const others = tokens(cookie)
    .filter(
      (token) =>
        token.expires * 1000 > now &&
        token.id !== id &&
        token.id !== previous?.id,
    )
    .map((token) => token.raw);
  return [own, ...others].slice(0, MAX_TOKENS).join("~");
}
