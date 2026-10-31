import type { FastifyRequest, FastifyReply } from "fastify";
import {
  applyUntrustedContentPolicy,
  isSafeInlineContentType,
} from "../../utils/untrusted-content.js";
import * as filesService from "./files.service.js";
import type {
  CreateFolderInput,
  UpdateFileInput,
  FileQueryInput,
  CopyFileInput,
  ArchiveFilesInput,
} from "@pm/shared";
import { formatContentDisposition } from "../../utils/content-disposition.js";
import { receiveUpload } from "../../utils/upload-stream.js";
import { env } from "../../config/env.js";

function getAccessCtx(request: FastifyRequest) {
  return {
    workspaceId: (request.params as { wid: string }).wid,
    userId: request.user!.id,
    workspaceRole: request.workspaceMember!.role,
  };
}

export async function uploadFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  // Streamed to storage: over MAX_FILE_SIZE is a 413, a stalled client a 408
  // and a disconnect or malformed body a 400, each leaving nothing stored.
  const upload = await receiveUpload(request, reply, {
    maxBytes: env.MAX_FILE_SIZE,
    idleTimeoutMs: request.server.requestLimits.uploadIdleTimeoutMs,
  });

  const parentId =
    (upload.fields.parentId as { value?: string })?.value || undefined;

  try {
    const file = await filesService.uploadFileStream(
      request.server.prisma,
      request.server.storage,
      params.wid,
      request.user!.id,
      parentId,
      upload.filename,
      upload.mimetype,
      upload.stream,
      getAccessCtx(request),
    );
    return reply.status(201).send({ data: file });
  } finally {
    // Refused before its bytes were read (no access, unknown folder): stop
    // waiting for them.
    upload.stream.destroy();
  }
}

export async function createFolderHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as CreateFolderInput;

  const folder = await filesService.createFolder(
    request.server.prisma,
    params.wid,
    request.user!.id,
    body,
    getAccessCtx(request),
  );

  return reply.status(201).send({ data: folder });
}

export async function listFilesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const query = request.query as FileQueryInput;

  const result = await filesService.listFiles(
    request.server.prisma,
    params.wid,
    query,
    getAccessCtx(request),
  );

  return reply.send(result);
}

export async function getFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  const file = await filesService.getFile(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.send({ data: file });
}

export async function downloadFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };
  const query = request.query as { inline?: string };

  // Set before the blob is opened so a missing-content error keeps it too.
  applyUntrustedContentPolicy(reply);
  const { stream, file } = await filesService.downloadFile(
    request.server.storage,
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  const isInline =
    query.inline === "true" && isSafeInlineContentType(file.mimeType);

  return reply
    .header(
      "Content-Disposition",
      formatContentDisposition(file.name, isInline ? "inline" : "attachment"),
    )
    .header("Content-Type", isInline && file.mimeType ? file.mimeType : "application/octet-stream")
    .send(stream);
}

export async function downloadThumbnailHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  const file = await request.server.prisma.file.findFirst({
    where: { id: params.fid, workspaceId: params.wid },
    select: { id: true, thumbnailPath: true, teamFolderId: true, ownerId: true },
  });

  if (!file || !file.thumbnailPath) {
    return reply.status(404).send({ message: "Thumbnail not found" });
  }

  await filesService.getFile(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  reply.header("Cache-Control", "private, no-store");
  const stream = await request.server.storage.openReadStream(
    file.thumbnailPath,
  );

  return reply.header("Content-Type", "image/webp").send(stream);
}

export async function updateFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };
  const body = request.body as UpdateFileInput;

  const file = await filesService.updateFile(
    request.server.prisma,
    params.wid,
    params.fid,
    body,
    getAccessCtx(request),
  );

  return reply.send({ data: file });
}

export async function getFileBreadcrumbsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  const breadcrumbs = await filesService.getFileBreadcrumbs(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.send({ data: breadcrumbs });
}

export async function getFileAttachmentCountHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  const result = await filesService.getFileAttachmentCount(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.send({ data: result });
}

export async function listStarredFilesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };

  const files = await filesService.listStarredFiles(
    request.server.prisma,
    params.wid,
    getAccessCtx(request),
  );

  return reply.send({ data: files });
}

export async function starFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  await filesService.starFile(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.status(204).send();
}

export async function unstarFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  await filesService.unstarFile(
    request.server.prisma,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.status(204).send();
}

export async function copyFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };
  const body = request.body as CopyFileInput;

  const file = await filesService.copyFile(
    request.server.prisma,
    request.server.storage,
    params.wid,
    params.fid,
    body,
    getAccessCtx(request),
  );

  return reply.status(201).send({ data: file });
}

export async function deleteFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; fid: string };

  await filesService.deleteFile(
    request.server.prisma,
    request.server.storage,
    params.wid,
    params.fid,
    getAccessCtx(request),
  );

  return reply.status(204).send();
}

export async function archiveFilesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as ArchiveFilesInput;

  const { stream, archiveName } = await filesService.archiveFiles(
    request.server.prisma,
    request.server.storage,
    params.wid,
    body.fileIds,
    getAccessCtx(request),
  );

  return reply
    .header(
      "Content-Disposition",
      formatContentDisposition(archiveName),
    )
    .header("Content-Type", "application/zip")
    .send(stream);
}

