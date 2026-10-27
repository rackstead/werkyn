import type { PrismaClient } from "@prisma/client";
import { createAccount, waitForAccountRetry } from "./account-creation.js";
import { hashPassword, verifyPassword } from "../../utils/passwords.js";
import {
  signAccessToken,
  generateRefreshToken,
  generateSecureToken,
  hashToken,
} from "../../utils/tokens.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../utils/mailer.js";
import {
  ConflictError,
  UnauthorizedError,
  NotFoundError,
  GoneError,
  LockedError,
} from "../../utils/errors.js";

// Progressive lockout thresholds
const LOCKOUT_THRESHOLDS = [
  { attempts: 5, duration: 30 * 1000 },       // 30 seconds
  { attempts: 10, duration: 5 * 60 * 1000 },  // 5 minutes
  { attempts: 15, duration: 30 * 60 * 1000 }, // 30 minutes
];

function getLockoutDuration(failedCount: number): number {
  for (let i = LOCKOUT_THRESHOLDS.length - 1; i >= 0; i--) {
    if (failedCount >= LOCKOUT_THRESHOLDS[i].attempts) {
      return LOCKOUT_THRESHOLDS[i].duration;
    }
  }
  return 0;
}

async function getUserWorkspaces(prisma: PrismaClient, userId: string) {
  return prisma.workspaceMember.findMany({
    where: { userId },
    select: {
      id: true,
      workspaceId: true,
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
        },
      },
    },
  });
}

async function createTokenPair(
  prisma: PrismaClient,
  userId: string,
  email: string,
  familyId?: string,
) {
  const accessToken = signAccessToken({ sub: userId, email });
  const refreshToken = generateRefreshToken();

  const tokenFamilyId = familyId || crypto.randomUUID();

  await prisma.refreshToken.create({
    data: {
      token: hashToken(refreshToken),
      familyId: tokenFamilyId,
      userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    },
  });

  return { accessToken, refreshToken };
}

export async function register(
  prisma: PrismaClient,
  data: {
    email: string;
    password: string;
    displayName: string;
    inviteToken?: string;
  },
) {
  // SSO enforcement: reject registration if SSO-only mode
  const ssoConfig = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  if (ssoConfig?.enabled && !ssoConfig.passwordLoginEnabled) {
    throw new UnauthorizedError(
      "Password registration is disabled. Please use SSO to sign in.",
    );
  }

  const existingUser = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
  });

  if (existingUser) {
    throw new ConflictError("Email already in use");
  }

  const passwordHash = await hashPassword(data.password);

  const { user, isBootstrapAdmin } = await createPasswordAccount(prisma, {
    email: data.email.toLowerCase(),
    displayName: data.displayName,
    passwordHash,
  });

  // Skip verification for first user (already verified as instance admin)
  if (!isBootstrapAdmin) {
    const verificationToken = generateSecureToken();
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token: verificationToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
    });

    await sendVerificationEmail(user.email, verificationToken);
  }

  // Handle invite token if provided
  if (data.inviteToken) {
    try {
      const invite = await prisma.workspaceInvite.findUnique({
        where: { token: data.inviteToken },
      });

      if (
        invite &&
        (!invite.expiresAt || invite.expiresAt > new Date()) &&
        (invite.maxUses === null || invite.useCount < invite.maxUses) &&
        (!invite.email || invite.email.toLowerCase() === user.email)
      ) {
        await prisma.$transaction([
          prisma.workspaceMember.create({
            data: {
              userId: user.id,
              workspaceId: invite.workspaceId,
              role: invite.role,
            },
          }),
          prisma.workspaceInvite.update({
            where: { id: invite.id },
            data: { useCount: { increment: 1 } },
          }),
        ]);
      }
    } catch {
      // Ignore invite errors — user is still created
    }
  }

  // Generate tokens
  const { accessToken, refreshToken } = await createTokenPair(
    prisma,
    user.id,
    user.email,
  );

  const workspaces = await getUserWorkspaces(prisma, user.id);

  return { user, accessToken, refreshToken, workspaces };
}

async function createPasswordAccount(
  prisma: PrismaClient,
  data: { email: string; displayName: string; passwordHash: string },
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        (tx) =>
          createAccount(
            tx,
            {
              ...data,
              authProviders: {
                create: { provider: "password", email: data.email },
              },
            },
            { bootstrapAdminEligible: true },
          ),
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code === "P2002") throw new ConflictError("Email already in use");
      if (code !== "P2034") throw error;
      if (attempt === 2)
        throw new ConflictError(
          "Concurrent account registration. Please try again.",
        );
      await waitForAccountRetry(attempt);
    }
  }
  throw new ConflictError("Concurrent account registration. Please try again.");
}

export async function login(
  prisma: PrismaClient,
  data: { email: string; password: string },
) {
  const email = data.email.toLowerCase();

  // Check lockout
  const attempt = await prisma.loginAttempt.findUnique({
    where: { email },
  });

  if (attempt?.lockedUntil && attempt.lockedUntil > new Date()) {
    const secondsLeft = Math.ceil(
      (attempt.lockedUntil.getTime() - Date.now()) / 1000,
    );
    throw new LockedError(
      `Account locked. Try again in ${secondsLeft} seconds.`,
      secondsLeft,
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      jobTitle: true,
      phone: true,
      timezone: true,
      emailVerified: true,
      passwordHash: true,
    },
  });

  // SSO enforcement: reject password login if SSO-only mode
  const ssoConfig = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  if (ssoConfig?.enabled && !ssoConfig.passwordLoginEnabled) {
    throw new UnauthorizedError(
      "Password login is disabled. Please use SSO to sign in.",
    );
  }

  if (!user || !user.passwordHash || !(await verifyPassword(data.password, user.passwordHash))) {
    // Record failed attempt
    const currentAttempt = await prisma.loginAttempt.upsert({
      where: { email },
      create: {
        email,
        failedCount: 1,
        lastFailedAt: new Date(),
      },
      update: {
        failedCount: { increment: 1 },
        lastFailedAt: new Date(),
      },
    });

    const lockoutDuration = getLockoutDuration(currentAttempt.failedCount);
    if (lockoutDuration > 0) {
      await prisma.loginAttempt.update({
        where: { email },
        data: { lockedUntil: new Date(Date.now() + lockoutDuration) },
      });
    }

    throw new UnauthorizedError("Invalid email or password");
  }

  // Reset login attempts on success
  if (attempt) {
    await prisma.loginAttempt.delete({ where: { email } }).catch(() => {});
  }

  // Delete old refresh tokens for this user
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

  const { accessToken, refreshToken } = await createTokenPair(
    prisma,
    user.id,
    user.email,
  );
  const workspaces = await getUserWorkspaces(prisma, user.id);

  const { passwordHash: _, ...userWithoutPassword } = user;

  return { user: userWithoutPassword, accessToken, refreshToken, workspaces };
}

export async function refresh(prisma: PrismaClient, rawToken: string) {
  const tokenHash = hashToken(rawToken);

  // Look up the active refresh token
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: tokenHash },
  });

  if (!storedToken) {
    // Check if this is a rotated token (reuse detection)
    const rotated = await prisma.rotatedRefreshToken.findUnique({
      where: { tokenHash },
    });

    if (rotated) {
      // Token reuse detected — revoke entire family
      await prisma.refreshToken.deleteMany({
        where: { familyId: rotated.familyId },
      });
      await prisma.rotatedRefreshToken.deleteMany({
        where: { familyId: rotated.familyId },
      });
    }

    throw new UnauthorizedError("Invalid refresh token");
  }

  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: storedToken.id } });
    throw new UnauthorizedError("Refresh token expired");
  }

  // Rotate: store old token hash in RotatedRefreshToken, delete old, create new
  await prisma.$transaction([
    prisma.rotatedRefreshToken.create({
      data: {
        tokenHash: storedToken.token,
        familyId: storedToken.familyId,
      },
    }),
    prisma.refreshToken.delete({ where: { id: storedToken.id } }),
  ]);

  const user = await prisma.user.findUnique({
    where: { id: storedToken.userId },
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

  if (!user) {
    throw new UnauthorizedError("User not found");
  }

  const { accessToken, refreshToken } = await createTokenPair(
    prisma,
    user.id,
    user.email,
    storedToken.familyId,
  );

  const workspaces = await getUserWorkspaces(prisma, user.id);

  return { user, accessToken, refreshToken, workspaces };
}

export async function logout(prisma: PrismaClient, rawToken: string) {
  const tokenHash = hashToken(rawToken);
  await prisma.refreshToken
    .delete({ where: { token: tokenHash } })
    .catch(() => {});
}

export async function forgotPassword(prisma: PrismaClient, email: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    // Always return success to prevent email enumeration
    return;
  }

  // Invalidate existing reset tokens
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const token = generateSecureToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    },
  });

  await sendPasswordResetEmail(user.email, token);
}

export async function resetPassword(
  prisma: PrismaClient,
  token: string,
  newPassword: string,
) {
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token },
  });

  if (!resetToken) {
    throw new NotFoundError("Invalid reset token");
  }

  if (resetToken.usedAt) {
    throw new GoneError("Reset token has already been used");
  }

  if (resetToken.expiresAt < new Date()) {
    throw new GoneError("Reset token has expired");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.deleteMany({
      where: { userId: resetToken.userId },
    }),
  ]);
}

export async function verifyEmail(prisma: PrismaClient, token: string) {
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { token },
  });

  if (!verificationToken) {
    throw new NotFoundError("Invalid verification token");
  }

  if (verificationToken.expiresAt < new Date()) {
    throw new GoneError("Verification token has expired");
  }

  // Check if already verified (idempotent)
  const user = await prisma.user.findUnique({
    where: { id: verificationToken.userId },
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

  if (!user) {
    throw new NotFoundError("User not found");
  }

  if (!user.emailVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    });
    user.emailVerified = true;
  }

  // Delete the token
  await prisma.emailVerificationToken.delete({
    where: { id: verificationToken.id },
  });

  return { user };
}

export async function resendVerification(
  prisma: PrismaClient,
  userId: string,
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });

  if (!user) {
    throw new NotFoundError("User not found");
  }

  if (user.emailVerified) {
    return { message: "Email already verified." };
  }

  // Delete existing verification tokens
  await prisma.emailVerificationToken.deleteMany({
    where: { userId: user.id },
  });

  const token = generateSecureToken();
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    },
  });

  await sendVerificationEmail(user.email, token);

  return { message: "Verification email sent." };
}

export async function cleanupExpiredTokensAndAttempts(prisma: PrismaClient) {
  const now = new Date();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  await Promise.all([
    prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.rotatedRefreshToken.deleteMany({
      where: { rotatedAt: { lt: sevenDaysAgo } },
    }),
    prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.emailVerificationToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    prisma.loginAttempt.deleteMany({
      where: { updatedAt: { lt: oneDayAgo } },
    }),
    prisma.taskReminderSent.deleteMany({
      where: { sentAt: { lt: thirtyDaysAgo } },
    }),
    prisma.oidcState.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
  ]);
}
