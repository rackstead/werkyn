import type { Prisma, PrismaClient, WorkspaceInvite } from "@prisma/client";
import type {
  WorkspaceAdmissionCheck,
  WorkspaceAdmissionDenialReason,
  WorkspaceAdmissionResult,
} from "@pm/shared";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  GoneError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";

// The single admission gate for joining an existing workspace through an
// invitation. Registration-with-invite, authenticated acceptance and
// administrator approval all decide here, under the workspace lock, from the
// database's current user, invitation and policy. See utils/workspace-lock.ts
// for the lock order every participant follows.

const DENIAL_MESSAGES: Record<WorkspaceAdmissionDenialReason, string> = {
  not_found: "Invite not found or has been revoked",
  expired: "This invite has expired",
  exhausted: "This invite has reached its usage limit",
  disabled: "Invites are currently disabled for this workspace",
  email_mismatch: "This invite is restricted to a specific email",
  domain_not_allowed: "Your email domain is not allowed for this workspace",
  member_limit: "This workspace has reached its member limit",
};

const DENIAL_STATUS: Record<WorkspaceAdmissionDenialReason, number> = {
  not_found: 404,
  expired: 410,
  exhausted: 410,
  disabled: 403,
  email_mismatch: 403,
  domain_not_allowed: 403,
  member_limit: 403,
};

const workspaceSummarySelect = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.WorkspaceSelect;

function denied(
  reason: WorkspaceAdmissionDenialReason,
): WorkspaceAdmissionResult {
  return { status: "denied", reason, message: DENIAL_MESSAGES[reason] };
}

export function admissionDenialError(
  reason: WorkspaceAdmissionDenialReason,
): AppError {
  const message = DENIAL_MESSAGES[reason];
  switch (DENIAL_STATUS[reason]) {
    case 404:
      return new NotFoundError(message);
    case 410:
      return new GoneError(message);
    default:
      return new ForbiddenError(message);
  }
}

/** Lowercase, trim and drop leading "@"; empty means malformed. */
export function normalizeEmailDomain(domain: string) {
  return domain.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Validates domains written through settings. Malformed values are rejected
 * rather than dropped, so a restriction can never silently become empty.
 */
export function normalizeAllowedEmailDomains(domains: string[]) {
  const normalized = domains.map(normalizeEmailDomain);
  const invalid = normalized.findIndex(
    (domain) => !domain || /[\s@/\\]/.test(domain),
  );
  if (invalid >= 0) {
    throw new ValidationError("Validation failed", [
      {
        field: `allowedEmailDomains.${invalid}`,
        message: "Enter a domain such as example.com",
      },
    ]);
  }
  return [...new Set(normalized)];
}

// "status" evaluates the same rules read-only and never writes.
type Mode = "applicant" | "approval" | "status";

/**
 * Evaluates and applies admission for one user through one invite. Must run in
 * a transaction that already holds the invite's workspace lock. Only the final
 * join (or pending-request upsert) writes, so every denial has no side effect.
 */
async function decide(
  tx: Prisma.TransactionClient,
  invite: WorkspaceInvite,
  userId: string,
  mode: Mode,
): Promise<WorkspaceAdmissionCheck> {
  const workspaceId = invite.workspaceId;
  const workspace = await tx.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: workspaceSummarySelect,
  });

  const existing = await tx.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  if (existing) {
    // Idempotent retry: no role change and no additional invitation use.
    if (mode !== "status")
      await tx.workspaceAdmissionRequest.deleteMany({
        where: { userId, workspaceId },
      });
    return {
      status: "joined",
      workspace,
      role: existing.role,
      alreadyMember: true,
    };
  }

  // Evaluate expiry after any wait for the workspace lock.
  const now = new Date();
  const settings = await tx.workspaceSettings.findUnique({
    where: { workspaceId },
    select: {
      invitesEnabled: true,
      requireAdminApproval: true,
      allowedEmailDomains: true,
      maxMembers: true,
    },
  });
  const policy = settings ?? {
    invitesEnabled: true,
    requireAdminApproval: false,
    allowedEmailDomains: [],
    maxMembers: null,
  };

  if (!policy.invitesEnabled) return denied("disabled");
  if (invite.expiresAt && invite.expiresAt <= now) return denied("expired");
  // Explicit null checks: a legacy zero limit denies instead of meaning "none".
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
    return denied("exhausted");
  }

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user) throw new NotFoundError("User not found");
  const email = user.email.toLowerCase();
  if (invite.email && invite.email.toLowerCase() !== email) {
    return denied("email_mismatch");
  }
  const domain = email.split("@").pop() ?? "";
  if (
    policy.allowedEmailDomains.length > 0 &&
    !policy.allowedEmailDomains.some((d) => normalizeEmailDomain(d) === domain)
  ) {
    return denied("domain_not_allowed");
  }
  // Ownership proof is required whenever the invitation or workspace restricts
  // who may join; unrestricted open invitations keep their existing behavior.
  const restricted =
    Boolean(invite.email) || policy.allowedEmailDomains.length > 0;
  if (restricted && !user.emailVerified) {
    return { status: "verification_required", workspace, email: user.email };
  }

  if (mode === "status" && policy.requireAdminApproval) {
    // Report a pending request without creating one; a declined request is
    // gone and is reported as not pending rather than silently re-created.
    const request = await tx.workspaceAdmissionRequest.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { id: true, createdAt: true },
    });
    return request
      ? {
          status: "approval_pending",
          workspace,
          requestId: request.id,
          requestedAt: request.createdAt.toISOString(),
        }
      : { status: "not_pending", workspace };
  }

  if (mode === "applicant" && policy.requireAdminApproval) {
    // A request is bound to the exact invitation the administrator reviews.
    // Asking through a different invitation replaces the request under a new
    // id, so a decision taken on the earlier one (and the role it showed) can
    // no longer apply. The same invitation keeps its request and position.
    // A pending request reserves neither a seat nor an invitation use.
    await tx.workspaceAdmissionRequest.deleteMany({
      where: { userId, workspaceId, inviteId: { not: invite.id } },
    });
    const request = await tx.workspaceAdmissionRequest.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      create: { userId, workspaceId, inviteId: invite.id },
      update: {},
      select: { id: true, createdAt: true },
    });
    return {
      status: "approval_pending",
      workspace,
      requestId: request.id,
      requestedAt: request.createdAt.toISOString(),
    };
  }

  if (policy.maxMembers !== null) {
    const members = await tx.workspaceMember.count({ where: { workspaceId } });
    if (members >= policy.maxMembers) return denied("member_limit");
  }

  // Without required approval, every rule above admits this account now
  // (a request left from an earlier approval policy no longer applies).
  if (mode === "status") return { status: "ready", workspace };

  const used = await tx.workspaceInvite.updateMany({
    where:
      invite.maxUses === null
        ? { id: invite.id, workspaceId, maxUses: null }
        : {
            id: invite.id,
            workspaceId,
            maxUses: invite.maxUses,
            useCount: { lt: invite.maxUses },
          },
    data: { useCount: { increment: 1 } },
  });
  if (used.count !== 1) return denied("exhausted");

  // Use, request resolution and membership commit together or not at all.
  await tx.workspaceAdmissionRequest.deleteMany({
    where: { userId, workspaceId },
  });
  await tx.workspaceMember.create({
    data: { userId, workspaceId, role: invite.role },
  });
  return {
    status: "joined",
    workspace,
    role: invite.role,
    alreadyMember: false,
  };
}

/**
 * Applicant path shared by registration and authenticated acceptance. The
 * token lookup outside the transaction only discovers which workspace to lock;
 * the invitation is read again after the lock.
 */
export async function admitWithInvite(
  prisma: PrismaClient,
  { userId, token }: { userId: string; token: string },
): Promise<WorkspaceAdmissionResult> {
  const discovered = await prisma.workspaceInvite.findUnique({
    where: { token },
    select: { workspaceId: true },
  });
  if (!discovered) return denied("not_found");

  return withWorkspaceLock(
    prisma,
    discovered.workspaceId,
    async (tx) => {
      const invite = await tx.workspaceInvite.findFirst({
        where: { token, workspaceId: discovered.workspaceId },
      });
      if (!invite) return denied("not_found");
      return (await decide(tx, invite, userId, "applicant")) as WorkspaceAdmissionResult;
    },
    // The workspace, and with it the invite, was deleted after discovery.
    { onMissing: () => denied("not_found") },
  );
}

/**
 * Read-only status for the current account: current refusals, verification,
 * membership or a pending request, using the same rules as admission. It takes
 * no lock and writes nothing, so checking never creates or revives a request.
 */
export async function checkAdmission(
  prisma: PrismaClient,
  { userId, token }: { userId: string; token: string },
): Promise<WorkspaceAdmissionCheck> {
  const invite = await prisma.workspaceInvite.findUnique({ where: { token } });
  if (!invite) return denied("not_found");
  return decide(prisma, invite, userId, "status");
}

export async function assertCurrentAdmin(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actorId: string,
  message = "Insufficient permissions",
) {
  const actor = await tx.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: actorId, workspaceId } },
    select: { role: true },
  });
  if (actor?.role !== "ADMIN") throw new ForbiddenError(message);
}

export async function listAdmissionRequests(
  prisma: PrismaClient,
  workspaceId: string,
) {
  return prisma.workspaceAdmissionRequest.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          emailVerified: true,
        },
      },
      invite: {
        select: {
          id: true,
          role: true,
          email: true,
          expiresAt: true,
          maxUses: true,
          useCount: true,
        },
      },
    },
  });
}

/**
 * Administrator approval rechecks the current approver, request, invitation,
 * applicant and policy under the workspace lock, then joins through the same
 * decision as the applicant path. Any refusal leaves the request untouched.
 */
export async function approveAdmissionRequest(
  prisma: PrismaClient,
  { workspaceId, requestId, actorId }: {
    workspaceId: string;
    requestId: string;
    actorId: string;
  },
) {
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertCurrentAdmin(tx, workspaceId, actorId);
    const request = await tx.workspaceAdmissionRequest.findFirst({
      where: { id: requestId, workspaceId },
      include: { invite: true },
    });
    if (!request) throw new NotFoundError("Join request not found");
    const result = await decide(tx, request.invite, request.userId, "approval");
    if (result.status === "denied") throw admissionDenialError(result.reason);
    if (result.status === "verification_required") {
      throw new ForbiddenError(
        "The applicant must verify their email address before approval",
      );
    }
    if (result.status !== "joined") {
      throw new ConflictError("Join request could not be approved");
    }
    return { ...result, userId: request.userId };
  });
}

export async function rejectAdmissionRequest(
  prisma: PrismaClient,
  { workspaceId, requestId, actorId }: {
    workspaceId: string;
    requestId: string;
    actorId: string;
  },
) {
  await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertCurrentAdmin(tx, workspaceId, actorId);
    const removed = await tx.workspaceAdmissionRequest.deleteMany({
      where: { id: requestId, workspaceId },
    });
    if (removed.count !== 1) throw new NotFoundError("Join request not found");
  });
}
