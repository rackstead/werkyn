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
    // A frontend on another origin reads the wait of a 429 (sign-in backoff
    // and route limits); Retry-After is not readable cross-origin otherwise.
    exposedHeaders: ["Retry-After"],
  });
});
