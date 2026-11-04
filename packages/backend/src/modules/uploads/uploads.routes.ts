import type { FastifyInstance } from "fastify";
import { uploadHandler } from "./uploads.controller.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authenticatedMediaHandler } from "./uploaded-media.js";

export default async function uploadsRoutes(fastify: FastifyInstance) {
  fastify.route({ method: ["GET", "HEAD"], url: "/uploads/media", preHandler: [authenticate], handler: authenticatedMediaHandler });
  // POST /api/uploads — Upload a file (avatar, etc.)
  fastify.route({
    method: "POST",
    url: "/uploads",
    preHandler: [authenticate],
    handler: uploadHandler,
  });
}
