import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  CreateInviteSchema,
  CreateTaskSchema,
  LoginSchema,
  QueryBooleanSchema,
  RegisterSchema,
  SetCustomFieldValueSchema,
  isoDateTime,
} from "../dist/index.js";

const messages = (schema, input) => schema.safeParse(input).error?.issues.map((issue) => issue.message);

// Importing @pm/shared installs the Zod 3 wording; these are the messages Zod 3
// gave for each issue kind, which API `details` and form errors carry.
test("issue messages keep the Zod 3 wording", () => {
  assert.deepEqual(messages(z.object({ a: z.string() }), {}), ["Required"]);
  assert.deepEqual(messages(z.string(), 1), ["Expected string, received number"]);
  assert.deepEqual(messages(z.number(), "1"), ["Expected number, received string"]);
  assert.deepEqual(messages(z.number(), Number.NaN), ["Expected number, received nan"]);
  assert.deepEqual(messages(z.array(z.string()), null), ["Expected array, received null"]);
  assert.deepEqual(messages(z.record(z.string(), z.unknown()), []), ["Expected object, received array"]);
  assert.deepEqual(messages(z.number().int(), 1.5), ["Expected integer, received float"]);
  assert.deepEqual(messages(z.coerce.number().int(), "Infinity"), ["Number must be finite"]);

  const role = z.enum(["ADMIN", "MEMBER"]);
  assert.deepEqual(messages(z.object({ role }), {}), ["Required"]);
  assert.deepEqual(messages(role, "OWNER"), ["Invalid enum value. Expected 'ADMIN' | 'MEMBER', received 'OWNER'"]);
  assert.deepEqual(messages(role, 3), ["Expected 'ADMIN' | 'MEMBER', received number"]);

  assert.deepEqual(messages(z.string().min(2), "a"), ["String must contain at least 2 character(s)"]);
  assert.deepEqual(messages(z.string().max(2), "abc"), ["String must contain at most 2 character(s)"]);
  assert.deepEqual(messages(z.string().length(2), "abc"), ["String must contain exactly 2 character(s)"]);
  assert.deepEqual(messages(z.array(z.string()).min(1), []), ["Array must contain at least 1 element(s)"]);
  assert.deepEqual(messages(z.array(z.string()).max(1), ["a", "b"]), ["Array must contain at most 1 element(s)"]);
  assert.deepEqual(messages(z.number().min(1), 0), ["Number must be greater than or equal to 1"]);
  assert.deepEqual(messages(z.number().gt(1), 1), ["Number must be greater than 1"]);
  assert.deepEqual(messages(z.number().max(5), 6), ["Number must be less than or equal to 5"]);
  assert.deepEqual(messages(z.number().lt(5), 5), ["Number must be less than 5"]);
  assert.deepEqual(messages(z.number().multipleOf(5), 6), ["Number must be a multiple of 5"]);

  assert.deepEqual(messages(z.string().email(), "nope"), ["Invalid email"]);
  assert.deepEqual(messages(z.string().url(), "nope"), ["Invalid url"]);
  assert.deepEqual(messages(z.string().datetime(), "nope"), ["Invalid datetime"]);
  assert.deepEqual(messages(z.string().regex(/^a$/), "b"), ["Invalid"]);
  assert.deepEqual(messages(z.union([z.string(), z.number()]), null), ["Invalid input"]);
  assert.deepEqual(messages(z.string().refine(() => false), "x"), ["Invalid input"]);
  assert.deepEqual(messages(z.object({}).strict(), { a: 1 }), ["Unrecognized key(s) in object: 'a'"]);
});

test("a message the schema sets still wins", () => {
  assert.deepEqual(messages(z.string().min(1, "Name is required"), ""), ["Name is required"]);
  assert.deepEqual(messages(z.string({ error: "Custom" }), 1), ["Custom"]);
  const login = LoginSchema.safeParse({ email: "x", password: "" });
  assert.equal(login.success, false);
  assert.ok(login.error.issues.length > 0);
  assert.deepEqual(messages(CreateTaskSchema, { title: "" }), ["Title is required"]);
  assert.equal(RegisterSchema.safeParse({}).error.issues[0].message, "Required");
});

test("a union whose list option is over its cap names the cap, without checking each element", () => {
  const cap = "A MULTI_SELECT value can list at most 200 options";
  assert.deepEqual(messages(SetCustomFieldValueSchema, { value: Array(201).fill("a") }), [cap]);
  // Zod 4.6.6 stops at the length, so 300,000 wrong elements give one issue
  // (Zod 3 checked them all and said "Invalid input").
  assert.deepEqual(messages(SetCustomFieldValueSchema, { value: Array(300_000).fill(0) }), [cap]);
  // Within the cap, a bad element or a value of no option's type reads as on Zod 3.
  for (const value of [["a", 5], {}]) {
    const issues = SetCustomFieldValueSchema.safeParse({ value }).error.issues;
    assert.deepEqual(issues.map((issue) => [issue.path.join("."), issue.message]), [["value", "Invalid input"]]);
  }
  // A union of a type and an enum still gives Zod 3's summary for a value of neither.
  for (const value of [null, 0, "yes"]) assert.deepEqual(messages(QueryBooleanSchema, value), ["Invalid input"], String(value));
});

test("datetimes take optional seconds and fractions, as Zod 3's .datetime() did", () => {
  const datetime = isoDateTime();
  for (const value of ["2026-01-01T00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.123Z", "2026-01-01T23:59:59.123456Z"]) {
    assert.equal(datetime.safeParse(value).success, true, value);
  }
  for (const value of ["2026-01-01", "2026-01-01T00:00", "2026-01-01T00:00:00+02:00", "2026-13-01T00:00Z", "2026-01-01T24:00Z", "soon"]) {
    assert.deepEqual(messages(datetime, value), ["Invalid datetime"], value);
  }
  assert.deepEqual(messages(datetime, 5), ["Expected string, received number"]);
  assert.equal(CreateInviteSchema.safeParse({ expiresAt: "2026-01-01T00:00Z" }).success, true);
});
