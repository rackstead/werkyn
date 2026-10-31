import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { describeAuthenticationFailure as describe } from "../src/utils/authentication-failures.ts";

const privateValue = "credential-or-query-must-stay-private";
const known = (code, meta) => new Prisma.PrismaClientKnownRequestError(privateValue, { clientVersion: "test", code, meta });
test("authentication operational Prisma codes have bounded retryable diagnostics", () => {
  for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034", "P2037"])
    assert.deepEqual(describe(known(code)), { statusCode: 503, category: "database_operation", code });
  assert.deepEqual(describe(new Prisma.PrismaClientInitializationError(privateValue, "test", "P1001")), { statusCode: 503, category: "initialization", code: "P1001" });
});
test("authentication schema and query faults remain safe server errors", () => {
  for (const [code, category] of [["P2010", "query"], ["P2021", "schema"], ["P2022", "schema"], ["P2025", "record_missing"]])
    assert.deepEqual(describe(known(code)), { statusCode: 500, category, code });
  assert.deepEqual(describe(new Prisma.PrismaClientValidationError(privateValue, { clientVersion: "test" })), { statusCode: 500, category: "query_validation" });
  assert.deepEqual(describe(new TypeError(privateValue)), { statusCode: 500, category: "programming" });
});
test("recognized operational SQLSTATE diagnostics work for raw and model query errors", () => {
  for (const sqlState of ["55P03", "57014", "40P01", "40001", "08006", "53300", "57P01"]) {
    assert.deepEqual(describe(known("P2010", { code: sqlState })), { statusCode: 503, category: "database_operation", code: "P2010", sqlState });
    assert.deepEqual(describe(new Prisma.PrismaClientUnknownRequestError(`${privateValue} code: "${sqlState}"`, { clientVersion: "test" })), { statusCode: 503, category: "database_operation", sqlState });
  }
});
test("authentication diagnostics never copy arbitrary names, codes, messages, metadata or getters", () => {
  const hostile = Object.defineProperty({}, "code", { get() { throw new Error(privateValue); } });
  const trapping = new Proxy({}, { getPrototypeOf() { throw new Error(privateValue); } });
  const failures = [hostile, trapping, new Error(privateValue), { name: privateValue, code: "P1001", message: privateValue }, known(privateValue, { code: privateValue }), known("P2010", { code: privateValue }), new Prisma.PrismaClientUnknownRequestError(`${privateValue} code: "XXXXX"`, { clientVersion: "test" })];
  for (const error of failures) {
    const result = describe(error);
    assert.equal(result.statusCode, 500);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});
