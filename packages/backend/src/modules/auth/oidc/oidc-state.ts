import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { UnauthorizedError } from "../../../utils/errors.js";

export const OIDC_STATE_TTL_SECONDS = 10 * 60;
export const OIDC_STATE_COOKIE_PREFIX = "oidc_state_";
export const OIDC_STATE_COOKIE_PATH = "/api/auth/oidc";
export const MAX_OIDC_BROWSER_ATTEMPTS = 5;
export const OIDC_STATE_PATTERN = /^[a-f0-9]{64}$/;

export function oidcStateCookieName(state: string) {
  if (!OIDC_STATE_PATTERN.test(state))
    throw new UnauthorizedError("Invalid OIDC state");
  return `${OIDC_STATE_COOKIE_PREFIX}${state}`;
}

export async function consumeOidcState(
  prisma: PrismaClient,
  state: string,
  browserState: string | undefined,
) {
  if (
    !OIDC_STATE_PATTERN.test(state) ||
    !browserState ||
    !OIDC_STATE_PATTERN.test(browserState) ||
    !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(browserState))
  ) {
    throw new UnauthorizedError("OIDC state does not match this browser");
  }
  const record = await prisma.oidcState.findUnique({ where: { state } });
  if (!record)
    throw new UnauthorizedError("Invalid or already used OIDC state");

  const now = new Date();
  if (record.expiresAt <= now) {
    await prisma.oidcState.deleteMany({ where: { id: record.id } });
    throw new UnauthorizedError("OIDC state expired");
  }
  // A conditional delete elects one callback even if two requests both read the
  // row before either deletes it. Replays fail cleanly before a token exchange.
  const claimed = await prisma.oidcState.deleteMany({
    where: { id: record.id, state, expiresAt: { gt: now } },
  });
  if (claimed.count !== 1)
    throw new UnauthorizedError("Invalid or already used OIDC state");
  // A database row lock or slow claim can outlive the timestamp above. Once
  // claimed, reject an expired attempt before callers can exchange its code.
  if (record.expiresAt <= new Date())
    throw new UnauthorizedError("OIDC state expired");
  return record;
}
