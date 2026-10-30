import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../utils/errors.js";
import {
  PAGE_WRITE_TRANSACTION,
  databaseNow,
  lockPageRow,
} from "./wiki-page-writes.js";

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
    const now = await databaseNow(tx);
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
  // Renews only this user's own lock while it is still held. A lapsed lock
  // is not revived: a save or restore by another user may already have
  // checked it as absent; Start Editing takes it again. The renewal waits for
  // the page row like those writers, then judges expiry on the database clock
  // as it runs, so a renewal delayed past expiry (by the pool, the event loop
  // or a save in progress) fails too. The columns hold UTC without a time
  // zone, as Prisma writes them.
  await prisma.$transaction(async (tx) => {
    await lockPageRow(tx, pageId);
    const count = await tx.$executeRaw`
      UPDATE "WikiPageLock"
      SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC')
            + make_interval(secs => ${LOCK_DURATION_MS / 1000}),
          "heartbeat" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE "pageId" = ${pageId} AND "userId" = ${userId}
        AND "expiresAt" > clock_timestamp() AT TIME ZONE 'UTC'
    `;
    if (count === 0) throw new NotFoundError("No active lock found");
  }, PAGE_WRITE_TRANSACTION);
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
  await prisma.$executeRaw`
    DELETE FROM "WikiPageLock"
    WHERE "expiresAt" < clock_timestamp() AT TIME ZONE 'UTC'
  `;
}
