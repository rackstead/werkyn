import assert from "node:assert/strict";
import crypto from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { openRawSocket } from "./support/raw-websocket.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "notification-file-access-test-jwt-secret",
  COOKIE_SECRET: "notification-file-access-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-notification-files-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { PrismaClient } = await import("@prisma/client");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const { assertFileAccess } = await import("../../src/modules/files/file-access.js");
const { enqueueNotification, deliverNotification } = await import("../../src/modules/notifications/notification-delivery.js");

let app, baseUrl, port;
let requestNumber = 0;
const workspaces = [], users = [], deliveryIds = [];
const uid = () => crypto.randomUUID();

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  try {
    if (app) {
      await app.prisma.notificationDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function request(user, url, { method = "GET", body } = {}) {
  // Distinct loopback sources retain the real HTTP pipeline without making
  // this permission matrix consume one client's 100-request quota.
  const sequence = ++requestNumber;
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}${url}`, {
      method, localAddress: `127.126.${Math.floor(sequence / 250)}.${sequence % 250 + 1}`,
      headers: { authorization: `Bearer ${user.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: text, json: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function user(label) {
  const row = await app.prisma.user.create({
    data: { email: `notification-file-${label}-${uid()}@example.test`, displayName: label, emailVerified: true },
  });
  users.push(row.id);
  return { ...row, token: signAccessToken({ sub: row.id, email: row.email }) };
}

async function workspace(members) {
  const row = await app.prisma.workspace.create({
    data: {
      name: "Notification file scope", slug: `nf-${uid()}`,
      members: { create: members.map(([member, role]) => ({ userId: member.id, role })) },
    },
  });
  workspaces.push(row.id);
  return row;
}

async function fixture() {
  const owner = await user("Owner"), reader = await user("Reader"), admin = await user("Admin");
  const ws = await workspace([[owner, "MEMBER"], [reader, "MEMBER"], [admin, "ADMIN"]]);
  const f = { owner, reader, admin, ws };
  f.file = await file(f);
  return f;
}

async function file(f, data = {}) {
  return app.prisma.file.create({ data: {
    workspaceId: f.ws.id, name: `Private file ${uid()}`, uploadedById: f.owner.id,
    ownerId: f.owner.id, ...data,
  } });
}

async function share(f, target = f.file, reader = f.reader, workspaceId = f.ws.id) {
  return app.prisma.fileShare.create({ data: {
    fileId: target.id, workspaceId, sharedById: f.owner.id, sharedWithId: reader.id,
  } });
}

async function seed(f, { data = { fileId: f.file.id, workspaceId: f.ws.id }, type = "FILE_SHARED", createdAt, read = false } = {}) {
  return app.prisma.notification.create({ data: {
    userId: f.reader.id, type, title: `Private title ${uid()}`, body: "Retained file snippet",
    ...(data === undefined ? {} : { data }), ...(createdAt ? { createdAt } : {}), read,
  } });
}

async function enqueue(f, options = {}) {
  const id = await enqueueNotification(app.prisma, {
    recipients: [f.reader.id], type: "FILE_SHARED", title: `Deferred private title ${uid()}`,
    body: "Deferred file snippet", data: { fileId: f.file.id, workspaceId: f.ws.id }, ...options,
  });
  assert.ok(id);
  deliveryIds.push(id);
  return id;
}

async function visible(f, query = "") {
  const list = await request(f.reader, `/api/notifications${query}`);
  const count = await request(f.reader, "/api/notifications/unread-count");
  assert.equal(list.status, 200, list.body);
  assert.equal(count.status, 200, count.body);
  return { rows: list.json.data, cursor: list.json.nextCursor, count: count.json.count, raw: list.body };
}

async function canonical(f, fileId = f.file.id, workspaceId = f.ws.id) {
  try {
    await assertFileAccess(app.prisma, fileId, { userId: f.reader.id, workspaceId, workspaceRole: "ADMIN" });
    return true;
  } catch (error) {
    if (error.statusCode === 403 || error.statusCode === 404) return false;
    throw error;
  }
}

async function socketFor(actor) {
  const { familyId } = await startRefreshSession(app.prisma, actor.id);
  const token = signAccessToken({ sub: actor.id, email: actor.email, sid: familyId });
  const client = await openRawSocket(port);
  client.sendJSON({ type: "auth", token });
  assert.deepEqual(await client.next((m) => m.event === "authenticated"), { event: "authenticated" });
  return client;
}

test("revoked direct share hides retained file content from real HTTP list and unread count", async () => {
  const f = await fixture();
  await share(f);
  const stored = await seed(f);
  assert.equal(await canonical(f), true);
  assert.equal((await visible(f)).rows[0]?.id, stored.id);
  const removed = await request(f.owner, `/api/workspaces/${f.ws.id}/files/${f.file.id}/shares/${f.reader.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204, removed.body);
  assert.equal(await canonical(f), false);
  const actualFile = await request(f.reader, `/api/workspaces/${f.ws.id}/files/${f.file.id}`);
  assert.equal(actualFile.status, 403, actualFile.body);
  const result = await visible(f);
  assert.deepEqual({ ids: result.rows.map((n) => n.id), unread: result.count, title: result.raw.includes(stored.title) },
    { ids: [], unread: 0, title: false });
  assert.equal(await app.prisma.notification.count({ where: { id: stored.id } }), 1, "history remains stored");
});

test("retry begun after share revocation creates no stored content or actual socket toast", async () => {
  const f = await fixture();
  const grant = await share(f);
  const id = await enqueue(f);
  const client = await socketFor(f.reader);
  try {
    await app.prisma.fileShare.delete({ where: { id: grant.id } });
    assert.equal(await canonical(f), false);
    assert.equal(await deliverNotification(app.prisma, app, id), "completed");
    client.sendJSON({ type: "ping" });
    await client.next((m) => m.event === "pong");
    assert.deepEqual({
      notifications: await app.prisma.notification.count({ where: { userId: f.reader.id } }),
      toasts: client.inbox.filter((m) => m.event === "notification_new").length,
    }, { notifications: 0, toasts: 0 });
    assert.equal(await app.prisma.notificationDelivery.count({ where: { id } }), 0);
  } finally {
    client.socket.destroy();
  }
});

test("revoking an inherited folder share hides history and refuses its queued delivery", async () => {
  const f = await fixture();
  const parent = await file(f, { isFolder: true });
  await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } });
  const grant = await share(f, parent);
  const stored = await seed(f);
  const id = await enqueue(f);
  assert.equal(await canonical(f), true);
  assert.deepEqual((await visible(f)).rows.map((n) => n.id), [stored.id]);
  await app.prisma.fileShare.delete({ where: { id: grant.id } });
  assert.equal(await canonical(f), false);
  const result = await visible(f);
  assert.deepEqual(result.rows, []);
  assert.equal(result.count, 0);
  assert.equal(result.raw.includes(stored.title), false);
  assert.equal(await deliverNotification(app.prisma, app, id), "completed");
  assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), 1);
});

async function team(f) {
  const root = await file(f, { isFolder: true, ownerId: null });
  const row = await app.prisma.teamFolder.create({ data: { workspaceId: f.ws.id, folderId: root.id, name: "Private team" } });
  await app.prisma.file.update({ where: { id: f.file.id }, data: { ownerId: null, teamFolderId: row.id, parentId: root.id } });
  return { ...row, root };
}

const cases = [
  ["personal unshared member", false, async () => {}],
  ["current direct share", true, async (f) => { await share(f); }],
  ["personal owner", true, async (f) => { await app.prisma.file.update({ where: { id: f.file.id }, data: { ownerId: f.reader.id } }); }],
  ["current admin", true, async (f) => { await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["viewer with direct share", true, async (f) => { await share(f); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "VIEWER" } }); }],
  ["removed workspace member", false, async (f) => { await share(f); await app.prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } } }); }],
  ["trashed file", false, async (f) => { await share(f); await app.prisma.file.update({ where: { id: f.file.id }, data: { trashedAt: new Date() } }); }],
  ["deleted file", false, async (f) => { await share(f); await app.prisma.file.delete({ where: { id: f.file.id } }); }],
  ["foreign share row workspace", false, async (f) => { const foreign = await workspace([[f.owner, "ADMIN"], [f.reader, "MEMBER"]]); await share(f, f.file, f.reader, foreign.id); }],
  ["inherited folder share", true, async (f) => { const parent = await file(f, { isFolder: true }); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); await share(f, parent); }],
  ["separate leaf grant survives parent revocation", true, async (f) => { const parent = await file(f, { isFolder: true }); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); const ancestor = await share(f, parent); await share(f); await app.prisma.fileShare.delete({ where: { id: ancestor.id } }); }],
  ["inheritance cannot cross owner", false, async (f) => { const parent = await file(f, { isFolder: true, ownerId: f.admin.id }); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); await share(f, parent); }],
  ["inheritance cannot cross nonfolder", false, async (f) => { const parent = await file(f); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); await share(f, parent); }],
  ["inheritance cannot cross trash", false, async (f) => { const parent = await file(f, { isFolder: true, trashedAt: new Date() }); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); await share(f, parent); }],
  ["direct leaf grant ignores inaccessible ancestor", true, async (f) => { const parent = await file(f, { isFolder: true, ownerId: f.admin.id, trashedAt: new Date() }); await app.prisma.file.update({ where: { id: f.file.id }, data: { parentId: parent.id } }); await share(f); }],
  ["legacy cycle terminates with inherited share", true, async (f) => { const parent = await file(f, { isFolder: true, parentId: f.file.id }); await app.prisma.file.update({ where: { id: f.file.id }, data: { isFolder: true, parentId: parent.id } }); await share(f, parent); }],
  ["legacy cycle terminates without share", false, async (f) => { const parent = await file(f, { isFolder: true, parentId: f.file.id }); await app.prisma.file.update({ where: { id: f.file.id }, data: { isFolder: true, parentId: parent.id } }); }],
  ["direct team membership", true, async (f) => { const tf = await team(f); await app.prisma.teamFolderMember.create({ data: { teamFolderId: tf.id, userId: f.reader.id } }); }],
  ["current team group", true, async (f) => { const tf = await team(f); const g = await app.prisma.group.create({ data: { workspaceId: f.ws.id, name: "Readers", members: { create: { userId: f.reader.id } } } }); await app.prisma.teamFolderGroup.create({ data: { teamFolderId: tf.id, groupId: g.id } }); }],
  ["foreign team group refuses", false, async (f) => { const tf = await team(f); const foreign = await workspace([[f.reader, "MEMBER"]]); const g = await app.prisma.group.create({ data: { workspaceId: foreign.id, name: "Foreign readers", members: { create: { userId: f.reader.id } } } }); await app.prisma.teamFolderGroup.create({ data: { teamFolderId: tf.id, groupId: g.id } }); }],
  ["unshared private team", false, async (f) => { await team(f); }],
  ["team explicit share", true, async (f) => { await team(f); await share(f); }],
  ["corrupt team workspace denies admin", false, async (f) => { const tf = await team(f); const foreign = await workspace([[f.reader, "ADMIN"]]); await app.prisma.teamFolder.update({ where: { id: tf.id }, data: { workspaceId: foreign.id } }); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["trashed team root denies admin", false, async (f) => { const tf = await team(f); await app.prisma.file.update({ where: { id: tf.root.id }, data: { trashedAt: new Date() } }); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["ownerless personal denies explicit share", false, async (f) => { await share(f); await app.prisma.file.update({ where: { id: f.file.id }, data: { ownerId: null } }); }],
  ["ownerless personal remains readable to admin", true, async (f) => { await app.prisma.file.update({ where: { id: f.file.id }, data: { ownerId: null } }); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["revoked team group", false, async (f) => { const tf = await team(f); const g = await app.prisma.group.create({ data: { workspaceId: f.ws.id, name: "Former readers", members: { create: { userId: f.reader.id } } } }); await app.prisma.teamFolderGroup.create({ data: { teamFolderId: tf.id, groupId: g.id } }); await app.prisma.groupMember.deleteMany({ where: { groupId: g.id, userId: f.reader.id } }); }],
  ["independent leaf share survives group revocation", true, async (f) => { const tf = await team(f); const g = await app.prisma.group.create({ data: { workspaceId: f.ws.id, name: "Former readers", members: { create: { userId: f.reader.id } } } }); await app.prisma.teamFolderGroup.create({ data: { teamFolderId: tf.id, groupId: g.id } }); await share(f); await app.prisma.groupMember.deleteMany({ where: { groupId: g.id, userId: f.reader.id } }); }],
  ["team owner alone is no personal shortcut", false, async (f) => { await team(f); await app.prisma.file.update({ where: { id: f.file.id }, data: { ownerId: f.reader.id } }); }],
  ["nonfolder team root denies admin", false, async (f) => { const tf = await team(f); await app.prisma.file.update({ where: { id: tf.root.id }, data: { isFolder: false } }); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["foreign team root denies admin", false, async (f) => { const tf = await team(f); const foreign = await workspace([[f.reader, "ADMIN"]]); await app.prisma.file.update({ where: { id: tf.root.id }, data: { workspaceId: foreign.id } }); await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.reader.id, workspaceId: f.ws.id } }, data: { role: "ADMIN" } }); }],
  ["root team relation wins over stale child relation", true, async (f) => { const tf = await team(f); f.file = tf.root; await app.prisma.teamFolderMember.create({ data: { teamFolderId: tf.id, userId: f.reader.id } }); const foreign = await workspace([[f.owner, "ADMIN"]]); const foreignRoot = await app.prisma.file.create({ data: { workspaceId: foreign.id, uploadedById: f.owner.id, ownerId: null, isFolder: true, name: "Foreign root" } }); const foreignTeam = await app.prisma.teamFolder.create({ data: { workspaceId: foreign.id, folderId: foreignRoot.id, name: "Foreign" } }); await app.prisma.file.update({ where: { id: f.file.id }, data: { teamFolderId: foreignTeam.id } }); }],
];

test("notification list, unread and first delivery match canonical file read policy", async (t) => {
  for (const [label, allowed, arrange] of cases) {
    await t.test(label, async () => {
      const f = await fixture();
      await arrange(f);
      assert.equal(await canonical(f), allowed, "canonical positive/negative control");
      const stored = await seed(f);
      const result = await visible(f);
      assert.deepEqual(result.rows.map((n) => n.id), allowed ? [stored.id] : []);
      assert.equal(result.count, allowed ? 1 : 0);
      assert.equal(result.raw.includes(stored.title), allowed);
      const id = await enqueue(f);
      assert.equal(await deliverNotification(app.prisma, app, id), "completed");
      assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), allowed ? 2 : 1);
    });
  }
});

test("file notification metadata fails closed without changing unrelated legacy notifications", async (t) => {
  const shapes = [
    ["file-only legacy source", true, "FILE_SHARED", (f) => ({ fileId: f.file.id })],
    ["missing source", false, "FILE_SHARED", () => ({})],
    ["null source", false, "FILE_SHARED", () => ({ fileId: null })],
    ["empty source", false, "FILE_SHARED", () => ({ fileId: "" })],
    ["numeric source", false, "FILE_SHARED", () => ({ fileId: 3 })],
    ["object source", false, "FILE_SHARED", () => ({ fileId: { id: "unknown" } })],
    ["array source", false, "FILE_SHARED", () => ({ fileId: [] })],
    ["unknown source", false, "FILE_SHARED", () => ({ fileId: "missing-file" })],
    ["numeric workspace", false, "FILE_SHARED", (f) => ({ fileId: f.file.id, workspaceId: 3 })],
    ["unrelated no-file data", true, "TASK_ASSIGNED", () => ({ oldMetadata: true })],
    ["unrelated null file", true, "TASK_ASSIGNED", () => ({ fileId: null })],
    ["unrelated array data", true, "TASK_ASSIGNED", () => []],
    ["file-type array data", false, "FILE_SHARED", () => []],
  ];
  for (const [label, allowed, type, data] of shapes) {
    await t.test(label, async () => {
      const f = await fixture();
      await share(f);
      const scope = data(f);
      const stored = await seed(f, { type, data: scope });
      const result = await visible(f);
      assert.deepEqual(result.rows.map((n) => n.id), allowed ? [stored.id] : []);
      assert.equal(result.count, allowed ? 1 : 0);
      const id = await enqueue(f, { type, data: scope });
      assert.equal(await deliverNotification(app.prisma, app, id), "completed");
      assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), allowed ? 2 : 1);
    });
  }
});

test("file scope and every named workspace or project scope must all remain readable", async () => {
  const f = await fixture();
  await share(f);
  const foreign = await workspace([[f.owner, "ADMIN"], [f.reader, "MEMBER"]]);
  const mismatch = await seed(f, { data: { fileId: f.file.id, workspaceId: foreign.id } });
  const project = await app.prisma.project.create({ data: { workspaceId: f.ws.id, name: "Private project" } });
  const projectDenied = await seed(f, { data: { fileId: f.file.id, workspaceId: f.ws.id, projectId: project.id } });
  assert.deepEqual((await visible(f)).rows, []);
  for (const data of [mismatch.data, projectDenied.data]) {
    const id = await enqueue(f, { data });
    assert.equal(await deliverNotification(app.prisma, app, id), "completed");
  }
  assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), 2);
  await app.prisma.projectMember.create({ data: { projectId: project.id, userId: f.reader.id } });
  assert.deepEqual((await visible(f)).rows.map((n) => n.id), [projectDenied.id]);
  await app.prisma.fileShare.deleteMany({ where: { fileId: f.file.id, sharedWithId: f.reader.id } });
  assert.deepEqual((await visible(f)).rows, [], "a readable project never bypasses lost file access");
});

test("file filtering precedes pagination, type filters and unread counting", async () => {
  const f = await fixture();
  await share(f);
  const hidden = await file(f);
  const at = (n) => new Date(Date.UTC(2027, 0, 1, 0, 0, n));
  const hiddenData = { fileId: hidden.id, workspaceId: f.ws.id };
  const top = await seed(f, { data: hiddenData, createdAt: at(6) });
  const first = await seed(f, { createdAt: at(5) });
  await seed(f, { data: hiddenData, createdAt: at(4) });
  const second = await seed(f, { createdAt: at(3), read: true });
  const third = await seed(f, { createdAt: at(2), type: "TASK_ASSIGNED" });
  await seed(f, { data: hiddenData, createdAt: at(1) });
  let result = await visible(f, "?limit=1");
  assert.deepEqual(result.rows.map((n) => n.id), [first.id]);
  assert.equal(result.count, 2);
  assert.equal(result.cursor, first.id);
  result = await visible(f, `?limit=1&cursor=${result.cursor}`);
  assert.deepEqual(result.rows.map((n) => n.id), [second.id]);
  assert.equal(result.cursor, second.id);
  result = await visible(f, `?limit=1&cursor=${result.cursor}`);
  assert.deepEqual(result.rows.map((n) => n.id), [third.id]);
  assert.equal(result.cursor, undefined);
  result = await visible(f, "?limit=1&type=FILE_SHARED&unreadOnly=true");
  assert.deepEqual(result.rows.map((n) => n.id), [first.id]);
  assert.equal(result.cursor, undefined);
  assert.deepEqual((await visible(f, "?type=UNKNOWN_TYPE")).rows, []);
  assert.deepEqual((await visible(f, `?limit=1&cursor=${top.id}`)).rows.map((n) => n.id), [first.id]);
  const marked = await request(f.reader, "/api/notifications/mark-read", { method: "POST", body: { notificationIds: [first.id] } });
  assert.equal(marked.status, 200, marked.body);
  assert.equal((await visible(f)).count, 1);
});

async function deleteFailure(enabled) {
  if (enabled) {
    await app.prisma.$executeRawUnsafe(`CREATE FUNCTION r12_nf_delete_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'R12 injected completion failure'; END $$`);
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER r12_nf_delete_failure BEFORE DELETE ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION r12_nf_delete_failure()`);
  } else {
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r12_nf_delete_failure ON "NotificationDelivery"`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS r12_nf_delete_failure()`);
  }
}

test("retry after creation keeps one toast and sends only an id refresh after file revocation", async () => {
  const f = await fixture();
  const grant = await share(f);
  const id = await enqueue(f);
  const client = await socketFor(f.reader);
  try {
    await deleteFailure(true);
    try {
      assert.equal(await deliverNotification(app.prisma, app, id), "pending");
    } finally {
      await deleteFailure(false);
    }
    const first = await client.next((m) => m.event === "notification_new");
    const [stored] = await app.prisma.notification.findMany({ where: { userId: f.reader.id } });
    assert.equal(first.data.id, stored.id);
    await app.prisma.fileShare.delete({ where: { id: grant.id } });
    assert.equal(await deliverNotification(app.prisma, app, id, { now: new Date(Date.now() + 6000) }), "completed");
    const refresh = await client.next((m) => m.event === "notification_created");
    assert.deepEqual(refresh.data, { id: stored.id });
    client.sendJSON({ type: "ping" });
    await client.next((m) => m.event === "pong");
    assert.equal(client.inbox.filter((m) => m.event === "notification_new").length, 0);
    assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), 1);
    assert.deepEqual((await visible(f)).rows, []);
    assert.equal((await visible(f)).count, 0);
  } finally {
    await deleteFailure(false);
    client.socket.destroy();
  }
});

test("authorized in-flight creation may finish but subsequent reads hide revoked file content", async () => {
  const f = await fixture();
  const grant = await share(f);
  const id = await enqueue(f);
  const controlUrl = new URL(process.env.TEST_DATABASE_URL);
  controlUrl.searchParams.set("connection_limit", "1");
  const control = new PrismaClient({ datasources: { db: { url: controlUrl.href } } });
  const key = 712_126_014;
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let held, pending;
  try {
    await app.prisma.$executeRawUnsafe(`CREATE FUNCTION r12_nf_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${key}); RETURN NEW; END $$`);
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER r12_nf_insert_barrier BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION r12_nf_insert_barrier()`);
    held = control.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key})::text`;
      acquired();
      await released;
    }, { timeout: 10000 });
    await Promise.race([ready, held]);
    pending = deliverNotification(app.prisma, app, id);
    let observed = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const [{ count }] = await app.prisma.$queryRaw`
        SELECT COUNT(*)::int AS "count" FROM pg_locks l
        JOIN pg_database d ON d.oid = l.database
        WHERE d.datname = current_database() AND l.locktype = 'advisory'
          AND l.objid = ${key} AND l.granted = false`;
      if (count > 0) { observed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(observed, true, "authorization finished and insert reached its barrier");
    await app.prisma.fileShare.delete({ where: { id: grant.id } });
    release();
    await held;
    assert.equal(await pending, "completed");
    assert.equal(await app.prisma.notification.count({ where: { userId: f.reader.id } }), 1);
    assert.deepEqual((await visible(f)).rows, []);
    assert.equal((await visible(f)).count, 0);
  } finally {
    release?.();
    await held?.catch(() => {});
    await pending?.catch(() => {});
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS r12_nf_insert_barrier ON "Notification"`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS r12_nf_insert_barrier()`);
    await control.$disconnect();
  }
});
