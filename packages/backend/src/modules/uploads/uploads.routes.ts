import type { FastifyInstance } from "fastify";
import { uploadHandler } from "./uploads.controller.js";
import { authenticate } from "../../middleware/authenticate.js";

export default async function uploadsRoutes(fastify: FastifyInstance) {
  // POST /api/uploads — Upload a file (avatar, etc.)
  fastify.route({
    method: "POST",
    url: "/uploads",
    preHandler: [authenticate],
    handler: uploadHandler,
  });
}
