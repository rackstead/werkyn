import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "../../services/storage.js";
import type { AttachmentQueryInput, LinkAttachmentInput } from "@pm/shared";
import { ForbiddenError, NotFoundError } from "../../utils/errors.js";
import {
  assertFileAccess,
  fileReadWhere,
  type AccessContext,
} from "../files/file-access.js";
import { assertProjectAccess } from "../../utils/project-access.js";

async function assertAttachmentTarget(
  prisma: PrismaClient,
  ctx: AccessContext,
  entity: { entityType: string; entityId: string },
  write = false,
) {
  // Resolve the declared type only; IDs can collide across tables.
  const task =
    entity.entityType === "task"
      ? await prisma.task.findUnique({
          where: { id: entity.entityId },
          select: { projectId: true },
        })
      : entity.entityType === "comment"
        ? (
            await prisma.comment.findUnique({
              where: { id: entity.entityId },
              select: { task: { select: { projectId: true } } },
            })
          )?.task
        : null;
  if (!task) throw new NotFoundError("Attachment target not found");
  const access = await assertProjectAccess(prisma, task.projectId, ctx.userId);
  if (access.workspaceId !== ctx.workspaceId)
    throw new NotFoundError("Attachment target not found");
  // Attachments follow discussion policy; project members need not be assignees.
  if (write && access.role === "VIEWER")
    throw new ForbiddenError("Read-only workspace access");
  return access;
}

export async function listAttachments(
  prisma: PrismaClient,
  workspaceId: string,
  query: AttachmentQueryInput,
  ctx: AccessContext,
) {
  ctx = { ...ctx, workspaceId };
  await assertAttachmentTarget(prisma, ctx, query);
  const readable = await fileReadWhere(prisma, ctx);
  const attachments = await prisma.attachment.findMany({
    where: {
      workspaceId,
      entityType: query.entityType,
      entityId: query.entityId,
      OR: [
        { fileId: null },
        {
          file: {
            AND: [
              readable,
              { storagePath: { not: null } },
              { storagePath: { not: "" } },
            ],
            isFolder: false,
          },
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: {
      uploadedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
      file: {
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          storagePath: true,
          trashedAt: true,
        },
      },
    },
  });

  return {
    data: attachments.map((attachment) => {
      const file = attachment.file;
      // SetNull/legacy rows cannot prove current source rights. Keep a generic
      // discussion placeholder for cleanup, without cached source metadata.
      if (!file)
        return {
          ...attachment,
          name: "Unavailable file",
          mimeType: "application/octet-stream",
          size: 0n,
          storagePath: "",
          fileId: null,
          file: null,
        };
      return {
        ...attachment,
        name: file.name,
        mimeType: file.mimeType ?? "application/octet-stream",
        size: file.size ?? 0n,
        storagePath: file.storagePath!,
        file: { id: file.id, name: file.name, trashedAt: file.trashedAt },
      };
    }),
  };
}

export async function downloadAttachment(
  storage: StorageProvider,
  prisma: PrismaClient,
  workspaceId: string,
  attachmentId: string,
  ctx: AccessContext,
) {
  ctx = { ...ctx, workspaceId };
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, workspaceId },
    include: { file: true },
  });

  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }

  await assertAttachmentTarget(prisma, ctx, attachment);
  // SetNull clears fileId too. Never fall back to an unavailable row's cache.
  if (!attachment.file?.storagePath || attachment.file.isFolder)
    throw new NotFoundError("The linked Drive file is no longer available");
  await assertFileAccess(prisma, attachment.file.id, ctx);
  const stream = storage.readStream(attachment.file.storagePath);
  return { stream, attachment: { ...attachment, name: attachment.file.name } };
}

export async function deleteAttachment(
  prisma: PrismaClient,
  workspaceId: string,
  attachmentId: string,
  ctx: AccessContext,
) {
  ctx = { ...ctx, workspaceId };
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, workspaceId },
  });

  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }

  const access = await assertAttachmentTarget(prisma, ctx, attachment, true);
  if (access.role !== "ADMIN" && attachment.uploadedById !== ctx.userId)
    throw new ForbiddenError(
      "Only the uploader or workspace administrator can remove an attachment",
    );
  await prisma.attachment.delete({ where: { id: attachmentId, workspaceId } });
}

export async function linkAttachment(
  prisma: PrismaClient,
  workspaceId: string,
  uploadedById: string,
  input: LinkAttachmentInput,
  ctx: AccessContext,
) {
  ctx = { ...ctx, workspaceId };
  if (ctx.userId !== uploadedById)
    throw new ForbiddenError("Attachment author mismatch");
  await assertAttachmentTarget(prisma, ctx, input, true);
  await assertFileAccess(prisma, input.fileId, ctx);
  const file = await prisma.file.findFirst({
    where: {
      id: input.fileId,
      workspaceId,
      isFolder: false,
      trashedAt: null,
    },
  });

  if (!file?.storagePath) {
    throw new NotFoundError("File not found in workspace");
  }

  const attachment = await prisma.attachment.create({
    data: {
      workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      name: file.name,
      mimeType: file.mimeType ?? "application/octet-stream",
      size: file.size ?? 0,
      storagePath: file.storagePath,
      uploadedById,
      fileId: file.id,
    },
  });

  return attachment;
}
