import type { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { BackupExportRequestSchema } from "@pm/shared";
import {
  exportHandler,
  previewHandler,
  restoreHandler,
} from "./backup.controller.js";
import { limitBackupRequests } from "./backup-concurrency.js";
import { backupStagingDir, prepareBackupStaging } from "./backup-staging.js";
import { env } from "../../config/env.js";

export default async function backupRoutes(fastify: FastifyInstance) {
  // A staged file belongs to the request that created it, so any found before
  // the server accepts requests were left by a process that stopped mid-request.
  // If this sweep fails, the server still starts, and every backup request
  // retries it before staging anything (and fails while it cannot).
  fastify.addHook("onReady", async () => {
    try {
      await prepareBackupStaging(backupStagingDir(env.STORAGE_DIR), fastify.log);
    } catch (error) {
      fastify.log.error({ err: error }, "Could not clear the backup staging area");
    }
  });

  // Every backup route is admitted per workspace and per process before it
  // reads an upload or the database, after the caller is authorized.

  // POST /api/workspaces/:wid/backup/export
  fastify.route({
    method: "POST",
    url: "/:wid/backup/export",
    preHandler: [authenticate, authorize("ADMIN"), validate(BackupExportRequestSchema)],
    handler: limitBackupRequests(exportHandler),
  });

  // POST /api/workspaces/:wid/backup/preview
  fastify.route({
    method: "POST",
    url: "/:wid/backup/preview",
    preHandler: [authenticate, authorize("ADMIN")],
    handler: limitBackupRequests(previewHandler),
  });

  // POST /api/workspaces/:wid/backup/restore
  fastify.route({
    method: "POST",
    url: "/:wid/backup/restore",
    preHandler: [authenticate, authorize("ADMIN")],
    handler: limitBackupRequests(restoreHandler),
  });
}
