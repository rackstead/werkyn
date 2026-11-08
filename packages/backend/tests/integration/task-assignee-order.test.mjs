import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
}
// The (taskId, userId) index returns assignees in user-id order. A sequential
// scan, or a bitmap heap scan, of a small table returns heap order, which is
// insertion order and hides a missing orderBy. Turn both off for this file's
// connections so an unordered read follows the index unless it sorts by
// assignment id.
const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
databaseUrl.searchParams.set("connection_limit", "5");
databaseUrl.searchParams.delete("options");
process.env.DATABASE_URL = `${databaseUrl.toString().replace(/\+/g, "%20")}&options=-c%20enable_seqscan%3Doff%20-c%20enable_bitmapscan%3Doff`;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "task-assignee-order-integration-secret";
process.env.COOKIE_SECRET = "task-assignee-order-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-task-assignee-order-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

let app;
let workspace;
let project;
let status;
let admin;
let aaron;
let zoe;
const tokens = {};
let requests = 0;

function request(actor, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.54.${Math.floor(++requests / 200)}.${(requests % 200) + 1}`,
  });
}

function assertEarliestFirst(task, label) {
  assert.ok(task?.assignees?.length === 2, `${label} assignee count: ${JSON.stringify(task?.assignees)}`);
  const ids = task.assignees.map((row) => row.id);
  assert.deepEqual(ids, [...ids].sort(), `${label} TaskAssignee.id`);
  assert.deepEqual(
    task.assignees.map((row) => row.userId),
    [zoe.id, aaron.id],
    label,
  );
  assert.deepEqual(
    task.assignees.map((row) => row.user.displayName),
    ["Zoe Later", "Aaron First"],
    `${label} calendar colour follows the earliest assignment, not the name`,
  );
  assert.ok(aaron.id < zoe.id, "the later assignee sorts first by user id");
  assert.ok("Aaron First" < "Zoe Later");
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  const [seq] = await app.prisma.$queryRawUnsafe("SHOW enable_seqscan");
  const [bitmap] = await app.prisma.$queryRawUnsafe("SHOW enable_bitmapscan");
  assert.equal(seq.enable_seqscan, "off");
  assert.equal(bitmap.enable_bitmapscan, "off");
  const suffix = crypto.randomUUID().slice(0, 12);
  admin = await app.prisma.user.create({
    data: { email: `admin-${suffix}@example.test`, displayName: "Admin", emailVerified: true },
  });
  // Explicit ids: Aaron sorts before Zoe by user id and by display name.
  aaron = await app.prisma.user.create({
    data: {
      id: `aaaaron${suffix}`,
      email: `aaron-${suffix}@example.test`,
      displayName: "Aaron First",
      emailVerified: true,
    },
  });
  zoe = await app.prisma.user.create({
    data: {
      id: `zzzoe${suffix}`,
      email: `zoe-${suffix}@example.test`,
      displayName: "Zoe Later",
      emailVerified: true,
    },
  });
  assert.ok(aaron.id < zoe.id);
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Assignee order",
      slug: `assignee-order-${suffix}`,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: aaron.id, role: "MEMBER" },
          { userId: zoe.id, role: "MEMBER" },
        ],
      },
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Assignee order",
      members: { create: [{ userId: aaron.id }, { userId: zoe.id }] },
    },
  });
  status = await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "Open", color: "#336699" },
  });
  tokens.admin = signAccessToken({ sub: admin.id, email: admin.email });
  tokens.zoe = signAccessToken({ sub: zoe.id, email: zoe.email });
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({
        where: { id: { in: [admin, aaron, zoe].filter(Boolean).map((user) => user.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("task payloads and the calendar list follow the earliest assignment id", async () => {
  const created = await request("admin", "POST", `/api/projects/${project.id}/tasks`, {
    title: "Calendar colour order",
    startDate: "2026-11-08",
    dueDate: "2026-11-08",
    statusId: status.id,
  });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().data.id;

  const first = await request("admin", "POST", `/api/tasks/${taskId}/assignees`, { userId: zoe.id });
  assert.equal(first.statusCode, 201, first.body);
  const second = await request("admin", "POST", `/api/tasks/${taskId}/assignees`, { userId: aaron.id });
  assert.equal(second.statusCode, 201, second.body);

  const stored = await app.prisma.taskAssignee.findMany({
    where: { taskId },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(stored.map((row) => row.userId), [zoe.id, aaron.id]);
  assert.ok(stored[0].id < stored[1].id);

  // The same read without an order follows the user-id index: Aaron, then Zoe.
  const unordered = await app.prisma.task.findUnique({
    where: { id: taskId },
    include: { assignees: true },
  });
  assert.deepEqual(unordered.assignees.map((row) => row.userId), [aaron.id, zoe.id]);

  const detail = await request("admin", "GET", `/api/tasks/${taskId}`);
  assert.equal(detail.statusCode, 200, detail.body);
  assertEarliestFirst(detail.json().data, "task");
  assert.deepEqual(detail.json().data.assignees.map((row) => row.id), stored.map((row) => row.id));

  for (const pass of [1, 2]) {
    const board = await request("admin", "GET", `/api/projects/${project.id}/tasks?view=board`);
    assert.equal(board.statusCode, 200, board.body);
    const listed = board.json().data.find((task) => task.id === taskId);
    assertEarliestFirst(listed, `calendar list ${pass}`);
    assert.deepEqual(listed.assignees.map((row) => row.id), stored.map((row) => row.id));
  }

  const page = await request("admin", "GET", `/api/projects/${project.id}/tasks`);
  assert.equal(page.statusCode, 200, page.body);
  assertEarliestFirst(page.json().data.find((task) => task.id === taskId), "paginated list");

  const renamed = await request("admin", "PATCH", `/api/tasks/${taskId}`, { title: "Calendar colour order renamed" });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assertEarliestFirst(renamed.json().data, "update");

  const copied = await request("admin", "POST", `/api/tasks/${taskId}/duplicate`);
  assert.equal(copied.statusCode, 201, copied.body);
  assertEarliestFirst(copied.json().data, "duplicate");

  const born = await request("admin", "POST", `/api/projects/${project.id}/tasks`, {
    title: "Created with both assignees",
    assigneeIds: [zoe.id, aaron.id],
    statusId: status.id,
  });
  assert.equal(born.statusCode, 201, born.body);
  assertEarliestFirst(born.json().data, "create");

  const template = await request("admin", "POST", `/api/projects/${project.id}/templates`, {
    name: "Ordered template",
    title: "From an ordered template",
    assigneeIds: [zoe.id, aaron.id],
    statusId: status.id,
  });
  assert.equal(template.statusCode, 201, template.body);
  const instantiated = await request(
    "admin",
    "POST",
    `/api/projects/${project.id}/templates/${template.json().data.id}/create-task`,
    {},
  );
  assert.equal(instantiated.statusCode, 201, instantiated.body);
  assertEarliestFirst(instantiated.json().data, "template");

  const search = await request(
    "admin",
    "GET",
    `/api/workspaces/${workspace.id}/search?q=${encodeURIComponent("Calendar colour order renamed")}`,
  );
  assert.equal(search.statusCode, 200, search.body);
  assertEarliestFirst(search.json().data.find((task) => task.id === taskId), "search");

  const mine = await request("zoe", "GET", `/api/workspaces/${workspace.id}/my-tasks`);
  assert.equal(mine.statusCode, 200, mine.body);
  assertEarliestFirst(mine.json().data.find((task) => task.id === taskId), "my tasks");

  const beforeBulk = detail.json().data.assignees.map((row) => row.id);
  const reversed = await request("admin", "POST", `/api/projects/${project.id}/tasks/bulk-update`, {
    taskIds: [taskId],
    assigneeIds: [aaron.id, zoe.id],
  });
  assert.equal(reversed.statusCode, 200, reversed.body);
  const afterBulk = await request("admin", "GET", `/api/projects/${project.id}/tasks?view=board`);
  assert.equal(afterBulk.statusCode, 200, afterBulk.body);
  const bulkListed = afterBulk.json().data.find((task) => task.id === taskId);
  assertEarliestFirst(bulkListed, "bulk resubmit");
  assert.deepEqual(bulkListed.assignees.map((row) => row.id), beforeBulk);
});
