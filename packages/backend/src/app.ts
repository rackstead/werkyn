// Enable BigInt JSON serialization (safe for file sizes well under Number.MAX_SAFE_INTEGER)
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

import path from "node:path";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { getLoggerConfig } from "./plugins/logger.js";
import prismaPlugin from "./plugins/prisma.js";
import errorPlugin from "./plugins/errors.js";
import corsPlugin from "./plugins/cors.js";
import cookiePlugin from "./plugins/cookie.js";
import rateLimitPlugin from "./plugins/rate-limit.js";
import securityPlugin from "./plugins/security.js";
import staticPlugin from "./plugins/static.js";
import { FRONTEND_REVALIDATE, frontendPathname, isFrontendAssetPath } from "./plugins/frontend-static.js";
import websocketPlugin from "./plugins/websocket.js";
import multipartPlugin from "./plugins/multipart.js";
import storagePlugin from "./plugins/storage.js";
import dexProxyPlugin from "./plugins/dex-proxy.js";
import healthPlugin from "./plugins/health.js";
import requestLimitsPlugin, {
  REQUEST_LIMITS,
  requestLimitServerOptions,
  type RequestLimits,
} from "./plugins/request-limits.js";
import authRoutes from "./modules/auth/auth.routes.js";
import apiKeysRoutes from "./modules/api-keys/api-keys.routes.js";
import usersRoutes from "./modules/users/users.routes.js";
import workspacesRoutes from "./modules/workspaces/workspaces.routes.js";
import projectsRoutes from "./modules/projects/projects.routes.js";
import statusesRoutes from "./modules/statuses/statuses.routes.js";
import labelsRoutes from "./modules/labels/labels.routes.js";
import tasksRoutes from "./modules/tasks/tasks.routes.js";
import invitesRoutes from "./modules/invites/invites.routes.js";
import uploadsRoutes from "./modules/uploads/uploads.routes.js";
import subtasksRoutes from "./modules/subtasks/subtasks.routes.js";
import commentsRoutes from "./modules/comments/comments.routes.js";
import realtimeRoutes from "./modules/realtime/realtime.routes.js";
import notificationsRoutes from "./modules/notifications/notifications.routes.js";
import customFieldsRoutes from "./modules/custom-fields/custom-fields.routes.js";
import templatesRoutes from "./modules/templates/templates.routes.js";
import recurringRoutes from "./modules/recurring/recurring.routes.js";
import filesRoutes from "./modules/files/files.routes.js";
import fileSharesRoutes from "./modules/files/file-shares.routes.js";
import teamFoldersRoutes from "./modules/team-folders/team-folders.routes.js";
import attachmentsRoutes from "./modules/attachments/attachments.routes.js";
import groupsRoutes from "./modules/groups/groups.routes.js";
import wikiRoutes from "./modules/wiki/wiki.routes.js";
import timeRoutes from "./modules/time/time.routes.js";
import ssoRoutes from "./modules/sso/sso.routes.js";
import emailRoutes from "./modules/email/email.routes.js";
import chatRoutes from "./modules/chat/chat.routes.js";
import backupRoutes from "./modules/backup/backup.routes.js";
import { broadcast, broadcastToWorkspace, broadcastToUser, broadcastToChannel } from "./modules/realtime/realtime.service.js";
import { env } from "./config/env.js";
import { setPrisma } from "./utils/mailer.js";

export interface BuildAppOptions {
  /** Overrides of the HTTP timeouts in REQUEST_LIMITS (tests use short ones). */
  requestLimits?: Partial<RequestLimits>;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const limits = Object.freeze({ ...REQUEST_LIMITS, ...options.requestLimits });
  const app = Fastify({
    logger: getLoggerConfig(),
    // Header, request, idle and keep-alive timeouts. Authorized uploads lift
    // the request deadline and backup routes suspend the idle timeout until
    // they respond, each bounded instead (see plugins/request-limits.ts).
    ...requestLimitServerOptions(limits),
  });

  // Plugins (order matters)
  await app.register(requestLimitsPlugin, { limits });
  await app.register(prismaPlugin);
  await app.register(errorPlugin);
  await app.register(corsPlugin);
  await app.register(cookiePlugin);
  await app.register(rateLimitPlugin);
  await app.register(securityPlugin);
  await app.register(staticPlugin);
  await app.register(websocketPlugin);
  await app.register(multipartPlugin);
  await app.register(storagePlugin);
  await app.register(dexProxyPlugin);

  // Probes: liveness (/api/live), readiness (/api/ready) and database health (/api/health)
  await app.register(healthPlugin);

  // Module routes
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(apiKeysRoutes, { prefix: "/api" });
  await app.register(usersRoutes, { prefix: "/api/users" });
  await app.register(workspacesRoutes, { prefix: "/api/workspaces" });
  await app.register(projectsRoutes, { prefix: "/api" });
  await app.register(statusesRoutes, { prefix: "/api/projects" });
  await app.register(labelsRoutes, { prefix: "/api/projects" });
  await app.register(tasksRoutes, { prefix: "/api" });
  await app.register(subtasksRoutes, { prefix: "/api" });
  await app.register(commentsRoutes, { prefix: "/api" });
  await app.register(invitesRoutes, { prefix: "/api" });
  await app.register(uploadsRoutes, { prefix: "/api" });
  await app.register(realtimeRoutes, { prefix: "/api" });
  await app.register(notificationsRoutes, { prefix: "/api/notifications" });
  await app.register(customFieldsRoutes, { prefix: "/api/projects" });
  await app.register(templatesRoutes, { prefix: "/api/projects" });
  await app.register(recurringRoutes, { prefix: "/api/projects" });
  await app.register(filesRoutes, { prefix: "/api" });
  await app.register(fileSharesRoutes, { prefix: "/api" });
  await app.register(teamFoldersRoutes, { prefix: "/api" });
  await app.register(attachmentsRoutes, { prefix: "/api" });
  await app.register(groupsRoutes, { prefix: "/api" });
  await app.register(wikiRoutes, { prefix: "/api" });
  await app.register(timeRoutes, { prefix: "/api" });
  await app.register(ssoRoutes, { prefix: "/api/admin/sso" });
  await app.register(emailRoutes, { prefix: "/api/admin/email" });
  await app.register(chatRoutes, { prefix: "/api/chat" });
  await app.register(backupRoutes, { prefix: "/api/workspaces" });

  // Give mailer access to prisma for DB-backed email config
  setPrisma(app.prisma);

  // Decorate with broadcast functions for use by other modules
  app.decorate("broadcast", broadcast);
  app.decorate("broadcastToWorkspace", broadcastToWorkspace);
  app.decorate("broadcastToUser", broadcastToUser);
  app.decorate("broadcastToChannel", broadcastToChannel);

  // SPA fallback for production (serves index.html for client-side routes)
  if (env.NODE_ENV === "production") {
    const indexHtml = readFileSync(
      path.resolve(process.cwd(), "packages/frontend/dist/index.html"),
      "utf-8",
    );

    app.setNotFoundHandler((request, reply) => {
      const pathname = frontendPathname(request);
      if (pathname === undefined || isFrontendAssetPath(pathname)) {
        return reply.code(404).header("Cache-Control", "no-store").send({ error: "Not Found" });
      }
      return reply.type("text/html").header("Cache-Control", FRONTEND_REVALIDATE).send(indexHtml);
    });
  }

  return app;
}
