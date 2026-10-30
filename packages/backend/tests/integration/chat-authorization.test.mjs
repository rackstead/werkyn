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
process.env.JWT_SECRET = "chat-authorization-test-jwt-secret";
process.env.COOKIE_SECRET = "chat-authorization-test-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-chat-auth-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");
let app, ownWorkspace, foreignWorkspace;
const users = [], channels = {}, sockets = [], observedEvents = [];
const sessions = {};
let requestNumber = 0;

function request(actor, method, route, payload) {
  return app.inject({
    method, url: `/api/chat/${ownWorkspace.id}${route}`, payload,
    headers: { authorization: `Bearer ${sessions[actor]}` },
    remoteAddress: `10.30.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
  });
}

async function channel(workspaceId, type, name, members) {
  const record = await app.prisma.chatChannel.create({
    data: { workspaceId, type, name, createdById: members[0].id, members: { create: members.map((u) => ({ userId: u.id })) } },
  });
  const message = await app.prisma.chatMessage.create({ data: { channelId: record.id, userId: members[0].id, content: `${name} confidential payload`, pinnedAt: new Date() } });
  await app.prisma.chatMessage.create({ data: { channelId: record.id, userId: members[0].id, content: `${name} reply`, parentId: message.id } });
  return { ...record, message };
}

async function snapshot() {
  const where = { workspaceId: { in: [ownWorkspace.id, foreignWorkspace.id] } };
  return Promise.all([
    app.prisma.chatChannel.findMany({ where, orderBy: { id: "asc" } }),
    app.prisma.chatMessage.findMany({ where: { channel: where }, orderBy: { id: "asc" } }),
    app.prisma.chatChannelMember.findMany({ where: { channel: where }, orderBy: { id: "asc" } }),
    app.prisma.chatReaction.findMany({ where: { message: { channel: where } }, orderBy: { id: "asc" } }),
    app.prisma.chatBookmark.findMany({ where: { userId: { in: users.map((u) => u.id) } }, orderBy: { id: "asc" } }),
    app.prisma.chatThreadSubscription.findMany({ where: { userId: { in: users.map((u) => u.id) } }, orderBy: { id: "asc" } }),
    app.prisma.notification.findMany({ where: { userId: { in: users.map((u) => u.id) } }, orderBy: { id: "asc" } }),
  ]);
}

function resourceRoutes(target) {
  const c = `/channels/${target.id}`, m = `/messages/${target.message.id}`;
  return [
    ["GET", c], ["PATCH", c, { name: "changed" }], ["DELETE", c],
    ["POST", `${c}/join`], ["POST", `${c}/leave`], ["GET", `${c}/members`],
    ["POST", `${c}/members`, { userIds: [users[1].id] }],
    ["DELETE", `${c}/members/${users[1].id}`], ["GET", `${c}/messages`],
    ["POST", `${c}/messages`, { content: "attack" }],
    ["POST", `${c}/read`], ["POST", `${c}/typing`], ["GET", `${c}/pins`],
    ["POST", `${c}/archive`, { archived: true }], ["GET", `${c}/messages/search?q=confidential`],
    ["PATCH", m, { content: "changed" }], ["DELETE", m], ["GET", `${m}/thread`],
    ["POST", `${m}/reactions`, { emoji: "x" }], ["POST", `${m}/pin`, { pinned: false }],
    ["POST", `${m}/bookmark`], ["GET", `${m}/subscription`],
    ["POST", `${m}/subscription`], ["DELETE", `${m}/subscription`],
  ];
}

async function connect(userIndex, workspaceId = ownWorkspace.id) {
  const messages = [];
  const ws = { OPEN: 1, readyState: 1, send(data) { const message = JSON.parse(data); messages.push(message); observedEvents.push(message); }, close() { this.readyState = 3; } };
  sockets.push(ws);
  assert.equal(await realtime.authenticate(ws, sessions[users[userIndex].displayName], app.prisma), users[userIndex].id);
  if (workspaceId) assert.equal(await realtime.subscribeWorkspace(ws, workspaceId, app.prisma), true);
  return { ws, messages };
}

before(async () => {
  app = await buildApp(); await app.ready();
  const suffix = crypto.randomUUID();
  for (const name of ["ADMIN", "MEMBER", "VIEWER", "PEER", "FOREIGN"]) {
    const u = await app.prisma.user.create({ data: { email: `chat-${name}-${suffix}@example.test`, displayName: name, emailVerified: true } });
    // Sockets require an access token bound to a live sign-in session.
    const { familyId } = await startRefreshSession(app.prisma, u.id);
    users.push(u); sessions[name] = signAccessToken({ sub: u.id, email: u.email, sid: familyId });
  }
  ownWorkspace = await app.prisma.workspace.create({ data: { name: "Chat own", slug: `chat-own-${suffix}`, members: { create: users.slice(0, 4).map((u, i) => ({ userId: u.id, role: ["ADMIN", "MEMBER", "VIEWER", "MEMBER"][i] })) } } });
  foreignWorkspace = await app.prisma.workspace.create({ data: { name: "Chat foreign", slug: `chat-foreign-${suffix}`, members: { create: { userId: users[4].id, role: "ADMIN" } } } });
  channels.foreignPrivate = await channel(foreignWorkspace.id, "PRIVATE", "foreign-private", [users[4]]);
  channels.foreignPublic = await channel(foreignWorkspace.id, "PUBLIC", "foreign-public", [users[4]]);
  channels.foreignDm = await channel(foreignWorkspace.id, "DM", null, [users[4]]);
  channels.hidden = await channel(ownWorkspace.id, "PRIVATE", "own-private", [users[3]]);
  channels.hiddenDm = await channel(ownWorkspace.id, "DM", null, [users[3]]);
  channels.allowed = await channel(ownWorkspace.id, "PRIVATE", "allowed-private", users.slice(0, 3));
  channels.public = await channel(ownWorkspace.id, "PUBLIC", "own-public", [users[3]]);
  const peer = await connect(3);
  for (const target of [channels.hidden, channels.hiddenDm, channels.public]) {
    assert.equal(await realtime.subscribeChannel(peer.ws, target.id, app.prisma), true);
  }
  const foreign = await connect(4, foreignWorkspace.id);
  for (const target of [channels.foreignPrivate, channels.foreignPublic, channels.foreignDm]) {
    assert.equal(await realtime.subscribeChannel(foreign.ws, target.id, app.prisma), true);
  }
  const allowed = await connect(1);
  assert.equal(await realtime.subscribeChannel(allowed.ws, channels.allowed.id, app.prisma), true);
});

after(async () => {
  for (const ws of sockets) realtime.cleanup(ws);
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: [ownWorkspace?.id, foreignWorkspace?.id].filter(Boolean) } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
  test(`${role}: every foreign/public/private/DM resource route denies without writes`, async () => {
    const initial = await snapshot();
    const initialEvents = [...observedEvents];
    for (const target of [channels.foreignPrivate, channels.foreignPublic, channels.foreignDm, channels.hidden, channels.hiddenDm]) {
      for (const [method, route, payload] of resourceRoutes(target)) {
        const result = await request(role, method, route, payload);
        assert([403, 404].includes(result.statusCode), `${role} ${method} ${route}: ${result.statusCode} ${result.body}`);
        assert(!result.body.includes("confidential payload"));
      }
    }
    assert.deepEqual(await snapshot(), initial);
    assert.deepEqual(observedEvents, initialEvents, "denied requests must not broadcast");
  });

  test(`${role}: current members read private content and workspace members discover public channels`, async () => {
    for (const target of [channels.allowed, channels.public]) {
      for (const [method, route] of resourceRoutes(target).filter(([method]) => method === "GET")) {
        const result = await request(role, method, route);
        assert.equal(result.statusCode, 200, `${method} ${route}: ${result.body}`);
      }
    }
  });
}

test("DM and channel membership creation reject foreign recipients atomically", async () => {
  const initial = await snapshot();
  for (const route of ["/dm", `/channels/${channels.allowed.id}/members`, `/channels/${channels.public.id}/members`]) {
    const result = await request("ADMIN", "POST", route, { userIds: [users[1].id, users[4].id] });
    assert.equal(result.statusCode, 403, result.body);
  }
  assert.deepEqual(await snapshot(), initial);
});

test("revoked private-channel bookmarks cannot reveal retained message content", async () => {
  await app.prisma.chatBookmark.create({ data: { userId: users[1].id, messageId: channels.hidden.message.id } });
  const result = await request("MEMBER", "GET", "/bookmarks");
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().data.some((b) => b.messageId === channels.hidden.message.id), false);
});

test("private create/archive/delete events stay out of workspace feed; public discovery stays live", async () => {
  const { messages } = await connect(3);
  messages.length = 0;
  const privateResult = await request("ADMIN", "POST", "/channels", { name: "new private", type: "PRIVATE" });
  assert.equal(privateResult.statusCode, 201, privateResult.body);
  const privateId = privateResult.json().data.id;
  assert.equal((await request("ADMIN", "POST", `/channels/${privateId}/archive`, { archived: true })).statusCode, 200);
  assert.equal((await request("ADMIN", "DELETE", `/channels/${privateId}`)).statusCode, 204);
  assert.equal(messages.some((m) => JSON.stringify(m).includes(privateId)), false);
  const publicResult = await request("ADMIN", "POST", "/channels", { name: "new public", type: "PUBLIC" });
  assert.equal(publicResult.statusCode, 201, publicResult.body);
  const publicId = publicResult.json().data.id;
  assert.equal((await request("ADMIN", "DELETE", `/channels/${publicId}`)).statusCode, 204);
  assert(messages.some((m) => m.event === "chat_channel_created" && m.data.channel.id === publicId));
  assert(messages.some((m) => m.event === "chat_channel_deleted" && m.data.channelId === publicId));
});

test("private message mentions notify only current channel and workspace recipients", async () => {
  const content = `private @[${users[1].id}] @[${users[3].id}] @[${users[4].id}]`;
  const result = await request("ADMIN", "POST", `/channels/${channels.allowed.id}/messages`, { content });
  assert.equal(result.statusCode, 201, result.body);
  const notifications = await app.prisma.notification.findMany({ where: { body: content } });
  assert.deepEqual(notifications.map((n) => n.userId), [users[1].id]);
});


test("public reads remain discoverable while sending requires join and a writable workspace role", async () => {
  const initial = await snapshot();
  let response = await request("MEMBER", "POST", `/channels/${channels.public.id}/messages`, { content: "must join first" });
  assert.equal(response.statusCode, 403, response.body);
  response = await request("VIEWER", "POST", `/channels/${channels.allowed.id}/messages`, { content: "viewer cannot send" });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(await snapshot(), initial);
  response = await request("MEMBER", "POST", `/channels/${channels.public.id}/join`);
  assert.equal(response.statusCode, 204, response.body);
  response = await request("MEMBER", "POST", `/channels/${channels.public.id}/messages`, { content: "joined public message" });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().data.content, "joined public message");
  response = await request("MEMBER", "POST", `/channels/${channels.public.id}/leave`);
  assert.equal(response.statusCode, 204, response.body);
});

test("authorized private member operations persist, while a foreign thread parent is atomic denial", async () => {
  const initial = await snapshot();
  const events = [...observedEvents];
  let response = await request("MEMBER", "POST", `/channels/${channels.allowed.id}/messages`, { content: "foreign parent", parentId: channels.foreignPrivate.message.id });
  assert.equal(response.statusCode, 404, response.body);
  assert.deepEqual(await snapshot(), initial);
  assert.deepEqual(observedEvents, events);
  response = await request("MEMBER", "POST", `/channels/${channels.allowed.id}/messages`, { content: "legitimate private message" });
  assert.equal(response.statusCode, 201, response.body);
  const messageId = response.json().data.id;
  response = await request("MEMBER", "PATCH", `/messages/${messageId}`, { content: "edited private message" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.content, "edited private message");
  for (const [route, payload] of [["reactions", { emoji: "check" }], ["pin", { pinned: true }], ["bookmark", undefined], ["subscription", undefined]]) {
    response = await request("MEMBER", "POST", `/messages/${messageId}/${route}`, payload);
    assert([200, 204].includes(response.statusCode), response.body);
  }
  response = await request("MEMBER", "POST", `/channels/${channels.allowed.id}/messages`, { content: "valid reply", parentId: messageId });
  assert.equal(response.statusCode, 201, response.body);
  response = await request("VIEWER", "GET", `/messages/${messageId}/thread`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data[0].content, "valid reply");
  response = await request("MEMBER", "DELETE", `/messages/${messageId}`);
  assert.equal(response.statusCode, 204, response.body);
  assert.ok((await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: messageId } })).deletedAt);
});

test("channel and workspace searches and channel lists exclude private outsiders and foreign tenants", async () => {
  for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
    const list = await request(role, "GET", "/channels");
    assert.equal(list.statusCode, 200, list.body);
    const ids = list.json().data.map(c => c.id);
    assert.ok(ids.includes(channels.allowed.id));
    assert.ok(ids.includes(channels.public.id));
    for (const target of [channels.hidden, channels.hiddenDm, channels.foreignPrivate, channels.foreignPublic, channels.foreignDm]) assert.ok(!ids.includes(target.id));
    for (const url of [`/api/chat/${ownWorkspace.id}/messages/search?q=confidential`, `/api/workspaces/${ownWorkspace.id}/search?q=confidential`]) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${sessions[role]}` } });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.body.includes("allowed-private confidential payload"));
      for (const secret of ["own-private confidential payload", "foreign-private confidential payload", "foreign-public confidential payload"]) assert.ok(!response.body.includes(secret));
    }
  }
});

test("valid DM creation is idempotent and mentions cannot notify foreign or same-workspace outsiders", async () => {
  const payload = { userIds: [users[1].id, users[1].id] };
  const first = await request("ADMIN", "POST", "/dm", payload);
  const second = await request("ADMIN", "POST", "/dm", payload);
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(first.json().data.id, second.json().data.id);
  const content = `dm-local-only @[${users[1].id}] @[${users[3].id}] @[${users[4].id}]`;
  const response = await request("ADMIN", "POST", `/channels/${first.json().data.id}/messages`, { content });
  assert.equal(response.statusCode, 201, response.body);
  const notifs = await app.prisma.notification.findMany({ where: { body: content } });
  assert.ok(notifs.length > 0);
  assert.ok(notifs.every(n => n.userId === users[1].id));
});
