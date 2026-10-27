import type { PrismaClient } from "@prisma/client";
import type { CreateInviteInput } from "@pm/shared";
import crypto from "node:crypto";
import { GoneError, NotFoundError } from "../../utils/errors.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";
import { assertCurrentAdmin } from "./admission.service.js";

export async function createInvite(
  prisma: PrismaClient,
  workspaceId: string,
  actorId: string,
  data: CreateInviteInput,
) {
  const token = crypto.randomBytes(32).toString("hex");

  // Invitation writers follow the workspace lock order used by admission.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    await assertCurrentAdmin(tx, workspaceId, actorId);
    return tx.workspaceInvite.create({
      data: {
        workspaceId,
        email: data.email,
        role: data.role,
        token,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        maxUses: data.maxUses ?? null,
      },
    });
  });
}

export async function listInvites(
  prisma: PrismaClient,
  workspaceId: string,
) {
  const now = new Date();

  return prisma.workspaceInvite.findMany({
    where: {
      workspaceId,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function revokeInvite(
  prisma: PrismaClient,
  inviteId: string,
  actorId: string,
) {
  // Unlocked discovery only selects the workspace to lock.
  const discovered = await prisma.workspaceInvite.findUnique({
    where: { id: inviteId },
    select: { workspaceId: true },
  });
  if (!discovered) throw new NotFoundError("Invite not found");

  await withWorkspaceLock(
    prisma,
    discovered.workspaceId,
    async (tx) => {
      await assertCurrentAdmin(
        tx,
        discovered.workspaceId,
        actorId,
        "Only admins can revoke invites",
      );
      // Deleting the invite cascades to its pending admission requests.
      const removed = await tx.workspaceInvite.deleteMany({
        where: { id: inviteId, workspaceId: discovered.workspaceId },
      });
      if (removed.count !== 1) throw new NotFoundError("Invite not found");
    },
    {
      onMissing: () => {
        throw new NotFoundError("Invite not found");
      },
    },
  );
}

export async function getInviteByToken(
  prisma: PrismaClient,
  token: string,
) {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { token },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, logoUrl: true },
      },
    },
  });

  if (!invite) {
    throw new NotFoundError("Invite not found or has been revoked");
  }

  const now = new Date();
  if (invite.expiresAt && invite.expiresAt < now) {
    throw new GoneError("This invite has expired");
  }

  if (invite.maxUses && invite.useCount >= invite.maxUses) {
    throw new GoneError("This invite has reached its usage limit");
  }

  return {
    id: invite.id,
    workspace: invite.workspace,
    role: invite.role,
    email: invite.email,
  };
}
