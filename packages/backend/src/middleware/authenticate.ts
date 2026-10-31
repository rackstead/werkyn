import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "../utils/tokens.js";
import { UnauthorizedError } from "../utils/errors.js";
import { verifyApiKey } from "../modules/api-keys/api-keys.service.js";
import {
  findAuthenticatedUser,
  failAuthenticationLookup,
} from "../utils/authenticated-user.js";

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }

  const token = authHeader.slice(7);
  if (typeof token !== "string" || token === "") {
    throw new UnauthorizedError("Invalid or expired token");
  }

  let lookupStage: "api_key" | "account" | "session_account" = "account";
  try {
    let userId: string;
    let sessionId: string | undefined;
    let accessClaims: FastifyRequest["accessClaims"];
    if (token.startsWith("wk_")) {
      // Durable credentials, like access JWTs, require the header.
      lookupStage = "api_key";
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
      accessClaims = {
        sub: userId,
        exp: payload.exp,
        ...(sessionId === undefined ? {} : { sid: sessionId }),
      };
    }

    // One statement checks the account and its owned, unrevoked, unexpired
    // session. Rotation replaces the current token atomically, so the query
    // sees its predecessor or successor, never a gap. No cache delays logout.
    lookupStage = sessionId === undefined ? "account" : "session_account";
    const user = await findAuthenticatedUser(
      request.server.prisma,
      userId,
      sessionId,
    );

    if (!user) {
      throw new UnauthorizedError("Invalid or expired token");
    }

    request.user = user;
    request.accessClaims = accessClaims;
  } catch (error) {
    failAuthenticationLookup(request, error, lookupStage);
  }
}
