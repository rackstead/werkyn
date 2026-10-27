import type { FastifyInstance } from "fastify";
import { CreateApiKeySchema } from "@pm/shared";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import { ForbiddenError } from "../../utils/errors.js";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
} from "./api-keys.controller.js";

export default async function apiKeysRoutes(fastify: FastifyInstance) {
  // Keys cannot mint credentials or manage other keys, including their own.
  fastify.addHook("preHandler", authenticate);
  fastify.addHook("preHandler", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.apiKeyId) {
      throw new ForbiddenError("Sign in to manage API keys");
    }
  });

  fastify.get("/api-keys", listApiKeysHandler);
  fastify.post(
    "/api-keys",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      preHandler: [validate(CreateApiKeySchema)],
    },
    createApiKeyHandler,
  );
  fastify.delete("/api-keys/:id", revokeApiKeyHandler);
}
