import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateWikiPageSchema,
  UpdateWikiPageSchema,
  CreateWikiCommentSchema,
} from "../dist/index.js";

function nested(levels, kind = "object", leaf = "leaf") {
  let value = leaf;
  for (let i = 0; i < levels; i++)
    value =
      kind === "array" || (kind === "mixed" && i % 2)
        ? [value]
        : { child: value };
  return value;
}

const inputs = [
  ["create content", CreateWikiPageSchema, { title: "Page" }, "content", 123],
  ["update content", UpdateWikiPageSchema, {}, "content", 123],
  [
    "selectionStart",
    CreateWikiCommentSchema,
    { body: "Comment", highlightId: "h" },
    "selectionStart",
    121,
  ],
  [
    "selectionEnd",
    CreateWikiCommentSchema,
    { body: "Comment", highlightId: "h" },
    "selectionEnd",
    121,
  ],
];

for (const [name, schema, base, field, limit] of inputs) {
  test(`${name} counts object, array and mixed container depth`, () => {
    for (const kind of ["object", "array", "mixed"]) {
      const content = nested(limit, kind);
      assert.equal(
        schema.parse({ ...base, [field]: content })[field],
        content,
        "JSON must not be cloned",
      );
      const rejected = schema.safeParse({
        ...base,
        [field]: nested(limit + 1, kind),
      });
      assert.equal(rejected.success, false);
      assert.deepEqual(rejected.error.issues[0].path, [field]);
      assert.match(rejected.error.issues[0].message, new RegExp(`${limit}`));
      for (const empty of [{}, []]) {
        assert.equal(
          schema.safeParse({ ...base, [field]: nested(limit - 1, kind, empty) })
            .success,
          true,
        );
        assert.equal(
          schema.safeParse({ ...base, [field]: nested(limit, kind, empty) })
            .success,
          false,
        );
      }
    }
  });

  test(`${name} checks every string and member name without quoting it`, () => {
    for (const bad of ["secret\u0000", "secret\ud800", "secret\udfff"]) {
      for (const value of [bad, { x: [bad] }, { x: { [bad]: true } }]) {
        const rejected = schema.safeParse({ ...base, [field]: value });
        assert.equal(rejected.success, false);
        assert.deepEqual(rejected.error.issues[0].path, [field]);
        assert.doesNotMatch(rejected.error.issues[0].message, /secret/);
      }
    }
  });

  test(`${name} accepts JSON primitives, Unicode and optional fields`, () => {
    for (const value of [
      null,
      true,
      false,
      0,
      -1.25,
      "",
      "Zoë 李 😀\n\t\u000b",
      [],
      {},
      { "😀": [null, false] },
    ])
      assert.equal(schema.parse({ ...base, [field]: value })[field], value);
    assert.equal(schema.safeParse(base).success, true);
    assert.equal(
      schema.safeParse({ ...base, [field]: undefined }).success,
      true,
    );
  });
}

test("cycles and non-JSON values refuse safely without invoking accessors or toJSON", () => {
  const cycle = {};
  cycle.self = cycle;
  const arrayCycle = [];
  arrayCycle.push(arrayCycle);
  let invoked = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      invoked++;
      throw new Error("getter");
    },
  });
  const jsonMethod = {
    toJSON() {
      invoked++;
      throw new Error("toJSON");
    },
  };
  const hiddenMethod = Object.defineProperty({}, "toJSON", {
    value() {
      invoked++;
      throw new Error("hidden toJSON");
    },
  });
  const hiddenAccessor = Object.defineProperty({}, "toJSON", {
    get() {
      invoked++;
      throw new Error("hidden getter");
    },
  });
  for (const value of [
    cycle,
    arrayCycle,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => 1,
    Symbol("x"),
    { x: undefined },
    [undefined],
    Array(1),
    new Date(),
    accessor,
    jsonMethod,
    hiddenMethod,
    hiddenAccessor,
  ]) {
    const result = CreateWikiPageSchema.safeParse({
      title: "Page",
      content: value,
    });
    assert.equal(result.success, false, typeof value);
  }
  assert.equal(invoked, 0);
});

test("wide JSON and harmless shared subobjects remain compatible", () => {
  const shared = { text: "same" };
  const wide = {
    array: Array.from({ length: 10_000 }, (_, i) => ({ count: i })),
    object: Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`key${i}`, i]),
    ),
    aliases: [shared, shared],
  };
  assert.equal(
    CreateWikiPageSchema.parse({ title: "Wide", content: wide }).content,
    wide,
  );
  const literalKeys = {
    constructor: "plain",
    prototype: false,
    toJSON: "literal",
  };
  assert.equal(
    CreateWikiPageSchema.parse({ title: "Keys", content: literalKeys }).content,
    literalKeys,
  );
  assert.equal({}.safe, undefined);
});

test("serializer-interpreted object members are refused at every nested position", () => {
  const proto = JSON.parse('{"__proto__":{"literal":true},"safe":true}');
  const raw = { __prismaRawParameters__: true, values: [1, 2] };
  for (const value of [
    proto,
    raw,
    { items: [proto] },
    { items: [raw] },
    { __prismaRawParameters__: true },
  ]) {
    for (const [, schema, base, field] of inputs) {
      const result = schema.safeParse({ ...base, [field]: value });
      assert.equal(result.success, false);
      assert.deepEqual(result.error.issues[0].path, [field]);
      assert.doesNotMatch(
        result.error.issues[0].message,
        /__proto__|__prismaRawParameters__|"literal"/,
      );
    }
  }
});

test("supported literal keys and non-true markers retain identity", () => {
  for (const marker of [false, null, 0, 1, "true", {}, []]) {
    const value = {
      __prismaRawParameters__: marker,
      values: [1, 2],
      constructor: "literal",
      prototype: false,
      toJSON: "literal",
    };
    assert.equal(
      CreateWikiPageSchema.parse({ title: "Keys", content: value }).content,
      value,
    );
  }
  const value = {
    $type: "ordinary",
    value: { constructor: "literal", toJSON: "literal" },
  };
  assert.equal(
    CreateWikiPageSchema.parse({ title: "Type", content: value }).content,
    value,
  );
});

test("raw marker descriptors are checked without invoking accessors", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "__prismaRawParameters__", {
    get() {
      calls++;
      throw new Error("must not run");
    },
  });
  const enabled = Object.defineProperty(
    { values: [1] },
    "__prismaRawParameters__",
    { value: true },
  );
  for (const value of [getter, enabled])
    assert.equal(
      CreateWikiPageSchema.safeParse({ title: "Descriptor", content: value })
        .success,
      false,
    );
  assert.equal(calls, 0);
});

test("very deep direct input is rejected before recursion can overflow", () => {
  const result = CreateWikiPageSchema.safeParse({
    title: "Deep",
    content: nested(10_000),
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues[0].path, ["content"]);
});

test("an alias is checked at each path's actual depth", () => {
  const alias = nested(122);
  assert.equal(
    CreateWikiPageSchema.safeParse({
      title: "Alias",
      content: { first: alias, second: alias },
    }).success,
    true,
  );
  assert.equal(
    CreateWikiPageSchema.safeParse({
      title: "Alias",
      content: { first: alias, second: { inner: alias } },
    }).success,
    false,
  );
});
