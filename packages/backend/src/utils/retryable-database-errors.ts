import { Prisma } from "@prisma/client";

// PostgreSQL rolls back one transaction to resolve a deadlock (40P01) or a
// serialization failure (40001); retrying the request can succeed. Prisma
// reports these as P2034 only in some cases. Inside interactive transactions a
// model query surfaces them as an unknown request error that carries the
// SQLSTATE in its message, and a raw query as P2010 with meta.code.
const RETRYABLE_SQLSTATES = new Set(["40P01", "40001"]);

function sqlState(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code !== "P2010") return undefined;
    const code = error.meta?.code;
    return typeof code === "string" ? code : undefined;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /\bcode: "([0-9A-Z]{5})"/.exec(error.message)?.[1];
  }
  return undefined;
}

/**
 * True when the database abandoned the transaction so that another could
 * proceed (P2034, 40P01, 40001), or the transaction expired or could not start
 * in time (P2028), for example while it waited for a row lock.
 */
export function isRetryableDatabaseError(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || error.code === "P2028")
  ) {
    return true;
  }
  const state = sqlState(error);
  return state !== undefined && RETRYABLE_SQLSTATES.has(state);
}
