import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { isPublicFrontendRequest } from "./frontend-static.js";

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    // Public frontend files/documents have no API side effects and a split
    // frontend may load many of them. Keep API/private routes in their normal
    // global or route-specific bucket, including misses in server namespaces.
    allowList: (request) => env.NODE_ENV === "production" && isPublicFrontendRequest(request),
    errorResponseBuilder: (_req, context) => {
      const err = new Error(
        `Rate limit exceeded, retry in ${Math.ceil(context.ttl / 1000)} seconds`,
      );
      (err as Error & { statusCode: number }).statusCode = context.statusCode;
      return err;
    },
  });
});
