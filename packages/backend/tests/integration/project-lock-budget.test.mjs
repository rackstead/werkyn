import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
actorUrl.searchParams.set("connection_limit", "5");
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "3");
const singleUrl = new URL(actorUrl);
singleUrl.searchParams.set("connection_limit", "1");
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(), NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "project-lock-budget-jwt", COOKIE_SECRET: "project-lock-budget-cookie",
});
const { PrismaClient } = await import("@prisma/client");
const { withProjectOrder, ProjectBusyError } = await import("../../src/utils/task-order.ts");
const { createTaskHandler, moveTaskHandler } = await import("../../src/modules/tasks/tasks.controller.ts");
const { createStatusHandler } = await import("../../src/modules/statuses/statuses.controller.ts");
const { createSubtaskHandler } = await import("../../src/modules/subtasks/subtasks.controller.ts");
const { createTaskFromTemplateHandler } = await import("../../src/modules/templates/templates.controller.ts");
const { processRecurringTasks } = await import("../../src/schedulers/recurring-tasks.ts");
const workspaceIds = [], userIds = [];
let actor, control, single;

before(async () => {
  actor = new PrismaClient({ datasources: { db: { url: actorUrl.toString() } } });
  control = new PrismaClient({ datasources: { db: { url: controlUrl.toString() } } });
  single = new PrismaClient({ datasources: { db: { url: singleUrl.toString() } } });
  await Promise.all([actor.$connect(), control.$connect(), single.$connect()]);
});
after(async () => {
  try {
    await actor?.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
    await actor?.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await actor?.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await Promise.all([actor?.$disconnect(), control?.$disconnect(), single?.$disconnect()]);
  }
});

async function fixture() {
  const user = await actor.user.create({ data: { email: `project-budget-${crypto.randomUUID()}@example.test`, displayName: "Budget admin", emailVerified: true } });
  userIds.push(user.id);
  const workspace = await actor.workspace.create({ data: {
    name: "Project budget", slug: crypto.randomUUID(), members: { create: { userId: user.id, role: "ADMIN" } },
  } });
  workspaceIds.push(workspace.id);
  const project = await actor.project.create({ data: { workspaceId: workspace.id, name: "Budget project", members: { create: { userId: user.id } } } });
  const status = await actor.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  const task = await actor.task.create({ data: { projectId: project.id, statusId: status.id, title: "Original", position: 0 } });
  return { user, workspace, project, status, task };
}
const busy = (error) => error instanceof ProjectBusyError && error.statusCode === 503 &&
  error.message === "The project is busy. Try again in a moment.";
const state = (error, code) => error.code === "P2010" && error.meta?.code === code;
const outcome = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
async function settings(db) {
  const [row] = await db.$queryRaw`SELECT pg_backend_pid()::int AS pid, current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
  return row;
}
async function setSettings(db, statement, lock, local) {
  await db.$executeRaw`SELECT set_config('statement_timeout', ${statement}, ${local}), set_config('lock_timeout', ${lock}, ${local})`;
}
async function session(statement, lock, callback) {
  const original = await settings(single);
  try {
    await setSettings(single, `${statement}ms`, `${lock}ms`, false);
    const configured = await settings(single);
    return await callback(configured);
  } finally {
    await setSettings(single, original.statement, original.lock, false);
    assert.deepEqual(await settings(single), original, "owned session settings or backend changed");
  }
}
async function until(predicate, timeout = 1500) {
  const deadline = performance.now() + timeout;
  do { if (await predicate()) return; await sleep(10); } while (performance.now() < deadline);
  assert.fail("expected PostgreSQL state was not observed");
}
async function waiters() {
  return control.$queryRaw`SELECT pid, query, wait_event AS event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
}
async function holder(table, id, callback, { maxHold = 2000, remove = false } = {}) {
  assert(["Project", "Task"].includes(table));
  let ready, failed, release, pid;
  const acquired = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const finish = new Promise((resolve) => { release = resolve; });
  const holding = control.$transaction(async (tx) => {
    [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
    await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR NO KEY UPDATE`, id);
    if (remove) await tx.project.delete({ where: { id } });
    ready();
    await finish;
  }, { timeout: maxHold + 5000, maxWait: 5000 });
  holding.catch(failed);
  await acquired;
  const deadline = setTimeout(release, maxHold);
  try { return await callback({ pid, release }); }
  finally { clearTimeout(deadline); release(); await holding; }
}
async function stillHeld(table, id) {
  await assert.rejects(control.$transaction((tx) => tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE NOWAIT`, id)), (error) => state(error, "55P03"));
}
const write = (f, title) => (tx) => tx.task.create({ data: { projectId: f.project.id, statusId: f.status.id, title, position: 1 } });

for (const local of [false, true]) {
  for (const [statement, lock] of [[180, 0], [0, 140]]) {
    test(`${local ? "caller transaction" : "owned session"} ${statement ? "statement-only" : "lock-only"} acquisition limit is retained`, async () => {
      const f = await fixture();
      let ran = 0;
      const body = async (tx) => { ran++; return write(f, "Refused acquisition")(tx); };
      const run = () => local ? single.$transaction(async (tx) => {
        await setSettings(tx, `${statement}ms`, `${lock}ms`, true);
        return withProjectOrder(tx, f.project.id, body);
      }) : withProjectOrder(single, f.project.id, body);
      const check = async () => holder("Project", f.project.id, async () => {
        const started = performance.now();
        const pending = outcome(run());
        await until(async () => (await waiters()).length === 1);
        const result = await pending, ms = Math.round(performance.now() - started);
        console.info("project strict acquisition", JSON.stringify({ local, statement, lock, ms, ok: result.ok, callbacks: ran }));
        assert.equal(result.ok, false, "acquisition widened the stricter timeout and ran the callback");
        assert(busy(result.error), String(result.error));
        assert(ms < 1200, `stricter acquisition took ${ms}ms`);
        assert.equal((await waiters()).length, 0);
        await stillHeld("Project", f.project.id);
        assert.equal(ran, 0);
      });
      if (local) await check(); else await session(statement, lock, check);
      assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1, "late acquisition write");
    });
  }
}

test("stricter lock-only budget bounds later model waits and rolls back preceding writes", async () => {
  const f = await fixture();
  await session(0, 140, async (configured) => {
    await holder("Task", f.task.id, async () => {
      const started = performance.now();
      let wrote = false;
      const pending = outcome(withProjectOrder(single, f.project.id, async (tx) => {
        await write(f, "Must roll back")(tx);
        wrote = true;
        return tx.task.update({ where: { id: f.task.id }, data: { title: "Must not stick" } });
      }));
      await until(async () => (await waiters()).some(({ query }) => query.includes('"Task"')));
      const result = await pending;
      const ms = Math.round(performance.now() - started);
      console.info("project strict later model", JSON.stringify({ ms, ok: result.ok }));
      assert.equal(result.ok, false, "later lock wait widened the stricter timeout");
      assert(busy(result.error), String(result.error));
      assert.equal(wrote, true);
      assert(ms < 1200);
      assert.equal((await waiters()).length, 0);
      await stillHeld("Task", f.task.id);
    });
    assert.deepEqual(await settings(single), configured);
  });
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1);
  assert.equal((await actor.task.findUnique({ where: { id: f.task.id } })).title, "Original");
});

test("later statement timeout and caller-owned later lock timeout keep their original classifications", async () => {
  const f = await fixture();
  await session(180, 0, async (configured) => {
    await holder("Task", f.task.id, async () => {
      const started = performance.now();
      await assert.rejects(withProjectOrder(single, f.project.id, async (tx) => {
        await write(f, "Canceled body")(tx);
        await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${f.task.id} FOR UPDATE`;
      }), (error) => state(error, "57014") && error.statusCode === undefined);
      assert(performance.now() - started < 1200);
      await stillHeld("Task", f.task.id);
    });
    assert.deepEqual(await settings(single), configured);
  });
  await holder("Task", f.task.id, async () => {
    await assert.rejects(single.$transaction(async (tx) => {
      await setSettings(tx, "0", "140ms", true);
      await withProjectOrder(tx, f.project.id, (db) => db.$queryRaw`SELECT id FROM "Task" WHERE id = ${f.task.id} FOR UPDATE`);
    }), (error) => state(error, "55P03") && error.statusCode === undefined);
    await stillHeld("Task", f.task.id);
  });
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1);
});

test("same backend restores nonzero session settings after commit, rollback, refusal and manual body cancellation", async () => {
  const f = await fixture();
  await session(7000, 140, async (configured) => {
    await withProjectOrder(single, f.project.id, async (tx) => assert.deepEqual(await settings(tx), configured));
    assert.deepEqual(await settings(single), configured);
    const abort = new Error("roll back body");
    await assert.rejects(withProjectOrder(single, f.project.id, async (tx) => { await write(f, "Rolled back")(tx); throw abort; }), (error) => error === abort);
    assert.deepEqual(await settings(single), configured);
    await holder("Project", f.project.id, () => assert.rejects(withProjectOrder(single, f.project.id, async () => assert.fail("refused callback")), busy));
    assert.deepEqual(await settings(single), configured);
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const canceled = outcome(withProjectOrder(single, f.project.id, async (tx) => {
      assert.equal((await settings(tx)).pid, configured.pid);
      entered();
      await tx.$queryRaw`SELECT pg_sleep(3)`;
    }));
    await Promise.race([ready, sleep(1500, undefined, { ref: false }).then(() => { throw new Error("body did not start"); })]);
    await until(async () => (await control.$queryRaw`SELECT query FROM pg_stat_activity WHERE pid = ${configured.pid}::int AND state = 'active'`)[0]?.query.includes("pg_sleep"));
    await control.$queryRaw`SELECT pg_cancel_backend(${configured.pid}::int)`;
    const result = await canceled;
    assert.equal(result.ok, false);
    assert(state(result.error, "57014") && result.error.statusCode === undefined);
    assert.deepEqual(await settings(single), configured);
    console.info("project same backend", JSON.stringify(configured));
  });
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1);
});

test("whole acquisition statement stays bounded across tuple and transaction queues", async () => {
  const f = await fixture();
  await holder("Project", f.project.id, async ({ release }) => {
    let secondReady, releaseSecond;
    const ready = new Promise((resolve) => { secondReady = resolve; });
    const finish = new Promise((resolve) => { releaseSecond = resolve; });
    const second = control.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id} FOR NO KEY UPDATE`;
      secondReady();
      await finish;
    }, { timeout: 12000 });
    const secondResult = outcome(second);
    const cap = setTimeout(releaseSecond, 9000);
    try {
      await until(async () => (await waiters()).length === 1);
      const started = performance.now();
      const pending = outcome(withProjectOrder(actor, f.project.id, async () => assert.fail("refused callback")));
      await until(async () => (await waiters()).length === 2);
      assert((await waiters()).some(({ event }) => event === "tuple"), "no tuple queue observed");
      await sleep(2800);
      release();
      await Promise.race([ready, secondResult.then(() => { throw new Error("second holder ended before acquisition"); })]);
      const result = await pending, ms = Math.round(performance.now() - started);
      console.info("project consecutive queues", JSON.stringify({ ms, ok: result.ok, waiters: (await waiters()).length }));
      assert.equal(result.ok, false);
      assert(busy(result.error));
      assert(ms >= 4700 && ms < 6500, `whole acquisition took ${ms}ms`);
      assert.equal((await waiters()).length, 0);
      await stillHeld("Project", f.project.id);
    } finally { clearTimeout(cap); releaseSecond(); await secondResult; }
  }, { maxHold: 9000 });
});

test("the default later lock cap rolls back writes while its independent holder remains", async () => {
  const f = await fixture();
  await holder("Task", f.task.id, async () => {
    const started = performance.now();
    const pending = outcome(withProjectOrder(actor, f.project.id, async (tx) => {
      await write(f, "Default cap rollback")(tx);
      return tx.task.update({ where: { id: f.task.id }, data: { title: "Blocked default body" } });
    }));
    await until(async () => (await waiters()).length === 1);
    const result = await pending, ms = Math.round(performance.now() - started);
    console.info("project default later lock", JSON.stringify({ ms, ok: result.ok }));
    assert.equal(result.ok, false);
    assert(busy(result.error));
    assert(ms >= 4700 && ms < 8000);
    assert.equal((await waiters()).length, 0);
    await stillHeld("Task", f.task.id);
  }, { maxHold: 9000 });
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1);
  assert.equal((await actor.task.findUnique({ where: { id: f.task.id } })).title, "Original");
});

test("successful release, FK inserts, scheduler-style upgrade and missing rows keep their behavior", async () => {
  const f = await fixture();
  let runs = 0;
  await holder("Project", f.project.id, async ({ release }) => {
    const pending = outcome(withProjectOrder(actor, f.project.id, async () => ++runs));
    await until(async () => (await waiters()).length === 1);
    await actor.statusColumn.create({ data: { projectId: f.project.id, name: "Compatible FK", position: 1 } });
    release();
    assert.deepEqual(await pending, { ok: true, value: 1 });
  });
  assert.equal(runs, 1);
  await actor.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id} FOR KEY SHARE`;
    assert.equal(await withProjectOrder(tx, f.project.id, async () => "upgraded"), "upgraded");
  });
  await assert.rejects(withProjectOrder(actor, crypto.randomUUID(), async () => assert.fail("missing callback")), (error) => error.statusCode === 404);
  // A waiting acquisition re-reads the row after a committed deletion.
  const empty = await actor.project.create({ data: { workspaceId: f.workspace.id, name: "Deleted while waiting" } });
  await holder("Project", empty.id, async ({ release }) => {
    const pending = outcome(withProjectOrder(actor, empty.id, async () => assert.fail("deleted callback")));
    await until(async () => (await waiters()).length === 1);
    release();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.statusCode, 404);
  }, { remove: true });
});

test("the normal body runtime permits one statement longer than the acquisition cap", async () => {
  const f = await fixture(), started = performance.now();
  await session(7000, 140, async (configured) => {
    await withProjectOrder(single, f.project.id, async (tx) => {
      assert.deepEqual(await settings(tx), configured);
      assert.deepEqual(await tx.$queryRaw`SELECT 1 AS done FROM pg_sleep(5.2)`, [{ done: 1 }]);
      await write(f, "Long legitimate body")(tx);
    });
    assert.deepEqual(await settings(single), configured);
  });
  console.info("project long body", JSON.stringify({ ms: Math.round(performance.now() - started) }));
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 2);
});

test("real task, column, subtask and template controllers refuse without writes, broadcasts or notifications", async () => {
  const f = await fixture();
  const template = await actor.taskTemplate.create({ data: { projectId: f.project.id, name: "Budget template", title: "Template task", statusId: f.status.id, assigneeIds: [], labelIds: [], subtasks: [] } });
  const target = await actor.statusColumn.create({ data: { projectId: f.project.id, name: "Target", position: 1 } });
  const events = [], answers = [];
  const server = { prisma: single, broadcast: (...args) => events.push(args), broadcastToUser: (...args) => events.push(args) };
  const reply = { status() { return this; }, send(body) { answers.push(body); return body; } };
  const request = (params, body) => ({ params, body, server, user: f.user, workspaceMember: { role: "ADMIN" }, log: { error() {} } });
  const cases = [
    () => createTaskHandler(request({ pid: f.project.id }, { title: "Refused create" }), reply),
    () => moveTaskHandler(request({ tid: f.task.id }, { statusId: target.id, position: 0 }), reply),
    () => createStatusHandler(request({ pid: f.project.id }, { name: "Refused column" }), reply),
    () => createSubtaskHandler(request({ tid: f.task.id }, { title: "Refused subtask" }), reply),
    () => createTaskFromTemplateHandler(request({ pid: f.project.id, templateId: template.id }, {}), reply),
  ];
  const counts = async () => ({
    tasks: await actor.task.count({ where: { projectId: f.project.id } }), statuses: await actor.statusColumn.count({ where: { projectId: f.project.id } }),
    subtasks: await actor.subtask.count({ where: { taskId: f.task.id } }), activity: await actor.activityLog.count({ where: { task: { projectId: f.project.id } } }),
    notifications: await actor.notification.count(), deliveries: await actor.notificationDelivery.count(),
  });
  const original = await counts();
  await session(0, 140, async () => {
    for (const call of cases) await holder("Project", f.project.id, async () => {
      await assert.rejects(call(), busy);
      await stillHeld("Project", f.project.id);
      assert.equal((await waiters()).length, 0);
    });
  });
  assert.deepEqual(await counts(), original);
  assert.equal((await actor.task.findUnique({ where: { id: f.task.id } })).statusId, f.status.id);
  assert.deepEqual(events, []);
  assert.deepEqual(answers, []);
});

test("the recurring scheduler rolls back refused occurrences and generates them once after release", async () => {
  const f = await fixture();
  const template = await actor.taskTemplate.create({ data: { projectId: f.project.id, name: "Recurring budget", title: "Recurring task", statusId: f.status.id, assigneeIds: [], labelIds: [], subtasks: [] } });
  const config = await actor.recurringTaskConfig.create({ data: { projectId: f.project.id, templateId: template.id, frequency: "DAILY", startDate: "2026-10-31", nextRunDate: "2026-10-31" } });
  const events = [], errors = [];
  const server = { broadcast: (...args) => events.push(args), log: { error: (...args) => errors.push(args), info() {} } };
  await session(0, 140, async () => {
    await holder("Project", f.project.id, async () => {
      const summary = await processRecurringTasks(single, server, { now: new Date("2026-10-31T12:00:00Z") });
      assert.equal(summary.generated, 0);
      assert.equal(summary.failed, 1);
      await stillHeld("Project", f.project.id);
    });
  });
  assert.equal(errors.length, 1);
  assert(busy(errors[0][0]));
  assert.equal(await actor.recurringTaskOccurrence.count({ where: { configId: config.id } }), 0);
  assert.equal((await actor.recurringTaskConfig.findUnique({ where: { id: config.id } })).nextRunDate, "2026-10-31");
  assert.equal(await actor.task.count({ where: { projectId: f.project.id } }), 1);
  assert.equal(events.length, 0);
  const summary = await processRecurringTasks(actor, server, { now: new Date("2026-10-31T12:00:00Z") });
  assert.equal(summary.generated, 1);
  assert.equal(summary.failed, 0);
  assert.equal(await actor.recurringTaskOccurrence.count({ where: { configId: config.id } }), 1);
  assert.equal(events.length, 1);
  assert.equal((await processRecurringTasks(actor, server, { now: new Date("2026-10-31T12:00:00Z") })).generated, 0);
});

test("all five pooled backends retain their original settings after success and refusal", async () => {
  let arrived = 0, ready, release;
  const allReady = new Promise((resolve) => { ready = resolve; });
  const finish = new Promise((resolve) => { release = resolve; });
  const cap = setTimeout(release, 2000);
  const pending = Array.from({ length: 5 }, () => actor.$transaction(async (tx) => {
    const row = await settings(tx);
    if (++arrived === 5) ready();
    await finish;
    return row;
  }));
  try {
    await Promise.race([allReady, sleep(1500, undefined, { ref: false }).then(() => { throw new Error("pool did not fill"); })]);
  } finally { clearTimeout(cap); release(); }
  const rows = await Promise.all(pending);
  assert.equal(new Set(rows.map(({ pid }) => pid)).size, 5);
  assert(rows.every(({ statement, lock }) => statement === "0" && lock === "0"), JSON.stringify(rows));
});
