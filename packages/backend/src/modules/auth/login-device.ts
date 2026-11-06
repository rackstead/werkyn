import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";

/**
 * Trusted-device tokens for sign-in (OWASP "device cookies"; see
 * docs/remediation/r31-login-backoff.md).
 *
 * A successful password sign-in sets an HttpOnly cookie, sent only to the
 * sign-in route. It holds one token per address that signed in from this
 * browser (at most MAX_TOKENS, each expiring after DEVICE_DAYS). A token is
 * `<device id>.<expiry>.<mac>`, where the MAC binds the device id and expiry
 * to the normalized address under a key derived from COOKIE_SECRET. A token
 * is minted only after the account's password signed in, so an address
 * without an account never has one, and a token is valid only for the
 * address it was minted for.
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
const TOKEN = /^([A-Za-z0-9_-]{22})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

let deviceKey: Buffer | undefined;

function mac(email: string, id: string, expires: number): string {
  deviceKey ??= createHmac("sha256", env.COOKIE_SECRET)
    .update("werkyn login device v1")
    .digest();
  return createHmac("sha256", deviceKey)
    .update(`${email}\n${id}\n${expires}`, "utf8")
    .digest("base64url");
}

interface Token {
  id: string;
  expires: number;
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
        ? [{ id: match[1]!, expires: Number(match[2]), mac: match[3]!, raw }]
        : [];
    });
}

/**
 * The device id of an unexpired token for this normalized address in the
 * cookie, or null. Decided without the database, so it takes the same time
 * whether or not the address has an account.
 */
export function trustedDevice(
  cookie: string | undefined,
  email: string,
  now = Date.now(),
): string | null {
  for (const token of tokens(cookie)) {
    if (token.expires * 1000 <= now) continue;
    const expected = Buffer.from(mac(email, token.id, token.expires));
    const given = Buffer.from(token.mac);
    if (expected.length === given.length && timingSafeEqual(expected, given))
      return token.id;
  }
  return null;
}

/**
 * The cookie value after this address signed in: its token first (renewed,
 * keeping the device id it had in this browser), then the other addresses'
 * unexpired tokens, at most MAX_TOKENS in all.
 */
export function deviceCookieAfterSignIn(
  cookie: string | undefined,
  email: string,
  now = Date.now(),
): string {
  const id =
    trustedDevice(cookie, email, now) ?? randomBytes(16).toString("base64url");
  const expires = Math.floor(now / 1000) + LOGIN_DEVICE_MAX_AGE_SECONDS;
  const own = `${id}.${expires}.${mac(email, id, expires)}`;
  const others = tokens(cookie)
    .filter((token) => token.expires * 1000 > now && token.id !== id)
    .map((token) => token.raw);
  return [own, ...others].slice(0, MAX_TOKENS).join("~");
}
