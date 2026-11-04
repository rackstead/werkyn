import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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

const ownRequire = createRequire(
  new URL("../../package.json", import.meta.url),
);
const { PrismaClient } = await import(
  pathToFileURL(ownRequire.resolve("@prisma/client")).href
);
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const users = {};
const tokens = {};
let app, control, workspace, space, project, column;
const events = [];
let requests = 0;
let counter = 0;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  // Observe the serialized broadcast envelope, matching the HTTP JSON representation.
  app.broadcastToWorkspace = (...args) =>
    events.push(JSON.parse(JSON.stringify(args)));
  app.broadcastToUser = () => {};
  app.broadcast = (...args) => events.push(JSON.parse(JSON.stringify(args)));
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

const wiki = await import("../../src/modules/wiki/wiki-pages.service.ts");
const tasks = await import("../../src/modules/tasks/tasks.service.ts");
async function page() {
  return app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Before",
      content: [{ type: "paragraph", content: "stored" }],
      createdById: users.ALICE.id,
    },
  });
}
async function task() {
  return app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: column.id,
      title: "Before",
      description: "stored",
      position: ++counter,
      assignees: { create: { userId: users.ALICE.id } },
    },
  });
}
async function wikiState(id) {
  return {
    row: await app.prisma.wikiPage.findUniqueOrThrow({ where: { id } }),
    versions: await app.prisma.wikiPageVersion.findMany({
      where: { pageId: id },
      orderBy: { id: "asc" },
    }),
    events: structuredClone(events),
  };
}
async function taskState(id) {
  return {
    row: await app.prisma.task.findUniqueOrThrow({ where: { id } }),
    activity: await app.prisma.activityLog.findMany({
      where: { taskId: id },
      orderBy: { id: "asc" },
    }),
    outbox: await app.prisma.notificationDelivery.findMany({
      orderBy: { id: "asc" },
    }),
    events: structuredClone(events),
  };
}
for (const [name, patch] of [
  ["title", { title: "Changed" }],
  ["content", { content: [{ type: "paragraph", content: "replacement" }] }],
  ["icon", { icon: "book" }],
]) {
  test("wiki rejects omitted revision for " + name, async () => {
    const p = await page(),
      before = await wikiState(p.id);
    const r = await req("ALICE", "PATCH", `/api/wiki/pages/${p.id}`, patch);
    const after = await wikiState(p.id);
    assert.equal(r.statusCode, 400, r.body);
    assert.deepEqual(after, before);
  });
}
for (const [name, value] of [
  ["text", "replacement"],
  ["null", null],
  ["empty", ""],
]) {
  test("task rejects omitted description revision for " + name, async () => {
    const t = await task(),
      before = await taskState(t.id);
    const r = await req("ALICE", "PATCH", `/api/tasks/${t.id}`, {
      description: value,
    });
    const after = await taskState(t.id);
    assert.equal(r.statusCode, 400, r.body);
    assert.deepEqual(after, before);
  });
}
test("direct wiki service refuses omitted revision before effects", async () => {
  const p = await page(),
    before = await wikiState(p.id);
  let error;
  try {
    await wiki.updatePage(app.prisma, p.id, users.ALICE.id, {
      title: "direct",
    });
  } catch (e) {
    error = e;
  }
  const after = await wikiState(p.id);
  assert.equal(error?.statusCode, 400, String(error));
  assert.deepEqual(after, before);
});
test("direct task service refuses omitted description revision before effects", async () => {
  const t = await task(),
    before = await taskState(t.id);
  let error;
  try {
    await tasks.updateTask(app.prisma, t.id, users.ALICE.id, "MEMBER", {
      description: null,
    });
  } catch (e) {
    error = e;
  }
  const after = await taskState(t.id);
  assert.equal(error?.statusCode, 400, String(error));
  assert.deepEqual(after, before);
});
test("wiki invalid revision is 400 and leaves versions/content untouched", async () => {
  const p = await page(),
    before = await wikiState(p.id);
  status(
    await req("ALICE", "PATCH", `/api/wiki/pages/${p.id}`, {
      title: "invalid",
      expectedRevision: 2147483648,
    }),
    400,
  );
  assert.deepEqual(await wikiState(p.id), before);
});
test("task invalid description revision is 400 without effects", async () => {
  const t = await task(),
    before = await taskState(t.id);
  status(
    await req("ALICE", "PATCH", `/api/tasks/${t.id}`, {
      description: "invalid",
      expectedDescriptionRevision: -1,
    }),
    400,
  );
  assert.deepEqual(await taskState(t.id), before);
});
test("wiki current revision saves and advances once", async () => {
  const p = await page();
  const r = status(
    await req("ALICE", "PATCH", `/api/wiki/pages/${p.id}`, {
      title: "ACK",
      expectedRevision: p.revision,
    }),
    200,
  );
  assert.equal(r.data.revision, p.revision + 1);
  assert.equal(r.data.title, "ACK");
});
test("task current revision allows null clear and advances once", async () => {
  const t = await task();
  const r = status(
    await req("ALICE", "PATCH", `/api/tasks/${t.id}`, {
      description: null,
      expectedDescriptionRevision: t.descriptionRevision,
    }),
    200,
  );
  assert.equal(r.data.descriptionRevision, t.descriptionRevision + 1);
  assert.equal(r.data.description, null);
});
test("wiki stale revision 409 has no page/version/broadcast effects", async () => {
  const p = await page(),
    before = await wikiState(p.id);
  const r = status(
    await req("ALICE", "PATCH", `/api/wiki/pages/${p.id}`, {
      title: "stale",
      expectedRevision: p.revision + 1,
    }),
    409,
  );
  assert.equal(r.code, "REVISION_CONFLICT");
  assert.deepEqual(await wikiState(p.id), before);
});
test("task stale mixed metadata description is atomic with no side effects", async () => {
  const t = await task(),
    before = await taskState(t.id);
  const r = status(
    await req("ALICE", "PATCH", `/api/tasks/${t.id}`, {
      title: "stale title",
      description: "stale",
      priority: "HIGH",
      expectedDescriptionRevision: t.descriptionRevision + 1,
    }),
    409,
  );
  assert.equal(r.code, "REVISION_CONFLICT");
  assert.deepEqual(await taskState(t.id), before);
});
test("metadata-only task update needs no description revision", async () => {
  const t = await task();
  const r = status(
    await req("ALICE", "PATCH", `/api/tasks/${t.id}`, {
      title: "Metadata only",
      priority: "HIGH",
    }),
    200,
  );
  assert.equal(r.data.title, "Metadata only");
  assert.equal(r.data.description, "stored");
  assert.equal(r.data.descriptionRevision, t.descriptionRevision);
});
test("two same-base wiki edits commit exactly once", async () => {
  const p = await page();
  const rs = await Promise.all(
    ["one", "two"].map((title) =>
      req("ALICE", "PATCH", `/api/wiki/pages/${p.id}`, {
        title,
        expectedRevision: p.revision,
      }),
    ),
  );
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  const stored = await app.prisma.wikiPage.findUniqueOrThrow({
    where: { id: p.id },
  });
  assert.equal(stored.revision, p.revision + 1);
  assert.equal(
    (await app.prisma.wikiPageVersion.findMany({ where: { pageId: p.id } }))
      .length,
    1,
  );
});

test("page creation remains revision-free control", async () => {
  const p = await wiki.createPage(
    app.prisma,
    workspace.id,
    space.id,
    users.ALICE.id,
    { title: "Fresh ordinary page" },
  );
  assert.equal(p.revision, 0);
  assert.equal(p.title, "Fresh ordinary page");
});
