import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { ConflictError } from "./errors.js";

export type PublicShareKind = "wiki" | "files";
export interface ShareAccessRecord {
  id: string;
  passwordHash: string | null;
  enabled: boolean;
  updatedAt: Date;
  expiresAt?: Date | null;
}

const GRANT_LIFETIME_MS = 30 * 60 * 1000;

function revision(share: ShareAccessRecord): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        share.id,
        share.passwordHash,
        share.enabled,
        share.updatedAt.getTime(),
        share.expiresAt?.getTime() ?? null,
      ]),
    )
    .digest("base64url");
}

function signature(payload: string): Buffer {
  return crypto
    .createHmac("sha256", env.COOKIE_SECRET)
    .update(`public-share-grant\0${payload}`)
    .digest();
}

export function createShareGrant(
  kind: PublicShareKind,
  share: ShareAccessRecord,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      kind,
      id: share.id,
      revision: revision(share),
      expires: Math.min(
        now + GRANT_LIFETIME_MS,
        share.expiresAt?.getTime() ?? Infinity,
      ),
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function hasShareGrant(
  grant: string | undefined,
  kind: PublicShareKind,
  share: ShareAccessRecord,
): boolean {
  if (!grant || grant.length > 1024) return false;
  try {
    const parts = grant.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
    const received = Buffer.from(parts[1], "base64url");
    const expected = signature(parts[0]);
    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    )
      return false;
    const payload = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    );
    return (
      payload.kind === kind &&
      payload.id === share.id &&
      payload.revision === revision(share) &&
      typeof payload.expires === "number" &&
      Number.isFinite(payload.expires) &&
      payload.expires > Date.now()
    );
  } catch {
    return false;
  }
}

export function shareGrantCookieName(
  kind: PublicShareKind,
  token: string,
): string {
  return `share_${kind}_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

export function setShareGrantCookie(
  reply: FastifyReply,
  kind: PublicShareKind,
  token: string,
  share: ShareAccessRecord,
): void {
  const now = Date.now();
  const expires = Math.min(
    now + GRANT_LIFETIME_MS,
    share.expiresAt?.getTime() ?? Infinity,
  );
  reply.setCookie(
    shareGrantCookieName(kind, token),
    createShareGrant(kind, share, now),
    {
      // Let the browser derive the share path from its external /validate URL.
      // This preserves reverse-proxy API prefixes without broad cookie paths.
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
      maxAge: Math.max(0, Math.floor((expires - now) / 1000)),
      expires: new Date(expires),
    },
  );
}

export function publicShareNoStore(
  _request: unknown,
  reply: FastifyReply,
  done: () => void,
): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Pragma", "no-cache");
  done();
}

export function shareSummary<T extends { passwordHash: string | null }>(
  share: T,
) {
  const { passwordHash, ...publicFields } = share;
  return { ...publicFields, hasPassword: Boolean(passwordHash) };
}

// Guarded updates ensure every mutation advances the credential revision, even
// concurrent writes and disable/re-enable cycles within one clock millisecond.
export async function updateShareRevision<T extends { updatedAt: Date }, R>(
  load: () => Promise<T | null>,
  write: (share: T, nextRevision: Date) => Promise<R>,
  missing: () => Error,
): Promise<R> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const share = await load();
    if (!share) throw missing();
    const nextRevision = new Date(
      Math.max(Date.now(), share.updatedAt.getTime() + 1),
    );
    try {
      return await write(share, nextRevision);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "P2025"
      )
        throw error;
      if (attempt === 4) {
        throw new ConflictError("Share changed concurrently; please retry");
      }
    }
  }
  throw missing();
}
