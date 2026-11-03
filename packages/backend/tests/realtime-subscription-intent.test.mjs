// Public authentication is completed once using an immediately resolved synthetic session;
// only ordinary resource authorization is deferred. No session/logout/token/auth ordering test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', JWT_SECRET: 'r29-public-service-synthetic-secret', COOKIE_SECRET: 'r29-public-service-synthetic-cookie', STORAGE_DIR: tmpdir() });
process.env.DATABASE_URL = 'postgresql://synthetic:unused@127.0.0.1:1/r29_never_connected';
const realtime = await import(pathToFileURL(backend + '/src/modules/realtime/realtime.service.ts').href);
const { signAccessToken } = await import(pathToFileURL(backend + '/src/utils/tokens.ts').href);
const IDS = ['ordinary-resource-one', 'ordinary-resource-two'];
const KINDS = ['project', 'workspace', 'channel'];
let fixtureOrdinal = 0;
function latch() {
  let resolve, startedResolve;
  const item = { settled: false, promise: new Promise(r => { resolve = r; }), started: new Promise(r => { startedResolve = r; }) };
  item.markStarted = () => startedResolve();
  item.settle = allowed => { if (!item.settled) { item.settled = true; resolve(allowed); } };
  return item;
}
async function waitForResourceRead(held) {
  let timer;
  try {
    await Promise.race([held.started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic resource-read prerequisite was not reached within1000ms')), 1000); })]);
  } finally { clearTimeout(timer); }
}
async function fixture(socketCount = 1) {
  assert.ok(socketCount >= 1 && socketCount <= 2);
  const ordinal = ++fixtureOrdinal, actions = new Map(), reads = [], latches = [], pending = [], sockets = [];
  const key = (kind, id) => kind + ':' + id;
  const install = (kind, id, entry) => { const k = key(kind, id); const q = actions.get(k) || []; q.push(entry); actions.set(k, q); };
  const hold = (kind, id = IDS[0]) => { const x = latch(); latches.push(x); install(kind, id, x); return x; };
  const deny = (kind, id = IDS[0]) => install(kind, id, { immediate: false });
  const read = async (kind, id, userId) => {
    assert.ok(KINDS.includes(kind) && IDS.includes(id)); reads.push({ kind, id, userId });
    const action = actions.get(key(kind, id))?.shift();
    let allowed = true;
    if (action?.promise) { action.markStarted(); allowed = await action.promise; }
    else if (action) allowed = action.immediate;
    if (!allowed) return null;
    if (kind === 'project') return { workspaceId: IDS[0], members: [{ id: 'synthetic-project-member' }], workspace: { members: [{ role: 'MEMBER' }] } };
    return { workspaceId: IDS[0] };
  };
  try {
    for (let i = 0; i < socketCount; i++) {
      const userId = `r29-synthetic-${ordinal}-${i}`, sessionId = `r29-established-${ordinal}-${i}`;
      const ws = { OPEN: 1, CONNECTING: 0, readyState: 1, frames: [], closes: [], send(text) { this.frames.push(JSON.parse(text)); }, close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; } };
      let sessionReads = 0;
      const prisma = {
        refreshTokenFamily: { async findFirst(q) { sessionReads++; assert.deepEqual(q.where, { id: sessionId, userId, revokedAt: null }); return { id: sessionId }; } },
        project: { findUnique(q) { assert.deepEqual(q.select.members.where, { userId }); assert.deepEqual(q.select.workspace.select.members.where, { userId }); return read('project', q.where.id, userId); } },
        workspaceMember: { findUnique(q) { assert.equal(q.where.userId_workspaceId.userId, userId); return read('workspace', q.where.userId_workspaceId.workspaceId, userId); } },
        chatChannel: { findFirst(q) { assert.deepEqual(q.where.members, { some: { userId } }); assert.deepEqual(q.where.workspace, { members: { some: { userId } } }); return read('channel', q.where.id, userId); } },
      };
      sockets.push({ ws, prisma, userId, sessionReads: () => sessionReads });
      const authenticated = await realtime.authenticate(ws, signAccessToken({ sub: userId, email: `fixture-${ordinal}-${i}@example.invalid`, sid: sessionId }), prisma);
      assert.equal(authenticated, userId); assert.equal(sessionReads, 1); assert.deepEqual(ws.closes, []);
    }
  } catch (error) {
    // No subscription ordering starts before fixture() returns. Every socket
    // already created belongs to this constructor, including failed setup.
    for (const socket of sockets) realtime.cleanup(socket.ws);
    throw error;
  }
  const subscribe = (kind, socket = sockets[0], id = IDS[0]) => {
    const fn = { project: realtime.subscribe, workspace: realtime.subscribeWorkspace, channel: realtime.subscribeChannel }[kind];
    const p = fn(socket.ws, id, socket.prisma); void p.catch(() => {}); pending.push(p); return p;
  };
  const unsubscribe = (kind, socket = sockets[0], id = IDS[0]) => ({ project: realtime.unsubscribe, workspace: realtime.unsubscribeWorkspace, channel: realtime.unsubscribeChannel }[kind])(socket.ws, id);
  const broadcast = (kind, marker, id = IDS[0]) => ({ project: realtime.broadcast, workspace: realtime.broadcastToWorkspace, channel: realtime.broadcastToChannel }[kind])(id, 'ordinary_subscription_marker', { marker });
  const markers = (socket, marker) => socket.ws.frames.filter(f => f.event === 'ordinary_subscription_marker' && f.data?.marker === marker);
  const absent = () => assert.ok(!realtime.getOnlineUsers(IDS[0]).some(x => sockets.some(s => s.userId === x.userId)));
  const finish = async () => {
    for (const x of latches) x.settle(false);
    await Promise.allSettled(pending);
    for (const s of sockets) { realtime.cleanup(s.ws); assert.equal(s.sessionReads(), 1); assert.deepEqual(s.ws.closes, []); }
    absent(); assert.ok(latches.every(x => x.settled));
  };
  return { sockets, reads, hold, deny, subscribe, unsubscribe, broadcast, markers, absent, finish };
}
for (const kind of KINDS) {
  test(`${kind}: release while allowed resource read is pending wins after old read resolves`, async () => {
    const f = await fixture();
    try {
      const held = f.hold(kind), p = f.subscribe(kind); await waitForResourceRead(held);
      f.unsubscribe(kind); held.settle(true); const oldResult = await p; assert.equal(typeof oldResult, 'boolean');
      f.broadcast(kind, 'released-old'); assert.equal(f.markers(f.sockets[0], 'released-old').length, 0);
      if (kind === 'workspace') f.absent();
    } finally { await f.finish(); }
  });
  test(`${kind}: release and newer denied subscribe cannot be overwritten by old allowed result`, async () => {
    const f = await fixture();
    try {
      const held = f.hold(kind), old = f.subscribe(kind); await waitForResourceRead(held);
      f.unsubscribe(kind); f.deny(kind); assert.equal(await f.subscribe(kind), false);
      held.settle(true); assert.equal(typeof await old, 'boolean');
      f.broadcast(kind, 'new-denied'); assert.equal(f.markers(f.sockets[0], 'new-denied').length, 0);
      if (kind === 'workspace') f.absent();
    } finally { await f.finish(); }
  });
  test(`${kind}: current allowed subscription receives one marker and ordinary release removes it`, async () => {
    const f = await fixture();
    try {
      assert.equal(await f.subscribe(kind), true); f.broadcast(kind, 'live-current'); assert.equal(f.markers(f.sockets[0], 'live-current').length, 1);
      if (kind === 'workspace') assert.ok(realtime.getOnlineUsers(IDS[0]).some(x => x.userId === f.sockets[0].userId));
      f.unsubscribe(kind); f.broadcast(kind, 'after-release'); assert.equal(f.markers(f.sockets[0], 'after-release').length, 0);
      if (kind === 'workspace') f.absent();
    } finally { await f.finish(); }
  });
}
test('retiring one pending intent preserves other connection, kind and resource holders', async () => {
  const f = await fixture(2);
  try {
    const [a, b] = f.sockets, held = f.hold('project'), old = f.subscribe('project', a); await waitForResourceRead(held);
    assert.equal(await f.subscribe('project', b), true); assert.equal(await f.subscribe('workspace', a), true); assert.equal(await f.subscribe('project', a, IDS[1]), true);
    f.unsubscribe('project', a); held.settle(true); await old;
    f.broadcast('project', 'same-id'); assert.equal(f.markers(a, 'same-id').length, 0); assert.equal(f.markers(b, 'same-id').length, 1);
    f.broadcast('workspace', 'other-kind'); assert.equal(f.markers(a, 'other-kind').length, 1);
    f.broadcast('project', 'other-resource', IDS[1]); assert.equal(f.markers(a, 'other-resource').length, 1);
  } finally { await f.finish(); }
});
test('public cleanup before pending workspace read settles leaves no holder or presence', async () => {
  const f = await fixture();
  try {
    const held = f.hold('workspace'), old = f.subscribe('workspace'); await waitForResourceRead(held);
    realtime.cleanup(f.sockets[0].ws); held.settle(true); assert.equal(await old, false);
    f.broadcast('workspace', 'after-cleanup'); assert.equal(f.markers(f.sockets[0], 'after-cleanup').length, 0); f.absent();
  } finally { await f.finish(); }
});
test('existing accessVersion reread still denies after ordinary project revocation', async () => {
  const f = await fixture();
  try {
    const held = f.hold('project'), old = f.subscribe('project'); await waitForResourceRead(held);
    realtime.revokeProjectAccess(f.sockets[0].userId, IDS[0]); f.deny('project'); held.settle(true);
    assert.equal(await old, false); assert.equal(f.reads.filter(r => r.kind === 'project').length, 2);
    f.broadcast('project', 'after-revoke'); assert.equal(f.markers(f.sockets[0], 'after-revoke').length, 0);
  } finally { await f.finish(); }
});

for (const kind of KINDS) {
  test(`${kind}: old authorized no-op cannot clear newer pending allowed intent`, async () => {
    const f = await fixture();
    try {
      const first = f.hold(kind), old = f.subscribe(kind); await waitForResourceRead(first);
      f.unsubscribe(kind);
      const second = f.hold(kind), current = f.subscribe(kind); await waitForResourceRead(second);
      first.settle(true);
      assert.equal(await old, true); // The old authorized ACK is preserved.
      f.broadcast(kind, 'before-new-allow'); assert.equal(f.markers(f.sockets[0], 'before-new-allow').length, 0);
      second.settle(true); assert.equal(await current, true);
      f.broadcast(kind, 'after-new-allow'); assert.equal(f.markers(f.sockets[0], 'after-new-allow').length, 1);
    } finally { await f.finish(); }
  });
}
