import { env } from "../config/env.js";
import type { FastifyServerOptions } from "fastify";
import { baseLoggerOptions } from "../utils/logger.js";
import { serializeError, serializeRequest } from "../utils/log-redaction.js";

export function getLoggerConfig(): FastifyServerOptions["logger"] {
  const options = {
    ...baseLoggerOptions(env.LOG_LEVEL),
    serializers: { req: serializeRequest, err: serializeError },
  };

  if (env.NODE_ENV === "development") {
    return {
      ...options,
      transport: {
        target: "pino-pretty",
      },
    };
  }

  return options;
}
