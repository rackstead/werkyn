import type { FastifyInstance } from "fastify";
import { publicShareNoStore } from "../../utils/share-grants.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateWikiSpaceSchema,
  UpdateWikiSpaceSchema,
  CreateWikiPageSchema,
  UpdateWikiPageSchema,
  MoveWikiPageSchema,
  WikiPageTreeQuerySchema,
  WikiPageVersionQuerySchema,
  CreateNamedVersionSchema,
  CreateWikiCommentSchema,
  UpdateWikiCommentSchema,
  WikiCommentQuerySchema,
  CreateWikiShareSchema,
  UpdateWikiShareSchema,
  ValidateWikiShareSchema,
} from "./wiki.schemas.js";
import {
  createSpaceHandler,
  listSpacesHandler,
  getSpaceHandler,
  updateSpaceHandler,
  deleteSpaceHandler,
  createPageHandler,
  getPageTreeHandler,
  getPageHandler,
  updatePageHandler,
  deletePageHandler,
  movePageHandler,
  getBreadcrumbsHandler,
  listVersionsHandler,
  createNamedVersionHandler,
  getVersionHandler,
  restoreVersionHandler,
  acquireLockHandler,
  releaseLockHandler,
  heartbeatLockHandler,
  checkLockHandler,
  listCommentsHandler,
  createCommentHandler,
  updateCommentHandler,
  resolveCommentHandler,
  deleteCommentHandler,
  getShareHandler,
  createShareHandler,
  updateShareHandler,
  deleteShareHandler,
  getPublicPageHandler,
  validatePublicPageHandler,
} from "./wiki.controller.js";

export default async function wikiRoutes(fastify: FastifyInstance) {
  // ─── Spaces ───────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/wiki/spaces",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateWikiSpaceSchema),
    ],
    handler: createSpaceHandler,
  });

  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/wiki/spaces",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: listSpacesHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/spaces/:sid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: getSpaceHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/spaces/:sid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateWikiSpaceSchema),
    ],
    handler: updateSpaceHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/wiki/spaces/:sid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
    ],
    handler: deleteSpaceHandler,
  });

  // ─── Pages ────────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/wiki/spaces/:sid/pages",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateWikiPageSchema),
    ],
    handler: createPageHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/spaces/:sid/pages/tree",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(WikiPageTreeQuerySchema),
    ],
    handler: getPageTreeHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: getPageHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/pages/:pgid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateWikiPageSchema),
    ],
    handler: updatePageHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/wiki/pages/:pgid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
    ],
    handler: deletePageHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/pages/:pgid/move",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(MoveWikiPageSchema),
    ],
    handler: movePageHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid/breadcrumbs",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: getBreadcrumbsHandler,
  });

  // ─── Versions ─────────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid/versions",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(WikiPageVersionQuerySchema),
    ],
    handler: listVersionsHandler,
  });

  fastify.route({
    method: "POST",
    url: "/wiki/pages/:pgid/versions",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateNamedVersionSchema),
    ],
    handler: createNamedVersionHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/versions/:vid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: getVersionHandler,
  });

  fastify.route({
    method: "POST",
    url: "/wiki/versions/:vid/restore",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: restoreVersionHandler,
  });

  // ─── Locks ────────────────────────────────────────────

  fastify.route({
    method: "POST",
    url: "/wiki/pages/:pgid/lock",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: acquireLockHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/wiki/pages/:pgid/lock",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: releaseLockHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/pages/:pgid/lock/heartbeat",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: heartbeatLockHandler,
  });

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid/lock",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: checkLockHandler,
  });

  // ─── Comments ─────────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid/comments",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(WikiCommentQuerySchema),
    ],
    handler: listCommentsHandler,
  });

  fastify.route({
    method: "POST",
    url: "/wiki/pages/:pgid/comments",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateWikiCommentSchema),
    ],
    handler: createCommentHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/comments/:cid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateWikiCommentSchema),
    ],
    handler: updateCommentHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/comments/:cid/resolve",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: resolveCommentHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/wiki/comments/:cid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
    ],
    handler: deleteCommentHandler,
  });

  // ─── Shares ─────────────────────────────────────────────

  fastify.route({
    method: "GET",
    url: "/wiki/pages/:pgid/share",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
    ],
    handler: getShareHandler,
  });

  fastify.route({
    method: "POST",
    url: "/wiki/pages/:pgid/share",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateWikiShareSchema),
    ],
    handler: createShareHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/wiki/shares/:shid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateWikiShareSchema),
    ],
    handler: updateShareHandler,
  });

  fastify.route({
    method: "DELETE",
    url: "/wiki/shares/:shid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
    ],
    handler: deleteShareHandler,
  });

  // ─── Public (unauthenticated) ───────────────────────────

  fastify.route({
    method: "GET",
    url: "/public/wiki/:token",
    onRequest: publicShareNoStore,
    handler: getPublicPageHandler,
  });

  fastify.route({
    method: "POST",
    url: "/public/wiki/:token/validate",
    onRequest: publicShareNoStore,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: [validate(ValidateWikiShareSchema)],
    handler: validatePublicPageHandler,
  });
}
