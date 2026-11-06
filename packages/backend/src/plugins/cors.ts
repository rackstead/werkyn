import fp from "fastify-plugin";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";

export default fp(async (fastify: FastifyInstance) => {
  const origins = env.CORS_ORIGIN.split(",");

  if (origins.includes("*")) {
    throw new Error(
      'CORS_ORIGIN="*" is not allowed when credentials are enabled. ' +
        "Set CORS_ORIGIN to specific origins (e.g. http://localhost:5173).",
    );
  }

  await fastify.register(cors, {
    origin: origins,
    credentials: true,
    // A frontend served from another origin reads how long to wait after a
    // 429 from the request limit (plugins/rate-limit.ts).
    exposedHeaders: ["Retry-After"],
  });
});
