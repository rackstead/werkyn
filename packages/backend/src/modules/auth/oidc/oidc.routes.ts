import type { FastifyInstance } from "fastify";
import { oidcLoginHandler, oidcCallbackHandler } from "./oidc.controller.js";

export default async function oidcRoutes(fastify: FastifyInstance) {
  // GET /api/auth/oidc/login?connector_id=...&return_url=...
  fastify.route({
    method: "GET",
    url: "/login",
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    handler: oidcLoginHandler,
  });

  // GET /api/auth/oidc/callback?code=...&state=...
  fastify.route({
    method: "GET",
    url: "/callback",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    handler: oidcCallbackHandler,
  });
}
