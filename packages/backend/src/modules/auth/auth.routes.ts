import type { FastifyInstance } from "fastify";
import {
  registerHandler,
  loginHandler,
  refreshHandler,
  logoutHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  verifyEmailHandler,
  resendVerificationHandler,
} from "./auth.controller.js";
import oidcRoutes from "./oidc/oidc.routes.js";
import { validate } from "../../middleware/validate.js";
import { authenticate } from "../../middleware/authenticate.js";
import {
  RecoverLogoutSchema,
  requireLogoutRecoveryRequest,
  recoverLogoutHandler,
} from "./logout-recovery.js";
import {
  LoginSchema,
  RegisterSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ResendVerificationSchema,
} from "@pm/shared";

export default async function authRoutes(fastify: FastifyInstance) {
  // OIDC sub-routes
  await fastify.register(oidcRoutes, { prefix: "/oidc" });

  // GET /api/auth/sso-info (public)
  fastify.route({
    method: "GET",
    url: "/sso-info",
    handler: async (request) => {
      const config = await request.server.prisma.ssoConfig.findUnique({
        where: { id: "singleton" },
        include: {
          connectors: {
            where: { enabled: true },
            orderBy: { position: "asc" },
            select: { connectorId: true, name: true, type: true },
          },
        },
      });

      const userCount = await request.server.prisma.user.count({ take: 1 });
      const hasUsers = userCount > 0;

      if (!config || !config.enabled) {
        return {
          data: {
            enabled: false,
            passwordLoginEnabled: true,
            connectors: [],
            hasUsers,
          },
        };
      }

      return {
        data: {
          enabled: config.enabled,
          passwordLoginEnabled: config.passwordLoginEnabled,
          connectors: config.connectors,
          hasUsers,
        },
      };
    },
  });
  // POST /api/auth/register
  fastify.route({
    method: "POST",
    url: "/register",
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: [validate(RegisterSchema)],
    handler: registerHandler,
  });

  // POST /api/auth/login
  fastify.route({
    method: "POST",
    url: "/login",
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: [validate(LoginSchema)],
    handler: loginHandler,
  });

  // POST /api/auth/refresh
  fastify.route({
    method: "POST",
    url: "/refresh",
    handler: refreshHandler,
  });

  // POST /api/auth/logout
  fastify.route({
    method: "POST",
    url: "/logout",
    preHandler: [authenticate],
    handler: logoutHandler,
  });

  // Cookie-authenticated, session-conditional recovery; no cookie mutation.
  fastify.route({
    method: "POST",
    url: "/logout/recover",
    onRequest: requireLogoutRecoveryRequest,
    preHandler: [validate(RecoverLogoutSchema)],
    handler: recoverLogoutHandler,
  });

  // POST /api/auth/forgot-password
  fastify.route({
    method: "POST",
    url: "/forgot-password",
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    preHandler: [validate(ForgotPasswordSchema)],
    handler: forgotPasswordHandler,
  });

  // POST /api/auth/reset-password/:token
  fastify.route({
    method: "POST",
    url: "/reset-password/:token",
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    preHandler: [validate(ResetPasswordSchema)],
    handler: resetPasswordHandler,
  });

  // POST /api/auth/verify-email/:token
  fastify.route({
    method: "POST",
    url: "/verify-email/:token",
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: verifyEmailHandler,
  });

  // POST /api/auth/resend-verification
  fastify.route({
    method: "POST",
    url: "/resend-verification",
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    preHandler: [authenticate, validate(ResendVerificationSchema)],
    handler: resendVerificationHandler,
  });
}
