import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "recurrence-calendar-integration-secret";
process.env.COOKIE_SECRET = "recurrence-calendar-cookie-secret";
const storage = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-recurrence-calendar-"),
);
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { processRecurringTasks } = await import(
  "../../src/schedulers/recurring-tasks.js"
);

let app, user, workspace, project;
const templates = {};
const configs = {};
const events = [];
let requests = 0;

// The scheduler and the recurrence service both read "today" as the current
// UTC date; only Date is mocked so timers and the database behave normally.
function setToday(date) {
  mock.timers.setTime(Date.parse(`${date}T12:00:00Z`));
}

function request(method, suffix, payload) {
  // Sign at the mocked time so the access token is valid on every simulated day.
  const token = signAccessToken({ sub: user.id, email: user.email });
  return app.inject({
    method,
    url: `/api/projects/${project.id}/recurring${suffix}`,
    payload,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.57.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

async function create(name, body) {
  const response = await request("POST", "", {
    templateId: templates[name].id,
    ...body,
  });
  assert.equal(response.statusCode, 201, response.body);
  configs[name] = response.json().data.id;
  return response.json().data;
}

async function edit(name, body) {
  const response = await request("PATCH", `/${configs[name]}`, body);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}

async function nextRunDates() {
  const rows = await app.prisma.recurringTaskConfig.findMany({
    where: { projectId: project.id },
    include: { template: { select: { name: true } } },
  });
  return Object.fromEntries(
    rows.map((row) => [row.template.name, row.nextRunDate]),
  );
}

async function generatedTasks() {
  const tasks = await app.prisma.task.findMany({
    where: { projectId: project.id },
    select: { title: true },
  });
  const counts = {};
  for (const { title } of tasks) counts[title] = (counts[title] ?? 0) + 1;
  return counts;
}

// Runs one scheduler tick on the given UTC day and returns the tasks it created.
async function tick(date) {
  setToday(date);
  const before = await generatedTasks();
  const eventCount = events.length;
  await processRecurringTasks(app.prisma, app);
  const afterTick = await generatedTasks();
  const created = {};
  for (const [title, count] of Object.entries(afterTick)) {
    if (count !== (before[title] ?? 0)) created[title] = count - (before[title] ?? 0);
  }
  const broadcasts = events.slice(eventCount).filter(([pid]) => pid === project.id);
  assert.equal(
    broadcasts.length,
    Object.values(created).reduce((sum, count) => sum + count, 0),
  );
  assert(broadcasts.every(([, event]) => event === "task_created"));
  return created;
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID();
  user = await app.prisma.user.create({
    data: {
      email: `recurrence-${suffix}@example.test`,
      displayName: "Recurrence fixture",
      emailVerified: true,
    },
  });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Recurrence fixture",
      slug: `recurrence-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Recurrence fixture",
      members: { create: { userId: user.id } },
    },
  });
  await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "Open" },
  });
  for (const name of [
    "monthly-31",
    "monthly-28",
    "monthly-edited",
    "biweekly",
    "december-31",
    "leap-29",
  ]) {
    templates[name] = await app.prisma.taskTemplate.create({
      data: { projectId: project.id, name, title: name },
    });
  }
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2027-01-31T12:00:00Z") });
});

after(async () => {
  mock.timers.reset();
  try {
    if (workspace)
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (user) await app.prisma.user.delete({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test("create and edit initialize month-end and biweekly schedules on the calendar", async () => {
  setToday("2027-01-31");
  assert.equal(
    (await create("monthly-31", { frequency: "MONTHLY", dayOfMonth: 31, startDate: "2027-01-31" })).nextRunDate,
    "2027-01-31",
  );
  // Past the 28th on Jan 31: the next occurrence is Feb 28, not Mar 28.
  assert.equal(
    (await create("monthly-28", { frequency: "MONTHLY", dayOfMonth: 28, startDate: "2027-01-31" })).nextRunDate,
    "2027-02-28",
  );
  assert.equal(
    (await create("monthly-edited", { frequency: "MONTHLY", dayOfMonth: 15, startDate: "2027-01-01" })).nextRunDate,
    "2027-02-15",
  );
  assert.equal((await edit("monthly-edited", { dayOfMonth: 30 })).nextRunDate, "2027-02-28");

  // Mondays of the two-week cycles starting Jan 11: Jan 11, Jan 25, Feb 8.
  assert.equal(
    (await create("biweekly", { frequency: "BIWEEKLY", dayOfWeek: 1, startDate: "2027-01-11" })).nextRunDate,
    "2027-02-08",
  );
  // Moving to Wednesday keeps the same cycles: Jan 13, Jan 27, Feb 10.
  assert.equal((await edit("biweekly", { dayOfWeek: 3 })).nextRunDate, "2027-02-10");
  assert.equal((await edit("biweekly", { frequency: "BIWEEKLY" })).nextRunDate, "2027-02-10");
  assert.equal((await edit("biweekly", { endDate: "2027-12-31" })).nextRunDate, "2027-02-10");

  assert.deepEqual(await nextRunDates(), {
    "monthly-31": "2027-01-31",
    "monthly-28": "2027-02-28",
    "monthly-edited": "2027-02-28",
    biweekly: "2027-02-10",
  });
});

test("scheduler ticks create one task per occurrence and advance through short months", async () => {
  assert.deepEqual(await tick("2027-01-31"), { "monthly-31": 1 });
  assert.equal((await nextRunDates())["monthly-31"], "2027-02-28");
  // A repeated tick on the same day does not fire the advanced schedule again.
  assert.deepEqual(await tick("2027-01-31"), {});
  assert.deepEqual(await tick("2027-02-09"), {});
  assert.deepEqual(await tick("2027-02-10"), { biweekly: 1 });
  assert.deepEqual(await tick("2027-02-24"), { biweekly: 1 });
  assert.deepEqual(await tick("2027-02-27"), {});
  assert.deepEqual(await tick("2027-02-28"), {
    "monthly-31": 1,
    "monthly-28": 1,
    "monthly-edited": 1,
  });
  assert.deepEqual(await tick("2027-02-28"), {});
  assert.deepEqual(await nextRunDates(), {
    "monthly-31": "2027-03-31",
    "monthly-28": "2027-03-28",
    "monthly-edited": "2027-03-30",
    biweekly: "2027-03-10",
  });
  assert.deepEqual(await tick("2027-03-10"), { biweekly: 1 });
  assert.deepEqual(await tick("2027-03-24"), { biweekly: 1 });
  assert.deepEqual(await tick("2027-03-28"), { "monthly-28": 1 });
  assert.deepEqual(await tick("2027-03-30"), { "monthly-edited": 1 });
  assert.deepEqual(await tick("2027-03-31"), { "monthly-31": 1 });
  assert.deepEqual(await tick("2027-04-30"), {
    "monthly-31": 1,
    "monthly-28": 1,
    "monthly-edited": 1,
    biweekly: 1,
  });
  assert.deepEqual(await nextRunDates(), {
    "monthly-31": "2027-05-31",
    "monthly-28": "2027-05-28",
    "monthly-edited": "2027-05-30",
    // Apr 7 had no tick; the catch-up tick handled that one occurrence only.
    biweekly: "2027-04-21",
  });
  assert.deepEqual(await generatedTasks(), {
    "monthly-31": 4,
    "monthly-28": 3,
    "monthly-edited": 3,
    biweekly: 5,
  });

  // Pausing a schedule does not recompute or move its next run.
  for (const name of ["monthly-31", "monthly-28", "monthly-edited", "biweekly"]) {
    const paused = await edit(name, { isActive: false });
    assert.equal(paused.isActive, false);
  }
  assert.deepEqual(await nextRunDates(), {
    "monthly-31": "2027-05-31",
    "monthly-28": "2027-05-28",
    "monthly-edited": "2027-05-30",
    biweekly: "2027-04-21",
  });
});

test("December rollover and leap-year February keep the configured day", async () => {
  // Independent of the previous test's outcome: only this test's schedules are active.
  await app.prisma.recurringTaskConfig.updateMany({
    where: { projectId: project.id },
    data: { isActive: false },
  });
  setToday("2027-12-31");
  assert.equal(
    (await create("december-31", { frequency: "MONTHLY", dayOfMonth: 31, startDate: "2027-12-31" })).nextRunDate,
    "2027-12-31",
  );
  assert.equal(
    (await create("leap-29", { frequency: "MONTHLY", dayOfMonth: 29, startDate: "2027-12-31" })).nextRunDate,
    "2028-01-29",
  );
  assert.deepEqual(await tick("2027-12-31"), { "december-31": 1 });
  assert.deepEqual(await tick("2028-01-29"), { "leap-29": 1 });
  assert.deepEqual(await tick("2028-01-31"), { "december-31": 1 });
  assert.deepEqual(await tick("2028-02-28"), {});
  assert.deepEqual(await tick("2028-02-29"), { "december-31": 1, "leap-29": 1 });
  assert.deepEqual(await tick("2028-03-29"), { "leap-29": 1 });
  assert.deepEqual(await tick("2028-03-31"), { "december-31": 1 });
  const dates = await nextRunDates();
  assert.equal(dates["december-31"], "2028-04-30");
  assert.equal(dates["leap-29"], "2028-04-29");
  const counts = await generatedTasks();
  assert.equal(counts["december-31"], 4);
  assert.equal(counts["leap-29"], 3);
});
