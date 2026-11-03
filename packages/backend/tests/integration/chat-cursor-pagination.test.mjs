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
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "chat-cursor-disposable-jwt",
  COOKIE_SECRET: "chat-cursor-disposable-cookie",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-chat-cursor-"));
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const chat = await import("../../src/modules/chat/chat.service.js");
const { startRefreshSession } =
  await import("../../src/modules/auth/refresh-sessions.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { PrismaClient } = await import("@prisma/client");
const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({
  datasourceUrl: observerUrl.toString(),
  log: [{ level: "query", emit: "event" }],
});
let captureOwner = null;
const pageQueryShape = (event) =>
  event.query.startsWith("SELECT ") &&
  event.query.includes('FROM "public"."ChatMessage"') &&
  event.query.includes('"content"') && event.query.includes("ORDER BY");

function deferredQuery() {
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => {
    resolve = (value) => { if (!settled) { settled = true; yes(value); } };
    reject = (error) => { if (!settled) { settled = true; no(error); } };
  });
  void promise.catch(() => {});
  return { promise, resolve, reject, settled: () => settled };
}

function startPageQuery(scope, cursor, run, hold = false) {
  assert.equal(captureOwner, null, "Settle the prior capture before starting another");
  const query = deferredQuery(), held = deferredQuery();
  const delivered = [];
  let heldEvent, released = false, closed = false;
  const matches = (event) => pageQueryShape(event) &&
    JSON.parse(event.params).includes(scope) && JSON.parse(event.params).includes(cursor);
  const capture = {
    delivered, query: query.promise, held: held.promise, observed: query.settled,
    deliver(event) {
      if (captureOwner !== capture) return;
      delivered.push(event);
      if (matches(event)) query.resolve(event);
    },
    receive(event) {
      if (captureOwner !== capture) return;
      if (hold && matches(event) && !heldEvent) { heldEvent = event; held.resolve(event); }
      else capture.deliver(event);
    },
    release() {
      if (captureOwner === capture && heldEvent && !released) {
        released = true;
        capture.deliver(heldEvent);
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        if (captureOwner === capture) captureOwner = null;
        const disposed = new Error("Owned page-query capture disposed");
        query.reject(disposed); held.reject(disposed);
      }
      await Promise.allSettled([capture.operation, query.promise, held.promise]);
    },
  };
  captureOwner = capture;
  const timer = setTimeout(() => {
    const error = new Error("Owned page SELECT was not observed within 1000ms");
    error.name = "PageQueryCaptureTimeout";
    query.reject(error); held.reject(error);
  }, 1000);
  if (!hold) held.resolve(undefined);
  capture.operation = Promise.resolve().then(run);
  void capture.operation.catch(() => {});
  return capture;
}
observer.$on("query", (event) => captureOwner?.receive(event));

async function ownPageEvent(scope, cursor, run) {
  const capture = startPageQuery(scope, cursor, run);
  try {
    await capture.operation;
    return await capture.query;
  } finally {
    await capture.close();
  }
}

const users = [],
  workspaces = [],
  families = [],
  history = [],
  replies = [];
let app,
  channels,
  token,
  requests = 0,
  wrongThread;
const historyPath = (cursor, limit, channelId = channels.public.id) =>
  `/api/chat/${workspaces[0].id}/channels/${channelId}/messages?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const threadPath = (cursor, limit, parentId = history[0].id) =>
  `/api/chat/${workspaces[0].id}/messages/${parentId}/thread?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const compare = (a, b) =>
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function get(url, authenticated = true) {
  requests++;
  return app.inject({
    method: "GET",
    url,
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: `10.61.${Math.floor(requests / 250)}.${(requests % 250) + 1}`,
  });
}
async function walk(rows, limit, url) {
  const expected = rows.map((row) => row.id),
    seen = [];
  let cursor,
    pages = 0;
  do {
    assert.ok(pages++ <= expected.length, "Traversal terminates");
    const response = await get(url(cursor, limit));
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json();
    assert.deepEqual(
      page.data.map((row) => row.id),
      expected.slice(seen.length, seen.length + limit),
    );
    seen.push(...page.data.map((row) => row.id));
    const next = seen.length < expected.length ? seen.at(-1) : undefined;
    assert.equal(
      page.nextCursor,
      next,
      "Only a real extra row produces a next cursor",
    );
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, expected.length);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  await observer.$connect();
  const suffix = crypto.randomUUID().slice(0, 12);
  for (const role of ["reader", "foreign"])
    users.push(
      await app.prisma.user.create({
        data: {
          email: `cursor-${role}-${suffix}@example.test`,
          displayName: role,
          emailVerified: true,
        },
      }),
    );
  const session = await startRefreshSession(app.prisma, users[0].id);
  families.push(session.familyId);
  token = signAccessToken({
    sub: users[0].id,
    email: users[0].email,
    sid: session.familyId,
  });
  for (let i = 0; i < 2; i++)
    workspaces.push(
      await app.prisma.workspace.create({
        data: {
          name: "Cursor fixture",
          slug: `cursor-${i}-${suffix}`,
          members: { create: { userId: users[i].id, role: "ADMIN" } },
        },
      }),
    );
  channels = {};
  for (const [key, type, owner] of [
    ["public", "PUBLIC", 0],
    ["other", "PUBLIC", 0],
    ["private", "PRIVATE", 1],
    ["foreign", "PUBLIC", 1],
    ["empty", "PUBLIC", 0],
  ]) {
    channels[key] = await app.prisma.chatChannel.create({
      data: {
        workspaceId: workspaces[key === "foreign" ? 1 : 0].id,
        name: key,
        type,
        createdById: users[owner].id,
        members: { create: { userId: users[owner].id } },
      },
    });
  }
  for (let i = 0; i < 112; i++)
    history.push({
      id: `cursor_h_${String(i).padStart(3, "0")}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      content: `History ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      ...(i === 42 ? { deletedAt: new Date() } : {}),
      ...(i === 0
        ? {
            clientMessageId: `cursor-key-${suffix}`,
            clientMessageHash: "a".repeat(64),
          }
        : {}),
    });
  for (let i = 0; i < 112; i++)
    replies.push({
      id: `cursor_r_${String(i).padStart(3, "0")}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      parentId: history[0].id,
      content: `Reply ${i}`,
      createdAt: new Date(Date.UTC(2026, 1, 1) + i * 1000),
      ...(i === 5 ? { deletedAt: new Date() } : {}),
    });
  // Deliberately permute insertion order; timestamps alone cannot define these pages.
  for (const rank of [4, 1, 6, 0, 5, 2, 3]) {
    history.push({
      id: `cursor_ht_${rank}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      content: `Tied history ${rank}`,
      createdAt: new Date("2026-06-01"),
    });
    replies.push({
      id: `cursor_rt_${rank}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      parentId: history[0].id,
      content: `Tied reply ${rank}`,
      createdAt: new Date("2026-06-02"),
    });
  }
  await app.prisma.chatMessage.createMany({ data: history });
  await app.prisma.chatMessage.createMany({ data: replies });
  wrongThread = await app.prisma.chatMessage.create({
    data: {
      channelId: channels.public.id,
      userId: users[0].id,
      parentId: history[1].id,
      content: "Other thread",
      createdAt: new Date("2026-07-01"),
    },
  });
  for (const key of ["other", "private", "foreign"])
    channels[key].message = await app.prisma.chatMessage.create({
      data: {
        channelId: channels[key].id,
        userId: users[1].id,
        content: `Excluded ${key} marker`,
        createdAt: new Date("2026-08-01"),
      },
    });
  await app.prisma.chatReaction.create({
    data: { messageId: history[0].id, userId: users[0].id, emoji: "cursor" },
  });
});

after(async () => {
  try {
    if (captureOwner) await captureOwner.close();
    await observer.$disconnect();
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: workspaces.map((w) => w.id) } },
      });
      await app.prisma.rotatedRefreshToken.deleteMany({
        where: { familyId: { in: families } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: users.map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

for (const limit of [1, 2, 50, 100]) {
  test(`history completely traverses ordinary and tied timestamps at limit${limit}`, () =>
    walk(
      [...history].sort((a, b) => -compare(a, b)),
      limit,
      historyPath,
    ));
  test(`thread completely traverses ordinary and tied timestamps at limit${limit}`, () =>
    walk([...replies].sort(compare), limit, threadPath));
}

for (const family of ["history", "thread"]) {
  test(`${family} cursor pagination delegates the take bound to PostgreSQL`, async () => {
    const cursor = (family === "history" ? history : replies)[55].id;
    const scope = family === "history" ? channels.public.id : history[0].id;
    const capture = startPageQuery(scope, cursor, () => family === "history"
      ? chat.listMessages(observer, channels.public.id, cursor, 50)
      : chat.getThreadReplies(observer, history[0].id, cursor, 50));
    try {
    const data = await capture.operation;
    const main = await capture.query;
    assert.ok(main, "Captured the generated page SELECT");
    assert.match(main.query, /LIMIT \$\d+/);
    assert.ok(
      JSON.parse(main.params).includes(51),
      "The page SELECT includes the sentinel bound",
    );
    const response = await get(
      (family === "history" ? historyPath : threadPath)(cursor, 50),
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), JSON.parse(JSON.stringify(data)));
    } finally {
      await capture.close();
    }
  });
}

test("out-of-scope and missing cursors retain an empty scoped page", async () => {
  const beforeRows = await app.prisma.chatMessage.findMany({
    where: { channelId: { in: Object.values(channels).map((c) => c.id) } },
    orderBy: { id: "asc" },
  });
  for (const cursor of [
    "cursor-not-present",
    channels.foreign.message.id,
    channels.other.message.id,
    channels.private.message.id,
    replies[0].id,
  ]) {
    const response = await get(historyPath(cursor, 2));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { data: [] });
  }
  for (const cursor of [
    "cursor-not-present",
    channels.foreign.message.id,
    channels.other.message.id,
    channels.private.message.id,
    history[0].id,
    wrongThread.id,
  ]) {
    const response = await get(threadPath(cursor, 2));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { data: [] });
  }
  assert.deepEqual(
    await app.prisma.chatMessage.findMany({
      where: { channelId: { in: Object.values(channels).map((c) => c.id) } },
      orderBy: { id: "asc" },
    }),
    beforeRows,
  );
});

test("soft-deleted cursors and message DTOs retain their existing meaning", async () => {
  const deleted = await get(historyPath(history[43].id, 1));
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json().data[0].id, history[42].id);
  assert.ok(deleted.json().data[0].deletedAt);
  const afterDeleted = await get(historyPath(history[42].id, 2));
  assert.deepEqual(
    afterDeleted.json().data.map((m) => m.id),
    [history[41].id, history[40].id],
  );
  const afterReply = await get(threadPath(replies[5].id, 2));
  assert.equal(afterReply.statusCode, 200, afterReply.body);
  assert.deepEqual(
    afterReply.json().data.map((m) => m.id),
    [replies[6].id, replies[7].id],
  );
  const root = await get(historyPath(history[1].id, 1));
  const row = root.json().data[0];
  assert.equal(row.id, history[0].id);
  assert.equal(row._count.replies, replies.length);
  assert.equal(row.reactions[0].emoji, "cursor");
  assert.equal(row.user.id, users[0].id);
  assert.ok(!("clientMessageId" in row) && !("clientMessageHash" in row));
});

test("defaults, maximum, end, empty and route authorization remain intact", async () => {
  for (const url of [
    historyPath(undefined, 50).split("?")[0],
    threadPath(undefined, 50).split("?")[0],
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.length, 50);
  }
  for (const url of [historyPath(undefined, 100), threadPath(undefined, 100)]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.length, 100);
  }
  for (const url of [
    historyPath(history[0].id, 50),
    threadPath([...replies].sort(compare).at(-1).id, 50),
    historyPath(undefined, 50, channels.empty.id),
    threadPath(undefined, 50, history[2].id),
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { data: [] });
  }
  assert.equal((await get(historyPath(undefined, 1), false)).statusCode, 401);
  assert.equal(
    (await get(historyPath(undefined, 1, channels.private.id))).statusCode,
    403,
  );
  assert.equal(
    (await get(historyPath(undefined, 1, channels.foreign.id))).statusCode,
    404,
  );
  for (const limit of ["0", "101", "1.5", "invalid"]) {
    assert.equal((await get(historyPath(undefined, limit))).statusCode, 400);
    assert.equal((await get(threadPath(undefined, limit))).statusCode, 400);
  }
});


test("page-query capture awaits its actual held event after the service settles", async () => {
  const cursor = replies[54].id;
  const capture = startPageQuery(history[0].id, cursor,
    () => chat.getThreadReplies(observer, history[0].id, cursor, 50), true);
  try {
    const data = await capture.operation;
    const event = await capture.held;
    assert.equal(capture.delivered.find(pageQueryShape), undefined);
    assert.equal(capture.observed(), false);
    capture.release();
    const main = await capture.query;
    assert.equal(main, event, "The exact actual event satisfies its own capture");
    assert.match(main.query, /LIMIT \$\d+/);
    assert.ok(JSON.parse(main.params).includes(51));
    assert.equal(data.data.length, 50);
    assert.equal(data.nextCursor, data.data.at(-1).id);
  } finally {
    capture.release();
    await capture.close();
  }
});

test("page-query capture rejects stale-family and different-cursor events", async () => {
  const staleHistory = await ownPageEvent(channels.public.id, history[55].id,
    () => chat.listMessages(observer, channels.public.id, history[55].id, 50));
  const staleThread = await ownPageEvent(history[0].id, replies[55].id,
    () => chat.getThreadReplies(observer, history[0].id, replies[55].id, 50));
  assert.ok(staleHistory && staleThread);
  const cursor = replies[53].id;
  const capture = startPageQuery(history[0].id, cursor,
    () => chat.getThreadReplies(observer, history[0].id, cursor, 50), true);
  try {
    const data = await capture.operation;
    const event = await capture.held;
    capture.deliver(staleHistory);
    capture.deliver(staleThread);
    assert.equal(capture.delivered.find(pageQueryShape), staleHistory);
    assert.equal(capture.observed(), false, "No prior operation may satisfy this waiter");
    capture.release();
    const main = await capture.query;
    assert.equal(main, event);
    assert.notEqual(main, staleHistory);
    assert.notEqual(main, staleThread);
    assert.match(main.query, /LIMIT \$\d+/);
    assert.ok(JSON.parse(main.params).includes(51));
    assert.equal(data.data.length, 50);
  } finally {
    capture.release();
    await capture.close();
  }
});

test("page-query capture fails boundedly when no owned page SELECT exists", async () => {
  const staleHistory = await ownPageEvent(channels.public.id, history[55].id,
    () => chat.listMessages(observer, channels.public.id, history[55].id, 50));
  const cursor = "cursor-capture-owned-missing";
  const capture = startPageQuery(history[0].id, cursor,
    () => chat.getThreadReplies(observer, history[0].id, cursor, 50));
  try {
    assert.deepEqual(await capture.operation, { data: [], nextCursor: undefined });
    assert.equal(capture.delivered.find(pageQueryShape), undefined);
    capture.deliver(staleHistory);
    assert.equal(capture.observed(), false);
    await assert.rejects(capture.query, { name: "PageQueryCaptureTimeout" });
  } finally {
    await capture.close();
  }
});
