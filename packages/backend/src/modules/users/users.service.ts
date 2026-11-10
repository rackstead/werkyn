import type { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../../utils/passwords.js";
import {
  isBusy,
  limitLockWaits,
  refreshTransactionOptions,
  revokeUserRefreshSessions,
} from "../auth/refresh-sessions.js";
import { endSessions } from "../realtime/realtime.service.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import type { StorageProvider } from "../../services/storage.js";
import {
  avatarStoragePath,
  canonicalAvatarUrl,
} from "../uploads/avatar-storage-path.js";

const profileSelect = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  jobTitle: true,
  phone: true,
  timezone: true,
  emailVerified: true,
} as const;

export async function getMe(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: profileSelect,
  });

  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function updateProfile(
  prisma: PrismaClient,
  storage: Pick<StorageProvider, "exists">,
  userId: string,
  requesterId: string,
  data: {
    displayName?: string;
    avatarUrl?: string | null;
    jobTitle?: string | null;
    phone?: string | null;
    timezone?: string | null;
  },
) {
  if (userId !== requesterId) {
    throw new ForbiddenError("You can only update your own profile");
  }

  // A display-name (or other) save does not read or queue the avatar.
  if (data.avatarUrl === undefined) {
    return prisma.user.update({
      where: { id: userId },
      data,
      select: profileSelect,
    });
  }

  // Queue the previous uploaded avatar in the same transaction as the
  // profile write, with the file trigger's insert. The user row is locked so
  // two replacements cannot each miss the other's path. Adopting a path also
  // locks its BlobCleanup row, the same row the sweeper holds across its
  // reference check and delete: whoever gets it first wins, and a path whose
  // bytes are already gone is not saved. The request does not delete the
  // bytes. The same path, a missing previous URL, and anything that is not
  // an uploaded avatar (including wiki media) are not queued, and the new
  // URL is never queued.
  try {
    return await prisma.$transaction(async (tx) => {
      await limitLockWaits(tx);
      const [current] = await tx.$queryRaw<Array<{ avatarUrl: string | null }>>`
        SELECT "avatarUrl" FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE
      `;
      const previousPath = avatarStoragePath(current?.avatarUrl);
      // Same prefix the upload handler writes. The media route also serves
      // other casings of `/storage`; the sweep keeps those too.
      const storedAvatarUrl =
        canonicalAvatarUrl(data.avatarUrl) ?? data.avatarUrl;
      const nextPath = avatarStoragePath(storedAvatarUrl);
      const profileData =
        storedAvatarUrl === data.avatarUrl
          ? data
          : { ...data, avatarUrl: storedAvatarUrl };
      if (nextPath && nextPath !== previousPath) {
        await tx.$queryRaw`
          SELECT "storagePath" FROM "BlobCleanup"
          WHERE "storagePath" = ${nextPath}
          FOR UPDATE
        `;
        if (!(await storage.exists(nextPath))) {
          throw new ConflictError("This avatar is no longer available");
        }
      }
      if (current && previousPath && previousPath !== nextPath) {
        await tx.$executeRaw`
          INSERT INTO "BlobCleanup" ("storagePath")
          VALUES (${previousPath})
          ON CONFLICT ("storagePath") DO UPDATE
          SET "availableAt" = LEAST("BlobCleanup"."availableAt", CURRENT_TIMESTAMP)
        `;
      }
      return tx.user.update({
        where: { id: userId },
        data: profileData,
        select: profileSelect,
      });
    }, refreshTransactionOptions);
  } catch (error: unknown) {
    if (isBusy(error)) {
      throw new AppError(
        503,
        "Service Unavailable",
        "This account is busy. Try again in a moment.",
      );
    }
    throw error;
  }
}

export async function changePassword(
  prisma: PrismaClient,
  userId: string,
  requesterId: string,
  data: { currentPassword: string; newPassword: string },
) {
  if (userId !== requesterId) {
    throw new ForbiddenError("You can only change your own password");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });

  if (!user) throw new NotFoundError("User not found");

  if (!user.passwordHash) {
    throw new ValidationError("This account uses SSO and has no password set");
  }

  const valid = await verifyPassword(data.currentPassword, user.passwordHash);
  if (!valid) {
    throw new ValidationError("Current password is incorrect");
  }

  const passwordHash = await hashPassword(data.newPassword);

  // The current password was verified against the hash read above, outside
  // the transaction, so that password hashing does not run while the row is held. The
  // transaction locks the user row (FOR NO KEY UPDATE, as password login and
  // reset do, before the families) and writes only if the hash is still the
  // one that was verified. A reset or another change that committed in
  // between replaced the password this request proved; it is refused with
  // the same error as a wrong password and changes nothing.
  const changing = prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    const [current] = await tx.$queryRaw<
      Array<{ passwordHash: string | null }>
    >`
      SELECT "passwordHash" FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE
    `;
    if (current?.passwordHash !== user.passwordHash) {
      throw new ValidationError("Current password is incorrect");
    }
    // Invalidate pre-existing unused reset links before the password and
    // families change. The account lock excludes every reset. Other token
    // holders are forgot-password/cleanup deletes; skip them so multi-row
    // deletes cannot wait for one another in opposite row orders.
    await tx.$executeRaw`
      DELETE FROM "PasswordResetToken"
      WHERE id IN (
        SELECT id FROM "PasswordResetToken"
        WHERE "userId" = ${userId} AND "usedAt" IS NULL
        FOR UPDATE SKIP LOCKED
      )
    `;
    // A skipped deleter may still roll back. Its old row remains visible to
    // this nonlocking READ COMMITTED check until it commits; refuse and roll
    // back this change rather than leave that link usable after success.
    const remaining = await tx.passwordResetToken.findFirst({
      where: { userId, usedAt: null },
      select: { id: true },
    });
    if (remaining) {
      throw new AppError(
        503,
        "Service Unavailable",
        "This account is busy. Try again in a moment.",
      );
    }
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    return revokeUserRefreshSessions(tx, userId, "password_change");
  }, refreshTransactionOptions);
  const revoked = await changing.catch((error: unknown) => {
    // A lock wait past the lock timeout, or a transaction past its budget,
    // was rolled back without changing anything; the request can be retried.
    if (isBusy(error))
      throw new AppError(
        503,
        "Service Unavailable",
        "This account is busy. Try again in a moment.",
      );
    throw error;
  });
  // Every session ended, including the one that made the change; their
  // sockets close now that the revocation has committed.
  endSessions(revoked);

  return { message: "Password updated" };
}
