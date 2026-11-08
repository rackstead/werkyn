import type { FastifyInstance, FastifyRequest } from "fastify";
import { jsonValueHasUnpairedSurrogate } from "@pm/shared";
import { ValidationError } from "../utils/errors.js";

const UNPAIRED_SURROGATE_MESSAGE =
  "The request contains a character that cannot be stored";

type JsonDone = (error: Error | null, value?: unknown) => void;

/**
 * Fastify's application/json parser, plus a refusal of unpaired UTF-16
 * surrogates. Invalid JSON, empty bodies and prototype checks stay on the
 * default parser. U+0000 is not refused here. The cursor query parameter is
 * not an HTTP body and is checked with the same surrogate test separately.
 */
export function installJsonBodyParser(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser(
    app.initialConfig.onProtoPoisoning ?? "error",
    app.initialConfig.onConstructorPoisoning ?? "error",
  ) as (
    request: FastifyRequest,
    body: string | Buffer,
    done: JsonDone,
  ) => void;

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      parseJson(request, body, (error, value) => {
        if (error) {
          done(error);
          return;
        }
        if (jsonValueHasUnpairedSurrogate(value)) {
          done(new ValidationError(UNPAIRED_SURROGATE_MESSAGE));
          return;
        }
        done(null, value);
      });
    },
  );
}
