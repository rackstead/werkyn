import type { FastifyRequest, FastifyReply } from "fastify";
import type { ZodType } from "zod";
import { validationDetails } from "../utils/validation-details.js";

export function validate(schema: ZodType) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      const details = validationDetails(result.error.issues);
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details,
      });
    }
    request.body = result.data;
  };
}

export function validateQuery(schema: ZodType) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.query);
    if (!result.success) {
      const details = validationDetails(result.error.issues);
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details,
      });
    }
    request.query = result.data as typeof request.query;
  };
}

export function validateParams(schema: ZodType) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = schema.safeParse(request.params);
    if (!result.success) {
      const details = validationDetails(result.error.issues);
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        details,
      });
    }
    request.params = result.data as typeof request.params;
  };
}
