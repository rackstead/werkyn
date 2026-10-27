import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  FileQuerySchema,
  ProjectQuerySchema,
  TaskQuerySchema,
  WikiCommentQuerySchema,
} from "@pm/shared";
import { validateQuery } from "../src/middleware/validate.js";

for (const [name, schema, field, defaultValue] of [
  ["project archive", ProjectQuerySchema, "archived", false],
  ["task archive", TaskQuerySchema, "archived", false],
  ["file trash", FileQuerySchema, "trashed", false],
  ["wiki resolution", WikiCommentQuerySchema, "resolved", undefined],
]) {
  test(`${name}: HTTP query validation forwards typed booleans and rejects malformed filters before the handler`, async () => {
    const app = Fastify();
    let calls = 0;
    app.get("/fixture", { preHandler: validateQuery(schema) }, (request) => {
      calls++;
      const value = request.query[field];
      return { value, type: typeof value };
    });
    try {
      for (const [query, value] of [
        ["", defaultValue],
        [`?${field}=false`, false],
        [`?${field}=true`, true],
      ]) {
        const result = await app.inject({
          method: "GET",
          url: `/fixture${query}`,
        });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().value, value);
        assert.equal(result.json().type, typeof value);
      }
      const validCalls = calls;
      for (const query of [
        `${field}=`,
        `${field}=0`,
        `${field}=1`,
        `${field}=null`,
        `${field}=FALSE`,
        `${field}=True`,
        `${field}=%20false`,
        `${field}=false&${field}=true`,
        `${field}=false&${field}=false`,
      ]) {
        const result = await app.inject({
          method: "GET",
          url: `/fixture?${query}`,
        });
        assert.equal(result.statusCode, 400, result.body);
        assert.equal(result.json().message, "Validation failed");
        assert.ok(
          result.json().details.some((detail) => detail.field === field),
        );
        assert.equal(
          calls,
          validCalls,
          "invalid query must stop before the route handler",
        );
      }
    } finally {
      await app.close();
    }
  });
}
