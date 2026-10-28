import fp from "fastify-plugin";
import type { FastifyInstance, FastifyError } from "fastify";
import { Prisma } from "@prisma/client";
import { AppError, ValidationError, LockedError } from "../utils/errors.js";
import { ZodError } from "zod";
import { env } from "../config/env.js";

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

const INTERNAL_ERROR: ErrorBody = {
  statusCode: 500,
  error: "Internal Server Error",
  message: "An unexpected error occurred",
};
const INVALID_VALUE: ErrorBody = {
  statusCode: 400,
  error: "Bad Request",
  message: "The request contains a value that cannot be stored",
};
const RELATED_CONFLICT: ErrorBody = {
  statusCode: 409,
  error: "Conflict",
  message: "The request conflicts with a related record",
};
const NOT_FOUND: ErrorBody = {
  statusCode: 404,
  error: "Not Found",
  message: "Resource not found",
};

// Prisma error codes that describe the request rather than the server.
// Codes about values already stored (P2005, P2023) are server errors.
// https://www.prisma.io/docs/orm/reference/error-reference
const PRISMA_REQUEST_ERRORS: Record<string, ErrorBody> = {
  P2000: INVALID_VALUE, // value too long for its column
  P2006: INVALID_VALUE, // value not valid for the field
  P2007: INVALID_VALUE, // data validation error
  P2011: INVALID_VALUE, // null constraint violation
  P2012: INVALID_VALUE, // missing required value
  P2019: INVALID_VALUE, // input error
  P2020: INVALID_VALUE, // value out of range for the type
  P2033: INVALID_VALUE, // number does not fit in a 64-bit integer
  P2002: {
    statusCode: 409,
    error: "Conflict",
    message: "A record with these values already exists",
  },
  P2003: RELATED_CONFLICT, // foreign key constraint
  P2014: RELATED_CONFLICT, // required relation violation
  P2034: {
    statusCode: 409,
    error: "Conflict",
    message: "The request conflicted with a concurrent change; try again",
  },
  P2015: NOT_FOUND, // related record not found
  P2018: NOT_FOUND, // required connected records not found
  P2025: NOT_FOUND, // record to update or delete not found
};

/** PostgreSQL class 22 "data exception": a value the database cannot accept. */
function isDataException(sqlState: unknown) {
  return typeof sqlState === "string" && /^22[0-9A-Z]{3}$/.test(sqlState);
}

/**
 * The response for an error thrown by Prisma, or null for any other error.
 * Prisma messages quote the query, its arguments, source file locations and
 * database error text, so they are logged and never sent to clients.
 */
function prismaErrorResponse(error: unknown): ErrorBody | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2010 wraps a raw query failure and carries its SQLSTATE in meta.code.
    if (error.code === "P2010" && isDataException(error.meta?.code)) {
      return INVALID_VALUE;
    }
    return PRISMA_REQUEST_ERRORS[error.code] ?? INTERNAL_ERROR;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    // Database errors without a Prisma code, such as U+0000 in text (22021)
    // or JSON (22P05), are only identified by the SQLSTATE in the message.
    const sqlState = /\bcode: "([0-9A-Z]{5})"/.exec(error.message)?.[1];
    return isDataException(sqlState) ? INVALID_VALUE : INTERNAL_ERROR;
  }
  if (
    // An invalid query is a server bug (request values that used to cause
    // one, such as an infinite rate, are rejected by the request schemas).
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return INTERNAL_ERROR;
  }
  return null;
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.setErrorHandler(
    (error: FastifyError | Error, request, reply) => {
      // A failed download may already have selected a binary response type.
      // Every branch below sends a JSON error object, not the original file.
      reply.type("application/json");
      reply.removeHeader("Content-Disposition");
      // Fastify stages stream headers on ServerResponse before reading bytes.
      // Removing its pending header alone leaves that staged value in place.
      if (!reply.raw.headersSent) {
        reply.raw.removeHeader("Content-Disposition");
      }

      // Known application errors
      if (error instanceof AppError) {
        const response: Record<string, unknown> = {
          statusCode: error.statusCode,
          error: error.error,
          message: error.message,
        };
        if (error instanceof ValidationError && error.details) {
          response.details = error.details;
        }
        if (error instanceof LockedError) {
          reply.header("Retry-After", String(error.retryAfter));
        }
        return reply.status(error.statusCode).send(response);
      }

      // Zod validation errors
      if (error instanceof ZodError) {
        const details = error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        }));
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "Validation failed",
          details,
        });
      }

      // Fastify validation errors (from schema)
      if ("validation" in error && error.validation) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: error.message,
        });
      }

      const prismaResponse = prismaErrorResponse(error);
      if (prismaResponse) {
        if (prismaResponse.statusCode >= 500) {
          request.log.error(error);
        } else {
          request.log.warn({ err: error }, "Database rejected the request");
        }
        return reply.status(prismaResponse.statusCode).send({ ...prismaResponse });
      }

      // Errors with an explicit statusCode (e.g. rate-limit 429)
      const statusCode =
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 500;

      if (statusCode < 500) {
        return reply.status(statusCode).send({
          statusCode,
          error: error.message,
          message: error.message,
        });
      }

      // Unhandled errors
      request.log.error(error);

      if (env.NODE_ENV === "production") {
        return reply.status(500).send({
          statusCode: 500,
          error: "Internal Server Error",
          message: "An unexpected error occurred",
        });
      }

      return reply.status(500).send({
        statusCode: 500,
        error: "Internal Server Error",
        message: error.message,
        stack: error.stack,
      });
    },
  );
});
