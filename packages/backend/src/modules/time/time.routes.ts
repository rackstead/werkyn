import type { FastifyInstance } from "fastify";
import {
  createEntryHandler,
  listEntriesHandler,
  updateEntryHandler,
  deleteEntryHandler,
  getReportHandler,
  exportCSVHandler,
  listReportEntriesHandler,
  setRateHandler,
  getRateHandler,
  listRatesHandler,
} from "./time.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate, validateQuery } from "../../middleware/validate.js";
import {
  CreateTimeEntrySchema,
  UpdateTimeEntrySchema,
  TimeEntryQuerySchema,
  TimeReportQuerySchema,
  TimeReportEntriesQuerySchema,
  SetUserRateSchema,
} from "@pm/shared";

export default async function timeRoutes(fastify: FastifyInstance) {
  // ─── Time Entries ───────────────────────────────────────

  // POST /api/workspaces/:wid/time/entries
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/time/entries",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(CreateTimeEntrySchema),
    ],
    handler: createEntryHandler,
  });

  // GET /api/workspaces/:wid/time/entries?startDate&endDate&userId?
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/entries",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER", "VIEWER"),
      validateQuery(TimeEntryQuerySchema),
    ],
    handler: listEntriesHandler,
  });

  // PATCH /api/time/entries/:eid
  fastify.route({
    method: "PATCH",
    url: "/time/entries/:eid",
    preHandler: [
      authenticate,
      authorize("ADMIN", "MEMBER"),
      validate(UpdateTimeEntrySchema),
    ],
    handler: updateEntryHandler,
  });

  // DELETE /api/time/entries/:eid
  fastify.route({
    method: "DELETE",
    url: "/time/entries/:eid",
    preHandler: [authenticate, authorize("ADMIN", "MEMBER")],
    handler: deleteEntryHandler,
  });

  // ─── Reports (admin only) ────────────────────────────────

  // GET /api/workspaces/:wid/time/reports
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/reports",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validateQuery(TimeReportQuerySchema),
    ],
    handler: getReportHandler,
  });

  // GET /api/workspaces/:wid/time/reports/entries?groupKey&cursor&limit
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/reports/entries",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validateQuery(TimeReportEntriesQuerySchema),
    ],
    handler: listReportEntriesHandler,
  });

  // GET /api/workspaces/:wid/time/reports/export
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/reports/export",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validateQuery(TimeReportQuerySchema),
    ],
    handler: exportCSVHandler,
  });

  // ─── User Rates (admin only) ─────────────────────────────

  // POST /api/workspaces/:wid/time/rates/:uid
  fastify.route({
    method: "POST",
    url: "/workspaces/:wid/time/rates/:uid",
    preHandler: [
      authenticate,
      authorize("ADMIN"),
      validate(SetUserRateSchema),
    ],
    handler: setRateHandler,
  });

  // GET /api/workspaces/:wid/time/rates/:uid
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/rates/:uid",
    preHandler: [authenticate, authorize("ADMIN")],
    handler: getRateHandler,
  });

  // GET /api/workspaces/:wid/time/rates
  fastify.route({
    method: "GET",
    url: "/workspaces/:wid/time/rates",
    preHandler: [authenticate, authorize("ADMIN")],
    handler: listRatesHandler,
  });
}
