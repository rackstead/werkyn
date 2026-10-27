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
process.env.JWT_SECRET = "task-edit-integration-secret";
process.env.COOKIE_SECRET = "task-edit-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-task-edit-policy-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const taskService = await import("../../src/modules/tasks/tasks.service.js");
const subtaskService = await import("../../src/modules/subtasks/subtasks.service.js");
const fieldService = await import("../../src/modules/custom-fields/custom-fields.service.js");
let app, workspace, foreignWorkspace, project, hidden, assigned, unassigned, blocking, subtask, comment, field, label, status;
const users = {}, tokens = {}, events = [];
let requests = 0;

function request(actor, method, url, payload) {
  return app.inject({ method, url, payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.40.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

async function snapshot() {
  return Promise.all([
    app.prisma.task.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } }),
    app.prisma.taskAssignee.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.taskLabel.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.subtask.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.customFieldValue.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.activityLog.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.taskDependency.findMany({ where: { blockedTask: { projectId: project.id } }, orderBy: { id: "asc" } }),
    app.prisma.notification.findMany({ where: { userId: { in: Object.values(users).map((user) => user.id) } }, orderBy: { id: "asc" } }),
    app.prisma.comment.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }),
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
  try {
    if (app) {
      const ids = [workspace?.id, foreignWorkspace?.id].filter(Boolean);
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: ids } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test("unassigned members cannot edit via move, bulk, labels, dependencies, subtasks or custom fields", async () => {
  const initial = await snapshot(); events.length = 0;
  for (const [method, url, payload] of [
    ["PATCH", `/api/tasks/${unassigned.id}`, { title: "Denied" }],
    ["PATCH", `/api/tasks/${unassigned.id}/move`, { statusId: status.id, position: 0 }],
    ["POST", `/api/tasks/${unassigned.id}/labels`, { labelId: label.id }],
    ["DELETE", `/api/tasks/${unassigned.id}/labels/${label.id}`],
    ["POST", `/api/tasks/${unassigned.id}/dependencies`, { blockingTaskId: blocking.id }],
    ["POST", `/api/tasks/${unassigned.id}/subtasks`, { title: "Denied" }],
    ["PATCH", `/api/subtasks/${subtask.id}`, { title: "Denied" }],
    ["PATCH", `/api/subtasks/${subtask.id}/toggle`], ["DELETE", `/api/subtasks/${subtask.id}`],
    ["POST", `/api/tasks/${unassigned.id}/subtasks/reorder`, { orderedIds: [subtask.id] }],
    ["PUT", `/api/projects/${project.id}/tasks/${unassigned.id}/custom-fields/${field.id}`, { value: "Denied" }],
    ["POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [assigned.id, unassigned.id], priority: "URGENT" }],
  ]) {
    const response = await request("MEMBER", method, url, payload); assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
  }
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("bulk edits preserve administrator-only archive and other-user assignment policy", async () => {
  const initial = await snapshot();
  for (const changes of [{ archived: true }, { archived: false }, { assigneeIds: [users.MEMBER.id] }, { assigneeIds: [users.MEMBER.id, users.OUTSIDER.id] }]) {
    const response = await request("MEMBER", "POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [assigned.id], ...changes });
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.deepEqual(await snapshot(), initial);
  const allowed = await request("MEMBER", "POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [assigned.id], priority: "HIGH", assigneeIds: [users.MEMBER.id, users.PEER.id] });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("assigned MEMBER task/derived edits and unassigned ADMIN edits succeed", async () => {
  const ownSubtask = await app.prisma.subtask.create({ data: { taskId: assigned.id, title: "Own subtask" } });
  for (const [actor, method, url, payload, code] of [
    ["MEMBER", "PATCH", `/api/tasks/${assigned.id}`, { title: "Edited by assignee" }, 200],
    ["MEMBER", "PATCH", `/api/tasks/${assigned.id}/move`, { statusId: status.id, position: 0 }, 200],
    ["MEMBER", "POST", `/api/tasks/${assigned.id}/labels`, { labelId: label.id }, 201],
    ["MEMBER", "DELETE", `/api/tasks/${assigned.id}/labels/${label.id}`, undefined, 204],
    ["MEMBER", "PATCH", `/api/subtasks/${ownSubtask.id}/toggle`, undefined, 200],
    ["MEMBER", "PUT", `/api/projects/${project.id}/tasks/${assigned.id}/custom-fields/${field.id}`, { value: "Allowed" }, 200],
    ["ADMIN", "PATCH", `/api/tasks/${unassigned.id}`, { title: "Admin edit" }, 200],
  ]) { const r = await request(actor, method, url, payload); assert.equal(r.statusCode, code, `${url}: ${r.body}`); }
  const dependency = await request("MEMBER", "POST", `/api/tasks/${assigned.id}/dependencies`, { blockingTaskId: blocking.id });
  assert.equal(dependency.statusCode, 201, dependency.body);
  assert.equal((await request("MEMBER", "DELETE", `/api/tasks/${assigned.id}/dependencies/${dependency.json().data.id}`)).statusCode, 204);
});

test("member self-assignment and project discussion remain available", async () => {
  const assign = await request("MEMBER", "POST", `/api/tasks/${unassigned.id}/assignees`, { userId: users.MEMBER.id });
  assert.equal(assign.statusCode, 201, assign.body);
  assert.equal((await request("MEMBER", "PATCH", `/api/tasks/${unassigned.id}`, { priority: "LOW" })).statusCode, 200);
  assert.equal((await request("MEMBER", "DELETE", `/api/tasks/${unassigned.id}/assignees/${users.MEMBER.id}`)).statusCode, 204);
  assert.equal((await request("MEMBER", "POST", `/api/tasks/${unassigned.id}/comments`, { body: "Discussion without assignment" })).statusCode, 201);
  assert.equal((await request("VIEWER", "POST", `/api/tasks/${unassigned.id}/comments`, { body: "Denied" })).statusCode, 403);
});

test("service mutation entry points verify current database permission even with a forged caller role", async () => {
  const initial = await snapshot();
  await assert.rejects(taskService.updateTask(app.prisma, assigned.id, users.VIEWER.id, "ADMIN", { title: "Denied" }), /assigned to them/);
  await assert.rejects(taskService.moveTask(app.prisma, assigned.id, users.OUTSIDER.id, { statusId: status.id, position: 0 }), /member of this project/);
  await assert.rejects(taskService.archiveTask(app.prisma, assigned.id, { archived: true }, users.MEMBER.id), /Only administrators/);
  await assert.rejects(taskService.bulkDeleteTasks(app.prisma, project.id, [assigned.id], users.MEMBER.id), /Only administrators/);
  await assert.rejects(taskService.addAssignee(app.prisma, assigned.id, users.MEMBER.id, "ADMIN", { userId: users.OUTSIDER.id }), /only assign themselves/);
  await assert.rejects(taskService.removeAssignee(app.prisma, assigned.id, users.PEER.id, users.MEMBER.id, "ADMIN"), /only unassign themselves/);
  await assert.rejects(taskService.addAssignee(app.prisma, unassigned.id, users.OUTSIDER.id, "ADMIN", { userId: users.OUTSIDER.id }), /member of this project/);
  await assert.rejects(taskService.createTask(app.prisma, project.id, users.VIEWER.id, "ADMIN", { title: "Denied", priority: "NONE" }), /Insufficient permissions/);
  await assert.rejects(taskService.duplicateTask(app.prisma, assigned.id, users.VIEWER.id), /Insufficient permissions/);
  assert.deepEqual(await snapshot(), initial);
});

test("unassigned relation removals and custom-field clearing deny before deleting existing data", async () => {
  const dependency = await app.prisma.taskDependency.create({ data: { blockedTaskId: unassigned.id, blockingTaskId: blocking.id } });
  await app.prisma.taskLabel.create({ data: { taskId: unassigned.id, labelId: label.id } });
  await app.prisma.customFieldValue.create({ data: { taskId: unassigned.id, fieldId: field.id, value: "Preserved" } });
  const initial = await snapshot(); events.length = 0;
  for (const [method, url, payload] of [
    ["DELETE", `/api/tasks/${unassigned.id}/dependencies/${dependency.id}`],
    ["DELETE", `/api/tasks/${unassigned.id}/labels/${label.id}`],
    ["PUT", `/api/projects/${project.id}/tasks/${unassigned.id}/custom-fields/${field.id}`, { value: null }],
    ["POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [unassigned.id, assigned.id], priority: "URGENT", labelIds: [] }],
  ]) {
    const response = await request("MEMBER", method, url, payload);
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("viewer assignment and foreign ADMIN status do not grant task write permission", async () => {
  await app.prisma.taskAssignee.create({ data: { taskId: assigned.id, userId: users.VIEWER.id } });
  const initial = await snapshot(); events.length = 0;
  for (const actor of ["VIEWER", "OUTSIDER", "FOREIGN"]) {
    for (const [method, url, payload] of [
      ["PATCH", `/api/tasks/${assigned.id}`, { title: "Denied" }],
      ["PATCH", `/api/tasks/${assigned.id}/move`, { statusId: status.id, position: 0 }],
      ["POST", `/api/tasks/${assigned.id}/labels`, { labelId: label.id }],
      ["POST", `/api/tasks/${assigned.id}/dependencies`, { blockingTaskId: blocking.id }],
      ["POST", `/api/tasks/${assigned.id}/subtasks`, { title: "Denied" }],
      ["PUT", `/api/projects/${project.id}/tasks/${assigned.id}/custom-fields/${field.id}`, { value: "Denied" }],
      ["POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [assigned.id], priority: "URGENT" }],
      ["PATCH", `/api/tasks/${assigned.id}/archive`, { archived: true }],
      ["DELETE", `/api/tasks/${assigned.id}`],
    ]) {
      const response = await request(actor, method, url, payload);
      assert.equal(response.statusCode, 403, response.body);
    }
  }
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
  await app.prisma.taskAssignee.delete({ where: { taskId_userId: { taskId: assigned.id, userId: users.VIEWER.id } } });
});

test("derived service entry points enforce parent assignment without trusting their callers", async () => {
  const initial = await snapshot();
  for (const call of [
    () => taskService.deleteTask(app.prisma, assigned.id, users.MEMBER.id),
    () => taskService.addLabel(app.prisma, unassigned.id, { labelId: label.id }, users.MEMBER.id),
    () => taskService.removeLabel(app.prisma, unassigned.id, label.id, users.MEMBER.id, "ADMIN"),
    () => taskService.addDependency(app.prisma, unassigned.id, users.MEMBER.id, { blockingTaskId: assigned.id }),
    () => taskService.bulkUpdateTasks(app.prisma, project.id, users.VIEWER.id, { taskIds: [assigned.id], priority: "URGENT" }),
    () => subtaskService.createSubtask(app.prisma, unassigned.id, users.MEMBER.id, { title: "Denied" }),
    () => subtaskService.updateSubtask(app.prisma, subtask.id, users.MEMBER.id, { title: "Denied" }),
    () => subtaskService.toggleSubtask(app.prisma, subtask.id, users.MEMBER.id),
    () => subtaskService.reorderSubtasks(app.prisma, unassigned.id, [subtask.id], users.MEMBER.id),
    () => subtaskService.deleteSubtask(app.prisma, subtask.id, users.MEMBER.id),
    () => fieldService.setFieldValue(app.prisma, project.id, unassigned.id, field.id, { value: null }, users.MEMBER.id),
  ]) await assert.rejects(call, (error) => error.statusCode === 403);
  assert.deepEqual(await snapshot(), initial);
});

test("current database role wins over stale caller role for admin and demoted-member service calls", async () => {
  await taskService.updateTask(app.prisma, unassigned.id, users.ADMIN.id, "MEMBER", { title: "Current admin" });
  await taskService.addLabel(app.prisma, assigned.id, { labelId: label.id }, users.ADMIN.id);
  await taskService.removeLabel(app.prisma, assigned.id, label.id, users.ADMIN.id, "MEMBER");
  await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: users.PEER.id, workspaceId: workspace.id } }, data: { role: "VIEWER" } });
  try {
    const initial = await snapshot();
    await assert.rejects(() => taskService.updateTask(app.prisma, assigned.id, users.PEER.id, "ADMIN", { title: "Stale admin" }), (error) => error.statusCode === 403);
    await assert.rejects(() => taskService.addAssignee(app.prisma, unassigned.id, users.PEER.id, "ADMIN", { userId: users.PEER.id }), (error) => error.statusCode === 403);
    assert.deepEqual(await snapshot(), initial);
  } finally {
    await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: users.PEER.id, workspaceId: workspace.id } }, data: { role: "MEMBER" } });
  }
});

test("new-task creation and duplication preserve member workflows with current roles", async () => {
  const created = await taskService.createTask(app.prisma, project.id, users.MEMBER.id, "ADMIN", { title: "Member-created", priority: "NONE" });
  assert(created.assignees.some((row) => row.userId === users.MEMBER.id));
  const copied = await taskService.duplicateTask(app.prisma, unassigned.id, users.MEMBER.id);
  assert.equal(copied.projectId, project.id);
  for (const actor of ["VIEWER", "OUTSIDER", "FOREIGN"]) {
    const initial = await snapshot();
    await assert.rejects(() => taskService.createTask(app.prisma, project.id, users[actor].id, "ADMIN", { title: "Denied", priority: "NONE" }), (error) => error.statusCode === 403);
    await assert.rejects(() => taskService.duplicateTask(app.prisma, assigned.id, users[actor].id), (error) => error.statusCode === 403);
    assert.deepEqual(await snapshot(), initial);
  }
});

test("members can remove only their own bulk assignment and immediately lose later edit permission", async () => {
  const response = await request("MEMBER", "POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [assigned.id], assigneeIds: [users.PEER.id], priority: "LOW" });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual((await app.prisma.taskAssignee.findMany({ where: { taskId: assigned.id } })).map((row) => row.userId), [users.PEER.id]);
  const initial = await snapshot(); events.length = 0;
  assert.equal((await request("MEMBER", "PATCH", `/api/tasks/${assigned.id}`, { title: "Denied after removal" })).statusCode, 403);
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("admins retain bulk assignment/archive and direct/bulk delete authority", async () => {
  const target = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Admin target" } });
  const bulk = await request("ADMIN", "POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [target.id], assigneeIds: [users.PEER.id], archived: true });
  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.equal((await app.prisma.task.findUnique({ where: { id: target.id } })).archived, true);
  const unarchive = await request("ADMIN", "PATCH", `/api/tasks/${target.id}/archive`, { archived: false });
  assert.equal(unarchive.statusCode, 200, unarchive.body);
  const deleted = await request("ADMIN", "POST", `/api/projects/${project.id}/tasks/bulk-delete`, { taskIds: [target.id] });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(await app.prisma.task.findUnique({ where: { id: target.id } }), null);
  const direct = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Direct admin target" } });
  assert.equal((await request("ADMIN", "DELETE", `/api/tasks/${direct.id}`)).statusCode, 204);
});

for (const actor of ["MEMBER", "ADMIN"]) {
  test(`${actor}: permitted task and subtask operations persist their intended changes`, async () => {
    const target = await app.prisma.task.create({ data: {
      projectId: project.id, statusId: status.id, title: "Positive lifecycle",
      assignees: actor === "MEMBER" ? { create: { userId: users.MEMBER.id } } : undefined,
    } });
    const nextStatus = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: `Next ${actor}`, position: 1 } });
    const nextLabel = await app.prisma.label.create({ data: { projectId: project.id, name: `Next ${actor}`, color: "#123456" } });
    const moved = await request(actor, "PATCH", `/api/tasks/${target.id}/move`, { statusId: nextStatus.id, position: 0 });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await app.prisma.task.findUnique({ where: { id: target.id } })).statusId, nextStatus.id);
    const addedLabel = await request(actor, "POST", `/api/tasks/${target.id}/labels`, { labelId: nextLabel.id });
    assert.equal(addedLabel.statusCode, 201, addedLabel.body);
    assert.equal((await request(actor, "DELETE", `/api/tasks/${target.id}/labels/${nextLabel.id}`)).statusCode, 204);
    const dependency = await request(actor, "POST", `/api/tasks/${target.id}/dependencies`, { blockingTaskId: blocking.id });
    assert.equal(dependency.statusCode, 201, dependency.body);
    assert.equal((await request(actor, "DELETE", `/api/tasks/${target.id}/dependencies/${dependency.json().data.id}`)).statusCode, 204);
    const created = await request(actor, "POST", `/api/tasks/${target.id}/subtasks`, { title: "Created subtask" });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    assert.equal((await request(actor, "PATCH", `/api/subtasks/${id}`, { title: "Edited subtask" })).statusCode, 200);
    assert.equal((await request(actor, "PATCH", `/api/subtasks/${id}/toggle`)).statusCode, 200);
    assert.equal((await request(actor, "POST", `/api/tasks/${target.id}/subtasks/reorder`, { orderedIds: [id] })).statusCode, 200);
    const savedSubtask = await app.prisma.subtask.findUnique({ where: { id } });
    assert.equal(savedSubtask.title, "Edited subtask"); assert.equal(savedSubtask.completed, true);
    assert.equal((await request(actor, "DELETE", `/api/subtasks/${id}`)).statusCode, 204);
    assert.equal(await app.prisma.subtask.findUnique({ where: { id } }), null);
    const fieldUrl = `/api/projects/${project.id}/tasks/${target.id}/custom-fields/${field.id}`;
    assert.equal((await request(actor, "PUT", fieldUrl, { value: "Valid value" })).statusCode, 200);
    assert.equal((await request(actor, "PUT", fieldUrl, { value: null })).statusCode, 200);
    assert.equal(await app.prisma.customFieldValue.count({ where: { taskId: target.id, fieldId: field.id } }), 0);
    const bulk = await request(actor, "POST", `/api/projects/${project.id}/tasks/bulk-update`, {
      taskIds: [target.id], statusId: status.id, priority: "LOW", labelIds: [label.id], dueDate: "2026-10-28", startDate: "2026-10-27",
    });
    assert.equal(bulk.statusCode, 200, bulk.body);
    const saved = await app.prisma.task.findUnique({ where: { id: target.id }, include: { labels: true } });
    assert.equal(saved.statusId, status.id); assert.equal(saved.priority, "LOW");
    assert.equal(saved.dueDate, "2026-10-28"); assert.equal(saved.startDate, "2026-10-27");
    assert.deepEqual(saved.labels.map((row) => row.labelId), [label.id]);
  });
}
