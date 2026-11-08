import type { FastifyInstance } from "fastify";
import { UpdateRegistrationConfigSchema } from "@pm/shared";
import { authenticate } from "../../middleware/authenticate.js";
import { instanceAdmin } from "../../middleware/instance-admin.js";
import { validate } from "../../middleware/validate.js";
import {
  getRegistrationConfigHandler,
  updateRegistrationConfigHandler,
} from "./registration.controller.js";

export default async function registrationRoutes(fastify: FastifyInstance) {
  // Instance registration policy. Workspace admins are not instance admins.
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", instanceAdmin);

  fastify.route({
    method: "GET",
    url: "/config",
    handler: getRegistrationConfigHandler,
  });

  fastify.route({
    method: "PATCH",
    url: "/config",
    preHandler: [validate(UpdateRegistrationConfigSchema)],
    handler: updateRegistrationConfigHandler,
  });
}
