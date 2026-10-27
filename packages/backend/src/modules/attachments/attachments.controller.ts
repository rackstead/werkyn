import type { FastifyRequest, FastifyReply } from "fastify";
import { formatContentDisposition } from "../../utils/content-disposition.js";
import * as attachmentsService from "./attachments.service.js";
import type { AttachmentQueryInput, LinkAttachmentInput } from "@pm/shared";

export async function listAttachmentsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const query = request.query as AttachmentQueryInput;

  const result = await attachmentsService.listAttachments(
    request.server.prisma,
    params.wid,
    query,
  );

  return reply.send(result);
}

export async function downloadAttachmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; aid: string };

  const { stream, attachment } = await attachmentsService.downloadAttachment(
    request.server.storage,
    request.server.prisma,
    params.wid,
    params.aid,
  );

  return reply
    .header(
      "Content-Disposition",
      formatContentDisposition(attachment.name),
    )
    .header("Content-Type", "application/octet-stream")
    .send(stream);
}

export async function deleteAttachmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string; aid: string };

  await attachmentsService.deleteAttachment(
    request.server.prisma,
    params.wid,
    params.aid,
  );

  return reply.status(204).send();
}

export async function linkAttachmentHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { wid: string };
  const body = request.body as LinkAttachmentInput;

  const attachment = await attachmentsService.linkAttachment(
    request.server.prisma,
    params.wid,
    request.user!.id,
    body,
  );

  return reply.status(201).send({ data: attachment });
}
