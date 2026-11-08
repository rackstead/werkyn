import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  decideLegacyShareLookup,
  scrubNestedShareLinkArgs,
} from "../modules/files/legacy-share-lookup.js";

const LEGACY_SHARE_READS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

// Direct FileShareLink reads miss an 8-character token, including aggregate
// and groupBy. Relation filters on other models are rewritten the same way.
// Writes, and listings that do not ask for that token, still see the row.
function withLegacyShareTokenRejection(base: PrismaClient): PrismaClient {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const nested = scrubNestedShareLinkArgs(args);
          const next = nested.changed ? nested.args : args;
          if (
            model !== "FileShareLink" ||
            !LEGACY_SHARE_READS.has(operation) ||
            !next ||
            typeof next !== "object" ||
            !("where" in next)
          ) {
            return nested.changed ? query(next as typeof args) : query(args);
          }
          const decision = decideLegacyShareLookup(
            (next as { where?: unknown }).where,
          );
          if (decision.action === "pass") {
            return nested.changed ? query(next as typeof args) : query(args);
          }
          if (decision.action === "rewrite") {
            return query({
              ...(next as object),
              where: decision.where,
            } as typeof args);
          }
          // Impossible row: aggregate and groupBy keep their empty shape.
          if (operation === "aggregate" || operation === "groupBy" || operation.endsWith("OrThrow")) {
            return query({ ...(next as object), where: { id: "" } } as typeof args);
          }
          if (operation === "findMany") return [];
          if (operation === "count") return 0;
          return null;
        },
      },
    },
  }) as unknown as PrismaClient;
}

export default fp(async (fastify: FastifyInstance) => {
  const prisma = withLegacyShareTokenRejection(new PrismaClient());
  await prisma.$connect();

  fastify.decorate("prisma", prisma);

  fastify.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
