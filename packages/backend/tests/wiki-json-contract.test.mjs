import assert from "node:assert/strict";
import test from "node:test";
import {
  createPage,
  updatePage,
} from "../src/modules/wiki/wiki-pages.service.ts";
import { createComment } from "../src/modules/wiki/wiki-comments.service.ts";
import { snapshotPage } from "../src/modules/wiki/wiki-page-writes.ts";
import { restoreVersion } from "../src/modules/wiki/wiki-versions.service.ts";
import { checkJsonValue } from "../src/modules/backup/restore-validation.ts";

function nested(levels) {
  let value = "leaf";
  while (levels-- > 0) value = { child: value };
  return value;
}

const invalid = (field) => (error) => {
  assert.equal(error.statusCode, 400);
  assert.deepEqual(
    error.details.map((detail) => detail.field),
    [field],
  );
  assert.doesNotMatch(error.message, /leaf|secret/);
  return true;
};

test("direct page service callers refuse unsupported JSON before entering a transaction", async () => {
  const cycle = {};
  cycle.self = cycle;
  const prisma = new Proxy(
    {},
    {
      get() {
        assert.fail("database must not be accessed");
      },
    },
  );
  for (const content of [
    cycle,
    nested(124),
    { "secret\u0000": true },
    Infinity,
  ]) {
    await assert.rejects(
      createPage(prisma, "w", "s", "u", { title: "p", content }),
      invalid("content"),
    );
    await assert.rejects(
      updatePage(prisma, "p", "u", { content }),
      invalid("content"),
    );
  }
});

test("direct service callers refuse serializer-interpreted members before any database access", async () => {
  const prisma = new Proxy(
    {},
    {
      get() {
        assert.fail("database must not be accessed");
      },
    },
  );
  const proto = JSON.parse('{"__proto__":{"literal":true},"safe":true}');
  for (const content of [
    proto,
    { __prismaRawParameters__: true, values: [1, 2] },
    { nested: [proto] },
  ]) {
    await assert.rejects(
      createPage(prisma, "w", "s", "u", { title: "p", content }),
      invalid("content"),
    );
    await assert.rejects(
      updatePage(prisma, "p", "u", { content }),
      invalid("content"),
    );
    for (const field of ["selectionStart", "selectionEnd"])
      await assert.rejects(
        createComment(prisma, "p", "u", {
          body: "c",
          highlightId: "h",
          [field]: content,
        }),
        invalid(field),
      );
    assert.throws(() => checkJsonValue(content, "page content"), {
      statusCode: 400,
    });
  }
});

test("direct comment service callers validate both selections before any database access", async () => {
  const cycle = [];
  cycle.push(cycle);
  const prisma = new Proxy(
    {},
    {
      get() {
        assert.fail("database must not be accessed");
      },
    },
  );
  for (const field of ["selectionStart", "selectionEnd"])
    for (const value of [
      cycle,
      nested(122),
      { value: "secret\ud800" },
      -Infinity,
    ])
      await assert.rejects(
        createComment(prisma, "p", "u", {
          body: "c",
          highlightId: "h",
          [field]: value,
        }),
        invalid(field),
      );
});

test("snapshot validates legacy content before numbering or inserting a version", async () => {
  const tx = {
    wikiPage: {
      findUniqueOrThrow: async () => ({ title: "p", content: nested(124) }),
    },
  };
  await assert.rejects(snapshotPage(tx, "p", "u"), invalid("content"));
});

test("a throttled snapshot does not revalidate content it never copies", async () => {
  const tx = {
    wikiPageVersion: { findFirst: async () => ({ createdAt: new Date() }) },
  };
  assert.equal(await snapshotPage(tx, "p", "u", { throttle: true }), null);
});

test("historical restore validates the chosen value before snapshotting or changing the page", async () => {
  const tx = {
    $queryRaw: async () => [{ revision: 3, updatedAt: new Date() }],
    wikiPageLock: { findUnique: async () => null },
    wikiPageVersion: {
      findUnique: async () => ({
        id: "v",
        pageId: "p",
        title: "p",
        content: nested(124),
      }),
    },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  await assert.rejects(restoreVersion(prisma, "v", "u"), invalid("content"));
});

test("backup JSON numeric validation accepts finite primitives and refuses overflow at any position", () => {
  for (const value of [0, -0, -1.25, Number.MIN_VALUE, Number.MAX_VALUE])
    assert.doesNotThrow(() =>
      checkJsonValue({ number: [value] }, "page content"),
    );
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const content of [value, { number: [value] }])
      assert.throws(() => checkJsonValue(content, "page content"), {
        statusCode: 400,
        message:
          "Invalid backup file: page content contains a non-finite number",
      });
  }
});
