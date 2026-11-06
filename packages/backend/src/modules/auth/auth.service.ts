import type { PrismaClient } from "@prisma/client";
import type { WorkspaceAdmissionResult } from "@pm/shared";
import { createAccount, waitForAccountRetry } from "./account-creation.js";
import { admitWithInvite } from "../invites/admission.service.js";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";
import { hashPassword, verifyLoginPassword } from "../../utils/passwords.js";
import { loginThrottle } from "./login-throttle.js";
import {
  credentialMatches,
  deviceCookieAfterSignIn,
  deviceToken,
} from "./login-device.js";
import {
  signAccessToken,
  generateSecureToken,
  hashToken,
} from "../../utils/tokens.js";
import {
  isBusy,
  limitLockWaits,
  refreshTransactionOptions,
  revokeRefreshFamily,
  revokeUserRefreshSessions,
  rotateRefreshToken,
  startRefreshSession,
} from "./refresh-sessions.js";
import { endSessions } from "../realtime/realtime.service.js";
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
  TooManyRequestsError,
} from "../../utils/errors.js";

export {
  REFRESH_REUSE_GRACE_MS,
  createRefreshSession,
  startRefreshSession,
} from "./refresh-sessions.js";

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
  const { refreshToken, familyId } = await startRefreshSession(prisma, userId);
  const accessToken = signAccessToken({ sub: userId, email, sid: familyId });
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
        tokenHash: hashToken(verificationToken),
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

/**
 * The account whose password this is, or null. An unknown address or an
 * account without a usable password does the same Argon2id work as a wrong
 * password for a real account (verifyLoginPassword).
 */
async function passwordSignInUser(
  prisma: PrismaClient,
  email: string,
  password: string,
) {
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
  const valid = await verifyLoginPassword(password, user?.passwordHash);
  return valid ? user : null;
}

export async function login(
  prisma: PrismaClient,
  data: { email: string; password: string },
  /** The login_device cookie the browser sent, if any (login-device.ts). */
  deviceCookie?: string,
) {
  const email = data.email.toLowerCase();

  // SSO enforcement: reject password login if SSO-only mode. This is the same
  // for every address, so it is decided before an attempt is counted.
  const ssoConfig = await prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  if (ssoConfig?.enabled && !ssoConfig.passwordLoginEnabled) {
    throw new UnauthorizedError(
      "Password login is disabled. Please use SSO to sign in.",
    );
  }

  // Failed-attempt backoff (login-throttle.ts). Without a device token, every
  // address, with or without an account, is counted and answered alike, so
  // neither the refusal nor its Retry-After tells whether an account exists.
  // A browser holding a valid token for this address (it signed in to it
  // before; only an account's password can mint one) is counted in its own
  // lane, so failures others send for the address do not hold it off. The
  // token must also have been minted under the account's current password:
  // a password change or reset ends every token. That lookup runs only for a
  // token minted for this very address, which no one probing other people's
  // addresses can present.
  const throttle = loginThrottle();
  const token = deviceToken(deviceCookie, email);
  const device =
    token &&
    credentialMatches(
      token,
      (
        await prisma.user.findUnique({
          where: { email },
          select: { passwordHash: true },
        })
      )?.passwordHash,
    )
      ? token.id
      : null;
  const addressMark = device ? await throttle.addressMark(prisma, email) : null;
  const admission = device
    ? await throttle.admitDevice(prisma, device)
    : await throttle.admit(prisma, email);
  if (!admission.admitted) {
    throw new TooManyRequestsError(
      `Too many sign-in attempts. Try again in ${admission.retryAfter} ${admission.retryAfter === 1 ? "second" : "seconds"}.`,
      admission.retryAfter,
    );
  }

  const { ticket } = admission;
  // An attempt whose outcome was not decided (its password could not be
  // checked, or its sign-in could not be completed) is not a failure.
  const undecided = async (error: unknown): Promise<never> => {
    await throttle.unchecked(prisma, ticket).catch((uncountError) => {
      logger.warn({ err: uncountError }, "Could not uncount an undecided sign-in attempt");
    });
    throw error;
  };

  const user = await passwordSignInUser(prisma, email, data.password).catch(
    undecided,
  );
  if (!user) throw new UnauthorizedError("Invalid email or password");

  // A password login replaces the user's other sessions. The user row is held
  // FOR NO KEY UPDATE until the new session commits: a concurrent password
  // change or reset either rejects this login or revokes the new session, and
  // concurrent logins (which find no family to lock on a fresh account) run
  // one after another, so only the last one's session remains. The lock still
  // admits the KEY SHARE checks of in-flight rotations.
  const signIn = await prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    const [current] = await tx.$queryRaw<
      Array<{ passwordHash: string | null }>
    >`
      SELECT "passwordHash" FROM "User" WHERE id = ${user.id} FOR NO KEY UPDATE
    `;
    if (current?.passwordHash !== user.passwordHash) return null;
    const replaced = await revokeUserRefreshSessions(tx, user.id, "login");
    return { replaced, session: await startRefreshSession(tx, user.id) };
  }, refreshTransactionOptions).catch(undecided);
  // The password stopped being the account's meanwhile: a counted failure.
  if (!signIn) throw new UnauthorizedError("Invalid email or password");
  // The replaced sessions' sockets close now that their revocation committed.
  endSessions(signIn.replaced);
  // Only a completed sign-in clears failures, and only those admitted up to
  // it (for a trusted device, also the address's failures admitted before it
  // started); the session stands even if clearing them fails.
  for (const cleared of addressMark ? [ticket, addressMark] : [ticket])
    await throttle.succeeded(prisma, cleared).catch((clearError) => {
      logger.warn({ err: clearError }, "Could not clear failed sign-ins after a sign-in");
    });
  const { refreshToken, familyId } = signIn.session;

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    sid: familyId,
  });
  const workspaces = await getUserWorkspaces(prisma, user.id);

  const { passwordHash: _, ...userWithoutPassword } = user;

  return {
    user: userWithoutPassword,
    accessToken,
    refreshToken,
    workspaces,
    // Bound to the hash this sign-in was checked and committed against (a
    // successful check means the account has one).
    deviceCookie: deviceCookieAfterSignIn(deviceCookie, email, user.passwordHash!),
  };
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
  if (rotation.status === "reused") {
    // A replayed rotated token ended its session; so do its sockets.
    endSessions([rotation.familyId]);
    throw new UnauthorizedError("Invalid refresh token");
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

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    sid: rotation.familyId,
  });
  const workspaces = await getUserWorkspaces(prisma, user.id);

  return { user, accessToken, refreshToken: rotation.refreshToken, workspaces };
}

// Ends the cookie's whole session (family), whether the presented token is the
// current one or was already rotated, and closes that session's sockets. The
// account's other sessions are untouched. Unknown tokens are a no-op.
export async function logout(prisma: PrismaClient, rawToken: string) {
  const familyId = await revokeRefreshFamily(prisma, rawToken, "logout");
  if (familyId) endSessions([familyId]);
}

// Password-reset requests are answered before their work runs, so the
// response takes the same time whether or not the address has an account:
// looking the account up, replacing its link and waiting for the mail server
// all happen afterwards. How long work stays in progress depends on whether
// the account exists (mail is sent only then), so no admission rule may
// depend on work in progress: that would be an account oracle and would
// drop other users' requests behind a shared proxy address.
//
// Work is bounded per address instead, after the answer: a request for an
// address whose earlier request is still in progress adds nothing (that one
// sends the newest link), and an account gets at most one new link per
// PASSWORD_RESET_COOLDOWN_SECONDS (forgotPassword). Work for an address
// without an account ends after one lookup. As a memory guard only, each
// process starts at most PASSWORD_RESET_REQUESTS_PER_MINUTE requests,
// counted by request alone before any lookup; past it every request, for
// any address, is answered 429 with Retry-After. The default (6,000) takes
// about 600 client addresses at the route limit to reach. Work in progress
// is drained when the server closes (drainPasswordResetRequests); it is not
// durable.
const RESET_REQUEST_WINDOW_MS = 60_000;
const pendingResetRequests = new Map<string, Promise<void>>();
let resetWindowStart = 0;
let resetWindowCount = 0;
let resetWindowRefused = 0;

/** Seconds until a request can be started, or 0 after counting this one. */
function resetRequestWait(now: number): number {
  if (now - resetWindowStart >= RESET_REQUEST_WINDOW_MS) {
    if (resetWindowRefused > 0)
      logger.warn(
        { event: "password_reset_budget_exhausted", refused: resetWindowRefused },
        "Password reset requests were refused: more than the per-minute ceiling arrived",
      );
    resetWindowStart = now;
    resetWindowCount = 0;
    resetWindowRefused = 0;
  }
  if (resetWindowCount >= env.PASSWORD_RESET_REQUESTS_PER_MINUTE) {
    resetWindowRefused++;
    return Math.max(1, Math.ceil((resetWindowStart + RESET_REQUEST_WINDOW_MS - now) / 1000));
  }
  resetWindowCount++;
  return 0;
}

export function requestPasswordReset(prisma: PrismaClient, email: string) {
  const wait = resetRequestWait(Date.now());
  if (wait > 0) {
    if (resetWindowRefused === 1)
      logger.warn(
        { event: "password_reset_budget_exhausted" },
        "Too many password reset requests this minute; refusing until the next",
      );
    throw new TooManyRequestsError(
      `Too many password reset requests right now. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.`,
      wait,
    );
  }
  const address = email.toLowerCase();
  if (pendingResetRequests.has(address)) return;
  const work: Promise<void> = forgotPassword(prisma, address)
    .catch((error) => {
      logger.error({ err: error }, "Password reset request failed");
    })
    .finally(() => {
      pendingResetRequests.delete(address);
    });
  pendingResetRequests.set(address, work);
}

/** Resolves once no password-reset request work is in progress. */
export async function settlePasswordResetRequests() {
  while (pendingResetRequests.size > 0)
    await Promise.allSettled([...pendingResetRequests.values()]);
}

// When closing the server must be done; set by the shutdown handler from
// its overall deadline (server.ts). Other closes (tests) allow 5 seconds.
const DEFAULT_RESET_DRAIN_MS = 5_000;
let resetDrainDeadline: number | undefined;

export function setPasswordResetDrainDeadline(deadline: number) {
  resetDrainDeadline = deadline;
}

export function passwordResetDrainDeadline() {
  return resetDrainDeadline ?? Date.now() + DEFAULT_RESET_DRAIN_MS;
}

/**
 * Waits for password-reset work in progress until `deadline` (epoch ms), so
 * the database stays open for it while the server closes. Work still running
 * then is logged with its count and abandoned: its links may not arrive.
 */
export async function drainPasswordResetRequests(deadline: number) {
  if (pendingResetRequests.size === 0) return;
  logger.info(
    { event: "password_reset_requests_draining", pending: pendingResetRequests.size },
    "Waiting for password reset requests in progress",
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  try {
    await Promise.race([settlePasswordResetRequests(), expired]);
  } finally {
    clearTimeout(timer);
  }
  if (pendingResetRequests.size > 0)
    logger.warn(
      { event: "password_reset_requests_abandoned", abandoned: pendingResetRequests.size },
      "Shutdown abandoned password reset requests in progress; their links may not arrive",
    );
}

export async function forgotPassword(prisma: PrismaClient, email: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    // Always return success to prevent email enumeration
    return;
  }

  // At most one new link per account per cooldown: a link made moments ago
  // is still the newest. The requester was already answered alike. Links are
  // kept until they expire (1 hour, the longest cooldown allowed), so the
  // newest one's creation time is always there to check. A password change
  // deletes the unused links and so ends the cooldown early; a completed
  // reset keeps its used link, so the cooldown still runs from it.
  if (env.PASSWORD_RESET_COOLDOWN_SECONDS > 0) {
    const recent = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        createdAt: {
          gt: new Date(Date.now() - env.PASSWORD_RESET_COOLDOWN_SECONDS * 1000),
        },
      },
      select: { id: true },
    });
    if (recent) return;
  }

  // Invalidate existing reset tokens
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, usedAt: null },
  });

  const token = generateSecureToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    },
  });

  await sendPasswordResetEmail(user.email, token);
}

// A token transaction that waited past the lock timeout or its budget was
// rolled back without using the token, so the same link can be retried.
function retryLinkWhenBusy(error: unknown): never {
  if (isBusy(error))
    throw new AppError(
      503,
      "Service Unavailable",
      "This link is busy. Try again in a moment.",
    );
  throw error;
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
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });
  // Refuses unusable tokens before the password is hashed. Requests that pass
  // this check together are decided by the claim below.
  assertResetTokenUsable(resetToken, new Date());

  const passwordHash = await hashPassword(newPassword);

  // A reset token is used once, and a successful reset ends the account's
  // other unused links. Resets of one account run one at a time: the
  // transaction first locks the user row (FOR NO KEY UPDATE, as password
  // login and change do), then claims the token with a conditional update in
  // the same transaction that changes the password and revokes the sessions.
  // A request whose token was used or removed meanwhile claims nothing,
  // changes nothing and gets the reuse or invalid-link error. Lock order: user
  // row, reset tokens, families (refresh-sessions.ts). The statements that
  // lock reset tokens without the user row (forgot-password and the cleanup
  // job deleting tokens) never wait for a user row.
  const resetting = prisma.$transaction(async (tx) => {
    await limitLockWaits(tx);
    await tx.$queryRaw`
      SELECT id FROM "User" WHERE id = ${resetToken.userId} FOR NO KEY UPDATE
    `;
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
    // The lock waits may have lasted past the token's expiry; rolling back
    // leaves the token unused.
    if (resetToken.expiresAt <= new Date())
      throw new GoneError("Reset token has expired");
    // The account's other unused links are deleted; a later use of one is
    // answered 404, like a link replaced by forgot-password. No other reset
    // can hold one, since it would hold the user row. A locked row is being
    // deleted by forgot-password or the cleanup job and is skipped rather
    // than waited for, so that the two deletes never wait for each other.
    await tx.$executeRaw`
      DELETE FROM "PasswordResetToken"
      WHERE id IN (
        SELECT id FROM "PasswordResetToken"
        WHERE "userId" = ${resetToken.userId} AND "usedAt" IS NULL
          AND id <> ${resetToken.id}
        FOR UPDATE SKIP LOCKED
      )
    `;
    // A skipped deletion has not committed and can still roll back. Refuse
    // rather than leave that pre-existing sibling usable after success.
    // This read takes no row locks, so deletes never wait for one another.
    const remaining = await tx.passwordResetToken.findFirst({
      where: { userId: resetToken.userId, usedAt: null },
      select: { id: true },
    });
    if (remaining) {
      throw new AppError(
        503,
        "Service Unavailable",
        "This link is busy. Try again in a moment.",
      );
    }
    await tx.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    });
    return revokeUserRefreshSessions(tx, resetToken.userId, "password_reset");
  }, refreshTransactionOptions);
  endSessions(await resetting.catch(retryLinkWhenBusy));
}

function assertVerificationTokenUsable<T extends { expiresAt: Date }>(
  verificationToken: T | null,
  now: Date,
): asserts verificationToken is T {
  if (!verificationToken) throw new NotFoundError("Invalid verification token");
  if (verificationToken.expiresAt <= now)
    throw new GoneError("Verification token has expired");
}

export async function verifyEmail(prisma: PrismaClient, token: string) {
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true },
  });
  assertVerificationTokenUsable(verificationToken, new Date());

  // Deleting the token claims it: the account is verified only in the
  // transaction whose delete removed it. A concurrent use of the same link,
  // or one whose token a resend replaced meanwhile, changes nothing and gets
  // the same error as a later reuse.
  const verifying = prisma.$transaction(async (tx) => {
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
  const user = await verifying.catch(retryLinkWhenBusy);

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
      tokenHash: hashToken(token),
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
    loginThrottle().prune(prisma),
    prisma.taskReminderSent.deleteMany({
      where: { sentAt: { lt: thirtyDaysAgo } },
    }),
    prisma.oidcState.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
  ]);
}
