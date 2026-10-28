import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { generateRefreshToken, hashToken } from "../../utils/tokens.js";

// A refresh token is single use. Each rotation returns a successor in the same
// family (one sign-in session) and keeps the old hash as a rotated record.
//
// Every operation that mints or revokes a family's tokens first locks its
// RefreshTokenFamily row under READ COMMITTED, so later statements see what the
// previous lock holder committed:
// - rotation re-reads the presented token under the lock and creates the
//   successor in the same transaction as the rotated record;
// - a revoked family (revokedAt set) can never mint again;
// - revocation that waits behind an in-flight rotation deletes its successor.
//
// A rotated token presented again within REFRESH_REUSE_GRACE_MS is treated as
// a benign concurrent use: browser tabs share one cookie, and a tab that sent
// it while another tab's refresh was in flight receives 409 without a new
// token and without revoking anything, then retries with the shared cookie.
// Presented later, it is reuse of a stolen or replayed token and revokes the
// whole family.

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_REUSE_GRACE_MS = 30_000;

export type RefreshRevocationReason =
  | "reuse"
  | "logout"
  | "login"
  | "password_change"
  | "password_reset";

type Client = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

// Locking relies on READ COMMITTED: each statement after a lock wait sees the
// rows the previous holder committed.
export const refreshTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
};

/** Starts a new family for the user and returns its first raw refresh token. */
export async function createRefreshSession(client: Client, userId: string) {
  const refreshToken = generateRefreshToken();
  // One nested write: the family is never visible without its first token.
  await client.refreshTokenFamily.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      tokens: {
        create: {
          token: hashToken(refreshToken),
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        },
      },
    },
  });
  return refreshToken;
}

async function findFamilyId(tx: Tx, tokenHash: string) {
  const active = await tx.refreshToken.findUnique({
    where: { token: tokenHash },
    select: { familyId: true },
  });
  if (active) return active.familyId;
  const rotated = await tx.rotatedRefreshToken.findUnique({
    where: { tokenHash },
    select: { familyId: true },
  });
  return rotated?.familyId ?? null;
}

async function lockFamily(tx: Tx, familyId: string) {
  const [family] = await tx.$queryRaw<
    Array<{ userId: string; revokedAt: Date | null }>
  >`
    SELECT "userId", "revokedAt" FROM "RefreshTokenFamily"
    WHERE id = ${familyId}
    FOR UPDATE
  `;
  return family ?? null;
}

async function revokeLockedFamily(
  tx: Tx,
  familyId: string,
  reason: RefreshRevocationReason,
) {
  await tx.refreshTokenFamily.updateMany({
    where: { id: familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await tx.refreshToken.deleteMany({ where: { familyId } });
}

export type RotationResult =
  | { status: "rotated"; userId: string; refreshToken: string }
  | { status: "superseded" }
  | { status: "expired" }
  | { status: "invalid" };

/**
 * Rotates a presented refresh token. The outcome is returned rather than
 * thrown so that a reuse revocation or expired-token deletion commits.
 */
export function rotateRefreshToken(
  prisma: PrismaClient,
  rawToken: string,
): Promise<RotationResult> {
  const tokenHash = hashToken(rawToken);
  return prisma.$transaction(async (tx): Promise<RotationResult> => {
    const familyId = await findFamilyId(tx, tokenHash);
    if (!familyId) return { status: "invalid" };
    const family = await lockFamily(tx, familyId);
    if (!family || family.revokedAt) return { status: "invalid" };

    const now = new Date();
    // Re-read under the lock: a previous holder may have rotated it.
    const current = await tx.refreshToken.findUnique({
      where: { token: tokenHash },
      select: { id: true, expiresAt: true },
    });
    if (current) {
      if (current.expiresAt <= now) {
        await tx.refreshToken.delete({ where: { id: current.id } });
        return { status: "expired" };
      }
      const refreshToken = generateRefreshToken();
      await tx.rotatedRefreshToken.create({
        data: { tokenHash, familyId, rotatedAt: now },
      });
      await tx.refreshToken.delete({ where: { id: current.id } });
      await tx.refreshToken.create({
        data: {
          token: hashToken(refreshToken),
          familyId,
          userId: family.userId,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        },
      });
      return { status: "rotated", userId: family.userId, refreshToken };
    }

    const rotated = await tx.rotatedRefreshToken.findUnique({
      where: { tokenHash },
      select: { rotatedAt: true },
    });
    if (!rotated) return { status: "invalid" };
    if (now.getTime() - rotated.rotatedAt.getTime() < REFRESH_REUSE_GRACE_MS)
      return { status: "superseded" };
    await revokeLockedFamily(tx, familyId, "reuse");
    return { status: "invalid" };
  }, refreshTransactionOptions);
}

/** Revokes the family of a presented active or rotated token, if any. */
export async function revokeRefreshFamily(
  prisma: PrismaClient,
  rawToken: string,
  reason: RefreshRevocationReason,
) {
  const tokenHash = hashToken(rawToken);
  await prisma.$transaction(async (tx) => {
    const familyId = await findFamilyId(tx, tokenHash);
    if (!familyId || !(await lockFamily(tx, familyId))) return;
    await revokeLockedFamily(tx, familyId, reason);
  }, refreshTransactionOptions);
}

/**
 * Revokes every family of a user inside the caller's READ COMMITTED
 * transaction. Families are locked in id order, waiting for in-flight
 * rotations to commit, so their successors are deleted as well.
 */
export async function revokeUserRefreshSessions(
  tx: Tx,
  userId: string,
  reason: RefreshRevocationReason,
) {
  await tx.$queryRaw`
    SELECT id FROM "RefreshTokenFamily"
    WHERE "userId" = ${userId}
    ORDER BY id
    FOR UPDATE
  `;
  await tx.refreshTokenFamily.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  await tx.refreshToken.deleteMany({ where: { userId } });
}
