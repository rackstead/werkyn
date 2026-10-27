import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "dat-parent-scope-integration-secret";
process.env.COOKIE_SECRET = "dat-parent-scope-cookie-secret";
process.env.LOG_LEVEL = "error";
const storageDir = await mkdtemp(path.join(tmpdir(), "werkyn-parent-scope-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app;
let ownWorkspace;
let foreignWorkspace;
let own;
let sameWorkspaceOther;
let foreign;
const users = [];
const sessions = {};
const events = [];
let requests = 0;

function request(role, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${sessions[role]}` },
    remoteAddress: `10.20.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
  });
}

async function createProject(workspaceId, suffix, memberIds) {
  const project = await app.prisma.project.create({
    data: {
      workspaceId,
      name: `Scope ${suffix}`,
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  const task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: `${suffix} private task` } });
  // Field writes also obey the task ownership policy. Keep this parent-scope
  // suite's positive MEMBER fixture assigned to that member.
  if (memberIds[1]) await app.prisma.taskAssignee.create({ data: { taskId: task.id, userId: memberIds[1] } });
  const field = await app.prisma.customField.create({ data: { projectId: project.id, name: `${suffix} field`, type: "TEXT" } });
  const template = await app.prisma.taskTemplate.create({ data: { projectId: project.id, name: `${suffix} template`, title: `${suffix} title` } });
  const config = await app.prisma.recurringTaskConfig.create({
    data: { projectId: project.id, templateId: template.id, frequency: "DAILY", startDate: "2099-01-01", nextRunDate: "2099-01-01" },
  });
  await app.prisma.customFieldValue.create({ data: { taskId: task.id, fieldId: field.id, value: `${suffix} original` } });
  return { project, status, task, field, template, config };
}

async function snapshot() {
  const projectIds = [own.project.id, sameWorkspaceOther.project.id, foreign.project.id];
  const [templates, configs, values, tasks, activities] = await Promise.all([
    app.prisma.taskTemplate.findMany({ where: { projectId: { in: projectIds } }, orderBy: { id: "asc" } }),
    app.prisma.recurringTaskConfig.findMany({ where: { projectId: { in: projectIds } }, orderBy: { id: "asc" } }),
    app.prisma.customFieldValue.findMany({ where: { task: { projectId: { in: projectIds } } }, orderBy: { id: "asc" } }),
    app.prisma.task.findMany({ where: { projectId: { in: projectIds } }, orderBy: { id: "asc" } }),
    app.prisma.activityLog.findMany({ where: { task: { projectId: { in: projectIds } } }, orderBy: { id: "asc" } }),
  ]);
  return { templates, configs, values, tasks, activities };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID();
  for (const role of ["ADMIN", "MEMBER", "VIEWER", "FOREIGN_ADMIN"]) {
    const user = await app.prisma.user.create({ data: { email: `scope-${role}-${suffix}@example.test`, displayName: role, emailVerified: true } });
    users.push(user);
    sessions[role] = signAccessToken({ sub: user.id, email: user.email });
  }
  ownWorkspace = await app.prisma.workspace.create({
    data: { name: "Scope own", slug: `scope-own-${suffix}`, members: { create: users.slice(0, 3).map((user, i) => ({ userId: user.id, role: ["ADMIN", "MEMBER", "VIEWER"][i] })) } },
  });
  foreignWorkspace = await app.prisma.workspace.create({
    data: { name: "Scope foreign", slug: `scope-foreign-${suffix}`, members: { create: { userId: users[3].id, role: "ADMIN" } } },
  });
  own = await createProject(ownWorkspace.id, "own", users.slice(0, 3).map((u) => u.id));
  sameWorkspaceOther = await createProject(ownWorkspace.id, "other", users.slice(0, 3).map((u) => u.id));
  foreign = await createProject(foreignWorkspace.id, "foreign", [users[3].id]);
});

after(async () => {
  try {
    if (app) {
      const ids = [ownWorkspace?.id, foreignWorkspace?.id].filter(Boolean);
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: ids } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
  test(`${role}: template parent mismatches deny all methods without side effects`, async () => {
    const initial = await snapshot();
    events.length = 0;
    for (const target of [sameWorkspaceOther, foreign]) {
      const base = `/api/projects/${own.project.id}/templates/${target.template.id}`;
      for (const [method, tail, payload, expected] of [
        ["GET", "", undefined, 404],
        ["PATCH", "", { title: "attacker title" }, role === "VIEWER" ? 403 : 404],
        ["DELETE", "", undefined, role === "ADMIN" ? 404 : 403],
        ["POST", "/create-task", {}, role === "VIEWER" ? 403 : 404],
      ]) {
        const result = await request(role, method, base + tail, payload);
        assert.equal(result.statusCode, expected, `${method} ${base}${tail}: ${result.body}`);
        assert(!result.body.includes(target.template.title), "denied response must not disclose template content");
      }
    }
    assert.deepEqual(await snapshot(), initial);
    assert.deepEqual(events, []);
  });

  test(`${role}: recurring parent mismatches deny update, delete and creation with foreign template`, async () => {
    const initial = await snapshot();
    events.length = 0;
    for (const target of [sameWorkspaceOther, foreign]) {
      for (const method of ["PATCH", "DELETE"]) {
        const result = await request(role, method, `/api/projects/${own.project.id}/recurring/${target.config.id}`, method === "PATCH" ? { isActive: false } : undefined);
        assert.equal(result.statusCode, role === "ADMIN" ? 404 : 403, result.body);
      }
      const create = await request(role, "POST", `/api/projects/${own.project.id}/recurring`, { templateId: target.template.id, frequency: "DAILY", startDate: "2099-01-01" });
      assert.equal(create.statusCode, role === "ADMIN" ? 404 : 403, create.body);
    }
    assert.deepEqual(await snapshot(), initial);
    assert.deepEqual(events, []);
  });

  test(`${role}: field/task/project mismatches deny upsert and clear with no activity or broadcast`, async () => {
    const initial = await snapshot();
    events.length = 0;
    for (const target of [sameWorkspaceOther, foreign]) {
      for (const [task, field] of [[target.task, target.field], [own.task, target.field], [target.task, own.field]]) {
        for (const value of ["attacker payload", null]) {
          const result = await request(role, "PUT", `/api/projects/${own.project.id}/tasks/${task.id}/custom-fields/${field.id}`, { value });
          // Parent consistency can reject before role evaluation. Both outcomes
          // conceal the foreign resource and must leave the database untouched.
          assert([403, 404].includes(result.statusCode), result.body);
          assert(!result.body.includes(target.field.name), "denied response must not disclose field metadata");
        }
      }
    }
    assert.deepEqual(await snapshot(), initial);
    assert.deepEqual(events, []);
  });

  test(`${role}: valid same-project template and field flows preserve role behavior`, async () => {
    const base = `/api/projects/${own.project.id}`;
    assert.equal((await request(role, "GET", `${base}/templates`)).statusCode, 200);
    assert.equal((await request(role, "GET", `${base}/templates/${own.template.id}`)).statusCode, 200);
    const create = await request(role, "POST", `${base}/templates`, { name: `${role} template`, title: "Generated safely" });
    if (role === "VIEWER") {
      assert.equal(create.statusCode, 403, create.body);
      const denied = await request(role, "PUT", `${base}/tasks/${own.task.id}/custom-fields/${own.field.id}`, { value: "viewer edit" });
      assert.equal(denied.statusCode, 403, denied.body);
      return;
    }
    assert.equal(create.statusCode, 201, create.body);
    const template = create.json().data;
    const update = await request(role, "PATCH", `${base}/templates/${template.id}`, { title: "Updated safely" });
    assert.equal(update.statusCode, 200, update.body);
    assert.equal(update.json().data.title, "Updated safely");
    const instantiate = await request(role, "POST", `${base}/templates/${template.id}/create-task`, {});
    assert.equal(instantiate.statusCode, 201, instantiate.body);
    assert.equal(instantiate.json().data.projectId, own.project.id);
    const field = await request(role, "PUT", `${base}/tasks/${own.task.id}/custom-fields/${own.field.id}`, { value: `${role} value` });
    assert.equal(field.statusCode, 200, field.body);
    assert.equal(field.json().data.value, `${role} value`);
    const clear = await request(role, "PUT", `${base}/tasks/${own.task.id}/custom-fields/${own.field.id}`, { value: null });
    assert.equal(clear.statusCode, 200, clear.body);
    assert.equal(clear.json().data, null);
    const remove = await request(role, "DELETE", `${base}/templates/${template.id}`);
    assert.equal(remove.statusCode, role === "ADMIN" ? 204 : 403, remove.body);
  });
}

test("ADMIN: valid recurring create, update, list and delete remain scoped", async () => {
  const base = `/api/projects/${own.project.id}/recurring`;
  const create = await request("ADMIN", "POST", base, { templateId: own.template.id, frequency: "DAILY", startDate: "2099-01-01" });
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().data.id;
  const update = await request("ADMIN", "PATCH", `${base}/${id}`, { isActive: false });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().data.isActive, false);
  const list = await request("ADMIN", "GET", base);
  assert.equal(list.statusCode, 200, list.body);
  assert(list.json().data.every((config) => config.projectId === own.project.id));
  assert.equal((await request("ADMIN", "DELETE", `${base}/${id}`)).statusCode, 204);
});
