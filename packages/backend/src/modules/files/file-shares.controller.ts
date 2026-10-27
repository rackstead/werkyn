import type { FastifyRequest, FastifyReply } from "fastify";
import * as shareService from "./file-shares.service.js";
import type {
  CreateFileShareInput,
  CreateFileShareLinkInput,
  UpdateFileShareLinkInput,
  ValidateFileShareLinkInput,
  SharedFilesQueryInput,
} from "@pm/shared";

function getAccessCtx(request: FastifyRequest) {
  return {
    workspaceId: (request.params as { wid: string }).wid,
    userId: request.user!.id,
    workspaceRole: request.workspaceMember!.role,
  };
}

// ─── Member Shares ──────────────────────────────────────

export async function createFileSharesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateFileShareInput;

  const result = await shareService.createFileShares(
    request.server.prisma,
    wid,
    body.fileIds,
    body.userIds,
    request.user!.id,
    getAccessCtx(request),
    request.server,
  );

  return reply.status(201).send({ data: result });
}

export async function getFileSharesHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, fid } = request.params as { wid: string; fid: string };

  const shares = await shareService.getFileShares(
    request.server.prisma,
    wid,
    fid,
    getAccessCtx(request),
  );

  return reply.send({ data: shares });
}

export async function removeFileShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, fid, uid } = request.params as { wid: string; fid: string; uid: string };

  await shareService.removeFileShare(
    request.server.prisma,
    wid,
    fid,
    uid,
    getAccessCtx(request),
  );

  return reply.status(204).send();
}

export async function sharedWithMeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as SharedFilesQueryInput;

  const result = await shareService.listSharedWithMe(
    request.server.prisma,
    wid,
    getAccessCtx(request),
    query.cursor,
    query.limit,
  );

  return reply.send(result);
}

export async function sharedByMeHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as SharedFilesQueryInput;

  const result = await shareService.listSharedByMe(
    request.server.prisma,
    wid,
    getAccessCtx(request),
    query.cursor,
    query.limit,
  );

  return reply.send(result);
}

// ─── Share Links ────────────────────────────────────────

export async function createFileShareLinkHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as CreateFileShareLinkInput;

  const link = await shareService.createFileShareLink(
    request.server.prisma,
    wid,
    body.fileIds,
    request.user!.id,
    getAccessCtx(request),
    body.password,
    body.expiresAt,
  );

  return reply.status(201).send({ data: link });
}

export async function getFileShareLinksHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid, fid } = request.params as { wid: string; fid: string };

  const links = await shareService.getFileShareLinks(
    request.server.prisma,
    wid,
    fid,
    getAccessCtx(request),
  );

  return reply.send({ data: links });
}

export async function updateFileShareLinkHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { lid } = request.params as { lid: string };
  const body = request.body as UpdateFileShareLinkInput;

  const link = await shareService.updateFileShareLink(
    request.server.prisma,
    lid,
    body,
    getAccessCtx(request),
  );

  return reply.send({ data: link });
}

export async function deleteFileShareLinkHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { lid } = request.params as { lid: string };

  await shareService.deleteFileShareLink(
    request.server.prisma,
    lid,
    getAccessCtx(request),
  );

  return reply.status(204).send();
}

// ─── Share Status ───────────────────────────────────────

export async function getFileShareStatusHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const query = request.query as { fileIds?: string };

  const fileIds = query.fileIds?.split(",").filter(Boolean) ?? [];
  if (fileIds.length === 0) return reply.send({ data: [] });

  const sharedIds = await shareService.getFileShareStatus(
    request.server.prisma,
    wid,
    fileIds,
    getAccessCtx(request),
  );

  return reply.send({ data: sharedIds });
}

// ─── Public (no auth) ───────────────────────────────────

export async function getPublicShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token } = request.params as { token: string };

  const result = await shareService.getPublicShareLink(
    request.server.prisma,
    token,
  );

  return reply.send({ data: result });
}

export async function validatePublicShareHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token } = request.params as { token: string };
  const body = request.body as ValidateFileShareLinkInput;

  await shareService.validateShareLinkAccess(
    request.server.prisma,
    token,
    body.password,
  );

  return reply.send({ data: { valid: true } });
}

export async function downloadPublicFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { token, fid } = request.params as { token: string; fid: string };

  const { stream, file } = await shareService.downloadPublicFile(
    request.server.prisma,
    request.server.storage,
    token,
    fid,
  );

  const safeName = file.name.replace(/"/g, '\\"');
  const encodedName = encodeURIComponent(file.name);

  return reply
    .header(
      "Content-Disposition",
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
    )
    .header("Content-Type", "application/octet-stream")
    .send(stream);
}
