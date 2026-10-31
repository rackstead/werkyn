import { Prisma } from "@prisma/client";

const OPERATIONAL_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2028",
  "P2034",
  "P2037",
]);
const QUERY_CODES = new Map([
  ["P2010", "query"],
  ["P2021", "schema"],
  ["P2022", "schema"],
  ["P2025", "record_missing"],
]);
const OPERATIONAL_STATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
]);

export interface AuthenticationFailure {
  statusCode: 500 | 503;
  category: string;
  code?: string;
  sqlState?: string;
}

/** Only fixed labels and recognized codes leave this function, never messages. */
export function describeAuthenticationFailure(
  error: unknown,
): AuthenticationFailure {
  try {
    if (error instanceof Prisma.PrismaClientInitializationError) {
      return {
        statusCode: 503,
        category: "initialization",
        ...(error.errorCode && OPERATIONAL_CODES.has(error.errorCode)
          ? { code: error.errorCode }
          : {}),
      };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const code = error.code;
      const state = error.meta?.code;
      if (
        code === "P2010" &&
        typeof state === "string" &&
        OPERATIONAL_STATES.has(state)
      ) {
        return {
          statusCode: 503,
          category: "database_operation",
          code,
          sqlState: state,
        };
      }
      if (OPERATIONAL_CODES.has(code))
        return { statusCode: 503, category: "database_operation", code };
      const category = QUERY_CODES.get(code);
      return {
        statusCode: 500,
        category: category ?? "database_query",
        ...(category ? { code } : {}),
      };
    }
    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const state = /\bcode: "([0-9A-Z]{5})"/.exec(error.message)?.[1];
      if (state && OPERATIONAL_STATES.has(state))
        return {
          statusCode: 503,
          category: "database_operation",
          sqlState: state,
        };
      return { statusCode: 500, category: "database_query" };
    }
    if (error instanceof Prisma.PrismaClientValidationError)
      return { statusCode: 500, category: "query_validation" };
    if (error instanceof Prisma.PrismaClientRustPanicError)
      return { statusCode: 500, category: "database_engine" };
    if (
      error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof RangeError
    )
      return { statusCode: 500, category: "programming" };
  } catch {
    // A thrown object may contain hostile getters or a trapping prototype.
  }
  return { statusCode: 500, category: "unknown" };
}
