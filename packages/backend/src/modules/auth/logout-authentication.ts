import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/authenticate.js";

interface ExpiredLogoutProof {
  userId: string;
  sessionId: string;
}
const proofs = new WeakMap<FastifyRequest, ExpiredLogoutProof>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A signed expired JWT is a selector for logout, never an access credential. */
export async function authenticateLogout(request: FastifyRequest, reply: FastifyReply) {
  reply.header("Cache-Control", "no-store");
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_SECRET, {
        algorithms: ["HS256"], ignoreExpiration: true,
      });
      if (typeof payload === "object" && payload !== null &&
          typeof payload.sub === "string" && payload.sub !== "" &&
          typeof payload.sid === "string" && UUID.test(payload.sid) &&
          typeof payload.exp === "number" && Number.isFinite(payload.exp) &&
          payload.exp * 1000 <= Date.now()) {
        proofs.set(request, { userId: payload.sub, sessionId: payload.sid.toLowerCase() });
        return;
      }
    } catch {
      // Normal authentication retains its existing malformed-token response.
    }
  }
  await authenticate(request, reply);
}

export const expiredLogoutProof = (request: FastifyRequest) => proofs.get(request);
