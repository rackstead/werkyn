import type { FastifyInstance } from "fastify";
import {
  listAttachmentsHandler,
  downloadAttachmentHandler,
  deleteAttachmentHandler,
  linkAttachmentHandler,
} from "./attachments.controller.js";
import { applyUntrustedContentPolicy } from "../../utils/untrusted-content.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import { AttachmentQuerySchema, LinkAttachmentSchema } from "@pm/shared";

export default async function attachmentsRoutes(fastify: FastifyInstance) {
  // POST /api/workspaces/:wid/attachments/link — Link a Drive file as attachment
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/attachments/link",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER"), validate(LinkAttachmentSchema)],
    handler: linkAttachmentHandler,
  });

  // GET /api/workspaces/:wid/attachments — List attachments for entity
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/attachments",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(AttachmentQuerySchema),
    ],
    handler: listAttachmentsHandler,
  });

  // GET /api/workspaces/:wid/attachments/:aid/download — Stream attachment
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/attachments/:aid/download",
    onSend: (_request, reply, payload, done) => {
      applyUntrustedContentPolicy(reply);
      done(null, payload);
    },
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: downloadAttachmentHandler,
  });

  // DELETE /api/workspaces/:wid/attachments/:aid — Delete attachment
  fastify.route({
    method: "DELETE",
    url: "/workspaces/:wid/attachments/:aid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteAttachmentHandler,
  });
}
