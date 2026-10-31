import { openRawSocket } from './support/raw-websocket.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to own disposable database');
Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test', LOG_LEVEL: 'error', JWT_SECRET: 'file-share-outbox-test-secret-key', COOKIE_SECRET: 'file-share-outbox-test-cookie-key' });
const storageDir = await mkdtemp(path.join(os.tmpdir(), 'werkyn-file-share-outbox-'));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import('../../src/app.ts');
const { PrismaClient, Prisma } = await import('@prisma/client');
const { signAccessToken } = await import('../../src/utils/tokens.ts');
const { startRefreshSession } = await import('../../src/modules/auth/refresh-sessions.ts');
const { createFileShares } = await import('../../src/modules/files/file-shares.service.ts');
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BARRIER = 439117411;
const fixtures = [], children = new Set(), openedSockets = new Set(), observations = [];
let app, control, port, sequence = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 3000) { const end = Date.now() + timeout; for (;;) { if (await check()) return; assert(Date.now() < end, `Timeout: ${label}`); await sleep(10); } }
function observe(name, value) { observations.push({ name, ...value }); if (process.env.FSO_OBSERVATIONS) writeFileSync(process.env.FSO_OBSERVATIONS, JSON.stringify(observations, null, 2) + '\n'); }
const scope = f => ({ data: { path: ['workspaceId'], equals: f.ws.id } });
async function counts(f) { return { shares: await app.prisma.fileShare.count({ where: { workspaceId: f.ws.id } }), outbox: await app.prisma.notificationDelivery.count({ where: scope(f) }), notifications: await app.prisma.notification.count({ where: scope(f) }) }; }
async function post(f, body = { fileIds: f.files.map(x => x.id), userIds: [f.peer.id] }, targetPort = port, token = f.owner.token) {
  const n = ++sequence;
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${targetPort}/api/workspaces/${f.ws.id}/files/shares`, { method: 'POST', localAddress: `127.122.${Math.floor(n / 250)}.${n % 250 + 1}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP fixture timeout'))); req.on('error', reject); req.end(JSON.stringify(body));
  });
}
async function fixture(label, fileCount = 1) {
  const suffix = crypto.randomBytes(5).toString('hex');
  async function user(name, role) {
    const row = await app.prisma.user.create({ data: { email: `fso-${name}-${suffix}@example.test`, displayName: `${name} ${suffix}`, emailVerified: true } });
    const { familyId } = await startRefreshSession(app.prisma, row.id);
    return { ...row, role, token: signAccessToken({ sub: row.id, email: row.email, sid: familyId }) };
  }
  const owner = await user('Owner', 'MEMBER'), peer = await user('Reader', 'MEMBER'), third = await user('Third', 'MEMBER'), viewer = await user('Viewer', 'VIEWER');
  const users = [owner, peer, third, viewer];
  const ws = await app.prisma.workspace.create({ data: { name: `FSO ${label}`, slug: `fso-${suffix}`, members: { create: users.map(u => ({ userId: u.id, role: u.role })) } } });
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const id = crypto.randomUUID(), storagePath = `${ws.id}/files/${owner.id}/${id}.txt`, bytes = Buffer.from(`owned ${label} ${i}`);
    await mkdir(path.dirname(path.join(storageDir, storagePath)), { recursive: true }); await writeFile(path.join(storageDir, storagePath), bytes);
    files.push(await app.prisma.file.create({ data: { id, workspaceId: ws.id, ownerId: owner.id, uploadedById: owner.id, name: `Source ${label} ${i}`, storagePath, mimeType: 'text/plain', size: BigInt(bytes.length) } }));
  }
  const f = { owner, peer, third, viewer, users, ws, files }; fixtures.push(f); return f;
}
async function hook(f, kind) { await app.prisma.$executeRaw`INSERT INTO fso_hook("fileId",kind) VALUES (${f.files[0].id},${kind}) ON CONFLICT("fileId") DO UPDATE SET kind=EXCLUDED.kind`; }
async function unhook(f) { await app.prisma.$executeRaw`DELETE FROM fso_hook WHERE "fileId"=${f.files[0].id}`; }
async function faults() { const [x] = await app.prisma.$queryRawUnsafe('SELECT last_value,is_called FROM fso_faults'); return x.is_called ? Number(x.last_value) : 0; }
async function hold() {
  let release, ready; const released = new Promise(r => { release = r; }), acquired = new Promise(r => { ready = r; });
  const run = control.$transaction(async tx => { await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${BARRIER})`); ready(); await released; }, { timeout: 10000, maxWait: 1000 });
  const failsafe = setTimeout(() => release(), 8000); await Promise.race([acquired, run]);
  return async () => { clearTimeout(failsafe); release(); await run; };
}
async function waiterPids() { return (await app.prisma.$queryRawUnsafe(`SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND objid=${BARRIER} AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)).map(x => x.pid); }
async function waitGone(pids) { if (pids.length) await waitFor(async () => (await app.prisma.$queryRaw`SELECT pid FROM pg_stat_activity WHERE pid IN (${Prisma.join(pids)})`).length === 0, 'owned blocked child backend disconnect'); }
async function startChild(mode = 'serve') {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(backend, 'tests/integration/support/file-share-outbox-worker.mjs'), mode], { cwd: backend, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.add(child);
  const messages = []; let output = '', exited;
  child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; }); child.on('message', x => messages.push(x));
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { children.delete(child); exited = { code, signal }; resolve(exited); }));
  await waitFor(() => { assert(!exited, `Child exited ${JSON.stringify(exited)} ${output}`); return messages.some(x => x.kind === 'ready'); }, 'child ready', 5000);
  return { child, port: messages.find(x => x.kind === 'ready').port, messages, exit, async kill() { if (!exited) child.kill('SIGKILL'); return exit; }, async stop() { if (!exited) child.send({ kind: 'stop' }); await exit; assert.equal(exited.code, 0, output); } };
}
before(async () => {
  app = await buildApp(); control = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL.replace(/connection_limit=\d+/, 'connection_limit=1') });
  await app.listen({ host: '127.0.0.1', port: 0 }); port = app.server.address().port;
  await app.prisma.$executeRawUnsafe('CREATE TABLE fso_hook("fileId" text PRIMARY KEY,kind text NOT NULL)');
  await app.prisma.$executeRawUnsafe('CREATE SEQUENCE fso_faults');
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION fso_delivery_hook() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode text; BEGIN SELECT kind INTO mode FROM fso_hook WHERE "fileId"=NEW.data->>'fileId'; IF mode='fault' THEN PERFORM nextval('fso_faults'); RAISE EXCEPTION 'owned file-share enqueue fault'; ELSIF mode='hold' THEN PERFORM pg_advisory_xact_lock(${BARRIER}); END IF; RETURN NEW; END $$`);
  await app.prisma.$executeRawUnsafe('CREATE TRIGGER fso_delivery_before BEFORE INSERT ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION fso_delivery_hook()');
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION fso_notification_hook() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode text; BEGIN SELECT kind INTO mode FROM fso_hook WHERE "fileId"=NEW.data->>'fileId'; IF mode='notification-hold' THEN PERFORM pg_advisory_xact_lock(${BARRIER}); ELSIF mode='notification-fault' THEN PERFORM nextval('fso_faults'); RAISE EXCEPTION 'owned file-share notification fault'; END IF; RETURN NEW; END $$`);
  await app.prisma.$executeRawUnsafe('CREATE TRIGGER fso_notification_before BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION fso_notification_hook()');
  await app.prisma.$executeRawUnsafe(`CREATE FUNCTION fso_claim_hook() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE mode text; BEGIN SELECT kind INTO mode FROM fso_hook WHERE "fileId"=NEW.data->>'fileId'; IF mode='claim-fault' AND NEW.attempts>OLD.attempts THEN PERFORM nextval('fso_faults'); RAISE EXCEPTION 'owned file-share claim fault'; END IF; RETURN NEW; END $$`);
  await app.prisma.$executeRawUnsafe('CREATE TRIGGER fso_claim_before BEFORE UPDATE ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION fso_claim_hook()');

});
after(async () => {
  for (const socket of openedSockets) socket.socket.destroy();
  for (const child of children) child.kill('SIGKILL');
  try { if (app) {
    await app.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fso_notification_before ON "Notification"'); await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fso_notification_hook()'); await app.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fso_claim_before ON "NotificationDelivery"'); await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fso_claim_hook()');
    await app.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fso_delivery_before ON "NotificationDelivery"'); await app.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fso_delivery_hook()'); await app.prisma.$executeRawUnsafe('DROP TABLE IF EXISTS fso_hook'); await app.prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS fso_faults');
    for (const f of fixtures) { await app.prisma.notificationDelivery.deleteMany({ where: scope(f) }); await app.prisma.workspace.delete({ where: { id: f.ws.id } }); await app.prisma.user.deleteMany({ where: { id: { in: f.users.map(x => x.id) } } }); }
  } } finally { await control?.$disconnect(); await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});
const { processDueNotificationDeliveries } = await import('../../src/modules/notifications/notification-delivery.ts');
const { createApiKey } = await import('../../src/modules/api-keys/api-keys.service.ts');
async function socketFor(f, targetPort = port, user = f.peer) {
  const n = ++sequence, socket = await openRawSocket(targetPort, { localAddress: `127.121.${Math.floor(n / 250)}.${n % 250 + 1}` }); openedSockets.add(socket);
  try { socket.sendJSON({ type: 'auth', token: user.token }); await socket.next(x => x.event === 'authenticated'); return socket; }
  catch (error) { socket.socket.destroy(); openedSockets.delete(socket); throw error; }
}
function closeSocket(socket) { if (socket) { socket.socket.destroy(); openedSockets.delete(socket); } }
async function queued(f, userIds = [f.peer.id]) {
  const start = await faults(); await hook(f, 'claim-fault');
  try {
    const response = await post(f, { fileIds: f.files.map(x => x.id), userIds }); assert.equal(response.status, 201);
    await waitFor(async () => await faults() > start, 'committed delivery claim fault');
    const row = await app.prisma.notificationDelivery.findFirstOrThrow({ where: scope(f) }); assert.equal(row.attempts, 0); assert.equal(row.lockedUntil, null); return row;
  } finally { await unhook(f); }
}
async function drainChild(child, now) { const old = child.messages.filter(x => x.kind === 'drained').length; child.child.send({ kind: 'drain', now }); await waitFor(() => child.messages.filter(x => x.kind === 'drained').length > old, 'fresh child due pass'); }
test('postcommit process death recovers one durable batch without duplicate rows or toasts', async () => {
  const f = await fixture('postcommit'); let child, fresh, release, pending, pids = [], peerSocket, thirdSocket;
  await hook(f, 'notification-hold');
  try {
    release = await hold(); child = await startChild(); pending = post(f, { fileIds: [f.files[0].id], userIds: [f.peer.id, f.third.id] }, child.port).catch(error => ({ error: error.message }));
    await waitFor(async () => { pids = await waiterPids(); return pids.length === 1; }, 'postcommit notification insert waiter');
    assert.deepEqual(await counts(f), { shares: 2, outbox: 1, notifications: 0 });
    await child.kill(); await release(); release = null; await waitGone(pids); await pending; await unhook(f);
    assert.deepEqual(await counts(f), { shares: 2, outbox: 1, notifications: 0 });
    fresh = await startChild(); peerSocket = await socketFor(f, fresh.port); thirdSocket = await socketFor(f, fresh.port, f.third);
    await drainChild(fresh, new Date(Date.now() + 61000).toISOString());
    for (const socket of [peerSocket, thirdSocket]) { const event = await socket.next(x => x.event === 'notification_new'); assert.equal(event.data.type, 'FILE_SHARED'); }
    assert.deepEqual(await counts(f), { shares: 2, outbox: 0, notifications: 2 });
    await drainChild(fresh, new Date(Date.now() + 120000).toISOString());
    for (const socket of [peerSocket, thirdSocket]) { await socket.drain(30); assert.equal(socket.inbox.filter(x => x.event === 'notification_new').length, 0); }
    observe('postcommit recovery', { state: await counts(f), qualification: 'fresh process actual HTTP/WS and due helper with logical now advanced beyond the lease; not wall-clock lease expiry' });
  } finally {
    closeSocket(peerSocket); closeSocket(thirdSocket); await fresh?.stop(); await child?.kill(); if (release) await release(); await waitGone(pids); if (pending) await pending; await unhook(f);
  }
});
test('the actual periodic worker delivers an unleased committed file-share intent', async () => {
  const f = await fixture('periodic'); let child, socket;
  try {
    await queued(f); child = await startChild(); socket = await socketFor(f, child.port); child.child.send({ kind: 'start-worker' });
    await socket.next(x => x.event === 'notification_new'); await waitFor(async () => (await counts(f)).outbox === 0, 'periodic delivery completes');
    await socket.drain(60); assert.equal(socket.inbox.filter(x => x.event === 'notification_new').length, 0); assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 1 });
    observe('actual periodic recovery', { state: await counts(f), qualification: 'real periodic job at 20ms, unleased due row, no logical clock or direct drain call' });
  } finally { closeSocket(socket); await child?.stop(); await unhook(f); }
});
test('duplicate request IDs preserve raw file count, deduplicate recipients and exclude the actor', async () => {
  const f = await fixture('duplicate-ids');
  const result = await post(f, { fileIds: [f.files[0].id, f.files[0].id], userIds: [f.owner.id, f.peer.id, f.peer.id] });
  assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 1 } });
  await waitFor(async () => (await counts(f)).outbox === 0 && (await counts(f)).notifications === 1, 'duplicate request delivery');
  const row = await app.prisma.notification.findFirstOrThrow({ where: scope(f) }); assert.equal(row.userId, f.peer.id); assert.equal(row.title, `${f.owner.displayName} shared 2 files with you`); assert.deepEqual(row.data, { fileId: f.files[0].id, workspaceId: f.ws.id });
});
test('all-existing duplicates, self-only HTTP and pure callers never enqueue', async () => {
  const f = await fixture('zero-pure'), ctx = { workspaceId: f.ws.id, userId: f.owner.id, workspaceRole: 'MEMBER' };
  const start = await faults(); await hook(f, 'fault');
  try {
    assert.deepEqual(await createFileShares(app.prisma, f.ws.id, [f.files[0].id], [f.peer.id], f.owner.id, ctx), { count: 1 });
    for (const userIds of [[f.peer.id], [f.owner.id]]) { const result = await post(f, { fileIds: [f.files[0].id], userIds }); assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 0 } }); }
    assert.equal(await faults(), start); assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 0 });
  } finally { await unhook(f); }
});
test('enqueue failure preserves old shares and rolls back only newly requested rows', async () => {
  const f = await fixture('partial-rollback', 2), ctx = { workspaceId: f.ws.id, userId: f.owner.id, workspaceRole: 'MEMBER' };
  await createFileShares(app.prisma, f.ws.id, [f.files[0].id], [f.peer.id], f.owner.id, ctx); const prior = await app.prisma.fileShare.findFirstOrThrow({ where: { workspaceId: f.ws.id } });
  await hook(f, 'fault'); try {
    const result = await post(f, { fileIds: f.files.map(x => x.id), userIds: [f.peer.id, f.third.id] }); assert.equal(result.status, 500);
    assert.deepEqual(await app.prisma.fileShare.findMany({ where: { workspaceId: f.ws.id } }), [prior]); assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 0 });
  } finally { await unhook(f); }
});
test('API key actor names come from current database state', async () => {
  const f = await fixture('api-key'); const { key } = await createApiKey(app.prisma, f.owner.id, { name: 'Owned file-share fixture', expiresInDays: null });
  const displayName = 'Current API actor'; await app.prisma.user.update({ where: { id: f.owner.id }, data: { displayName } });
  const result = await post(f, undefined, port, key); assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 1 } });
  await waitFor(async () => (await counts(f)).outbox === 0 && (await counts(f)).notifications === 1, 'API key delivery');
  assert.equal((await app.prisma.notification.findFirstOrThrow({ where: scope(f) })).title, `${displayName} shared "${f.files[0].name}" with you`);
});
test('delayed delivery respects preferences without undoing shares', async () => {
  const f = await fixture('preference'); await queued(f);
  await app.prisma.notificationPreference.create({ data: { userId: f.peer.id, fileShared: false } });
  const result = await processDueNotificationDeliveries(app.prisma, app); assert(result.completed >= 1); assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 0 });
});
test('delayed delivery uses current canonical file grants and workspace membership', async () => {
  const f = await fixture('revoked'), other = await fixture('left');
  await queued(f); await app.prisma.fileShare.deleteMany({ where: { workspaceId: f.ws.id } });
  await queued(other); await app.prisma.workspaceMember.delete({ where: { userId_workspaceId: { workspaceId: other.ws.id, userId: other.peer.id } } });
  const result = await processDueNotificationDeliveries(app.prisma, app); assert(result.completed >= 2);
  assert.deepEqual(await counts(f), { shares: 0, outbox: 0, notifications: 0 }); assert.deepEqual(await counts(other), { shares: 1, outbox: 0, notifications: 0 });
  const response = await app.inject({ method: 'GET', url: `/api/workspaces/${f.ws.id}/files/${f.files[0].id}/download`, headers: { authorization: `Bearer ${f.peer.token}` } }); assert.equal(response.statusCode, 403);
});
for (const kind of ['allowed-code', 'untrusted-code', 'accessors', 'proxy', 'primitive', 'inherited-code']) {
  test(`postcommit diagnostics stay bounded for ${kind}`, async () => {
    const f = await fixture(`diagnostic-${kind}`), marker = `private-${crypto.randomUUID()}`, records = []; let reads = 0, failure;
    if (kind === 'allowed-code') failure = Object.assign(new TypeError(marker), { code: 'EPIPE', private: marker });
    if (kind === 'untrusted-code') failure = Object.assign(new Error(marker), { code: marker });
    if (kind === 'accessors') { failure = {}; for (const field of ['code', 'name', 'message', 'stack']) Object.defineProperty(failure, field, { get() { reads++; throw new Error(marker); } }); }
    if (kind === 'proxy') failure = new Proxy({}, { getPrototypeOf() { throw new Error(marker); } });
    if (kind === 'primitive') failure = marker;
    if (kind === 'inherited-code') failure = Object.assign(new Error(marker), {}), Object.setPrototypeOf(failure, Object.assign(Object.create(Error.prototype), { code: 'EPIPE' }));
    const original = app.log.error;
    app.log.error = function (value, message) { if (message === 'Could not claim notification delivery') throw failure; records.push({ value, message }); };
    await hook(f, 'claim-fault');
    try {
      const result = await post(f); assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 1 } });
      await waitFor(() => records.some(x => x.value?.stage === 'file_share_notification_delivery'), 'bounded outer diagnostic');
      const row = records.find(x => x.value?.stage === 'file_share_notification_delivery');
      assert.equal(row.message, 'Committed file-share notification remains queued for retry'); assert.equal(row.value.workspaceId, f.ws.id);
      const intent = await app.prisma.notificationDelivery.findFirstOrThrow({ where: scope(f) }); assert.equal(row.value.notificationDeliveryId, intent.id);
      assert.equal(row.value.errorKind, kind === 'allowed-code' ? 'type_error' : ['untrusted-code', 'inherited-code'].includes(kind) ? 'error' : 'unknown');
      assert.deepEqual(Object.keys(row.value).sort(), ['errorKind', 'notificationDeliveryId', 'stage', 'workspaceId', ...(kind === 'allowed-code' ? ['errorCode'] : [])].sort());
      if (kind === 'allowed-code') assert.equal(row.value.errorCode, 'EPIPE');
      assert.equal(JSON.stringify(row).includes(marker), false); assert.equal(reads, 0); assert.deepEqual(await counts(f), { shares: 1, outbox: 1, notifications: 0 });
    } finally { app.log.error = original; await unhook(f); }
    const recovery = await processDueNotificationDeliveries(app.prisma, app); assert(recovery.completed >= 1); assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 1 });
  });
}
test('enqueue failure rolls back every newly inserted share', async () => {
  const f = await fixture('enqueue', 2); const start = await faults(); await hook(f, 'fault');
  try {
    const result = await post(f); await waitFor(async () => await faults() > start, 'enqueue fault observed'); const state = await counts(f);
    observe('enqueue failure', { status: result.status, state });
    assert.equal(result.status, 500); assert.deepEqual(state, { shares: 0, outbox: 0, notifications: 0 });
  } finally { await unhook(f); }
});
test('process death while enqueue is blocked leaves no partial shares', async () => {
  const f = await fixture('precommit'); let child, release, pending, pids = [], blocked, finalState;
  await hook(f, 'hold');
  try {
    release = await hold(); child = await startChild(); pending = post(f, undefined, child.port).catch(error => ({ error: error.message }));
    await waitFor(async () => { pids = await waiterPids(); return pids.length === 1; }, 'one actual enqueue waiter');
    blocked = await counts(f); await child.kill();
  } finally {
    await child?.kill(); if (release) await release(); await waitGone(pids); if (pending) await pending; await unhook(f);
  }
  finalState = await counts(f); observe('blocked enqueue death', { blocked, finalState, orphanQualification: 'old already-submitted standalone INSERT may finish after child death and holder release' });
  assert.equal(blocked.shares, 0); assert.deepEqual(finalState, { shares: 0, outbox: 0, notifications: 0 });
});
test('batch counts, partial duplicates and first-file metadata stay compatible', async () => {
  const f = await fixture('batch', 2), fileIds = f.files.map(x => x.id);
  let result = await post(f, { fileIds, userIds: [f.owner.id, f.peer.id] }); assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 2 } });
  await waitFor(async () => (await counts(f)).notifications === 1 && (await counts(f)).outbox === 0, 'initial batch notification');
  result = await post(f, { fileIds, userIds: [f.peer.id, f.third.id] }); assert.equal(result.status, 201); assert.deepEqual(result.body, { data: { count: 2 } });
  await waitFor(async () => (await counts(f)).notifications === 3 && (await counts(f)).outbox === 0, 'all requested recipients in partial batch');
  const rows = await app.prisma.notification.findMany({ where: scope(f) });
  assert.equal(rows.filter(x => x.userId === f.peer.id).length, 2); assert.equal(rows.filter(x => x.userId === f.third.id).length, 1);
  for (const row of rows) { assert.equal(row.title, `${f.owner.displayName} shared 2 files with you`); assert.deepEqual(row.data, { fileId: fileIds[0], workspaceId: f.ws.id }); }
  result = await post(f, { fileIds, userIds: [f.peer.id, f.third.id] }); assert.deepEqual(result.body, { data: { count: 0 } });
  assert.deepEqual(await counts(f), { shares: 4, outbox: 0, notifications: 3 }); observe('batch compatibility', { state: await counts(f), result: result.body });
});
test('no-server, self-only and direct empty-array calls remain pure', async () => {
  const f = await fixture('pure'); const ctx = { workspaceId: f.ws.id, userId: f.owner.id, workspaceRole: 'MEMBER' };
  assert.deepEqual(await createFileShares(app.prisma, f.ws.id, [f.files[0].id], [f.peer.id], f.owner.id, ctx), { count: 1 });
  assert.deepEqual(await createFileShares(app.prisma, f.ws.id, [f.files[0].id], [f.owner.id], f.owner.id, ctx), { count: 0 });
  assert.deepEqual(await createFileShares(app.prisma, f.ws.id, [], [], f.owner.id, ctx), { count: 0 });
  assert.deepEqual(await counts(f), { shares: 1, outbox: 0, notifications: 0 }); observe('pure compatibility', { state: await counts(f) });
});
test('viewer, foreign-file, recipient and empty HTTP denials have no effects', async () => {
  const f = await fixture('denial'), other = await fixture('foreign');
  for (const [body, token, expected] of [
    [{ fileIds: [f.files[0].id], userIds: [f.peer.id] }, f.viewer.token, 403],
    [{ fileIds: [other.files[0].id], userIds: [f.peer.id] }, f.owner.token, 404],
    [{ fileIds: [f.files[0].id], userIds: [other.peer.id] }, f.owner.token, 403],
    [{ fileIds: [], userIds: [f.peer.id] }, f.owner.token, 400],
  ]) { const result = await post(f, body, port, token); assert.equal(result.status, expected, JSON.stringify(result)); }
  assert.deepEqual(await counts(f), { shares: 0, outbox: 0, notifications: 0 }); observe('denial compatibility', { state: await counts(f) });
});
