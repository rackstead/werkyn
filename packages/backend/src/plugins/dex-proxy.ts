import fp from "fastify-plugin";
import replyFrom from "@fastify/reply-from";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { dexManager } from "../services/dex-manager.js";

async function forwardToDex(request: FastifyRequest, reply: FastifyReply) {
  if (!dexManager.isRunning) {
    return reply.code(503).send({ error: "SSO service is not running" });
  }

  // reply-from decodes the whole target, query included, to check for path
  // traversal, and throws on malformed percent-escapes.
  try {
    decodeURIComponent(request.url);
  } catch {
    return reply.code(400).send({ error: "Malformed request URL" });
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body;
  return reply.from(request.url, {
    rewriteRequestHeaders: (_request, headers) => {
      const { authorization, ...rest } = headers;
      return rest;
    },
    // reply-from reports a refused or reset connection to Dex as a 500 and a
    // DNS failure as a 503. Report them as a gateway failure instead.
    onError: (errorReply, { error }) => {
      const timedOut = (error as { statusCode?: number }).statusCode === 504;
      errorReply
        .code(timedOut ? 504 : 502)
        .send({
          error: timedOut
            ? "SSO service timed out"
            : "SSO service is unavailable",
        });
    },
    // Send the body bytes as received, with the client's content type.
    ...(Buffer.isBuffer(body)
      ? {
          body,
          contentType:
            request.headers["content-type"] ?? "application/octet-stream",
        }
      : {}),
  });
}

export default fp(async function dexProxy(app: FastifyInstance) {
  await app.register(replyFrom, {
    base: `http://127.0.0.1:${env.DEX_INTERNAL_PORT}`,
    undici: { connections: 10, pipelining: 1 },
  });

  // An encapsulated scope, so the body parser below applies only to /dex.
  await app.register(async function dexRoutes(scope) {
    // Dex's login pages post HTML forms, and its token and API endpoints take
    // their own media types. Buffer every body (within bodyLimit) unparsed so
    // it reaches Dex exactly as sent.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.all("/dex", forwardToDex);
    scope.all("/dex/*", forwardToDex);
  });
});
