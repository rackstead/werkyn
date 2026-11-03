import assert from "node:assert/strict";
import { test } from "node:test";
import { RestoreWikiPageVersionSchema, UpdateWikiPageSchema } from "../dist/index.js";

test("historical restore requires an Int32 revision, including zero", () => {
  for (const expectedRevision of [0, 1, 2147483647])
    assert.deepEqual(RestoreWikiPageVersionSchema.parse({ expectedRevision }), { expectedRevision });
  for (const body of [undefined, null, {}, { expectedRevision: null }, { expectedRevision: "1" },
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: 2147483648 }])
    assert.equal(RestoreWikiPageVersionSchema.safeParse(body).success, false);
});
test("ordinary wiki PATCH continues to allow an omitted revision", () => {
  assert.deepEqual(UpdateWikiPageSchema.parse({ title: "Optional PATCH" }), { title: "Optional PATCH" });
});
