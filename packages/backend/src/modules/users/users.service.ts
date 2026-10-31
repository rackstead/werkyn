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
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";

export async function getMe(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      jobTitle: true,
      phone: true,
      timezone: true,
      emailVerified: true,
    },
  });

  if (!user) throw new NotFoundError("User not found");
  return user;
}

export async function updateProfile(
  prisma: PrismaClient,
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

  const user = await prisma.user.update({
    where: { id: userId },
    data,
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      jobTitle: true,
      phone: true,
      timezone: true,
      emailVerified: true,
    },
  });

  return user;
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
  // the transaction, so that bcrypt does not run while the row is held. The
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
