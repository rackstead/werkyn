import assert from "node:assert/strict";
import test from "node:test";
import {
  FileQuerySchema,
  ProjectQuerySchema,
  TaskQuerySchema,
  WikiCommentQuerySchema,
} from "../dist/index.js";

const filters = [
  ["project archive", ProjectQuerySchema, "archived", false],
  ["task archive", TaskQuerySchema, "archived", false],
  ["file trash", FileQuerySchema, "trashed", false],
  ["wiki resolution", WikiCommentQuerySchema, "resolved", undefined],
];

for (const [name, schema, field, defaultValue] of filters) {
  test(`${name} preserves query boolean meaning and defaults`, () => {
    assert.equal(schema.parse({})[field], defaultValue);
    assert.equal(schema.parse({ [field]: undefined })[field], defaultValue);
    for (const [input, expected] of [
      ["false", false],
      ["true", true],
      [false, false],
      [true, true],
    ]) {
      assert.equal(schema.parse({ [field]: input })[field], expected);
    }
    for (const input of [
      "",
      "0",
      "1",
      "FALSE",
      "TRUE",
      "False",
      " true",
      "false ",
      "anything",
      ["false"],
      ["true", "false"],
      [],
      null,
      0,
      1,
      {},
    ]) {
      assert.equal(schema.safeParse({ [field]: input }).success, false);
    }
  });
}
