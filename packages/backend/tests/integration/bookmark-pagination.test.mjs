import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "bookmark-pagination-disposable-jwt-secret";
process.env.COOKIE_SECRET = "bookmark-pagination-disposable-cookie-secret";
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-bookmark-query-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, token, own, foreign;
const users = [],
  expected = [];

function get(query = "", workspaceId = own.id, authenticated = true) {
  return app.inject({
    method: "GET",
    url: "/api/chat/" + workspaceId + "/bookmarks" + query,
    headers: authenticated ? { authorization: "Bearer " + token } : {},
  });
}

async function bookmark(channelId, content, createdAt, userId = users[0].id) {
  const message = await app.prisma.chatMessage.create({
    data: { channelId, userId: users[1].id, content },
  });
  return app.prisma.chatBookmark.create({
    data: { userId, messageId: message.id, createdAt },
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 12);
  for (const name of ["reader", "peer"]) {
    users.push(
      await app.prisma.user.create({
        data: {
          email: "bookmark-" + name + "-" + suffix + "@example.test",
          displayName: name,
          emailVerified: true,
        },
      }),
    );
  }
  token = signAccessToken({ sub: users[0].id, email: users[0].email });
  own = await app.prisma.workspace.create({
    data: {
      name: "Bookmark query fixture",
      slug: "bookmark-query-" + suffix,
      members: {
        create: [
          { userId: users[0].id, role: "MEMBER" },
          { userId: users[1].id, role: "ADMIN" },
        ],
      },
    },
  });
  foreign = await app.prisma.workspace.create({
    data: {
      name: "Other bookmark fixture",
      slug: "bookmark-other-" + suffix,
      members: { create: { userId: users[1].id, role: "ADMIN" } },
    },
  });
  const channels = [];
  for (const [workspaceId, type, name] of [
    [own.id, "PUBLIC", "visible"],
    [own.id, "PRIVATE", "membership-required"],
    [foreign.id, "PUBLIC", "other-workspace"],
  ]) {
    channels.push(
      await app.prisma.chatChannel.create({
        data: {
          workspaceId,
          type,
          name,
          createdById: users[1].id,
          members: { create: { userId: users[1].id } },
        },
      }),
    );
  }
  for (let i = 0; i < 24; i++) {
    expected.unshift(
      await bookmark(
        channels[0].id,
        "Visible bookmark " + i,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      ),
    );
  }
  await bookmark(
    channels[1].id,
    "Private fixture marker",
    new Date("2026-02-01"),
  );
  await bookmark(
    channels[2].id,
    "Foreign fixture marker",
    new Date("2026-02-02"),
  );
  await bookmark(
    channels[0].id,
    "Peer fixture marker",
    new Date("2026-02-03"),
    users[1].id,
  );
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [own?.id, foreign?.id].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: users.map((user) => user.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("explicit bookmark limit and cursor produce the requested consecutive pages", async () => {
  const first = await get("?limit=1");
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(
    first.json().data.map((item) => item.id),
    [expected[0].id],
  );
  assert.equal(first.json().nextCursor, expected[0].id);
  const second = await get(
    "?limit=1&cursor=" + encodeURIComponent(first.json().nextCursor),
  );
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(
    second.json().data.map((item) => item.id),
    [expected[1].id],
  );
  assert.equal(second.json().nextCursor, expected[1].id);
});

test("bookmark pagination preserves the default20 and accepts its maximum100", async () => {
  const initial = await get();
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(
    initial.json().data.map((item) => item.id),
    expected.slice(0, 20).map((item) => item.id),
  );
  assert.equal(initial.json().nextCursor, expected[19].id);
  const all = await get("?limit=100");
  assert.equal(all.statusCode, 200, all.body);
  assert.deepEqual(
    all.json().data.map((item) => item.id),
    expected.map((item) => item.id),
  );
  assert.equal(all.json().nextCursor, undefined);
});

test("invalid bookmark limits return400 without changing persisted rows", async () => {
  const where = { userId: { in: users.map((user) => user.id) } };
  const initial = await app.prisma.chatBookmark.findMany({
    where,
    orderBy: { id: "asc" },
  });
  for (const query of [
    "?limit=invalid",
    "?limit=0",
    "?limit=-1",
    "?limit=1.5",
    "?limit=101",
    "?limit=Infinity",
    "?limit=",
    "?limit=1&limit=2",
  ]) {
    const result = await get(query);
    assert.equal(result.statusCode, 400, query + ": " + result.body);
    assert(result.json().details.some((issue) => issue.field === "limit"));
  }
  assert.deepEqual(
    await app.prisma.chatBookmark.findMany({ where, orderBy: { id: "asc" } }),
    initial,
  );
});

test("validated bookmark queries retain user/channel/workspace authorization", async () => {
  const result = await get("?limit=100");
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    result.json().data.map((item) => item.id),
    expected.map((item) => item.id),
  );
  for (const marker of [
    "Private fixture marker",
    "Foreign fixture marker",
    "Peer fixture marker",
  ]) {
    assert.equal(result.body.includes(marker), false);
  }
  assert.equal((await get("?limit=1", foreign.id)).statusCode, 403);
  assert.equal((await get("?limit=1", own.id, false)).statusCode, 401);
});
