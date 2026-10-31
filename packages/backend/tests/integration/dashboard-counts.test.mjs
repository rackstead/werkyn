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
process.env.JWT_SECRET = "dashboard-counts-integration-secret";
process.env.COOKIE_SECRET = "dashboard-counts-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-dashboard-counts-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

let app, workspace, projects;
const users = {}, tokens = {};
let requests = 0;

const DAY = 86_400_000;
const today = () => new Date().toISOString().split("T")[0];
const dayFrom = (offset) => new Date(Date.now() + offset * DAY).toISOString().split("T")[0];

function request(actor, method, url) {
  return app.inject({ method, url,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.41.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

// The dashboard's original definition, applied to every task row: counts of
// active tasks, of those in a completion column, and of incomplete ones whose
// truthy due date sorts before today as a JavaScript string.
async function expectedDashboard(actor) {
  const where = { workspaceId: workspace.id, ...(actor === "ADMIN" ? {} : { members: { some: { userId: users[actor].id } } }) };
  const rows = await app.prisma.project.findMany({
    where,
    select: { id: true, name: true, color: true, archived: true,
      tasks: { where: { archived: false }, select: { dueDate: true, status: { select: { isCompletion: true } } } } },
    orderBy: { name: "asc" },
  });
  const now = today();
  return rows.map((p) => ({
    id: p.id, name: p.name, color: p.color, archived: p.archived,
    totalTasks: p.tasks.length,
    completedTasks: p.tasks.filter((t) => t.status.isCompletion).length,
    overdueTasks: p.tasks.filter((t) => t.dueDate && t.dueDate < now && !t.status.isCompletion).length,
  }));
}

before(async () => {
  app = await buildApp(); await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  for (const actor of ["ADMIN", "MEMBER"]) {
    const user = await app.prisma.user.create({ data: { email: `dashboard-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    users[actor] = user; tokens[actor] = signAccessToken({ sub: user.id, email: user.email, sid: "dashboard-counts" });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Dashboard counts", slug: `dashboard-${suffix}`,
    members: { create: [{ userId: users.ADMIN.id, role: "ADMIN" }, { userId: users.MEMBER.id, role: "MEMBER" }] } } });
  const project = (name, opts = {}) => app.prisma.project.create({ data: { workspaceId: workspace.id, name, ...opts } });
  const member = { members: { create: { userId: users.MEMBER.id } } };
  projects = {
    main: await project("A main", member),
    hidden: await project("B hidden"),
    archived: await project("C archived", { ...member, archived: true }),
    empty: await project("D empty", member),
  };
  const status = (projectId, name, isCompletion) => app.prisma.statusColumn.create({ data: { projectId, name, isCompletion } });
  const open = await status(projects.main.id, "Open", false);
  const done = await status(projects.main.id, "Done", true);
  const hiddenDone = await status(projects.hidden.id, "Done", true);
  const archivedOpen = await status(projects.archived.id, "Open", false);
  const task = (projectId, statusId, title, data = {}) => ({ projectId, statusId, title, ...data });
  await app.prisma.task.createMany({ data: [
    task(projects.main.id, open.id, "overdue", { dueDate: dayFrom(-1) }),
    task(projects.main.id, open.id, "due today", { dueDate: today() }),
    task(projects.main.id, open.id, "due tomorrow", { dueDate: dayFrom(1) }),
    task(projects.main.id, open.id, "no due date"),
    // Legacy values the API no longer accepts.
    task(projects.main.id, open.id, "empty due date", { dueDate: "" }),
    // "YYYY-M-9": before today by code unit ("-" sorts before every digit),
    // after it in collations that skip punctuation.
    task(projects.main.id, open.id, "unpadded due date", { dueDate: `${today().slice(0, 5)}${today()[5]}-9` }),
    task(projects.main.id, open.id, "lowercase sorts after digits", { dueDate: "x" }),
    task(projects.main.id, done.id, "done but past due", { dueDate: dayFrom(-3) }),
    // A legacy row whose column belongs to another project still counts by that column.
    task(projects.main.id, hiddenDone.id, "foreign completion column", { dueDate: dayFrom(-2) }),
    task(projects.main.id, open.id, "archived and past due", { dueDate: dayFrom(-5), archived: true }),
    task(projects.hidden.id, hiddenDone.id, "hidden done"),
    task(projects.hidden.id, hiddenDone.id, "hidden archived", { archived: true }),
    task(projects.archived.id, archivedOpen.id, "in archived project", { dueDate: dayFrom(-10) }),
  ] });
});

after(async () => {
  if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("dashboard counts match the per-task definition for admins and members", async () => {
  for (const actor of ["ADMIN", "MEMBER"]) {
    const res = await request(actor, "GET", `/api/workspaces/${workspace.id}/dashboard`);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data, await expectedDashboard(actor), actor);
  }
});

test("dashboard counts exclude archived tasks and count only truthy past due dates of open tasks", async () => {
  const res = await request("ADMIN", "GET", `/api/workspaces/${workspace.id}/dashboard`);
  assert.equal(res.statusCode, 200, res.body);
  const byName = Object.fromEntries(res.json().data.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName), ["A main", "B hidden", "C archived", "D empty"]);
  assert.deepEqual(
    { total: byName["A main"].totalTasks, completed: byName["A main"].completedTasks, overdue: byName["A main"].overdueTasks },
    { total: 9, completed: 2, overdue: 2 },
  );
  assert.deepEqual([byName["B hidden"].totalTasks, byName["B hidden"].completedTasks, byName["B hidden"].overdueTasks], [1, 1, 0]);
  assert.deepEqual([byName["C archived"].totalTasks, byName["C archived"].overdueTasks, byName["C archived"].archived], [1, 1, true]);
  assert.deepEqual([byName["D empty"].totalTasks, byName["D empty"].completedTasks, byName["D empty"].overdueTasks], [0, 0, 0]);

  const member = await request("MEMBER", "GET", `/api/workspaces/${workspace.id}/dashboard`);
  assert.deepEqual(member.json().data.map((p) => p.name), ["A main", "C archived", "D empty"]);
});
