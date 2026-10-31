import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

assert(process.env.TEST_DATABASE_URL, "An owned migrated disposable database is required");
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-admin-demotion-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "admin-demotion-jwt-secret",
  COOKIE_SECRET: "admin-demotion-cookie-secret",
  STORAGE_DIR: storage,
});
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { processRecurringTasks } = await import("../../src/schedulers/recurring-tasks.ts");
const userIds = [], workspaceIds = [], tokens = new Map();
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
assert.equal(Number(actorUrl.searchParams.get("connection_limit") ?? 5), 5, "Demotion fixtures use five app connections");
actorUrl.searchParams.set("connection_limit", "5");
process.env.DATABASE_URL = actorUrl.toString();
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "1");
let app, control, port, requests = 0;

before(async () => {
  control = new PrismaClient({ datasources: { db: { url: controlUrl.toString() } } });
  await control.$connect();
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});
after(async () => {
  try {
    if (app) {
      await app.prisma.notificationDelivery.deleteMany({ where: { recipientIds: { hasSome: userIds } } });
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    const closed = await Promise.allSettled([app?.close(), control?.$disconnect()]);
    for (const result of closed) if (result.status === "rejected") throw result.reason;
    await rm(storage, { recursive: true, force: true });
  }
});
function call(actor, method, url, body) {
  const n = ++requests;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port, path: `/api${url}`, method, agent: false,
      localAddress: `127.81.${Math.floor(n / 250) % 250}.${n % 250 + 1}`,
      headers: { authorization: `Bearer ${tokens.get(actor.id)}`,
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (part) => body += part);
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`${method} ${url} timed out`)));
    request.end(payload);
  });
}
async function fixture() {
  const suffix = crypto.randomBytes(5).toString("hex");
  const user = async (name) => {
    const result = await app.prisma.user.create({ data: { email: `adm-${name}-${suffix}@example.test`, displayName: name, emailVerified: true } });
    userIds.push(result.id);
    tokens.set(result.id, signAccessToken({ sub: result.id, email: result.email }));
    return result;
  };
  const actor = await user("actor"), target = await user("target"), other = await user("other");
  const makeWorkspace = async (name) => {
    const result = await app.prisma.workspace.create({ data: { name, slug: `adm-${name}-${suffix}`,
      members: { create: [{ userId: actor.id, role: "ADMIN" }, { userId: target.id, role: "ADMIN" }, { userId: other.id, role: "MEMBER" }] } } });
    workspaceIds.push(result.id);
    return result;
  };
  const workspace = await makeWorkspace("scope"), elsewhere = await makeWorkspace("elsewhere");
  const makeProject = async (workspaceId, name, retained) => {
    const project = await app.prisma.project.create({ data: { workspaceId, name,
      members: { create: [{ userId: actor.id }, { userId: other.id }, ...(retained ? [{ userId: target.id }] : [])] } } });
    const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
    const task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: name, position: 0,
      assignees: { create: [{ userId: target.id }, { userId: other.id }] },
      subtasks: { create: [{ title: "Target", assigneeId: target.id }, { title: "Other", assigneeId: other.id }] } } });
    return { project, task, status };
  };
  const lost = [await makeProject(workspace.id, "Lost one", false), await makeProject(workspace.id, "Lost two", false)];
  const retained = await makeProject(workspace.id, "Retained", true), foreign = await makeProject(elsewhere.id, "Other workspace", true);
  const slot = await app.prisma.task.create({ data: { projectId: lost[0].project.id, statusId: lost[0].status.id, title: "Unassigned target", position: 1 } });
  const subtask = await app.prisma.subtask.create({ data: { taskId: slot.id, title: "Unassigned subtask" } });
  const template = await app.prisma.taskTemplate.create({ data: { projectId: lost[0].project.id, name: "Demotion template", title: "Raced template", assigneeIds: [target.id] } });
  const heldAssignment = await app.prisma.taskAssignee.findUniqueOrThrow({ where: { taskId_userId: { taskId: lost[0].task.id, userId: target.id } } });
  return { actor, target, other, workspace, lost, retained, foreign, slot, subtask, template, heldAssignment };
}

for (const role of ["MEMBER", "VIEWER"]) {
  test(`ADMIN to ${role} clears only lost-access task and subtask assignments`, async () => {
    const f = await fixture();
    const response = await call(f.actor, "PATCH", `/workspaces/${f.workspace.id}/members/${f.target.id}`, { role });
    assert.equal(response.status, 200, response.body);
    const dto = JSON.parse(response.body).data;
    assert.equal(dto.role, role);
    assert.equal(dto.userId, f.target.id);
    assert.equal(dto.workspaceId, f.workspace.id);
    assert.deepEqual(Object.keys(dto.user).sort(), ["avatarUrl", "displayName", "email", "id"]);
    for (const p of f.lost) assert.equal((await call(f.target, "GET", `/projects/${p.project.id}`)).status, 403);
    assert.equal((await call(f.target, "GET", `/projects/${f.retained.project.id}`)).status, 200);
    const lostIds = f.lost.map((p) => p.project.id);
    const count = async (userId, projectIds) => ({
      tasks: await app.prisma.taskAssignee.count({ where: { userId, task: { projectId: { in: projectIds } } } }),
      subtasks: await app.prisma.subtask.count({ where: { assigneeId: userId, task: { projectId: { in: projectIds } } } }),
    });
    assert.deepEqual(await count(f.target.id, [f.retained.project.id, f.foreign.project.id]), { tasks: 2, subtasks: 2 });
    assert.deepEqual(await count(f.other.id, [...lostIds, f.retained.project.id, f.foreign.project.id]), { tasks: 4, subtasks: 4 });
    const stale = await count(f.target.id, lostIds);
    console.info(JSON.stringify({ role, responseStatus: response.status, lostProjectAccess: false, retainedProjectAccess: true, stale, preservedControls: true }));
    assert.deepEqual(stale, { tasks: 0, subtasks: 0 }, "demoted administrator remains assigned without project access");
  });
}

const demote = (f, role = "MEMBER") =>
  call(f.actor, "PATCH", `/workspaces/${f.workspace.id}/members/${f.target.id}`, { role });
const lockable = new Set(["User", "TaskAssignee", "Subtask", "Task", "Project", "ProjectMember"]);
function lockRow(table, id) {
  assert(lockable.has(table));
  return (tx) => tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
}
// The single control connection only holds the barrier. Observing through the
// five-connection app pool leaves three connections beside the two racers.
async function waiters() {
  return app.prisma.$queryRaw`
    SELECT pid, query, pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
}
async function until(predicate) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(10);
  }
  return null;
}
async function barrier(hold, work) {
  let ready, release, holderPid;
  const isReady = new Promise((resolve) => ready = resolve);
  const released = new Promise((resolve) => release = resolve);
  const holder = control.$transaction(async (tx) => {
    [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
    await hold(tx);
    ready();
    await released;
  }, { timeout: 20_000, maxWait: 5_000 });
  try {
    await Promise.race([isReady, holder.then(() => { throw new Error("Barrier ended before acquisition"); })]);
    return await work(holderPid);
  } finally {
    release();
    await holder;
  }
}
async function race(context, hold, first, second, expectedSecondStatement) {
  const pending = [];
  let observed, responses;
  await barrier(hold, async (holderPid) => {
    try {
      pending.push(first());
      const firstWaiter = await until(async () => (await waiters()).find((row) => row.blockers.includes(holderPid)));
      assert(firstWaiter, `${context}: first request never reached its PostgreSQL barrier`);
      let finished = false;
      pending.push(second().finally(() => finished = true));
      const secondWaiter = await until(async () => {
        if (finished) return null;
        return (await waiters()).find((row) => row.blockers.includes(firstWaiter.pid));
      });
      observed = { holderPid, firstWaiter, secondWaiter, secondFinishedBeforeRelease: finished };
    } catch (error) {
      // Release the holder before awaiting all requests, even on a failed fixture.
      observed = { error };
    }
  });
  responses = await Promise.all(pending);
  if (observed.error) throw observed.error;
  assert(observed.secondWaiter && !observed.secondFinishedBeforeRelease,
    `${context}: second request did not wait behind the first: ${JSON.stringify(observed)}`);
  assert.match(observed.secondWaiter.query, expectedSecondStatement, `${context}: wrong lock wait`);
  console.info(JSON.stringify({ serialized: context, ...observed }));
  return responses;
}
function status(response, expected, context) {
  assert.equal(response.status, expected, `${context}: ${response.body}`);
}
async function assignmentState(f) {
  const projectIds = f.lost.map((p) => p.project.id);
  return {
    tasks: await app.prisma.taskAssignee.count({ where: { userId: f.target.id, task: { projectId: { in: projectIds } } } }),
    subtasks: await app.prisma.subtask.count({ where: { assigneeId: f.target.id, task: { projectId: { in: projectIds } } } }),
  };
}
async function assertClean(f) {
  assert.deepEqual(await assignmentState(f), { tasks: 0, subtasks: 0 });
  assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, taskId: f.retained.task.id } }), 1);
  assert.equal(await app.prisma.subtask.count({ where: { assigneeId: f.target.id, taskId: f.retained.task.id } }), 1);
  assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, taskId: f.foreign.task.id } }), 1);
  const originalTasks = f.lost.map((p) => p.task.id);
  const remainingTasks = await app.prisma.task.count({ where: { id: { in: originalTasks } } });
  assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.other.id, taskId: { in: originalTasks } } }), remainingTasks);
}
const writers = [
  { name: "task create", ok: 201,
    send: (f) => call(f.actor, "POST", `/projects/${f.lost[0].project.id}/tasks`, { title: "Raced task", assigneeIds: [f.target.id] }) },
  { name: "add assignee", ok: 201,
    send: (f) => call(f.actor, "POST", `/tasks/${f.slot.id}/assignees`, { userId: f.target.id }) },
  { name: "bulk replacement", ok: 200,
    send: (f) => call(f.actor, "POST", `/projects/${f.lost[0].project.id}/tasks/bulk-update`, { taskIds: [f.slot.id], assigneeIds: [f.target.id], priority: "HIGH" }) },
  { name: "subtask create", ok: 201,
    send: (f) => call(f.actor, "POST", `/tasks/${f.slot.id}/subtasks`, { title: "Raced subtask", assigneeId: f.target.id }) },
  { name: "subtask update", ok: 200,
    send: (f) => call(f.actor, "PATCH", `/subtasks/${f.subtask.id}`, { assigneeId: f.target.id, title: "Changed title" }) },
  { name: "template explicit override", ok: 201,
    send: (f) => call(f.actor, "POST", `/projects/${f.lost[0].project.id}/templates/${f.template.id}/create-task`, { assigneeIds: [f.target.id] }) },
  { name: "duplicate including subtask assignees", ok: 201, filters: true,
    send: (f) => call(f.actor, "POST", `/tasks/${f.lost[0].task.id}/duplicate`, {}) },
  { name: "template stored assignees", ok: 201, filters: true,
    send: (f) => call(f.actor, "POST", `/projects/${f.lost[0].project.id}/templates/${f.template.id}/create-task`, {}) },
];

for (const [index, writer] of writers.entries()) {
  test(`${writer.name} commits before waiting demotion clears lost access`, async () => {
    const f = await fixture();
    const context = `${writer.name} before demotion`;
    // Every writer checks target's membership before its User FK check. Holding
    // User parks it after the SHARE check, including copied subtask assignees.
    const [written, demoted] = await race(context, lockRow("User", f.target.id),
      () => writer.send(f), () => demote(f, index % 2 ? "VIEWER" : "MEMBER"), /UPDATE.*"WorkspaceMember"/s);
    status(written, writer.ok, context);
    status(demoted, 200, context);
    await assertClean(f);
  });
}

for (const [index, writer] of writers.entries()) {
  test(`${writer.name} waits for demotion then ${writer.filters ? "filters stored" : "rejects explicit"} assignees`, async () => {
    const f = await fixture();
    const context = `demotion before ${writer.name}`;
    const [demoted, written] = await race(context, lockRow("TaskAssignee", f.heldAssignment.id),
      () => demote(f, index % 2 ? "MEMBER" : "VIEWER"), () => writer.send(f), /FOR SHARE OF wm/);
    status(demoted, 200, context);
    status(written, writer.filters ? writer.ok : 400, context);
    if (!writer.filters) assert.match(written.body, /Assignees must be workspace members with access to this project/);
    await assertClean(f);
    if (writer.filters) {
      const copied = JSON.parse(written.body).data;
      assert.equal(copied.assignees.some((row) => row.userId === f.target.id), false);
      assert.equal(await app.prisma.subtask.count({ where: { taskId: copied.id, assigneeId: f.target.id } }), 0);
    } else {
      assert.equal(await app.prisma.activityLog.count({ where: { task: { projectId: f.lost[0].project.id } } }), 0);
      assert.equal(await app.prisma.task.count({ where: { projectId: f.lost[0].project.id } }), 2);
      assert.equal((await app.prisma.task.findUniqueOrThrow({ where: { id: f.slot.id } })).priority, "NONE");
      assert.equal((await app.prisma.subtask.findUniqueOrThrow({ where: { id: f.subtask.id } })).title, "Unassigned subtask");
      assert.equal(await app.prisma.notificationDelivery.count({ where: { data: { path: ["projectId"], equals: f.lost[0].project.id } } }), 0);
    }
  });
}

test("an explicit-project assignee remains valid as VIEWER in both race orders", async () => {
  for (const demotionFirst of [false, true]) {
    const f = await fixture();
    const slot = await app.prisma.task.create({ data: { projectId: f.retained.project.id, statusId: f.retained.status.id, title: "Retained new assignment", position: 1 } });
    const assign = () => call(f.actor, "POST", `/tasks/${slot.id}/assignees`, { userId: f.target.id });
    const responses = await race(`retained VIEWER, demotion first=${demotionFirst}`,
      demotionFirst ? lockRow("TaskAssignee", f.heldAssignment.id) : lockRow("User", f.target.id),
      demotionFirst ? () => demote(f, "VIEWER") : assign,
      demotionFirst ? assign : () => demote(f, "VIEWER"),
      demotionFirst ? /FOR SHARE OF wm/ : /UPDATE.*"WorkspaceMember"/s);
    status(responses[demotionFirst ? 0 : 1], 200, "demotion");
    status(responses[demotionFirst ? 1 : 0], 201, "retained assignment");
    await assertClean(f);
    assert.equal(await app.prisma.taskAssignee.count({ where: { taskId: slot.id, userId: f.target.id } }), 1);
    status(await call(f.target, "GET", `/projects/${f.retained.project.id}`), 200, "retained project read");
  }
});

test("demoted members retain automatic assignment only in joined projects, while viewers stay read-only", async () => {
  for (const role of ["MEMBER", "VIEWER"]) {
    const f = await fixture();
    status(await demote(f, role), 200, "demotion");
    const template = await app.prisma.taskTemplate.create({ data: { projectId: f.retained.project.id, name: "Retained template", title: "Retained auto assignment" } });
    const created = await call(f.target, "POST", `/projects/${f.retained.project.id}/tasks`, { title: "Retained actor task" });
    const instantiated = await call(f.target, "POST", `/projects/${f.retained.project.id}/templates/${template.id}/create-task`, {});
    status(created, role === "MEMBER" ? 201 : 403, "create as demoted actor");
    status(instantiated, role === "MEMBER" ? 201 : 403, "instantiate as demoted actor");
    if (role === "MEMBER") {
      for (const response of [created, instantiated]) {
        assert.deepEqual(JSON.parse(response.body).data.assignees.map((row) => row.userId), [f.target.id]);
      }
    }
    status(await call(f.target, "POST", `/projects/${f.lost[0].project.id}/tasks`, { title: "Forbidden task" }), 403, "lost project actor");
    await assertClean(f);
  }
});

test("the pure recurring scheduler filters stored assignees in both demotion orders", async () => {
  for (const demotionFirst of [false, true]) {
    const f = await fixture();
    const config = await app.prisma.recurringTaskConfig.create({ data: {
      projectId: f.lost[0].project.id, templateId: f.template.id, frequency: "DAILY",
      startDate: "2026-10-31", endDate: "2026-10-31", nextRunDate: "2026-10-31",
    } });
    const run = () => processRecurringTasks(app.prisma, app, { now: new Date("2026-10-31T12:00:00Z") });
    const responses = await race(`pure scheduler, demotion first=${demotionFirst}`,
      demotionFirst ? lockRow("TaskAssignee", f.heldAssignment.id) : lockRow("User", f.target.id),
      demotionFirst ? () => demote(f) : run,
      demotionFirst ? run : () => demote(f),
      demotionFirst ? /FOR SHARE OF wm/ : /UPDATE.*"WorkspaceMember"/s);
    status(responses[demotionFirst ? 0 : 1], 200, "demotion");
    assert.equal(responses[demotionFirst ? 1 : 0].generated, 1);
    assert.equal(responses[demotionFirst ? 1 : 0].failed, 0);
    const occurrence = await app.prisma.recurringTaskOccurrence.findUniqueOrThrow({ where: { configId_occurrenceDate: { configId: config.id, occurrenceDate: "2026-10-31" } } });
    assert(occurrence.taskId);
    await assertClean(f);
    assert.equal(await app.prisma.notificationDelivery.count({ where: { data: { path: ["projectId"], equals: f.lost[0].project.id } } }), 0);
  }
});

test("empty retained projects clear the workspace, while same roles and promotions preserve assignments", async () => {
  {
    const f = await fixture();
    await app.prisma.projectMember.deleteMany({ where: { projectId: f.retained.project.id, userId: f.target.id } });
    status(await demote(f, "VIEWER"), 200, "empty retained list");
    assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, task: { project: { workspaceId: f.workspace.id } } } }), 0);
    assert.equal(await app.prisma.subtask.count({ where: { assigneeId: f.target.id, task: { project: { workspaceId: f.workspace.id } } } }), 0);
    assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, taskId: f.foreign.task.id } }), 1);
  }
  for (const [beforeRole, afterRole] of [["ADMIN", "ADMIN"], ["MEMBER", "ADMIN"], ["MEMBER", "VIEWER"]]) {
    const f = await fixture();
    await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.target.id, workspaceId: f.workspace.id } }, data: { role: beforeRole } });
    const before = await assignmentState(f);
    status(await demote(f, afterRole), 200, `${beforeRole} to ${afterRole}`);
    // The non-ADMIN fixture's historical stale rows are deliberate: this is
    // not a legacy repair, and only an actual ADMIN demotion clears them.
    assert.deepEqual(await assignmentState(f), before);
  }
});

test("denied, missing-target and last-admin requests leave every assignment intact", async () => {
  const f = await fixture();
  const before = await assignmentState(f);
  status(await call(f.other, "PATCH", `/workspaces/${f.workspace.id}/members/${f.target.id}`, { role: "VIEWER" }), 403, "non-admin actor");
  status(await call(f.actor, "PATCH", `/workspaces/${f.workspace.id}/members/missing-target`, { role: "MEMBER" }), 404, "missing target");
  await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.actor.id, workspaceId: f.workspace.id } }, data: { role: "MEMBER" } });
  status(await call(f.target, "PATCH", `/workspaces/${f.workspace.id}/members/${f.target.id}`, { role: "VIEWER" }), 409, "last administrator");
  assert.deepEqual(await assignmentState(f), before);
  assert.equal((await app.prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: f.target.id, workspaceId: f.workspace.id } } })).role, "ADMIN");
});

test("retained rows are excluded from both cleanup locks and mutations", async () => {
  const f = await fixture();
  const assignment = await app.prisma.taskAssignee.findUniqueOrThrow({ where: { taskId_userId: { taskId: f.retained.task.id, userId: f.target.id } } });
  const subtask = await app.prisma.subtask.findFirstOrThrow({ where: { taskId: f.retained.task.id, assigneeId: f.target.id } });
  await barrier(async (tx) => {
    await lockRow("TaskAssignee", assignment.id)(tx);
    await lockRow("Subtask", subtask.id)(tx);
  }, async () => {
    // Success while the holder remains proves neither retained row was locked.
    status(await demote(f, "VIEWER"), 200, "excluded retained rows");
    await assertClean(f);
  });
});

test("a cleanup lock timeout rolls the role and assignments back before the holder releases", async () => {
  const f = await fixture();
  const before = await assignmentState(f);
  await barrier(lockRow("TaskAssignee", f.heldAssignment.id), async (holderPid) => {
    const pending = demote(f, "VIEWER");
    assert(await until(async () => (await waiters()).find((row) => row.blockers.includes(holderPid) && /TaskAssignee/.test(row.query))), "demotion never waited in cleanup");
    const response = await pending;
    status(response, 409, "bounded cleanup refusal");
    assert.deepEqual(JSON.parse(response.body), { statusCode: 409, error: "Conflict", message: "The workspace is busy. Please try again." });
    assert.deepEqual(await assignmentState(f), before);
    assert.equal((await app.prisma.workspaceMember.findUniqueOrThrow({ where: { userId_workspaceId: { userId: f.target.id, workspaceId: f.workspace.id } } })).role, "ADMIN");
  });
  assert.deepEqual(await assignmentState(f), before);
  status(await demote(f, "VIEWER"), 200, "retry after holder release");
  await assertClean(f);
});

test("reverse bulk replacements in two lost projects finish before global cleanup", async () => {
  const f = await fixture();
  const groups = [];
  const prefix = crypto.randomBytes(5).toString("hex");
  // Interleave task IDs across projects so project-by-project order cannot be
  // mistaken for the cleanup's one global task order.
  for (const [index, p] of f.lost.entries()) {
    const tasks = [];
    for (const order of [index, index + 2]) {
      tasks.push(await app.prisma.task.create({ data: {
        id: `adm-${prefix}-${order}`, projectId: p.project.id, statusId: p.status.id,
        title: `Bulk ${order}`, position: order + 3, assignees: { create: { userId: f.target.id } },
      } }));
    }
    groups.push(tasks);
  }
  const pending = [];
  await barrier(async (tx) => {
    for (const tasks of groups) await lockRow("Task", tasks[1].id)(tx);
  }, async (holderPid) => {
    for (const [index, tasks] of groups.entries()) {
      pending.push(call(f.actor, "POST", `/projects/${f.lost[index].project.id}/tasks/bulk-update`, {
        taskIds: tasks.map((task) => task.id).reverse(), assigneeIds: [f.other.id],
      }));
      assert(await until(async () => (await waiters()).filter((row) => row.blockers.includes(holderPid)).length === index + 1), "bulk did not reach its late insert barrier");
    }
    pending.push(demote(f));
    const waiting = await until(async () => (await waiters()).find((row) => !row.blockers.includes(holderPid) && /TaskAssignee/.test(row.query)));
    assert(waiting, "demotion did not wait for an existing bulk assignment row");
    assert.match(waiting.query, /ORDER BY ta\."taskId" COLLATE "C"/);
    console.info(JSON.stringify({ serialized: "two reverse bulks before global demotion cleanup", waiting }));
  });
  const [a, b, changed] = await Promise.all(pending);
  status(a, 200, "first bulk"); status(b, 200, "second bulk"); status(changed, 200, "demotion");
  assert.deepEqual(await assignmentState(f), { tasks: 0, subtasks: 0 });
  assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.other.id, taskId: { in: groups.flat().map((task) => task.id) } } }), 4);
});

test("subtask reorder and demotion use the same row order", async () => {
  const f = await fixture();
  const assigned = await app.prisma.subtask.create({ data: { taskId: f.slot.id, title: "Assigned reorder row", assigneeId: f.target.id, position: 1 } });
  const ids = [f.subtask.id, assigned.id].sort();
  const [reordered, changed] = await race("subtask reorder before demotion", lockRow("Subtask", ids[1]),
    () => call(f.actor, "POST", `/tasks/${f.slot.id}/subtasks/reorder`, { orderedIds: [...ids].reverse() }),
    () => demote(f), /ORDER BY s\.id COLLATE "C"/);
  status(reordered, 200, "subtask reorder"); status(changed, 200, "demotion");
  await assertClean(f);
  const rows = await app.prisma.subtask.findMany({ where: { taskId: f.slot.id }, orderBy: { position: "asc" } });
  assert.deepEqual(rows.map((row) => row.id), [...ids].reverse());
});

test("project-member changes serialize with demotion in both orders", async () => {
  for (const operation of ["add", "remove"]) {
    for (const demotionFirst of [false, true]) {
      const f = await fixture();
      const project = operation === "add" ? f.lost[0].project : f.retained.project;
      const membershipChange = () => operation === "add"
        ? call(f.actor, "POST", `/projects/${project.id}/members`, { userId: f.target.id })
        : call(f.actor, "DELETE", `/projects/${project.id}/members/${f.target.id}`);
      let hold;
      if (demotionFirst) hold = lockRow("TaskAssignee", f.heldAssignment.id);
      else if (operation === "add") hold = lockRow("Project", project.id);
      else {
        const row = await app.prisma.taskAssignee.findUniqueOrThrow({ where: { taskId_userId: { taskId: f.retained.task.id, userId: f.target.id } } });
        hold = lockRow("TaskAssignee", row.id);
      }
      const responses = await race(`project ${operation}, demotion first=${demotionFirst}`, hold,
        demotionFirst ? () => demote(f, "VIEWER") : membershipChange,
        demotionFirst ? membershipChange : () => demote(f, "VIEWER"), /FOR NO KEY UPDATE/);
      status(responses[demotionFirst ? 0 : 1], 200, "demotion");
      status(responses[demotionFirst ? 1 : 0], operation === "add" ? 201 : 204, "project membership change");
      const allowed = operation === "add";
      status(await call(f.target, "GET", `/projects/${project.id}`), allowed ? 200 : 403, "post-change access");
      if (operation === "add" && !demotionFirst) {
        assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, taskId: f.lost[0].task.id } }), 1);
      } else {
        assert.equal(await app.prisma.taskAssignee.count({ where: { userId: f.target.id, task: { projectId: project.id } } }), 0);
      }
      assert.equal(await app.prisma.subtask.count({ where: { assigneeId: f.target.id, task: { projectId: f.lost[1].project.id } } }), 0);
    }
  }
});

for (const demotionFirst of [false, true]) {
  test(`project deletion and demotion finish, demotion first=${demotionFirst}`, async () => {
    const f = await fixture();
    const remove = () => call(f.actor, "DELETE", `/projects/${f.lost[0].project.id}`);
    const responses = await race(`project deletion, demotion first=${demotionFirst}`, lockRow("TaskAssignee", f.heldAssignment.id),
      demotionFirst ? () => demote(f) : remove,
      demotionFirst ? remove : () => demote(f), demotionFirst ? /DELETE FROM.*Project/s : /TaskAssignee/);
    status(responses[demotionFirst ? 0 : 1], 200, "demotion");
    status(responses[demotionFirst ? 1 : 0], 204, "project deletion");
    assert.equal(await app.prisma.project.count({ where: { id: f.lost[0].project.id } }), 0);
    await assertClean(f);
  });
}
