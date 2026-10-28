import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "chat-send-atomicity-test-jwt-secret";
process.env.COOKIE_SECRET = "chat-send-atomicity-test-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-chat-send-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");
// The retry worker entry point. Missing before the fix, when nothing retries.
const delivery = await import("../../src/modules/chat/chat-delivery.js").catch(() => null);

let app, workspace, channel, parent;
const users = {}, sessions = {}, sockets = [];
const peerEvents = [];
let socketFault = null;
let requestNumber = 0;

function send(actor, body, key, channelId = channel.id) {
  return app.inject({
    method: "POST",
    url: `/api/chat/${workspace.id}/channels/${channelId}/messages`,
    payload: body,
    headers: {
      authorization: `Bearer ${sessions[actor]}`,
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    remoteAddress: `10.41.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
  });
}

function get(actor, route) {
  return app.inject({
    method: "GET",
    url: `/api/chat/${workspace.id}${route}`,
    headers: { authorization: `Bearer ${sessions[actor]}` },
    remoteAddress: `10.42.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
  });
}

// Runs the background retry pass as if its next attempt were already due.
async function drain() {
  if (!delivery) return;
  await delivery.processDueChatMessageDeliveries(app.prisma, {
    now: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

const persisted = (content) => app.prisma.chatMessage.count({ where: { content } });
const peerNotifications = (content) =>
  app.prisma.notification.count({ where: { userId: users.PEER.id, body: content } });
const notificationsFor = (messageId) =>
  app.prisma.notification.count({ where: { userId: users.PEER.id, data: { path: ["messageId"], equals: messageId } } });

async function peerUnread() {
  const response = await get("PEER", "/unread");
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data.find((c) => c.channelId === channel.id)?.count ?? 0;
}

async function markPeerRead() {
  await app.prisma.chatChannelMember.updateMany({
    where: { channelId: channel.id, userId: users.PEER.id },
    data: { lastReadAt: new Date() },
  });
}

async function replyCount() {
  const response = await get("PEER", `/messages/${parent.id}/thread`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data.length;
}

async function setDbFault(target) {
  await app.prisma.$executeRawUnsafe(`INSERT INTO "chat_send_fault" ("target") VALUES ($1) ON CONFLICT DO NOTHING`, target);
}

async function clearDbFaults() {
  await app.prisma.$executeRawUnsafe(`DELETE FROM "chat_send_fault"`);
}

// Real PostgreSQL failures: a BEFORE trigger rejects the write while its
// target is listed in "chat_send_fault".
const triggerTargets = [
  ["ChatChannel", "UPDATE"],
  ["ChatThreadSubscription", "INSERT"],
  ["Notification", "INSERT"],
  ["ChatMessageDelivery", "INSERT"],
];

async function installFaultTriggers() {
  await app.prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "chat_send_fault" ("target" TEXT PRIMARY KEY)`);
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION chat_send_fault_check() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM "chat_send_fault" WHERE "target" = TG_TABLE_NAME || ':' || TG_OP) THEN
        RAISE EXCEPTION 'injected fault on % %', TG_OP, TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END $$`);
  for (const [table, op] of triggerTargets) {
    const [{ exists }] = await app.prisma.$queryRawUnsafe(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, `"${table}"`);
    if (!exists) continue;
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "chat_send_fault" ON "${table}"`);
    await app.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "chat_send_fault" BEFORE ${op} ON "${table}" FOR EACH ROW EXECUTE FUNCTION chat_send_fault_check()`,
    );
  }
}

async function removeFaultTriggers() {
  for (const [table] of triggerTargets) {
    const [{ exists }] = await app.prisma.$queryRawUnsafe(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, `"${table}"`);
    if (exists) await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "chat_send_fault" ON "${table}"`);
  }
  await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS chat_send_fault_check()`);
  await app.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "chat_send_fault"`);
}

// A read failure: the preference table is briefly unavailable.
async function withPreferenceTableUnavailable(fn) {
  await app.prisma.$executeRawUnsafe(`ALTER TABLE "NotificationPreference" RENAME TO "NotificationPreference_unavailable"`);
  try {
    return await fn();
  } finally {
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "NotificationPreference_unavailable" RENAME TO "NotificationPreference"`);
  }
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  for (const name of ["SENDER", "PEER", "OTHER"]) {
    const user = await app.prisma.user.create({
      data: { email: `chat-send-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    users[name] = user;
    sessions[name] = signAccessToken({ sub: user.id, email: user.email });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Chat send",
      slug: `chat-send-${suffix}`,
      members: { create: Object.values(users).map((u) => ({ userId: u.id, role: "MEMBER" })) },
    },
  });
  channel = await app.prisma.chatChannel.create({
    data: {
      workspaceId: workspace.id,
      type: "PRIVATE",
      name: "send-atomicity",
      createdById: users.SENDER.id,
      members: { create: Object.values(users).map((u) => ({ userId: u.id })) },
    },
  });
  parent = await app.prisma.chatMessage.create({
    data: { channelId: channel.id, userId: users.PEER.id, content: "thread parent" },
  });
  await app.prisma.chatThreadSubscription.create({ data: { messageId: parent.id, userId: users.PEER.id } });

  const ws = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      const message = JSON.parse(data);
      if (socketFault && message.event === socketFault) throw new Error(`injected socket fault on ${message.event}`);
      peerEvents.push(message);
    },
    close() { this.readyState = 3; },
  };
  sockets.push(ws);
  assert.equal(await realtime.authenticate(ws, sessions.PEER, app.prisma), users.PEER.id);
  assert.equal(await realtime.subscribeWorkspace(ws, workspace.id, app.prisma), true);
  assert.equal(await realtime.subscribeChannel(ws, channel.id, app.prisma), true);
  await installFaultTriggers();
});

after(async () => {
  for (const ws of sockets) realtime.cleanup(ws);
  try {
    if (app) {
      await removeFaultTriggers();
      await app.prisma.workspace.deleteMany({ where: { id: workspace?.id } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: Object.values(users).map((u) => u.id) } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

const requiredWriteFaults = [
  { name: "channel ordering update", target: "ChatChannel:UPDATE" },
  { name: "thread auto-subscription", target: "ChatThreadSubscription:INSERT", thread: true },
  { name: "delivery outbox row", target: "ChatMessageDelivery:INSERT" },
];

for (const fault of requiredWriteFaults) {
  test(`required write failure (${fault.name}) persists nothing and a keyed retry creates exactly one message`, async () => {
    const content = `required ${fault.name} ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const body = fault.thread ? { content, parentId: parent.id } : { content };
    const repliesBefore = await replyCount();
    await markPeerRead();

    await setDbFault(fault.target);
    let first;
    try {
      first = await send("SENDER", body, key);
    } finally {
      await clearDbFaults();
    }
    const afterFailure = await persisted(content);
    // The client saw a failure, so it retries the same logical send.
    const retry = await send("SENDER", body, key);
    const replay = await send("SENDER", body, key);
    await drain();

    assert.deepEqual(
      {
        failedRequestReportedFailure: first.statusCode >= 500,
        persistedAfterFailure: afterFailure,
        retryStatus: retry.statusCode,
        replayReturnedSameMessage: replay.statusCode < 300 && replay.json().data?.id === retry.json().data?.id,
        persistedAfterRetries: await persisted(content),
        peerUnread: await peerUnread(),
        threadReplies: fault.thread ? (await replyCount()) - repliesBefore : 0,
      },
      {
        failedRequestReportedFailure: true,
        persistedAfterFailure: 0,
        retryStatus: 201,
        replayReturnedSameMessage: true,
        persistedAfterRetries: 1,
        peerUnread: 1,
        threadReplies: fault.thread ? 1 : 0,
      },
      `first response ${first.statusCode} ${first.body}`,
    );
    if (fault.thread) {
      const subscription = await app.prisma.chatThreadSubscription.findUnique({
        where: { messageId_userId: { messageId: parent.id, userId: users.SENDER.id } },
      });
      assert.ok(subscription, "thread reply subscribes its author in the same transaction");
    }
  });
}

const sideEffectFaults = [
  {
    name: "notification preference lookup",
    run: (fn) => withPreferenceTableUnavailable(fn),
    delivered: async (message) => (await notificationsFor(message.id)) === 1,
  },
  {
    name: "notification insert",
    run: async (fn) => { await setDbFault("Notification:INSERT"); try { return await fn(); } finally { await clearDbFaults(); } },
    delivered: async (message) => (await notificationsFor(message.id)) === 1,
  },
  {
    name: "realtime message broadcast",
    run: async (fn) => { socketFault = "chat_message_created"; try { return await fn(); } finally { socketFault = null; } },
    delivered: async (message) => peerEvents.some((e) => e.event === "chat_message_created" && e.data.message.id === message.id),
  },
  {
    name: "realtime notification broadcast",
    run: async (fn) => { socketFault = "notification_created"; try { return await fn(); } finally { socketFault = null; } },
    delivered: async (message) => peerEvents.some((e) => e.event === "notification_created" && e.data.data?.messageId === message.id),
  },
  {
    name: "thread reply broadcast",
    thread: true,
    run: async (fn) => { socketFault = "chat_thread_reply"; try { return await fn(); } finally { socketFault = null; } },
    delivered: async (message) => peerEvents.some((e) => e.event === "chat_thread_reply" && e.data.messageId === message.id),
  },
];

for (const fault of sideEffectFaults) {
  test(`post-commit side-effect failure (${fault.name}) reports the one persisted message and is retried until delivered`, async () => {
    const content = `side effect ${fault.name} @[${users.PEER.id}] ${crypto.randomUUID()}`;
    const key = crypto.randomUUID();
    const body = fault.thread ? { content, parentId: parent.id } : { content };
    const repliesBefore = await replyCount();
    await markPeerRead();

    const first = await fault.run(() => send("SENDER", body, key));
    const stored = await app.prisma.chatMessage.findMany({ where: { content } });
    const pending = delivery && stored[0]
      ? await app.prisma.chatMessageDelivery.findUnique({ where: { messageId: stored[0].id } })
      : null;
    // A client that never saw the response retries with the same key.
    const retry = await send("SENDER", body, key);
    // Concurrent retry workers must not repeat completed side effects.
    await Promise.all([drain(), drain(), drain()]);
    await drain();

    assert.deepEqual(
      {
        status: first.statusCode,
        responseIsPersistedMessage: first.statusCode === 201 && first.json().data.id === stored[0]?.id,
        persistedAfterFailure: stored.length,
        failureRecordedForRetry: !delivery || /injected|does not exist/.test(pending?.lastError ?? ""),
        retryReturnedSameMessage: retry.statusCode < 300 && retry.json().data?.id === stored[0]?.id,
        persistedAfterRetries: await persisted(content),
        delivered: stored[0] ? await fault.delivered(stored[0]) : false,
        peerNotifications: await peerNotifications(content),
        peerUnread: await peerUnread(),
        threadReplies: fault.thread ? (await replyCount()) - repliesBefore : 0,
        // A delivered message's outbox row is removed.
        deliveryCompleted: !delivery || (await app.prisma.chatMessageDelivery.count({ where: { messageId: stored[0]?.id } })) === 0,
      },
      {
        status: 201,
        responseIsPersistedMessage: true,
        persistedAfterFailure: 1,
        failureRecordedForRetry: true,
        retryReturnedSameMessage: true,
        persistedAfterRetries: 1,
        delivered: true,
        peerNotifications: 1,
        peerUnread: 1,
        threadReplies: fault.thread ? 1 : 0,
        deliveryCompleted: true,
      },
      `first response ${first.statusCode} ${first.body}`,
    );
  });
}

test("concurrent sends with one key create one message and one notification", async () => {
  const content = `concurrent @[${users.PEER.id}] ${crypto.randomUUID()}`;
  const key = crypto.randomUUID();
  await markPeerRead();
  const responses = await Promise.all(Array.from({ length: 8 }, () => send("SENDER", { content }, key)));
  const ids = new Set(responses.map((r) => r.json().data?.id));
  assert.deepEqual(
    {
      statuses: responses.every((r) => r.statusCode === 200 || r.statusCode === 201),
      created: responses.filter((r) => r.statusCode === 201).length,
      distinctIds: ids.size,
      persisted: await persisted(content),
      peerNotifications: await peerNotifications(content),
      peerUnread: await peerUnread(),
    },
    { statuses: true, created: 1, distinctIds: 1, persisted: 1, peerNotifications: 1, peerUnread: 1 },
    responses.map((r) => `${r.statusCode} ${r.body}`).join("\n"),
  );
});

test("a key reused for a different message conflicts, keys are per author, and malformed keys are rejected", async () => {
  const key = crypto.randomUUID();
  const content = `original ${key}`;
  const first = await send("SENDER", { content }, key);
  assert.equal(first.statusCode, 201, first.body);

  const conflict = await send("SENDER", { content: `different ${key}` }, key);
  assert.equal(conflict.statusCode, 409, conflict.body);
  const threadConflict = await send("SENDER", { content, parentId: parent.id }, key);
  assert.equal(threadConflict.statusCode, 409, threadConflict.body);
  assert.equal(await persisted(`different ${key}`), 0);

  const otherAuthor = await send("OTHER", { content }, key);
  assert.equal(otherAuthor.statusCode, 201, otherAuthor.body);
  assert.notEqual(otherAuthor.json().data.id, first.json().data.id);
  assert.equal(await persisted(content), 2);

  for (const bad of ["", "has spaces", "x".repeat(129)]) {
    const response = await send("SENDER", { content: `bad key ${key}` }, bad);
    assert.equal(response.statusCode, 400, `${JSON.stringify(bad)}: ${response.body}`);
  }
  assert.equal(await persisted(`bad key ${key}`), 0);

  const unkeyed = [await send("SENDER", { content: `unkeyed ${key}` }), await send("SENDER", { content: `unkeyed ${key}` })];
  assert.deepEqual(unkeyed.map((r) => r.statusCode), [201, 201]);
  assert.equal(await persisted(`unkeyed ${key}`), 2, "sends without a key keep their existing behaviour");
});

test("a keyed replay keeps channel authorization: a removed member cannot replay", async () => {
  const key = crypto.randomUUID();
  const content = `private replay ${key}`;
  const first = await send("OTHER", { content }, key);
  assert.equal(first.statusCode, 201, first.body);
  await app.prisma.chatChannelMember.deleteMany({ where: { channelId: channel.id, userId: users.OTHER.id } });
  try {
    const replay = await send("OTHER", { content }, key);
    assert.ok([403, 404].includes(replay.statusCode), replay.body);
    assert.ok(!replay.body.includes(content));
    assert.equal(await persisted(content), 1);
  } finally {
    await app.prisma.chatChannelMember.create({ data: { channelId: channel.id, userId: users.OTHER.id } });
  }
});

test("a delivery abandoned mid-attempt is retried after its lease expires and completes once", async () => {
  assert.ok(delivery, "a retry worker must exist for post-commit side effects");
  const content = `abandoned @[${users.PEER.id}] ${crypto.randomUUID()}`;
  await setDbFault("Notification:INSERT");
  let response;
  try {
    response = await send("SENDER", { content }, crypto.randomUUID());
  } finally {
    await clearDbFaults();
  }
  assert.equal(response.statusCode, 201, response.body);
  const messageId = response.json().data.id;
  // Simulates a worker that claimed the row and then crashed.
  const leaseEnd = new Date(Date.now() + 60_000);
  await app.prisma.chatMessageDelivery.update({
    where: { messageId },
    data: { lockedUntil: leaseEnd, nextAttemptAt: new Date(Date.now() - 1000) },
  });
  await delivery.processDueChatMessageDeliveries(app.prisma, { now: new Date() });
  assert.equal(await peerNotifications(content), 0, "a live lease is not taken over");
  await delivery.processDueChatMessageDeliveries(app.prisma, { now: new Date(leaseEnd.getTime() + 1) });
  assert.equal(await peerNotifications(content), 1);
  assert.equal(await app.prisma.chatMessageDelivery.count({ where: { messageId } }), 0);
});

test("an archived channel rejects new sends without writes but replays an already stored keyed send", async () => {
  const key = crypto.randomUUID();
  const content = `before archive ${key}`;
  const first = await send("SENDER", { content }, key);
  assert.equal(first.statusCode, 201, first.body);
  await app.prisma.chatChannel.update({ where: { id: channel.id }, data: { archivedAt: new Date() } });
  try {
    const rejected = await send("SENDER", { content: `after archive ${key}` }, crypto.randomUUID());
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.equal(await persisted(`after archive ${key}`), 0);
    const replay = await send("SENDER", { content }, key);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().data.id, first.json().data.id);
  } finally {
    await app.prisma.chatChannel.update({ where: { id: channel.id }, data: { archivedAt: null } });
  }
});
