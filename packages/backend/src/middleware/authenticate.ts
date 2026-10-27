import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "../utils/tokens.js";
import { UnauthorizedError } from "../utils/errors.js";
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

  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken!;

  try {
    let userId: string;
    if (token.startsWith("wk_")) {
      // Durable credentials must not travel in URLs or access logs.
      if (!authHeader?.startsWith("Bearer ")) {
        throw new UnauthorizedError("API keys require an Authorization header");
      }
      const key = await verifyApiKey(request.server.prisma, token);
      userId = key.userId;
      request.apiKeyId = key.id;
    } else {
      userId = verifyAccessToken(token).sub;
    }

    const user = await request.server.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        emailVerified: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError("User not found");
    }

    request.user = user;
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    throw new UnauthorizedError("Invalid or expired token");
  }
}
