import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

// R09 / DAT-012: complete custom-field permutations and competing definition
// writers are serialized over real HTTP/TCP against PostgreSQL.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
actorUrl.searchParams.set("connection_limit", "5");
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-field-order-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(), NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "field-order-jwt-secret", COOKIE_SECRET: "field-order-cookie-secret", STORAGE_DIR: storageDir,
});
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { createApiKey } = await import("../../src/modules/api-keys/api-keys.service.ts");
let app, control, port, requests = 0;
const workspaceIds = [], userIds = [], events = [];

before(async () => {
  control = new PrismaClient({ datasourceUrl: controlUrl.toString() });
  await control.$connect();
  app = await buildApp();
  app.broadcast = (...event) => events.push(event);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});
after(async () => {
  try {
    await app?.prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
    await app?.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await app?.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    const closed = await Promise.allSettled([app?.close(), control?.$disconnect()]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
});

// A real TCP request, with its own address so fixtures do not share IP limits.
function call(f, method, suffix, payload, token = f.token) {
  const n = ++requests, serialized = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1", port, method, path: `/api/projects/${f.project.id}/custom-fields${suffix}`,
      localAddress: `127.79.${Math.floor(n / 250) % 250}.${n % 250 + 1}`, agent: false,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => text += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body: text }));
    });
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("Custom-field request timed out")));
    request.end(serialized);
  });
}
function expect(response, status) {
  assert.equal(response.status, status, response.body);
  return response.body ? JSON.parse(response.body) : undefined;
}
const reorder = (f, ids, token) => call(f, "PATCH", "/reorder", { orderedIds: ids }, token);
const create = (f, name) => call(f, "POST", "", { name, type: "TEXT" });
const remove = (f, field) => call(f, "DELETE", `/${field.id}`);
const fields = (f) => app.prisma.customField.findMany({ where: { projectId: f.project.id }, orderBy: [{ position: "asc" }, { id: "asc" }] });
const values = (f) => app.prisma.customFieldValue.findMany({ where: { task: { projectId: f.project.id } }, orderBy: { id: "asc" } });
const history = (f) => app.prisma.activityLog.findMany({ where: { task: { projectId: f.project.id } }, orderBy: { id: "asc" } });
const snapshot = async (f) => ({ fields: await fields(f), values: await values(f), history: await history(f) });
const projectEvents = (f) => events.filter(([id]) => id === f.project.id);

async function fixture({ count = 3, roles = false } = {}) {
  const user = await app.prisma.user.create({ data: {
    email: `field-order-${crypto.randomUUID()}@example.test`, displayName: "Field order", emailVerified: true,
  } });
  userIds.push(user.id);
  const token = signAccessToken({ sub: user.id, email: user.email });
  const workspace = await app.prisma.workspace.create({ data: {
    name: "Field order", slug: crypto.randomUUID(), members: { create: { userId: user.id, role: "ADMIN" } },
  } });
  workspaceIds.push(workspace.id);
  const project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: "Fields", members: { create: { userId: user.id } },
  } });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  const task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Field values" } });
  const f = { user, token, workspace, project, task, fields: [], tokens: {} };
  for (let position = 0; position < count; position++) {
    const field = await app.prisma.customField.create({ data: {
      projectId: project.id, name: `Field ${position}`, type: "SELECT", options: [{ value: "kept" }], required: true, position,
    } });
    f.fields.push(field);
    await app.prisma.customFieldValue.create({ data: { taskId: task.id, fieldId: field.id, value: "kept" } });
  }
  await app.prisma.activityLog.create({ data: { taskId: task.id, actorId: user.id, action: "custom_field_changed", details: { fixture: true } } });
  if (roles) {
    for (const [role, joined] of [["MEMBER", true], ["VIEWER", true], ["MEMBER", false]]) {
      const member = await app.prisma.user.create({ data: { email: `field-order-${crypto.randomUUID()}@example.test`, displayName: role, emailVerified: true } });
      userIds.push(member.id);
      await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: member.id, role } });
      if (joined) await app.prisma.projectMember.create({ data: { projectId: project.id, userId: member.id } });
      f.tokens[joined ? role : "unjoined"] = signAccessToken({ sub: member.id, email: member.email });
    }
  }
  events.length = 0;
  return f;
}

async function refused(f, ids, status, token, message) {
  const before = await snapshot(f);
  events.length = 0;
  const response = await reorder(f, ids, token);
  if (response.status !== status) {
    const after = await snapshot(f);
    console.info("unexpected reorder result", JSON.stringify({
      status: response.status, expected: status, positions: after.fields.map((field) => field.position),
      fieldsChanged: JSON.stringify(after.fields) !== JSON.stringify(before.fields),
      valuesChanged: JSON.stringify(after.values) !== JSON.stringify(before.values),
      historyChanged: JSON.stringify(after.history) !== JSON.stringify(before.history), events: projectEvents(f).length,
    }));
  }
  const result = expect(response, status);
  if (message) assert.match(result.message, message);
  assert.deepEqual(await snapshot(f), before, "a refused reorder changed fields, values or history");
  assert.deepEqual(projectEvents(f), [], "a refused reorder broadcast an event");
  return result;
}
function assertPositions(rows, ids, positions = ids.map((_, i) => i)) {
  assert.deepEqual(rows.map((row) => row.id), ids);
  assert.deepEqual(rows.map((row) => row.position), positions);
  assert.equal(new Set(rows.map((row) => row.position)).size, rows.length, "duplicate field positions");
}

for (const [label, select] of [
  ["duplicate replacing an omitted field", (ids) => [ids[0], ids[0], ids[2]]],
  ["incomplete subset", (ids) => [ids[2]]],
  ["duplicate appended to the complete list", (ids) => [...ids, ids[0]]],
]) {
  test(`${label} is refused without changing fields, values, history or events`, async () => {
    const f = await fixture(), ids = f.fields.map((field) => field.id);
    const list = select(ids);
    await refused(f, list, 400, undefined, /every custom field.*exactly once/);
  });
}

test("foreign and missing field IDs keep their 404, including mixed duplicate/incomplete lists", async () => {
  const f = await fixture(), foreign = await fixture();
  const ids = f.fields.map((field) => field.id);
  for (const bad of [foreign.fields[0].id, "missing-field"]) {
    for (const list of [[ids[0], bad, ids[2]], [ids[0], ids[0], bad], [bad]]) {
      await refused(f, list, 404, undefined, /not found in project/);
    }
  }
});

test("complete orders preserve definitions, values and history, return the exact order and broadcast once", async () => {
  const f = await fixture(), before = await snapshot(f), ids = f.fields.map((field) => field.id).reverse();
  const answer = expect(await reorder(f, ids), 200).data;
  assertPositions(answer, ids);
  const after = await snapshot(f);
  assertPositions(after.fields, ids);
  const definitions = (rows) => rows.map(({ position, updatedAt, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(definitions(after.fields), definitions(before.fields));
  assert.deepEqual(after.values, before.values);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(projectEvents(f), [[f.project.id, "custom_field_updated", { reordered: true }]]);
  events.length = 0;
  assertPositions(expect(await call(f, "GET", ""), 200).data, ids);
  assert.deepEqual(projectEvents(f), []);
});

test("roles, project boundaries, single-field and empty-project schema behavior are preserved", async () => {
  const f = await fixture({ count: 1, roles: true }), ids = f.fields.map((field) => field.id);
  const apiKey = (await createApiKey(app.prisma, f.user.id, { name: "Field reorder", expiresInDays: null })).key;
  for (const token of [f.token, f.tokens.MEMBER, apiKey]) {
    assertPositions(expect(await reorder(f, ids, token), 200).data, ids);
  }
  await refused(f, ids, 403, f.tokens.VIEWER);
  await refused(f, ids, 403, f.tokens.unjoined);
  await refused(f, ids, 401, null);
  await refused(f, [], 400);
  const empty = await fixture({ count: 0 });
  await refused(empty, [], 400);
  await refused(empty, [ids[0]], 404);
  await refused({ ...f, project: { id: "missing-project" } }, ids, 404);
  await refused(f, [ids[0], ids[0]], 400, apiKey);
});

// Hold the project order row on a separate backend. The first HTTP request
// must enter PostgreSQL's lock queue, then the second must wait behind that
// backend. Release only after observing both: no sleeps decide request order.
async function orderedRace(f, first, second) {
  let ready, failed, release, holderPid, firstPid, firstDone = false, secondDone = false;
  const acquired = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const released = new Promise((resolve) => { release = resolve; });
  const holder = control.$transaction(async (tx) => {
    [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id} FOR NO KEY UPDATE`;
    ready();
    await released;
  }, { timeout: 10_000, maxWait: 5000 });
  holder.catch(failed);
  const pending = [], observed = { firstWaited: false, secondWaited: false };
  const projectOrderQuery = /FROM "Project".*FOR NO KEY UPDATE/s;
  const waiters = () => control.$queryRaw`
    SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
  async function until(check, finished) {
    const deadline = performance.now() + 1500;
    do {
      if (await check()) return true;
      if (finished()) return false;
      await sleep(10);
    } while (performance.now() < deadline);
    return false;
  }
  let failsafe;
  try {
    await acquired;
    failsafe = setTimeout(release, 4000);
    pending.push(first().finally(() => firstDone = true));
    observed.firstWaited = await until(async () => {
      // Activity text and live blocker information can straddle statements.
      // Keep polling until both identify the order-lock wait we need to prove.
      const row = (await waiters()).find((waiter) => waiter.blockers.includes(holderPid) && projectOrderQuery.test(waiter.query));
      if (row) { firstPid = row.pid; assert.match(row.query, projectOrderQuery); }
      return Boolean(row);
    }, () => firstDone);
    pending.push(second().finally(() => secondDone = true));
    observed.secondWaited = await until(async () => {
      const row = (await waiters()).find((waiter) => waiter.pid !== firstPid && waiter.blockers.includes(firstPid) && projectOrderQuery.test(waiter.query));
      if (row) assert.match(row.query, projectOrderQuery);
      return Boolean(row);
    }, () => secondDone);
  } finally {
    clearTimeout(failsafe);
    release();
    await Promise.allSettled([holder, ...pending]);
  }
  await holder;
  const responses = await Promise.all(pending);
  console.info("field order queue", JSON.stringify({ firstPid, holderPid, ...observed, statuses: responses.map((response) => response.status) }));
  assert(observed.firstWaited, "first request did not wait on the Project order lock");
  assert(observed.secondWaited, "second request did not wait behind the first in PostgreSQL");
  assert.equal(secondDone, true);
  console.info("field order serialized", JSON.stringify({ firstPid, holderPid, ...observed }));
  return responses;
}

for (const participant of ["create", "delete"]) {
  for (const firstIsReorder of [true, false]) {
    test(`reorder versus ${participant}: ${firstIsReorder ? "reorder" : participant} first is serialized in PostgreSQL`, async () => {
      const f = await fixture(), before = await snapshot(f), ids = f.fields.map((field) => field.id).reverse();
      const writer = () => participant === "create" ? create(f, "Added") : remove(f, f.fields[1]);
      const sorting = () => reorder(f, ids);
      const responses = await orderedRace(f, firstIsReorder ? sorting : writer, firstIsReorder ? writer : sorting);
      const [sorted, written] = firstIsReorder ? responses : responses.toReversed();
      const newField = expect(written, participant === "create" ? 201 : 204)?.data;
      expect(sorted, firstIsReorder ? 200 : participant === "create" ? 400 : 404);
      const final = await fields(f);
      if (participant === "create") {
        assertPositions(final, [...(firstIsReorder ? ids : f.fields.map((field) => field.id)), newField.id]);
        assert.deepEqual(await values(f), before.values);
      } else {
        const kept = (firstIsReorder ? ids : f.fields.map((field) => field.id)).filter((id) => id !== f.fields[1].id);
        assertPositions(final, kept, [0, 2]); // Deletion leaves a harmless gap.
        assert.deepEqual(await values(f), before.values.filter((value) => value.fieldId !== f.fields[1].id));
      }
      assert.deepEqual(await history(f), before.history);
      const emitted = projectEvents(f);
      assert.equal(emitted.length, firstIsReorder ? 2 : 1);
      assert.equal(emitted.filter(([, name]) => name === "custom_field_updated").length, firstIsReorder ? 1 : 0);
      if (!firstIsReorder) {
        const unchanged = (rows) => rows.filter((row) => row.id !== newField?.id && (participant !== "delete" || row.id !== f.fields[1].id));
        assert.deepEqual(unchanged(final), unchanged(before.fields), "refused stale list partly reordered surviving fields");
      }
    });
  }
}

test("two creates append distinct positions under the same project serialization", async () => {
  const f = await fixture();
  const [a, b] = await orderedRace(f, () => create(f, "Added A"), () => create(f, "Added B"));
  assertPositions(await fields(f), [...f.fields.map((field) => field.id), expect(a, 201).data.id, expect(b, 201).data.id]);
  assert.equal(projectEvents(f).length, 2);
});

test("create, delete and reorder retain the project-busy bound without rows or events", async () => {
  const f = await fixture(), before = await snapshot(f);
  let ready, failed, release;
  const acquired = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  const released = new Promise((resolve) => { release = resolve; });
  const holder = control.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${f.project.id} FOR NO KEY UPDATE`;
    ready(); await released;
  }, { timeout: 12_000 });
  holder.catch(failed);
  let failsafe;
  try {
    await acquired;
    failsafe = setTimeout(release, 9000);
    const start = performance.now();
    const responses = await Promise.all([
      reorder(f, f.fields.map((field) => field.id).reverse()), create(f, "Refused create"), remove(f, f.fields[1]),
    ]);
    const elapsed = performance.now() - start;
    for (const response of responses) assert.match(expect(response, 503).message, /project is busy/i);
    assert(elapsed >= 4000 && elapsed < 8000, `busy response took ${elapsed}ms`);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(projectEvents(f), []);
  } finally {
    clearTimeout(failsafe); release(); await holder;
  }
});

test("create name conflicts and delete parent checks retain their errors without changes or events", async () => {
  const f = await fixture(), foreign = await fixture(), before = await snapshot(f);
  expect(await create(f, f.fields[0].name), 409);
  expect(await remove(f, foreign.fields[0]), 404);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual(projectEvents(f), []);
});
