import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  JWT_SECRET: "dashboard-liveness-test-jwt-secret",
  COOKIE_SECRET: "dashboard-liveness-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-dashboard-liveness-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");

const INVALIDATION = "workspace_tasks_invalidated";
let app, port, fixture;
let socketCount = 0;
let requestCount = 0;

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  fixture = await createFixture();
});

after(async () => {
  try {
    if (app && fixture) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [fixture.workspace.id, fixture.otherWorkspace.id] } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: [fixture.actor.id, fixture.watcher.id, fixture.admin.id, fixture.hidden.id] } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = async (name, role, workspaceIds) => {
    const created = await app.prisma.user.create({
      data: { email: `dashlive-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    const { familyId } = await startRefreshSession(app.prisma, created.id);
    return {
      ...created,
      role,
      token: signAccessToken({ sub: created.id, email: created.email, sid: familyId }),
      workspaceIds,
    };
  };
  const actor = await user("actor");
  const watcher = await user("watcher");
  const admin = await user("admin");
  const hidden = await user("hidden");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Dash live ${suffix}`,
      slug: `dash-live-${suffix}`,
      members: {
        create: [
          { userId: actor.id, role: "ADMIN" },
          { userId: watcher.id, role: "MEMBER" },
          { userId: admin.id, role: "ADMIN" },
          { userId: hidden.id, role: "MEMBER" },
        ],
      },
    },
  });
  const otherWorkspace = await app.prisma.workspace.create({
    data: {
      name: `Dash other ${suffix}`,
      slug: `dash-other-${suffix}`,
      members: { create: [{ userId: watcher.id, role: "MEMBER" }] },
    },
  });
  const project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Visible ${suffix}`,
      members: { create: [{ userId: watcher.id }] },
      statuses: { create: { name: "Todo" } },
    },
    include: { statuses: true },
  });
  return {
    suffix,
    actor,
    watcher,
    admin,
    hidden,
    workspace,
    otherWorkspace,
    project,
    title: `secret-title-${suffix}`,
    body: `secret-body-${suffix}`,
  };
}

function request(token, method, url, payload) {
  requestCount += 1;
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: `127.19.1.${requestCount}`,
  });
}

async function connect(token) {
  socketCount += 1;
  const client = await openRawSocket(port, { localAddress: `127.19.0.${socketCount}` });
  client.sendJSON({ type: "auth", token });
  await client.next((message) => message.event === "authenticated");
  return client;
}

async function subscribe(client, kind, id) {
  const requestKind = {
    project: ["subscribe", "projectId", "subscribed"],
    workspace: ["subscribe_workspace", "workspaceId", "subscribed_workspace"],
  }[kind];
  client.sendJSON({ type: requestKind[0], [requestKind[1]]: id });
  const reply = await client.next((message) => message.event === requestKind[2] && message[requestKind[1]] === id);
  assert.equal(reply.success, true);
}

async function quiet(clients) {
  await Promise.all(clients.map((client) => client.drain(100)));
  for (const client of clients) client.inbox.splice(0);
}

async function rest(clients) {
  await Promise.all(clients.map((client) => client.drain(200)));
}

function assertContentFree(message, workspaceId, secrets) {
  assert.equal(message.event, INVALIDATION);
  assert.deepEqual(message.data, {});
  assert.equal(message.workspaceId, workspaceId);
  assert.equal(message.projectId, undefined);
  assert.equal(message.channelId, undefined);
  const encoded = JSON.stringify(message);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false, encoded);
}

test("a workspace subscriber does not see the task event; a visible user gets a content-free invalidation", async () => {
  const { actor, watcher, admin, hidden, workspace, otherWorkspace, project, title, body } = fixture;
  const clients = [];
  try {
    const board = await connect(actor.token);
    const dashboard = await connect(watcher.token);
    const adminDashboard = await connect(admin.token);
    const stranger = await connect(hidden.token);
    const otherTab = await connect(watcher.token);
    clients.push(board, dashboard, adminDashboard, stranger, otherTab);
    await subscribe(board, "project", project.id);
    await subscribe(dashboard, "workspace", workspace.id);
    await subscribe(adminDashboard, "workspace", workspace.id);
    await subscribe(stranger, "workspace", workspace.id);
    await subscribe(otherTab, "workspace", otherWorkspace.id);
    await quiet(clients);

    const created = await request(actor.token, "POST", `/api/projects/${project.id}/tasks`, {
      title,
      description: body,
      priority: "NONE",
    });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().data.id;
    const secrets = [taskId, title, body];

    const createdEvent = await board.next((message) => message.event === "task_created", 2000);
    assert.deepEqual(createdEvent, { event: "task_created", data: { taskId }, projectId: project.id });
    const createdForMember = await dashboard.next((message) => message.event === INVALIDATION, 2000);
    const createdForAdmin = await adminDashboard.next((message) => message.event === INVALIDATION, 2000);
    assertContentFree(createdForMember, workspace.id, secrets);
    assertContentFree(createdForAdmin, workspace.id, secrets);
    await rest(clients);
    assert.deepEqual(board.inbox, [], JSON.stringify(board.inbox));
    assert.deepEqual(dashboard.inbox, [], JSON.stringify(dashboard.inbox));
    assert.deepEqual(adminDashboard.inbox, [], JSON.stringify(adminDashboard.inbox));
    assert.deepEqual(stranger.inbox, [], JSON.stringify(stranger.inbox));
    assert.deepEqual(otherTab.inbox, [], JSON.stringify(otherTab.inbox));
    await quiet(clients);

    const updated = await request(actor.token, "PATCH", `/api/tasks/${taskId}`, { title: `${title}-edited` });
    assert.equal(updated.statusCode, 200, updated.body);
    const updatedEvent = await board.next((message) => message.event === "task_updated", 2000);
    assert.deepEqual(updatedEvent, { event: "task_updated", data: { taskId }, projectId: project.id });
    assertContentFree(await dashboard.next((message) => message.event === INVALIDATION, 2000), workspace.id, [...secrets, `${title}-edited`]);
    assertContentFree(await adminDashboard.next((message) => message.event === INVALIDATION, 2000), workspace.id, [...secrets, `${title}-edited`]);
    await rest(clients);
    assert.deepEqual(stranger.inbox, [], JSON.stringify(stranger.inbox));
    assert.deepEqual(otherTab.inbox, [], JSON.stringify(otherTab.inbox));
    assert.deepEqual(dashboard.inbox, [], JSON.stringify(dashboard.inbox));
    assert.deepEqual(board.inbox, [], JSON.stringify(board.inbox));
    assert.deepEqual(adminDashboard.inbox, [], JSON.stringify(adminDashboard.inbox));
    await quiet(clients);

    const removed = await request(actor.token, "DELETE", `/api/tasks/${taskId}`);
    assert.equal(removed.statusCode, 204, removed.body);
    const deletedEvent = await board.next((message) => message.event === "task_deleted", 2000);
    assert.deepEqual(deletedEvent, { event: "task_deleted", data: { taskId }, projectId: project.id });
    assertContentFree(await dashboard.next((message) => message.event === INVALIDATION, 2000), workspace.id, secrets);
    assertContentFree(await adminDashboard.next((message) => message.event === INVALIDATION, 2000), workspace.id, secrets);
    await rest(clients);
    assert.deepEqual(stranger.inbox, [], JSON.stringify(stranger.inbox));
    assert.deepEqual(otherTab.inbox, [], JSON.stringify(otherTab.inbox));
    assert.deepEqual(dashboard.inbox, [], JSON.stringify(dashboard.inbox));
    assert.deepEqual(board.inbox, [], JSON.stringify(board.inbox));
    assert.deepEqual(adminDashboard.inbox, [], JSON.stringify(adminDashboard.inbox));
  } finally {
    for (const client of clients) client.socket.destroy();
  }
});

test("a revocation during the recipient read is not delivered, nor is a socket that subscribes during it", async () => {
  const { actor, watcher, admin, workspace, project, suffix } = fixture;
  const original = app.prisma.project.findUnique.bind(app.prisma.project);
  let release = () => {};
  let entered = () => {};
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  app.prisma.project.findUnique = async (args) => {
    const result = await original(args);
    const listed = args?.select?.members?.where?.userId?.in;
    if (Array.isArray(listed)) {
      entered();
      await hold;
    }
    return result;
  };
  const clients = [];
  try {
    const board = await connect(actor.token);
    const dashboard = await connect(watcher.token);
    clients.push(board, dashboard);
    await subscribe(board, "project", project.id);
    await subscribe(dashboard, "workspace", workspace.id);
    await quiet(clients);

    const pending = request(actor.token, "POST", `/api/projects/${project.id}/tasks`, {
      title: `race-${suffix}`,
      priority: "NONE",
    });
    await Promise.race([
      enteredPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("recipient lookup did not start")), 5000)),
    ]);
    await app.prisma.projectMember.delete({
      where: { projectId_userId: { projectId: project.id, userId: watcher.id } },
    });
    realtime.revokeProjectAccess(watcher.id, project.id);
    const late = await connect(admin.token);
    clients.push(late);
    await subscribe(late, "workspace", workspace.id);
    release();

    const created = await pending;
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().data.id;
    const createdEvent = await board.next((message) => message.event === "task_created", 2000);
    assert.deepEqual(createdEvent, { event: "task_created", data: { taskId }, projectId: project.id });
    await rest(clients);
    assert.equal(dashboard.inbox.some((message) => message.event === INVALIDATION), false, JSON.stringify(dashboard.inbox));
    assert.equal(late.inbox.some((message) => message.event === INVALIDATION), false, JSON.stringify(late.inbox));

    app.prisma.project.findUnique = original;
    await quiet(clients);
    const updated = await request(actor.token, "PATCH", `/api/tasks/${taskId}`, { title: `race-${suffix}-edited` });
    assert.equal(updated.statusCode, 200, updated.body);
    assertContentFree(
      await late.next((message) => message.event === INVALIDATION, 2000),
      workspace.id,
      [taskId, `race-${suffix}`, `race-${suffix}-edited`],
    );
    await rest([dashboard, late, board]);
    assert.equal(dashboard.inbox.some((message) => message.event === INVALIDATION), false, JSON.stringify(dashboard.inbox));
  } finally {
    app.prisma.project.findUnique = original;
    release();
    await app.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: watcher.id } },
      update: {},
      create: { projectId: project.id, userId: watcher.id },
    });
    for (const client of clients) client.socket.destroy();
  }
});
