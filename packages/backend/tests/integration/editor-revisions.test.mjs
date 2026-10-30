import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
// Up to three requests wait on PostgreSQL row locks at once, each holding one
// pooled connection inside its transaction. The lock holder and the
// pg_stat_activity observer use their own pool so waiting requests can never
// starve the control that releases them.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit"))
  actorUrl.searchParams.set("connection_limit", "5");
assert(
  Number(actorUrl.searchParams.get("connection_limit")) >= 5,
  "Editor revision races require connection_limit>=5",
);
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-revisions-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "editor-revisions-jwt-secret",
  COOKIE_SECRET: "editor-revisions-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const users = {};
const tokens = {};
let app, control, workspace, space, project, column;
let requests = 0;
let counter = 0;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  app.broadcastToWorkspace = () => {};
  app.broadcastToUser = () => {};
  app.broadcast = () => {};
  for (const name of ["ALICE", "BOB", "VIEWER"]) {
    users[name] = await app.prisma.user.create({
      data: {
        email: `revisions-${name}-${suffix}@example.test`,
        displayName: name,
        emailVerified: true,
      },
    });
    tokens[name] = signAccessToken({
      sub: users[name].id,
      email: users[name].email,
    });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Editor revisions",
      slug: `revisions-${suffix}`,
      members: {
        create: [
          { userId: users.ALICE.id, role: "MEMBER" },
          { userId: users.BOB.id, role: "MEMBER" },
          { userId: users.VIEWER.id, role: "VIEWER" },
        ],
      },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: "Docs",
      slug: `docs-${suffix}`,
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Revisions",
      members: {
        create: [{ userId: users.ALICE.id }, { userId: users.BOB.id }],
      },
    },
  });
  column = await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "Open" },
  });
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.task.deleteMany({
        where: { projectId: project?.id },
      });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((u) => u.id) } },
      });
    }
  } finally {
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
});

function req(actor, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.92.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
  return response.body ? response.json() : undefined;
}

/** Asserts a 409 that wrote nothing and reports the stored revision. */
function conflict(response, code, revision) {
  const body = status(response, 409);
  assert.equal(body.code, code, response.body);
  assert.equal(body.current.revision, revision, response.body);
  assert.equal(typeof body.current.updatedAt, "string");
  return body;
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

let holderPid = null;

async function waitForLockWaiters(expected) {
  const deadline = performance.now() + 5000;
  let observed = 0;
  while (performance.now() < deadline) {
    const [row] = await control.$queryRaw`
      SELECT count(*)::int AS total FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        AND pid <> ${holderPid}::int
    `;
    observed = row.total;
    if (observed >= expected) return;
    await sleep(10);
  }
  assert.fail(`Expected ${expected} PostgreSQL lock waiters, saw ${observed}`);
}

/**
 * Holds `table` row `id` FOR UPDATE in a control transaction while the
 * requests start, so every request has passed authentication and its reads
 * and is waiting in PostgreSQL before any of them can write. `starts` run in
 * order, each after the previous one is observed waiting: PostgreSQL grants a
 * row lock to its waiters in arrival order, which models one request being
 * delivered before another. `during` runs while they all wait.
 */
async function race(table, id, starts, during) {
  let unlock, locked;
  const unlocked = new Promise((resolve) => (unlock = resolve));
  const ready = new Promise((resolve) => (locked = resolve));
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRawUnsafe(
        `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
        id,
      );
      locked();
      await unlocked;
    },
    { timeout: 15_000, maxWait: 2_000 },
  );
  const running = [];
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    for (const start of starts) {
      running.push(Promise.resolve(start()));
      await waitForLockWaiters(running.length);
    }
    await during?.();
  } finally {
    unlock();
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

// ─── Fixtures ──────────────────────────────────────────────

function doc(text) {
  return [{ type: "paragraph", content: text }];
}

async function newPage(text = "original") {
  counter++;
  return app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: `Page ${counter}`,
      content: doc(text),
      position: counter,
      createdById: users.ALICE.id,
    },
  });
}

async function stored(pageId) {
  return app.prisma.wikiPage.findUniqueOrThrow({ where: { id: pageId } });
}

function save(actor, pageId, body) {
  return req(actor, "PATCH", `/api/wiki/pages/${pageId}`, body);
}

function acquire(actor, pageId) {
  return req(actor, "POST", `/api/wiki/pages/${pageId}/lock`);
}

/** Lets a held lock lapse, as if its holder stopped renewing it. */
async function expireLock(pageId) {
  await app.prisma.wikiPageLock.update({
    where: { pageId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
}

async function newTask(description = "<p>original</p>") {
  counter++;
  return app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: column.id,
      title: `Task ${counter}`,
      description,
      position: counter,
      assignees: {
        create: [{ userId: users.ALICE.id }, { userId: users.BOB.id }],
      },
    },
  });
}

function saveTask(actor, taskId, body) {
  return req(actor, "PATCH", `/api/tasks/${taskId}`, body);
}

// ─── Wiki pages ────────────────────────────────────────────

test("a page save is a compare-and-set on the revision it was based on", async () => {
  const page = await newPage();
  const read = status(await req("ALICE", "GET", `/api/wiki/pages/${page.id}`), 200);
  assert.equal(read.data.revision, 0);

  const first = status(
    await save("ALICE", page.id, { content: doc("first"), expectedRevision: 0 }),
    200,
  );
  assert.equal(first.data.revision, 1);
  assert.deepEqual(first.data.content, doc("first"));

  // A second editor still holding revision 0 is refused, not merged.
  const stale = conflict(
    await save("BOB", page.id, { content: doc("stale"), expectedRevision: 0 }),
    "REVISION_CONFLICT",
    1,
  );
  assert.equal(stale.current.updatedAt, first.data.updatedAt);
  const after = await stored(page.id);
  assert.deepEqual(after.content, doc("first"));
  assert.equal(after.revision, 1);
  assert.equal(after.lastEditedById, users.ALICE.id);

  // Reloading gives the current revision, and a save based on it applies.
  const next = status(
    await save("BOB", page.id, { title: "Renamed", expectedRevision: 1 }),
    200,
  );
  assert.equal(next.data.revision, 2);
  assert.equal(next.data.title, "Renamed");
  assert.deepEqual(next.data.content, doc("first"));
});

test("concurrent saves based on one revision: exactly one is stored, the others get 409", async () => {
  const page = await newPage();
  // Three tabs of the lock holder, so only the revision decides.
  status(await acquire("ALICE", page.id), 200);
  const texts = ["tab one", "tab two", "tab three"];
  const responses = await race(
    "WikiPage",
    page.id,
    texts.map((text) => () =>
      save("ALICE", page.id, { content: doc(text), expectedRevision: 0 }),
    ),
  );
  const won = responses.filter((r) => r.statusCode === 200);
  assert.equal(won.length, 1, responses.map((r) => r.body).join("\n"));
  for (const response of responses.filter((r) => r !== won[0]))
    conflict(response, "REVISION_CONFLICT", 1);
  const after = await stored(page.id);
  assert.equal(after.revision, 1);
  assert.deepEqual(after.content, won[0].json().data.content);
  // Arrival order decides: the first request delivered is the one stored.
  assert.deepEqual(after.content, doc("tab one"));
});

test("a save delivered after a newer one is refused instead of reverting it", async () => {
  const page = await newPage();
  status(await acquire("ALICE", page.id), 200);
  // The client sends A (based on 0), then B (based on A's revision 1). A
  // retransmitted copy of A arrives after B was stored.
  const a = status(
    await save("ALICE", page.id, { content: doc("A"), expectedRevision: 0 }),
    200,
  );
  status(
    await save("ALICE", page.id, {
      content: doc("B"),
      expectedRevision: a.data.revision,
    }),
    200,
  );
  conflict(
    await save("ALICE", page.id, { content: doc("A"), expectedRevision: 0 }),
    "REVISION_CONFLICT",
    2,
  );
  assert.deepEqual((await stored(page.id)).content, doc("B"));

  // Two tabs both based on revision 2; the one sent second is delivered first.
  const [late, early] = await race("WikiPage", page.id, [
    () => save("ALICE", page.id, { content: doc("sent second"), expectedRevision: 2 }),
    () => save("ALICE", page.id, { content: doc("sent first"), expectedRevision: 2 }),
  ]);
  status(late, 200);
  conflict(early, "REVISION_CONFLICT", 3);
  assert.deepEqual((await stored(page.id)).content, doc("sent second"));
});

test("a restore is a new revision that an in-flight older save cannot overwrite", async () => {
  const page = await newPage("v1");
  status(await acquire("ALICE", page.id), 200);
  const named = status(
    await req("ALICE", "POST", `/api/wiki/pages/${page.id}/versions`, {
      name: "Before edits",
    }),
    201,
  );
  status(await save("ALICE", page.id, { content: doc("v2"), expectedRevision: 0 }), 200);

  // Restored from one tab while another tab's save based on revision 1 is
  // still on its way.
  const restored = status(
    await req("ALICE", "POST", `/api/wiki/versions/${named.data.id}/restore`),
    200,
  );
  assert.equal(restored.data.revision, 2);
  assert.deepEqual(restored.data.content, doc("v1"));
  conflict(
    await save("ALICE", page.id, { content: doc("v2 more"), expectedRevision: 1 }),
    "REVISION_CONFLICT",
    2,
  );
  const after = await stored(page.id);
  assert.deepEqual(after.content, doc("v1"));
  assert.equal(after.revision, 2);
  // The replaced content was kept as a version even though an auto-save
  // version had just been recorded by the save.
  const versions = await app.prisma.wikiPageVersion.findMany({
    where: { pageId: page.id },
    orderBy: { versionNumber: "asc" },
  });
  assert.deepEqual(
    versions.map((v) => [v.versionNumber, v.content[0].content, v.isAutoSave]),
    [
      [1, "v1", false],
      [2, "v1", true],
      [3, "v2", true],
    ],
  );

  // Racing a restore with a save based on the replaced revision: whichever
  // the database orders first, the restore is stored and nothing is lost.
  for (const restoreFirst of [true, false]) {
    const current = (await stored(page.id)).revision;
    const restore = () =>
      req("ALICE", "POST", `/api/wiki/versions/${named.data.id}/restore`);
    const edit = () =>
      save("ALICE", page.id, { content: doc(`edit ${restoreFirst}`), expectedRevision: current });
    const [first, second] = await race(
      "WikiPage",
      page.id,
      restoreFirst ? [restore, edit] : [edit, restore],
    );
    const [restoreResponse, saveResponse] = restoreFirst
      ? [first, second]
      : [second, first];
    status(restoreResponse, 200);
    if (restoreFirst) conflict(saveResponse, "REVISION_CONFLICT", current + 1);
    else status(saveResponse, 200);
    const now = await stored(page.id);
    assert.deepEqual(now.content, doc("v1"));
    assert.equal(now.revision, current + (restoreFirst ? 1 : 2));
    if (!restoreFirst) {
      const kept = await app.prisma.wikiPageVersion.findFirst({
        where: { pageId: page.id },
        orderBy: { versionNumber: "desc" },
      });
      assert.deepEqual(kept.content, doc("edit false"));
    }
  }
});

test("another user's edit lock refuses saves and restores, with or without a revision", async () => {
  const page = await newPage();
  status(await acquire("ALICE", page.id), 200);
  const version = status(
    await req("ALICE", "POST", `/api/wiki/pages/${page.id}/versions`, { name: "v" }),
    201,
  );

  const locked = conflict(
    await save("BOB", page.id, { content: doc("bob"), expectedRevision: 0 }),
    "EDIT_LOCKED",
    0,
  );
  assert.equal(locked.current.lockedBy.id, users.ALICE.id);
  assert.equal(locked.current.lockedBy.displayName, "ALICE");
  assert.ok(Date.parse(locked.current.lockExpiresAt) > Date.now());
  // An API client that sends no revision is refused the same way.
  conflict(await save("BOB", page.id, { title: "API" }), "EDIT_LOCKED", 0);
  conflict(
    await req("BOB", "POST", `/api/wiki/versions/${version.data.id}/restore`),
    "EDIT_LOCKED",
    0,
  );
  const after = await stored(page.id);
  assert.equal(after.revision, 0);
  assert.equal(after.title, page.title);
  assert.deepEqual(after.content, doc("original"));

  // The holder may save, and once the lock is released anyone may.
  status(await save("ALICE", page.id, { content: doc("alice") }), 200);
  status(await req("ALICE", "DELETE", `/api/wiki/pages/${page.id}/lock`), 204);
  const bob = status(await save("BOB", page.id, { content: doc("bob") }), 200);
  assert.equal(bob.data.revision, 2);
});

test("after a lock takeover the previous holder's saves are refused", async () => {
  const page = await newPage();
  status(await acquire("ALICE", page.id), 200);
  const alice = status(
    await save("ALICE", page.id, { content: doc("alice 1"), expectedRevision: 0 }),
    200,
  );
  // Alice stops renewing; Bob takes the page over and reads revision 1.
  await expireLock(page.id);
  status(await acquire("BOB", page.id), 200);

  // Alice's next save is based on the current revision, but Bob holds the
  // lock now.
  const refused = conflict(
    await save("ALICE", page.id, {
      content: doc("alice 2"),
      expectedRevision: alice.data.revision,
    }),
    "EDIT_LOCKED",
    1,
  );
  assert.equal(refused.current.lockedBy.id, users.BOB.id);
  status(await save("BOB", page.id, { content: doc("bob 1"), expectedRevision: 1 }), 200);
  // A late renewal or release from Alice neither revives nor removes Bob's lock.
  status(await req("ALICE", "PATCH", `/api/wiki/pages/${page.id}/lock/heartbeat`), 404);
  status(await req("ALICE", "DELETE", `/api/wiki/pages/${page.id}/lock`), 204);
  const lock = await app.prisma.wikiPageLock.findUniqueOrThrow({
    where: { pageId: page.id },
  });
  assert.equal(lock.userId, users.BOB.id);
  // Retrying now fails on both counts and still writes nothing.
  conflict(
    await save("ALICE", page.id, { content: doc("alice 2"), expectedRevision: 1 }),
    "EDIT_LOCKED",
    2,
  );
  assert.deepEqual((await stored(page.id)).content, doc("bob 1"));

  // Takeover delivered while a save from the lapsed holder is waiting: the
  // database orders them, and the save is stored only if it came first.
  for (const takeoverFirst of [true, false]) {
    const contested = await newPage();
    status(await acquire("ALICE", contested.id), 200);
    await expireLock(contested.id);
    const takeover = () => acquire("BOB", contested.id);
    const late = () =>
      save("ALICE", contested.id, { content: doc("late alice"), expectedRevision: 0 });
    const [first, second] = await race(
      "WikiPage",
      contested.id,
      takeoverFirst ? [takeover, late] : [late, takeover],
    );
    const [takeoverResponse, saveResponse] = takeoverFirst
      ? [first, second]
      : [second, first];
    status(takeoverResponse, 200);
    const now = await stored(contested.id);
    if (takeoverFirst) {
      conflict(saveResponse, "EDIT_LOCKED", 0);
      assert.deepEqual(now.content, doc("original"));
    } else {
      status(saveResponse, 200);
      assert.deepEqual(now.content, doc("late alice"));
    }
    // Bob holds the lock either way and saves on the revision he reads.
    const read = status(await req("BOB", "GET", `/api/wiki/pages/${contested.id}`), 200);
    status(
      await save("BOB", contested.id, {
        content: doc("bob"),
        expectedRevision: read.data.revision,
      }),
      200,
    );
  }
});

test("a late renewal cannot revive a lapsed lock under a save that already checked it", async () => {
  const page = await newPage();
  status(await acquire("ALICE", page.id), 200);
  await expireLock(page.id);
  // Bob's save takes the page row and passes the lock check (Alice's lock has
  // lapsed), then waits on Bob's user row for its version insert. Alice's
  // renewal arrives in that window and waits for the page row.
  const [saved, renewal] = await race("User", users.BOB.id, [
    () => save("BOB", page.id, { content: doc("bob"), expectedRevision: 0 }),
    () => req("ALICE", "PATCH", `/api/wiki/pages/${page.id}/lock/heartbeat`),
  ]);
  status(renewal, 404);
  status(saved, 200);
  const lock = await app.prisma.wikiPageLock.findUnique({ where: { pageId: page.id } });
  assert.ok(!lock || lock.expiresAt <= new Date(), "the lapsed lock was renewed");
  // Start Editing takes the page again, and the stale draft is refused.
  status(await acquire("ALICE", page.id), 200);
  conflict(
    await save("ALICE", page.id, { content: doc("alice"), expectedRevision: 0 }),
    "REVISION_CONFLICT",
    1,
  );
  assert.deepEqual((await stored(page.id)).content, doc("bob"));
});

test("a renewal delayed past expiry does not revive the lock (database clock, review L1)", async () => {
  const page = await newPage();
  status(await acquire("ALICE", page.id), 200);
  await app.prisma.wikiPageLock.update({
    where: { pageId: page.id },
    data: { expiresAt: new Date(Date.now() + 1000) },
  });
  // The renewal is sent before expiry but waits for the page row (held here as
  // a save in progress, or a slow pool or event loop, would) until after it.
  const [renewal] = await race(
    "WikiPage",
    page.id,
    [() => req("ALICE", "PATCH", `/api/wiki/pages/${page.id}/lock/heartbeat`)],
    () => sleep(1500),
  );
  status(renewal, 404);
  const after = await app.prisma.wikiPageLock.findUnique({ where: { pageId: page.id } });
  assert.ok(!after || after.expiresAt <= new Date(), "the lapsed lock was renewed");
});

test("two users taking a free lock at once: exactly one holds it", async () => {
  const page = await newPage();
  const responses = await race("WikiPage", page.id, [
    () => acquire("ALICE", page.id),
    () => acquire("BOB", page.id),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 409],
    responses.map((r) => r.body).join("\n"),
  );
  const lock = await app.prisma.wikiPageLock.findUniqueOrThrow({
    where: { pageId: page.id },
  });
  assert.equal(lock.userId, users.ALICE.id);
});

test("version numbers stay unique when snapshots race", async () => {
  const page = await newPage();
  const responses = await race("WikiPage", page.id, [
    () => req("ALICE", "POST", `/api/wiki/pages/${page.id}/versions`, { name: "one" }),
    () => req("BOB", "POST", `/api/wiki/pages/${page.id}/versions`, { name: "two" }),
    // A save with no recent auto-save version records one too.
    () => save("ALICE", page.id, { content: doc("edited") }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [201, 201, 200],
    responses.map((r) => r.body).join("\n"),
  );
  const numbers = (
    await app.prisma.wikiPageVersion.findMany({
      where: { pageId: page.id },
      select: { versionNumber: true },
    })
  ).map((v) => v.versionNumber);
  assert.deepEqual(numbers.sort(), [1, 2, 3]);
});

test("the auto-save version is stored with the save that replaced its content", async () => {
  const page = await newPage("before");
  status(await save("ALICE", page.id, { content: doc("after") }), 200);
  // Recorded in the same transaction: present as soon as the save returns.
  const versions = await app.prisma.wikiPageVersion.findMany({
    where: { pageId: page.id },
  });
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].content, doc("before"));
  assert.equal(versions[0].isAutoSave, true);
});

test("saves without a revision keep last-writer-wins and still advance the revision", async () => {
  const page = await newPage();
  status(await save("ALICE", page.id, { content: doc("one") }), 200);
  const two = status(await save("BOB", page.id, { content: doc("two") }), 200);
  assert.equal(two.data.revision, 2);
  assert.deepEqual((await stored(page.id)).content, doc("two"));
  // Validation of the new field.
  status(await save("ALICE", page.id, { expectedRevision: -1 }), 400);
  status(await save("ALICE", page.id, { expectedRevision: "2" }), 400);
  status(await save("VIEWER", page.id, { content: doc("x"), expectedRevision: 2 }), 403);
});

// ─── Task descriptions ─────────────────────────────────────

test("a task description save is a compare-and-set on its description revision", async () => {
  const task = await newTask();
  const read = status(await req("ALICE", "GET", `/api/tasks/${task.id}`), 200);
  assert.equal(read.data.descriptionRevision, 0);

  const first = status(
    await saveTask("ALICE", task.id, {
      description: "<p>alice</p>",
      expectedDescriptionRevision: 0,
    }),
    200,
  );
  assert.equal(first.data.descriptionRevision, 1);
  const stale = conflict(
    await saveTask("BOB", task.id, {
      description: "<p>bob</p>",
      expectedDescriptionRevision: 0,
    }),
    "REVISION_CONFLICT",
    1,
  );
  assert.equal(typeof stale.current.updatedAt, "string");
  let after = await app.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.description, "<p>alice</p>");
  assert.equal(after.descriptionRevision, 1);
  // The refused request wrote nothing else either, not even its activity.
  const edits = await app.prisma.activityLog.count({
    where: { taskId: task.id, actorId: users.BOB.id },
  });
  assert.equal(edits, 0);

  // Other fields do not move the description revision, so they never make a
  // pending description edit conflict.
  status(
    await saveTask("BOB", task.id, { title: "Renamed", priority: "HIGH" }),
    200,
  );
  after = await app.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.descriptionRevision, 1);
  status(
    await saveTask("ALICE", task.id, {
      description: "<p>alice 2</p>",
      expectedDescriptionRevision: 1,
    }),
    200,
  );

  // Without a revision the description is replaced as before.
  const api = status(
    await saveTask("BOB", task.id, { description: "<p>api</p>" }),
    200,
  );
  assert.equal(api.data.descriptionRevision, 3);
  // A revision without a description is ignored.
  status(
    await saveTask("BOB", task.id, { title: "Again", expectedDescriptionRevision: 0 }),
    200,
  );
  status(
    await saveTask("BOB", task.id, {
      description: "<p>x</p>",
      expectedDescriptionRevision: 1.5,
    }),
    400,
  );
});

test("concurrent and reordered description saves: exactly one is stored", async () => {
  const task = await newTask();
  const responses = await race("Task", task.id, [
    () => saveTask("ALICE", task.id, { description: "<p>alice</p>", expectedDescriptionRevision: 0 }),
    () => saveTask("BOB", task.id, { description: "<p>bob</p>", expectedDescriptionRevision: 0 }),
    () => saveTask("ALICE", task.id, { description: "<p>tab</p>", expectedDescriptionRevision: 0 }),
  ]);
  // The requests first queue for the key-share lock of their activity insert,
  // which they then hold together, so which one reaches the revision check
  // first is up to the database; exactly one may win.
  const won = responses.filter((r) => r.statusCode === 200);
  assert.equal(won.length, 1, responses.map((r) => r.body).join("\n"));
  for (const response of responses.filter((r) => r !== won[0]))
    conflict(response, "REVISION_CONFLICT", 1);
  let after = await app.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.description, won[0].json().data.description);
  assert.equal(after.descriptionRevision, 1);

  // A retransmitted older save arriving after a newer one does not revert it.
  status(
    await saveTask("ALICE", task.id, { description: "<p>newer</p>", expectedDescriptionRevision: 1 }),
    200,
  );
  conflict(
    await saveTask("ALICE", task.id, { description: "<p>alice</p>", expectedDescriptionRevision: 0 }),
    "REVISION_CONFLICT",
    2,
  );
  after = await app.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.description, "<p>newer</p>");
});
