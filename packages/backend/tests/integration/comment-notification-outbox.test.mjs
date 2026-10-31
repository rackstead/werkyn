import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { openRawSocket } from "./support/raw-websocket.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable database");
const database = new URL(process.env.TEST_DATABASE_URL);
database.searchParams.set("connection_limit", "5");
const controlDatabase = new URL(database);
controlDatabase.searchParams.set("connection_limit", "1");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-comment-outbox-"));
Object.assign(process.env, {
  TEST_DATABASE_URL: database.toString(), DATABASE_URL: database.toString(),
  NODE_ENV: "test", LOG_LEVEL: "error", STORAGE_DIR: storageDir,
  JWT_SECRET: "comment-outbox-only-local-jwt-secret",
  COOKIE_SECRET: "comment-outbox-only-local-cookie-secret",
});
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const { processDueNotificationDeliveries } = await import("../../src/modules/notifications/notification-delivery.js");
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BARRIER = 438_115_077;
const fixtures = [];
const children = new Set();
const sockets = new Set();
const broadcasts = [];
const loggedErrors = [];
let app, control, port, broadcastFailure = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert(Date.now() < end, `Timed out waiting for ${label}`);
    await sleep(10);
  }
}
const scoped = (taskId) => ({ data: { path: ["taskId"], equals: taskId } });
async function counts(f) {
  return {
    comments: await app.prisma.comment.count({ where: { taskId: f.task.id } }),
    activity: await app.prisma.activityLog.count({ where: { taskId: f.task.id, action: "comment_added" } }),
    outbox: await app.prisma.notificationDelivery.count({ where: scoped(f.task.id) }),
    notifications: await app.prisma.notification.count({ where: scoped(f.task.id) }),
    broadcasts: broadcasts.filter((event) => event[2]?.taskId === f.task.id).length,
  };
}
async function post(f, body, targetPort = port) {
  const response = await fetch(`http://127.0.0.1:${targetPort}/api/tasks/${f.task.id}/comments`, {
    method: "POST", headers: { authorization: `Bearer ${f.actor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ body }), signal: AbortSignal.timeout(8000),
  });
  return { status: response.status, body: await response.json() };
}
async function fixture(label, { mention = false } = {}) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const user = async (name, role) => {
    const row = await app.prisma.user.create({ data: {
      email: `comment-${label}-${name}-${suffix}@example.test`, displayName: `${name} ${suffix}`, emailVerified: true,
    } });
    const { familyId } = await startRefreshSession(app.prisma, row.id);
    return { ...row, role, token: signAccessToken({ sub: row.id, email: row.email, sid: familyId }) };
  };
  const actor = await user("Author", "ADMIN");
  const peer = await user("Assignee", "MEMBER");
  const mentioned = mention ? await user("Mentioned", "MEMBER") : null;
  const users = [actor, peer, ...(mentioned ? [mentioned] : [])];
  const workspace = await app.prisma.workspace.create({ data: {
    name: `Comment ${label}`, slug: `comment-${suffix}`,
    members: { create: users.map((u) => ({ userId: u.id, role: u.role })) },
  } });
  const project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: `Project ${label}`,
    members: { create: users.filter((u) => u !== actor).map((u) => ({ userId: u.id })) },
    statuses: { create: { name: "Todo" } },
  }, include: { statuses: true } });
  const task = await app.prisma.task.create({ data: {
    projectId: project.id, statusId: project.statuses[0].id, title: `Task ${label}`,
    assignees: { create: { userId: peer.id } },
  } });
  const f = { actor, peer, mentioned, users, workspace, project, task };
  fixtures.push(f);
  return f;
}
async function hook(f, stage, kind, notificationType = "") {
  await app.prisma.$executeRaw`
    INSERT INTO "cbo_hook" ("taskId", "stage", "kind", "notificationType")
    VALUES (${f.task.id}, ${stage}, ${kind}, ${notificationType})
    ON CONFLICT ("taskId", "stage") DO UPDATE SET "kind" = EXCLUDED."kind", "notificationType" = EXCLUDED."notificationType"`;
}
async function unhook(f) {
  await app.prisma.$executeRaw`DELETE FROM "cbo_hook" WHERE "taskId" = ${f.task.id}`;
}
async function faults() {
  const [row] = await app.prisma.$queryRawUnsafe('SELECT "last_value", "is_called" FROM "cbo_faults"');
  return row.is_called ? Number(row.last_value) : 0;
}
async function drain() {
  await processDueNotificationDeliveries(app.prisma, app, { now: new Date(Date.now() + 60_000), log: app.log });
}
async function holdBarrier() {
  let release, ready;
  const released = new Promise((resolve) => { release = resolve; });
  const acquired = new Promise((resolve) => { ready = resolve; });
  const run = control.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${BARRIER})`);
    ready();
    await released;
  }, { timeout: 8000, maxWait: 1000 });
  await Promise.race([acquired, run]);
  return async () => { release(); await run; };
}
async function waiters() {
  const [row] = await app.prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS count FROM pg_locks
    WHERE locktype = 'advisory' AND objid = ${BARRIER} AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  return row.count;
}
async function startChild(mode) {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(backend, "tests/integration/support/comment-outbox-worker.mjs"), mode], {
    cwd: backend, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  const messages = [];
  let output = "", exit;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("message", (message) => messages.push(message));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    exit = { code, signal }; children.delete(child); resolve(exit);
  }));
  await waitFor(() => {
    assert(!exit, `Fixture worker exited before ready: ${output}`);
    return messages.some((m) => m.type === "ready");
  }, "owned worker ready", 5000);
  return {
    child, messages, exited, port: messages.find((m) => m.type === "ready").port,
    async stop() {
      if (exit) return;
      child.send({ type: "stop" });
      await waitFor(() => exit, "owned worker stop", 3000);
    },
    async drain() {
      const id = crypto.randomUUID(); child.send({ type: "drain", id });
      await waitFor(() => messages.some((m) => m.id === id && m.type === "drained"), "fresh retry worker pass", 5000);
    },
  };
}
async function socketFor(targetPort, token) {
  const socket = await openRawSocket(targetPort);
  sockets.add(socket);
  try {
    socket.sendJSON({ type: "auth", token });
    await socket.next((message) => message.event === "authenticated");
    return socket;
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
}
function closeSocket(socket) {
  socket?.socket.destroy();
  sockets.delete(socket);
}

before(async () => {
  app = await buildApp();
  app.addHook("onRequest", async (request) => {
    const error = request.log.error.bind(request.log);
    request.log.error = (...args) => { loggedErrors.push(args); error(...args); };
  });
  const broadcast = app.broadcast.bind(app);
  app.broadcast = (...args) => {
    broadcasts.push(args);
    if (broadcastFailure && args[1] === "comment_created") throw new Error("synthetic postcommit broadcast failure");
    return broadcast(...args);
  };
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  control = new PrismaClient({ datasources: { db: { url: controlDatabase.toString() } } });
  await app.prisma.$executeRawUnsafe('CREATE TABLE "cbo_hook" ("taskId" TEXT NOT NULL, "stage" TEXT NOT NULL, "kind" TEXT NOT NULL, "notificationType" TEXT NOT NULL, PRIMARY KEY ("taskId", "stage"))');
  await app.prisma.$executeRawUnsafe('CREATE SEQUENCE "cbo_faults"');
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION cbo_hook() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE item jsonb := to_jsonb(NEW); scoped_task text; active record;
    BEGIN
      scoped_task := CASE WHEN TG_TABLE_NAME = 'ActivityLog' THEN item->>'taskId' ELSE item->'data'->>'taskId' END;
      SELECT * INTO active FROM "cbo_hook" WHERE "taskId" = scoped_task AND "stage" = TG_TABLE_NAME;
      IF FOUND AND (active."notificationType" = '' OR active."notificationType" = item->>'type') THEN
        IF active."kind" = 'fault' THEN
          PERFORM nextval('"cbo_faults"');
          RAISE EXCEPTION 'synthetic comment outbox fault';
        ELSIF active."kind" = 'barrier' THEN
          PERFORM pg_advisory_xact_lock(${BARRIER});
        END IF;
      END IF;
      RETURN NEW;
    END $$`);
  for (const table of ["ActivityLog", "NotificationDelivery", "Notification"]) {
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER "cbo_hook" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION cbo_hook()`);
  }
});

after(async () => {
  for (const socket of sockets) closeSocket(socket);
  for (const child of children) child.kill("SIGKILL");
  if (app) {
    for (const table of ["ActivityLog", "NotificationDelivery", "Notification"]) {
      await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "cbo_hook" ON "${table}"`);
    }
    await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS cbo_hook()');
    await app.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "cbo_hook"');
    await app.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS "cbo_faults"');
    for (const f of fixtures) {
      await app.prisma.notificationDelivery.deleteMany({ where: scoped(f.task.id) });
      await app.prisma.notification.deleteMany({ where: scoped(f.task.id) });
    }
    await app.prisma.workspace.deleteMany({ where: { id: { in: fixtures.map((f) => f.workspace.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: fixtures.flatMap((f) => f.users.map((u) => u.id)) } } });
  }
  await control?.$disconnect();
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("comment enqueue failure rolls back both notification groups, comment and activity", async (t) => {
  const f = await fixture("enqueue", { mention: true });
  const before = await faults();
  await hook(f, "NotificationDelivery", "fault", "COMMENT_MENTION");
  try {
    const response = await post(f, `Please review @[${f.mentioned.id}]`);
    await waitFor(async () => (await faults()) > before, "outbox insert attempted");
    if (response.status === 201) await waitFor(async () => (await counts(f)).notifications > 0, "old first-group delivery");
    const observed = await counts(f);
    t.diagnostic(JSON.stringify({ status: response.status, ...observed }));
    assert.equal(response.status, 500);
    assert.deepEqual(observed, { comments: 0, activity: 0, outbox: 0, notifications: 0, broadcasts: 0 });
  } finally { await unhook(f); }
});

test("process death before outbox commit leaves no comment or activity", async (t) => {
  const f = await fixture("before-death", { mention: true });
  await hook(f, "NotificationDelivery", "barrier");
  let worker, request, release;
  try {
    worker = await startChild("normal");
    release = await holdBarrier();
    request = post(f, `Crash boundary @[${f.mentioned.id}]`, worker.port).then((value) => ({ value }), (error) => ({ error: error.name }));
    await waitFor(async () => (await waiters()) > 0, "owned worker blocked before enqueue");
    const blocked = await app.prisma.$queryRawUnsafe(`
      SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${BARRIER} AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    const whileBlocked = await counts(f);
    worker.child.kill("SIGKILL");
    const exit = await worker.exited;
    await request;
    // PostgreSQL cannot notice the dead client's EOF while its statement is
    // waiting on our advisory lock. Release first; an explicit transaction
    // then rolls back without ever receiving COMMIT from the killed client.
    await release();
    await waitFor(async () => (await waiters()) === 0, "owned killed worker rollback");
    await waitFor(async () => {
      const [row] = await app.prisma.$queryRawUnsafe(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid = ANY($1::int[])",
        blocked.map((row) => row.pid),
      );
      return row.count === 0;
    }, "owned killed database backends gone");
    const observed = await counts(f);
    t.diagnostic(JSON.stringify({ whileBlocked, afterDeath: observed, signal: exit.signal }));
    assert.equal(exit.signal, "SIGKILL");
    assert.deepEqual(observed, { comments: 0, activity: 0, outbox: 0, notifications: 0, broadcasts: 0 });
    assert.equal(worker.messages.filter((m) => m.type === "comment-broadcast").length, 0);
  } finally {
    await release?.(); await unhook(f);
    if (worker) await worker.stop();
    if (request) await request;
  }
});

test("valid surrogate-boundary comment retains a durable notification", async (t) => {
  const f = await fixture("unicode");
  const body = `${"x".repeat(99)}😀`;
  const beforeErrors = loggedErrors.length;
  const response = await post(f, body);
  assert.equal(response.status, 201);
  await waitFor(async () =>
    (await app.prisma.notification.count({ where: scoped(f.task.id) })) > 0 ||
    loggedErrors.slice(beforeErrors).some((args) => args.includes("Failed to send comment notification")),
  "notification or recorded old enqueue failure");
  await drain();
  const rows = await app.prisma.notification.findMany({ where: scoped(f.task.id) });
  t.diagnostic(JSON.stringify({ status: response.status, ...(await counts(f)), delivered: rows.length,
    oldEnqueueErrorObserved: loggedErrors.slice(beforeErrors).some((args) => args.includes("Failed to send comment notification")) }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, `${f.actor.displayName}: ${"x".repeat(99)}`);
  assert.equal((await app.prisma.comment.findUnique({ where: { id: response.body.data.id } })).body, body);
});

test("process death after commit keeps both intents for a fresh retry worker", async (t) => {
  const f = await fixture("after-death", { mention: true });
  const killed = await startChild("kill-after-commit");
  let retry, peer, mentioned;
  try {
    const request = post(f, `Restart recovery @[${f.mentioned.id}]`, killed.port).catch(() => null);
    const exit = await killed.exited;
    await request;
    const observed = await counts(f);
    t.diagnostic(JSON.stringify({ afterDeath: observed, signal: exit.signal }));
    assert.equal(exit.signal, "SIGKILL");
    assert.deepEqual(observed, { comments: 1, activity: 1, outbox: 2, notifications: 0, broadcasts: 0 });
    retry = await startChild("retry");
    peer = await socketFor(retry.port, f.peer.token);
    mentioned = await socketFor(retry.port, f.mentioned.token);
    await retry.drain();
    const isToast = (message) => message.event === "notification_new" && message.data?.data?.taskId === f.task.id;
    const first = await peer.next(isToast);
    const second = await mentioned.next(isToast);
    assert.equal(first.data.type, "COMMENT_ADDED");
    assert.equal(second.data.type, "COMMENT_MENTION");
    assert.notEqual(first.data.id, second.data.id);
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 0, notifications: 2, broadcasts: 0 });
    await retry.drain();
    await Promise.all([peer.drain(50), mentioned.drain(50)]);
    assert.equal(peer.inbox.filter(isToast).length + mentioned.inbox.filter(isToast).length, 0);
  } finally {
    closeSocket(peer); closeSocket(mentioned);
    await retry?.stop(); await killed.stop();
  }
});

test("activity failure rolls back the required comment and all intents", async () => {
  const f = await fixture("activity", { mention: true });
  await hook(f, "ActivityLog", "fault");
  try {
    const response = await post(f, `Activity failure @[${f.mentioned.id}]`);
    assert.equal(response.status, 500);
    assert.deepEqual(await counts(f), { comments: 0, activity: 0, outbox: 0, notifications: 0, broadcasts: 0 });
  } finally { await unhook(f); }
});

test("duplicate mentions, assigned mentions and actor exclusion retain the public response and one toast each", async () => {
  const f = await fixture("recipients", { mention: true });
  await app.prisma.taskAssignee.createMany({ data: [f.actor, f.mentioned].map((u) => ({ taskId: f.task.id, userId: u.id })) });
  let peer, mentioned;
  try {
    peer = await socketFor(port, f.peer.token);
    mentioned = await socketFor(port, f.mentioned.token);
    const body = `Review @[${f.mentioned.id}] @[${f.mentioned.id}] @[${f.actor.id}]`;
    const response = await post(f, body);
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body), ["data"]);
    assert.equal(response.body.data.body, body);
    assert.equal(response.body.data.author.displayName, f.actor.displayName);
    assert.equal(Object.hasOwn(response.body.data, "notificationDeliveryIds"), false);
    const isToast = (message) => message.event === "notification_new" && message.data?.data?.taskId === f.task.id;
    const first = await peer.next(isToast);
    const second = await mentioned.next(isToast);
    assert.equal(first.data.type, "COMMENT_ADDED");
    assert.equal(first.data.title, `New comment on "${f.task.title}"`);
    assert.equal(first.data.body, `${f.actor.displayName}: ${body.slice(0, 100)}`);
    assert.equal(second.data.type, "COMMENT_MENTION");
    assert.equal(second.data.title, `${f.actor.displayName} mentioned you in "${f.task.title}"`);
    assert.equal(second.data.body, body.slice(0, 100));
    await waitFor(async () => (await counts(f)).outbox === 0, "initial deliveries finish");
    const rows = await app.prisma.notification.findMany({ where: scoped(f.task.id) });
    assert.deepEqual(rows.map((n) => [n.userId, n.type]).sort(), [[f.peer.id, "COMMENT_ADDED"], [f.mentioned.id, "COMMENT_MENTION"]].sort());
    for (const row of rows) assert.deepEqual(row.data, {
      taskId: f.task.id, projectId: f.project.id, commentId: response.body.data.id,
      actorId: f.actor.id, actorName: f.actor.displayName, taskTitle: f.task.title,
    });
    await drain();
    await Promise.all([peer.drain(50), mentioned.drain(50)]);
    assert.equal(peer.inbox.filter(isToast).length + mentioned.inbox.filter(isToast).length, 0);
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 0, notifications: 2, broadcasts: 1 });
  } finally { closeSocket(peer); closeSocket(mentioned); }
});

test("actor-only intents skip enqueue and preserve successful comment creation", async () => {
  const f = await fixture("actor-only");
  await app.prisma.taskAssignee.deleteMany({ where: { taskId: f.task.id } });
  await app.prisma.taskAssignee.create({ data: { taskId: f.task.id, userId: f.actor.id } });
  const before = await faults();
  await hook(f, "NotificationDelivery", "fault");
  try {
    const response = await post(f, `Self note @[${f.actor.id}] @[${f.actor.id}]`);
    assert.equal(response.status, 201);
    assert.equal(await faults(), before);
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 0, notifications: 0, broadcasts: 1 });
  } finally { await unhook(f); }
});

test("preference filtering remains at delivery and does not fail the comment", async () => {
  const f = await fixture("preferences", { mention: true });
  await app.prisma.notificationPreference.createMany({ data: [
    { userId: f.peer.id, commentAdded: false }, { userId: f.mentioned.id, commentMention: false },
  ] });
  const response = await post(f, `Preferences @[${f.mentioned.id}]`);
  assert.equal(response.status, 201);
  await waitFor(async () => (await counts(f)).outbox === 0, "preference-filtered deliveries finish");
  assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 0, notifications: 0, broadcasts: 1 });
});

test("failed first delivery preserves201 and committed intents recover once", async () => {
  const f = await fixture("delivery-fault", { mention: true });
  let peer, mentioned;
  try {
    peer = await socketFor(port, f.peer.token);
    mentioned = await socketFor(port, f.mentioned.token);
    await hook(f, "Notification", "fault");
    const response = await post(f, `Retry both @[${f.mentioned.id}]`);
    assert.equal(response.status, 201);
    await waitFor(async () => (await app.prisma.notificationDelivery.count({
      where: { ...scoped(f.task.id), lastError: { not: null } },
    })) === 2, "both failed first attempts recorded");
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 2, notifications: 0, broadcasts: 1 });
    await unhook(f);
    await Promise.all([drain(), drain()]);
    const isToast = (message) => message.event === "notification_new" && message.data?.data?.taskId === f.task.id;
    await peer.next(isToast); await mentioned.next(isToast);
    await drain(); await Promise.all([peer.drain(50), mentioned.drain(50)]);
    assert.equal(peer.inbox.filter(isToast).length + mentioned.inbox.filter(isToast).length, 0);
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 0, notifications: 2, broadcasts: 1 });
  } finally { closeSocket(peer); closeSocket(mentioned); await unhook(f); }
});

test("lost project access before retry filters the recipient without repeating the other intent", async () => {
  const f = await fixture("lost-access", { mention: true });
  let peer, mentioned;
  try {
    peer = await socketFor(port, f.peer.token);
    mentioned = await socketFor(port, f.mentioned.token);
    await hook(f, "Notification", "fault");
    assert.equal((await post(f, `Access retry @[${f.mentioned.id}]`)).status, 201);
    await waitFor(async () => (await app.prisma.notificationDelivery.count({
      where: { ...scoped(f.task.id), lastError: { not: null } },
    })) === 2, "first attempts deferred");
    const removed = await fetch(`http://127.0.0.1:${port}/api/projects/${f.project.id}/members/${f.peer.id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${f.actor.token}` }, signal: AbortSignal.timeout(8000),
    });
    assert.equal(removed.status, 204);
    await unhook(f); await drain();
    const isToast = (message) => message.event === "notification_new" && message.data?.data?.taskId === f.task.id;
    await mentioned.next(isToast);
    await peer.drain(50);
    assert.equal(peer.inbox.filter(isToast).length, 0);
    const rows = await app.prisma.notification.findMany({ where: scoped(f.task.id) });
    assert.deepEqual(rows.map((row) => [row.userId, row.type]), [[f.mentioned.id, "COMMENT_MENTION"]]);
    await drain(); await mentioned.drain(50);
    assert.equal(mentioned.inbox.filter(isToast).length, 0);
  } finally { closeSocket(peer); closeSocket(mentioned); await unhook(f); }
});

test("postcommit broadcast failure preserves201 and the durable notification", async () => {
  const f = await fixture("broadcast-fault");
  const startErrors = loggedErrors.length;
  await hook(f, "Notification", "fault");
  broadcastFailure = true;
  try {
    const response = await post(f, "Broadcast failure must not erase committed success");
    assert.equal(response.status, 201);
    await waitFor(async () => (await app.prisma.notificationDelivery.count({
      where: { ...scoped(f.task.id), lastError: { not: null } },
    })) === 1, "first delivery deferred");
    assert.deepEqual(await counts(f), { comments: 1, activity: 1, outbox: 1, notifications: 0, broadcasts: 1 });
    assert(loggedErrors.slice(startErrors).length > 0, "postcommit failure is observable");
    assert(loggedErrors.slice(startErrors).every((args) => !(args[0] instanceof Error)), "request logs keep fixed context instead of copying broadcast exceptions");
    broadcastFailure = false; await unhook(f); await drain();
    assert.equal((await counts(f)).notifications, 1);
    assert.equal((await counts(f)).outbox, 0);
  } finally { broadcastFailure = false; await unhook(f); }
});

test("two deliberate unkeyed creates remain two distinct committed intents", async () => {
  const f = await fixture("two-creates");
  const responses = await Promise.all([post(f, "Same intentional text"), post(f, "Same intentional text")]);
  assert.deepEqual(responses.map((r) => r.status), [201, 201]);
  assert.notEqual(responses[0].body.data.id, responses[1].body.data.id);
  await waitFor(async () => (await counts(f)).outbox === 0, "both first deliveries finish");
  const rows = await app.prisma.notification.findMany({ where: scoped(f.task.id) });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.data.commentId).sort(), responses.map((r) => r.body.data.id).sort());
  assert.deepEqual(await counts(f), { comments: 2, activity: 2, outbox: 0, notifications: 2, broadcasts: 2 });
});

test("adjacent valid Unicode excerpt boundaries retain their previous bytes", async (t) => {
  for (const prefix of [98, 100]) {
    await t.test(`prefix ${prefix}`, async () => {
      const f = await fixture(`unicode-${prefix}`);
      const body = `${"x".repeat(prefix)}😀tail`;
      const response = await post(f, body);
      assert.equal(response.status, 201);
      await waitFor(async () => (await counts(f)).notifications === 1 && (await counts(f)).outbox === 0, "valid excerpt delivered");
      const row = await app.prisma.notification.findFirstOrThrow({ where: scoped(f.task.id) });
      assert.equal(row.body, `${f.actor.displayName}: ${body.slice(0, 100)}`);
      assert.equal((await app.prisma.comment.findUnique({ where: { id: response.body.data.id } })).body, body);
    });
  }
});
