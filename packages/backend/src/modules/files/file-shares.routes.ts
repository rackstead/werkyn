import type { FastifyInstance } from "fastify";
import { publicShareNoStore } from "../../utils/share-grants.js";
import {
  createFileSharesHandler,
  getFileSharesHandler,
  removeFileShareHandler,
  sharedWithMeHandler,
  sharedByMeHandler,
  createFileShareLinkHandler,
  getFileShareLinksHandler,
  updateFileShareLinkHandler,
  deleteFileShareLinkHandler,
  getFileShareStatusHandler,
  getPublicShareHandler,
  validatePublicShareHandler,
  downloadPublicFileHandler,
} from "./file-shares.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateFileShareSchema,
  CreateFileShareLinkSchema,
  UpdateFileShareLinkSchema,
  ValidateFileShareLinkSchema,
  SharedFilesQuerySchema,
} from "@pm/shared";

export default async function fileSharesRoutes(fastify: FastifyInstance) {
  // ─── Authenticated Routes ───────────────────────────────

  // POST /api/workspaces/:wid/files/shares — Share files with users
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/shares",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateFileShareSchema),
    ],
    handler: createFileSharesHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/shares — Get shares for a file
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/shares",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getFileSharesHandler,
  });

  // DELETE /api/workspaces/:wid/files/:fid/shares/:uid — Remove a share
  fastify.route({
    method: "DELETE",
    url: "/workspaces/:wid/files/:fid/shares/:uid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: removeFileShareHandler,
  });

  // GET /api/workspaces/:wid/files/shared-with-me — Files shared with current user
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/shared-with-me",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(SharedFilesQuerySchema),
    ],
    handler: sharedWithMeHandler,
  });

  // GET /api/workspaces/:wid/files/shared-by-me — Files shared by current user
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/shared-by-me",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(SharedFilesQuerySchema),
    ],
    handler: sharedByMeHandler,
  });

  // POST /api/workspaces/:wid/files/share-links — Create a public share link
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/share-links",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateFileShareLinkSchema),
    ],
    handler: createFileShareLinkHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/share-links — Get share links for a file
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/share-links",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getFileShareLinksHandler,
  });

  // PATCH /api/workspaces/:wid/file-share-links/:lid — Update a share link
  fastify.route({
    method: "PATCH",
    url: "/workspaces/:wid/file-share-links/:lid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateFileShareLinkSchema),
    ],
    handler: updateFileShareLinkHandler,
  });

  // DELETE /api/workspaces/:wid/file-share-links/:lid — Delete a share link
  fastify.route({
    method: "DELETE",
    url: "/workspaces/:wid/file-share-links/:lid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteFileShareLinkHandler,
  });

  // GET /api/workspaces/:wid/files/share-status — Batch check share status
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/share-status",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getFileShareStatusHandler,
  });

  // ─── Public Routes (no auth) ────────────────────────────

  // GET /api/public/files/:token — Get public share info
  fastify.route({
    method: "GET",
    url: "/public/files/:token",
    onRequest: publicShareNoStore,
    handler: getPublicShareHandler,
  });

  // POST /api/public/files/:token/validate — Validate password
  fastify.route({
    method: "POST",
    url: "/public/files/:token/validate",
    onRequest: publicShareNoStore,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: [validate(ValidateFileShareLinkSchema)],
    handler: validatePublicShareHandler,
  });

  // GET /api/public/files/:token/:fid/download — Download public file
  fastify.route({
    method: "GET",
    url: "/public/files/:token/:fid/download",
    onRequest: publicShareNoStore,
    handler: downloadPublicFileHandler,
  });
}
