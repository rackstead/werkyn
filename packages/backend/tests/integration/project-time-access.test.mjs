import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "project-time-test-signing-secret", COOKIE_SECRET: "project-time-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-project-time-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, workspace, foreignWorkspace, visible, hidden, foreign, entry, hiddenEntry, mixedEntry, foreignEntry;
const users = {}, tokens = {}, events = [];
let requests = 0;
const range = "startDate=2026-10-01&endDate=2026-10-31";
const entryUrl = () => `/api/workspaces/${workspace.id}/time/entries`;
const req = (actor, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` },
  remoteAddress: `10.70.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
});
const denied = (response) => {
  assert([403, 404].includes(response.statusCode), `${response.statusCode}: ${response.body}`);
  assert(!response.body.includes("Hidden time") && !response.body.includes("Foreign time"), response.body);
};
async function snapshot() {
  return app.prisma.timeEntry.findMany({ where: { workspaceId: workspace.id }, orderBy: { id: "asc" } });
}
async function makeProject(workspaceId, name, members) {
  const project = await app.prisma.project.create({ data: {
    workspaceId, name, members: { create: members.map((userId) => ({ userId })) },
  } });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  const task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: `${name} task` } });
  return { project, task };
}
before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID().slice(0, 20);
  for (const actor of ["ADMIN", "MEMBER", "VIEWER", "PEER", "FOREIGN"]) {
    users[actor] = await app.prisma.user.create({ data: { email: `project-time-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Project time access", slug: `ptime-${suffix}`, members: { create: [
    { userId: users.ADMIN.id, role: "ADMIN" }, { userId: users.MEMBER.id, role: "MEMBER" },
    { userId: users.VIEWER.id, role: "VIEWER" }, { userId: users.PEER.id, role: "MEMBER" },
  ] } } });
  foreignWorkspace = await app.prisma.workspace.create({ data: { name: "Foreign time workspace", slug: `ftime-${suffix}`, members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } } } });
  visible = await makeProject(workspace.id, "Visible time", [users.MEMBER.id, users.VIEWER.id]);
  hidden = await makeProject(workspace.id, "Hidden time", [users.PEER.id]);
  foreign = await makeProject(foreignWorkspace.id, "Foreign time", [users.FOREIGN.id]);
  const makeEntry = (projectId, taskId, description) => app.prisma.timeEntry.create({ data: {
    workspaceId: workspace.id, userId: users.MEMBER.id, date: "2026-10-25", hours: 1, projectId, taskId, description,
  } });
  entry = await makeEntry(visible.project.id, visible.task.id, "Visible entry");
  hiddenEntry = await makeEntry(hidden.project.id, hidden.task.id, "Hidden time entry");
  mixedEntry = await makeEntry(visible.project.id, hidden.task.id, "Hidden time mixed entry");
  foreignEntry = await makeEntry(foreign.project.id, foreign.task.id, "Foreign time entry");
});
after(async () => {
  try {
    if (app) {
      const ids = [workspace?.id, foreignWorkspace?.id].filter(Boolean);
      await app.prisma.timeEntry.deleteMany({ where: { workspaceId: { in: ids } } });
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: ids } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test("time creation cannot return hidden project or task content through supplied references", async () => {
  const initial = await snapshot(); events.length = 0;
  for (const refs of [
    { projectId: hidden.project.id }, { taskId: hidden.task.id },
    { projectId: visible.project.id, taskId: hidden.task.id },
    { projectId: hidden.project.id, taskId: visible.task.id },
    { projectId: foreign.project.id }, { taskId: foreign.task.id },
  ]) denied(await req("MEMBER", "POST", entryUrl(), { date: "2026-10-25", hours: 2, ...refs }));
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
  denied(await req("ADMIN", "POST", entryUrl(), { date: "2026-10-25", hours: 2, taskId: foreign.task.id }));
  assert.deepEqual(await snapshot(), initial);
});

test("time updates reject newly supplied hidden references before writes or response metadata", async () => {
  const initial = await snapshot(); events.length = 0;
  for (const refs of [
    { projectId: hidden.project.id }, { taskId: hidden.task.id },
    { projectId: visible.project.id, taskId: hidden.task.id },
    { projectId: hidden.project.id, taskId: visible.task.id },
    { taskId: foreign.task.id, projectId: foreign.project.id },
  ]) denied(await req("MEMBER", "PATCH", `/api/time/entries/${entry.id}`, { hours: 3, ...refs }));
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("own time lists apply current project rights to both independent references", async () => {
  const result = await req("MEMBER", "GET", `${entryUrl()}?${range}`);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(result.json().data.map((row) => row.id), [entry.id]);
  assert(!result.body.includes(hidden.project.name) && !result.body.includes(foreign.project.name));
  const admin = await req("ADMIN", "GET", `${entryUrl()}?${range}`);
  assert.equal(admin.statusCode, 200, admin.body);
  assert(admin.json().data.some((row) => row.id === hiddenEntry.id));
  assert(!admin.body.includes(foreign.project.name));
});

test("entry-id mutations cannot bypass the project boundary on legacy hidden relations", async () => {
  const initial = await snapshot(); events.length = 0;
  for (const target of [hiddenEntry, mixedEntry, foreignEntry]) {
    denied(await req("MEMBER", "PATCH", `/api/time/entries/${target.id}`, { hours: 4 }));
    denied(await req("MEMBER", "DELETE", `/api/time/entries/${target.id}`));
  }
  denied(await req("ADMIN", "PATCH", `/api/time/entries/${foreignEntry.id}`, { hours: 4 }));
  denied(await req("ADMIN", "DELETE", `/api/time/entries/${foreignEntry.id}`));
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});

test("time report and CSV preserve admin visibility while excluding foreign-project metadata and totals", async () => {
  const reportUrl = `/api/workspaces/${workspace.id}/time/reports`;
  const report = await req("ADMIN", "GET", `${reportUrl}?${range}&groupBy=project`);
  assert.equal(report.statusCode, 200, report.body);
  assert(report.body.includes(hidden.project.name));
  assert(!report.body.includes(foreign.project.name));
  assert.equal(report.json().data.summary.totalHours, 3);
  const csv = await req("ADMIN", "GET", `${reportUrl}/export?${range}`);
  assert.equal(csv.statusCode, 200, csv.body);
  assert(csv.body.includes(hidden.project.name)); assert(!csv.body.includes(foreign.project.name));
  for (const actor of ["MEMBER", "VIEWER", "FOREIGN"]) {
    denied(await req(actor, "GET", `${reportUrl}?${range}`));
    denied(await req(actor, "GET", `${reportUrl}/export?${range}`));
  }
});

test("authorized time create update list and projectless entries remain usable", async () => {
  for (const actor of ["MEMBER", "ADMIN"]) {
    const created = await req(actor, "POST", entryUrl(), { date: "2026-10-25", hours: 2, taskId: visible.task.id });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.projectId, visible.project.id);
    assert.equal(created.json().data.task.title, visible.task.title);
    const id = created.json().data.id;
    const updated = await req(actor, "PATCH", `/api/time/entries/${id}`, { hours: 3 });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.hours, 3);
    assert.equal((await req(actor, "DELETE", `/api/time/entries/${id}`)).statusCode, 204);
  }
  const projectless = await req("MEMBER", "POST", entryUrl(), { date: "2026-10-25", hours: 1 });
  assert.equal(projectless.statusCode, 201, projectless.body);
  const list = await req("MEMBER", "GET", `${entryUrl()}?${range}`);
  assert(list.json().data.some((row) => row.id === projectless.json().data.id));
  assert.equal((await req("VIEWER", "POST", entryUrl(), { date: "2026-10-25", hours: 1 })).statusCode, 403);
  assert.equal((await req("MEMBER", "DELETE", `/api/time/entries/${projectless.json().data.id}`)).statusCode, 204);
});

test("project removal revokes old time reads and mutations despite a valid workspace session", async () => {
  const removed = await req("ADMIN", "DELETE", `/api/projects/${visible.project.id}/members/${users.MEMBER.id}`);
  assert.equal(removed.statusCode, 204, removed.body);
  const initial = await snapshot(); events.length = 0;
  const list = await req("MEMBER", "GET", `${entryUrl()}?${range}`);
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(list.json().data, []);
  denied(await req("MEMBER", "PATCH", `/api/time/entries/${entry.id}`, { hours: 9 }));
  denied(await req("MEMBER", "DELETE", `/api/time/entries/${entry.id}`));
  denied(await req("MEMBER", "POST", entryUrl(), { date: "2026-10-25", hours: 1, taskId: visible.task.id }));
  assert.deepEqual(await snapshot(), initial); assert.deepEqual(events, []);
});
