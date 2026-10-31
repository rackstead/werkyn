import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError, ForbiddenError } from "../../utils/errors.js";
import { endSessions } from "../realtime/realtime.service.js";
import { isBusy, revokeMatchingRefreshFamily } from "./refresh-sessions.js";

export const RecoverLogoutSchema = z.object({
  sessionId: z.string().uuid().transform((value) => value.toLowerCase()),
}).strict();

const trustedOrigins = new Set([
  new URL(env.FRONTEND_URL).origin,
  ...env.CORS_ORIGIN.split(","),
]);

/** This opt-in cookie operation requires a non-simple browser request. */
export async function requireLogoutRecoveryRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header("Cache-Control", "no-store");
  const origin = request.headers.origin;
  if (
    typeof origin !== "string" ||
    !trustedOrigins.has(origin) ||
    request.headers["x-werkyn-session-recovery"] !== "1"
  ) {
    throw new ForbiddenError("Sign-out recovery requires a trusted browser request");
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new AppError(415, "Unsupported Media Type", "Sign-out recovery requires JSON");
  }
}

export async function recoverLogoutHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { sessionId } = request.body as z.infer<typeof RecoverLogoutSchema>;
  let result: Awaited<ReturnType<typeof revokeMatchingRefreshFamily>>;
  try {
    result = await revokeMatchingRefreshFamily(
      request.server.prisma,
      request.cookies.refresh_token,
      sessionId,
    );
  } catch (error) {
    if (isBusy(error)) {
      throw new AppError(503, "Service Unavailable", "Sign-out recovery is busy. Try again in a moment.");
    }
    throw error;
  }
  // This response never sets, clears or rotates cookies. A delayed response
  // therefore cannot overwrite a later sign-in's cookie.
  if (result.status === "revoked") endSessions([result.familyId]);
  return reply.send({ data: { status: result.status } });
}
