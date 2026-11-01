import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as oidcService from "./oidc.service.js";
import { env } from "../../../config/env.js";
import { ConflictError, UnauthorizedError } from "../../../utils/errors.js";
import {
  OIDC_COMPLETION_TTL_MS,
  assertOidcAttemptCookieBudget,
  hasDuplicateAttemptCookie,
  readBrowserAttempt,
  pendingAttemptCookie,
  completedAttemptCookie,
} from "./oidc-completion.js";
import {
  consumeOidcState,
  MAX_OIDC_BROWSER_ATTEMPTS,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_PATTERN,
  OIDC_STATE_TTL_SECONDS,
  oidcStateCookieName,
} from "./oidc-state.js";

const LoginQuery = z.object({
  connector_id: z.string().min(1).max(100).optional(),
  return_url: z.string().max(500).optional(),
  client_attempt: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
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

export async function oidcLoginHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header("Cache-Control", "no-store");
  try {
    const query = LoginQuery.parse(request.query);
    const rawCount = query.client_attempt
      ? assertOidcAttemptCookieBudget(request)
      : undefined;
    const attempts: string[] = [];
    const expired: string[] = [];
    const inspectOwnedAttempts = () => {
      for (const [name, value] of Object.entries(request.cookies)) {
        const attempt = readBrowserAttempt(request, name, value);
        if (!attempt) continue;
        if (attempt.phase === "completed" && attempt.expiresAt <= Date.now())
          expired.push(name);
        else attempts.push(name);
      }
    };
    // Reserve the newly issued raw slot before creating opt-in state. Only
    // verified owned cookies can supply room; junk is never ours to delete.
    let reserve = 0;
    if (rawCount !== undefined) {
      inspectOwnedAttempts();
      reserve = Math.max(
        0,
        rawCount - expired.length + 1 - MAX_OIDC_BROWSER_ATTEMPTS,
      );
      if (reserve > attempts.length)
        throw new ConflictError("Too many OIDC browser attempts");
    }
    const result = await oidcService.initiateOidcLogin(
      request.server.prisma,
      query.connector_id,
      sanitizeReturnUrl(query.return_url),
    );

    // One cookie per attempt supports parallel tabs. Retain at most the latest
    // five attempts sent by this browser so abandoned logins do not fill its jar.
    if (rawCount === undefined) inspectOwnedAttempts();
    for (const name of expired)
      reply.clearCookie(name, { path: OIDC_STATE_COOKIE_PATH });
    for (const name of attempts.slice(
      0,
      Math.max(reserve, attempts.length - MAX_OIDC_BROWSER_ATTEMPTS + 1),
    )) {
      reply.clearCookie(name, { path: OIDC_STATE_COOKIE_PATH });
    }
    reply.setCookie(
      oidcStateCookieName(result.state),
      query.client_attempt
        ? pendingAttemptCookie(result.state, query.client_attempt)
        : result.state,
      {
        signed: true,
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: "lax", // IdP top-level redirect must carry the browser binding.
        path: OIDC_STATE_COOKIE_PATH,
        maxAge: OIDC_STATE_TTL_SECONDS,
      },
    );
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
  let pendingCookie: string | undefined;
  try {
    const query = CallbackQuery.parse(request.query);
    const name = oidcStateCookieName(query.state);
    if (hasDuplicateAttemptCookie(request, name))
      throw new UnauthorizedError("OIDC state does not match this browser");
    const attempt = readBrowserAttempt(request, name, request.cookies[name]);
    // A completed marker is never pending state. Replays cannot erase it.
    if (attempt?.phase === "completed")
      throw new UnauthorizedError("Invalid or already used OIDC state");
    const binding = attempt?.state;
    if (attempt?.phase !== "pending")
      reply.clearCookie(name, { path: OIDC_STATE_COOKIE_PATH });
    if (query.error) {
      await consumeOidcState(request.server.prisma, query.state, binding);
      if (attempt?.phase === "pending") pendingCookie = name;
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
      attempt?.phase === "pending"
        ? () => {
            // Only the unique state claimant can safely clear pending proof.
            // A losing/unfinished callback may arrive after completed proof.
            pendingCookie = name;
          }
        : undefined,
    );

    reply.setCookie("refresh_token", result.refreshToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN || undefined,
      path: "/api/auth",
      maxAge: 7 * 24 * 60 * 60,
    });
    if (attempt?.phase === "pending") {
      reply.setCookie(
        name,
        completedAttemptCookie(query.state, attempt.attemptId, result.familyId),
        {
          signed: true,
          httpOnly: true,
          secure: env.COOKIE_SECURE,
          sameSite: env.COOKIE_SAMESITE,
          path: OIDC_STATE_COOKIE_PATH,
          maxAge: OIDC_COMPLETION_TTL_MS / 1000,
        },
      );
      pendingCookie = undefined;
    }
    const safeReturnUrl = sanitizeReturnUrl(result.returnUrl ?? undefined);
    return reply.redirect(
      `${env.FRONTEND_URL}/auth/oidc/complete?return_url=${encodeURIComponent(safeReturnUrl)}`,
    );
  } catch (error) {
    if (pendingCookie)
      reply.clearCookie(pendingCookie, { path: OIDC_STATE_COOKIE_PATH });
    return redirectFailure(request, reply, error);
  }
}
