import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { clientFrameHeader, openRawSocket } from "./support/raw-websocket.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
const JWT_SECRET = "realtime-revocation-test-jwt-secret";
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET,
  COOKIE_SECRET: "realtime-revocation-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-realtime-revocation-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");

let app, port;
const workspaceIds = [];
const userIds = [];

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

// Each test gets its own workspace: two admins, a project member, a peer that
// stays everywhere (proving events are still emitted) and a private channel.
async function createFixture() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = async (name) => {
    const created = await app.prisma.user.create({
      data: { email: `rt-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    userIds.push(created.id);
    // Sockets require an access token bound to a live sign-in session.
    const { familyId } = await startRefreshSession(app.prisma, created.id);
    return {
      ...created,
      sessionId: familyId,
      token: signAccessToken({ sub: created.id, email: created.email, sid: familyId }),
    };
  };
  const admin = await user("admin");
  const deputy = await user("deputy");
  const member = await user("member");
  const peer = await user("peer");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Revocation ${suffix}`,
      slug: `rt-revoke-${suffix}`,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: deputy.id, role: "ADMIN" },
          { userId: member.id, role: "MEMBER" },
          { userId: peer.id, role: "MEMBER" },
        ],
      },
    },
  });
  workspaceIds.push(workspace.id);
  const otherWorkspace = await app.prisma.workspace.create({
    data: {
      name: `Unrelated ${suffix}`,
      slug: `rt-other-${suffix}`,
      members: { create: [{ userId: member.id, role: "MEMBER" }, { userId: deputy.id, role: "MEMBER" }] },
    },
  });
  workspaceIds.push(otherWorkspace.id);
  const project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Restricted project",
      members: { create: [{ userId: member.id }, { userId: peer.id }] },
      statuses: { create: { name: "Todo" } },
    },
    include: { statuses: true },
  });
  const task = await app.prisma.task.create({
    data: { projectId: project.id, statusId: project.statuses[0].id, title: "Confidential roadmap" },
  });
  const channel = await app.prisma.chatChannel.create({
    data: {
      workspaceId: workspace.id,
      name: `private-${suffix}`,
      type: "PRIVATE",
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }, { userId: peer.id }] },
    },
  });
  return { admin, deputy, member, peer, workspace, otherWorkspace, project, task, channel };
}

function inject(method, url, token, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function connect(token) {
  const client = await openRawSocket(port);
  client.sendJSON({ type: "auth", token });
  await client.next((m) => m.event === "authenticated");
  return client;
}

async function subscribe(client, kind, id) {
  const request = {
    project: ["subscribe", "projectId", "subscribed"],
    workspace: ["subscribe_workspace", "workspaceId", "subscribed_workspace"],
    channel: ["subscribe_channel", "channelId", "subscribed_channel"],
  }[kind];
  client.sendJSON({ type: request[0], [request[1]]: id });
  const reply = await client.next((m) => m.event === request[2] && m[request[1]] === id);
  return reply.success;
}

async function subscribeAll(client, f) {
  assert.equal(await subscribe(client, "workspace", f.workspace.id), true);
  assert.equal(await subscribe(client, "project", f.project.id), true);
  assert.equal(await subscribe(client, "channel", f.channel.id), true);
}

// Emits one event on every scope and returns the marker so receivers can be checked.
function emitEverywhere(f) {
  const marker = crypto.randomUUID();
  app.broadcastToWorkspace(f.workspace.id, "probe_workspace", { marker, secret: "workspace detail" });
  app.broadcast(f.project.id, "probe_project", { marker, title: f.task.title });
  app.broadcastToChannel(f.channel.id, "probe_channel", { marker, content: "private message" });
  return marker;
}

async function assertReceivesAll(client, marker) {
  for (const event of ["probe_workspace", "probe_project", "probe_channel"]) {
    await client.next((m) => m.event === event && m.data.marker === marker);
  }
}

async function assertReceivesNothing(client, marker, label) {
  await client.drain(300);
  const leaked = client.inbox.filter((m) => m.data?.marker === marker);
  assert.deepEqual(leaked, [], `${label} still received ${JSON.stringify(leaked)}`);
}

function closeAll(...clients) {
  for (const client of clients) client.socket.destroy();
}

test("a removed workspace member stops receiving events on every open socket, cannot resubscribe and keeps other workspaces", async () => {
  const f = await createFixture();
  const tabA = await connect(f.member.token);
  const tabB = await connect(f.member.token);
  const observer = await connect(f.peer.token);
  try {
    for (const client of [tabA, tabB, observer]) await subscribeAll(client, f);
    assert.equal(await subscribe(tabA, "workspace", f.otherWorkspace.id), true);

    const folder = await app.prisma.file.create({
      data: { workspaceId: f.workspace.id, name: "Team", isFolder: true, uploadedById: f.admin.id },
    });
    const teamFolder = await app.prisma.teamFolder.create({
      data: { workspaceId: f.workspace.id, folderId: folder.id, name: "Team", members: { create: { userId: f.member.id } } },
    });
    const group = await app.prisma.group.create({
      data: { workspaceId: f.workspace.id, name: `Group ${f.workspace.id}`, members: { create: { userId: f.member.id } } },
    });

    const removed = await inject("DELETE", `/api/workspaces/${f.workspace.id}/members/${f.member.id}`, f.admin.token);
    assert.equal(removed.statusCode, 204, removed.body);

    const marker = emitEverywhere(f);
    await assertReceivesAll(observer, marker);
    await assertReceivesNothing(tabA, marker, "tab A");
    await assertReceivesNothing(tabB, marker, "tab B");
    // The peer is told the removed user went offline.
    await observer.next((m) => m.event === "presence_offline" && m.data.userId === f.member.id);

    // Unrelated workspace subscriptions survive.
    app.broadcastToWorkspace(f.otherWorkspace.id, "probe_other", { marker });
    await tabA.next((m) => m.event === "probe_other" && m.data.marker === marker);

    // Existing socket and a fresh connection with the still-valid token are both refused.
    const reconnect = await connect(f.member.token);
    try {
      for (const client of [tabA, reconnect]) {
        assert.equal(await subscribe(client, "workspace", f.workspace.id), false);
        assert.equal(await subscribe(client, "project", f.project.id), false);
        assert.equal(await subscribe(client, "channel", f.channel.id), false);
      }
      const after = emitEverywhere(f);
      await assertReceivesNothing(reconnect, after, "reconnected socket");
    } finally {
      closeAll(reconnect);
    }

    // Dependent memberships no longer outlive the workspace membership.
    assert.equal(await app.prisma.projectMember.count({ where: { userId: f.member.id, projectId: f.project.id } }), 0);
    assert.equal(await app.prisma.chatChannelMember.count({ where: { userId: f.member.id, channelId: f.channel.id } }), 0);
    assert.equal(await app.prisma.teamFolderMember.count({ where: { userId: f.member.id, teamFolderId: teamFolder.id } }), 0);
    assert.equal(await app.prisma.groupMember.count({ where: { userId: f.member.id, groupId: group.id } }), 0);
    assert.equal(await app.prisma.projectMember.count({ where: { userId: f.peer.id, projectId: f.project.id } }), 1);
  } finally {
    closeAll(tabA, tabB, observer);
  }
});

test("a legacy chat membership row cannot authorize a channel subscription after workspace removal", async () => {
  const f = await createFixture();
  await app.prisma.workspaceMember.delete({
    where: { userId_workspaceId: { userId: f.member.id, workspaceId: f.workspace.id } },
  });
  // The private channel row is still present, as it was for members removed before cleanup existed.
  assert.equal(await app.prisma.chatChannelMember.count({ where: { userId: f.member.id, channelId: f.channel.id } }), 1);
  const client = await connect(f.member.token);
  try {
    assert.equal(await subscribe(client, "channel", f.channel.id), false);
    assert.equal(await subscribe(client, "project", f.project.id), false);
    const marker = emitEverywhere(f);
    await assertReceivesNothing(client, marker, "stale member");
  } finally {
    closeAll(client);
  }
});

test("project removal stops project events on the existing socket and on reconnect", async () => {
  const f = await createFixture();
  const client = await connect(f.member.token);
  const observer = await connect(f.peer.token);
  try {
    await subscribeAll(client, f);
    await subscribeAll(observer, f);
    const removed = await inject("DELETE", `/api/projects/${f.project.id}/members/${f.member.id}`, f.admin.token);
    assert.equal(removed.statusCode, 204, removed.body);

    const marker = emitEverywhere(f);
    await assertReceivesAll(observer, marker);
    await client.next((m) => m.event === "probe_workspace" && m.data.marker === marker);
    await client.next((m) => m.event === "probe_channel" && m.data.marker === marker);
    await assertReceivesNothing(client, marker, "removed project member");

    assert.equal(await subscribe(client, "project", f.project.id), false);
    const reconnect = await connect(f.member.token);
    try {
      assert.equal(await subscribe(reconnect, "project", f.project.id), false);
    } finally {
      closeAll(reconnect);
    }
  } finally {
    closeAll(client, observer);
  }
});

test("removal from a private channel, or leaving it, stops its messages immediately", async () => {
  const f = await createFixture();
  const removedClient = await connect(f.member.token);
  const leavingClient = await connect(f.peer.token);
  const observer = await connect(f.admin.token);
  try {
    for (const client of [removedClient, leavingClient, observer]) {
      assert.equal(await subscribe(client, "channel", f.channel.id), true);
    }
    const removed = await inject(
      "DELETE",
      `/api/chat/${f.workspace.id}/channels/${f.channel.id}/members/${f.member.id}`,
      f.admin.token,
    );
    assert.equal(removed.statusCode, 204, removed.body);
    const left = await inject("POST", `/api/chat/${f.workspace.id}/channels/${f.channel.id}/leave`, f.peer.token);
    assert.equal(left.statusCode, 204, left.body);

    const sent = await inject("POST", `/api/chat/${f.workspace.id}/channels/${f.channel.id}/messages`, f.admin.token, {
      content: "after removal: acquisition shortlist",
    });
    assert.equal(sent.statusCode, 201, sent.body);
    const created = await observer.next((m) => m.event === "chat_message_created");
    assert.equal(created.data.message.content, "after removal: acquisition shortlist");

    for (const client of [removedClient, leavingClient]) {
      await client.drain(300);
      assert.deepEqual(
        client.inbox.filter((m) => m.event === "chat_message_created"),
        [],
        "former channel member received a message created after removal",
      );
      assert.equal(await subscribe(client, "channel", f.channel.id), false);
    }
  } finally {
    closeAll(removedClient, leavingClient, observer);
  }
});

test("demoting an administrator drops project subscriptions that relied on the admin role", async () => {
  const f = await createFixture();
  // The deputy admin is not a project member; access came only from ADMIN.
  const client = await connect(f.deputy.token);
  // The member keeps project membership and must keep its subscription as VIEWER.
  const memberClient = await connect(f.member.token);
  try {
    assert.equal(await subscribe(client, "workspace", f.workspace.id), true);
    assert.equal(await subscribe(client, "project", f.project.id), true);
    assert.equal(await subscribe(memberClient, "project", f.project.id), true);

    const demoted = await inject("PATCH", `/api/workspaces/${f.workspace.id}/members/${f.deputy.id}`, f.admin.token, {
      role: "VIEWER",
    });
    assert.equal(demoted.statusCode, 200, demoted.body);
    const viewer = await inject("PATCH", `/api/workspaces/${f.workspace.id}/members/${f.member.id}`, f.admin.token, {
      role: "VIEWER",
    });
    assert.equal(viewer.statusCode, 200, viewer.body);

    const marker = crypto.randomUUID();
    app.broadcast(f.project.id, "probe_project", { marker, title: f.task.title });
    app.broadcastToWorkspace(f.workspace.id, "probe_workspace", { marker });
    await memberClient.next((m) => m.event === "probe_project" && m.data.marker === marker);
    await client.next((m) => m.event === "probe_workspace" && m.data.marker === marker);
    await assertReceivesNothing(client, marker, "demoted admin");
    assert.equal(await subscribe(client, "project", f.project.id), false);

    // Promoting again restores access through a normal subscribe.
    const promoted = await inject("PATCH", `/api/workspaces/${f.workspace.id}/members/${f.deputy.id}`, f.admin.token, {
      role: "ADMIN",
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    assert.equal(await subscribe(client, "project", f.project.id), true);
  } finally {
    closeAll(client, memberClient);
  }
});

test("a socket is closed when its access token expires and receives nothing afterwards", async () => {
  const f = await createFixture();
  const shortToken = jwt.sign({ sub: f.member.id, email: f.member.email, sid: f.member.sessionId }, JWT_SECRET, {
    expiresIn: 2,
  });
  const client = await connect(shortToken);
  try {
    await subscribeAll(client, f);
    client.sendJSON({ type: "ping" });
    await client.next((m) => m.event === "pong");

    const closed = await client.closed(4000);
    assert.deepEqual(closed, { code: 4004, reason: "Session expired" });
    const marker = emitEverywhere(f);
    await assertReceivesNothing(client, marker, "expired socket");

    // The expired token cannot open a new session; a fresh token can.
    const retry = await openRawSocket(port);
    try {
      retry.sendJSON({ type: "auth", token: shortToken });
      assert.deepEqual(await retry.closed(), { code: 4002, reason: "Authentication failed" });
    } finally {
      closeAll(retry);
    }
    const fresh = await connect(f.member.token);
    closeAll(fresh);
  } finally {
    closeAll(client);
  }
});

test("revoking a user's sessions closes every open socket for that user only", async () => {
  const f = await createFixture();
  const tabA = await connect(f.member.token);
  const tabB = await connect(f.member.token);
  const observer = await connect(f.peer.token);
  try {
    for (const client of [tabA, tabB, observer]) await subscribeAll(client, f);
    realtime.disconnectUserSockets(f.member.id);
    for (const client of [tabA, tabB]) {
      assert.deepEqual(await client.closed(), { code: 4005, reason: "Session revoked" });
    }
    const marker = emitEverywhere(f);
    await assertReceivesAll(observer, marker);
  } finally {
    closeAll(tabA, tabB, observer);
  }
});

test("a subscription check that raced a removal is repeated against the committed state", async () => {
  const f = await createFixture();
  const socket = {
    OPEN: 1,
    CONNECTING: 0,
    readyState: 1,
    sent: [],
    send(message) {
      this.sent.push(JSON.parse(message));
    },
    close() {
      this.readyState = 3;
    },
  };
  assert.equal(await realtime.authenticate(socket, f.member.token, app.prisma), f.member.id);
  try {
    // The first authorization read completes before the removal commits and
    // is held until the removal has been applied.
    let reads = 0;
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let firstReadDone;
    const firstRead = new Promise((resolve) => (firstReadDone = resolve));
    const gated = {
      chatChannel: {
        findFirst: async (args) => {
          const result = await app.prisma.chatChannel.findFirst(args);
          if (reads++ === 0) {
            firstReadDone(result);
            await held;
          }
          return result;
        },
      },
    };
    const pending = realtime.subscribeChannel(socket, f.channel.id, gated);
    assert.notEqual(await firstRead, null, "the first read saw the membership");

    const removed = await inject(
      "DELETE",
      `/api/chat/${f.workspace.id}/channels/${f.channel.id}/members/${f.member.id}`,
      f.admin.token,
    );
    assert.equal(removed.statusCode, 204, removed.body);
    release();

    assert.equal(await pending, false);
    assert.equal(reads, 2, "the stale read was repeated");
    app.broadcastToChannel(f.channel.id, "probe_channel", { content: "after removal" });
    assert.deepEqual(socket.sent, []);
  } finally {
    realtime.cleanup(socket);
  }
});

test("notification list and unread count hide entries for scopes the user can no longer access", async () => {
  const f = await createFixture();
  const otherProject = await app.prisma.project.create({
    data: { workspaceId: f.otherWorkspace.id, name: "Still visible", members: { create: { userId: f.member.id } } },
  });
  const base = { userId: f.member.id, read: false };
  const created = [];
  const make = async (title, type, data) => {
    const row = await app.prisma.notification.create({
      data: { ...base, title, type, body: `${title} body`, ...(data ? { data } : {}) },
    });
    created.push(row);
    // Distinct timestamps keep the expected order deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return row;
  };
  await make("project assignment", "TASK_ASSIGNED", { taskId: f.task.id, projectId: f.project.id });
  await make("due soon", "TASK_DUE_SOON", { taskId: f.task.id, workspaceId: f.workspace.id });
  await make("mention", "CHAT_MENTION", { channelId: f.channel.id, messageId: "m1" });
  const sharedFile = await app.prisma.file.create({
    data: { workspaceId: f.workspace.id, name: "Shared fixture", ownerId: f.admin.id, uploadedById: f.admin.id },
  });
  await app.prisma.fileShare.create({
    data: { workspaceId: f.workspace.id, fileId: sharedFile.id, sharedById: f.admin.id, sharedWithId: f.member.id },
  });
  await make("file share", "FILE_SHARED", { fileId: sharedFile.id, workspaceId: f.workspace.id });
  const keepProject = await make("other project", "TASK_ASSIGNED", { projectId: otherProject.id });
  const keepPlain = await make("plain", "TASK_ASSIGNED");

  const before = await inject("GET", "/api/notifications?limit=50", f.member.token);
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().data.length, 6);
  assert.equal((await inject("GET", "/api/notifications/unread-count", f.member.token)).json().count, 6);

  const removed = await inject("DELETE", `/api/workspaces/${f.workspace.id}/members/${f.member.id}`, f.admin.token);
  assert.equal(removed.statusCode, 204, removed.body);

  const list = await inject("GET", "/api/notifications?limit=50", f.member.token);
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    list.json().data.map((n) => n.id),
    [keepPlain.id, keepProject.id],
  );
  assert.ok(!list.body.includes("Confidential roadmap") && !list.body.includes("mention body"));
  const unread = await inject("GET", "/api/notifications/unread-count", f.member.token);
  assert.equal(unread.json().count, 2);
  const unreadOnly = await inject("GET", "/api/notifications?unreadOnly=true&limit=50", f.member.token);
  assert.deepEqual(unreadOnly.json().data.map((n) => n.id), [keepPlain.id, keepProject.id]);

  // Cursor pagination walks only visible entries.
  const first = await inject("GET", "/api/notifications?limit=1", f.member.token);
  assert.deepEqual(first.json().data.map((n) => n.id), [keepPlain.id]);
  assert.equal(first.json().nextCursor, keepPlain.id);
  const second = await inject("GET", `/api/notifications?limit=1&cursor=${keepPlain.id}`, f.member.token);
  assert.deepEqual(second.json().data.map((n) => n.id), [keepProject.id]);
  assert.equal(second.json().nextCursor, undefined);

  // Type filtering composes with access filtering.
  const typed = await inject("GET", "/api/notifications?type=TASK_DUE_SOON,CHAT_MENTION", f.member.token);
  assert.deepEqual(typed.json().data, []);

  // The project member who kept access still sees project notifications.
  const peerRow = await app.prisma.notification.create({
    data: { userId: f.peer.id, type: "TASK_ASSIGNED", title: "peer", data: { taskId: f.task.id, projectId: f.project.id } },
  });
  const peerList = await inject("GET", "/api/notifications?limit=50", f.peer.token);
  assert.deepEqual(peerList.json().data.map((n) => n.id), [peerRow.id]);
});

test("an oversized frame is rejected before authentication without buffering it", async () => {
  const client = await openRawSocket(port);
  try {
    // Announce a 4 MiB text frame and send only the header: the server must
    // refuse it from the length alone rather than wait for the payload.
    client.socket.write(Buffer.concat([clientFrameHeader(0x1, true, 4 * 1024 * 1024), crypto.randomBytes(4)]));
    const closed = await client.closed(2000);
    assert.equal(closed?.code, 1009);
  } finally {
    closeAll(client);
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200);
});
