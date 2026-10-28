import type { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "../../utils/passwords.js";
import {
  refreshTransactionOptions,
  revokeUserRefreshSessions,
} from "../auth/refresh-sessions.js";
import {
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

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await revokeUserRefreshSessions(tx, userId, "password_change");
  }, refreshTransactionOptions);

  return { message: "Password updated" };
}
