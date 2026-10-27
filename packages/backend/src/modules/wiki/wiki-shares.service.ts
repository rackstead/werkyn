import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import bcrypt from "bcrypt";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../../utils/errors.js";
import {
  hasShareGrant,
  updateShareRevision,
} from "../../utils/share-grants.js";

export async function createShare(
  prisma: PrismaClient,
  pageId: string,
  createdById: string,
  password?: string,
) {
  // Check for existing share
  const existing = await prisma.wikiPageShare.findUnique({
    where: { pageId },
  });
  if (existing) {
    return existing;
  }

  const token = randomUUID();
  const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

  return prisma.wikiPageShare.create({
    data: {
      pageId,
      token,
      passwordHash,
      createdById,
    },
  });
}

export async function getShare(prisma: PrismaClient, pageId: string) {
  return prisma.wikiPageShare.findUnique({
    where: { pageId },
  });
}

export async function updateShare(
  prisma: PrismaClient,
  shareId: string,
  data: { enabled?: boolean; password?: string | null },
) {
  const updateData: Record<string, unknown> = {};
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.password !== undefined) {
    updateData.passwordHash = data.password
      ? await bcrypt.hash(data.password, 10)
      : null;
  }

  return updateShareRevision(
    () => prisma.wikiPageShare.findUnique({ where: { id: shareId } }),
    (existing, updatedAt) =>
      prisma.wikiPageShare.update({
        where: { id: shareId, updatedAt: existing.updatedAt },
        data: { ...updateData, updatedAt },
      }),
    () => new NotFoundError("Share not found"),
  );
}

export async function deleteShare(prisma: PrismaClient, shareId: string) {
  const existing = await prisma.wikiPageShare.findUnique({
    where: { id: shareId },
  });
  if (!existing) throw new NotFoundError("Share not found");

  await prisma.wikiPageShare.delete({ where: { id: shareId } });
}

export async function getPublicPage(
  prisma: PrismaClient,
  token: string,
  grant?: string,
) {
  const share = await prisma.wikiPageShare.findUnique({
    where: { token },
  });

  if (!share || !share.enabled) {
    throw new NotFoundError("Shared page not found");
  }

  if (share.passwordHash && !hasShareGrant(grant, "wiki", share)) {
    return { page: null, hasPassword: true, authorized: false as const };
  }

  const authorizedShare = await prisma.wikiPageShare.findUnique({
    where: { id: share.id, updatedAt: share.updatedAt, enabled: true },
    select: {
      page: {
        select: {
          id: true,
          title: true,
          content: true,
          icon: true,
          updatedAt: true,
          createdBy: { select: { displayName: true } },
          lastEditedBy: { select: { displayName: true } },
        },
      },
    },
  });
  if (!authorizedShare) throw new NotFoundError("Shared page not found");

  return {
    page: authorizedShare.page,
    hasPassword: !!share.passwordHash,
    authorized: true as const,
  };
}

export async function validateShareAccess(
  prisma: PrismaClient,
  token: string,
  password: string,
) {
  const share = await prisma.wikiPageShare.findUnique({
    where: { token },
  });

  if (!share || !share.enabled) {
    throw new NotFoundError("Shared page not found");
  }

  if (!share.passwordHash) {
    return share;
  }

  const valid = await bcrypt.compare(password, share.passwordHash);
  if (!valid) {
    throw new ForbiddenError("Invalid password");
  }

  const current = await prisma.wikiPageShare.findUnique({
    where: { id: share.id, updatedAt: share.updatedAt, enabled: true },
  });
  if (!current)
    throw new ConflictError("Share changed; please verify its password again");
  return current;
}
