import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import { PAGE_WRITE_TRANSACTION, lockPageRow } from "./wiki-page-writes.js";

const LOCK_DURATION_MS = 2 * 60 * 1000; // 2 minutes

const lockUser = {
  user: { select: { id: true, displayName: true, avatarUrl: true } },
} as const;

/**
 * Takes or renews the edit lock. Runs under the page row lock, which saves and
 * restores also take, so a save either finishes before the lock changes hands
 * or sees the new holder and is refused.
 */
export async function acquireLock(
  prisma: PrismaClient,
  pageId: string,
  userId: string,
) {
  // Clean up expired locks first
  await cleanupExpiredLocks(prisma);

  return prisma.$transaction(async (tx) => {
    await lockPageRow(tx, pageId);
    const existing = await tx.wikiPageLock.findUnique({
      where: { pageId },
      include: lockUser,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_DURATION_MS);

    if (existing?.userId === userId) {
      // Extend own lock
      return tx.wikiPageLock.update({
        where: { pageId },
        data: { expiresAt, heartbeat: now },
        include: lockUser,
      });
    }
    if (existing) {
      // Another user's lock can be replaced only once it has expired; a
      // heartbeat that renewed it in the meantime keeps it.
      const { count } = await tx.wikiPageLock.deleteMany({
        where: { pageId, userId: existing.userId, expiresAt: { lte: now } },
      });
      if (count === 0)
        throw new ConflictError(
          `Page is being edited by ${existing.user.displayName}`,
        );
    }

    return tx.wikiPageLock.create({
      data: { pageId, userId, expiresAt },
      include: lockUser,
    });
  }, PAGE_WRITE_TRANSACTION);
}

export async function releaseLock(
  prisma: PrismaClient,
  pageId: string,
  userId: string,
) {
  // Can only release own lock. One conditional statement, so a lock that
  // changed hands since the request was sent is never removed.
  await prisma.wikiPageLock.deleteMany({ where: { pageId, userId } });
}

export async function heartbeatLock(
  prisma: PrismaClient,
  pageId: string,
  userId: string,
) {
  // Renews only this user's own lock row, in one conditional statement.
  const { count } = await prisma.wikiPageLock.updateMany({
    where: { pageId, userId },
    data: {
      expiresAt: new Date(Date.now() + LOCK_DURATION_MS),
      heartbeat: new Date(),
    },
  });
  if (count === 0) throw new NotFoundError("No active lock found");
}

export async function checkLock(prisma: PrismaClient, pageId: string) {
  await cleanupExpiredLocks(prisma);

  return prisma.wikiPageLock.findUnique({
    where: { pageId },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true } },
    },
  });
}

export async function cleanupExpiredLocks(prisma: PrismaClient) {
  await prisma.wikiPageLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}
