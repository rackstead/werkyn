import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from "../../utils/errors.js";
import {
  findAuthenticatedUser,
  failAuthenticationLookup,
} from "../../utils/authenticated-user.js";
import {
  signFilePreviewGrant,
  verifyFilePreviewGrant,
} from "../../utils/file-preview-tokens.js";
import { applyUntrustedContentPolicy } from "../../utils/untrusted-content.js";
import { formatContentDisposition } from "../../utils/content-disposition.js";
import * as filesService from "./files.service.js";

export async function previewNoStore(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  applyUntrustedContentPolicy(reply);
  reply.header("Referrer-Policy", "no-referrer");
}

export async function authenticateFilePreview(
  request: FastifyRequest,
  _reply: FastifyReply,
) {
  const { wid, fid } = request.params as { wid: string; fid: string };
  const token = (request.query as Record<string, unknown>)?.token;
  let claims: ReturnType<typeof verifyFilePreviewGrant>;
  try {
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      typeof token !== "string" ||
      token === ""
    )
      throw new UnauthorizedError();
    claims = verifyFilePreviewGrant(token, wid, fid);
  } catch {
    throw new UnauthorizedError("Invalid or expired preview grant");
  }
  try {
    const user = await findAuthenticatedUser(
      request.server.prisma,
      claims.sub,
      claims.sid,
    );
    if (!user) throw new UnauthorizedError("Invalid or expired preview grant");
    request.user = user;
  } catch (error) {
    failAuthenticationLookup(
      request,
      error,
      claims.sid === undefined ? "account" : "session_account",
    );
  }
}

async function readablePdf(request: FastifyRequest) {
  const { wid, fid } = request.params as { wid: string; fid: string };
  const ctx = {
    workspaceId: wid,
    userId: request.user!.id,
    workspaceRole: request.workspaceMember!.role,
  };
  const file = await filesService.getFile(request.server.prisma, wid, fid, ctx);
  if (
    file.isFolder ||
    !file.storagePath ||
    file.mimeType?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf"
  )
    throw new ValidationError("PDF preview is not available for this file");
  return file;
}

export async function createPreviewGrantHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (!request.accessClaims || request.apiKeyId)
    throw new ForbiddenError("PDF preview grants require a browser session");
  await readablePdf(request);
  const { wid, fid } = request.params as { wid: string; fid: string };
  return reply.send({
    data: signFilePreviewGrant(request.accessClaims, wid, fid),
  });
}

export async function previewFileHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const file = await readablePdf(request);
  const stream = await request.server.storage.openReadStream(file.storagePath!);
  return reply
    .header(
      "Content-Disposition",
      formatContentDisposition(file.name, "inline"),
    )
    .header("Content-Type", "application/pdf")
    .send(stream);
}
