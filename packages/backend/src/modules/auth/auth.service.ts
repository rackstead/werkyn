import type { PrismaClient } from "@prisma/client";
import type { WorkspaceAdmissionResult } from "@pm/shared";
import { createAccount, waitForAccountRetry } from "./account-creation.js";
import { admitWithInvite } from "../invites/admission.service.js";
import { logger } from "../../utils/logger.js";
import { hashPassword, verifyPassword } from "../../utils/passwords.js";
import { signAccessToken, generateSecureToken } from "../../utils/tokens.js";
import {
  createRefreshSession,
  limitLockWaits,
  refreshTransactionOptions,
  revokeRefreshFamily,
  revokeUserRefreshSessions,
  rotateRefreshToken,
} from "./refresh-sessions.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../utils/mailer.js";
import {
  AppError,
  ConflictError,
  UnauthorizedError,
  NotFoundError,
  GoneError,
  LockedError,
} from "../../utils/errors.js";

export {
  REFRESH_REUSE_GRACE_MS,
  createRefreshSession,
} from "./refresh-sessions.js";

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

export async function getUserWorkspaces(prisma: PrismaClient, userId: string) {
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
) {
  const accessToken = signAccessToken({ sub: userId, email });
  const refreshToken = await createRefreshSession(prisma, userId);
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

  // Admission runs in its own transaction after the account commits; it is
  // never nested in the account-creation retry. A failed or refused join keeps
  // the account and is reported explicitly instead of being swallowed.
  let admission: WorkspaceAdmissionResult | undefined;
  if (data.inviteToken) {
    try {
      admission = await admitWithInvite(prisma, {
        userId: user.id,
        token: data.inviteToken,
      });
    } catch (error) {
      logger.warn({ err: error }, "Workspace admission after registration failed");
      admission = {
        status: "unavailable",
        message:
          "Your account was created, but joining the workspace could not be completed. Open the invitation again to retry.",
      };
    }
  }

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

    // Carry the invitation only when verification is what blocks joining.
    await sendVerificationEmail(
      user.email,
      verificationToken,
      admission?.status === "verification_required"
        ? data.inviteToken
        : undefined,
    );
  }

  // Generate tokens
  const { accessToken, refreshToken } = await createTokenPair(
    prisma,
    user.id,
    user.email,
  );

  const workspaces = await getUserWorkspaces(prisma, user.id);

  return { user, accessToken, refreshToken, workspaces, admission };
}

async function createPasswordAccount(
  prisma: PrismaClient,
  data: { email: string; displayName: string; passwordHash: string },
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // An already committed account permanently rules out bootstrap during
      // normal runtime operation; no account-deletion endpoint exists.
      const existingAccountObserved =
        (await prisma.user.findFirst({ select: { id: true } })) !== null;
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
            { bootstrapAdminEligible: true, existingAccountObserved },
          ),
        {
          isolationLevel: existingAccountObserved
            ? "ReadCommitted"
            : "Serializable",
        },
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

  // A password login replaces the user's other sessions. The user row is held
  // FOR NO KEY UPDATE until the new session commits: a concurrent password
  // change or reset either rejects this login or revokes the new session, and
  // concurrent logins (which find no family to lock on a fresh account) run
  // one after another, so only the last one's session remains. The lock still
  // admits the KEY SHARE checks of in-flight rotations.
  const refreshToken = await prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    const [current] = await tx.$queryRaw<
      Array<{ passwordHash: string | null }>
    >`
      SELECT "passwordHash" FROM "User" WHERE id = ${user.id} FOR NO KEY UPDATE
    `;
    if (current?.passwordHash !== user.passwordHash) return null;
    await revokeUserRefreshSessions(tx, user.id, "login");
    return createRefreshSession(tx, user.id);
  }, refreshTransactionOptions);
  if (!refreshToken) throw new UnauthorizedError("Invalid email or password");

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  const workspaces = await getUserWorkspaces(prisma, user.id);

  const { passwordHash: _, ...userWithoutPassword } = user;

  return { user: userWithoutPassword, accessToken, refreshToken, workspaces };
}

export async function refresh(prisma: PrismaClient, rawToken: string) {
  const rotation = await rotateRefreshToken(prisma, rawToken);
  if (rotation.status === "superseded") {
    // A concurrent request (usually another tab) rotated this cookie first.
    // Nothing was minted or revoked; the client retries with its new cookie.
    throw new ConflictError(
      "This refresh token has already been refreshed by another request",
    );
  }
  if (rotation.status === "busy") {
    // Another operation held this session past the transaction budget and
    // this attempt was rolled back; the same cookie can be retried.
    throw new AppError(
      503,
      "Service Unavailable",
      "This session is busy. Retry the refresh.",
    );
  }
  if (rotation.status === "expired") {
    throw new UnauthorizedError("Refresh token expired");
  }
  if (rotation.status !== "rotated") {
    throw new UnauthorizedError("Invalid refresh token");
  }

  const user = await prisma.user.findUnique({
    where: { id: rotation.userId },
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

  const accessToken = signAccessToken({ sub: user.id, email: user.email });
  const workspaces = await getUserWorkspaces(prisma, user.id);

  return { user, accessToken, refreshToken: rotation.refreshToken, workspaces };
}

// Ends the cookie's whole session (family), whether the presented token is the
// current one or was already rotated. Unknown tokens are a no-op.
export async function logout(prisma: PrismaClient, rawToken: string) {
  await revokeRefreshFamily(prisma, rawToken, "logout");
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

function assertResetTokenUsable<
  T extends { usedAt: Date | null; expiresAt: Date },
>(resetToken: T | null, now: Date): asserts resetToken is T {
  if (!resetToken) throw new NotFoundError("Invalid reset token");
  if (resetToken.usedAt)
    throw new GoneError("Reset token has already been used");
  if (resetToken.expiresAt <= now)
    throw new GoneError("Reset token has expired");
}

export async function resetPassword(
  prisma: PrismaClient,
  token: string,
  newPassword: string,
) {
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });
  // Refuses unusable tokens before the password is hashed. Requests that pass
  // this check together are decided by the claim below.
  assertResetTokenUsable(resetToken, new Date());

  const passwordHash = await hashPassword(newPassword);

  // A reset token is used once. The conditional update claims it in the same
  // transaction that changes the password and revokes the sessions: a request
  // that reaches the token row while another holds it waits, then re-checks
  // usedAt and claims nothing, so it changes nothing and gets the reuse error.
  // The token row is locked before the user row and the user row before the
  // families (refresh-sessions.ts); no path locks a reset token while holding
  // its user.
  await prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    const now = new Date();
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: resetToken.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) {
      assertResetTokenUsable(
        await tx.passwordResetToken.findUnique({
          where: { id: resetToken.id },
          select: { usedAt: true, expiresAt: true },
        }),
        now,
      );
      // Not reached: a usable token is always claimed by the update above.
      throw new GoneError("Reset token has already been used");
    }
    // The claim may have waited for another holder of the token row past the
    // token's expiry; rolling back leaves the token unused.
    if (resetToken.expiresAt <= new Date())
      throw new GoneError("Reset token has expired");
    await tx.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    });
    await revokeUserRefreshSessions(tx, resetToken.userId, "password_reset");
  }, refreshTransactionOptions);
}

function assertVerificationTokenUsable<T extends { expiresAt: Date }>(
  verificationToken: T | null,
  now: Date,
): asserts verificationToken is T {
  if (!verificationToken)
    throw new NotFoundError("Invalid verification token");
  if (verificationToken.expiresAt <= now)
    throw new GoneError("Verification token has expired");
}

export async function verifyEmail(prisma: PrismaClient, token: string) {
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { token },
    select: { id: true, userId: true, expiresAt: true },
  });
  assertVerificationTokenUsable(verificationToken, new Date());

  // Deleting the token claims it: the account is verified only in the
  // transaction whose delete removed it. A concurrent use of the same link,
  // or one whose token a resend replaced meanwhile, changes nothing and gets
  // the same error as a later reuse.
  const user = await prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    const now = new Date();
    const claimed = await tx.emailVerificationToken.deleteMany({
      where: { id: verificationToken.id, expiresAt: { gt: now } },
    });
    if (claimed.count !== 1) {
      assertVerificationTokenUsable(
        await tx.emailVerificationToken.findUnique({
          where: { id: verificationToken.id },
          select: { expiresAt: true },
        }),
        now,
      );
      // Not reached: a usable token is always claimed by the delete above.
      throw new NotFoundError("Invalid verification token");
    }
    if (verificationToken.expiresAt <= new Date())
      throw new GoneError("Verification token has expired");

    const user = await tx.user.findUnique({
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
    if (!user) throw new NotFoundError("User not found");
    // Already verified: the link still succeeds once (idempotent).
    if (!user.emailVerified) {
      await tx.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      user.emailVerified = true;
    }
    return user;
  }, refreshTransactionOptions);

  return { user };
}

export async function resendVerification(
  prisma: PrismaClient,
  userId: string,
  inviteToken?: string,
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

  // Only an existing invitation is carried into the verification link.
  const invite = inviteToken
    ? await prisma.workspaceInvite.findUnique({
        where: { token: inviteToken },
        select: { token: true },
      })
    : null;
  await sendVerificationEmail(user.email, token, invite?.token);

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
    // A family without tokens can never mint again; keep it a week for reuse
    // detection and revocation records, then remove it.
    prisma.refreshTokenFamily.deleteMany({
      where: {
        tokens: { none: {} },
        OR: [
          { revokedAt: { lt: sevenDaysAgo } },
          { revokedAt: null, createdAt: { lt: sevenDaysAgo } },
        ],
      },
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
