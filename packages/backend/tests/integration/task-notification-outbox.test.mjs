import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { pathToFileURL } from "node:url";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to an owned migrated database");
const database = new URL(process.env.TEST_DATABASE_URL);
database.searchParams.set("connection_limit", "5");
const controlDatabase = new URL(database); controlDatabase.searchParams.set("connection_limit", "1");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-task-outbox-"));
Object.assign(process.env, {
  DATABASE_URL: database.href, TEST_DATABASE_URL: database.href,
  NODE_ENV: "test", LOG_LEVEL: "error", STORAGE_DIR: storageDir,
  JWT_SECRET: "task-outbox-only-local-jwt-secret", COOKIE_SECRET: "task-outbox-only-local-cookie-secret",
});
const backend = process.cwd();
const load = (p) => import(pathToFileURL(path.join(backend, p)).href);
const { PrismaClient } = createRequire(path.join(backend, "package.json"))("@prisma/client");
const { buildApp } = await load("src/app.ts");
const { signAccessToken } = await load("src/utils/tokens.ts");
const { startRefreshSession } = await load("src/modules/auth/refresh-sessions.ts");
const { processDueNotificationDeliveries } = await load("src/modules/notifications/notification-delivery.ts");
const { createApiKey } = await load("src/modules/api-keys/api-keys.service.ts");
const tasksService = await load("src/modules/tasks/tasks.service.ts");
const { openRawSocket } = await load("tests/integration/support/raw-websocket.mjs");
const BARRIER = 638_115_078;
const fixtures = [], observations = [], broadcasts = [];
const children = new Map();
const sockets = new Set(), requestErrors = [];
let app, control, port;
let broadcastFailure, throwAfterToast = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, budget = 3000) {
  const end = Date.now() + budget;
  for (;;) { if (await check()) return; assert(Date.now() < end, `Timed out waiting for ${label}`); await sleep(10); }
}
const scope = (projectId) => ({ data: { path: ["projectId"], equals: projectId } });
function observe(t, label, value) { observations.push({ label, ...value }); t.diagnostic(JSON.stringify({ label, ...value })); }
async function fixture(label, { assigned = true } = {}) {
  const suffix = crypto.randomBytes(5).toString("hex");
  async function user(name, role) {
    const row = await app.prisma.user.create({ data: {
      email: `task-${name}-${suffix}@example.test`, displayName: `${name} ${suffix}`, emailVerified: true,
    } });
    const { familyId } = await startRefreshSession(app.prisma, row.id);
    return { ...row, role, token: signAccessToken({ sub: row.id, email: row.email, sid: familyId }) };
  }
  const actor = await user("Actor", "ADMIN"), peer = await user("Peer", "MEMBER"), viewer = await user("Viewer", "VIEWER");
  const users = [actor, peer, viewer];
  const workspace = await app.prisma.workspace.create({ data: {
    name: `Tasks ${label}`, slug: `task-outbox-${suffix}`,
    members: { create: users.map((u) => ({ userId: u.id, role: u.role })) },
  } });
  const project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: `Project ${label}`,
    members: { create: users.slice(1).map((u) => ({ userId: u.id })) },
    statuses: { create: [{ name: "Open", position: 0 }, { name: "Review", position: 1 }, { name: "Done", position: 2, isCompletion: true }] },
  }, include: { statuses: true } });
  const status = Object.fromEntries(project.statuses.map((s) => [s.name, s]));
  const task = await app.prisma.task.create({ data: {
    projectId: project.id, statusId: status.Open.id, title: `Task ${label}`,
    ...(assigned ? { assignees: { create: { userId: peer.id } } } : {}),
  } });
  const f = { actor, peer, viewer, users, workspace, project, status, task }; fixtures.push(f); return f;
}
async function state(f) {
  return {
    tasks: await app.prisma.task.findMany({ where: { projectId: f.project.id }, orderBy: { id: "asc" },
      select: { id: true, title: true, statusId: true, position: true, assignees: { select: { userId: true }, orderBy: { userId: "asc" } } } }),
    activity: await app.prisma.activityLog.count({ where: { task: { projectId: f.project.id } } }),
    outbox: await app.prisma.notificationDelivery.count({ where: scope(f.project.id) }),
    notifications: await app.prisma.notification.count({ where: scope(f.project.id) }),
    enqueued: Number((await app.prisma.$queryRaw`SELECT count(*)::int AS count FROM tno_audit WHERE "projectId" = ${f.project.id}`)[0].count),
    broadcasts: broadcasts.filter((e) => e[0] === f.project.id).length,
  };
}
async function mutate(f, operation, { targetPort = port, token = f.actor.token, data } = {}) {
  const method = operation === "status" || operation === "move" ? "PATCH" : "POST";
  const suffix = { status: "", move: "/move", assign: "/assignees", duplicate: "/duplicate" }[operation];
  const body = data ?? { status: { statusId: f.status.Review.id }, move: { statusId: f.status.Review.id, position: 0 }, assign: { userId: f.peer.id } }[operation];
  const response = await fetch(`http://127.0.0.1:${targetPort}/api/tasks/${f.task.id}${suffix}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
  });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function hook(f, kind, stage = "NotificationDelivery") {
  await app.prisma.$executeRaw`INSERT INTO tno_hook ("projectId", stage, kind) VALUES (${f.project.id}, ${stage}, ${kind})
    ON CONFLICT ("projectId", stage) DO UPDATE SET kind = EXCLUDED.kind`;
}
async function unhook(f) { await app.prisma.$executeRaw`DELETE FROM tno_hook WHERE "projectId" = ${f.project.id}`; }
async function faults() {
  const [row] = await app.prisma.$queryRawUnsafe('SELECT last_value, is_called FROM tno_faults');
  return row.is_called ? Number(row.last_value) : 0;
}
async function holdProject(f) {
  let ready, release;
  const acquired = new Promise((resolve) => { ready = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const run = control.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id} FOR NO KEY UPDATE`;
    ready(); await released;
  }, { timeout: 8000, maxWait: 1000 });
  await Promise.race([acquired, run]);
  return async () => { release(); await run; };
}
async function projectWaiters() {
  return app.prisma.$queryRawUnsafe(`SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
      AND query LIKE '%FROM "Project"%' AND query LIKE '%FOR NO KEY UPDATE%'`);
}
async function holdBarrier() {
  let ready, release;
  const acquired = new Promise((resolve) => { ready = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const run = control.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${BARRIER})`);
    ready(); await released;
  }, { timeout: 8000, maxWait: 1000 });
  await Promise.race([acquired, run]);
  return async () => { release(); await run; };
}
async function barrierWaiters() {
  return app.prisma.$queryRawUnsafe(`SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND objid = ${BARRIER} AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
}
async function socketFor(targetPort, token) {
  const socket = await openRawSocket(targetPort); sockets.add(socket);
  try {
    socket.sendJSON({ type: "auth", token });
    await socket.next((m) => m.event === "authenticated");
    return socket;
  } catch (error) { closeSocket(socket); throw error; }
}
function closeSocket(socket) { socket?.socket.destroy(); sockets.delete(socket); }
async function startChild(mode) {
  const source = path.join(backend, "tests/integration/support/task-outbox-worker.mjs");
  const child = spawn(process.execPath, ["--import", "tsx", source, mode], {
    cwd: backend, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = []; let output = "", exit;
  child.stdout.on("data", (chunk) => { if (output.length < 65536) output += chunk; });
  child.stderr.on("data", (chunk) => { if (output.length < 65536) output += chunk; });
  child.on("message", (message) => messages.push(message));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    exit = { code, signal }; children.delete(child); resolve(exit);
  }));
  children.set(child, exited);
  try {
    await waitFor(() => {
      assert(!exit, `Owned fixture exited before ready: ${output}`);
      return messages.some((m) => m.type === "ready");
    }, "owned server ready", 5000);
  } catch (error) { child.kill("SIGKILL"); await exited; throw error; }
  return { child, messages, exited, get exit() { return exit; }, port: messages.find((m) => m.type === "ready").port,
    async drain() {
      const id = crypto.randomUUID(); child.send({ type: "drain", id });
      await waitFor(() => messages.some((m) => m.type === "drained" && m.id === id), "actual fresh worker pass", 5000);
    },
    async stop() {
      if (exit) return;
      child.send({ type: "stop" }); await waitFor(() => exit, "owned server stop", 3000);
    } };
}

before(async () => {
  app = await buildApp();
  const broadcast = app.broadcast.bind(app);
  app.broadcast = (...args) => {
    broadcasts.push(args);
    if (broadcastFailure) throw broadcastFailure;
    return broadcast(...args);
  };
  const broadcastUser = app.broadcastToUser.bind(app);
  app.broadcastToUser = (...args) => {
    const result = broadcastUser(...args);
    if (throwAfterToast && args[1] === "notification_new") {
      throwAfterToast = false;
      throw new Error("synthetic post-toast callback failure");
    }
    return result;
  };
  app.addHook("onRequest", async (request) => {
    const logError = request.log.error.bind(request.log);
    request.log.error = (...args) => { requestErrors.push(args); logError(...args); };
  });
  await app.listen({ host: "127.0.0.1", port: 0 }); port = app.server.address().port;
  control = new PrismaClient({ datasources: { db: { url: controlDatabase.href } } });
  await app.prisma.$executeRawUnsafe('CREATE TABLE tno_hook ("projectId" text NOT NULL, stage text NOT NULL, kind text NOT NULL, PRIMARY KEY ("projectId", stage))');
  await app.prisma.$executeRawUnsafe('CREATE TABLE tno_audit (id text PRIMARY KEY, "projectId" text NOT NULL, "taskId" text, type text)');
  await app.prisma.$executeRawUnsafe('CREATE SEQUENCE tno_faults');
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION tno_hook() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE item jsonb := to_jsonb(NEW); scoped_project text; active record;
    BEGIN
      IF TG_TABLE_NAME = 'ActivityLog' THEN
        SELECT "projectId" INTO scoped_project FROM "Task" WHERE id = item->>'taskId';
      ELSE scoped_project := item->'data'->>'projectId'; END IF;
      SELECT * INTO active FROM tno_hook WHERE "projectId" = scoped_project AND stage = TG_TABLE_NAME;
      IF FOUND THEN
        IF active.kind = 'fault' THEN PERFORM nextval('tno_faults'); RAISE EXCEPTION 'synthetic task outbox fault';
        ELSIF active.kind = 'barrier' THEN PERFORM pg_advisory_xact_lock(${BARRIER}); END IF;
      END IF;
      RETURN NEW;
    END $$`);
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION tno_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO tno_audit (id, "projectId", "taskId", type)
      VALUES (NEW.id, NEW.data->>'projectId', NEW.data->>'taskId', NEW.type::text); RETURN NEW; END $$`);
  for (const table of ["NotificationDelivery", "ActivityLog", "Notification"]) {
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER tno_hook BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION tno_hook()`);
  }
  await app.prisma.$executeRawUnsafe('CREATE TRIGGER tno_audit AFTER INSERT ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION tno_audit()');
});

after(async () => {
  for (const socket of sockets) closeSocket(socket);
  for (const [child] of children) child.kill("SIGKILL");
  await Promise.allSettled([...children.values()]);
  if (app) {
    await app.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS tno_audit ON "NotificationDelivery"');
    for (const table of ["NotificationDelivery", "ActivityLog", "Notification"]) await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS tno_hook ON "${table}"`);
    await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS tno_hook()');
    await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS tno_audit()');
    await app.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS tno_hook');
    await app.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS tno_audit');
    await app.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS tno_faults');
    for (const f of fixtures) {
      await app.prisma.notificationDelivery.deleteMany({ where: scope(f.project.id) });
      await app.prisma.notification.deleteMany({ where: scope(f.project.id) });
    }
    await app.prisma.workspace.deleteMany({ where: { id: { in: fixtures.map((f) => f.workspace.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => f.users.map((u) => u.id)) } } });
  }
  await control?.$disconnect(); await app?.close();
  await rm(storageDir, { recursive: true, force: true });
  if (process.env.TASK_OUTBOX_OBSERVATIONS) await writeFile(process.env.TASK_OUTBOX_OBSERVATIONS, JSON.stringify(observations, null, 2) + "\n");
});

for (const operation of ["status", "move", "assign", "duplicate"]) {
  test(`${operation} enqueue failure rolls back its mutation and activity without a success broadcast`, async (t) => {
    const f = await fixture(`enqueue-${operation}`, { assigned: operation !== "assign" });
    const before = await state(f), initialFaults = await faults();
    await hook(f, "fault");
    try {
      const response = await mutate(f, operation);
      await waitFor(async () => await faults() > initialFaults, "actual outbox fault");
      const after = await state(f);
      observe(t, operation, { responseStatus: response.status, before, after, faults: (await faults()) - initialFaults });
      assert.equal(response.status, 500); assert.deepEqual(after, before);
    } finally { await unhook(f); }
  });
}

test("two queued status requests produce one intent for the actual locked transition", async (t) => {
  const f = await fixture("same-target"); const release = await holdProject(f);
  let first, second;
  try {
    first = mutate(f, "status");
    await waitFor(async () => (await projectWaiters()).length === 1, "first Project waiter");
    second = mutate(f, "status");
    await waitFor(async () => (await projectWaiters()).length === 2, "second Project waiter");
    const queue = await projectWaiters(); assert(queue.every((row) => row.blockers.length > 0));
    await release();
    const responses = await Promise.all([first, second]); assert.deepEqual(responses.map((r) => r.status), [200, 200]);
    await waitFor(async () => await app.prisma.notification.count({ where: scope(f.project.id) }) > 0, "first actual notification");
    await processDueNotificationDeliveries(app.prisma, app, { log: app.log });
    await waitFor(async () => await app.prisma.notificationDelivery.count({ where: scope(f.project.id) }) === 0, "completed first delivery attempts");
    const after = await state(f); observe(t, "same-target", { queue, after });
    assert.equal(after.activity, 1); assert.equal(after.enqueued, 1); assert.equal(after.notifications, 1);
    assert.equal(after.tasks[0].statusId, f.status.Review.id);
  } finally { await release(); await Promise.allSettled([first, second].filter(Boolean)); }
});

test("death in the supplied postcommit callback retains recoverable duplicate intent", async (t) => {
  const f = await fixture("postcommit-death"); const child = await startChild("kill-after-commit");
  try {
    const response = mutate(f, "duplicate", { targetPort: child.port }).catch(() => null);
    await waitFor(() => child.exit, "owned callback SIGKILL", 5000);
    const exit = await child.exited; await response; assert.equal(exit.signal, "SIGKILL");
    const after = await state(f);
    observe(t, "postcommit-death", { exit, after, callbackCutoff: "before normal broadcast or notify; no frame claim" });
    assert.equal(after.tasks.length, 2); assert.equal(after.activity, 1);
    assert.equal(after.outbox, 1); assert.equal(after.enqueued, 1); assert.equal(after.notifications, 0);
  } finally { await child.stop(); }
});

test("same-status update and same-column move create no status notification", async (t) => {
  const f = await fixture("same-status");
  const update = await mutate(f, "status", { data: { statusId: f.status.Open.id } });
  const move = await mutate(f, "move", { data: { statusId: f.status.Open.id, position: 0 } });
  assert.deepEqual([update.status, move.status], [200, 200]);
  const after = await state(f); observe(t, "same-status-control", { after });
  assert.equal(after.activity, 0); assert.equal(after.enqueued, 0); assert.equal(after.notifications, 0); assert.equal(after.broadcasts, 2);
});

test("unauthenticated and viewer task notification mutations retain denial with no effects", async (t) => {
  const f = await fixture("denial", { assigned: false }); const before = await state(f);
  for (const operation of ["status", "move", "assign", "duplicate"]) {
    assert.equal((await mutate(f, operation, { token: null })).status, 401);
    assert.equal((await mutate(f, operation, { token: f.viewer.token })).status, 403);
  }
  const after = await state(f); observe(t, "denial-control", { before, after }); assert.deepEqual(after, before);
});

test("extra: process death during blocked enqueue rolls back the whole duplicate", async (t) => {
  const f = await fixture("precommit-death");
  await app.prisma.subtask.create({ data: { taskId: f.task.id, title: "Copied atomically" } });
  const before = await state(f), release = await holdBarrier();
  let child, request;
  try {
    await hook(f, "barrier");
    child = await startChild("server");
    request = mutate(f, "duplicate", { targetPort: child.port }).catch(() => null);
    await waitFor(async () => (await barrierWaiters()).length === 1, "actual enqueue barrier");
    const [waiter] = await barrierWaiters();
    assert.deepEqual(await state(f), before);
    child.child.kill("SIGKILL");
    await waitFor(() => child.exit, "owned precommit process death", 5000);
    await release();
    await waitFor(async () => (await app.prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE pid = ${waiter.pid}`).length === 0, "killed backend rollback");
    await request;
    const after = await state(f);
    observe(t, "precommit-death", { before, after, waiterPid: waiter.pid, exit: child.exit });
    assert.deepEqual(after, before);
    assert.equal(await app.prisma.subtask.count({ where: { task: { projectId: f.project.id } } }), 1);
  } finally {
    await release(); await unhook(f); await child?.stop();
    await Promise.allSettled([request].filter(Boolean));
  }
});

test("extra: fresh actual worker recovers a committed status intent with one socket toast", async (t) => {
  const f = await fixture("worker-recovery");
  const dying = await startChild("kill-after-commit");
  let fresh, peer;
  try {
    const request = mutate(f, "status", { targetPort: dying.port }).catch(() => null);
    await waitFor(() => dying.exit, "owned postcommit process death", 5000);
    await request;
    const committed = await state(f);
    assert.equal(committed.activity, 1); assert.equal(committed.outbox, 1); assert.equal(committed.notifications, 0);
    fresh = await startChild("retry");
    peer = await socketFor(fresh.port, f.peer.token);
    await fresh.drain();
    const toast = await peer.next((m) => m.event === "notification_new");
    assert.equal(toast.data.type, "TASK_STATUS_CHANGED");
    assert.equal(toast.data.data.taskId, f.task.id);
    await fresh.drain(); await peer.drain(80);
    assert.equal(peer.inbox.filter((m) => m.event === "notification_new").length, 0);
    const after = await state(f);
    assert.equal(after.notifications, 1); assert.equal(after.outbox, 0);
    observe(t, "worker-recovery", { committed, after, actualReceivedToast: toast.data.id,
      worker: "fresh actual worker.run; no elapsed interval or lease claim" });
  } finally { closeSocket(peer); await fresh?.stop(); await dying.stop(); }
});

for (const operation of ["status", "move", "assign", "duplicate"]) {
  test(`extra: ${operation} preserves public DTO and exact notification payload with an API key`, async (t) => {
    const f = await fixture(`payload-${operation}`, { assigned: operation !== "assign" });
    await app.prisma.taskAssignee.create({ data: { taskId: f.task.id, userId: f.actor.id } });
    const actorName = `Current actor ${operation}`;
    await app.prisma.user.update({ where: { id: f.actor.id }, data: { displayName: actorName } });
    const credential = await createApiKey(app.prisma, f.actor.id, { name: "Owned integration", expiresInDays: 1 });
    const response = await mutate(f, operation, { token: credential.key });
    assert.equal(response.status, ["status", "move"].includes(operation) ? 200 : 201);
    assert.deepEqual(Object.keys(response.body), ["data"]);
    const result = response.body.data;
    assert.equal(Object.hasOwn(result, "result"), false);
    assert.equal(Object.hasOwn(result, "notificationDeliveryIds"), false);
    const taskId = operation === "duplicate" ? result.id : f.task.id;
    const title = operation === "duplicate" ? `Copy of ${f.task.title}` : f.task.title;
    if (operation === "assign") {
      assert.equal(result.userId, f.peer.id); assert.equal(result.taskId, f.task.id);
      assert.equal(Object.hasOwn(result, "projectId"), false);
    } else { assert.equal(result.projectId, f.project.id); assert.equal(result.title, title); }
    await waitFor(async () => await app.prisma.notification.count({ where: scope(f.project.id) }) === 1, "real payload notification");
    await waitFor(async () => await app.prisma.notificationDelivery.count({ where: scope(f.project.id) }) === 0, "completed payload delivery");
    const [notification] = await app.prisma.notification.findMany({ where: scope(f.project.id) });
    const statusChange = operation === "status" || operation === "move";
    assert.equal(notification.userId, f.peer.id);
    assert.equal(notification.type, statusChange ? "TASK_STATUS_CHANGED" : "TASK_ASSIGNED");
    assert.equal(notification.title, statusChange ? `"${title}" moved to Review` : `You were assigned to "${title}"`);
    assert.equal(notification.body, statusChange ? `${actorName} changed the status`
      : operation === "assign" ? `${actorName} assigned you to this task` : `${actorName} duplicated a task and assigned you`);
    assert.deepEqual(notification.data, {
      taskId, projectId: f.project.id, actorId: f.actor.id, actorName, taskTitle: title,
      ...(operation === "assign" ? { projectName: f.project.name } : {}),
    });
    observe(t, `payload-${operation}`, { status: response.status, dataKeys: Object.keys(result), notificationType: notification.type });
  });
}

test("extra: existing service exports retain their DTOs and commit intents without external delivery", async (t) => {
  for (const operation of ["status", "move", "assign", "duplicate"]) {
    const f = await fixture(`service-${operation}`, { assigned: operation !== "assign" });
    const actorName = `Direct actor ${operation}`;
    await app.prisma.user.update({ where: { id: f.actor.id }, data: { displayName: actorName } });
    const result = await {
      status: () => tasksService.updateTask(app.prisma, f.task.id, f.actor.id, "VIEWER", { statusId: f.status.Review.id }),
      move: () => tasksService.moveTask(app.prisma, f.task.id, f.actor.id, { statusId: f.status.Review.id, position: 0 }),
      assign: () => tasksService.addAssignee(app.prisma, f.task.id, f.actor.id, "VIEWER", { userId: f.peer.id }),
      duplicate: () => tasksService.duplicateTask(app.prisma, f.task.id, f.actor.id),
    }[operation]();
    assert.equal(typeof result.id, "string");
    assert.equal(Object.hasOwn(result, "result"), false);
    assert.equal(Object.hasOwn(result, "notificationDeliveryIds"), false);
    if (operation === "assign") { assert.equal(result.userId, f.peer.id); assert.equal(Object.hasOwn(result, "projectId"), false); }
    else { assert.equal(result.projectId, f.project.id); assert.equal(result.statusId, operation === "duplicate" ? f.status.Open.id : f.status.Review.id); }
    if (operation === "move") assert.equal(Object.hasOwn(result, "warning"), true);
    const committed = await state(f);
    assert.equal(committed.outbox, 1); assert.equal(committed.notifications, 0); assert.equal(committed.broadcasts, 0);
    const [intent] = await app.prisma.notificationDelivery.findMany({ where: scope(f.project.id) });
    assert.equal(intent.data.actorName, actorName); assert.equal(intent.attempts, 0);
    await processDueNotificationDeliveries(app.prisma, app, { log: app.log });
    assert.equal((await state(f)).notifications, 1); assert.equal((await state(f)).outbox, 0);
    observe(t, `service-${operation}`, { resultKeys: Object.keys(result), committed });
  }
});

test("extra: delivery retains recipient preferences and actor exclusion", async () => {
  const f = await fixture("preferences");
  await app.prisma.taskAssignee.create({ data: { taskId: f.task.id, userId: f.actor.id } });
  await app.prisma.notificationPreference.create({ data: { userId: f.peer.id, taskStatusChanged: false } });
  const response = await mutate(f, "status"); assert.equal(response.status, 200);
  await waitFor(async () => (await state(f)).outbox === 0, "preference-filtered completion");
  const after = await state(f);
  assert.equal(after.enqueued, 1); assert.equal(after.notifications, 0); assert.equal(after.activity, 1);
});

test("extra: a deferred intent cannot notify an assignee who lost project access", async () => {
  const f = await fixture("revoked-before-delivery");
  const committed = await tasksService.updateTaskWithNotifications(
    app.prisma, f.task.id, f.actor.id, "ADMIN", { statusId: f.status.Review.id }, f.actor.displayName,
  );
  assert.equal(committed.notificationDeliveryIds.length, 1);
  assert.equal(committed.result.id, f.task.id); assert.equal(committed.projectId, f.project.id);
  assert.equal((await state(f)).outbox, 1);
  // Isolate delivery's current-authority boundary, rather than removal's assignment cleanup.
  await app.prisma.projectMember.delete({ where: { projectId_userId: { projectId: f.project.id, userId: f.peer.id } } });
  await processDueNotificationDeliveries(app.prisma, app, { log: app.log });
  assert.equal((await state(f)).notifications, 0); assert.equal((await state(f)).outbox, 0);
});

test("extra: optional first-delivery insert failure keeps truthful success and durable retry", async (t) => {
  const f = await fixture("delivery-failure", { assigned: false });
  await hook(f, "fault", "Notification");
  try {
    const response = await mutate(f, "assign"); assert.equal(response.status, 201);
    await waitFor(async () => {
      const [row] = await app.prisma.notificationDelivery.findMany({ where: scope(f.project.id) });
      return row?.attempts === 1 && row.lockedUntil === null;
    }, "recorded delivery failure");
    const afterFailure = await state(f);
    assert.equal(afterFailure.activity, 1); assert.equal(afterFailure.outbox, 1); assert.equal(afterFailure.notifications, 0);
    assert(afterFailure.tasks[0].assignees.some((a) => a.userId === f.peer.id));
    await unhook(f);
    // Explicit logical due time exercises the real retry primitive, not elapsed wall time.
    const now = new Date(Date.now() + 60_000);
    await processDueNotificationDeliveries(app.prisma, app, { log: app.log, now });
    await processDueNotificationDeliveries(app.prisma, app, { log: app.log, now });
    const after = await state(f);
    assert.equal(after.notifications, 1); assert.equal(after.outbox, 0);
    observe(t, "first-delivery-recovery", { afterFailure, after, logicalDuePass: true });
  } finally { await unhook(f); }
});

test("extra: retry after an actually received toast does not repeat that toast", async () => {
  const f = await fixture("post-toast"); const peer = await socketFor(port, f.peer.token);
  try {
    throwAfterToast = true;
    assert.equal((await mutate(f, "duplicate")).status, 201);
    const first = await peer.next((m) => m.event === "notification_new");
    await waitFor(async () => {
      const [row] = await app.prisma.notificationDelivery.findMany({ where: scope(f.project.id) });
      return row?.notifiedAt !== null && row?.attempts === 1 && row.lockedUntil === null;
    }, "pending post-toast failure");
    await processDueNotificationDeliveries(app.prisma, app, { log: app.log, now: new Date(Date.now() + 60_000) });
    const refresh = await peer.next((m) => m.event === "notification_created");
    assert.deepEqual(refresh.data, { id: first.data.id });
    await peer.drain(80);
    assert.equal(peer.inbox.filter((m) => m.event === "notification_new").length, 0);
    assert.equal((await state(f)).notifications, 1); assert.equal((await state(f)).outbox, 0);
  } finally { throwAfterToast = false; closeSocket(peer); }
});

const PRIVATE_DIAGNOSTIC = "task-private-diagnostic-canary";
let getterReads = 0;
const diagnosticCases = [
  { label: "builtin and known code", make: () => Object.assign(new TypeError(PRIVATE_DIAGNOSTIC), { code: "EPIPE" }), kind: "type_error", code: "EPIPE" },
  { label: "unknown code", make: () => Object.assign(new Error(PRIVATE_DIAGNOSTIC), { code: "PRIVATE_CODE" }), kind: "error" },
  { label: "accessors", make: () => {
    const error = new TypeError();
    for (const key of ["name", "message", "stack", "cause", "code"]) Object.defineProperty(error, key, {
      configurable: true, get() { getterReads++; return PRIVATE_DIAGNOSTIC; },
    });
    return error;
  }, kind: "type_error" },
  { label: "thrown value", make: () => PRIVATE_DIAGNOSTIC, kind: "unknown" },
  { label: "uninspectable value", make: () => new Proxy({}, { getPrototypeOf() { throw new Error(PRIVATE_DIAGNOSTIC); } }), kind: "unknown" },
];
for (const item of diagnosticCases) {
  test(`extra: postcommit ${item.label} diagnostic stays useful and private`, async () => {
    const f = await fixture(`diagnostic-${item.label}`);
    try {
      const beforeGetters = getterReads;
      broadcastFailure = item.make();
      const response = await mutate(f, "status");
      broadcastFailure = undefined;
      assert.equal(response.status, 200);
      const entry = requestErrors.findLast(([obj]) => obj?.stage === "task_broadcast" && obj.taskId === f.task.id)?.[0];
      assert(entry);
      assert.deepEqual(entry, { stage: "task_broadcast", operation: "update", taskId: f.task.id,
        errorKind: item.kind, ...(item.code ? { errorCode: item.code } : {}) });
      assert.equal(JSON.stringify(entry).includes(PRIVATE_DIAGNOSTIC), false);
      assert.equal(getterReads, beforeGetters);
      await waitFor(async () => (await state(f)).notifications === 1 && (await state(f)).outbox === 0, "durable delivery after failed broadcast");
      assert.equal((await state(f)).activity, 1);
    } finally { broadcastFailure = undefined; }
  });
}
