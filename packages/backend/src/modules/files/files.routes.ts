import type { FastifyInstance } from "fastify";
import {
  uploadFileHandler,
  createFolderHandler,
  listFilesHandler,
  listStarredFilesHandler,
  starFileHandler,
  unstarFileHandler,
  getFileHandler,
  downloadFileHandler,
  downloadThumbnailHandler,
  updateFileHandler,
  getFileBreadcrumbsHandler,
  getFileAttachmentCountHandler,
  copyFileHandler,
  deleteFileHandler,
  archiveFilesHandler,
} from "./files.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateFolderSchema,
  UpdateFileSchema,
  FileQuerySchema,
  CopyFileSchema,
  ArchiveFilesSchema,
} from "@pm/shared";

export default async function filesRoutes(fastify: FastifyInstance) {
  // POST /api/workspaces/:wid/files/upload — Upload file (multipart)
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/upload",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: uploadFileHandler,
  });

  // POST /api/workspaces/:wid/files/folder — Create folder
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/folder",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateFolderSchema),
    ],
    handler: createFolderHandler,
  });

  // GET /api/workspaces/:wid/files — List files
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(FileQuerySchema),
    ],
    handler: listFilesHandler,
  });

  // GET /api/workspaces/:wid/files/starred — List starred files
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/starred",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listStarredFilesHandler,
  });

  // POST /api/workspaces/:wid/files/:fid/star — Star a file
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/:fid/star",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: starFileHandler,
  });

  // DELETE /api/workspaces/:wid/files/:fid/star — Unstar a file
  fastify.route({
    method: "DELETE",
    url: "/workspaces/:wid/files/:fid/star",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: unstarFileHandler,
  });

  // GET /api/workspaces/:wid/files/:fid — Get file metadata
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getFileHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/download — Stream file content
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/download",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: downloadFileHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/thumbnail — Get file thumbnail
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/thumbnail",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: downloadThumbnailHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/breadcrumbs — Get breadcrumb path
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/breadcrumbs",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getFileBreadcrumbsHandler,
  });

  // PATCH /api/workspaces/:wid/files/:fid — Rename or move file
  fastify.route({
    method: "PATCH",
    url: "/workspaces/:wid/files/:fid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateFileSchema),
    ],
    handler: updateFileHandler,
  });

  // GET /api/workspaces/:wid/files/:fid/attachments-count — Check linked attachments
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/files/:fid/attachments-count",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: getFileAttachmentCountHandler,
  });

  // POST /api/workspaces/:wid/files/:fid/copy — Copy file
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/:fid/copy",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CopyFileSchema),
    ],
    handler: copyFileHandler,
  });

  // POST /api/workspaces/:wid/files/archive — Download multiple files as ZIP
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/files/archive",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validate(ArchiveFilesSchema),
    ],
    handler: archiveFilesHandler,
  });

  // DELETE /api/workspaces/:wid/files/:fid — Delete file/folder
  fastify.route({
    method: "DELETE",
    url: "/workspaces/:wid/files/:fid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteFileHandler,
  });
}
