import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to an owned migrated database');
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (file) => import(pathToFileURL(path.join(backend, file)).href);
const database = new URL(process.env.TEST_DATABASE_URL);
database.searchParams.set('connection_limit', '5');
const controlDatabase = new URL(database);
controlDatabase.searchParams.set('connection_limit', '1');
const storageDir = await mkdtemp(path.join(os.tmpdir(), 'werkyn-template-intent-'));
Object.assign(process.env, {
  TEST_DATABASE_URL: database.toString(), DATABASE_URL: database.toString(),
  NODE_ENV: 'test', LOG_LEVEL: 'error', STORAGE_DIR: storageDir,
  JWT_SECRET: 'template-intent-only-local-jwt-secret',
  COOKIE_SECRET: 'template-intent-only-local-cookie-secret',
});
const { PrismaClient } = await import('@prisma/client');
const { buildApp } = await load('src/app.ts');
const { signAccessToken } = await load('src/utils/tokens.ts');
const { startRefreshSession } = await load('src/modules/auth/refresh-sessions.ts');
const { openRawSocket } = await load('tests/integration/support/raw-websocket.mjs');
const templates = await load('src/modules/templates/templates.service.ts');
const { createApiKey } = await load('src/modules/api-keys/api-keys.service.ts');
const { processRecurringTasks } = await load('src/schedulers/recurring-tasks.ts');
const { processDueNotificationDeliveries } = await load('src/modules/notifications/notification-delivery.ts');
const BARRIER = 552871207;
const fixtures = [];
const children = new Map();
const sockets = new Set();
const broadcasts = [];
const loggedErrors = [];
let app, control, port, broadcastFailure;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert(Date.now() < end, 'Timed out waiting for ' + label);
    await sleep(10);
  }
}
const scope = (f) => ({ data: { path: ['projectId'], equals: f.project.id } });
async function counts(f) {
  return {
    tasks: await app.prisma.task.count({ where: { projectId: f.project.id } }),
    subtasks: await app.prisma.subtask.count({ where: { task: { projectId: f.project.id } } }),
    activity: await app.prisma.activityLog.count({ where: { task: { projectId: f.project.id } } }),
    outbox: await app.prisma.notificationDelivery.count({ where: scope(f) }),
    notifications: await app.prisma.notification.count({ where: scope(f) }),
  };
}
async function post(f, body = {}, { targetPort = port, actor = f.actor } = {}) {
  const response = await fetch('http://127.0.0.1:' + targetPort + '/api/projects/' + f.project.id + '/templates/' + f.template.id + '/create-task', {
    method: 'POST', headers: { authorization: 'Bearer ' + actor.token, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() };
}
async function fixture(label) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const user = async (name, role) => {
    const row = await app.prisma.user.create({ data: { email: 'template-' + label + '-' + name + '-' + suffix + '@example.test', displayName: name + ' ' + suffix, emailVerified: true } });
    const { familyId } = await startRefreshSession(app.prisma, row.id);
    return { ...row, role, token: signAccessToken({ sub: row.id, email: row.email, sid: familyId }) };
  };
  const actor = await user('Author', 'ADMIN');
  const peer = await user('Assignee', 'MEMBER');
  const viewer = await user('Viewer', 'VIEWER');
  const users = [actor, peer, viewer];
  const workspace = await app.prisma.workspace.create({ data: { name: 'Template ' + label, slug: 'template-' + suffix, members: { create: users.map((u) => ({ userId: u.id, role: u.role })) } } });
  const project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: 'Project ' + label, members: { create: [peer, viewer].map((u) => ({ userId: u.id })) }, statuses: { create: { name: 'Todo' } } }, include: { statuses: true } });
  const template = await app.prisma.taskTemplate.create({ data: { projectId: project.id, name: 'Template ' + label, title: 'Task ' + label, description: '<p>Template content</p>', priority: 'HIGH', statusId: project.statuses[0].id, dueOffset: 2, assigneeIds: [peer.id], subtasks: [{ title: 'First' }, { title: 'Second' }] } });
  const f = { actor, peer, viewer, users, workspace, project, template };
  fixtures.push(f);
  return f;
}

async function hook(f, stage, kind) {
  await app.prisma.$executeRawUnsafe('INSERT INTO "template_intent_hook" ("projectId", "stage", "kind") VALUES ($1,$2,$3) ON CONFLICT ("projectId", "stage") DO UPDATE SET "kind"=EXCLUDED."kind"', f.project.id, stage, kind);
}
async function unhook(f) {
  await app.prisma.$executeRawUnsafe('DELETE FROM "template_intent_hook" WHERE "projectId"=$1', f.project.id);
}
async function faults() {
  const [row] = await app.prisma.$queryRawUnsafe('SELECT "last_value", "is_called" FROM "template_intent_faults"');
  return row.is_called ? Number(row.last_value) : 0;
}
async function holdBarrier() {
  let release, ready;
  const released = new Promise((resolve) => { release = resolve; });
  const acquired = new Promise((resolve) => { ready = resolve; });
  const run = control.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(' + BARRIER + ')');
    ready();
    await released;
  }, { timeout: 8000, maxWait: 1000 });
  await Promise.race([acquired, run]);
  return async () => { release(); await run; };
}
async function waitingBackends() {
  return app.prisma.$queryRawUnsafe("SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=" + BARRIER + " AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
}
async function startChild(mode) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(backend, 'tests/integration/support/template-outbox-worker.mjs'), mode], {
    cwd: backend, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '', exit;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    exit = { code, signal }; children.delete(child); resolve(exit);
  }));
  children.set(child, exited);
  try {
    await waitFor(() => {
      assert(!exit, 'Owned worker exited before ready: ' + output);
      return messages.some((m) => m.type === 'ready');
    }, 'owned worker ready', 5000);
  } catch (error) {
    if (!exit) child.kill('SIGKILL');
    await exited;
    throw error;
  }
  return {
    child, messages, exited, port: messages.find((m) => m.type === 'ready').port,
    async stop() {
      if (exit) return;
      child.send({ type: 'stop' });
      try { await waitFor(() => exit, 'owned worker stop', 3000); }
      finally { if (!exit) child.kill('SIGKILL'); await exited; }
    },
    async drain() {
      const id = crypto.randomUUID(); child.send({ type: 'drain', id });
      await waitFor(() => messages.some((m) => m.id === id && m.type === 'drained'), 'fresh worker pass', 5000);
    },
  };
}
function closeSocket(socket) {
  socket?.socket.destroy(); sockets.delete(socket);
}
async function socketFor(targetPort, token) {
  const socket = await openRawSocket(targetPort);
  sockets.add(socket);
  try {
    socket.sendJSON({ type: 'auth', token });
    await socket.next((message) => message.event === 'authenticated');
    return socket;
  } catch (error) { closeSocket(socket); throw error; }
}

before(async () => {
  app = await buildApp();
  app.addHook('onRequest', async (request) => {
    const error = request.log.error.bind(request.log);
    request.log.error = (...args) => { loggedErrors.push(args); error(...args); };
  });
  const broadcast = app.broadcast.bind(app);
  app.broadcast = (...args) => {
    broadcasts.push(args);
    if (args[1] === 'task_created' && broadcastFailure) throw broadcastFailure;
    return broadcast(...args);
  };
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = app.server.address().port;
  control = new PrismaClient({ datasources: { db: { url: controlDatabase.toString() } } });
  await app.prisma.$executeRawUnsafe('CREATE TABLE "template_intent_hook" ("projectId" TEXT NOT NULL, "stage" TEXT NOT NULL, "kind" TEXT NOT NULL, PRIMARY KEY ("projectId", "stage"))');
  await app.prisma.$executeRawUnsafe('CREATE SEQUENCE "template_intent_faults"');
  await app.prisma.$executeRawUnsafe('CREATE FUNCTION template_intent_hook() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE item jsonb := to_jsonb(NEW); project_id text; active record; BEGIN project_id := item->\'data\'->>\'projectId\'; SELECT * INTO active FROM "template_intent_hook" WHERE "projectId"=project_id AND "stage"=TG_TABLE_NAME; IF FOUND THEN IF active."kind"=\'fault\' THEN PERFORM nextval(\'"template_intent_faults"\'); RAISE EXCEPTION \'synthetic template intent fault\'; ELSIF active."kind"=\'barrier\' THEN PERFORM pg_advisory_xact_lock(' + BARRIER + '); END IF; END IF; RETURN NEW; END $$');
  for (const table of ['NotificationDelivery', 'Notification']) {
    await app.prisma.$executeRawUnsafe('CREATE TRIGGER "template_intent_hook" BEFORE INSERT ON "' + table + '" FOR EACH ROW EXECUTE FUNCTION template_intent_hook()');
  }
});

after(async () => {
  for (const socket of sockets) closeSocket(socket);
  const exits = [...children.values()];
  for (const child of children.keys()) child.kill('SIGKILL');
  await Promise.allSettled(exits);
  try {
    if (app) {
      for (const table of ['NotificationDelivery', 'Notification']) {
        await app.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "template_intent_hook" ON "' + table + '"');
      }
      await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS template_intent_hook()');
      await app.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "template_intent_hook"');
      await app.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS "template_intent_faults"');
      for (const f of fixtures) {
        await app.prisma.notificationDelivery.deleteMany({ where: scope(f) });
        await app.prisma.notification.deleteMany({ where: scope(f) });
      }
      await app.prisma.workspace.deleteMany({ where: { id: { in: fixtures.map((f) => f.workspace.id) } } });
      await app.prisma.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => f.users.map((u) => u.id)) } } });
    }
  } finally {
    await control?.$disconnect(); await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

const zero = { tasks: 0, subtasks: 0, activity: 0, outbox: 0, notifications: 0 };
test('template enqueue failure rolls back task, subtasks, activity and intent', async (t) => {
  const f = await fixture('enqueue');
  const beforeFaults = await faults();
  await hook(f, 'NotificationDelivery', 'fault');
  try {
    const response = await post(f);
    await waitFor(async () => (await faults()) > beforeFaults, 'outbox insert fault observed');
    const observed = await counts(f);
    const successCallbacks = broadcasts.filter((b) => b[0] === f.project.id && b[1] === 'task_created').length;
    t.diagnostic(JSON.stringify({ status: response.status, ...observed, successCallbacks }));
    assert.equal(response.status, 500);
    assert.deepEqual(observed, zero);
    assert.equal(successCallbacks, 0);
  } finally { await unhook(f); }
});

test('owned process death while enqueue is blocked leaves no partial template task', async (t) => {
  const f = await fixture('precommit');
  await hook(f, 'NotificationDelivery', 'barrier');
  let worker, release, pending;
  try {
    worker = await startChild('normal');
    release = await holdBarrier();
    pending = post(f, {}, { targetPort: worker.port }).then((value) => ({ value }), (error) => ({ error: error.name }));
    await waitFor(async () => (await waitingBackends()).length > 0, 'owned worker at PostgreSQL enqueue barrier');
    const blocked = await waitingBackends();
    const whileBlocked = await counts(f);
    worker.child.kill('SIGKILL');
    const exit = await worker.exited;
    await pending;
    // Release before waiting for EOF detection: an old standalone INSERT may
    // finish after client death; an explicit transaction receives no COMMIT.
    await release();
    await waitFor(async () => (await waitingBackends()).length === 0, 'released enqueue waiter');
    await waitFor(async () => {
      const [row] = await app.prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])', blocked.map((b) => b.pid));
      return row.count === 0;
    }, 'killed owned database backend gone');
    const afterDeath = await counts(f);
    const childCallbacks = worker.messages.filter((m) => m.type === 'task-broadcast').length;
    t.diagnostic(JSON.stringify({ whileBlocked, afterDeath, signal: exit.signal, childCallbacks }));
    assert.equal(exit.signal, 'SIGKILL');
    assert.deepEqual(whileBlocked, zero);
    assert.deepEqual(afterDeath, zero);
    assert.equal(childCallbacks, 0);
  } finally {
    await release?.(); await unhook(f); await worker?.stop();
    if (pending) await pending;
  }
});

test('postcommit callback death preserves a template intent for a fresh worker', async (t) => {
  const f = await fixture('postcommit');
  let killed, retry, peer;
  try {
    killed = await startChild('kill-after-commit');
    const pending = post(f, {}, { targetPort: killed.port }).catch(() => null);
    const exit = await killed.exited;
    await pending;
    const observed = await counts(f);
    t.diagnostic(JSON.stringify({ afterDeath: observed, signal: exit.signal }));
    assert.equal(exit.signal, 'SIGKILL');
    assert.deepEqual(observed, { tasks: 1, subtasks: 2, activity: 1, outbox: 1, notifications: 0 });
    retry = await startChild('retry');
    peer = await socketFor(retry.port, f.peer.token);
    await retry.drain(); await retry.drain();
    const isToast = (m) => m.event === 'notification_new' && m.data?.data?.projectId === f.project.id;
    const toast = await peer.next(isToast);
    assert.equal(toast.data.type, 'TASK_ASSIGNED');
    assert.equal(toast.data.title, 'You were assigned to "' + f.template.title + '"');
    assert.equal(toast.data.body, f.actor.displayName + ' created a task from a template');
    assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 1, outbox: 0, notifications: 1 });
    await retry.drain(); await peer.drain(50);
    assert.equal(peer.inbox.filter(isToast).length, 0);
  } finally { closeSocket(peer); await retry?.stop(); await killed?.stop(); }
});

test('legitimate manual creation retains public DTO and pure creation does not notify', async () => {
  const f = await fixture('compatible');
  const response = await post(f, { title: 'Manual override', dueDate: '2027-04-12' });
  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(response.body), ['data']);
  assert.equal(response.body.data.title, 'Manual override');
  assert.equal(response.body.data.dueDate, '2027-04-12');
  assert.equal(response.body.data.priority, 'HIGH');
  assert.deepEqual(response.body.data.assignees.map((a) => a.userId), [f.peer.id]);
  assert.equal(Object.hasOwn(response.body.data, 'notificationDeliveryIds'), false);
  assert.equal(Object.hasOwn(response.body.data, 'task'), false);
  await waitFor(async () => (await counts(f)).notifications === 1 && (await counts(f)).outbox === 0, 'manual first delivery');
  const pure = await templates.createTaskFromTemplate(app.prisma, f.project.id, f.template.id, f.actor.id, 'ADMIN', { title: 'Pure caller' }, '2027-01-31');
  assert.equal(pure.title, 'Pure caller');
  assert.equal(pure.dueDate, '2027-02-02');
  assert.deepEqual(Object.keys(pure).sort(), Object.keys(response.body.data).sort());
  assert.deepEqual(await counts(f), { tasks: 2, subtasks: 4, activity: 2, outbox: 0, notifications: 1 });
});

test('denied viewer cannot instantiate or enqueue', async () => {
  const f = await fixture('denied');
  const response = await post(f, {}, { actor: f.viewer });
  assert.equal(response.status, 403);
  assert.deepEqual(await counts(f), zero);
  assert.equal(broadcasts.filter((b) => b[0] === f.project.id).length, 0);
});

test('member auto-inclusion preserves the assignment payload and excludes the actor', async () => {
  const f = await fixture('member');
  await app.prisma.workspaceMember.update({ where: { userId_workspaceId: { userId: f.actor.id, workspaceId: f.workspace.id } }, data: { role: 'MEMBER' } });
  await app.prisma.projectMember.create({ data: { projectId: f.project.id, userId: f.actor.id } });
  let peer;
  try {
    peer = await socketFor(port, f.peer.token);
    const response = await post(f, { title: 'Member copy' });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body.data.assignees.map((a) => a.userId).sort(), [f.actor.id, f.peer.id].sort());
    const toast = await peer.next((m) => m.event === 'notification_new' && m.data?.data?.taskId === response.body.data.id);
    assert.deepEqual(toast.data.data, { taskId: response.body.data.id, projectId: f.project.id, actorId: f.actor.id, actorName: f.actor.displayName, taskTitle: 'Member copy' });
    await waitFor(async () => (await counts(f)).outbox === 0, 'member delivery complete');
    assert.deepEqual((await app.prisma.notification.findMany({ where: scope(f) })).map((n) => n.userId), [f.peer.id]);
    assert.equal(broadcasts.filter((b) => b[0] === f.project.id && b[1] === 'task_created').length, 1);
  } finally { closeSocket(peer); }
});

test('self-only and empty assignment groups do not attempt an outbox insert', async () => {
  const f = await fixture('empty-intent');
  const beforeFaults = await faults();
  await hook(f, 'NotificationDelivery', 'fault');
  try {
    const first = await post(f, { assigneeIds: [f.actor.id] });
    const second = await post(f, { assigneeIds: [] });
    assert.equal(first.status, 201); assert.equal(second.status, 201);
    assert.notEqual(first.body.data.id, second.body.data.id);
    assert.deepEqual(first.body.data.assignees.map((a) => a.userId), [f.actor.id]);
    assert.deepEqual(second.body.data.assignees, []);
    assert.equal(await faults(), beforeFaults);
    assert.deepEqual(await counts(f), { tasks: 2, subtasks: 4, activity: 2, outbox: 0, notifications: 0 });
  } finally { await unhook(f); }
});

test('disabled assignment preferences are applied at delivery', async () => {
  const f = await fixture('preference');
  await app.prisma.notificationPreference.create({ data: { userId: f.peer.id, taskAssigned: false } });
  assert.equal((await post(f)).status, 201);
  await waitFor(async () => (await counts(f)).outbox === 0, 'preference delivery complete');
  assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 1, outbox: 0, notifications: 0 });
});

test('failed first delivery keeps201 and current project access filters its retry', async () => {
  const f = await fixture('revoked-retry');
  await hook(f, 'Notification', 'fault');
  let peer;
  try {
    peer = await socketFor(port, f.peer.token);
    assert.equal((await post(f)).status, 201);
    await waitFor(async () => (await app.prisma.notificationDelivery.count({ where: { ...scope(f), lastError: { not: null } } })) === 1, 'failed delivery retained');
    assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 1, outbox: 1, notifications: 0 });
    const removed = await fetch('http://127.0.0.1:' + port + '/api/projects/' + f.project.id + '/members/' + f.peer.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + f.actor.token }, signal: AbortSignal.timeout(8000) });
    assert.equal(removed.status, 204);
    await unhook(f);
    await processDueNotificationDeliveries(app.prisma, app, { now: new Date(Date.now() + 60_000), log: app.log });
    await peer.drain(50);
    assert.equal(peer.inbox.filter((m) => m.event === 'notification_new' && m.data?.data?.projectId === f.project.id).length, 0);
    assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 1, outbox: 0, notifications: 0 });
  } finally { closeSocket(peer); await unhook(f); }
});

test('stored foreign references filter while explicit foreign overrides refuse atomically', async () => {
  const f = await fixture('references');
  const other = await fixture('foreign');
  const label = await app.prisma.label.create({ data: { projectId: other.project.id, name: 'Foreign label' } });
  for (const body of [{ statusId: other.project.statuses[0].id }, { assigneeIds: [other.peer.id] }]) {
    assert.equal((await post(f, body)).status, 400);
    assert.deepEqual(await counts(f), zero);
  }
  await app.prisma.taskTemplate.update({ where: { id: f.template.id }, data: { statusId: other.project.statuses[0].id, labelIds: [label.id], assigneeIds: [f.peer.id, other.peer.id, f.peer.id, 'missing-template-assignee'] } });
  const response = await post(f, { statusId: '' });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.statusId, f.project.statuses[0].id);
  assert.deepEqual(response.body.data.labels, []);
  assert.deepEqual(response.body.data.assignees.map((a) => a.userId), [f.peer.id]);
  await waitFor(async () => (await counts(f)).outbox === 0, 'reference-filtered delivery complete');
  assert.deepEqual((await app.prisma.notification.findMany({ where: scope(f) })).map((n) => n.userId), [f.peer.id]);
});

test('pure caller transaction owns rollback and keeps stricter settings without any intent', async () => {
  const f = await fixture('pure-transaction');
  const rollback = new Error('owned caller rollback');
  await assert.rejects(app.prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('statement_timeout','250ms',true)");
    await tx.$queryRawUnsafe('SELECT id FROM "Project" WHERE id=$1 FOR KEY SHARE', f.project.id);
    const task = await templates.createTaskFromTemplate(tx, f.project.id, f.template.id, null, 'ADMIN', undefined, '2027-03-09');
    assert.equal(task.dueDate, '2027-03-11');
    assert.equal(Object.hasOwn(task, 'notificationDeliveryIds'), false);
    assert.equal(await tx.notificationDelivery.count({ where: scope(f) }), 0);
    const settings = await tx.$queryRawUnsafe("SELECT name,setting::integer AS ms FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout')");
    assert.equal(settings.find((s) => s.name === 'statement_timeout').ms, 250);
    assert.equal(settings.find((s) => s.name === 'lock_timeout').ms, 5000);
    throw rollback;
  }), (error) => error === rollback);
  assert.deepEqual(await counts(f), zero);
});

test('actual recurring occurrence retains its due date, atomic key and no-notify policy', async () => {
  const f = await fixture('recurring');
  const config = await app.prisma.recurringTaskConfig.create({ data: { projectId: f.project.id, templateId: f.template.id, frequency: 'DAILY', startDate: '2027-03-09', endDate: '2027-03-09', nextRunDate: '2027-03-09' } });
  const beforeFaults = await faults();
  await hook(f, 'NotificationDelivery', 'fault');
  try {
    const first = await processRecurringTasks(app.prisma, app, { now: new Date('2027-03-10T12:00:00Z') });
    const second = await processRecurringTasks(app.prisma, app, { now: new Date('2027-03-10T12:00:00Z') });
    assert.equal(first.generated, 1); assert.equal(first.failed, 0); assert.equal(second.generated, 0);
    const occurrences = await app.prisma.recurringTaskOccurrence.findMany({ where: { configId: config.id } });
    assert.equal(occurrences.length, 1); assert.equal(occurrences[0].occurrenceDate, '2027-03-09');
    const task = await app.prisma.task.findUnique({ where: { id: occurrences[0].taskId } });
    assert.equal(task.dueDate, '2027-03-11');
    const advanced = await app.prisma.recurringTaskConfig.findUnique({ where: { id: config.id } });
    assert.equal(advanced.nextRunDate, '2027-03-10'); assert.equal(advanced.isActive, false);
    assert.equal(await faults(), beforeFaults);
    assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 0, outbox: 0, notifications: 0 });
  } finally { await unhook(f); }
});

test('API-key manual creation retains actor and public payload', async () => {
  const f = await fixture('api-key');
  const { key } = await createApiKey(app.prisma, f.actor.id, { name: 'Template fixture', expiresInDays: null });
  const response = await post(f, { title: 'Key-created template task' }, { actor: { ...f.actor, token: key } });
  assert.equal(response.status, 201);
  assert.equal(Object.hasOwn(response.body.data, 'notificationDeliveryIds'), false);
  await waitFor(async () => (await counts(f)).outbox === 0, 'API-key notification delivered');
  const [notification] = await app.prisma.notification.findMany({ where: scope(f) });
  assert.equal(notification.data.actorId, f.actor.id);
  assert.equal(notification.data.actorName, f.actor.displayName);
  assert.equal(notification.title, 'You were assigned to "Key-created template task"');
});

test('archived or missing template refuses without mutation or event', async () => {
  const f = await fixture('refusal');
  await app.prisma.project.update({ where: { id: f.project.id }, data: { archived: true } });
  assert.equal((await post(f)).status, 400);
  await app.prisma.project.update({ where: { id: f.project.id }, data: { archived: false } });
  const missing = { ...f, template: { ...f.template, id: 'missing-template' } };
  assert.equal((await post(missing)).status, 404);
  assert.deepEqual(await counts(f), zero);
  assert.equal(broadcasts.filter((b) => b[0] === f.project.id).length, 0);
});

test('deliberate separate manual requests remain separate tasks and intents', async () => {
  const f = await fixture('separate');
  const first = await post(f), second = await post(f);
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.notEqual(first.body.data.id, second.body.data.id);
  await waitFor(async () => (await counts(f)).outbox === 0, 'both manual intents delivered');
  assert.deepEqual(await counts(f), { tasks: 2, subtasks: 4, activity: 2, outbox: 0, notifications: 2 });
  const tasks = await app.prisma.task.findMany({ where: { projectId: f.project.id }, orderBy: { position: 'asc' } });
  assert.deepEqual(tasks.map((t) => t.position), [0, 1]);
});

const PRIVATE_ERROR = 'TEMPLATE_PRIVATE_EXCEPTION_CANARY';
const diagnosticCases = [
  {
    name: 'known network code',
    create() { return { error: Object.assign(new TypeError(PRIVATE_ERROR), { code: 'EPIPE' }), expected: { errorKind: 'type_error', errorCode: 'EPIPE' } }; },
  },
  {
    name: 'unrecognized code',
    create() { return { error: Object.assign(new Error(PRIVATE_ERROR), { code: PRIVATE_ERROR }), expected: { errorKind: 'error' } }; },
  },
  {
    name: 'private accessors',
    create() {
      let reads = 0;
      const error = new TypeError();
      for (const field of ['name', 'message', 'stack', 'cause', 'code']) {
        Object.defineProperty(error, field, { configurable: true, get() { reads++; return PRIVATE_ERROR; } });
      }
      return { error, expected: { errorKind: 'type_error' }, reads: () => reads };
    },
  },
  {
    name: 'uninspectable value',
    create() {
      const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
      return { error: proxy, expected: { errorKind: 'unknown' } };
    },
  },
];
for (const item of diagnosticCases) {
  test('postcommit broadcast failure preserves201 and safe diagnostics: ' + item.name, async () => {
    const f = await fixture('diagnostic');
    const supplied = item.create();
    const beforeErrors = loggedErrors.length;
    broadcastFailure = supplied.error;
    try {
      const response = await post(f);
      assert.equal(response.status, 201);
      await waitFor(async () => (await counts(f)).outbox === 0, 'postcommit delivery complete');
      assert.deepEqual(await counts(f), { tasks: 1, subtasks: 2, activity: 1, outbox: 0, notifications: 1 });
      const records = loggedErrors.slice(beforeErrors);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0][0], { stage: 'template_broadcast', taskId: response.body.data.id, ...supplied.expected });
      assert.equal(records[0][1], 'Could not broadcast committed template task');
      assert.equal(JSON.stringify(records).includes(PRIVATE_ERROR), false);
      assert.equal(supplied.reads?.() ?? 0, 0);
    } finally { broadcastFailure = undefined; }
  });
}
