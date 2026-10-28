import type { FastifyRequest, FastifyReply } from "fastify";
import type { ResendVerificationInput } from "@pm/shared";
import * as authService from "./auth.service.js";
import { env } from "../../config/env.js";

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie("refresh_token", token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/api/auth",
    maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie("refresh_token", {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/api/auth",
  });
}

export async function registerHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as {
    email: string;
    password: string;
    displayName: string;
    inviteToken?: string;
  };

  const result = await authService.register(request.server.prisma, body);

  setRefreshCookie(reply, result.refreshToken);

  return reply.status(201).send({
    data: {
      user: result.user,
      accessToken: result.accessToken,
      workspaces: result.workspaces,
      ...(result.admission ? { admission: result.admission } : {}),
    },
  });
}

export async function loginHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as { email: string; password: string };

  const result = await authService.login(request.server.prisma, body);

  setRefreshCookie(reply, result.refreshToken);

  return reply.send({
    data: {
      user: result.user,
      accessToken: result.accessToken,
      workspaces: result.workspaces,
    },
  });
}

export async function refreshHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const rawToken = request.cookies.refresh_token;
  if (!rawToken) {
    return reply.status(401).send({
      statusCode: 401,
      error: "Unauthorized",
      message: "No refresh token",
    });
  }

  const result = await authService.refresh(request.server.prisma, rawToken);

  setRefreshCookie(reply, result.refreshToken);

  return reply.send({
    data: {
      user: result.user,
      accessToken: result.accessToken,
      workspaces: result.workspaces,
    },
  });
}

export async function logoutHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const rawToken = request.cookies.refresh_token;
  if (rawToken) {
    await authService.logout(request.server.prisma, rawToken);
  }

  clearRefreshCookie(reply);

  return reply.status(204).send();
}

export async function forgotPasswordHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as { email: string };

  await authService.forgotPassword(request.server.prisma, body.email);

  return reply.send({
    message: "If an account exists, a reset link has been sent.",
  });
}

export async function resetPasswordHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { token: string };
  const body = request.body as { password: string };

  await authService.resetPassword(
    request.server.prisma,
    params.token,
    body.password,
  );

  return reply.send({ message: "Password reset successfully." });
}

export async function verifyEmailHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const params = request.params as { token: string };

  const result = await authService.verifyEmail(
    request.server.prisma,
    params.token,
  );

  return reply.send({ data: result });
}

export async function resendVerificationHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const body = request.body as ResendVerificationInput;
  const result = await authService.resendVerification(
    request.server.prisma,
    request.user!.id,
    body?.inviteToken,
  );

  return reply.send(result);
}
