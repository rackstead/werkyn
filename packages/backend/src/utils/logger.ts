import pino from "pino";
import type { DestinationStream, LoggerOptions } from "pino";
import { logMethodHook, redactOptions, serializeError } from "./log-redaction.js";

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/**
 * Options shared by the standalone logger and the Fastify request logger:
 * credential fields are censored and URL tokens are removed from messages.
 */
export function baseLoggerOptions(level: string | undefined): LoggerOptions {
  return {
    // An unknown level would make pino throw before config/env.ts can report
    // the invalid LOG_LEVEL, so fall back here and let validation fail loudly.
    level: level && LEVELS.has(level) ? level : "info",
    redact: redactOptions,
    serializers: { err: serializeError },
    hooks: logMethodHook,
  };
}

export function createLogger(stream?: DestinationStream) {
  const options = baseLoggerOptions(process.env.LOG_LEVEL);
  if (stream) return pino(options, stream);
  return pino({
    ...options,
    ...(process.env.NODE_ENV === "development" && {
      transport: { target: "pino-pretty" },
    }),
  });
}

/**
 * Standalone logger for non-request contexts (startup, mailer, etc.).
 * Uses the same log level as the Fastify request logger.
 */
export const logger = createLogger();
