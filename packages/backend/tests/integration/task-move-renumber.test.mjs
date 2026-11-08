import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

// Task moves keep dense 0..n-1 positions with a constant number of statements.
// A column of n tasks used to be one UPDATE per shifted row.

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
actorUrl.searchParams.set("connection_limit", "5");
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "task-move-renumber-jwt",
  COOKIE_SECRET: "task-move-renumber-cookie",
});

const { PrismaClient } = await import("@prisma/client");
const { moveTask, deleteTask } =
  await import("../../src/modules/tasks/tasks.service.ts");
const { shiftColumnsForMove, withProjectOrder } =
  await import("../../src/utils/task-order.ts");
const { recordQueries } = await import("./support/query-events.mjs");

const workspaceIds = [];
const userIds = [];
let actor;
let control;

before(async () => {
  actor = new PrismaClient({
    datasources: { db: { url: actorUrl.toString() } },
    log: [{ level: "query", emit: "event" }],
  });
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await Promise.all([actor.$connect(), control.$connect()]);
});

after(async () => {
  try {
    if (actor) {
      await actor.task.deleteMany({
        where: { project: { workspaceId: { in: workspaceIds } } },
      });
      await actor.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await actor.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    await Promise.all([actor?.$disconnect(), control?.$disconnect()]);
  }
});

async function fixture(titles, { reviewTitles = [] } = {}) {
  const user = await actor.user.create({
    data: {
      email: `renumber-${crypto.randomUUID()}@example.test`,
      displayName: "Renumber",
      emailVerified: true,
    },
  });
  userIds.push(user.id);
  const workspace = await actor.workspace.create({
    data: {
      name: "Renumber",
      slug: crypto.randomUUID(),
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  workspaceIds.push(workspace.id);
  const project = await actor.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Renumber",
      members: { create: { userId: user.id } },
    },
  });
  const open = await actor.statusColumn.create({
    data: { projectId: project.id, name: "Open", position: 0 },
  });
  const review = await actor.statusColumn.create({
    data: { projectId: project.id, name: "Review", position: 1 },
  });
  const stamp = new Date("2020-01-01T00:00:00.000Z");
  const task = {};
  const make = async (statusId, title, position) => {
    task[title] = await actor.task.create({
      data: {
        projectId: project.id,
        statusId,
        title,
        position,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  };
  for (const [position, title] of titles.entries())
    await make(open.id, title, position);
  for (const [position, title] of reviewTitles.entries())
    await make(review.id, title, position);
  return { user, project, open, review, task };
}

async function column(statusId) {
  const rows = await actor.task.findMany({
    where: { statusId, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true, position: true },
  });
  assert.deepEqual(
    rows.map((row) => row.position),
    rows.map((_, index) => index),
    `positions are not 0..n-1: ${JSON.stringify(rows.map((row) => [row.title, row.position]))}`,
  );
  const ids = new Set(rows.map((row) => row.position));
  assert.equal(ids.size, rows.length, "two active tasks share a position");
  return rows.map((row) => row.title);
}

async function marks(projectId) {
  const rows = await actor.$queryRaw`
    SELECT id, title, "statusId", position, archived, xmin::text AS xmin, "updatedAt"
    FROM "Task"
    WHERE "projectId" = ${projectId}
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

function changedIds(before, after) {
  const changed = [];
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (!previous || previous.xmin !== row.xmin) changed.push(id);
  }
  return changed;
}

function taskUpdates(events) {
  return events.filter((event) =>
    /\bupdate\s+("Task"|"public"\."Task")/i.test(event.query),
  );
}

async function move(f, title, statusId, position) {
  const started = performance.now();
  const recorded = await recordQueries(actor, (client) =>
    moveTask(client, f.task[title].id, f.user.id, { statusId, position }),
  );
  recorded.ms = Math.round(performance.now() - started);
  return recorded;
}

test("a move to the top uses the same statement count on a short column and a 1,000-task column", async () => {
  const counts = [];
  for (const size of [8, 1000]) {
    const titles = Array.from(
      { length: size },
      (_, index) => `t${String(index).padStart(4, "0")}`,
    );
    const f = await fixture(titles);
    const before = await marks(f.project.id);
    const recorded = await move(f, titles.at(-1), f.open.id, 0);
    const updates = taskUpdates(recorded.events);
    const sql = updates
      .map((event) => event.query.replace(/\s+/g, " "))
      .join("\n");
    assert.equal(updates.length, 2, `size ${size} task updates:\n${sql}`);
    assert.match(sql, /position = position \+ 1/);
    assert.match(sql, /position >= /);
    assert.equal(
      await column(f.open.id).then((order) => order[0]),
      titles.at(-1),
    );
    assert.equal((await column(f.open.id)).length, size);
    const after = await marks(f.project.id);
    assert.equal(
      changedIds(before, after).length,
      size,
      "the range update did not rewrite the shifted rows",
    );
    counts.push({
      size,
      statements: recorded.events.length,
      updates: updates.length,
      ms: recorded.ms,
    });
  }
  assert.equal(
    counts[0].statements,
    counts[1].statements,
    JSON.stringify(counts),
  );
  assert.equal(counts[0].updates, counts[1].updates);
  console.info("move to top", counts);
});

test("a one-slot move rewrites only the shifted neighbour", async () => {
  const titles = Array.from({ length: 20 }, (_, index) => `s${index}`);
  const f = await fixture(titles);
  const archived = await actor.task.create({
    data: {
      projectId: f.project.id,
      statusId: f.open.id,
      title: "archived-in-range",
      position: 9,
      archived: true,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const before = await marks(f.project.id);
  const up = await move(f, "s10", f.open.id, 9);
  const upSql = taskUpdates(up.events)
    .map((event) => event.query.replace(/\s+/g, " "))
    .join("\n");
  assert.match(upSql, /position = position \+ 1/);
  assert.deepEqual(await column(f.open.id), [
    ...titles.slice(0, 9),
    "s10",
    "s9",
    ...titles.slice(11),
  ]);
  const afterUp = await marks(f.project.id);
  assert.deepEqual(
    changedIds(before, afterUp).sort(),
    [f.task.s9.id, f.task.s10.id].sort(),
  );
  assert.equal(afterUp.get(archived.id).xmin, before.get(archived.id).xmin);
  assert.equal(afterUp.get(archived.id).position, 9);

  const downBefore = await marks(f.project.id);
  const down = await move(f, "s0", f.open.id, 1);
  const downSql = taskUpdates(down.events)
    .map((event) => event.query.replace(/\s+/g, " "))
    .join("\n");
  assert.match(downSql, /position = position - 1/);
  const downAfter = await marks(f.project.id);
  const downChanged = changedIds(downBefore, downAfter);
  assert.equal(downChanged.length, 2, `rewrote ${downChanged.length} rows`);
  assert.equal(
    downAfter.get(f.task.s19.id).xmin,
    downBefore.get(f.task.s19.id).xmin,
  );
  assert.equal(
    downAfter.get(archived.id).xmin,
    downBefore.get(archived.id).xmin,
  );
});

test("moving to the same index or onto the end of another column does not rewrite the other tasks", async () => {
  const f = await fixture(["a", "b", "c", "d"], { reviewTitles: ["r"] });
  const before = await marks(f.project.id);
  await move(f, "c", f.open.id, 2);
  const stayed = await marks(f.project.id);
  assert.deepEqual(changedIds(before, stayed), [f.task.c.id]);
  assert.deepEqual(await column(f.open.id), ["a", "b", "c", "d"]);

  const crossBefore = await marks(f.project.id);
  await move(f, "d", f.review.id, 5);
  const crossAfter = await marks(f.project.id);
  assert.deepEqual(changedIds(crossBefore, crossAfter), [f.task.d.id]);
  assert.deepEqual(await column(f.open.id), ["a", "b", "c"]);
  assert.deepEqual(await column(f.review.id), ["r", "d"]);
  assert.equal(crossAfter.get(f.task.d.id).position, 1);
});

test("a cross-column move closes the source gap and shifts only the destination tail", async () => {
  const f = await fixture(["a", "b", "c", "d", "e"], {
    reviewTitles: ["r0", "r1", "r2"],
  });
  const before = await marks(f.project.id);
  const recorded = await move(f, "b", f.review.id, 1);
  const sql = taskUpdates(recorded.events)
    .map((event) => event.query.replace(/\s+/g, " "))
    .join("\n");
  assert.match(sql, /position = position - 1/);
  assert.match(sql, /position = position \+ 1/);
  assert.equal(taskUpdates(recorded.events).length, 3);
  assert.deepEqual(await column(f.open.id), ["a", "c", "d", "e"]);
  assert.deepEqual(await column(f.review.id), ["r0", "b", "r1", "r2"]);
  const after = await marks(f.project.id);
  const changed = new Set(changedIds(before, after));
  assert.equal(
    changed.has(f.task.a.id),
    false,
    "a task before the source gap was rewritten",
  );
  assert.equal(
    changed.has(f.task.r0.id),
    false,
    "a destination task before the index was rewritten",
  );
  for (const title of ["c", "d", "e", "b", "r1", "r2"])
    assert.equal(changed.has(f.task[title].id), true, title);
});

test("a column with gaps or shared positions becomes dense in board order", async () => {
  const f = await fixture(["a", "b", "c", "d"]);
  await actor.task.update({
    where: { id: f.task.a.id },
    data: { position: 0, createdAt: new Date("2020-01-01T00:00:00.000Z") },
  });
  await actor.task.update({
    where: { id: f.task.b.id },
    data: { position: 0, createdAt: new Date("2020-01-02T00:00:00.000Z") },
  });
  await actor.task.update({
    where: { id: f.task.c.id },
    data: { position: 5, createdAt: new Date("2020-01-03T00:00:00.000Z") },
  });
  await actor.task.update({
    where: { id: f.task.d.id },
    data: { position: 9, createdAt: new Date("2020-01-04T00:00:00.000Z") },
  });
  const recorded = await move(f, "d", f.open.id, 1);
  const sql = taskUpdates(recorded.events)
    .map((event) => event.query.replace(/\s+/g, " "))
    .join("\n");
  assert.match(sql, /ROW_NUMBER/);
  assert.equal(taskUpdates(recorded.events).length, 2);
  assert.deepEqual(await column(f.open.id), ["a", "d", "b", "c"]);

  const across = await fixture(["p", "q", "r"], { reviewTitles: ["x", "y"] });
  await actor.task.update({
    where: { id: across.task.p.id },
    data: { position: 0 },
  });
  await actor.task.update({
    where: { id: across.task.q.id },
    data: { position: 4 },
  });
  await actor.task.update({
    where: { id: across.task.r.id },
    data: { position: 8 },
  });
  await actor.task.update({
    where: { id: across.task.x.id },
    data: { position: 0 },
  });
  await actor.task.update({
    where: { id: across.task.y.id },
    data: { position: 7 },
  });
  await move(across, "q", across.review.id, 1);
  assert.deepEqual(await column(across.open.id), ["p", "r"]);
  assert.deepEqual(await column(across.review.id), ["x", "q", "y"]);
});

test("an archived task is not an active slot and is not shifted by a move", async () => {
  const f = await fixture(["a", "b", "c"], { reviewTitles: ["r"] });
  const parked = await actor.task.create({
    data: {
      projectId: f.project.id,
      statusId: f.open.id,
      title: "parked",
      position: 1,
      archived: true,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const before = await marks(f.project.id);
  await move(f, "c", f.open.id, 0);
  const after = await marks(f.project.id);
  assert.equal(after.get(parked.id).position, 1);
  assert.equal(after.get(parked.id).xmin, before.get(parked.id).xmin);
  assert.equal(after.get(parked.id).archived, true);
  assert.deepEqual(await column(f.open.id), ["c", "a", "b"]);

  const leaving = await fixture(["a", "b"], { reviewTitles: ["r"] });
  const archived = await actor.task.create({
    data: {
      projectId: leaving.project.id,
      statusId: leaving.open.id,
      title: "old",
      position: 4,
      archived: true,
    },
  });
  leaving.task.old = archived;
  const sourceBefore = await marks(leaving.project.id);
  await move(leaving, "old", leaving.review.id, 0);
  const sourceAfter = await marks(leaving.project.id);
  assert.equal(
    sourceAfter.get(leaving.task.a.id).xmin,
    sourceBefore.get(leaving.task.a.id).xmin,
  );
  assert.equal(
    sourceAfter.get(leaving.task.b.id).xmin,
    sourceBefore.get(leaving.task.b.id).xmin,
  );
  assert.equal(
    sourceAfter.get(leaving.task.r.id).xmin,
    sourceBefore.get(leaving.task.r.id).xmin,
  );
  assert.deepEqual(await column(leaving.open.id), ["a", "b"]);
  assert.deepEqual(await column(leaving.review.id), ["r"]);
  assert.equal(sourceAfter.get(archived.id).archived, true);
  assert.equal(sourceAfter.get(archived.id).statusId, leaving.review.id);
  assert.equal(sourceAfter.get(archived.id).position, 0);
});

test("a shift that waited does not roll updatedAt backwards", async () => {
  const f = await fixture(["a", "b", "c", "d"]);
  let started;
  const isStarted = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  // The transaction starts, and its now() freezes, before the other move.
  const queued = actor.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      started();
      await released;
      await withProjectOrder(tx, f.project.id, async (locked) => {
        const current = await locked.task.findUnique({
          where: { id: f.task.c.id },
          select: { position: true, statusId: true, archived: true },
        });
        const position = await shiftColumnsForMove(locked, {
          projectId: f.project.id,
          taskId: f.task.c.id,
          fromStatusId: current.statusId,
          toStatusId: f.open.id,
          toIndex: 0,
          fromPosition: current.position,
          archived: current.archived,
        });
        await locked.task.update({
          where: { id: f.task.c.id },
          data: { position },
        });
      });
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
  await isStarted;
  await sleep(50);
  await moveTask(actor, f.task.d.id, f.user.id, {
    statusId: f.open.id,
    position: 0,
  });
  const mid = await actor.task.findUnique({
    where: { id: f.task.a.id },
    select: { updatedAt: true },
  });
  release();
  await queued;
  const after = await actor.task.findUnique({
    where: { id: f.task.a.id },
    select: { updatedAt: true, position: true },
  });
  assert.ok(
    after.updatedAt.getTime() >= mid.updatedAt.getTime(),
    `updatedAt moved backwards: ${mid.updatedAt.toISOString()} -> ${after.updatedAt.toISOString()}`,
  );
  assert.deepEqual(await column(f.open.id), ["c", "d", "a", "b"]);
});

async function lockWaiters(holderPid) {
  return control.$queryRaw`
    SELECT pid, pg_blocking_pids(pid) AS blockers
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
 * Holds `rowId` locked, runs `first` until it waits on that lock, then runs
 * `second` until it waits behind `first`. `inspect` runs before the lock is
 * released, so it sees only rows committed before either request.
 */
async function race(rowId, first, second, inspect) {
  let release;
  const released = new Promise((resolve) => {
    release = resolve;
  });
  let ready;
  const isReady = new Promise((resolve) => {
    ready = resolve;
  });
  let holderPid = null;
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] =
        await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${rowId} FOR UPDATE`;
      ready();
      await released;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
  await isReady;
  const observed = { firstWaited: false, secondWaited: false };
  const running = [];
  try {
    running.push(first());
    observed.firstWaited = await until(async () =>
      (await lockWaiters(holderPid)).some((waiter) =>
        waiter.blockers.includes(holderPid),
      ),
    );
    let secondDone = false;
    running.push(
      second().finally(() => {
        secondDone = true;
      }),
    );
    await until(async () => {
      if (secondDone) return true;
      const waiters = await lockWaiters(holderPid);
      observed.secondWaited = waiters.some(
        (waiter) =>
          waiter.blockers.length > 0 && !waiter.blockers.includes(holderPid),
      );
      return observed.secondWaited;
    });
    observed.secondFinishedFirst = secondDone;
    observed.during = await inspect();
  } finally {
    release();
  }
  await holder;
  const [firstResult, secondResult] = await Promise.all(running);
  assert.equal(
    observed.firstWaited,
    true,
    "the move never waited on the locked task",
  );
  assert.equal(
    observed.secondWaited,
    true,
    "the second request did not wait for the move",
  );
  assert.equal(
    observed.secondFinishedFirst,
    false,
    "the second request finished while the move held the lock",
  );
  return { firstResult, secondResult, during: observed.during };
}

test("a delete or another move cannot commit while a move holds the order lock", async () => {
  const deleted = await fixture(["a", "b", "c", "d"]);
  const deletion = await race(
    deleted.task.b.id,
    () =>
      moveTask(actor, deleted.task.d.id, deleted.user.id, {
        statusId: deleted.open.id,
        position: 0,
      }),
    () => deleteTask(actor, deleted.task.c.id, deleted.user.id),
    async () =>
      actor.task.findMany({
        where: { projectId: deleted.project.id },
        orderBy: { position: "asc" },
        select: { title: true },
      }),
  );
  assert.deepEqual(
    deletion.during.map((row) => row.title),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(await column(deleted.open.id), ["d", "a", "b"]);
  assert.equal(await actor.task.count({ where: { id: deleted.task.c.id } }), 0);

  const moved = await fixture(["a", "b", "c", "d"]);
  const other = await race(
    moved.task.b.id,
    () =>
      moveTask(actor, moved.task.d.id, moved.user.id, {
        statusId: moved.open.id,
        position: 0,
      }),
    () =>
      moveTask(actor, moved.task.a.id, moved.user.id, {
        statusId: moved.open.id,
        position: 3,
      }),
    async () =>
      actor.task.findMany({
        where: { projectId: moved.project.id },
        orderBy: { position: "asc" },
        select: { title: true, position: true },
      }),
  );
  assert.deepEqual(other.during, [
    { title: "a", position: 0 },
    { title: "b", position: 1 },
    { title: "c", position: 2 },
    { title: "d", position: 3 },
  ]);
  assert.deepEqual(await column(moved.open.id), ["d", "b", "c", "a"]);
});
