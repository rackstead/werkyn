import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import "@pm/shared";

const { validationDetails } = await import("../src/utils/validation-details.ts");

const details = (schema, input) => validationDetails(schema.safeParse(input).error.issues);

test("a field with the wrong type reports only its type error, as Zod 3 did", () => {
  const schema = z.object({
    userId: z.string().min(1, "User ID is required"),
    taskIds: z.array(z.string()).min(1).max(50),
    name: z.string().max(3),
  });
  // Zod 4 also runs the length checks on the wrong-typed values.
  assert.ok(schema.safeParse({ userId: [], taskIds: "", name: "abcd" }).error.issues.length > 3);
  assert.deepEqual(details(schema, { userId: [], taskIds: "", name: "abcd" }), [
    { field: "userId", message: "Expected string, received array" },
    { field: "taskIds", message: "Expected array, received string" },
    { field: "name", message: "String must contain at most 3 character(s)" },
  ]);
});

test("independent problems of one field and nested paths are all kept", () => {
  const schema = z.object({
    password: z.string().min(8, "too short").regex(/\d/, "needs a digit"),
    items: z.array(z.object({ id: z.string() })),
  });
  assert.deepEqual(details(schema, { password: "abc", items: [{ id: 1 }, {}] }), [
    { field: "password", message: "too short" },
    { field: "password", message: "needs a digit" },
    { field: "items.0.id", message: "Expected string, received number" },
    { field: "items.1.id", message: "Required" },
  ]);
});
