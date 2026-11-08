import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { writeLegacyRows } from "./support/legacy-rows.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "constraint-error-status-signing-secret",
  COOKIE_SECRET: "constraint-error-status-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-constraint-status-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { Prisma } = await import("@prisma/client");

const SAFE_CONFLICT = {
  statusCode: 409,
  error: "Conflict",
  message: "The request conflicts with a related record",
};

let app;
let user;
let token;
let workspace;
let otherWorkspace;
let project;
let otherProject;
let foreignProject;
let task;
let otherTask;
let foreignTask;
let label;
let otherLabel;
let validEntry;
let requests = 0;

const headers = () => ({ authorization: `Bearer ${token}` });
const remoteAddress = () => `10.91.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`;
const api = (method, url, payload) => app.inject({
  method,
  url,
  payload,
  headers: headers(),
  remoteAddress: remoteAddress(),
});

function sqlState(error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2010" && typeof error.meta?.code === "string" ? error.meta.code : error.code;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /\bcode: "([0-9A-Z]{5})"/.exec(error.message)?.[1] ?? "unknown";
  }
  return error instanceof Error ? error.name : "not-an-error";
}

before(async () => {
  app = await buildApp();
  const operations = {
    "hours-check": () => app.prisma.timeEntry.create({
      data: { workspaceId: workspace.id, userId: user.id, date: "2026-11-01", hours: 0 },
    }),
    "hours-raw": () => app.prisma.$executeRaw`UPDATE "TimeEntry" SET hours = 0 WHERE id = ${validEntry.id}`,
    "position-check": () => app.prisma.task.update({ where: { id: task.id }, data: { position: -1 } }),
    "label-trigger": () => app.prisma.taskLabel.create({ data: { taskId: task.id, labelId: otherLabel.id } }),
    "project-guard": () => app.prisma.task.update({
      where: { id: task.id },
      data: { projectId: otherProject.id, statusId: otherTask.statusId },
    }),
    "deferred-fk": () => app.prisma.timeEntry.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        date: "2026-11-02",
        hours: 1,
        taskId: task.id,
        projectId: otherProject.id,
      },
    }),
  };
  app.post("/__constraint/:kind", async (request) => {
    const run = operations[request.params.kind];
    if (!run) {
      const missing = new Error("Unknown constraint probe");
      missing.statusCode = 404;
      throw missing;
    }
    await run();
    return { stored: true };
  });
  app.constraintProbe = operations;
  await app.ready();
  app.broadcast = () => {};

  const suffix = crypto.randomUUID().slice(0, 8);
  user = await app.prisma.user.create({
    data: { email: `constraint-${suffix}@example.test`, displayName: "Constraint fixture", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Constraint fixture",
      slug: `constraint-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  otherWorkspace = await app.prisma.workspace.create({
    data: { name: "Other workspace", slug: `constraint-other-${suffix}` },
  });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Home" } });
  otherProject = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Sibling" } });
  foreignProject = await app.prisma.project.create({ data: { workspaceId: otherWorkspace.id, name: "Foreign" } });
  const homeStatus = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  const siblingStatus = await app.prisma.statusColumn.create({ data: { projectId: otherProject.id, name: "Open" } });
  const foreignStatus = await app.prisma.statusColumn.create({ data: { projectId: foreignProject.id, name: "Open" } });
  label = await app.prisma.label.create({ data: { projectId: project.id, name: "Home" } });
  otherLabel = await app.prisma.label.create({ data: { projectId: otherProject.id, name: "Sibling" } });
  task = await app.prisma.task.create({
    data: { projectId: project.id, statusId: homeStatus.id, title: "Home task", position: 0 },
  });
  otherTask = await app.prisma.task.create({
    data: { projectId: otherProject.id, statusId: siblingStatus.id, title: "Sibling task", position: 0 },
  });
  foreignTask = await app.prisma.task.create({
    data: { projectId: foreignProject.id, statusId: foreignStatus.id, title: "Foreign task", position: 0 },
  });
  validEntry = await app.prisma.timeEntry.create({
    data: { workspaceId: workspace.id, userId: user.id, date: "2026-11-03", hours: 1, projectId: project.id },
  });
});

after(async () => {
  if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
  if (otherWorkspace) await app.prisma.workspace.delete({ where: { id: otherWorkspace.id } }).catch(() => {});
  if (user) await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("a database CHECK or R35 trigger refusal is a 409 and does not leak", async () => {
  const cases = [
    ["hours-check", "23514"],
    ["hours-raw", "23514"],
    ["position-check", "23514"],
    ["label-trigger", "23514"],
    ["project-guard", "23514"],
    ["deferred-fk", "P2003"],
  ];
  const seen = [];
  for (const [kind, state] of cases) {
    let direct;
    try {
      await app.constraintProbe[kind]();
      direct = null;
    } catch (error) {
      direct = error;
    }
    const response = await app.inject({ method: "POST", url: `/__constraint/${kind}`, remoteAddress: remoteAddress() });
    const body = response.json();
    seen.push({
      kind,
      state: direct ? sqlState(direct) : "stored",
      status: response.statusCode,
      message: typeof body.message === "string" ? body.message.slice(0, 160) : body,
      leak: /23514|violates|constraint|TimeEntry|TaskLabel|projectId_fixed|plpgsql|SELECT |INSERT /.test(response.body),
    });
    assert.equal(seen.at(-1).state, state, direct instanceof Error ? direct.message : "write was stored");
  }
  assert.deepEqual(seen, cases.map(([kind]) => ({
    kind,
    state: kind === "deferred-fk" ? "P2003" : "23514",
    status: 409,
    message: SAFE_CONFLICT.message,
    leak: false,
  })));
  for (const response of [await app.inject({ method: "POST", url: "/__constraint/hours-check", remoteAddress: remoteAddress() })]) {
    assert.deepEqual(response.json(), SAFE_CONFLICT);
  }

  assert.equal(await app.prisma.timeEntry.count({ where: { hours: 0 } }), 0);
  assert.equal((await app.prisma.timeEntry.findUnique({ where: { id: validEntry.id } })).hours, 1);
  assert.equal((await app.prisma.task.findUnique({ where: { id: task.id } })).position, 0);
  assert.equal((await app.prisma.task.findUnique({ where: { id: task.id } })).projectId, project.id);
  assert.equal(await app.prisma.taskLabel.count({ where: { taskId: task.id, labelId: otherLabel.id } }), 0);
  assert.equal(await app.prisma.timeEntry.count({ where: { taskId: task.id, projectId: otherProject.id } }), 0);

  const stillValid = await app.prisma.timeEntry.create({
    data: { workspaceId: workspace.id, userId: user.id, date: "2026-11-04", hours: 1, taskId: task.id },
  });
  assert.equal(stillValid.projectId, null);
  assert.equal(stillValid.taskId, task.id);
});

test("application validation keeps its own 4xx and never reaches the constraint", async () => {
  const hours = await api("POST", `/api/workspaces/${workspace.id}/time/entries`, {
    date: "2026-11-05", hours: 0, projectId: project.id,
  });
  assert.equal(hours.statusCode, 400, hours.body);
  assert.equal(hours.json().message, "Validation failed");

  const mismatch = await api("POST", `/api/workspaces/${workspace.id}/time/entries`, {
    date: "2026-11-05", hours: 1, taskId: task.id, projectId: otherProject.id,
  });
  assert.equal(mismatch.statusCode, 400, mismatch.body);
  assert.equal(mismatch.json().message, "Task does not belong to the selected project");

  const foreignLabel = await api("POST", `/api/tasks/${task.id}/labels`, { labelId: otherLabel.id });
  assert.equal(foreignLabel.statusCode, 404, foreignLabel.body);
  assert.equal(foreignLabel.json().message, "Label not found in this project");

  assert.equal(await app.prisma.timeEntry.count({ where: { date: "2026-11-05" } }), 0);
  assert.equal(await app.prisma.taskLabel.count({ where: { taskId: task.id } }), 0);
});

test("the integrity report omits task-without-project entries and still lists real violations", async () => {
  const { findReferenceIntegrityIssues } = await import("../../src/scripts/reference-integrity-report.js");
  const taskOnly = await app.prisma.timeEntry.create({
    data: { workspaceId: workspace.id, userId: user.id, date: "2026-11-06", hours: 1, taskId: task.id },
  });
  const taskOnlyForeign = await app.prisma.timeEntry.create({
    data: { workspaceId: workspace.id, userId: user.id, date: "2026-11-07", hours: 1, taskId: foreignTask.id },
  });
  assert.equal(taskOnly.projectId, null);
  assert.equal(taskOnlyForeign.projectId, null);

  const [mismatched, foreignProjectEntry, crossTask] = await writeLegacyRows(app.prisma, (tx) => Promise.all([
    tx.timeEntry.create({
      data: {
        workspaceId: workspace.id, userId: user.id, date: "2026-11-08", hours: 1,
        taskId: task.id, projectId: otherProject.id,
      },
    }),
    tx.timeEntry.create({
      data: {
        workspaceId: workspace.id, userId: user.id, date: "2026-11-09", hours: 1,
        projectId: foreignProject.id,
      },
    }),
    tx.timeEntry.create({
      data: {
        workspaceId: workspace.id, userId: user.id, date: "2026-11-10", hours: 1,
        taskId: foreignTask.id, projectId: project.id,
      },
    }),
  ]));

  const report = await findReferenceIntegrityIssues(app.prisma, { sampleLimit: 100 });
  const keys = (id) => report.issues.filter((issue) => issue.samples.some((sample) => sample.id === id)).map((issue) => issue.key);
  assert.deepEqual({
    taskOnly: keys(taskOnly.id),
    taskOnlyForeign: keys(taskOnlyForeign.id),
    mismatched: keys(mismatched.id),
    foreignProject: keys(foreignProjectEntry.id),
    crossTask: keys(crossTask.id),
  }, {
    taskOnly: [],
    taskOnlyForeign: [],
    mismatched: ["time_entry_task_project"],
    foreignProject: ["time_entry_workspace"],
    crossTask: ["time_entry_workspace"],
  });
});
