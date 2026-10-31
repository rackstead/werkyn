import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "../utils/tokens.js";
import { AppError, UnauthorizedError } from "../utils/errors.js";
import { verifyApiKey } from "../modules/api-keys/api-keys.service.js";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  const queryToken = (request.query as Record<string, string>)?.token;

  if (!authHeader?.startsWith("Bearer ") && !queryToken) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }

  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : queryToken!;
  if (typeof token !== "string" || token === "") {
    throw new UnauthorizedError("Invalid or expired token");
  }

  try {
    let userId: string;
    let sessionId: string | undefined;
    if (token.startsWith("wk_")) {
      // Durable credentials must not travel in URLs or access logs.
      if (!authHeader?.startsWith("Bearer ")) {
        throw new UnauthorizedError("API keys require an Authorization header");
      }
      const key = await verifyApiKey(request.server.prisma, token);
      userId = key.userId;
      request.apiKeyId = key.id;
    } else {
      let payload: ReturnType<typeof verifyAccessToken>;
      try {
        payload = verifyAccessToken(token);
      } catch {
        throw new UnauthorizedError("Invalid or expired token");
      }
      // Only an absent sid receives the legacy JWT-expiry grace. A malformed
      // present claim must never bypass the family check or reach Prisma.
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof payload.sub !== "string" ||
        payload.sub === "" ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        (Object.hasOwn(payload, "sid") &&
          (typeof payload.sid !== "string" || payload.sid === ""))
      ) {
        throw new UnauthorizedError("Invalid or expired token");
      }
      userId = payload.sub;
      sessionId = payload.sid as string | undefined;
    }

    // One statement checks the account and its owned, unrevoked, unexpired
    // session. Rotation replaces the current token atomically, so the query
    // sees its predecessor or successor, never a gap. No cache delays logout.
    const user = await request.server.prisma.user.findUnique({
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

    if (!user) {
      throw new UnauthorizedError("Invalid or expired token");
    }

    request.user = user;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    // Database exceptions can contain queries and credential-related values.
    // Keep both the response and this operational event independent of them.
    request.log.error("Authentication lookup failed");
    throw new AppError(
      503,
      "Service Unavailable",
      "Authentication is temporarily unavailable. Try again in a moment.",
    );
  }
}
