import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as oidcService from "./oidc.service.js";
import { env } from "../../../config/env.js";
import { UnauthorizedError } from "../../../utils/errors.js";
import {
  consumeOidcState,
  MAX_OIDC_BROWSER_ATTEMPTS,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_COOKIE_PREFIX,
  OIDC_STATE_PATTERN,
  OIDC_STATE_TTL_SECONDS,
  oidcStateCookieName,
} from "./oidc-state.js";

const LoginQuery = z.object({
  connector_id: z.string().min(1).max(100).optional(),
  return_url: z.string().max(500).optional(),
});
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().regex(OIDC_STATE_PATTERN),
  iss: z.string().max(2048).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

function sanitizeReturnUrl(raw: string | undefined): string {
  if (!raw) return "/";
  try {
    for (const value of [raw, decodeURIComponent(raw)]) {
      if (
        !value.startsWith("/") ||
        value.startsWith("//") ||
        /[\\\x00-\x1f\x7f]/.test(value)
      ) {
        return "/";
      }
    }
    return raw;
  } catch {
    return "/";
  }
}

function redirectFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  const message =
    error instanceof UnauthorizedError ? error.message : "SSO login failed";
  // Provider/library errors can contain response bodies or credentials. Only log
  // a controlled description, and never echo an upstream error_description.
  request.log.warn({ reason: message }, "OIDC sign-in rejected");
  return reply.redirect(
    `${env.FRONTEND_URL}/login?sso_error=${encodeURIComponent(message)}`,
  );
}

function browserState(
  request: FastifyRequest,
  state: string,
): string | undefined {
  const value = request.cookies[oidcStateCookieName(state)];
  if (!value) return undefined;
  const unsigned = request.unsignCookie(value);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}

export async function oidcLoginHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = LoginQuery.parse(request.query);
    const result = await oidcService.initiateOidcLogin(
      request.server.prisma,
      query.connector_id,
      sanitizeReturnUrl(query.return_url),
    );

    // One cookie per attempt supports parallel tabs. Retain at most the latest
    // five attempts sent by this browser so abandoned logins do not fill its jar.
    const attempts = Object.entries(request.cookies).filter(([name, value]) => {
      if (!name.startsWith(OIDC_STATE_COOKIE_PREFIX)) return false;
      const state = name.slice(OIDC_STATE_COOKIE_PREFIX.length);
      return (
        OIDC_STATE_PATTERN.test(state) &&
        browserState(request, state) === state &&
        !!value
      );
    });
    for (const [name] of attempts.slice(
      0,
      Math.max(0, attempts.length - MAX_OIDC_BROWSER_ATTEMPTS + 1),
    )) {
      reply.clearCookie(name, { path: OIDC_STATE_COOKIE_PATH });
    }
    reply.setCookie(oidcStateCookieName(result.state), result.state, {
      signed: true,
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "lax", // IdP top-level redirect must carry the browser binding.
      path: OIDC_STATE_COOKIE_PATH,
      maxAge: OIDC_STATE_TTL_SECONDS,
    });
    return reply.redirect(result.authorizationUrl);
  } catch (error) {
    return redirectFailure(request, reply, error);
  }
}

export async function oidcCallbackHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = CallbackQuery.parse(request.query);
    const binding = browserState(request, query.state);
    reply.clearCookie(oidcStateCookieName(query.state), {
      path: OIDC_STATE_COOKIE_PATH,
    });
    if (query.error) {
      await consumeOidcState(request.server.prisma, query.state, binding);
      throw new UnauthorizedError("SSO sign-in was not completed");
    }
    if (!query.code)
      throw new UnauthorizedError("Missing OIDC authorization code");
    const result = await oidcService.handleOidcCallback(
      request.server.prisma,
      query.code,
      query.state,
      binding,
      query.iss,
    );

    reply.setCookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN || undefined,
      path: "/api/auth",
      maxAge: 7 * 24 * 60 * 60,
    });
    const safeReturnUrl = sanitizeReturnUrl(result.returnUrl ?? undefined);
    return reply.redirect(
      `${env.FRONTEND_URL}/auth/oidc/complete?return_url=${encodeURIComponent(safeReturnUrl)}`,
    );
  } catch (error) {
    return redirectFailure(request, reply, error);
  }
}
