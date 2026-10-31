import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AppError, UnauthorizedError } from "./errors.js";
import { describeAuthenticationFailure } from "./authentication-failures.js";

export interface AccessClaims {
  sub: string;
  exp: number;
  sid?: string;
}

/** The current account/session predicate shared by header and preview reads. */
export function findAuthenticatedUser(
  prisma: PrismaClient,
  userId: string,
  sessionId?: string,
) {
  return prisma.user.findUnique({
    where: {
      id: userId,
      ...(sessionId === undefined
        ? {}
        : {
            refreshTokenFamilies: {
              some: {
                id: sessionId,
                revokedAt: null,
                tokens: { some: { expiresAt: { gt: new Date() } } },
              },
            },
          }),
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      emailVerified: true,
    },
  });
}

/** Preserve bounded diagnostics without passing private database exceptions on. */
export function failAuthenticationLookup(
  request: FastifyRequest,
  error: unknown,
  stage: "api_key" | "account" | "session_account",
): never {
  if (error instanceof UnauthorizedError) throw error;
  const failure = describeAuthenticationFailure(error);
  request.log.error(
    { authentication: { stage, ...failure } },
    "Authentication lookup failed",
  );
  throw new AppError(
    failure.statusCode,
    failure.statusCode === 503
      ? "Service Unavailable"
      : "Internal Server Error",
    failure.statusCode === 503
      ? "Authentication is temporarily unavailable. Try again in a moment."
      : "An unexpected error occurred",
  );
}
