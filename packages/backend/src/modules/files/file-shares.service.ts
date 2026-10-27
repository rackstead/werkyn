import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { NotFoundError, ForbiddenError } from "../../utils/errors.js";
import {
  assertFileAccess,
  fileAccessRole,
  fileReadWhere,
  type AccessContext,
} from "./file-access.js";
import { notify } from "../../utils/notify.js";

// ─── Member Shares ──────────────────────────────────────

export async function createFileShares(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  userIds: string[],
  sharedById: string,
  ctx: AccessContext,
  fastify?: FastifyInstance,
) {
  // Verify access to all files
  for (const fileId of fileIds) {
    await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);
  }

  // Verify recipients are workspace members
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: userIds } },
    select: { userId: true },
  });
  const memberSet = new Set(members.map((m) => m.userId));
  for (const uid of userIds) {
    if (!memberSet.has(uid)) {
      throw new ForbiddenError(`User ${uid} is not a workspace member`);
    }
  }

  const data = fileIds.flatMap((fileId) =>
    userIds
      .filter((uid) => uid !== sharedById) // Don't share with yourself
      .map((uid) => ({
        workspaceId,
        fileId,
        sharedById,
        sharedWithId: uid,
      })),
  );

  if (data.length === 0) return { count: 0 };

  const result = await prisma.fileShare.createMany({
    data,
    skipDuplicates: true,
  });

  // Send notifications to recipients
  if (fastify && result.count > 0) {
    const sharer = await prisma.user.findUnique({
      where: { id: sharedById },
      select: { displayName: true },
    });
    const sharerName = sharer?.displayName ?? "Someone";

    // Build notification title
    let title: string;
    if (fileIds.length === 1) {
      const file = await prisma.file.findUnique({
        where: { id: fileIds[0] },
        select: { name: true },
      });
      title = `${sharerName} shared "${file?.name ?? "a file"}" with you`;
    } else {
      title = `${sharerName} shared ${fileIds.length} files with you`;
    }

    const recipients = userIds.filter((uid) => uid !== sharedById);
    if (recipients.length > 0) {
      notify(prisma, fastify, {
        recipients,
        type: "FILE_SHARED",
        title,
        data: { fileId: fileIds[0], workspaceId },
        excludeUserId: sharedById,
      }).catch(() => {});
    }
  }

  return result;
}

export async function removeFileShare(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  userId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  return prisma.fileShare.deleteMany({
    where: { workspaceId, fileId, sharedWithId: userId },
  });
}

export async function getFileShares(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  return prisma.fileShare.findMany({
    where: { workspaceId, fileId },
    include: {
      sharedWith: {
        select: { id: true, displayName: true, avatarUrl: true, email: true },
      },
      sharedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function listSharedWithMe(
  prisma: PrismaClient,
  workspaceId: string,
  ctx: AccessContext,
  cursor?: string,
  limit = 50,
) {
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });
  const userId = ctx.userId;
  const shares = await prisma.fileShare.findMany({
    where: {
      workspaceId,
      sharedWithId: userId,
      file: { AND: [readable], trashedAt: null },
    },
    include: {
      file: {
        include: {
          uploadedBy: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
      sharedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = shares.length > limit;
  const data = hasMore ? shares.slice(0, limit) : shares;

  return {
    data,
    nextCursor: hasMore ? data[data.length - 1].id : null,
  };
}

export async function listSharedByMe(
  prisma: PrismaClient,
  workspaceId: string,
  ctx: AccessContext,
  _cursor?: string,
  _limit = 50,
) {
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });
  const userId = ctx.userId;
  // Query both member shares and public link shares in parallel
  const [memberShares, linkShareFiles] = await Promise.all([
    prisma.fileShare.findMany({
      where: {
        workspaceId,
        sharedById: userId,
        file: { AND: [readable], trashedAt: null },
      },
      include: {
        file: {
          include: {
            uploadedBy: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        sharedWith: {
          select: { id: true, displayName: true, avatarUrl: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.fileShareLinkFile.findMany({
      where: {
        shareLink: { workspaceId, createdById: userId },
        file: { AND: [readable], trashedAt: null },
      },
      include: {
        file: {
          include: {
            uploadedBy: {
              select: { id: true, displayName: true, avatarUrl: true },
            },
          },
        },
        shareLink: {
          select: { createdAt: true },
        },
      },
    }),
  ]);

  // Normalize into a common shape
  type Entry = {
    id: string;
    file: (typeof memberShares)[0]["file"];
    sharedWith: (typeof memberShares)[0]["sharedWith"] | null;
    shareType: "member" | "link";
    createdAt: Date;
  };

  const entries: Entry[] = [
    ...memberShares.map((s) => ({
      id: s.id,
      file: s.file,
      sharedWith: s.sharedWith,
      shareType: "member" as const,
      createdAt: s.createdAt,
    })),
    ...linkShareFiles.map((lf) => ({
      id: `link-${lf.id}`,
      file: lf.file,
      sharedWith: null,
      shareType: "link" as const,
      createdAt: lf.shareLink.createdAt,
    })),
  ];

  // Sort by date descending
  entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return {
    data: entries,
    nextCursor: null,
  };
}

// ─── Public Share Links ─────────────────────────────────

export async function createFileShareLink(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  createdById: string,
  ctx: AccessContext,
  password?: string,
  expiresAt?: string,
) {
  for (const fileId of fileIds) {
    await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);
  }

  const token = crypto.randomBytes(6).toString("base64url");
  const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });

  return prisma.fileShareLink.create({
    data: {
      workspaceId,
      token,
      passwordHash,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      createdById,
      files: {
        create: fileIds.map((fileId) => ({ fileId })),
      },
    },
    include: {
      files: {
        where: { file: { AND: [readable], trashedAt: null } },
        include: {
          file: {
            select: { id: true, name: true, mimeType: true, size: true },
          },
        },
      },
      createdBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });
}

export async function getFileShareLinks(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId }, true);

  const role = await fileAccessRole(prisma, { ...ctx, workspaceId });
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });

  return prisma.fileShareLink.findMany({
    where: {
      workspaceId,
      ...(role === "ADMIN" ? {} : { createdById: ctx.userId }),
      files: { some: { fileId } },
    },
    include: {
      files: {
        where: { file: { AND: [readable], trashedAt: null } },
        include: {
          file: {
            select: { id: true, name: true, mimeType: true, size: true },
          },
        },
      },
      createdBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function assertShareLinkManager(
  prisma: PrismaClient,
  linkId: string,
  ctx: AccessContext,
) {
  const link = await prisma.fileShareLink.findFirst({
    where: { id: linkId, workspaceId: ctx.workspaceId },
  });
  if (!link) throw new NotFoundError("Share link not found");
  const role = await fileAccessRole(prisma, ctx);
  if (
    role === "VIEWER" ||
    (role !== "ADMIN" && link.createdById !== ctx.userId)
  )
    throw new ForbiddenError(
      "Only the share creator or workspace administrator can manage this link",
    );
  return link;
}

export async function updateFileShareLink(
  prisma: PrismaClient,
  linkId: string,
  data: { enabled?: boolean; password?: string | null; expiresAt?: string | null },
  ctx: AccessContext,
) {
  await assertShareLinkManager(prisma, linkId, ctx);

  const updateData: Record<string, unknown> = {};
  if (data.enabled !== undefined) updateData.enabled = data.enabled;
  if (data.expiresAt !== undefined) {
    updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  }
  if (data.password !== undefined) {
    updateData.passwordHash = data.password
      ? await bcrypt.hash(data.password, 10)
      : null;
  }

  const readable = await fileReadWhere(prisma, ctx);

  return prisma.fileShareLink.update({
    where: { id: linkId, workspaceId: ctx.workspaceId },
    data: updateData,
    include: {
      files: {
        where: { file: { AND: [readable], trashedAt: null } },
        include: {
          file: {
            select: { id: true, name: true, mimeType: true, size: true },
          },
        },
      },
      createdBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });
}

export async function deleteFileShareLink(
  prisma: PrismaClient,
  linkId: string,
  ctx: AccessContext,
) {
  await assertShareLinkManager(prisma, linkId, ctx);
  await prisma.fileShareLink.delete({
    where: { id: linkId, workspaceId: ctx.workspaceId },
  });
}

// ─── Public Access (no auth) ────────────────────────────

export async function getPublicShareLink(prisma: PrismaClient, token: string) {
  const link = await prisma.fileShareLink.findUnique({
    where: { token },
    include: {
      files: {
        where: { file: { trashedAt: null } },
        include: {
          file: {
            select: {
              id: true,
              name: true,
              mimeType: true,
              size: true,
              workspaceId: true,
            },
          },
        },
      },
      createdBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });

  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  return {
    files: link.files
      .filter((entry) => entry.file.workspaceId === link.workspaceId)
      .map((entry) => {
        const { workspaceId: _workspaceId, ...file } = entry.file;
        return { ...entry, file };
      }),
    createdBy: link.createdBy,
    hasPassword: !!link.passwordHash,
    createdAt: link.createdAt,
  };
}

export async function validateShareLinkAccess(
  prisma: PrismaClient,
  token: string,
  password: string,
) {
  const link = await prisma.fileShareLink.findUnique({ where: { token } });
  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  if (!link.passwordHash) return true;

  const valid = await bcrypt.compare(password, link.passwordHash);
  if (!valid) throw new ForbiddenError("Invalid password");
  return true;
}

export async function downloadPublicFile(
  prisma: PrismaClient,
  storage: { readStream: (path: string) => NodeJS.ReadableStream },
  token: string,
  fileId: string,
) {
  const link = await prisma.fileShareLink.findUnique({
    where: { token },
    include: {
      files: { where: { fileId }, include: { file: true } },
    },
  });

  if (!link || !link.enabled) throw new NotFoundError("Shared files not found");

  if (link.expiresAt && link.expiresAt < new Date()) {
    throw new NotFoundError("This share link has expired");
  }

  if (link.files.length === 0) {
    throw new NotFoundError("File not found in share link");
  }

  const file = link.files[0].file;
  if (
    file.workspaceId !== link.workspaceId ||
    file.trashedAt ||
    file.isFolder ||
    !file.storagePath
  ) {
    throw new NotFoundError("File content not available");
  }

  const stream = storage.readStream(file.storagePath);
  return { stream, file };
}

// ─── Share Status (for indicators) ──────────────────────

export async function getFileShareStatus(
  prisma: PrismaClient,
  workspaceId: string,
  fileIds: string[],
  ctx: AccessContext,
) {
  const readable = await fileReadWhere(prisma, { ...ctx, workspaceId });
  const [shares, linkFiles] = await Promise.all([
    prisma.fileShare.findMany({
      where: {
        workspaceId,
        fileId: { in: fileIds },
        file: { AND: [readable], trashedAt: null },
      },
      select: { fileId: true },
      distinct: ["fileId"],
    }),
    prisma.fileShareLinkFile.findMany({
      where: {
        fileId: { in: fileIds },
        shareLink: { workspaceId },
        file: { AND: [readable], trashedAt: null },
      },
      select: { fileId: true },
      distinct: ["fileId"],
    }),
  ]);

  const sharedIds = new Set<string>();
  for (const s of shares) sharedIds.add(s.fileId);
  for (const l of linkFiles) sharedIds.add(l.fileId);

  return Array.from(sharedIds);
}
