import assert from "node:assert/strict";
import { test } from "node:test";
import { RestoreWikiPageVersionSchema, UpdateWikiPageSchema, UpdateTaskSchema } from "../dist/index.js";

test("historical restore requires an Int32 revision, including zero", () => {
  for (const expectedRevision of [0, 1, 2147483647])
    assert.deepEqual(RestoreWikiPageVersionSchema.parse({ expectedRevision }), { expectedRevision });
  for (const body of [undefined, null, {}, { expectedRevision: null }, { expectedRevision: "1" },
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: 2147483648 }])
    assert.equal(RestoreWikiPageVersionSchema.safeParse(body).success, false);
});
test("ordinary wiki PATCH requires the reviewed Int32 revision for every field", () => {
  for (const patch of [{ title: "Edit" }, { content: null }, { icon: null }]) {
    assert.equal(UpdateWikiPageSchema.safeParse(patch).success, false);
    for (const expectedRevision of [0, 2147483647])
      assert.deepEqual(UpdateWikiPageSchema.parse({ ...patch, expectedRevision }), { ...patch, expectedRevision });
    for (const expectedRevision of [null, "0", -1, 0.5, 2147483648, Infinity, NaN])
      assert.equal(UpdateWikiPageSchema.safeParse({ ...patch, expectedRevision }).success, false);
  }
});
test("task descriptions require revisions including clears; metadata-only fields remain independent", () => {
  for (const description of ["text", "", null]) {
    assert.equal(UpdateTaskSchema.safeParse({ description }).success, false);
    for (const expectedDescriptionRevision of [0, 2147483647])
      assert.deepEqual(UpdateTaskSchema.parse({ description, expectedDescriptionRevision }), { description, expectedDescriptionRevision });
    for (const expectedDescriptionRevision of [null, "0", -1, 0.5, 2147483648, Infinity, NaN])
      assert.equal(UpdateTaskSchema.safeParse({ description, expectedDescriptionRevision }).success, false);
  }
  assert.deepEqual(UpdateTaskSchema.parse({ title: "Metadata only", priority: "HIGH" }), { title: "Metadata only", priority: "HIGH" });
});
