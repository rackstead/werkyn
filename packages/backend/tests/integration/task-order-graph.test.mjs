import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

// Task order, column and dependency-graph invariants under real concurrency
// (DAT-012): real HTTP requests over TCP against PostgreSQL. Barrier cases hold
// a row lock on a control connection to park the first request inside its
// transaction, confirm in pg_stat_activity where the second one waits, and then
// release it. Free-running cases fire requests together without a barrier.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
// At most eight requests are in flight at once, and most of them wait for the
// project's order lock while holding a pooled connection, so the actor pool
// needs at least five; the full suite runs with exactly five. The lock holder
// and the observer use their own two-connection pool.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit")) actorUrl.searchParams.set("connection_limit", "6");
assert(Number(actorUrl.searchParams.get("connection_limit")) >= 5, "Task order fixtures require connection_limit>=5");
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-task-order-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "task-order-graph-jwt-secret",
  COOKIE_SECRET: "task-order-graph-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(4).toString("hex");
const userIds = [];
const workspaceIds = [];
const tokens = new Map();
let app, control, port;
let requests = 0;

before(async () => {
  control = new PrismaClient({ datasources: { db: { url: controlUrl.toString() } } });
  await control.$connect();
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});

after(async () => {
  try {
    if (app) {
      // Tasks first: a column cannot be deleted while a task still uses it.
      await app.prisma.task.deleteMany({ where: { project: { workspaceId: { in: workspaceIds } } } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    const closed = await Promise.allSettled([app?.close(), control?.$disconnect()]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed) if (result.status === "rejected") throw result.reason;
  }
});

// ─── Real HTTP over TCP ────────────────────────────────────

/** Requests are sent as the ADMIN of the latest fixture. */
let currentToken = null;

/** One request on its own TCP connection, from its own loopback address (per-IP rate limit). */
function call(method, url, body) {
  const n = ++requests;
  const localAddress = `127.78.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: `/api${url}`,
        localAddress,
        agent: false,
        headers: {
          authorization: `Bearer ${currentToken}`,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: text, label: `${method} ${url}` }));
      },
    );
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error(`${method} ${url} timed out`)));
    request.end(payload);
  });
}

function expectStatus(response, expected, context = "") {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert(
    allowed.includes(response.status),
    `${context}${response.label} -> ${response.status} (expected ${allowed.join("/")}): ${response.body}`,
  );
}

// ─── Fixtures ──────────────────────────────────────────────

/**
 * A workspace with one ADMIN and a project whose columns are `columns`
 * (positions 0, 1, …; "Done" is the completion column). `tasks` maps a column
 * name to task titles, created at positions 0, 1, … in that order. Task ids
 * are chosen by the caller when the test needs a particular id order.
 */
async function fixture({ columns = ["Open", "Review", "Done"], tasks = {}, ids = {} } = {}) {
  const id = crypto.randomBytes(4).toString("hex");
  const admin = await app.prisma.user.create({
    data: { email: `tog-${id}-${suffix}@example.test`, displayName: `Order ${id}`, emailVerified: true },
  });
  userIds.push(admin.id);
  currentToken = signAccessToken({ sub: admin.id, email: admin.email });
  const workspace = await app.prisma.workspace.create({
    data: { name: `Order ${id}`, slug: `tog-${id}-${suffix}`, members: { create: { userId: admin.id, role: "ADMIN" } } },
  });
  workspaceIds.push(workspace.id);
  const project = await app.prisma.project.create({
    data: { workspaceId: workspace.id, name: "Order project", members: { create: { userId: admin.id } } },
  });
  const column = {};
  for (const [position, name] of columns.entries()) {
    column[name] = await app.prisma.statusColumn.create({
      data: { projectId: project.id, name, position, isCompletion: name === "Done" },
    });
  }
  const task = {};
  for (const [name, titles] of Object.entries(tasks)) {
    for (const [position, title] of titles.entries()) {
      task[title] = await app.prisma.task.create({
        data: {
          ...(ids[title] ? { id: `${ids[title]}-${id}` } : {}),
          projectId: project.id,
          statusId: column[name].id,
          title,
          position,
        },
      });
    }
  }
  return { admin, workspace, project, column, task };
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

const LOCKABLE = new Set(["Task", "StatusColumn", "Subtask", "Project"]);
function lockRow(table, id) {
  assert(LOCKABLE.has(table));
  return (tx) => tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
}

async function lockWaiters(holderPid) {
  return control.$queryRaw`
    SELECT pid, wait_event AS "waitEvent", pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid() AND pid <> ${holderPid}::int
  `;
}

async function until(predicate, ms = 4000) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}

/**
 * The control transaction holds `hold`, starts `first` and waits until
 * PostgreSQL shows it blocked behind that lock. It then starts `second` and
 * waits (bounded) until `second` either completes or is blocked behind another
 * application backend, i.e. behind `first`. Releasing the control lock lets
 * them finish. The holder is always released and every request awaited.
 */
async function race(hold, first, second) {
  let release, ready;
  const released = new Promise((resolve) => (release = resolve));
  const isReady = new Promise((resolve) => (ready = resolve));
  let holderPid = null;
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await hold(tx);
      ready();
      await released;
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
  const observed = { firstWaitedOnControl: false, secondWaitedOnFirst: false, secondFinishedFirst: false };
  const running = [];
  try {
    await Promise.race([
      isReady,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was held");
      }),
    ]);
    running.push(first());
    observed.firstWaitedOnControl = await until(async () =>
      (await lockWaiters(holderPid)).some((w) => w.blockers.includes(holderPid)),
    );
    let done = false;
    running.push(second().finally(() => (done = true)));
    await until(async () => {
      if (done) return true;
      const waiters = await lockWaiters(holderPid);
      const behindFirst = waiters.find((w) => w.blockers.length > 0 && !w.blockers.includes(holderPid));
      if (behindFirst) {
        observed.secondWaitedOnFirst = true;
        observed.secondWaitEvent = behindFirst.waitEvent;
      }
      return observed.secondWaitedOnFirst;
    });
    observed.secondFinishedFirst = done;
  } finally {
    release();
    await Promise.allSettled([holder, ...running]);
  }
  await holder;
  const [firstResponse, secondResponse] = await Promise.all(running);
  assert(observed.firstWaitedOnControl, "the first request never reached the control lock");
  return { first: firstResponse, second: secondResponse, observed };
}

/** Lock evidence is checked after the invariants, so a failure names the real defect first. */
function assertSerialized(observed, context) {
  assert(
    observed.secondWaitedOnFirst && !observed.secondFinishedFirst,
    `${context}: the second request did not wait in PostgreSQL for the first ${JSON.stringify(observed)}`,
  );
  console.info(`serialized: ${context} (second waited on "${observed.secondWaitEvent}" behind the first)`);
}

// ─── Invariants ────────────────────────────────────────────

/** Active task titles of a column in board order. */
async function boardOrder(statusId) {
  const tasks = await app.prisma.task.findMany({
    where: { statusId, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { title: true },
  });
  return tasks.map((t) => t.title);
}

/**
 * Every column of the project orders its active tasks by distinct positions;
 * with `contiguous`, the positions are exactly 0..n-1. Subtasks of each task
 * likewise have distinct positions.
 */
async function assertValidOrder(f, context, { contiguous = false } = {}) {
  const tasks = await app.prisma.task.findMany({
    where: { projectId: f.project.id, archived: false },
    select: { title: true, statusId: true, position: true },
  });
  const byColumn = new Map();
  for (const t of tasks) byColumn.set(t.statusId, [...(byColumn.get(t.statusId) ?? []), t]);
  for (const [statusId, list] of byColumn) {
    const positions = list.map((t) => t.position).sort((a, b) => a - b);
    const name = Object.entries(f.column).find(([, c]) => c.id === statusId)?.[0] ?? statusId;
    assert.equal(
      new Set(positions).size,
      positions.length,
      `${context}: column ${name} has duplicate positions ${JSON.stringify(list.map((t) => [t.title, t.position]))}`,
    );
    if (contiguous) {
      assert.deepEqual(positions, positions.map((_, i) => i), `${context}: column ${name} is not contiguous`);
    }
  }
  const subtasks = await app.prisma.subtask.findMany({
    where: { task: { projectId: f.project.id } },
    select: { taskId: true, position: true },
  });
  const seen = new Set();
  for (const s of subtasks) {
    const key = `${s.taskId}:${s.position}`;
    assert(!seen.has(key), `${context}: duplicate subtask position ${key}`);
    seen.add(key);
  }
}

/** A dependency cycle among the project's tasks (as titles), or null. */
async function dependencyCycle(f) {
  const deps = await app.prisma.taskDependency.findMany({
    where: { blockedTask: { projectId: f.project.id } },
    select: { blockedTask: { select: { title: true } }, blockingTask: { select: { title: true } } },
  });
  const edges = new Map();
  for (const d of deps) edges.set(d.blockedTask.title, [...(edges.get(d.blockedTask.title) ?? []), d.blockingTask.title]);
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    if (state.get(node) === "done") return null;
    if (state.get(node) === "open") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "open");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}

const completionColumns = (f) =>
  app.prisma.statusColumn.findMany({ where: { projectId: f.project.id, isCompletion: true }, select: { name: true } });

// ─── Request shorthands ────────────────────────────────────

const addDependency = (blocked, blocking) =>
  call("POST", `/tasks/${blocked.id}/dependencies`, { blockingTaskId: blocking.id });
const createTask = (f, title, extra = {}) => call("POST", `/projects/${f.project.id}/tasks`, { title, ...extra });
const moveTask = (task, statusId, position) => call("PATCH", `/tasks/${task.id}/move`, { statusId, position });
const bulkUpdate = (f, body) => call("POST", `/projects/${f.project.id}/tasks/bulk-update`, body);
const deleteColumn = (f, column) => call("DELETE", `/projects/${f.project.id}/statuses/${column.id}`);
const updateColumn = (f, column, body) => call("PATCH", `/projects/${f.project.id}/statuses/${column.id}`, body);

// ─── Dependency graph ──────────────────────────────────────

test("opposite dependencies added at the same time: the second waits for the first and is refused", async () => {
  const f = await fixture({ tasks: { Open: ["A", "B"] } });
  const { A, B } = f.task;
  // The first add parks on its insert's foreign-key check of A, after its cycle check.
  const { first, second, observed } = await race(lockRow("Task", A.id), () => addDependency(A, B), () => addDependency(B, A));
  const cycle = await dependencyCycle(f);
  assert.equal(cycle, null, `a dependency cycle was stored: ${cycle?.join(" <- ")}`);
  expectStatus(first, 201, "A blocked by B: ");
  expectStatus(second, 400, "B blocked by A: ");
  assert.match(second.body, /would create a circular dependency/);
  assert.equal(await app.prisma.taskDependency.count({ where: { blockedTask: { projectId: f.project.id } } }), 1);
  assertSerialized(observed, "opposite dependency adds");
});

test("free-running: dependency adds racing around a loop never store a cycle", async () => {
  const outcomes = {};
  for (let i = 0; i < 20; i++) {
    const f = await fixture({ tasks: { Open: ["A", "B", "C"] } });
    const { A, B, C } = f.task;
    const jitter = () => sleep(Math.floor(Math.random() * 6));
    // A <- B <- C <- A, plus the direct opposite of the first edge.
    const responses = await Promise.all(
      [[A, B], [B, C], [C, A], [B, A]].map(([x, y]) => jitter().then(() => addDependency(x, y))),
    );
    const context = `iteration ${i}: `;
    for (const response of responses) {
      expectStatus(response, [201, 400], context);
      if (response.status === 400) assert.match(response.body, /circular dependency/, context);
      outcomes[response.status] = (outcomes[response.status] ?? 0) + 1;
    }
    const cycle = await dependencyCycle(f);
    assert.equal(cycle, null, `${context}a dependency cycle was stored: ${cycle?.join(" <- ")}`);
    const stored = await app.prisma.taskDependency.count({ where: { blockedTask: { projectId: f.project.id } } });
    assert.equal(stored, responses.filter((r) => r.status === 201).length, `${context}stored edges do not match the responses`);
  }
  console.info("free-running dependency outcomes", outcomes);
});

test("removing a dependency waits for a concurrent add instead of interleaving with its check", async () => {
  const f = await fixture({ tasks: { Open: ["A", "B", "C"] } });
  const { A, B, C } = f.task;
  const dependency = await app.prisma.taskDependency.create({ data: { blockedTaskId: B.id, blockingTaskId: C.id } });
  // The add parks on its insert after checking the graph; the removal of B <- C must queue behind it.
  const { first, second, observed } = await race(
    lockRow("Task", A.id),
    () => addDependency(A, B),
    () => call("DELETE", `/tasks/${B.id}/dependencies/${dependency.id}`),
  );
  expectStatus(first, 201, "add: ");
  expectStatus(second, 204, "remove: ");
  assert.equal(await dependencyCycle(f), null);
  assertSerialized(observed, "dependency add then remove");
});

// ─── Positions on create ───────────────────────────────────

test("tasks created at the same time in one column get distinct positions", async () => {
  const f = await fixture({ tasks: { Open: ["Existing"] } });
  // Both creates go to the first column; the first parks on its insert after choosing a position.
  const { first, second, observed } = await race(
    lockRow("StatusColumn", f.column.Open.id),
    () => createTask(f, "First"),
    () => createTask(f, "Second"),
  );
  expectStatus(first, 201, "first create: ");
  expectStatus(second, 201, "second create: ");
  await assertValidOrder(f, "concurrent creates", { contiguous: true });
  assert.deepEqual(await boardOrder(f.column.Open.id), ["Existing", "First", "Second"]);
  assertSerialized(observed, "two creates in one column");
});

test("subtasks created at the same time get distinct positions", async () => {
  const f = await fixture({ tasks: { Open: ["Parent"] } });
  const parent = f.task.Parent;
  const add = (title) => () => call("POST", `/tasks/${parent.id}/subtasks`, { title });
  // The first parks on its insert's foreign-key check of the parent, after choosing a position.
  const { first, second, observed } = await race(lockRow("Task", parent.id), add("One"), add("Two"));
  expectStatus(first, 201, "first subtask: ");
  expectStatus(second, 201, "second subtask: ");
  await assertValidOrder(f, "concurrent subtask creates");
  const positions = (await app.prisma.subtask.findMany({ where: { taskId: parent.id }, orderBy: { position: "asc" } }))
    .map((s) => [s.title, s.position]);
  assert.deepEqual(positions, [["One", 0], ["Two", 1]]);
  assertSerialized(observed, "two subtask creates");
});

test("free-running: bursts of creates, duplicates and template instantiations never share a position", async () => {
  const outcomes = {};
  for (let i = 0; i < 8; i++) {
    const f = await fixture({ tasks: { Open: ["Seed"] } });
    const template = await app.prisma.taskTemplate.create({
      data: { projectId: f.project.id, name: "Burst", title: "From template" },
    });
    const jitter = () => sleep(Math.floor(Math.random() * 6));
    const responses = await Promise.all([
      ...[0, 1, 2].map((n) => jitter().then(() => createTask(f, `Created ${n}`))),
      ...[0, 1].map(() => jitter().then(() => call("POST", `/tasks/${f.task.Seed.id}/duplicate`))),
      ...[0, 1].map(() =>
        jitter().then(() => call("POST", `/projects/${f.project.id}/templates/${template.id}/create-task`, {}))),
    ]);
    for (const response of responses) {
      expectStatus(response, 201, `iteration ${i}: `);
      outcomes[response.status] = (outcomes[response.status] ?? 0) + 1;
    }
    await assertValidOrder(f, `iteration ${i}`, { contiguous: true });
  }
  console.info("free-running create outcomes", outcomes);
});

// ─── Moves ─────────────────────────────────────────────────

test("two moves in one column apply one after the other instead of losing one", async () => {
  const f = await fixture({ tasks: { Open: ["t0", "t1", "t2", "t3"] } });
  const { t0, t1, t3 } = f.task;
  // Either serial order ends with t3 first and t0 last.
  const { first, second, observed } = await race(
    lockRow("Task", t1.id),
    () => moveTask(t3, f.column.Open.id, 0),
    () => moveTask(t0, f.column.Open.id, 3),
  );
  expectStatus(first, 200, "move t3 to the top: ");
  expectStatus(second, 200, "move t0 to the bottom: ");
  await assertValidOrder(f, "two same-column moves", { contiguous: true });
  assert.deepEqual(await boardOrder(f.column.Open.id), ["t3", "t1", "t2", "t0"], "a move was lost");
  assertSerialized(observed, "two same-column moves");
});

test("a move and a bulk update over the same tasks queue instead of deadlocking", async () => {
  // R has the lowest id and the highest position: the move renumbers P, Q, R in
  // position order, while the bulk update locks R before P (id and heap order).
  const f = await fixture({
    tasks: { Open: ["R", "P", "Q", "X"] },
    ids: { R: "a-r", P: "m-p", Q: "m-q", X: "m-x" },
  });
  const { P, Q, R, X } = f.task;
  await app.prisma.task.update({ where: { id: R.id }, data: { position: 2 } });
  await app.prisma.task.update({ where: { id: P.id }, data: { position: 0 } });
  await app.prisma.task.update({ where: { id: Q.id }, data: { position: 1 } });
  // Moving X to the top renumbers P, Q, R; the move parks on Q after locking P.
  const { first, second, observed } = await race(
    lockRow("Task", Q.id),
    () => moveTask(X, f.column.Open.id, 0),
    () => bulkUpdate(f, { taskIds: [R.id, P.id], priority: "HIGH" }),
  );
  expectStatus(first, 200, "move: ");
  expectStatus(second, 200, "bulk update: ");
  await assertValidOrder(f, "move and bulk update", { contiguous: true });
  assert.deepEqual(await boardOrder(f.column.Open.id), ["X", "P", "Q", "R"]);
  const high = await app.prisma.task.count({ where: { id: { in: [R.id, P.id] }, priority: "HIGH" } });
  assert.equal(high, 2, "the bulk update was not applied");
  assertSerialized(observed, "move then bulk update");
});

test("an ordering write that PostgreSQL aborts to break a deadlock is retried and succeeds", async () => {
  const f = await fixture({ tasks: { Open: ["Mover"], Review: ["Parked"] } });
  const { Mover, Parked } = f.task;
  const deadlocks = async () =>
    Number((await control.$queryRaw`
      SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()
    `)[0].deadlocks);
  const deadlocksBefore = await deadlocks();
  let holderPid = null;
  let ready;
  const isReady = new Promise((resolve) => (ready = resolve));
  // The control transaction holds Parked; the move (holding the project) waits
  // for it while renumbering Review. The control then asks for the project row,
  // closing the cycle: PostgreSQL aborts the move, which has waited longest.
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await lockRow("Task", Parked.id)(tx);
      ready();
      assert(
        await until(async () => (await lockWaiters(holderPid)).some((w) => w.blockers.includes(holderPid))),
        "the move never reached the control lock",
      );
      await lockRow("Project", f.project.id)(tx);
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
  await isReady;
  const response = await moveTask(Mover, f.column.Review.id, 0);
  await holder;
  // PostgreSQL did abort one attempt (statistics arrive within about a second).
  assert(await until(async () => (await deadlocks()) > deadlocksBefore, 5000), "no deadlock was detected");
  expectStatus(response, 200, "deadlocked move: ");
  assert.deepEqual(await boardOrder(f.column.Review.id), ["Mover", "Parked"]);
  await assertValidOrder(f, "retried move", { contiguous: true });
});

// ─── Bulk changes and column deletion keep the order ───────

test("a bulk status change appends the moved tasks to the destination without duplicate positions", async () => {
  const f = await fixture({ tasks: { Open: ["o0", "o1", "o2"], Review: ["r0", "r1"] } });
  const { o0, o2, r1 } = f.task;
  const response = await bulkUpdate(f, { taskIds: [o2.id, o0.id], statusId: f.column.Review.id });
  expectStatus(response, 200, "bulk move: ");
  await assertValidOrder(f, "bulk move");
  // Existing destination tasks keep their order; moved ones follow in board order.
  assert.deepEqual(await boardOrder(f.column.Review.id), ["r0", "r1", "o0", "o2"]);
  assert.deepEqual(await boardOrder(f.column.Open.id), ["o1"]);
  // Tasks already in the destination stay where they are.
  const again = await bulkUpdate(f, { taskIds: [r1.id, f.task.o1.id], statusId: f.column.Review.id });
  expectStatus(again, 200, "bulk move including a task already there: ");
  await assertValidOrder(f, "second bulk move");
  assert.deepEqual(await boardOrder(f.column.Review.id), ["r0", "r1", "o0", "o2", "o1"]);
});

test("bulk and single unarchive put tasks back at the end of their column", async () => {
  const f = await fixture({ tasks: { Open: ["a0", "a1", "a2", "a3"] } });
  const { a0, a1 } = f.task;
  for (const task of [a0, a1]) expectStatus(await call("PATCH", `/tasks/${task.id}/archive`, { archived: true }), 200);
  // Two new tasks take the next positions while a0 and a1 are archived.
  expectStatus(await createTask(f, "n0"), 201);
  expectStatus(await moveTask(f.task.a3, f.column.Open.id, 0), 200);
  const bulk = await bulkUpdate(f, { taskIds: [a1.id], archived: false });
  expectStatus(bulk, 200, "bulk unarchive: ");
  await assertValidOrder(f, "bulk unarchive");
  const single = await call("PATCH", `/tasks/${a0.id}/archive`, { archived: false });
  expectStatus(single, 200, "unarchive: ");
  await assertValidOrder(f, "unarchive");
  assert.deepEqual(await boardOrder(f.column.Open.id), ["a3", "a2", "n0", "a1", "a0"]);
});

test("deleting a column appends its tasks to the target column in their order", async () => {
  const f = await fixture({ tasks: { Open: ["o0", "o1"], Review: ["r0", "r1", "r2"] } });
  const response = await deleteColumn(f, f.column.Review);
  expectStatus(response, 204, "column delete: ");
  await assertValidOrder(f, "column delete", { contiguous: true });
  assert.deepEqual(await boardOrder(f.column.Open.id), ["o0", "o1", "r0", "r1", "r2"]);
});

test("two non-empty columns deleted at the same time both succeed", async () => {
  // Deleting Open moves its tasks to Review (the lowest remaining column) and
  // deleting Review moves its tasks to Open: before serialization each held
  // its own column and waited for the other.
  const f = await fixture({ tasks: { Open: ["o0"], Review: ["r0"], Done: ["d0"] } });
  const { first, second, observed } = await race(
    lockRow("Task", f.task.o0.id),
    () => deleteColumn(f, f.column.Open),
    () => deleteColumn(f, f.column.Review),
  );
  expectStatus(first, 204, "delete Open: ");
  expectStatus(second, 204, "delete Review: ");
  const columns = await app.prisma.statusColumn.findMany({ where: { projectId: f.project.id }, select: { name: true } });
  assert.deepEqual(columns.map((c) => c.name), ["Done"]);
  await assertValidOrder(f, "two column deletes", { contiguous: true });
  // Open's task went to Review first, then both followed Review's into Done.
  assert.deepEqual(await boardOrder(f.column.Done.id), ["d0", "r0", "o0"]);
  assertSerialized(observed, "two column deletes");
});

test("free-running: deleting the last two columns at the same time always leaves one", async () => {
  const outcomes = {};
  for (let i = 0; i < 20; i++) {
    const f = await fixture({ columns: ["Open", "Review"] });
    const jitter = () => sleep(Math.floor(Math.random() * 4));
    const responses = await Promise.all([
      jitter().then(() => deleteColumn(f, f.column.Open)),
      jitter().then(() => deleteColumn(f, f.column.Review)),
    ]);
    const context = `iteration ${i}: `;
    const columns = await app.prisma.statusColumn.count({ where: { projectId: f.project.id } });
    assert.equal(columns, 1, `${context}the project has ${columns} columns`);
    assert.deepEqual(responses.map((r) => r.status).sort(), [204, 409], `${context}${responses.map((r) => r.body)}`);
    assert.match(responses.find((r) => r.status === 409).body, /Cannot delete the last status column/, context);
    for (const r of responses) outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
  }
  console.info("free-running last-column outcomes", outcomes);
});

test("two columns marked as the completion column at the same time leave exactly one", async () => {
  const f = await fixture();
  // Both updates first clear the current completion column (Done); the first parks there.
  const { first, second, observed } = await race(
    lockRow("StatusColumn", f.column.Done.id),
    () => updateColumn(f, f.column.Review, { isCompletion: true }),
    () => updateColumn(f, f.column.Open, { isCompletion: true }),
  );
  expectStatus(first, 200, "Review: ");
  expectStatus(second, 200, "Open: ");
  assert.deepEqual((await completionColumns(f)).map((c) => c.name), ["Open"]);
  assertSerialized(observed, "two completion updates");
});

// ─── Reorder payloads ──────────────────────────────────────

test("column and subtask reorders must list every item exactly once", async () => {
  const f = await fixture({ tasks: { Open: ["Parent"] } });
  const { Open, Review, Done } = f.column;
  const reorderColumns = (orderedIds) => call("PATCH", `/projects/${f.project.id}/statuses/reorder`, { orderedIds });
  const columnPositions = async () =>
    (await app.prisma.statusColumn.findMany({ where: { projectId: f.project.id }, orderBy: { position: "asc" } }))
      .map((c) => [c.name, c.position]);
  const before = await columnPositions();
  for (const [name, ids] of [
    ["duplicate", [Done.id, Done.id, Open.id, Review.id]],
    ["duplicate in place of one", [Done.id, Done.id, Open.id]],
    ["missing", [Review.id, Open.id]],
  ]) {
    const response = await reorderColumns(ids);
    expectStatus(response, 400, `${name} column reorder: `);
    assert.match(response.body, /must list every status column of the project exactly once/, name);
    assert.deepEqual(await columnPositions(), before, `${name} column reorder changed positions`);
  }
  expectStatus(await reorderColumns([Done.id, Open.id, Review.id]), 200);
  assert.deepEqual(await columnPositions(), [["Done", 0], ["Open", 1], ["Review", 2]]);

  const parent = f.task.Parent;
  const subtasks = [];
  for (const title of ["s0", "s1", "s2"]) {
    const created = await call("POST", `/tasks/${parent.id}/subtasks`, { title });
    expectStatus(created, 201);
    subtasks.push(JSON.parse(created.body).data.id);
  }
  const reorderSubtasks = (orderedIds) => call("POST", `/tasks/${parent.id}/subtasks/reorder`, { orderedIds });
  const subtaskOrder = async () =>
    (await app.prisma.subtask.findMany({ where: { taskId: parent.id }, orderBy: { position: "asc" } }))
      .map((s) => [s.title, s.position]);
  for (const [name, ids] of [
    ["duplicate", [subtasks[2], subtasks[2], subtasks[0], subtasks[1]]],
    ["duplicate in place of one", [subtasks[2], subtasks[2], subtasks[0]]],
    ["missing", [subtasks[1], subtasks[0]]],
  ]) {
    const response = await reorderSubtasks(ids);
    expectStatus(response, 400, `${name} subtask reorder: `);
    assert.match(response.body, /must list every subtask of the task exactly once/, name);
    assert.deepEqual(await subtaskOrder(), [["s0", 0], ["s1", 1], ["s2", 2]], `${name} subtask reorder changed positions`);
  }
  expectStatus(await reorderSubtasks([subtasks[2], subtasks[0], subtasks[1]]), 200);
  assert.deepEqual(await subtaskOrder(), [["s2", 0], ["s0", 1], ["s1", 2]]);
});

test("columns created at the same time get distinct positions and one completion column", async () => {
  const f = await fixture();
  const create = (name) => () =>
    call("POST", `/projects/${f.project.id}/statuses`, { name, color: "#000000", isCompletion: true });
  // The first create parks on the project row (its insert's foreign-key check
  // before; the order lock now), after clearing Done as the completion column.
  const { first, second, observed } = await race(lockRow("Project", f.project.id), create("First"), create("Second"));
  expectStatus(first, 201, "first column: ");
  expectStatus(second, 201, "second column: ");
  const columns = await app.prisma.statusColumn.findMany({ where: { projectId: f.project.id }, orderBy: { position: "asc" } });
  assert.equal(new Set(columns.map((c) => c.position)).size, columns.length, `duplicate column positions ${JSON.stringify(columns.map((c) => [c.name, c.position]))}`);
  assert.deepEqual(columns.map((c) => c.name), ["Open", "Review", "Done", "First", "Second"]);
  assert.deepEqual((await completionColumns(f)).map((c) => c.name), ["Second"]);
  assertSerialized(observed, "two column creates");
});

// ─── Mixed free-running workload ───────────────────────────

test("free-running: mixed ordering writes keep every column valid and never fail", async () => {
  const outcomes = {};
  for (let i = 0; i < 12; i++) {
    const f = await fixture({
      tasks: { Open: ["o0", "o1", "o2", "o3", "o4"], Review: ["r0", "r1", "r2"], Done: ["d0"] },
    });
    const { o0, o1, o2, o3, o4, r0, r2 } = f.task;
    const { Open, Review, Done } = f.column;
    const jitter = () => sleep(Math.floor(Math.random() * 8));
    const work = [
      ["create", 201, () => createTask(f, "c0", { statusId: Review.id })],
      ["create", 201, () => createTask(f, "c1", { statusId: Review.id })],
      ["move across", 200, () => moveTask(o0, Review.id, 1)],
      ["move across", 200, () => moveTask(r0, Open.id, 0)],
      ["move within", 200, () => moveTask(o2, Open.id, 4)],
      ["bulk status", 200, () => bulkUpdate(f, { taskIds: [o3.id, r2.id], statusId: Done.id })],
      ["bulk priority", 200, () => bulkUpdate(f, { taskIds: [o1.id, o4.id, r2.id], priority: "HIGH" })],
      ["status change", 200, () => call("PATCH", `/tasks/${o4.id}`, { statusId: Review.id })],
    ];
    const responses = await Promise.all(work.map(([, , send]) => jitter().then(send)));
    const context = `iteration ${i}: `;
    responses.forEach((response, index) => {
      const [name, ok] = work[index];
      expectStatus(response, ok, `${context}${name}: `);
      outcomes[`${name} ${response.status}`] = (outcomes[`${name} ${response.status}`] ?? 0) + 1;
    });
    await assertValidOrder(f, `iteration ${i}`);
    const total = await app.prisma.task.count({ where: { projectId: f.project.id } });
    assert.equal(total, 11, `${context}task count`);
  }
  console.info("free-running mixed outcomes", outcomes);
});
