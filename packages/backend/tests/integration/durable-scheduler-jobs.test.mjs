import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, mock, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "durable-scheduler-jobs-test-jwt-secret";
process.env.COOKIE_SECRET = "durable-scheduler-jobs-test-cookie-secret";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-durable-jobs-"));
process.env.STORAGE_DIR = storageDir;
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { notify } = await import("../../src/utils/notify.js");
const { processRecurringTasks } = await import("../../src/schedulers/recurring-tasks.js");
const { processDueDateReminders } = await import("../../src/schedulers/due-date-reminders.js");
const { createShutdownHandler } = await import("../../src/utils/shutdown.js");
// Added by the fix; missing before it, when nothing retries a notification
// and the scheduler timers have no lifecycle.
const delivery = await import("../../src/modules/notifications/notification-delivery.js").catch(() => null);
const periodic = await import("../../src/schedulers/periodic-job.js").catch(() => null);

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, "../..");
const DAY_MS = 86_400_000;
// A Wednesday. Every scheduler in this file runs at this mocked instant
// unless a test moves it; only Date is mocked, so timers and the database
// behave normally.
const NOW = Date.parse("2027-03-10T12:00:00Z");
const BARRIER_KEY = 710_424_242;

let app, workspace, project, archivedProject, status, archivedStatus, workerB, barrierHolder, observer;
const users = {}, tokens = {};
const events = [], pushes = [], loggedErrors = [];
let requestNumber = 0;

const day = (offset, from = NOW) => new Date(from + offset * DAY_MS).toISOString().slice(0, 10);
const setNow = (ms) => mock.timers.setTime(ms);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = () => crypto.randomUUID().slice(0, 8);

const quietLog = {
  info() {}, warn() {}, debug() {}, trace() {}, fatal() {},
  error(...args) { loggedErrors.push(args); },
  child() { return quietLog; },
};

// A scheduler instance: its own Prisma pool and its own realtime outputs.
function worker(prisma, label) {
  return {
    prisma,
    fastify: {
      log: quietLog,
      broadcast: (...args) => events.push([label, ...args]),
      broadcastToUser: (...args) => pushes.push([label, ...args]),
    },
  };
}
let A, B;

function request(actor, method, url, payload) {
  return app.inject({
    method, url, payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.44.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
  });
}

// ─── Database fault injection and barriers ─────────────────────────────────
// A BEFORE trigger on each table below consults "b04_hook": a 'fault' row
// makes the write fail (optionally only for one userId), and a 'barrier' row
// makes the writing transaction wait on an advisory lock the test holds.

const hookTables = [
  ["Task", "INSERT"],
  ["RecurringTaskConfig", "UPDATE"],
  ["TaskReminderSent", "INSERT"],
  ["Notification", "INSERT"],
  ["NotificationDelivery", "DELETE"],
];

async function tableExists(table) {
  const [{ exists }] = await app.prisma.$queryRawUnsafe(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, `"${table}"`);
  return exists;
}

async function installHooks() {
  await app.prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "b04_hook" ("kind" TEXT NOT NULL, "target" TEXT NOT NULL, PRIMARY KEY ("kind", "target"))`,
  );
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION b04_hook() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      base text := TG_TABLE_NAME || ':' || TG_OP;
      subject jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    BEGIN
      IF EXISTS (SELECT 1 FROM "b04_hook" WHERE "kind" = 'barrier' AND "target" = base) THEN
        PERFORM pg_advisory_xact_lock_shared(${BARRIER_KEY});
      END IF;
      IF EXISTS (SELECT 1 FROM "b04_hook" WHERE "kind" = 'fault'
                 AND "target" IN (base, base || ':' || coalesce(subject->>'userId', ''))) THEN
        RAISE EXCEPTION 'injected fault on %', base;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  for (const [table, op] of hookTables) {
    if (!(await tableExists(table))) continue;
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "b04_hook" ON "${table}"`);
    await app.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "b04_hook" BEFORE ${op} ON "${table}" FOR EACH ROW EXECUTE FUNCTION b04_hook()`,
    );
  }
}

async function removeHooks() {
  for (const [table] of hookTables) {
    if (await tableExists(table)) await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "b04_hook" ON "${table}"`);
  }
  await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS b04_hook()`);
  await app.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "b04_hook"`);
}

const setHook = (kind, target) =>
  app.prisma.$executeRawUnsafe(`INSERT INTO "b04_hook" ("kind", "target") VALUES ($1, $2) ON CONFLICT DO NOTHING`, kind, target);
const clearHooks = () => app.prisma.$executeRawUnsafe(`DELETE FROM "b04_hook"`);

// Holds the barrier lock in an open transaction until the returned release().
async function holdBarrier() {
  let release, acquired;
  const released = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { acquired = resolve; });
  const held = barrierHolder.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${BARRIER_KEY})`);
    acquired();
    await released;
  }, { timeout: 120_000, maxWait: 10_000 });
  await Promise.race([ready, held]);
  return async () => { release(); await held; };
}

// Observed from its own connection: the scheduler pools under test may all
// be blocked at the barrier.
async function barrierWaiters() {
  return observer.$queryRawUnsafe(`
    SELECT l."pid" FROM pg_locks l JOIN pg_database d ON d."oid" = l."database"
    WHERE d."datname" = current_database() AND l."locktype" = 'advisory'
      AND l."objid" = ${BARRIER_KEY} AND NOT l."granted"`);
}

async function waitForWaiters(count, failed = () => null) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    if ((await barrierWaiters()).length >= count) return;
    const failure = failed();
    if (failure) throw new Error(failure);
    await sleep(25);
  }
  throw new Error(`Expected ${count} transactions waiting at the barrier`);
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const retired = [];

async function schedule(label, { frequency = "DAILY", nextRunDate, startDate, endDate = null, dueOffset = 2, projectId = project.id, dayOfWeek = null, dayOfMonth = null }) {
  const name = `${label} ${uid()}`;
  const template = await app.prisma.taskTemplate.create({ data: { projectId, name, title: name, dueOffset } });
  const config = await app.prisma.recurringTaskConfig.create({
    data: { projectId, templateId: template.id, frequency, dayOfWeek, dayOfMonth, startDate: startDate ?? nextRunDate, endDate, nextRunDate },
  });
  retired.push(config.id);
  return { ...config, name };
}

async function dueDatesOf(name) {
  const tasks = await app.prisma.task.findMany({ where: { title: name }, select: { dueDate: true } });
  return tasks.map((t) => t.dueDate).sort();
}

const configOf = (id) => app.prisma.recurringTaskConfig.findUnique({ where: { id } });

async function occurrencesOf(configId) {
  if (!app.prisma.recurringTaskOccurrence) return null;
  const rows = await app.prisma.recurringTaskOccurrence.findMany({ where: { configId }, orderBy: { occurrenceDate: "asc" } });
  return rows.map((row) => row.occurrenceDate);
}

// Leaves no schedule due for later tests.
async function retireSchedules() {
  await clearHooks();
  await app.prisma.recurringTaskConfig.updateMany({ where: { id: { in: retired.splice(0) } }, data: { isActive: false } });
}

const tick = (w = A, options) => processRecurringTasks(w.prisma, w.fastify, options);

// Runs the notification retry pass as if every pending attempt were due:
// each pass is a day after the previous one, past any backoff it recorded.
let drains = 0;
async function drain() {
  await delivery?.processDueNotificationDeliveries(app.prisma, A.fastify, { now: new Date(Date.now() + ++drains * DAY_MS) });
}

const toastsFor = (predicate) =>
  pushes.filter(([, , event, data]) => event === "notification_new" && predicate(data));

// Date is mocked, so this counts real sleeps instead of reading the clock.
async function waitFor(check, timeoutMs = 3000) {
  for (let waited = 0; ; waited += 25) {
    if (await check()) return true;
    if (waited >= timeoutMs) return false;
    await sleep(25);
  }
}

before(async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  app = await buildApp();
  await app.ready();
  app.broadcast = (...args) => events.push(["app", ...args]);
  app.broadcastToUser = (...args) => pushes.push(["app", ...args]);
  workerB = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  barrierHolder = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  observer = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  A = worker(app.prisma, "A");
  B = worker(workerB, "B");

  const suffix = uid();
  for (const [actor, role] of [["ADMIN", "ADMIN"], ["MEMBER", "MEMBER"]]) {
    users[actor] = await app.prisma.user.create({
      data: { email: `durable-jobs-${actor.toLowerCase()}-${suffix}@example.test`, displayName: `Durable ${actor}`, emailVerified: true },
    });
    users[actor].role = role;
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Durable jobs", slug: `durable-jobs-${suffix}`,
      members: { create: Object.values(users).map((u) => ({ userId: u.id, role: u.role })) },
    },
  });
  project = await app.prisma.project.create({
    data: { workspaceId: workspace.id, name: "Durable jobs", members: { create: Object.values(users).map((u) => ({ userId: u.id })) } },
  });
  archivedProject = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Archived", archived: true } });
  status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  archivedStatus = await app.prisma.statusColumn.create({ data: { projectId: archivedProject.id, name: "Open" } });
  for (const actor of Object.keys(users)) tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  await installHooks();
});

after(async () => {
  try {
    await removeHooks();
    if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } });
    await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } });
    if (delivery) await app.prisma.notificationDelivery.deleteMany({ where: { recipientIds: { hasSome: Object.values(users).map((u) => u.id) } } });
  } finally {
    mock.timers.reset();
    await workerB?.$disconnect();
    await barrierHolder?.$disconnect();
    await observer?.$disconnect();
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

// ─── Recurring tasks ───────────────────────────────────────────────────────

test("two scheduler instances racing over missed days create exactly one task per occurrence, each with its own due date", async () => {
  // Four schedules each missed three days; the template's due date is two
  // days after the occurrence.
  const schedules = [];
  for (let i = 0; i < 4; i++) schedules.push(await schedule(`race-${i}`, { nextRunDate: day(-3) }));
  await setHook("barrier", "Task:INSERT");
  const release = await holdBarrier();
  let runs;
  try {
    // Both instances start before either can create a task.
    runs = Promise.allSettled([tick(A), tick(B)]);
    await waitForWaiters(2);
  } finally {
    await release();
  }
  const results = await runs;
  await retireSchedules();
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  for (const s of schedules) {
    assert.deepEqual(await dueDatesOf(s.name), [day(-1), day(0), day(1), day(2)], `${s.name}: one task per occurrence, due two days after it`);
    assert.equal((await configOf(s.id)).nextRunDate, day(1));
    const occurrences = await occurrencesOf(s.id);
    if (occurrences) assert.deepEqual(occurrences, [day(-3), day(-2), day(-1), day(0)]);
  }
  const created = events.filter(([, projectId, event]) => projectId === project.id && event === "task_created");
  const ids = created.map(([, , , data]) => data.taskId);
  assert.equal(new Set(ids).size, ids.length, "each task announced once");
});

test("a failed task creation leaves the occurrence due and a later run generates it once", async () => {
  const s = await schedule("create-failure", { nextRunDate: day(0), dueOffset: 1 });
  await setHook("fault", "Task:INSERT");
  try {
    await tick(A).catch(() => {});
    assert.deepEqual(await dueDatesOf(s.name), []);
    assert.equal((await configOf(s.id)).nextRunDate, day(0), "the occurrence is not skipped");
  } finally {
    await clearHooks();
  }
  await tick(A);
  await tick(A);
  assert.deepEqual(await dueDatesOf(s.name), [day(1)]);
  assert.equal((await configOf(s.id)).nextRunDate, day(1));
  await retireSchedules();
});

test("a failure after the task is created and before the schedule advances rolls both back; the retry creates one task", async () => {
  const s = await schedule("advance-failure", { nextRunDate: day(0), dueOffset: 1 });
  await setHook("fault", "RecurringTaskConfig:UPDATE");
  try {
    await tick(A).catch(() => {});
    assert.deepEqual(await dueDatesOf(s.name), [], "no task without the advanced schedule");
  } finally {
    await clearHooks();
  }
  await tick(A);
  await tick(A);
  assert.deepEqual(await dueDatesOf(s.name), [day(1)]);
  assert.equal((await configOf(s.id)).nextRunDate, day(1));
  await retireSchedules();
});

for (const barrier of ["Task:INSERT", "RecurringTaskConfig:UPDATE"]) {
  test(`a scheduler process killed at ${barrier} leaves exactly one task after a restart`, async () => {
    const s = await schedule(`crash-${barrier}`, { nextRunDate: day(0), dueOffset: 1 });
    await setHook("barrier", barrier);
    const release = await holdBarrier();
    let child;
    try {
      child = spawn(process.execPath, ["--import", "tsx", path.join(here, "support/recurring-tick-child.mjs")], {
        cwd: backendDir,
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, FAKE_NOW: String(NOW) },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // The child must reach the barrier; exiting first means it never did.
      await waitForWaiters(1, () =>
        child.exitCode !== null ? `scheduler process exited (${child.exitCode}) before the barrier: ${stderr}` : null);
      child.kill("SIGKILL");
      await exited;
      // PostgreSQL only notices the dead client when the waiting session
      // ends: end it, as the server does once the connection drops.
      for (const { pid } of await barrierWaiters()) {
        await observer.$executeRawUnsafe(`SELECT pg_terminate_backend(${pid})`);
      }
      assert(await waitFor(async () => (await barrierWaiters()).length === 0), "crashed session ended");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await release();
      await clearHooks();
    }
    await tick(A);
    await tick(A);
    assert.deepEqual(await dueDatesOf(s.name), [day(1)], "exactly one task for the occurrence");
    assert.equal((await configOf(s.id)).nextRunDate, day(1));
    await retireSchedules();
  });
}

test("editing a schedule on a day it already generated does not generate that day again", async () => {
  const name = `edit-same-day ${uid()}`;
  const template = await app.prisma.taskTemplate.create({ data: { projectId: project.id, name, title: name, dueOffset: 0 } });
  const created = await request("ADMIN", "POST", `/api/projects/${project.id}/recurring`, {
    templateId: template.id, frequency: "DAILY", startDate: day(0),
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().data.id;
  retired.push(id);
  await tick(A);
  assert.deepEqual(await dueDatesOf(name), [day(0)]);

  // Today is a Wednesday: the weekly schedule's next run would be today.
  const edited = await request("ADMIN", "PATCH", `/api/projects/${project.id}/recurring/${id}`, { frequency: "WEEKLY", dayOfWeek: 3 });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().data.nextRunDate, day(7), "today was generated already");
  await tick(A);
  assert.deepEqual(await dueDatesOf(name), [day(0)], "no second task for today");
  await retireSchedules();
});

test("resuming a paused schedule skips the dates that passed while paused", async () => {
  const name = `resume ${uid()}`;
  const template = await app.prisma.taskTemplate.create({ data: { projectId: project.id, name, title: name, dueOffset: 1 } });
  try {
    setNow(NOW - 21 * DAY_MS);
    const created = await request("ADMIN", "POST", `/api/projects/${project.id}/recurring`, {
      templateId: template.id, frequency: "WEEKLY", dayOfWeek: 3, startDate: day(-21),
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    retired.push(id);
    await tick(A);
    setNow(NOW - 20 * DAY_MS);
    const paused = await request("ADMIN", "PATCH", `/api/projects/${project.id}/recurring/${id}`, { isActive: false });
    assert.equal(paused.statusCode, 200, paused.body);

    // Two Wednesdays (day -14 and day -7) pass while paused.
    setNow(NOW);
    const resumed = await request("ADMIN", "PATCH", `/api/projects/${project.id}/recurring/${id}`, { isActive: true });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().data.nextRunDate, day(0));
    await tick(A);
    assert.deepEqual(await dueDatesOf(name), [day(-20), day(1)], "the paused dates are not generated late");
    assert.equal((await configOf(id)).nextRunDate, day(7));

    // Pausing and resuming again leaves the next run alone.
    await request("ADMIN", "PATCH", `/api/projects/${project.id}/recurring/${id}`, { isActive: false });
    const again = await request("ADMIN", "PATCH", `/api/projects/${project.id}/recurring/${id}`, { isActive: true });
    assert.equal(again.json().data.nextRunDate, day(7));
    await tick(A);
    assert.deepEqual(await dueDatesOf(name), [day(-20), day(1)]);
  } finally {
    setNow(NOW);
    await retireSchedules();
  }
});

test("occurrences up to a passed end date are still generated, then the schedule ends", async () => {
  const s = await schedule("end-date", { nextRunDate: day(-3), endDate: day(-1), dueOffset: 0 });
  await tick(A);
  assert.deepEqual(await dueDatesOf(s.name), [day(-3), day(-2), day(-1)]);
  const config = await configOf(s.id);
  assert.equal(config.isActive, false);
  await tick(A);
  assert.equal((await dueDatesOf(s.name)).length, 3);
  await retireSchedules();
});

test("a schedule in an archived project skips its dates instead of piling them up", async () => {
  const s = await schedule("archived", { nextRunDate: day(-2), projectId: archivedProject.id });
  await tick(A);
  assert.deepEqual(await dueDatesOf(s.name), []);
  assert.equal((await configOf(s.id)).nextRunDate, day(1));
  await retireSchedules();
});

test("a long backlog is generated over several runs, at most 31 occurrences per schedule per run", async () => {
  const s = await schedule("backlog", { nextRunDate: day(-40), dueOffset: 0 });
  await tick(A);
  assert.equal((await dueDatesOf(s.name)).length, 31);
  assert.equal((await configOf(s.id)).nextRunDate, day(-9));
  await tick(A);
  const dates = await dueDatesOf(s.name);
  assert.equal(dates.length, 41);
  assert.equal(new Set(dates).size, 41);
  assert.equal(dates[0], day(-40));
  assert.equal(dates[40], day(0));
  assert.equal((await configOf(s.id)).nextRunDate, day(1));
  await retireSchedules();
});

test("a monthly schedule left a month late by the old arithmetic is moved back to its next occurrence", async () => {
  // Stored by the old code: first run Apr 15 although Mar 15 is the next one.
  const late = await schedule("late-monthly", { frequency: "MONTHLY", dayOfMonth: 15, startDate: "2027-01-31", nextRunDate: "2027-04-15" });
  // Generated today (Mar 10) and advanced: correct, and left alone.
  const current = await schedule("current-monthly", { frequency: "MONTHLY", dayOfMonth: 10, startDate: day(0), nextRunDate: day(0) });
  await tick(A);
  assert.equal((await configOf(late.id)).nextRunDate, "2027-03-15");
  assert.equal((await configOf(current.id)).nextRunDate, "2027-04-10");
  await tick(A);
  assert.equal((await configOf(current.id)).nextRunDate, "2027-04-10");
  assert.deepEqual(await dueDatesOf(current.name), [day(2)]);
  await retireSchedules();
});

test("shutdown during a running scheduler pass waits for the occurrence in progress and starts no new work", async () => {
  assert.ok(periodic, "scheduled jobs have a stoppable lifecycle");
  const s = await schedule("shutdown", { nextRunDate: day(-4), dueOffset: 0 });
  const job = periodic.startPeriodicJob({
    name: "recurring tasks",
    intervalMs: 60_000,
    log: quietLog,
    run: (signal) => processRecurringTasks(A.prisma, A.fastify, { signal }),
  });
  await setHook("barrier", "Task:INSERT");
  const release = await holdBarrier();
  const exits = [];
  let stopping;
  try {
    const pass = job.run();
    await waitForWaiters(1);
    const shutdown = createShutdownHandler({
      log: quietLog,
      exit: (code) => exits.push(code),
      steps: [{ name: "scheduled jobs", run: () => job.stop(), timeoutMs: 5_000 }],
    });
    stopping = shutdown("SIGTERM");
    await sleep(100);
    assert.deepEqual(exits, [], "shutdown waits for the occurrence in progress");
    await release();
    await stopping;
    await pass;
  } finally {
    await release();
    await clearHooks();
  }
  assert.deepEqual(exits, [0]);
  assert.deepEqual(await dueDatesOf(s.name), [day(-4)], "the occurrence in progress finished; no further one started");
  assert.equal((await configOf(s.id)).nextRunDate, day(-3));
  await job.run();
  assert.equal((await dueDatesOf(s.name)).length, 1, "a stopped job does not run again");
  // The rest of the backlog is generated by the next process.
  await tick(A);
  assert.deepEqual(await dueDatesOf(s.name), [day(-4), day(-3), day(-2), day(-1), day(0)]);
  await retireSchedules();
});

test("trash purge stops between candidates once its stop signal is aborted", async () => {
  const { processTrashPurge } = await import("../../src/schedulers/trash-purge.js");
  const trashedAt = new Date(NOW - 40 * DAY_MS);
  const files = [];
  for (let i = 0; i < 3; i++) {
    files.push(await app.prisma.file.create({
      data: { workspaceId: workspace.id, name: `trashed-${i}`, storagePath: `b04/${uid()}`, uploadedById: users.ADMIN.id, trashedAt },
    }));
  }
  const remaining = () => app.prisma.file.count({ where: { id: { in: files.map((f) => f.id) } } });
  // Stops as soon as the first purged candidate's blob is removed.
  const controller = new AbortController();
  const storage = { delete: async () => { controller.abort(); } };
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await processTrashPurge(app.prisma, storage, { signal: stopped.signal }), 0, "a stopped run purges nothing");
  assert.equal(await remaining(), 3);
  // The purge is global: another suite's leftover candidate may come first.
  // Either way the run stops after the candidate whose blob aborted it.
  assert.ok((await processTrashPurge(app.prisma, storage, { signal: controller.signal })) >= 1);
  assert.equal(controller.signal.aborted, true);
  assert.ok((await remaining()) >= 2, "no candidate starts after the abort");
  await processTrashPurge(app.prisma, { delete: async () => {} });
  assert.equal(await remaining(), 0);
});

// ─── Notifications ─────────────────────────────────────────────────────────

async function assignedTask(label, dueDate = day(1)) {
  return app.prisma.task.create({
    data: {
      projectId: project.id, statusId: status.id, title: `${label} ${uid()}`, dueDate,
      assignees: { create: { userId: users.MEMBER.id } },
    },
  });
}

const reminderCount = (taskId) =>
  app.prisma.notification.count({ where: { userId: users.MEMBER.id, type: "TASK_DUE_SOON", data: { path: ["taskId"], equals: taskId } } });

async function retireTasks(...tasks) {
  await clearHooks();
  await app.prisma.task.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
}

test("two concurrent reminder runs send each due-date reminder exactly once", async () => {
  const tasks = [await assignedTask("reminder-race"), await assignedTask("reminder-race")];
  await setHook("barrier", "TaskReminderSent:INSERT");
  const release = await holdBarrier();
  let runs;
  try {
    // Both runs are past their "already sent" check when they write.
    runs = Promise.allSettled([
      processDueDateReminders(A.prisma, A.fastify),
      processDueDateReminders(B.prisma, B.fastify),
    ]);
    await waitForWaiters(2);
  } finally {
    await release();
  }
  const results = await runs;
  await clearHooks();
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  for (const task of tasks) {
    assert.equal(await reminderCount(task.id), 1, "one stored reminder");
    assert.equal(await app.prisma.taskReminderSent.count({ where: { taskId: task.id } }), 1);
    assert.equal(toastsFor((n) => n.data?.taskId === task.id).length, 1, "one realtime push");
  }
  await retireTasks(...tasks);
});

test("a reminder whose notification write fails is retried until it is delivered, once", async () => {
  const task = await assignedTask("reminder-retry");
  await setHook("fault", "Notification:INSERT");
  try {
    await processDueDateReminders(A.prisma, A.fastify);
    assert.equal(await reminderCount(task.id), 0);
    // Runs while the failure persists queue nothing new.
    await processDueDateReminders(A.prisma, A.fastify);
    await drain();
    if (delivery) {
      const rows = await app.prisma.notificationDelivery.findMany({ where: { data: { path: ["taskId"], equals: task.id } } });
      assert.equal(rows.length, 1);
      assert.match(rows[0].lastError, /injected fault/);
    }
  } finally {
    await clearHooks();
  }
  await processDueDateReminders(A.prisma, A.fastify);
  await drain();
  await drain();
  assert.equal(await reminderCount(task.id), 1, "delivered after the failure, exactly once");
  assert.equal(toastsFor((n) => n.data?.taskId === task.id).length, 1);
  if (delivery) {
    assert.equal(await app.prisma.notificationDelivery.count({ where: { data: { path: ["taskId"], equals: task.id } } }), 0);
  }
  await retireTasks(task);
});

test("a notification that fails for one recipient is stored for none and then retried for all", async () => {
  const title = `Partial failure ${uid()}`;
  await setHook("fault", `Notification:INSERT:${users.ADMIN.id}`);
  try {
    await notify(app.prisma, A.fastify, {
      recipients: [users.MEMBER.id, users.ADMIN.id], type: "COMMENT_ADDED", title, data: { projectId: project.id },
    });
    assert.equal(await app.prisma.notification.count({ where: { title } }), 0, "no silent partial delivery");
  } finally {
    await clearHooks();
  }
  await drain();
  await drain();
  const rows = await app.prisma.notification.findMany({ where: { title } });
  assert.deepEqual(rows.map((r) => r.userId).sort(), [users.ADMIN.id, users.MEMBER.id].sort());
});

test("a comment notification whose first delivery fails is delivered by the retry", async () => {
  const task = await assignedTask("comment-retry");
  await setHook("fault", "Notification:INSERT");
  try {
    const response = await request("ADMIN", "POST", `/api/tasks/${task.id}/comments`, { body: "Please review" });
    assert.equal(response.statusCode, 201, response.body);
    // The notification is sent without delaying the response.
    await waitFor(async () =>
      delivery
        ? (await app.prisma.notificationDelivery.count({ where: { data: { path: ["taskId"], equals: task.id }, lastError: { not: null } } })) === 1
        : false,
    1000);
  } finally {
    await clearHooks();
  }
  await drain();
  assert.equal(
    await app.prisma.notification.count({ where: { userId: users.MEMBER.id, type: "COMMENT_ADDED", data: { path: ["taskId"], equals: task.id } } }),
    1,
  );
  await retireTasks(task);
});

test("a delivery whose completion fails is retried without a second notification or toast", async () => {
  assert.ok(delivery, "notifications have a durable outbox");
  const title = `Completion failure ${uid()}`;
  await setHook("fault", "NotificationDelivery:DELETE");
  let result;
  try {
    result = await notify(app.prisma, A.fastify, { recipients: [users.MEMBER.id], type: "TASK_ASSIGNED", title, data: { projectId: project.id } });
  } finally {
    await clearHooks();
  }
  assert.equal(result, "pending");
  const [stored] = await app.prisma.notification.findMany({ where: { title } });
  assert.ok(stored);
  await drain();
  await drain();
  assert.equal(await app.prisma.notification.count({ where: { title } }), 1);
  assert.equal(toastsFor((n) => n.title === title).length, 1, "the toast is not repeated");
  const refreshes = pushes.filter(([, userId, event, data]) => event === "notification_created" && data.id === stored.id);
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0][1], users.MEMBER.id);
  assert.equal(await app.prisma.notificationDelivery.count({ where: { title } }), 0);
});

test("a file-share notification retried after its recipient left the workspace is not created for them", async () => {
  const leaver = await app.prisma.user.create({
    data: { email: `durable-jobs-leaver-${uid()}@example.test`, displayName: "Leaver", emailVerified: true },
  });
  await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: leaver.id, role: "MEMBER" } });
  const title = `Shared "secret plan.pdf" ${uid()}`;
  try {
    await setHook("fault", "Notification:INSERT");
    try {
      await notify(app.prisma, A.fastify, {
        recipients: [leaver.id, users.MEMBER.id], type: "FILE_SHARED", title,
        data: { fileId: `file-${uid()}`, workspaceId: workspace.id },
      });
    } finally {
      await clearHooks();
    }
    await app.prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id, userId: leaver.id } });
    await drain();
    const rows = await app.prisma.notification.findMany({ where: { title } });
    assert.deepEqual(rows.map((r) => r.userId), [users.MEMBER.id]);
    assert.equal(pushes.filter(([, userId]) => userId === leaver.id).length, 0, "nothing pushed to the former member");
  } finally {
    await app.prisma.user.delete({ where: { id: leaver.id } });
  }
});

test("a title longer than the stored limit is shortened instead of dropping the notification", async () => {
  const marker = `Long title ${uid()} `;
  await notify(app.prisma, A.fastify, {
    recipients: [users.MEMBER.id], type: "TASK_ASSIGNED", title: marker + "x".repeat(300), data: { projectId: project.id },
  });
  const rows = await app.prisma.notification.findMany({ where: { title: { startsWith: marker } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title.length, 255);
});
