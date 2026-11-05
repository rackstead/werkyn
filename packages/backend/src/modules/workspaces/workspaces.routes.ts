import type { FastifyInstance } from "fastify";
import {
  createWorkspaceHandler,
  listWorkspacesHandler,
  getWorkspaceHandler,
  updateWorkspaceHandler,
  deleteWorkspaceHandler,
  listMembersHandler,
  updateMemberRoleHandler,
  removeMemberHandler,
  getDashboardHandler,
  getMyTasksHandler,
  getWorkspaceSettingsHandler,
  updateWorkspaceSettingsHandler,
  listWorkspaceActivityHandler,
  searchHandler,
  getDashboardPreferenceHandler,
  updateDashboardPreferenceHandler,
} from "./workspaces.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  UpdateWorkspaceMemberSchema,
} from "./workspaces.schemas.js";
import { WorkspaceSearchSchema, UpdateWorkspaceSettingsSchema, ActivityLogQuerySchema, MyTasksQuerySchema, UpdateDashboardPreferenceSchema } from "@pm/shared";

export default async function workspacesRoutes(fastify: FastifyInstance) {
  // POST /api/workspaces
  fastify.route({
    method: "POST",
    url: "/",
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    preHandler: [authenticate, validate(CreateWorkspaceSchema)],
    handler: createWorkspaceHandler,
  });

  // GET /api/workspaces
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [authenticate],
    handler: listWorkspacesHandler,
  });

  // GET /api/workspaces/:wid
  fastify.route({
    method: "GET",
    url: "/:wid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getWorkspaceHandler,
  });

  // PATCH /api/workspaces/:wid
  fastify.route({
    method: "PATCH",
    url: "/:wid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validate(UpdateWorkspaceSchema),
    ],
    handler: updateWorkspaceHandler,
  });

  // DELETE /api/workspaces/:wid
  fastify.route({
    method: "DELETE",
    url: "/:wid",
    preHandler: [authenticate, authorize("ADMIN")],
    handler: deleteWorkspaceHandler,
  });

  // GET /api/workspaces/:wid/members
  fastify.route({
    method: "GET",
    url: "/:wid/members",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: listMembersHandler,
  });

  // PATCH /api/workspaces/:wid/members/:uid
  fastify.route({
    method: "PATCH",
    url: "/:wid/members/:uid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validate(UpdateWorkspaceMemberSchema),
    ],
    handler: updateMemberRoleHandler,
  });

  // DELETE /api/workspaces/:wid/members/:uid
  fastify.route({
    method: "DELETE",
    url: "/:wid/members/:uid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: removeMemberHandler,
  });

  // GET /api/workspaces/:wid/dashboard
  fastify.route({
    method: "GET",
    url: "/:wid/dashboard",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getDashboardHandler,
  });

  // GET /api/workspaces/:wid/my-tasks
  fastify.route({
    method: "GET",
    url: "/:wid/my-tasks",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(MyTasksQuerySchema),
    ],
    handler: getMyTasksHandler,
  });

  // GET /api/workspaces/:wid/settings — Get workspace settings
  fastify.route({
    method: "GET",
    url: "/:wid/settings",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getWorkspaceSettingsHandler,
  });

  // PATCH /api/workspaces/:wid/settings — Update workspace settings (admin only)
  fastify.route({
    method: "PATCH",
    url: "/:wid/settings",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validate(UpdateWorkspaceSettingsSchema),
    ],
    handler: updateWorkspaceSettingsHandler,
  });

  // GET /api/workspaces/:wid/activity
  fastify.route({
    method: "GET",
    url: "/:wid/activity",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(ActivityLogQuerySchema),
    ],
    handler: listWorkspaceActivityHandler,
  });

  // GET /api/workspaces/:wid/search
  fastify.route({
    method: "GET",
    url: "/:wid/search",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(WorkspaceSearchSchema),
    ],
    handler: searchHandler,
  });

  // GET /api/workspaces/:wid/dashboard/preferences
  fastify.route({
    method: "GET",
    url: "/:wid/dashboard/preferences",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER", "VIEWER")],
    handler: getDashboardPreferenceHandler,
  });

  // PATCH /api/workspaces/:wid/dashboard/preferences
  fastify.route({
    method: "PATCH",
    url: "/:wid/dashboard/preferences",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validate(UpdateDashboardPreferenceSchema),
    ],
    handler: updateDashboardPreferenceHandler,
  });
}
