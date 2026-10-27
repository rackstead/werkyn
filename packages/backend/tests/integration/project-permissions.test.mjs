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
process.env.JWT_SECRET = "project-permission-integration-secret";
process.env.COOKIE_SECRET = "project-permission-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-project-permissions-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const realtime = await import("../../src/modules/realtime/realtime.service.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { notify } = await import("../../src/utils/notify.js");
let app, workspace, foreignWorkspace, project, hidden, assigned, unassigned, blocking, subtask, comment, field, label, status;
const users = {}, tokens = {}, sockets = [], events = [];
let requests = 0;

function request(actor, method, url, payload) {
  return app.inject({ method, url, payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.40.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

async function connect(actor) {
  const messages = [];
  const ws = { OPEN: 1, readyState: 1, send(value) { messages.push(JSON.parse(value)); }, close() { this.readyState = 3; } };
  sockets.push(ws);
  assert.equal(await realtime.authenticate(ws, tokens[actor], app.prisma), users[actor].id);
  return { ws, messages };
}

async function snapshot() {
  return Promise.all([
    app.prisma.task.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    app.prisma.taskAssignee.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.taskLabel.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.subtask.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.comment.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.customFieldValue.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.activityLog.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.taskDependency.findMany({ where: { blockedTask: { projectId: project.id } }, orderBy: { id: "asc" } }),
  ]);
}

before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID().slice(0, 20);
  const roles = { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER", OUTSIDER: "MEMBER", OUTSIDE_VIEWER: "VIEWER", PEER: "MEMBER", FOREIGN: "ADMIN" };
  for (const actor of Object.keys(roles)) {
    const user = await app.prisma.user.create({ data: { email: `project-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    users[actor] = user; tokens[actor] = signAccessToken({ sub: user.id, email: user.email });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Project authorization", slug: `project-scope-${suffix}`, members: { create: Object.keys(roles).filter((r) => r !== "FOREIGN").map((r) => ({ userId: users[r].id, role: roles[r] })) } } });
  foreignWorkspace = await app.prisma.workspace.create({ data: { name: "Foreign workspace", slug: `project-foreign-${suffix}`, members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } } } });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Restricted project", members: { create: ["MEMBER", "VIEWER", "PEER"].map((r) => ({ userId: users[r].id })) } } });
  hidden = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Hidden project", members: { create: { userId: users.PEER.id } } } });
  status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  label = await app.prisma.label.create({ data: { projectId: project.id, name: "Label", color: "#112233" } });
  field = await app.prisma.customField.create({ data: { projectId: project.id, name: "Text", type: "TEXT" } });
  assigned = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Assigned task", position: 0, assignees: { create: [{ userId: users.MEMBER.id }, { userId: users.PEER.id }] } } });
  unassigned = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Unassigned task", position: 1 } });
  blocking = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Blocking task", position: 2 } });
  subtask = await app.prisma.subtask.create({ data: { taskId: unassigned.id, title: "Private subtask" } });
  comment = await app.prisma.comment.create({ data: { taskId: unassigned.id, authorId: users.PEER.id, body: "Project private comment" } });
  const hiddenStatus = await app.prisma.statusColumn.create({ data: { projectId: hidden.id, name: "Hidden" } });
  const hiddenTask = await app.prisma.task.create({ data: { projectId: hidden.id, statusId: hiddenStatus.id, title: "Hidden task" } });
  await app.prisma.activityLog.createMany({ data: [
    { taskId: unassigned.id, actorId: users.PEER.id, action: "created" },
    { taskId: hiddenTask.id, actorId: users.PEER.id, action: "created" },
  ] });
});

after(async () => {
  for (const ws of sockets) realtime.cleanup(ws);
  try {
    if (app) {
      const ids = [workspace?.id, foreignWorkspace?.id].filter(Boolean);
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: ids } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

for (const actor of ["OUTSIDER", "OUTSIDE_VIEWER", "FOREIGN"]) {
  test(`${actor}: project, task and derived routes share the summary access policy`, async () => {
    const initial = await snapshot(); events.length = 0;
    const reads = [
      `/api/projects/${project.id}`, `/api/projects/${project.id}/tasks`, `/api/projects/${project.id}/members`,
      `/api/projects/${project.id}/statuses`, `/api/projects/${project.id}/labels`, `/api/projects/${project.id}/custom-fields`,
      `/api/projects/${project.id}/templates`, `/api/projects/${project.id}/recurring`, `/api/tasks/${unassigned.id}`,
      `/api/tasks/${unassigned.id}/comments`, `/api/tasks/${unassigned.id}/subtasks`, `/api/tasks/${unassigned.id}/activity`,
    ];
    for (const url of reads) {
      const response = await request(actor, "GET", url);
      assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
      assert(!response.body.includes("Private subtask"));
    }
    for (const [method, url, body] of [
      ["POST", `/api/projects/${project.id}/tasks`, { title: "Forbidden" }],
      ["PATCH", `/api/tasks/${unassigned.id}`, { title: "Forbidden" }],
      ["POST", `/api/tasks/${unassigned.id}/comments`, { body: "Forbidden" }],
      ["PATCH", `/api/subtasks/${subtask.id}`, { title: "Forbidden" }],
      ["PATCH", `/api/comments/${comment.id}`, { body: "Forbidden" }],
      ["PUT", `/api/projects/${project.id}/tasks/${unassigned.id}/custom-fields/${field.id}`, { value: "Forbidden" }],
      ["POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [unassigned.id], priority: "HIGH" }],
    ]) {
      const response = await request(actor, method, url, body);
      assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    }
    const { ws } = await connect(actor);
    assert.equal(await realtime.subscribe(ws, project.id, app.prisma), false);
    assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
  });
}

test("project members and same-workspace admins retain read access; activity filters hidden projects", async () => {
  for (const actor of ["ADMIN", "MEMBER", "VIEWER"]) {
    for (const url of [`/api/projects/${project.id}`, `/api/projects/${project.id}/tasks`, `/api/tasks/${unassigned.id}/comments`]) {
      const result = await request(actor, "GET", url); assert.equal(result.statusCode, 200, result.body);
    }
    const { ws } = await connect(actor);
    assert.equal(await realtime.subscribe(ws, project.id, app.prisma), true);
    const activity = await request(actor, "GET", `/api/workspaces/${workspace.id}/activity`);
    assert.equal(activity.statusCode, 200, activity.body);
    const projects = activity.json().data.map((a) => a.task.project.id);
    assert(projects.includes(project.id));
    assert.equal(projects.includes(hidden.id), actor === "ADMIN");
    assert.equal(activity.json().pagination.total, actor === "ADMIN" ? 2 : 1);
  }
});

test("workspace discovery and counts expose only the actor's projects", async () => {
  const hiddenTask = await app.prisma.task.findFirst({ where: { projectId: hidden.id } });
  await app.prisma.taskAssignee.create({ data: { taskId: hiddenTask.id, userId: users.MEMBER.id } });
  try {
    for (const actor of ["ADMIN", "MEMBER", "VIEWER", "OUTSIDER"]) {
      const expectedCount = actor === "ADMIN" ? 2 : actor === "OUTSIDER" ? 0 : 1;
      const summary = await request(actor, "GET", `/api/workspaces/${workspace.id}`);
      assert.equal(summary.statusCode, 200, summary.body);
      assert.equal(summary.json().data._count.projects, expectedCount);
      const dashboard = await request(actor, "GET", `/api/workspaces/${workspace.id}/dashboard`);
      assert.equal(dashboard.statusCode, 200, dashboard.body);
      assert.equal(dashboard.json().data.length, expectedCount);
      assert.equal(dashboard.json().data.some((row) => row.id === hidden.id), actor === "ADMIN");
      const search = await request(actor, "GET", `/api/workspaces/${workspace.id}/search?q=task`);
      assert.equal(search.statusCode, 200, search.body);
      assert.equal(search.json().data.some((row) => row.projectId === hidden.id), actor === "ADMIN");
      const myTasks = await request(actor, "GET", `/api/workspaces/${workspace.id}/my-tasks`);
      assert.equal(myTasks.statusCode, 200, myTasks.body);
      assert(!myTasks.json().data.some((row) => row.projectId === hidden.id));
    }
  } finally {
    await app.prisma.taskAssignee.delete({ where: { taskId_userId: { taskId: hiddenTask.id, userId: users.MEMBER.id } } });
  }
});

test("member self-assignment and project discussion remain available", async () => {
  const assign = await request("MEMBER", "POST", `/api/tasks/${unassigned.id}/assignees`, { userId: users.MEMBER.id });
  assert.equal(assign.statusCode, 201, assign.body);
  assert.equal((await request("MEMBER", "PATCH", `/api/tasks/${unassigned.id}`, { priority: "LOW" })).statusCode, 200);
  assert.equal((await request("MEMBER", "DELETE", `/api/tasks/${unassigned.id}/assignees/${users.MEMBER.id}`)).statusCode, 204);
  assert.equal((await request("MEMBER", "POST", `/api/tasks/${unassigned.id}/comments`, { body: "Discussion without assignment" })).statusCode, 201);
  assert.equal((await request("VIEWER", "POST", `/api/tasks/${unassigned.id}/comments`, { body: "Denied" })).statusCode, 403);
});

test("project notification recipients exclude other projects and workspaces", async () => {
  const title = `Notification scope ${crypto.randomUUID()}`;
  await notify(app.prisma, app, { recipients: Object.values(users).map((u) => u.id), type: "COMMENT_MENTION", title, body: "Private project content", data: { projectId: project.id } });
  const rows = await app.prisma.notification.findMany({ where: { title } });
  assert.deepEqual(rows.map((r) => r.userId).sort(), [users.ADMIN.id, users.MEMBER.id, users.PEER.id, users.VIEWER.id].sort());
});

test("task-only reminder notifications use actual project rights and ignore a supplied accessible project hint", async () => {
  const title = `Task-only reminder ${crypto.randomUUID()}`;
  await notify(app.prisma, app, { recipients: Object.values(users).map((u) => u.id), type: "TASK_DUE_SOON", title, body: "Private task content", data: { taskId: assigned.id } });
  const rows = await app.prisma.notification.findMany({ where: { title } });
  assert.deepEqual(rows.map((row) => row.userId).sort(), [users.ADMIN.id, users.MEMBER.id, users.PEER.id, users.VIEWER.id].sort());
  const hiddenTask = await app.prisma.task.findFirst({ where: { projectId: hidden.id } });
  const hintTitle = `Mismatched hint ${crypto.randomUUID()}`;
  await notify(app.prisma, app, { recipients: [users.MEMBER.id], type: "TASK_DUE_SOON", title: hintTitle, body: "Hidden task content", data: { projectId: project.id, taskId: hiddenTask.id } });
  assert.equal(await app.prisma.notification.count({ where: { title: hintTitle } }), 0);
});

test("actual comment mention delivery excludes project outsiders before storing private snippets", async () => {
  const marker = `Private comment ${crypto.randomUUID()}`;
  const result = await request("MEMBER", "POST", `/api/tasks/${assigned.id}/comments`, {
    body: `${marker} @[${users.PEER.id}] @[${users.OUTSIDER.id}] @[${users.FOREIGN.id}]`,
  });
  assert.equal(result.statusCode, 201, result.body);
  let rows = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    rows = await app.prisma.notification.findMany({ where: { body: { startsWith: marker } } });
    if (rows.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(rows.map((row) => row.userId), [users.PEER.id]);
});

test("resource ID collisions across tables cannot authorize a hidden comment through an accessible subtask", async () => {
  const hiddenTask = await app.prisma.task.findFirst({ where: { projectId: hidden.id } });
  const hiddenComment = await app.prisma.comment.create({ data: { id: subtask.id, taskId: hiddenTask.id, authorId: users.MEMBER.id, body: "Hidden comment collision" } });
  const result = await request("MEMBER", "PATCH", `/api/comments/${hiddenComment.id}`, { body: "Unauthorized" });
  assert.equal(result.statusCode, 403, result.body);
  assert.equal((await app.prisma.comment.findUnique({ where: { id: hiddenComment.id } })).body, "Hidden comment collision");
});

test("resource ID collisions cannot authorize a hidden subtask through an accessible comment", async () => {
  const hiddenTask = await app.prisma.task.findFirst({ where: { projectId: hidden.id } });
  const target = await app.prisma.subtask.create({ data: { id: comment.id, taskId: hiddenTask.id, title: "Hidden subtask collision" } });
  const result = await request("MEMBER", "PATCH", `/api/subtasks/${target.id}`, { title: "Unauthorized" });
  assert.equal(result.statusCode, 403, result.body);
  assert.equal((await app.prisma.subtask.findUnique({ where: { id: target.id } })).title, "Hidden subtask collision");
});

test("mixed parent URLs cannot select a task from another project", async () => {
  const hiddenTask = await app.prisma.task.findFirst({ where: { projectId: hidden.id } });
  const initial = await snapshot(); events.length = 0;
  const result = await request("MEMBER", "PUT", `/api/projects/${project.id}/tasks/${hiddenTask.id}/custom-fields/${field.id}`, { value: "Denied" });
  assert.equal(result.statusCode, 404, result.body);
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("stale project membership cannot authorize a removed workspace member", async () => {
  await app.prisma.projectMember.create({ data: { projectId: project.id, userId: users.OUTSIDER.id } });
  const member = await app.prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId: users.OUTSIDER.id, workspaceId: workspace.id } } });
  await app.prisma.workspaceMember.delete({ where: { id: member.id } });
  try {
    assert.equal((await request("OUTSIDER", "GET", `/api/tasks/${assigned.id}`)).statusCode, 403);
    const { ws } = await connect("OUTSIDER");
    assert.equal(await realtime.subscribe(ws, project.id, app.prisma), false);
  } finally {
    await app.prisma.workspaceMember.create({ data: { userId: users.OUTSIDER.id, workspaceId: workspace.id, role: "MEMBER" } });
    await app.prisma.projectMember.delete({ where: { projectId_userId: { projectId: project.id, userId: users.OUTSIDER.id } } });
  }
});

test("project removal invalidates a subscription whose authorization result is already in flight", async () => {
  const { ws, messages } = await connect("PEER");
  let releaseAuthorization, authorizationRead;
  const ready = new Promise((resolve) => { authorizationRead = resolve; });
  const gate = new Promise((resolve) => { releaseAuthorization = resolve; });
  // Use the real database result, then hold its delivery while removal commits.
  const delayedPrisma = { project: { async findUnique(args) {
    const result = await app.prisma.project.findUnique(args);
    authorizationRead();
    await gate;
    return result;
  } } };
  const pending = realtime.subscribe(ws, project.id, delayedPrisma);
  try {
    await ready;
    const removed = await request("ADMIN", "DELETE", `/api/projects/${project.id}/members/${users.PEER.id}`);
    assert.equal(removed.statusCode, 204, removed.body);
    releaseAuthorization();
    assert.equal(await pending, false);
    realtime.broadcast(project.id, "task_updated", { taskId: assigned.id });
    assert.deepEqual(messages, []);
  } finally {
    releaseAuthorization();
    await pending;
    await app.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: users.PEER.id } },
      create: { projectId: project.id, userId: users.PEER.id }, update: {},
    });
  }
});

test("removing project membership revokes existing and new project subscriptions", async () => {
  const { ws, messages } = await connect("PEER");
  assert.equal(await realtime.subscribe(ws, project.id, app.prisma), true);
  const response = await request("ADMIN", "DELETE", `/api/projects/${project.id}/members/${users.PEER.id}`);
  assert.equal(response.statusCode, 204, response.body);
  realtime.broadcast(project.id, "task_updated", { taskId: assigned.id });
  assert.deepEqual(messages, []);
  assert.equal(await realtime.subscribe(ws, project.id, app.prisma), false);
  assert.equal((await request("PEER", "GET", `/api/tasks/${assigned.id}`)).statusCode, 403);
});
