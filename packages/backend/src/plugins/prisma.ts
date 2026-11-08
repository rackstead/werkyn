import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { decideLegacyShareLookup } from "../modules/files/legacy-share-lookup.js";

const LEGACY_SHARE_READS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
]);

// Every FileShareLink read on the app client misses an 8-character token,
// including lookups added later. Writes and listings that do not ask for
// that token are unchanged, so the owner can still see and delete the row.
function withLegacyShareTokenRejection(base: PrismaClient): PrismaClient {
  return base.$extends({
    query: {
      fileShareLink: {
        async $allOperations({ operation, args, query }) {
          if (
            !LEGACY_SHARE_READS.has(operation) ||
            !args ||
            typeof args !== "object" ||
            !("where" in args)
          ) {
            return query(args);
          }
          const decision = decideLegacyShareLookup(
            (args as { where?: unknown }).where,
          );
          if (decision.action === "pass") return query(args);
          if (decision.action === "rewrite") {
            return query({
              ...args,
              where: decision.where as typeof args.where,
            });
          }
          if (operation === "findMany") return [];
          if (operation === "count") return 0;
          if (operation.endsWith("OrThrow")) {
            return query({ ...args, where: { id: "" } });
          }
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
