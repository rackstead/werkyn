import assert from "node:assert/strict";
import test from "node:test";
import {
  hasUnpairedSurrogate,
  jsonStorageIssue,
  jsonValueHasUnpairedSurrogate,
} from "../dist/index.js";

const PAIR = "\uD83D\uDE00";

test("a well-formed surrogate pair is not an unpaired surrogate", () => {
  assert.equal(hasUnpairedSurrogate("\uD800"), true);
  assert.equal(hasUnpairedSurrogate("\uDFFF"), true);
  assert.equal(hasUnpairedSurrogate("\uD800\uD800"), true);
  assert.equal(hasUnpairedSurrogate("\uDE00\uD83D"), true);
  assert.equal(hasUnpairedSurrogate(`${PAIR}\uD800`), true);
  assert.equal(hasUnpairedSurrogate(PAIR), false);
  assert.equal(hasUnpairedSurrogate(`ok ${PAIR} ok`), false);
  assert.equal(hasUnpairedSurrogate("\u0000"), false);
  assert.equal(hasUnpairedSurrogate("\\uD800"), false);
});

test("stored JSON still rejects NUL and an unpaired surrogate, and keeps a pair", () => {
  assert.equal(jsonStorageIssue("\u0000"), "Contains a character that cannot be stored");
  assert.equal(jsonStorageIssue("\uD800"), "Contains a character that cannot be stored");
  assert.equal(jsonStorageIssue(PAIR), undefined);
  assert.equal(jsonStorageIssue({ [PAIR]: [PAIR] }), undefined);
});

test("a JSON value scan finds unpaired surrogates and ignores NUL", () => {
  assert.equal(jsonValueHasUnpairedSurrogate("\uD800"), true);
  assert.equal(jsonValueHasUnpairedSurrogate(["ok", { nested: "\uDFFF" }]), true);
  assert.equal(jsonValueHasUnpairedSurrogate({ "\uD800": "ok" }), true);
  assert.equal(jsonValueHasUnpairedSurrogate({ [PAIR]: "\u0000" }), false);
  assert.equal(jsonValueHasUnpairedSurrogate({ name: "a\u0000b" }), false);
  assert.equal(jsonValueHasUnpairedSurrogate(PAIR), false);
  const shared = { name: "\uDC00" };
  assert.equal(jsonValueHasUnpairedSurrogate({ a: shared, b: shared }), true);
  const cycle = {};
  cycle.self = cycle;
  assert.equal(jsonValueHasUnpairedSurrogate(cycle), false);
});

test("a JSON value scan does not invoke accessors", () => {
  let invoked = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      invoked += 1;
      return "\uD800";
    },
  });
  assert.equal(jsonValueHasUnpairedSurrogate(accessor), false);
  assert.equal(invoked, 0);
});
