import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
// The free-running races keep up to five requests in flight, each holding at
// most one pooled connection at a time (at most two of them waiting on
// PostgreSQL locks in the barrier cases), so five connections are enough; the
// full suite runs with exactly five. The lock holder and the pg_stat_activity
// observer use their own two-connection pool, so blocked actors can never
// starve the control connection that has to release them.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit")) actorUrl.searchParams.set("connection_limit", "6");
assert(
  Number(actorUrl.searchParams.get("connection_limit")) >= 5,
  "Assignment race fixtures require connection_limit>=5",
);
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-assignment-race-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "assignment-membership-race-jwt-secret",
  COOKIE_SECRET: "assignment-membership-race-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(4).toString("hex");
const userIds = [];
const workspaceIds = [];
const tokens = new Map();
const pushes = [];
let app, control, port;
let requests = 0;

before(async () => {
  control = new PrismaClient({ datasources: { db: { url: controlUrl.toString() } } });
  await control.$connect();
  app = await buildApp();
  const broadcastToUser = app.broadcastToUser;
  app.broadcastToUser = function (userId, event, data) {
    pushes.push({ userId, event, data });
    return broadcastToUser.call(this, userId, event, data);
  };
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});

after(async () => {
  try {
    if (app) {
      // Tasks first: a column cannot be deleted while a task still uses it.
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    const closed = await Promise.allSettled([app?.close(), control?.$disconnect()]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
});

// ─── Real HTTP over TCP ────────────────────────────────────

/**
 * Sends one request over its own TCP connection. Each request uses a distinct
 * loopback source address so the per-IP rate limit never shapes the races.
 */
function call(actor, method, url, body) {
  const n = ++requests;
  const localAddress = `127.77.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: `/api${url}`,
        localAddress,
        agent: false,
        headers: {
          authorization: `Bearer ${tokens.get(actor.id)}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: text, label: `${method} ${url}` }));
      },
    );
    request.on("error", reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`${method} ${url} timed out`)));
    request.end(payload);
  });
}

function expectStatus(response, expected, context = "") {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(
    allowed.includes(response.status),
    `${context}${response.label} -> ${response.status} (expected ${allowed.join("/")}): ${response.body}`,
  );
}

// ─── Fixtures ──────────────────────────────────────────────

/**
 * A workspace with an ADMIN actor and RACER, a MEMBER of the race project and
 * of a second project. RACER is already assigned to `held` (the row the
 * removal pauses on). `outside` is a project RACER has not joined.
 */
async function fixture() {
  const id = crypto.randomBytes(4).toString("hex");
  const user = async (name) => {
    const created = await app.prisma.user.create({
      data: { email: `amr-${name}-${id}-${suffix}@example.test`, displayName: `${name} ${id}`, emailVerified: true },
    });
    userIds.push(created.id);
    tokens.set(created.id, signAccessToken({ sub: created.id, email: created.email }));
    return created;
  };
  const admin = await user("admin");
  const racer = await user("racer");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Assignment race ${id}`,
      slug: `amr-${id}-${suffix}`,
      members: { create: [{ userId: admin.id, role: "ADMIN" }, { userId: racer.id, role: "MEMBER" }] },
    },
  });
  workspaceIds.push(workspace.id);
  const project = await app.prisma.project.create({
    data: { workspaceId: workspace.id, name: "Race project", members: { create: [{ userId: admin.id }, { userId: racer.id }] } },
  });
  const other = await app.prisma.project.create({
    data: { workspaceId: workspace.id, name: "Second project", members: { create: [{ userId: racer.id }] } },
  });
  const outside = await app.prisma.project.create({
    data: { workspaceId: workspace.id, name: "Unjoined project", members: { create: [{ userId: admin.id }] } },
  });
  const open = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  const review = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Review", position: 1 } });
  const bug = await app.prisma.label.create({ data: { projectId: project.id, name: "Bug" } });
  const makeTask = (title, statusId, position, extra = {}) =>
    app.prisma.task.create({ data: { projectId: project.id, statusId, title, position, ...extra } });
  const held = await makeTask("Held task", open.id, 0, {
    assignees: { create: { userId: racer.id } },
    labels: { create: { labelId: bug.id } },
  });
  const target = await makeTask("Target task", open.id, 1);
  const parked = await makeTask("Parked task", review.id, 0);
  const subtask = await app.prisma.subtask.create({ data: { taskId: target.id, title: "Target subtask" } });
  const template = await app.prisma.taskTemplate.create({
    data: { projectId: project.id, name: "Race template", title: "Templated task" },
  });
  const heldAssignment = await app.prisma.taskAssignee.findFirstOrThrow({ where: { taskId: held.id, userId: racer.id } });
  const heldLabel = await app.prisma.taskLabel.findFirstOrThrow({ where: { taskId: held.id, labelId: bug.id } });
  const otherMembership = await app.prisma.projectMember.findFirstOrThrow({ where: { projectId: other.id, userId: racer.id } });
  const membership = await app.prisma.projectMember.findFirstOrThrow({ where: { projectId: project.id, userId: racer.id } });
  return {
    admin, racer, workspace, project, other, outside, open, review, bug,
    held, target, parked, subtask, template, heldAssignment, heldLabel, otherMembership, membership,
  };
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

const LOCKABLE = new Set(["Task", "TaskAssignee", "TaskLabel", "StatusColumn", "Subtask", "Project", "ProjectMember"]);
function lockRow(table, id) {
  assert(LOCKABLE.has(table));
  return (tx) => tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
}

async function lockWaiters(holderPid) {
  return control.$queryRaw`
    SELECT pid, wait_event AS "waitEvent", pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND pid <> ${holderPid}::int
  `;
}

async function until(predicate, ms = 4000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}

/**
 * The control transaction holds `hold`, starts `first` and waits until
 * PostgreSQL shows it blocked behind that lock. It then starts `second` and
 * waits (bounded) until `second` either completes or is blocked behind another
 * application backend, i.e. behind `first`. Releasing the control lock lets
 * them finish. The holder is always released and every request awaited.
 */
async function race(hold, first, second) {
  let release, ready;
  const released = new Promise((resolve) => (release = resolve));
  const isReady = new Promise((resolve) => (ready = resolve));
  let holderPid = null;
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await hold(tx);
      ready();
      await released;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
  const observed = { firstWaitedOnControl: false, secondWaitedOnFirst: false, secondFinishedFirst: false };
  const running = [];
  try {
    await Promise.race([
      isReady,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was held");
      }),
    ]);
    running.push(first());
    observed.firstWaitedOnControl = await until(async () =>
      (await lockWaiters(holderPid)).some((w) => w.blockers.includes(holderPid)),
    );
    let done = false;
    running.push(second().finally(() => (done = true)));
    await until(async () => {
      if (done) return true;
      const waiters = await lockWaiters(holderPid);
      const behindFirst = waiters.find((w) => w.blockers.length > 0 && !w.blockers.includes(holderPid));
      if (behindFirst) {
        observed.secondWaitedOnFirst = true;
        observed.secondWaitEvent = behindFirst.waitEvent;
      }
      return observed.secondWaitedOnFirst;
    });
    observed.secondFinishedFirst = done;
  } finally {
    release();
    await Promise.allSettled([holder, ...running]);
  }
  await holder;
  const [firstResponse, secondResponse] = await Promise.all(running);
  assert(observed.firstWaitedOnControl, "the first request never reached the control lock");
  return { first: firstResponse, second: secondResponse, observed };
}

/** Lock evidence is checked after the invariants, so a failure names the real defect first. */
function assertSerialized(observed, context) {
  assert(
    observed.secondWaitedOnFirst && !observed.secondFinishedFirst,
    `${context}: the second request did not wait in PostgreSQL for the first ${JSON.stringify(observed)}`,
  );
  console.info(`serialized: ${context} (second waited on "${observed.secondWaitEvent}" behind the first)`);
}

// ─── Invariants ────────────────────────────────────────────

/** Handlers send notifications without awaiting them; wait until none are still arriving. */
async function settle(userId) {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 60 && stable < 3; attempt++) {
    const current = await app.prisma.notification.count({ where: { userId } });
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    await sleep(40);
  }
}

async function canOpenProject(f, projectId = f.project.id) {
  const [wsMember, projectMember] = await Promise.all([
    app.prisma.workspaceMember.findUnique({ where: { userId_workspaceId: { userId: f.racer.id, workspaceId: f.workspace.id } } }),
    app.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: f.racer.id } } }),
  ]);
  return Boolean(wsMember && (wsMember.role === "ADMIN" || projectMember));
}

/** RACER lost access, so nothing in the workspace may still name RACER as an assignee. */
async function assertNoAssignmentWithoutAccess(f, context) {
  assert.equal(await canOpenProject(f), false, `${context}: RACER still has project access`);
  const inWorkspace = { task: { project: { workspaceId: f.workspace.id } } };
  const [assignments, subtasks] = await Promise.all([
    app.prisma.taskAssignee.findMany({ where: { userId: f.racer.id, ...inWorkspace }, include: { task: { select: { title: true } } } }),
    app.prisma.subtask.findMany({ where: { assigneeId: f.racer.id, ...inWorkspace }, select: { title: true } }),
  ]);
  assert.deepEqual(
    { assignments: assignments.map((a) => a.task.title), subtasks: subtasks.map((s) => s.title) },
    { assignments: [], subtasks: [] },
    `${context}: RACER is still assigned after losing project access`,
  );
}

async function assignmentNotifications(f) {
  await settle(f.racer.id);
  const rows = await app.prisma.notification.count({ where: { userId: f.racer.id, type: "TASK_ASSIGNED" } });
  const pushed = pushes.filter((p) => p.userId === f.racer.id && p.event === "notification_new").length;
  return { rows, pushed };
}

// ─── Assignment writers ────────────────────────────────────

// `pause` is a row the writer touches only after its access check, so holding
// it parks the writer between check and commit.
const writers = [
  {
    name: "add assignee",
    ok: 201,
    notifies: true,
    send: (f) => call(f.admin, "POST", `/tasks/${f.target.id}/assignees`, { userId: f.racer.id }),
    pause: (f) => lockRow("Task", f.target.id),
  },
  {
    name: "create task",
    ok: 201,
    send: (f) => call(f.admin, "POST", `/projects/${f.project.id}/tasks`, { title: "Raced task", assigneeIds: [f.racer.id] }),
    pause: (f) => lockRow("StatusColumn", f.open.id),
  },
  {
    name: "bulk update",
    ok: 200,
    // A different task than "add assignee", so the free-running race never
    // pits two writers against the same (task, user) row.
    send: (f) =>
      call(f.admin, "POST", `/projects/${f.project.id}/tasks/bulk-update`, { taskIds: [f.parked.id], assigneeIds: [f.racer.id] }),
    pause: (f) => lockRow("Task", f.parked.id),
  },
  {
    name: "create subtask",
    ok: 201,
    send: (f) => call(f.admin, "POST", `/tasks/${f.target.id}/subtasks`, { title: "Raced subtask", assigneeId: f.racer.id }),
    pause: (f) => lockRow("Task", f.target.id),
  },
  {
    name: "update subtask",
    ok: 200,
    send: (f) => call(f.admin, "PATCH", `/subtasks/${f.subtask.id}`, { assigneeId: f.racer.id }),
    pause: (f) => lockRow("Subtask", f.subtask.id),
  },
  {
    name: "instantiate template",
    ok: 201,
    notifies: true,
    send: (f) =>
      call(f.admin, "POST", `/projects/${f.project.id}/templates/${f.template.id}/create-task`, { assigneeIds: [f.racer.id] }),
    pause: (f) => lockRow("StatusColumn", f.open.id),
  },
  {
    // A MEMBER instantiating a template is assigned to the new task themselves.
    name: "member instantiates template",
    ok: 201,
    notifies: true,
    send: (f) => call(f.racer, "POST", `/projects/${f.project.id}/templates/${f.template.id}/create-task`, {}),
    pause: (f) => lockRow("StatusColumn", f.open.id),
  },
];

const removeFromProject = (f) => call(f.admin, "DELETE", `/projects/${f.project.id}/members/${f.racer.id}`);
const removeFromWorkspace = (f) => call(f.admin, "DELETE", `/workspaces/${f.workspace.id}/members/${f.racer.id}`);

test("an assignment that arrives during a project-member removal waits for it and is refused", async () => {
  for (const writer of writers) {
    const f = await fixture();
    const context = `removal first, then ${writer.name}`;
    // The removal parks on RACER's existing assignment, after its membership change.
    const { first, second, observed } = await race(
      lockRow("TaskAssignee", f.heldAssignment.id),
      () => removeFromProject(f),
      () => writer.send(f),
    );
    expectStatus(first, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    expectStatus(second, 400, `${context}: `);
    assert.match(second.body, /Assignees must be workspace members with access to this project/);
    assert.deepEqual(await assignmentNotifications(f), { rows: 0, pushed: 0 }, `${context}: RACER was notified`);
    assert.equal(await app.prisma.task.count({ where: { projectId: f.project.id } }), 3, `${context}: a task was created`);
    assertSerialized(observed, context);
  }
});

test("a project-member removal that starts during an assignment waits for it and then clears it", async () => {
  for (const writer of writers) {
    const f = await fixture();
    const context = `${writer.name} first, then removal`;
    const { first, second, observed } = await race(writer.pause(f), () => writer.send(f), () => removeFromProject(f));
    expectStatus(second, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    expectStatus(first, writer.ok, `${context}: `);
    // The assignment was valid when it committed; its notification is allowed,
    // but only because the assignment succeeded.
    const notified = await assignmentNotifications(f);
    if (!writer.notifies) assert.deepEqual(notified, { rows: 0, pushed: 0 }, `${context}: unexpected notification`);
    assertSerialized(observed, context);
  }
});

test("assignment and workspace removal serialize in both orders and leave no assignee behind", async () => {
  const assign = writers[0];
  {
    const f = await fixture();
    const context = "workspace removal first, then add assignee";
    // The workspace removal parks on RACER's second project row, after deleting the workspace membership.
    const { first, second, observed } = await race(
      lockRow("ProjectMember", f.otherMembership.id),
      () => removeFromWorkspace(f),
      () => assign.send(f),
    );
    expectStatus(first, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    expectStatus(second, 400, `${context}: `);
    assert.deepEqual(await assignmentNotifications(f), { rows: 0, pushed: 0 }, `${context}: RACER was notified`);
    assertSerialized(observed, context);
  }
  {
    const f = await fixture();
    const context = "add assignee first, then workspace removal";
    const { first, second, observed } = await race(assign.pause(f), () => assign.send(f), () => removeFromWorkspace(f));
    expectStatus(second, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    expectStatus(first, 201, `${context}: `);
    assertSerialized(observed, context);
  }
});

test("adding a project member while they leave the workspace never leaves a stale project row", async () => {
  const addToOutside = (f) => call(f.admin, "POST", `/projects/${f.outside.id}/members`, { userId: f.racer.id });
  const staleRows = (f) =>
    app.prisma.projectMember.count({ where: { userId: f.racer.id, project: { workspaceId: f.workspace.id } } });
  {
    const f = await fixture();
    const context = "workspace removal first, then project add";
    const { first, second, observed } = await race(
      lockRow("ProjectMember", f.otherMembership.id),
      () => removeFromWorkspace(f),
      () => addToOutside(f),
    );
    expectStatus(first, 204, `${context}: `);
    assert.equal(await staleRows(f), 0, `${context}: a project membership outlived the workspace membership`);
    expectStatus(second, 404, `${context}: `);
    assertSerialized(observed, context);
  }
  {
    const f = await fixture();
    const context = "project add first, then workspace removal";
    // The add parks on its foreign-key check of the project row, after its membership check.
    const { first, second, observed } = await race(
      lockRow("Project", f.outside.id),
      () => addToOutside(f),
      () => removeFromWorkspace(f),
    );
    expectStatus(second, 204, `${context}: `);
    assert.equal(await staleRows(f), 0, `${context}: a project membership outlived the workspace membership`);
    expectStatus(first, 201, `${context}: `);
    assertSerialized(observed, context);
  }
});

test("a project deletion and a task write in that project never deadlock", async () => {
  const deleteProject = (f) => call(f.admin, "DELETE", `/projects/${f.project.id}`);
  const create = (f) =>
    call(f.admin, "POST", `/projects/${f.project.id}/tasks`, { title: "Raced task", statusId: f.review.id, labelIds: [f.bug.id], assigneeIds: [f.racer.id] });
  {
    const f = await fixture();
    const context = "task create first, then project delete";
    // The create parks on the column lock after taking the project row. Were
    // the delete to deadlock with it, PostgreSQL would abort one of the two.
    const { first, second, observed } = await race(lockRow("StatusColumn", f.review.id), () => create(f), () => deleteProject(f));
    expectStatus(first, 201, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    assert.equal(await app.prisma.project.count({ where: { id: f.project.id } }), 0);
    assertSerialized(observed, context);
  }
  {
    const f = await fixture();
    const context = "project delete first, then task create";
    // The delete parks while cascading to RACER's assignment.
    const { first, second, observed } = await race(lockRow("TaskAssignee", f.heldAssignment.id), () => deleteProject(f), () => create(f));
    expectStatus(first, 204, `${context}: `);
    expectStatus(second, [400, 404], `${context}: `);
    assert.equal(await app.prisma.task.count({ where: { projectId: f.project.id } }), 0);
    assertSerialized(observed, context);
  }
});

test("bulk updates and member removals take assignment rows in the same order", async () => {
  for (const [name, remove] of [["workspace removal", removeFromWorkspace], ["project removal", removeFromProject]]) {
    const f = await fixture();
    await app.prisma.taskAssignee.create({ data: { taskId: f.target.id, userId: f.racer.id } });
    const [low, high] = [f.held.id, f.target.id].sort();
    // The client lists the tasks in descending id order and replaces RACER by ADMIN on both.
    const bulk = () =>
      call(f.admin, "POST", `/projects/${f.project.id}/tasks/bulk-update`, { taskIds: [high, low], assigneeIds: [f.admin.id] });
    const context = `bulk un-assign first, then ${name}`;
    // The bulk update parks on the foreign-key check of its last insert, holding RACER's assignment rows.
    const { first, second, observed } = await race(lockRow("Task", high), bulk, () => remove(f));
    expectStatus(first, 200, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    const admins = await app.prisma.taskAssignee.count({ where: { userId: f.admin.id, taskId: { in: [low, high] } } });
    assert.equal(admins, 2, `${context}: the bulk update was not applied`);
    assertSerialized(observed, context);
  }
  {
    const f = await fixture();
    const make = (title) =>
      app.prisma.subtask.create({ data: { taskId: f.target.id, title, assigneeId: f.racer.id } });
    const [a, b] = [(await make("First")).id, (await make("Second")).id].sort();
    const reorder = () => call(f.admin, "POST", `/tasks/${f.target.id}/subtasks/reorder`, { orderedIds: [b, a, f.subtask.id] });
    const context = "subtask reorder first, then project removal";
    const { first, second, observed } = await race(lockRow("Subtask", b), reorder, () => removeFromProject(f));
    expectStatus(first, 200, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    await assertNoAssignmentWithoutAccess(f, context);
    assertSerialized(observed, context);
  }
});

test("a task move and a delete of its column queue instead of deadlocking", async () => {
  const deleteReview = (f) => call(f.admin, "DELETE", `/projects/${f.project.id}/statuses/${f.review.id}`);
  // Moving `target` to the top of Review renumbers the task already there.
  const move = (f) => call(f.admin, "PATCH", `/tasks/${f.target.id}/move`, { statusId: f.review.id, position: 0 });
  {
    const f = await fixture();
    const context = "move first, then column delete";
    // The move parks on its own row after renumbering the destination column.
    const { first, second, observed } = await race(lockRow("Task", f.target.id), () => move(f), () => deleteReview(f));
    expectStatus(first, 200, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    const tasks = await app.prisma.task.findMany({ where: { projectId: f.project.id }, select: { statusId: true } });
    assert(tasks.every((t) => t.statusId === f.open.id), `${context}: a task still points at the deleted column`);
    assertSerialized(observed, context);
  }
  {
    const f = await fixture();
    const context = "column delete first, then move";
    // The delete parks while moving the column's existing task.
    const { first, second, observed } = await race(lockRow("Task", f.parked.id), () => deleteReview(f), () => move(f));
    expectStatus(first, 204, `${context}: `);
    expectStatus(second, 400, `${context}: `);
    assert.match(second.body, /Status column not found in this project/);
    const target = await app.prisma.task.findUniqueOrThrow({ where: { id: f.target.id } });
    assert.equal(target.statusId, f.open.id, `${context}: the refused move changed the task`);
    assertSerialized(observed, context);
  }
});

/**
 * The control transaction holds `first`, waits until the request blocks on it,
 * then requests `second`, which the request already holds. PostgreSQL detects
 * the cycle in the request's backend first (it has waited longest) and aborts
 * the request's transaction.
 */
async function deadlockRequest(first, second, send) {
  let ready;
  const isReady = new Promise((resolve) => (ready = resolve));
  let holderPid = null;
  let response;
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await first(tx);
      ready();
      await until(async () => (await lockWaiters(holderPid)).some((w) => w.blockers.includes(holderPid)));
      await second(tx);
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
  await isReady;
  response = await send();
  await holder;
  return response;
}

test("a transaction PostgreSQL aborts to break a deadlock is reported as a retryable 409", async () => {
  const busy = { statusCode: 409, error: "Conflict", message: "The request conflicted with a concurrent change; try again" };
  {
    // Aborted in a model query: the assignment insert waits for the task row.
    const f = await fixture();
    const response = await deadlockRequest(
      lockRow("Task", f.target.id),
      lockRow("ProjectMember", f.membership.id),
      () => writers[0].send(f),
    );
    expectStatus(response, 409, "model query deadlock: ");
    assert.deepEqual(JSON.parse(response.body), busy);
    assert.equal(await app.prisma.taskAssignee.count({ where: { taskId: f.target.id } }), 0);
  }
  {
    // Aborted in a raw query: the membership lock waits for RACER's workspace row.
    const f = await fixture();
    const wsMember = await app.prisma.workspaceMember.findFirstOrThrow({ where: { userId: f.racer.id, workspaceId: f.workspace.id } });
    const response = await deadlockRequest(
      (tx) => tx.$queryRaw`SELECT id FROM "WorkspaceMember" WHERE id = ${wsMember.id} FOR UPDATE`,
      lockRow("Project", f.project.id),
      () => writers[0].send(f),
    );
    expectStatus(response, 409, "raw query deadlock: ");
    assert.deepEqual(JSON.parse(response.body), busy);
    assert.equal(await app.prisma.taskAssignee.count({ where: { taskId: f.target.id } }), 0);
  }
  {
    // Aborted inside withWorkspaceLock: the removal waits for an assignment row.
    const f = await fixture();
    const response = await deadlockRequest(
      lockRow("TaskAssignee", f.heldAssignment.id),
      lockRow("ProjectMember", f.membership.id),
      () => removeFromProject(f),
    );
    expectStatus(response, 409, "workspace-lock deadlock: ");
    assert.deepEqual(JSON.parse(response.body), {
      statusCode: 409, error: "Conflict", message: "The workspace is busy. Please try again.",
    });
    assert.equal(await canOpenProject(f), true, "the aborted removal was partly applied");
  }
});

// ─── Referenced column and label deletion (N2) ─────────────

const raced = (f) => app.prisma.task.findMany({
  where: { projectId: f.project.id, title: "Raced task" },
  include: { labels: true, assignees: true },
});

async function referenceState(f) {
  const [tasks, labels, statuses, activity] = await Promise.all([
    app.prisma.task.findMany({
      where: { projectId: f.project.id },
      orderBy: { title: "asc" },
      select: { title: true, statusId: true, priority: true, labels: { select: { labelId: true } } },
    }),
    app.prisma.label.count({ where: { id: f.bug.id } }),
    app.prisma.statusColumn.count({ where: { id: f.review.id } }),
    app.prisma.activityLog.count({ where: { task: { projectId: f.project.id } } }),
  ]);
  return { tasks, labels, statuses, activity };
}

test("creating or bulk-updating with a label that is being deleted is refused or completes before the delete", async () => {
  const deleteLabel = (f) => call(f.admin, "DELETE", `/projects/${f.project.id}/labels/${f.bug.id}`);
  const create = (f) => call(f.admin, "POST", `/projects/${f.project.id}/tasks`, { title: "Raced task", labelIds: [f.bug.id] });
  const bulk = (f, extra = {}) =>
    call(f.admin, "POST", `/projects/${f.project.id}/tasks/bulk-update`, { taskIds: [f.target.id], labelIds: [f.bug.id], ...extra });
  for (const [name, write] of [["create", create], ["bulk update", (f) => bulk(f, { priority: "HIGH" })]]) {
    const f = await fixture();
    const context = `label delete first, then ${name}`;
    // The delete parks while cascading to an existing task label.
    const before = await referenceState(f);
    const { first, second, observed } = await race(lockRow("TaskLabel", f.heldLabel.id), () => deleteLabel(f), () => write(f));
    expectStatus(first, 204, `${context}: `);
    expectStatus(second, 400, `${context}: `);
    assert.match(second.body, /Labels must belong to this project/);
    const afterState = await referenceState(f);
    // Only the deleted label's own row disappears; the refused write left nothing.
    assert.deepEqual(afterState, {
      ...before,
      labels: 0,
      tasks: before.tasks.map((t) => ({ ...t, labels: [] })),
    });
    assertSerialized(observed, context);
  }
  for (const [name, write, ok, pause] of [
    ["create", create, 201, (f) => lockRow("StatusColumn", f.open.id)],
    ["bulk update", bulk, 200, (f) => lockRow("Task", f.target.id)],
  ]) {
    const f = await fixture();
    const context = `${name} first, then label delete`;
    const { first, second, observed } = await race(pause(f), () => write(f), () => deleteLabel(f));
    expectStatus(first, ok, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    assert.equal(await app.prisma.label.count({ where: { id: f.bug.id } }), 0);
    assert.equal(await app.prisma.taskLabel.count({ where: { task: { projectId: f.project.id } } }), 0);
    if (name === "create") assert.equal((await raced(f)).length, 1, `${context}: the task was not created`);
    assertSerialized(observed, context);
  }
});

test("creating or bulk-updating into a column that is being deleted is refused or moved with the column's tasks", async () => {
  const deleteStatus = (f) => call(f.admin, "DELETE", `/projects/${f.project.id}/statuses/${f.review.id}`);
  const create = (f) =>
    call(f.admin, "POST", `/projects/${f.project.id}/tasks`, { title: "Raced task", statusId: f.review.id, assigneeIds: [f.racer.id] });
  const bulk = (f) =>
    call(f.admin, "POST", `/projects/${f.project.id}/tasks/bulk-update`, { taskIds: [f.target.id], statusId: f.review.id });
  for (const [name, write] of [["create", create], ["bulk update", bulk]]) {
    const f = await fixture();
    const context = `column delete first, then ${name}`;
    // The delete parks while moving the column's existing task.
    const { first, second, observed } = await race(lockRow("Task", f.parked.id), () => deleteStatus(f), () => write(f));
    expectStatus(first, 204, `${context}: `);
    expectStatus(second, 400, `${context}: `);
    assert.match(second.body, /Status column not found in this project/);
    assert.equal(await app.prisma.statusColumn.count({ where: { id: f.review.id } }), 0);
    assert.equal((await raced(f)).length, 0, `${context}: a task was created`);
    const target = await app.prisma.task.findUniqueOrThrow({ where: { id: f.target.id } });
    assert.equal(target.statusId, f.open.id, `${context}: the bulk update was partly applied`);
    assertSerialized(observed, context);
  }
  for (const [name, write, ok, pause] of [
    // The create parks on its assignee's membership row, after validating the column.
    ["create", create, 201, (f) => lockRow("ProjectMember", f.membership.id)],
    ["bulk update", bulk, 200, (f) => lockRow("Task", f.target.id)],
  ]) {
    const f = await fixture();
    const context = `${name} first, then column delete`;
    const { first, second, observed } = await race(pause(f), () => write(f), () => deleteStatus(f));
    expectStatus(first, ok, `${context}: `);
    expectStatus(second, 204, `${context}: `);
    // The delete waited for the write, then moved its task with the others.
    const tasks = await app.prisma.task.findMany({ where: { projectId: f.project.id }, select: { statusId: true } });
    assert(tasks.every((t) => t.statusId === f.open.id), `${context}: a task still points at the deleted column`);
    if (name === "create") assert.equal((await raced(f)).length, 1, `${context}: the task was not created`);
    assertSerialized(observed, context);
  }
});

// ─── Free-running races (no barrier) ───────────────────────

test("free-running: assignments racing project-member removal never leave an assignee without access", async () => {
  const outcomes = {};
  for (let i = 0; i < 25; i++) {
    const f = await fixture();
    const jitter = () => sleep(Math.floor(Math.random() * 8));
    const [removal, ...writes] = await Promise.all([
      jitter().then(() => removeFromProject(f)),
      ...writers.slice(0, 4).map(async (writer) => {
        await jitter();
        return writer.send(f);
      }),
    ]);
    const context = `iteration ${i}: `;
    expectStatus(removal, 204, context);
    await assertNoAssignmentWithoutAccess(f, `iteration ${i}`);
    writes.forEach((response, index) => {
      expectStatus(response, [writers[index].ok, 400], context);
      const key = `${writers[index].name} ${response.status}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    });
    // A refused assignment never notifies; a successful one may (it was valid then).
    const notified = await assignmentNotifications(f);
    if (writes[0].status === 400) assert.deepEqual(notified, { rows: 0, pushed: 0 }, `${context}RACER was notified`);
  }
  console.info("free-running project-removal outcomes", outcomes);
});

test("free-running: project adds and assignments racing workspace removal leave nothing behind", async () => {
  const outcomes = {};
  for (let i = 0; i < 20; i++) {
    const f = await fixture();
    const jitter = () => sleep(Math.floor(Math.random() * 8));
    const [removal, add, assign] = await Promise.all([
      jitter().then(() => removeFromWorkspace(f)),
      jitter().then(() => call(f.admin, "POST", `/projects/${f.outside.id}/members`, { userId: f.racer.id })),
      jitter().then(() => writers[0].send(f)),
    ]);
    const context = `iteration ${i}: `;
    expectStatus(removal, 204, context);
    expectStatus(add, [201, 404], context);
    expectStatus(assign, [201, 400], context);
    assert.equal(
      await app.prisma.projectMember.count({ where: { userId: f.racer.id, project: { workspaceId: f.workspace.id } } }),
      0,
      `${context}stale project membership`,
    );
    await assertNoAssignmentWithoutAccess(f, `iteration ${i}`);
    for (const [key, response] of [["add", add], ["assign", assign]]) {
      outcomes[`${key} ${response.status}`] = (outcomes[`${key} ${response.status}`] ?? 0) + 1;
    }
  }
  console.info("free-running workspace-removal outcomes", outcomes);
});

test("free-running: writes racing label and column deletes get a 2xx or 400, never a server error or partial rows", async () => {
  const outcomes = {};
  for (let i = 0; i < 20; i++) {
    const f = await fixture();
    const jitter = () => sleep(Math.floor(Math.random() * 8));
    // A delete needs fewer queries than a write, so give the writes a head
    // start on every other iteration to see both orders.
    const lead = () => sleep(i % 2 ? 0 : 10).then(jitter);
    const [labelDelete, statusDelete, create, bulk] = await Promise.all([
      lead().then(() => call(f.admin, "DELETE", `/projects/${f.project.id}/labels/${f.bug.id}`)),
      lead().then(() => call(f.admin, "DELETE", `/projects/${f.project.id}/statuses/${f.review.id}`)),
      jitter().then(() =>
        call(f.admin, "POST", `/projects/${f.project.id}/tasks`, { title: "Raced task", statusId: f.review.id, labelIds: [f.bug.id] })),
      jitter().then(() =>
        call(f.admin, "POST", `/projects/${f.project.id}/tasks/bulk-update`, {
          taskIds: [f.target.id], statusId: f.review.id, labelIds: [f.bug.id], priority: "HIGH",
        })),
    ]);
    const context = `iteration ${i}: `;
    expectStatus(labelDelete, 204, context);
    expectStatus(statusDelete, 204, context);
    expectStatus(create, [201, 400], context);
    expectStatus(bulk, [200, 400], context);
    const created = await raced(f);
    assert.equal(created.length, create.status === 201 ? 1 : 0, `${context}created rows do not match the response`);
    const target = await app.prisma.task.findUniqueOrThrow({ where: { id: f.target.id } });
    // A refused bulk update changed nothing; an accepted one changed everything.
    assert.equal(target.priority, bulk.status === 200 ? "HIGH" : "NONE", `${context}bulk update partly applied`);
    assert.equal(await app.prisma.taskLabel.count({ where: { task: { projectId: f.project.id } } }), 0);
    const tasks = await app.prisma.task.findMany({ where: { projectId: f.project.id }, select: { statusId: true } });
    assert(tasks.every((t) => t.statusId === f.open.id), `${context}a task points at the deleted column`);
    for (const [key, response] of [["create", create], ["bulk", bulk]]) {
      outcomes[`${key} ${response.status}`] = (outcomes[`${key} ${response.status}`] ?? 0) + 1;
    }
  }
  console.info("free-running reference-delete outcomes", outcomes);
});
