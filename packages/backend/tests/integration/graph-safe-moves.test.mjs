import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
// At most three application requests wait on PostgreSQL locks at once, each
// holding one pooled connection, so the actor pool needs at least five. The
// lock holder and pg_stat_activity observer use a separate two-connection
// pool so blocked actors can never starve the control that releases them.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit"))
  actorUrl.searchParams.set("connection_limit", "6");
assert(
  Number(actorUrl.searchParams.get("connection_limit")) >= 5,
  "Graph fixtures require connection_limit>=5",
);
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-graph-"));
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "graph-safe-moves-jwt-secret",
  COOKIE_SECRET: "graph-safe-moves-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const restore = await import("../../src/modules/backup/restore.service.ts");
// Absent before the fix; the budget test reports that instead of crashing.
const { graphLimits } = await import("../../src/utils/graph-limits.ts").catch(
  () => ({ graphLimits: null }),
);

const suffix = crypto.randomBytes(5).toString("hex");
const users = {};
const tokens = {};
let app, control, wsA, wsB;
let requests = 0;
let counter = 0;
let broadcasts = 0;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  for (const name of ["ADMIN", "MEMBER", "VIEWER", "OUTSIDER"]) {
    users[name] = await app.prisma.user.create({
      data: {
        email: `graph-${name}-${suffix}@example.test`,
        displayName: name,
        emailVerified: true,
      },
    });
    tokens[name] = signAccessToken({
      sub: users[name].id,
      email: users[name].email,
    });
  }
  wsA = await app.prisma.workspace.create({
    data: {
      name: "Graph A",
      slug: `graph-a-${suffix}`,
      members: {
        create: [
          { userId: users.ADMIN.id, role: "ADMIN" },
          { userId: users.MEMBER.id, role: "MEMBER" },
          { userId: users.VIEWER.id, role: "VIEWER" },
        ],
      },
    },
  });
  // MEMBER also administers B: membership in both never permits transfers.
  wsB = await app.prisma.workspace.create({
    data: {
      name: "Graph B",
      slug: `graph-b-${suffix}`,
      members: {
        create: [
          { userId: users.MEMBER.id, role: "ADMIN" },
          { userId: users.OUTSIDER.id, role: "ADMIN" },
        ],
      },
    },
  });
  app.broadcastToWorkspace = () => {
    broadcasts++;
  };
  app.broadcastToUser = () => {};
});

after(async () => {
  try {
    if (graphLimits) Object.assign(graphLimits, defaultLimits);
    if (app) {
      // Detach every fixture edge first so cascades never walk legacy cycles.
      const ids = [wsA?.id, wsB?.id].filter(Boolean);
      await app.prisma.wikiPage.updateMany({
        where: { space: { workspaceId: { in: ids } } },
        data: { parentId: null },
      });
      await app.prisma.file.updateMany({
        where: { workspaceId: { in: ids } },
        data: { parentId: null },
      });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
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

const defaultLimits = graphLimits ? { ...graphLimits } : null;

function req(actor, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.91.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function status(response, expected) {
  assert.equal(response.statusCode, expected, response.body);
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

// A control transaction takes real locks, starts every actor, observes them
// waiting in PostgreSQL and then commits; cleanup always releases the holder
// and awaits every actor before the caller inspects state.
async function whileLocked(lock, startActors, waiters) {
  let unlock, locked;
  const unlocked = new Promise((resolve) => (unlock = resolve));
  const ready = new Promise((resolve) => (locked = resolve));
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await lock(tx);
      locked();
      await unlocked;
    },
    { timeout: 10_000, maxWait: 2_000 },
  );
  let running = [];
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    running = startActors().map((pending) => Promise.resolve(pending));
    await waitForLockWaiters(waiters ?? running.length);
  } finally {
    unlock();
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

// Locking the rows an operation writes lets every competing request finish
// its validation reads before any of them commits, with or without an
// application-level lock, so both orders of a race are actually exercised.
function rowLocks(table, ids) {
  return async (tx) => {
    for (const id of [...ids].sort())
      await tx.$queryRawUnsafe(
        `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
        id,
      );
  };
}

// ─── Wiki fixtures ─────────────────────────────────────────

function space(workspace = wsA) {
  counter++;
  return app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: `Space ${counter}`,
      slug: `space-${suffix}-${counter}`,
      position: counter,
    },
  });
}

function page(spaceRow, parent = null, position = 0) {
  return app.prisma.wikiPage.create({
    data: {
      spaceId: spaceRow.id,
      parentId: parent?.id ?? null,
      title: `Page ${++counter}`,
      position,
      createdById: users.ADMIN.id,
    },
  });
}

function pages(spaceIds) {
  return app.prisma.wikiPage.findMany({
    where: { spaceId: { in: spaceIds } },
    orderBy: { id: "asc" },
    select: { id: true, spaceId: true, parentId: true, position: true },
  });
}

function movePage(actor, pageRow, body) {
  return req(actor, "PATCH", `/api/wiki/pages/${pageRow.id}/move`, body);
}

async function assertWikiForest(spaceIds) {
  const rows = await pages(spaceIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    let current = row;
    for (let steps = 0; current.parentId; steps++) {
      const parent = byId.get(current.parentId);
      assert(parent, `page ${current.id} has a parent outside these spaces`);
      assert.equal(parent.spaceId, current.spaceId, "parent in another space");
      assert(steps < rows.length, `page ${row.id} is on a cycle`);
      current = parent;
    }
  }
}

function siblingPositions(rows, spaceId, parentId) {
  return rows
    .filter((r) => r.spaceId === spaceId && r.parentId === parentId)
    .map((r) => r.position)
    .sort((a, b) => a - b);
}

// ─── Wiki tests ────────────────────────────────────────────

test("wiki moves resolve destinations inside the source workspace and space", async () => {
  const [s1, s2, foreign] = await Promise.all([space(), space(), space(wsB)]);
  const source = await page(s1);
  await page(s1, source);
  const sibling = await page(s1, null, 1);
  const foreignPage = await page(foreign);
  await page(foreign, null, 1);
  const spaces = [s1.id, s2.id, foreign.id];
  const before = await pages(spaces);
  const events = broadcasts;

  for (const [actor, body, code] of [
    ["MEMBER", { spaceId: foreign.id, parentId: null, position: 0 }, 404],
    [
      "MEMBER",
      { spaceId: foreign.id, parentId: foreignPage.id, position: 0 },
      404,
    ],
    ["MEMBER", { parentId: foreignPage.id, position: 0 }, 404],
    ["MEMBER", { spaceId: s2.id, parentId: sibling.id, position: 0 }, 404],
    ["MEMBER", { spaceId: "missing-space", parentId: null, position: 0 }, 404],
    ["MEMBER", { parentId: "missing-page", position: 0 }, 404],
    ["VIEWER", { parentId: null, position: 1 }, 403],
    ["OUTSIDER", { spaceId: foreign.id, parentId: null, position: 0 }, 403],
  ])
    status(await movePage(actor, source, body), code);

  assert.deepEqual(await pages(spaces), before);
  assert.equal(broadcasts, events, "denied moves must not broadcast");
});

test("wiki moves reject self, direct and deep descendant parents", async () => {
  const s = await space();
  const a = await page(s);
  const b = await page(s, a);
  const c = await page(s, b);
  const d = await page(s, c);
  const before = await pages([s.id]);
  for (const target of [a, b, d])
    status(
      await movePage("MEMBER", a, { parentId: target.id, position: 0 }),
      400,
    );
  status(await movePage("MEMBER", b, { parentId: c.id, position: 0 }), 400);
  assert.deepEqual(await pages([s.id]), before);
});

test("cross-space moves carry the whole subtree, keep identity and renumber both sibling groups", async () => {
  const [s1, s2] = await Promise.all([space(), space()]);
  const r0 = await page(s1, null, 0);
  const source = await page(s1, null, 1);
  const r2 = await page(s1, null, 2);
  const c1 = await page(s1, source, 0);
  const c2 = await page(s1, source, 1);
  const g1 = await page(s1, c1, 0);
  const t0 = await page(s2, null, 0);
  const t1 = await page(s2, null, 1);
  const comment = await app.prisma.wikiPageComment.create({
    data: {
      pageId: g1.id,
      authorId: users.ADMIN.id,
      body: "kept",
      highlightId: "h1",
    },
  });

  const moved = await movePage("MEMBER", source, {
    spaceId: s2.id,
    parentId: null,
    position: 1,
  });
  status(moved, 200);
  assert.equal(moved.json().data.spaceId, s2.id);

  let rows = await pages([s1.id, s2.id]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const p of [source, c1, c2, g1])
    assert.equal(byId.get(p.id).spaceId, s2.id);
  assert.equal(byId.get(source.id).parentId, null);
  assert.equal(byId.get(c1.id).parentId, source.id);
  assert.equal(byId.get(c2.id).parentId, source.id);
  assert.equal(byId.get(g1.id).parentId, c1.id);
  assert.deepEqual(
    [r0, r2].map((p) => byId.get(p.id).position),
    [0, 1],
    "the old sibling group is renumbered after removal",
  );
  assert.deepEqual(
    [t0, source, t1].map((p) => byId.get(p.id).position),
    [0, 1, 2],
  );
  assert.equal(
    (await app.prisma.wikiPageComment.findUnique({ where: { id: comment.id } }))
      .pageId,
    g1.id,
  );

  const tree = await req(
    "MEMBER",
    "GET",
    `/api/wiki/spaces/${s2.id}/pages/tree`,
  );
  status(tree, 200);
  assert.deepEqual(
    tree.json().data.map((p) => [p.id, p._count.children]),
    [
      [t0.id, 0],
      [source.id, 2],
      [t1.id, 0],
    ],
  );
  const crumbs = await req(
    "MEMBER",
    "GET",
    `/api/wiki/pages/${g1.id}/breadcrumbs`,
  );
  status(crumbs, 200);
  assert.deepEqual(
    crumbs.json().data.map((p) => p.id),
    [source.id, c1.id, g1.id],
  );

  // Omitting parentId keeps the current parent, which is not in s1.
  status(await movePage("MEMBER", c1, { spaceId: s1.id, position: 0 }), 404);

  // Same-group reorder removes the page once and clamps the position.
  status(await movePage("MEMBER", t0, { position: 99 }), 200);
  rows = await pages([s2.id]);
  assert.deepEqual(siblingPositions(rows, s2.id, null), [0, 1, 2]);
  assert.equal(rows.find((r) => r.id === t0.id).position, 2);

  // And back under another page in s1: every descendant returns too.
  status(
    await movePage("ADMIN", source, {
      spaceId: s1.id,
      parentId: r2.id,
      position: 7,
    }),
    200,
  );
  rows = await pages([s1.id, s2.id]);
  for (const p of [source, c1, c2, g1])
    assert.equal(rows.find((r) => r.id === p.id).spaceId, s1.id);
  assert.equal(rows.find((r) => r.id === source.id).parentId, r2.id);
  assert.deepEqual(siblingPositions(rows, s2.id, null), [0, 1]);
  await assertWikiForest([s1.id, s2.id]);
});

test("a queued wiki move re-reads the actor's role after the workspace lock", async () => {
  const s = await space();
  const p = await page(s);
  const target = await page(s, null, 1);
  const before = await pages([s.id]);
  const membership = {
    userId_workspaceId: { userId: users.MEMBER.id, workspaceId: wsA.id },
  };
  let response;
  try {
    [response] = await whileLocked(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${wsA.id} FOR UPDATE`;
        await tx.workspaceMember.update({
          where: membership,
          data: { role: "VIEWER" },
        });
      },
      () => [movePage("MEMBER", p, { parentId: target.id, position: 0 })],
    );
  } finally {
    await app.prisma.workspaceMember.update({
      where: membership,
      data: { role: "MEMBER" },
    });
  }
  status(response, 403);
  assert.deepEqual(await pages([s.id]), before);
});

test("concurrent opposite wiki moves cannot form a cycle", async () => {
  const s = await space();
  const x = await page(s, null, 0);
  const y = await page(s, null, 1);
  const responses = await whileLocked(
    rowLocks("WikiPage", [x.id, y.id]),
    () => [
      movePage("MEMBER", x, { parentId: y.id, position: 0 }),
      movePage("ADMIN", y, { parentId: x.id, position: 0 }),
    ],
  );
  assert.deepEqual(
    responses.map((r) => r.statusCode).sort(),
    [200, 400],
    responses.map((r) => r.body).join(" | "),
  );
  await assertWikiForest([s.id]);
});

test("a wiki move and the deletion of its destination serialize", async () => {
  const s = await space();
  const p = await page(s, null, 0);
  const q = await page(s, null, 1);
  const child = await page(s, p);
  const [moved, deleted] = await whileLocked(
    rowLocks("WikiPage", [p.id, q.id]),
    () => [
      movePage("MEMBER", p, { parentId: q.id, position: 0 }),
      req("ADMIN", "DELETE", `/api/wiki/pages/${q.id}`),
    ],
  );
  status(deleted, 204);
  assert([200, 404].includes(moved.statusCode), moved.body);
  const rows = await pages([s.id]);
  assert(!rows.some((r) => r.id === q.id));
  // Either the move lost and p stays a root with its child, or it won and the
  // delete removed the whole moved subtree with it.
  const left = rows.filter((r) => [p.id, child.id].includes(r.id));
  if (moved.statusCode === 200) assert.equal(left.length, 0);
  else {
    assert.equal(left.length, 2);
    assert.equal(rows.find((r) => r.id === p.id).parentId, null);
  }
  await assertWikiForest([s.id]);
});

test("concurrent page creates and moves keep one consistent sibling order", async () => {
  const s = await space();
  const parent = await page(s);
  const mover = await page(s, null, 1);
  const responses = await whileLocked(
    rowLocks("WikiPage", [parent.id, mover.id]),
    () => [
      movePage("MEMBER", mover, { parentId: parent.id, position: 0 }),
      req("MEMBER", "POST", `/api/wiki/spaces/${s.id}/pages`, {
        title: "Created",
        parentId: parent.id,
      }),
      req("ADMIN", "POST", `/api/wiki/spaces/${s.id}/pages`, {
        title: "Created too",
        parentId: parent.id,
      }),
    ],
  );
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 201, 201],
  );
  const rows = await pages([s.id]);
  assert.deepEqual(siblingPositions(rows, s.id, parent.id), [0, 1, 2]);
  await assertWikiForest([s.id]);
});

test("wiki readers and writers stop on legacy cycles and foreign-space edges", async () => {
  const [s1, s2] = await Promise.all([space(), space()]);
  const a = await page(s1);
  const b = await page(s1, a);
  await app.prisma.wikiPage.update({
    where: { id: a.id },
    data: { parentId: b.id },
  });
  const host = await page(s1, null, 1);
  const stray = await page(s2);
  await app.prisma.wikiPage.update({
    where: { id: stray.id },
    data: { parentId: host.id },
  });
  const mover = await page(s1, null, 2);
  const spaces = [s1.id, s2.id];
  const before = await pages(spaces);

  try {
    status(
      await req("MEMBER", "GET", `/api/wiki/pages/${a.id}/breadcrumbs`),
      409,
    );
    const crumbs = await req(
      "MEMBER",
      "GET",
      `/api/wiki/pages/${stray.id}/breadcrumbs`,
    );
    status(crumbs, 200);
    assert.deepEqual(
      crumbs.json().data.map((p) => p.id),
      [stray.id],
    );
    assert(
      !crumbs.body.includes(host.title),
      "foreign parent title must not leak",
    );
    const tree = await req(
      "MEMBER",
      "GET",
      `/api/wiki/spaces/${s1.id}/pages/tree?parentId=${host.id}`,
    );
    status(tree, 200);
    assert.deepEqual(tree.json().data, []);
    const roots = await req(
      "MEMBER",
      "GET",
      `/api/wiki/spaces/${s1.id}/pages/tree`,
    );
    assert.equal(
      roots.json().data.find((p) => p.id === host.id)._count.children,
      0,
    );
    status(
      await req(
        "MEMBER",
        "GET",
        `/api/wiki/spaces/${s2.id}/pages/tree?parentId=${host.id}`,
      ),
      404,
    );

    status(
      await movePage("MEMBER", mover, { parentId: a.id, position: 0 }),
      409,
    );
    status(
      await movePage("MEMBER", host, {
        spaceId: s2.id,
        parentId: null,
        position: 0,
      }),
      409,
    );
    status(await req("ADMIN", "DELETE", `/api/wiki/pages/${host.id}`), 409);
    status(await req("ADMIN", "DELETE", `/api/wiki/spaces/${s1.id}`), 409);
    assert.deepEqual(await pages(spaces), before);
  } finally {
    await app.prisma.wikiPage.updateMany({
      where: { id: { in: [a.id, stray.id] } },
      data: { parentId: null },
    });
  }
});

// ─── File fixtures ─────────────────────────────────────────

const filesUrl = (suffixPath = "") =>
  `/api/workspaces/${wsA.id}/files${suffixPath}`;

async function file(owner, data = {}) {
  const storagePath = data.isFolder
    ? null
    : await app.storage.save(
        `${wsA.id}/files`,
        users[owner].id,
        crypto.randomUUID(),
        ".txt",
        Buffer.from(`bytes-${owner}`),
      );
  return app.prisma.file.create({
    data: {
      workspaceId: wsA.id,
      name: `File ${++counter}`,
      mimeType: data.isFolder ? null : "text/plain",
      size: data.isFolder ? null : 10,
      storagePath,
      ownerId: users[owner].id,
      uploadedById: users[owner].id,
      ...data,
    },
  });
}

const folder = (owner, data = {}) => file(owner, { isFolder: true, ...data });

function upload(actor, parentId) {
  const boundary = `graph-boundary-${suffix}`;
  return app.inject({
    method: "POST",
    url: filesUrl("/upload"),
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\nuploaded bytes\r\n--${boundary}--\r\n`,
    ),
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${tokens[actor]}`,
    },
    remoteAddress: `10.92.0.${(++requests % 250) + 1}`,
  });
}

async function teamFolder(memberNames) {
  const root = await folder("ADMIN", { ownerId: null });
  return app.prisma.teamFolder.create({
    data: {
      workspaceId: wsA.id,
      folderId: root.id,
      name: root.name,
      members: { create: memberNames.map((n) => ({ userId: users[n].id })) },
    },
  });
}

async function assertFileForest(ids) {
  const rows = await app.prisma.file.findMany({
    where: { workspaceId: wsA.id },
    select: { id: true, parentId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    let current = byId.get(id);
    for (let steps = 0; current?.parentId; steps++) {
      assert(steps < rows.length, `file ${id} is on a cycle`);
      current = byId.get(current.parentId);
      assert(current, `file ${id} has a missing parent`);
    }
  }
}

const exists = (p) =>
  access(path.join(storageDir, p)).then(
    () => true,
    () => false,
  );

// ─── File tests ────────────────────────────────────────────

test("concurrent opposite folder moves cannot form a cycle", async () => {
  const f1 = await folder("MEMBER");
  const f2 = await folder("MEMBER");
  const responses = await whileLocked(rowLocks("File", [f1.id, f2.id]), () => [
    req("MEMBER", "PATCH", filesUrl(`/${f1.id}`), { parentId: f2.id }),
    req("ADMIN", "PATCH", filesUrl(`/${f2.id}`), { parentId: f1.id }),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode).sort(),
    [200, 403],
    responses.map((r) => r.body).join(" | "),
  );
  await assertFileForest([f1.id, f2.id]);
});

test("children created while a folder moves take its final scope", async () => {
  const team = await teamFolder(["MEMBER"]);
  const moving = await folder("MEMBER");
  const responses = await whileLocked(rowLocks("File", [moving.id]), () => [
    req("MEMBER", "PATCH", filesUrl(`/${moving.id}`), {
      parentId: team.folderId,
    }),
    req("MEMBER", "POST", filesUrl("/folder"), {
      name: "Concurrent",
      parentId: moving.id,
    }),
    upload("MEMBER", moving.id),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 201, 201],
    responses.map((r) => r.body).join(" | "),
  );
  const children = await app.prisma.file.findMany({
    where: { parentId: moving.id },
    select: { ownerId: true, teamFolderId: true },
  });
  assert.equal(children.length, 2);
  for (const child of children)
    assert.deepEqual(child, { ownerId: null, teamFolderId: team.id });
});

test("a folder move and the deletion of its destination serialize", async () => {
  const moving = await folder("MEMBER");
  const leaf = await file("MEMBER", { parentId: moving.id });
  const destination = await folder("MEMBER");
  const [moved, deleted] = await whileLocked(
    rowLocks("File", [moving.id, destination.id]),
    () => [
      req("MEMBER", "PATCH", filesUrl(`/${moving.id}`), {
        parentId: destination.id,
      }),
      req("MEMBER", "DELETE", filesUrl(`/${destination.id}`)),
    ],
  );
  assert([200, 404].includes(moved.statusCode), moved.body);
  status(deleted, 204);
  const left = await app.prisma.file.findMany({
    where: { id: { in: [moving.id, leaf.id, destination.id] } },
    select: { id: true, parentId: true },
  });
  assert(!left.some((r) => r.id === destination.id));
  if (moved.statusCode === 200) {
    assert.equal(left.length, 0);
    assert.equal(
      await exists(leaf.storagePath),
      false,
      "moved blob was deleted",
    );
  } else {
    assert.equal(left.length, 2);
    assert.equal(left.find((r) => r.id === moving.id).parentId, null);
  }
});

test("legacy malformed file graphs are rejected before any write", async () => {
  const document = await file("MEMBER");
  const hidden = await file("MEMBER", { parentId: document.id });
  const c1 = await folder("MEMBER");
  const c2 = await folder("MEMBER", { parentId: c1.id });
  await app.prisma.file.update({
    where: { id: c1.id },
    data: { parentId: c2.id },
  });
  const target = await folder("MEMBER");
  const loose = await folder("MEMBER");
  const trashed = await folder("MEMBER", { trashedAt: new Date() });
  const snapshot = () =>
    app.prisma.file.findMany({
      where: { workspaceId: wsA.id },
      orderBy: { id: "asc" },
      select: { id: true, parentId: true, ownerId: true, teamFolderId: true },
    });
  const before = await snapshot();
  try {
    status(await req("MEMBER", "DELETE", filesUrl(`/${document.id}`)), 403);
    status(
      await req("MEMBER", "PATCH", filesUrl(`/${document.id}`), {
        parentId: target.id,
      }),
      403,
    );
    status(
      await req("MEMBER", "PATCH", filesUrl(`/${loose.id}`), {
        parentId: c1.id,
      }),
      403,
    );
    status(
      await req("MEMBER", "PATCH", filesUrl(`/${loose.id}`), {
        parentId: document.id,
      }),
      400,
    );
    status(
      await req("MEMBER", "PATCH", filesUrl(`/${loose.id}`), {
        parentId: trashed.id,
      }),
      404,
    );
    status(
      await req("MEMBER", "PATCH", filesUrl(`/${c1.id}`), {
        parentId: target.id,
      }),
      403,
    );
    const crumbs = await req(
      "MEMBER",
      "GET",
      filesUrl(`/${c1.id}/breadcrumbs`),
    );
    status(crumbs, 200);
    assert.deepEqual(
      crumbs.json().data.map((f) => f.id),
      [c2.id, c1.id],
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(await exists(hidden.storagePath), true);
  } finally {
    await app.prisma.file.updateMany({
      where: { id: { in: [c1.id, hidden.id] } },
      data: { parentId: null },
    });
  }
});

test("injected depth and size budgets bound graph readers and writers", async () => {
  assert(graphLimits, "graph traversal budgets are not configurable");
  const [s1, s2] = await Promise.all([space(), space()]);
  let wikiTail = await page(s1);
  const wikiRoot = wikiTail;
  for (let i = 0; i < 5; i++) wikiTail = await page(s1, wikiTail);
  const wide = await page(s1, null, 1);
  for (let i = 0; i < 3; i++) await page(s1, wide, i);
  let fileTail = await folder("MEMBER");
  const fileRoot = fileTail;
  for (let i = 0; i < 5; i++)
    fileTail = await folder("MEMBER", { parentId: fileTail.id });
  const deepFile = await file("MEMBER", { parentId: fileTail.id });
  const wikiBefore = await pages([s1.id, s2.id]);
  let reads = 0;
  const readStream = app.storage.readStream;
  app.storage.readStream = (...args) => {
    reads++;
    return readStream.apply(app.storage, args);
  };
  try {
    Object.assign(graphLimits, { maxDepth: 4, maxNodes: 2 });
    status(
      await req("MEMBER", "GET", `/api/wiki/pages/${wikiTail.id}/breadcrumbs`),
      409,
    );
    status(
      await movePage("MEMBER", wikiRoot, {
        spaceId: s2.id,
        parentId: null,
        position: 0,
      }),
      409,
    );
    status(
      await movePage("MEMBER", wide, {
        spaceId: s2.id,
        parentId: null,
        position: 0,
      }),
      409,
    );
    status(
      await movePage("MEMBER", wide, { parentId: wikiTail.id, position: 0 }),
      409,
    );
    assert.deepEqual(await pages([s1.id, s2.id]), wikiBefore);

    const crumbs = await req(
      "MEMBER",
      "GET",
      filesUrl(`/${deepFile.id}/breadcrumbs`),
    );
    status(crumbs, 200);
    assert(crumbs.json().data.length <= 4);
    status(
      await req("MEMBER", "POST", filesUrl("/archive"), {
        fileIds: [fileRoot.id],
      }),
      409,
    );
    assert.equal(reads, 0, "no stored bytes are read when the budget fails");
    status(await req("MEMBER", "DELETE", filesUrl(`/${fileRoot.id}`)), 409);
    assert(await app.prisma.file.findUnique({ where: { id: deepFile.id } }));
    assert.equal(await exists(deepFile.storagePath), true);

    Object.assign(graphLimits, defaultLimits);
    status(
      await req("MEMBER", "GET", `/api/wiki/pages/${wikiTail.id}/breadcrumbs`),
      200,
    );
    status(
      await movePage("MEMBER", wide, {
        spaceId: s2.id,
        parentId: null,
        position: 0,
      }),
      200,
    );
  } finally {
    Object.assign(graphLimits, defaultLimits);
    app.storage.readStream = readStream;
  }
});

// ─── Restore ───────────────────────────────────────────────

function backup(spaces) {
  return Buffer.from(
    JSON.stringify({
      metadata: {
        version: "1.1",
        exportedAt: new Date().toISOString(),
        sourceWorkspace: { name: "Source", slug: "source" },
        userRefs: [],
      },
      wikiSpaces: spaces.map((pagesInSpace, i) => ({
        space: { name: `Restored ${suffix} ${i}` },
        pages: pagesInSpace.map(([id, parentRef], position) => ({
          _originalId: id,
          title: `Restored ${id}`,
          position,
          parentRef,
        })),
      })),
    }),
  );
}

test("restore rejects invalid wiki hierarchies before any side effect", async () => {
  const count = () =>
    app.prisma.wikiSpace.count({ where: { workspaceId: wsA.id } });
  const before = await count();
  for (const invalid of [
    [[["a", "a"]]],
    [
      [
        ["a", "b"],
        ["b", "a"],
        ["c", null],
      ],
    ],
    [
      [
        ["a", null],
        ["b", "c"],
      ],
      [["c", null]],
    ],
    [
      [
        ["a", null],
        ["a", null],
      ],
    ],
  ]) {
    const buffer = backup(invalid);
    for (const run of [restore.previewRestore, restore.executeRestore])
      await assert.rejects(
        run(app.prisma, wsA.id, users.ADMIN.id, buffer),
        (error) => error.statusCode === 400,
      );
  }
  assert.equal(await count(), before);

  const summary = await restore.executeRestore(
    app.prisma,
    wsA.id,
    users.ADMIN.id,
    backup([
      [
        ["a", null],
        ["b", "a"],
        ["c", "b"],
        ["d", "gone"],
      ],
      [
        ["a", null],
        ["b", "a"],
      ],
    ]),
  );
  assert.equal(summary.wikiPages, 6);
  assert.equal(summary.warnings.filter((w) => w.includes("gone")).length, 1);
  const restored = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: wsA.id, name: { startsWith: `Restored ${suffix}` } },
    select: { id: true },
  });
  assert.equal(restored.length, 2);
  await assertWikiForest(restored.map((s) => s.id));
});
