import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "reference-integrity-signing-secret", COOKIE_SECRET: "reference-integrity-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-reference-integrity-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

// W holds the project under test (P) and a sibling project (Q); F is another tenant.
let app, W, F, P, Q, R, status = {}, label = {}, field = {}, task = {}, subtask, template, entry;
const users = {}, tokens = {}, events = [];
let requests = 0;
const SECRET = "Q-secret";

const req = (actor, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` },
  remoteAddress: `10.81.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
});

async function snapshot() {
  const workspaceIds = [W.id, F.id];
  const inScope = { project: { workspaceId: { in: workspaceIds } } };
  const byTask = { task: inScope };
  const order = { orderBy: { id: "asc" } };
  return Promise.all([
    app.prisma.task.findMany({ where: inScope, ...order }),
    app.prisma.statusColumn.findMany({ where: inScope, ...order }),
    app.prisma.label.findMany({ where: inScope, ...order }),
    app.prisma.taskAssignee.findMany({ where: byTask, ...order }),
    app.prisma.taskLabel.findMany({ where: byTask, ...order }),
    app.prisma.subtask.findMany({ where: byTask, ...order }),
    app.prisma.customFieldValue.findMany({ where: byTask, ...order }),
    app.prisma.taskDependency.findMany({ where: { blockedTask: inScope }, ...order }),
    app.prisma.activityLog.findMany({ where: byTask, ...order }),
    app.prisma.taskTemplate.findMany({ where: inScope, ...order }),
    app.prisma.timeEntry.findMany({ where: { workspaceId: { in: workspaceIds } }, ...order }),
    app.prisma.userRate.findMany({ where: { workspaceId: { in: workspaceIds } }, ...order }),
    app.prisma.notification.findMany({ where: { userId: { in: Object.values(users).map((u) => u.id) } }, ...order }),
  ]);
}

/** Earlier successful requests send assignment notifications without awaiting them. */
async function settleNotifications() {
  const where = { userId: { in: Object.values(users).map((u) => u.id) } };
  let previous = -1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const current = await app.prisma.notification.count({ where });
    if (current === previous) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Every request must be rejected with one of `codes`, with no row changed and no event sent. */
async function assertRejectedAtomically(cases, codes = [400]) {
  await settleNotifications();
  const initial = await snapshot();
  events.length = 0;
  for (const [actor, method, url, payload] of cases) {
    const response = await req(actor, method, url, payload);
    assert(codes.includes(response.statusCode), `${actor} ${method} ${url} ${JSON.stringify(payload)} -> ${response.statusCode}: ${response.body}`);
    assert(!response.body.includes(SECRET), response.body);
  }
  assert.deepEqual(await snapshot(), initial);
  assert.deepEqual(events, []);
}

before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID().slice(0, 20);
  // SIBLING belongs to W but not to P; STALE keeps a P project row after leaving W.
  for (const actor of ["ADMIN", "MEMBER", "PEER", "SIBLING", "STALE", "FOREIGN"]) {
    users[actor] = await app.prisma.user.create({ data: { email: `refs-${actor}-${suffix}@example.test`, displayName: `${actor} user`, emailVerified: true } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  }
  W = await app.prisma.workspace.create({ data: { name: "Reference workspace", slug: `refs-${suffix}`, members: { create: [
    { userId: users.ADMIN.id, role: "ADMIN" }, { userId: users.MEMBER.id, role: "MEMBER" },
    { userId: users.PEER.id, role: "MEMBER" }, { userId: users.SIBLING.id, role: "MEMBER" },
  ] } } });
  F = await app.prisma.workspace.create({ data: { name: "Foreign workspace", slug: `refs-foreign-${suffix}`, members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } } } });
  P = await app.prisma.project.create({ data: { workspaceId: W.id, name: "Project P", members: { create: ["MEMBER", "PEER", "STALE"].map((a) => ({ userId: users[a].id })) } } });
  Q = await app.prisma.project.create({ data: { workspaceId: W.id, name: `${SECRET} project`, members: { create: { userId: users.SIBLING.id } } } });
  R = await app.prisma.project.create({ data: { workspaceId: F.id, name: "Foreign project", members: { create: { userId: users.FOREIGN.id } } } });
  for (const [key, projectId, name, position, isCompletion] of [
    ["P", P.id, "Open", 0, false], ["P2", P.id, "Doing", 1, false], ["P3", P.id, "Spare", 2, false],
    ["Pdone", P.id, "Done", 3, true], ["Q", Q.id, `${SECRET} status`, 0, false], ["R", R.id, "Foreign status", 0, false],
  ]) status[key] = await app.prisma.statusColumn.create({ data: { projectId, name, position, isCompletion } });
  for (const [key, projectId, name] of [["P", P.id, "Bug"], ["P2", P.id, "Feature"], ["Q", Q.id, `${SECRET} label`], ["R", R.id, "Foreign label"]]) {
    label[key] = await app.prisma.label.create({ data: { projectId, name } });
  }
  for (const [key, projectId, name] of [["P", P.id, "Estimate"], ["Q", Q.id, `${SECRET} field`], ["R", R.id, "Foreign field"]]) {
    field[key] = await app.prisma.customField.create({ data: { projectId, name, type: "TEXT" } });
  }
  const makeTask = (projectId, statusId, title, position, assignees = []) => app.prisma.task.create({ data: {
    projectId, statusId, title, position, assignees: { create: assignees.map((a) => ({ userId: users[a].id })) },
  } });
  task.P = await makeTask(P.id, status.P.id, "Assigned P task", 0, ["MEMBER"]);
  task.P2 = await makeTask(P.id, status.P.id, "Second P task", 1);
  task.Q = await makeTask(Q.id, status.Q.id, `${SECRET} task`, 0);
  task.R = await makeTask(R.id, status.R.id, "Foreign task", 0);
  subtask = await app.prisma.subtask.create({ data: { taskId: task.P.id, title: "P subtask" } });
  template = await app.prisma.taskTemplate.create({ data: { projectId: P.id, name: "P template", title: "From template" } });
  entry = await app.prisma.timeEntry.create({ data: { workspaceId: W.id, userId: users.ADMIN.id, date: "2026-10-20", hours: 1, taskId: task.P.id, projectId: P.id } });
});

after(async () => {
  try {
    if (app) {
      const ids = [W?.id, F?.id].filter(Boolean);
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: ids } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

const foreignAssignees = () => [[users.SIBLING.id], [users.FOREIGN.id], [users.STALE.id], ["missing-user"], [users.MEMBER.id, users.MEMBER.id], [users.MEMBER.id, users.FOREIGN.id]];
const foreignLabels = () => [[label.Q.id], [label.R.id], ["missing-label"], [label.P.id, label.P.id], [label.P.id, label.Q.id]];
const foreignStatuses = () => [status.Q.id, status.R.id, "missing-status"];

test("task creation rejects every foreign, cross-project, missing or duplicate reference atomically", async () => {
  const payloads = [
    ...foreignStatuses().map((statusId) => ({ statusId })),
    ...foreignLabels().map((labelIds) => ({ labelIds })),
    ...foreignAssignees().map((assigneeIds) => ({ assigneeIds })),
    { statusId: status.P2.id, labelIds: [label.P.id], assigneeIds: [users.PEER.id, users.SIBLING.id] },
    { statusId: status.P2.id, labelIds: [label.P.id, label.R.id], assigneeIds: [users.PEER.id] },
    { statusId: status.Q.id, labelIds: [label.P.id], assigneeIds: [users.PEER.id] },
  ];
  await assertRejectedAtomically(["ADMIN", "MEMBER"].flatMap((actor) => payloads.map((payload) =>
    [actor, "POST", `/api/projects/${P.id}/tasks`, { title: "Rejected", ...payload }])));

  const created = await req("ADMIN", "POST", `/api/projects/${P.id}/tasks`, {
    title: "Valid references", statusId: status.P2.id, labelIds: [label.P.id, label.P2.id],
    assigneeIds: [users.MEMBER.id, users.PEER.id, users.ADMIN.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json().data;
  assert.equal(body.status.id, status.P2.id);
  assert.deepEqual(body.labels.map((l) => l.labelId).sort(), [label.P.id, label.P2.id].sort());
  assert.deepEqual(body.assignees.map((a) => a.userId).sort(), [users.MEMBER.id, users.PEER.id, users.ADMIN.id].sort());
  // A MEMBER is still added to their own task, also when listing themselves explicitly.
  for (const assigneeIds of [[users.PEER.id], [users.MEMBER.id]]) {
    const own = await req("MEMBER", "POST", `/api/projects/${P.id}/tasks`, { title: "Member task", assigneeIds });
    assert.equal(own.statusCode, 201, own.body);
    assert(own.json().data.assignees.some((a) => a.userId === users.MEMBER.id));
    assert.equal(own.json().data.status.id, status.P.id);
  }
});

test("bulk update validates every task, status, label and assignee before writing anything", async () => {
  const url = `/api/projects/${P.id}/tasks/bulk-update`;
  const taskIds = [task.P.id, task.P2.id];
  const payloads = [
    ...foreignStatuses().map((statusId) => ({ taskIds, priority: "URGENT", statusId })),
    ...foreignLabels().map((labelIds) => ({ taskIds, priority: "URGENT", labelIds })),
    ...foreignAssignees().map((assigneeIds) => ({ taskIds, priority: "URGENT", assigneeIds })),
    { taskIds: [task.P.id, task.P.id], priority: "URGENT" },
    { taskIds: [task.P.id, task.Q.id], priority: "URGENT" },
    { taskIds: [task.P.id, task.R.id], priority: "URGENT" },
    { taskIds, priority: "URGENT", statusId: status.P2.id, labelIds: [label.P.id], assigneeIds: [users.ADMIN.id, users.FOREIGN.id] },
  ];
  await assertRejectedAtomically(payloads.map((payload) => ["ADMIN", "POST", url, payload]));

  const valid = await req("ADMIN", "POST", url, { taskIds, priority: "HIGH", statusId: status.P2.id, labelIds: [label.P2.id], assigneeIds: [users.MEMBER.id, users.PEER.id] });
  assert.equal(valid.statusCode, 200, valid.body);
  const rows = await app.prisma.task.findMany({ where: { id: { in: taskIds } }, include: { labels: true, assignees: true } });
  for (const row of rows) {
    assert.equal(row.priority, "HIGH"); assert.equal(row.statusId, status.P2.id);
    assert.deepEqual(row.labels.map((l) => l.labelId), [label.P2.id]);
    assert.deepEqual(row.assignees.map((a) => a.userId).sort(), [users.MEMBER.id, users.PEER.id].sort());
  }
});

test("single-task status, assignee, label and dependency writers stay inside the task project", async () => {
  await assertRejectedAtomically([
    ...foreignStatuses().map((statusId) => ["ADMIN", "PATCH", `/api/tasks/${task.P.id}`, { title: "Changed", statusId }]),
    ...foreignStatuses().map((statusId) => ["ADMIN", "PATCH", `/api/tasks/${task.P.id}/move`, { statusId, position: 0 }]),
    ...[users.SIBLING.id, users.FOREIGN.id, users.STALE.id, "missing-user"].map((userId) => ["ADMIN", "POST", `/api/tasks/${task.P.id}/assignees`, { userId }]),
    ...[label.Q.id, label.R.id].map((labelId) => ["ADMIN", "POST", `/api/tasks/${task.P.id}/labels`, { labelId }]),
    ...[task.Q.id, task.R.id, "missing-task"].map((blockingTaskId) => ["ADMIN", "POST", `/api/tasks/${task.P.id}/dependencies`, { blockingTaskId }]),
  ], [400, 404]);
  const assign = await req("ADMIN", "POST", `/api/tasks/${task.P2.id}/assignees`, { userId: users.ADMIN.id });
  assert.equal(assign.statusCode, 201, assign.body);
  const dependency = await req("ADMIN", "POST", `/api/tasks/${task.P.id}/dependencies`, { blockingTaskId: task.P2.id });
  assert.equal(dependency.statusCode, 201, dependency.body);
  await app.prisma.taskDependency.delete({ where: { id: dependency.json().data.id } });
});

test("subtask assignees must be current members with access to the task project", async () => {
  await assertRejectedAtomically([
    ...[users.SIBLING.id, users.FOREIGN.id, users.STALE.id, "missing-user", ""].flatMap((assigneeId) => [
      ["ADMIN", "POST", `/api/tasks/${task.P.id}/subtasks`, { title: "Rejected", assigneeId }],
      ["MEMBER", "POST", `/api/tasks/${task.P.id}/subtasks`, { title: "Rejected", assigneeId }],
      ["ADMIN", "PATCH", `/api/subtasks/${subtask.id}`, { title: "Rejected", assigneeId }],
    ]),
  ]);
  const created = await req("MEMBER", "POST", `/api/tasks/${task.P.id}/subtasks`, { title: "Peer subtask", assigneeId: users.PEER.id });
  assert.equal(created.statusCode, 201, created.body);
  for (const assigneeId of [users.ADMIN.id, null]) {
    const updated = await req("ADMIN", "PATCH", `/api/subtasks/${subtask.id}`, { assigneeId });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.assigneeId, assigneeId);
  }
});

test("custom-field values bind task and field to the authorized project", async () => {
  await assertRejectedAtomically([
    ["ADMIN", "PUT", `/api/projects/${P.id}/tasks/${task.P.id}/custom-fields/${field.Q.id}`, { value: "x" }],
    ["ADMIN", "PUT", `/api/projects/${P.id}/tasks/${task.P.id}/custom-fields/${field.R.id}`, { value: "x" }],
    ["ADMIN", "PUT", `/api/projects/${P.id}/tasks/${task.Q.id}/custom-fields/${field.P.id}`, { value: "x" }],
    ["ADMIN", "PUT", `/api/projects/${Q.id}/tasks/${task.P.id}/custom-fields/${field.Q.id}`, { value: "x" }],
  ], [404]);
  const valid = await req("ADMIN", "PUT", `/api/projects/${P.id}/tasks/${task.P.id}/custom-fields/${field.P.id}`, { value: "3d" });
  assert.equal(valid.statusCode, 200, valid.body);
});

test("templates validate stored references and explicit instantiation overrides", async () => {
  const base = { name: "Rejected template", title: "Rejected" };
  const templateUrl = `/api/projects/${P.id}/templates`;
  const references = [
    ...foreignStatuses().map((statusId) => ({ statusId })),
    ...foreignLabels().map((labelIds) => ({ labelIds })),
    ...foreignAssignees().map((assigneeIds) => ({ assigneeIds })),
  ];
  await assertRejectedAtomically([
    ...references.map((payload) => ["MEMBER", "POST", templateUrl, { ...base, ...payload }]),
    ...references.map((payload) => ["ADMIN", "PATCH", `${templateUrl}/${template.id}`, payload]),
    ...foreignStatuses().map((statusId) => ["ADMIN", "POST", `${templateUrl}/${template.id}/create-task`, { statusId }]),
    ...foreignAssignees().map((assigneeIds) => ["MEMBER", "POST", `${templateUrl}/${template.id}/create-task`, { assigneeIds }]),
  ]);

  const created = await req("MEMBER", "POST", templateUrl, {
    name: "Valid template", title: "Templated", statusId: status.P2.id, labelIds: [label.P.id], assigneeIds: [users.PEER.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  const patched = await req("ADMIN", "PATCH", `${templateUrl}/${created.json().data.id}`, { statusId: null, labelIds: [label.P2.id], assigneeIds: [users.ADMIN.id] });
  assert.equal(patched.statusCode, 200, patched.body);
  const instance = await req("ADMIN", "POST", `${templateUrl}/${created.json().data.id}/create-task`, { statusId: status.P2.id, assigneeIds: [users.PEER.id] });
  assert.equal(instance.statusCode, 201, instance.body);
  assert.equal(instance.json().data.status.id, status.P2.id);
  assert.deepEqual(instance.json().data.assignees.map((a) => a.userId), [users.PEER.id]);
  assert.deepEqual(instance.json().data.labels.map((l) => l.labelId), [label.P2.id]);

  // Values stored before validation (or since deleted) are dropped rather than copied.
  // ADMIN has no project-member row but can access P, so it remains a valid assignee.
  const legacy = await app.prisma.taskTemplate.create({ data: {
    projectId: P.id, name: "Legacy template", title: "Legacy", statusId: status.Q.id,
    labelIds: [label.P.id, label.Q.id, label.R.id, label.P.id],
    assigneeIds: [users.MEMBER.id, users.SIBLING.id, users.FOREIGN.id, users.STALE.id, users.ADMIN.id, users.MEMBER.id],
  } });
  const valid = { statusId: null, labelIds: [label.P.id], assigneeIds: [users.MEMBER.id, users.ADMIN.id] };
  const listed = await req("MEMBER", "GET", templateUrl);
  assert.equal(listed.statusCode, 200, listed.body);
  const single = await req("MEMBER", "GET", `${templateUrl}/${legacy.id}`);
  assert.equal(single.statusCode, 200, single.body);
  for (const view of [listed.json().data.find((t) => t.id === legacy.id), single.json().data]) {
    assert.deepEqual({ statusId: view.statusId, labelIds: view.labelIds, assigneeIds: view.assigneeIds }, valid);
  }
  const fromLegacy = await req("ADMIN", "POST", `${templateUrl}/${legacy.id}/create-task`, {});
  assert.equal(fromLegacy.statusCode, 201, fromLegacy.body);
  assert(!fromLegacy.body.includes(SECRET), fromLegacy.body);
  const legacyTask = fromLegacy.json().data;
  assert.equal(legacyTask.status.id, status.P.id);
  assert.deepEqual(legacyTask.labels.map((l) => l.labelId), [label.P.id]);
  assert.deepEqual(legacyTask.assignees.map((a) => a.userId), [users.MEMBER.id, users.ADMIN.id]);
  // An editor round trip resubmits exactly what it was shown and keeps every valid reference.
  const resaved = await req("MEMBER", "PATCH", `${templateUrl}/${legacy.id}`, { name: "Legacy template saved", ...valid });
  assert.equal(resaved.statusCode, 200, resaved.body);
  const stored = await app.prisma.taskTemplate.findUnique({ where: { id: legacy.id } });
  assert.deepEqual({ statusId: stored.statusId, labelIds: stored.labelIds, assigneeIds: stored.assigneeIds }, valid);
});

test("time entries reject foreign references and task/project mismatches", async () => {
  const url = `/api/workspaces/${W.id}/time/entries`;
  const day = { date: "2026-10-21", hours: 1 };
  await assertRejectedAtomically([
    ["ADMIN", "POST", url, { ...day, taskId: task.P.id, projectId: Q.id }],
    ["ADMIN", "POST", url, { ...day, taskId: task.Q.id, projectId: P.id }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { projectId: Q.id }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { projectId: null }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { taskId: task.Q.id, projectId: P.id }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { taskId: task.P2.id, projectId: Q.id }],
  ]);
  await assertRejectedAtomically([
    ["ADMIN", "POST", url, { ...day, taskId: task.R.id }],
    ["ADMIN", "POST", url, { ...day, projectId: R.id }],
    ["ADMIN", "POST", url, { ...day, taskId: "missing-task" }],
    ["ADMIN", "POST", url, { ...day, taskId: "" }],
    ["ADMIN", "POST", url, { ...day, projectId: "" }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { taskId: "" }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { taskId: task.R.id }],
    ["ADMIN", "PATCH", `/api/time/entries/${entry.id}`, { projectId: R.id }],
  ], [403, 404]);

  for (const payload of [{ taskId: task.P.id, projectId: P.id }, { taskId: task.P.id }, { projectId: Q.id }]) {
    const created = await req("ADMIN", "POST", url, { ...day, ...payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.projectId, payload.projectId ?? P.id);
  }
  for (const [payload, projectId, taskId] of [
    [{ taskId: task.P2.id }, P.id, task.P2.id],
    [{ taskId: task.Q.id }, Q.id, task.Q.id],
    [{ taskId: task.P.id, projectId: P.id }, P.id, task.P.id],
    [{ taskId: null }, P.id, null],
    [{ projectId: Q.id }, Q.id, null],
    [{ hours: 2 }, Q.id, null],
  ]) {
    const updated = await req("ADMIN", "PATCH", `/api/time/entries/${entry.id}`, payload);
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.projectId, projectId);
    assert.equal(updated.json().data.taskId, taskId);
  }
});

test("rates can only be set for current workspace members", async () => {
  await assertRejectedAtomically([
    ["ADMIN", "POST", `/api/workspaces/${W.id}/time/rates/${users.FOREIGN.id}`, { rate: 10 }],
    ["ADMIN", "POST", `/api/workspaces/${W.id}/time/rates/${users.STALE.id}`, { rate: 10 }],
    ["ADMIN", "POST", `/api/workspaces/${W.id}/time/rates/missing-user`, { rate: 10 }],
  ], [404]);
  const valid = await req("ADMIN", "POST", `/api/workspaces/${W.id}/time/rates/${users.SIBLING.id}`, { rate: 10 });
  assert.equal(valid.statusCode, 200, valid.body);
});

test("legacy cross-project links are neither exposed nor copied", async () => {
  // Rows written before reference validation existed: P task pointing into Q.
  const corrupt = await app.prisma.task.create({ data: {
    projectId: P.id, statusId: status.Q.id, title: "Corrupted P task", position: 9,
    assignees: { create: [{ userId: users.ADMIN.id }, { userId: users.FOREIGN.id }] },
    labels: { create: [{ labelId: label.P.id }, { labelId: label.Q.id }] },
    customFieldValues: { create: [{ fieldId: field.P.id, value: "visible" }, { fieldId: field.Q.id, value: `${SECRET} value` }] },
    subtasks: { create: [{ title: "Copied subtask", assigneeId: users.FOREIGN.id }] },
  } });
  const sameProject = await app.prisma.task.create({ data: { projectId: P.id, statusId: status.Q.id, title: "Same-project blocker", position: 10 } });
  await app.prisma.taskDependency.createMany({ data: [
    { blockedTaskId: corrupt.id, blockingTaskId: task.Q.id },
    { blockedTaskId: task.Q.id, blockingTaskId: corrupt.id },
    { blockedTaskId: corrupt.id, blockingTaskId: sameProject.id },
  ] });

  const reads = [
    `/api/tasks/${corrupt.id}`,
    `/api/projects/${P.id}/tasks?limit=100`,
    `/api/projects/${P.id}/tasks?view=board`,
    `/api/workspaces/${W.id}/my-tasks`,
    `/api/workspaces/${W.id}/search?q=Corrupted`,
  ];
  for (const url of reads) {
    const response = await req("ADMIN", "GET", url);
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert(!response.body.includes(SECRET), `${url}: ${response.body}`);
    assert(response.body.includes("Corrupted P task"), url);
  }
  const detail = (await req("ADMIN", "GET", `/api/tasks/${corrupt.id}`)).json().data;
  assert.equal(detail.status.projectId, P.id);
  assert.equal(detail.status.id, status.Q.id);
  assert.deepEqual(detail.labels.map((l) => l.labelId), [label.P.id]);
  assert.deepEqual(detail.customFieldValues.map((v) => v.fieldId), [field.P.id]);
  assert.deepEqual(detail.blockedBy.map((d) => d.blockingTaskId), [sameProject.id]);
  assert.deepEqual(detail.blocking, []);
  const listed = (await req("ADMIN", "GET", `/api/projects/${P.id}/tasks?limit=100`)).json().data.find((t) => t.id === corrupt.id);
  assert.equal(listed._count.blockedBy, 1);

  const edited = await req("ADMIN", "PATCH", `/api/tasks/${corrupt.id}`, { title: "Corrupted P task edited" });
  assert.equal(edited.statusCode, 200, edited.body);
  assert(!edited.body.includes(SECRET), edited.body);
  const moved = await req("ADMIN", "PATCH", `/api/tasks/${corrupt.id}/move`, { statusId: status.Pdone.id, position: 0 });
  assert.equal(moved.statusCode, 200, moved.body);
  assert(!moved.body.includes(SECRET), moved.body);
  await app.prisma.task.update({ where: { id: corrupt.id }, data: { statusId: status.Q.id } });

  const copy = await req("ADMIN", "POST", `/api/tasks/${corrupt.id}/duplicate`);
  assert.equal(copy.statusCode, 201, copy.body);
  assert(!copy.body.includes(SECRET), copy.body);
  const copied = await app.prisma.task.findUnique({ where: { id: copy.json().data.id }, include: { labels: true, assignees: true, subtasks: true } });
  assert.equal(copied.statusId, status.P.id);
  assert.deepEqual(copied.labels.map((l) => l.labelId), [label.P.id]);
  assert.deepEqual(copied.assignees.map((a) => a.userId), [users.ADMIN.id]);
  assert.deepEqual(copied.subtasks.map((s) => s.assigneeId), [null]);
});

test("deleting a status never relinks another project's task", async () => {
  const intruder = await app.prisma.task.create({ data: { projectId: Q.id, statusId: status.P3.id, title: `${SECRET} intruder` } });
  await assertRejectedAtomically([["ADMIN", "DELETE", `/api/projects/${P.id}/statuses/${status.P3.id}`]], [409]);
  await app.prisma.task.delete({ where: { id: intruder.id } });
  const deleted = await req("ADMIN", "DELETE", `/api/projects/${P.id}/statuses/${status.P3.id}`);
  assert.equal(deleted.statusCode, 204, deleted.body);
});

test("the integrity report finds legacy relationships without writing", async () => {
  const { findReferenceIntegrityIssues } = await import("../../src/scripts/reference-integrity-report.js");
  const legacy = await app.prisma.task.create({ data: {
    projectId: P.id, statusId: status.Q.id, title: "Report target", position: 20,
    assignees: { create: [{ userId: users.FOREIGN.id }, { userId: users.SIBLING.id }] },
    labels: { create: { labelId: label.R.id } },
    customFieldValues: { create: { fieldId: field.Q.id, value: 1 } },
    subtasks: { create: { title: "Foreign subtask", assigneeId: users.STALE.id } },
  } });
  const dependency = await app.prisma.taskDependency.create({ data: { blockedTaskId: legacy.id, blockingTaskId: task.R.id } });
  const mismatched = await app.prisma.timeEntry.create({ data: { workspaceId: W.id, userId: users.ADMIN.id, date: "2026-10-22", hours: 1, taskId: task.P.id, projectId: Q.id } });
  const foreignEntry = await app.prisma.timeEntry.create({ data: { workspaceId: W.id, userId: users.ADMIN.id, date: "2026-10-22", hours: 1, taskId: task.R.id, projectId: R.id } });
  const rate = await app.prisma.userRate.create({ data: { workspaceId: W.id, userId: users.FOREIGN.id, rate: 1, effectiveFrom: "2026-01-01" } });
  const badTemplate = await app.prisma.taskTemplate.create({ data: { projectId: P.id, name: "Bad template", title: "Bad", statusId: status.R.id, labelIds: [label.Q.id], assigneeIds: [users.FOREIGN.id] } });
  const before = await snapshot();
  const report = await findReferenceIntegrityIssues(app.prisma, { sampleLimit: 1000 });
  assert.deepEqual(await snapshot(), before);

  const samples = (key) => report.issues.find((issue) => issue.key === key)?.samples ?? [];
  const ids = (key) => samples(key).map((s) => s.id);
  const forLegacy = (key) => samples(key).filter((s) => s.taskId === legacy.id);
  assert(ids("task_status_project").includes(legacy.id));
  assert.deepEqual(forLegacy("task_label_project").map((s) => s.referenceId), [label.R.id]);
  assert.deepEqual(forLegacy("custom_field_value_project").map((s) => s.referenceId), [field.Q.id]);
  assert(ids("task_dependency_project").includes(dependency.id));
  assert.deepEqual(forLegacy("task_assignee_access").map((s) => `${s.referenceId}:${s.reason}`).sort(), [
    `${users.FOREIGN.id}:not_workspace_member`, `${users.SIBLING.id}:no_project_access`,
  ].sort());
  assert.deepEqual(forLegacy("subtask_assignee_access").map((s) => s.reason), ["not_workspace_member"]);
  assert(ids("time_entry_task_project").includes(mismatched.id));
  assert(ids("time_entry_workspace").includes(foreignEntry.id));
  assert(ids("user_rate_workspace").includes(rate.id));
  assert(ids("task_template_reference").includes(badTemplate.id));
  for (const issue of report.issues) {
    assert.equal(typeof issue.repair, "string");
    assert.equal(issue.count >= issue.samples.length, true);
  }
  assert(!JSON.stringify(report).includes(SECRET));
});
