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
process.env.JWT_SECRET = "list-relation-counts-integration-secret";
process.env.COOKIE_SECRET = "list-relation-counts-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-list-counts-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");

let app, user, token, workspace, project, other, channel;
const familyIds = [];
const tasks = {}, messages = {};
let requests = 0;

function get(url) {
  return app.inject({ method: "GET", url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.42.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

/** The counts Prisma's `_count` include returned for each task before. */
async function expectedTaskCounts(where) {
  const rows = await app.prisma.task.findMany({
    where,
    select: { id: true, _count: { select: { subtasks: true, blockedBy: { where: { blockingTask: { projectId: project.id } } } } } },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r._count]));
}

async function expectedReplyCounts() {
  const rows = await app.prisma.chatMessage.findMany({
    where: { channelId: channel.id, parentId: null },
    select: { id: true, _count: { select: { replies: true } } },
  });
  return Object.fromEntries(rows.map((r) => [r.id, r._count]));
}

const countsOf = (data) => Object.fromEntries(data.map((item) => [item.id, item._count]));

before(async () => {
  app = await buildApp(); await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({ data: { email: `list-counts-${suffix}@example.test`, displayName: "Counter", emailVerified: true } });
  const session = await startRefreshSession(app.prisma, user.id);
  familyIds.push(session.familyId);
  const signedIn = await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: session.refreshToken } });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  token = signedIn.json().data.accessToken;
  workspace = await app.prisma.workspace.create({ data: { name: "List counts", slug: `list-counts-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } } });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Counted" } });
  other = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Other" } });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  const otherStatus = await app.prisma.statusColumn.create({ data: { projectId: other.id, name: "Open" } });
  for (const [name, position, archived] of [["withSubtasks", 0, false], ["plain", 1, false], ["blocked", 2, false], ["archived", 3, true]]) {
    tasks[name] = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: name, position, archived } });
  }
  tasks.foreign = await app.prisma.task.create({ data: { projectId: other.id, statusId: otherStatus.id, title: "foreign" } });
  await app.prisma.subtask.createMany({ data: [
    { taskId: tasks.withSubtasks.id, title: "a" }, { taskId: tasks.withSubtasks.id, title: "b", completed: true },
    { taskId: tasks.withSubtasks.id, title: "c" }, { taskId: tasks.archived.id, title: "d" },
    { taskId: tasks.foreign.id, title: "e" },
  ] });
  // Two same-project blockers and a legacy blocker in another project, which is not counted.
  await app.prisma.taskDependency.createMany({ data: [
    { blockedTaskId: tasks.blocked.id, blockingTaskId: tasks.withSubtasks.id },
    { blockedTaskId: tasks.blocked.id, blockingTaskId: tasks.plain.id },
    { blockedTaskId: tasks.blocked.id, blockingTaskId: tasks.foreign.id },
    { blockedTaskId: tasks.archived.id, blockingTaskId: tasks.plain.id },
    { blockedTaskId: tasks.foreign.id, blockingTaskId: tasks.plain.id },
  ] });

  channel = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, name: "counts", type: "PUBLIC", createdById: user.id, members: { create: { userId: user.id } } } });
  // Distinct creation times keep the history order (newest first) unambiguous.
  let second = 0;
  const message = (content, data = {}) => app.prisma.chatMessage.create({
    data: { channelId: channel.id, userId: user.id, content, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second++)), ...data },
  });
  messages.threaded = await message("threaded", { pinnedAt: new Date(), pinnedById: user.id });
  messages.quiet = await message("quiet");
  messages.pinnedQuiet = await message("pinned without replies", { pinnedAt: new Date(), pinnedById: user.id });
  for (const [content, deletedAt] of [["one", null], ["two", null], ["deleted reply", new Date()]]) {
    await message(content, { parentId: messages.threaded.id, deletedAt });
  }
});

after(async () => {
  if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
  await app.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: familyIds } } });
  if (user) await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("task list and board counts are each task's subtasks and same-project blockers", async () => {
  const expectedActive = await expectedTaskCounts({ projectId: project.id, archived: false });
  assert.deepEqual(expectedActive[tasks.withSubtasks.id], { subtasks: 3, blockedBy: 0 });
  assert.deepEqual(expectedActive[tasks.blocked.id], { subtasks: 0, blockedBy: 2 });

  const page = await get(`/api/projects/${project.id}/tasks`);
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(countsOf(page.json().data), expectedActive);

  const board = await get(`/api/projects/${project.id}/tasks?view=board`);
  assert.equal(board.statusCode, 200, board.body);
  assert.deepEqual(countsOf(board.json().data), expectedActive);

  const archived = await get(`/api/projects/${project.id}/tasks?archived=true`);
  assert.equal(archived.statusCode, 200, archived.body);
  assert.deepEqual(countsOf(archived.json().data), await expectedTaskCounts({ projectId: project.id, archived: true }));
  assert.deepEqual(countsOf(archived.json().data)[tasks.archived.id], { subtasks: 1, blockedBy: 1 });

  const filtered = await get(`/api/projects/${project.id}/tasks?search=plain`);
  assert.deepEqual(countsOf(filtered.json().data), { [tasks.plain.id]: { subtasks: 0, blockedBy: 0 } });
});

test("message history and pinned messages count every reply of each listed message", async () => {
  const expected = await expectedReplyCounts();
  assert.deepEqual(expected[messages.threaded.id], { replies: 3 });

  const history = await get(`/api/chat/${workspace.id}/channels/${channel.id}/messages`);
  assert.equal(history.statusCode, 200, history.body);
  assert.deepEqual(countsOf(history.json().data), expected);

  const older = await get(`/api/chat/${workspace.id}/channels/${channel.id}/messages?limit=1&cursor=${messages.pinnedQuiet.id}`);
  assert.equal(older.statusCode, 200, older.body);
  assert.deepEqual(countsOf(older.json().data), { [messages.quiet.id]: { replies: 0 } });

  const pins = await get(`/api/chat/${workspace.id}/channels/${channel.id}/pins`);
  assert.equal(pins.statusCode, 200, pins.body);
  assert.deepEqual(countsOf(pins.json().data), { [messages.threaded.id]: { replies: 3 }, [messages.pinnedQuiet.id]: { replies: 0 } });
});
