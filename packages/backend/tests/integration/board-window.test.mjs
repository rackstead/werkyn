import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "board-window-integration-secret-value";
process.env.COOKIE_SECRET = "board-window-cookie-secret-value";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-board-window-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");

const BIG = 2000;
let app;
let token;
let userId;
let workspace;
let project;
let open;
let done;
let firstId;

function request(method, url, body) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  const user = await app.prisma.user.create({
    data: { email: `board-window-${suffix}@example.test`, displayName: "Board", emailVerified: true },
  });
  userId = user.id;
  const session = await startRefreshSession(app.prisma, user.id);
  const signedIn = await app.inject({
    method: "POST",
    url: "/api/auth/refresh",
    cookies: { refresh_token: session.refreshToken },
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  token = signedIn.json().data.accessToken;
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Board window",
      slug: `board-win-${suffix}`.slice(0, 50),
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Window" } });
  open = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  done = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Done", position: 1 } });
  const origin = Date.UTC(2026, 0, 1);
  const rows = [];
  for (let index = 0; index < BIG; index++) {
    rows.push({
      projectId: project.id,
      statusId: open.id,
      title: index < 80 ? `keep ${String(index).padStart(4, "0")}` : `other ${String(index).padStart(4, "0")}`,
      position: index,
      createdAt: new Date(origin + index * 1000),
    });
  }
  for (let index = 0; index < 3; index++) {
    rows.push({
      projectId: project.id,
      statusId: done.id,
      title: `done ${index}`,
      position: index,
      createdAt: new Date(origin + index * 1000),
    });
  }
  rows.push({
    projectId: project.id,
    statusId: open.id,
    title: "archived task",
    position: 0,
    archived: true,
    createdAt: new Date(origin),
  });
  await app.prisma.task.createMany({ data: rows });
  firstId = (await app.prisma.task.findFirst({
    where: { statusId: open.id, archived: false, position: 0 },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  })).id;
});

after(async () => {
  try {
    // Files in this suite run one at a time. The user has to be gone before
    // the file exits: a later bootstrap file requires an empty user table.
    if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (userId) await app.prisma.user.delete({ where: { id: userId } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("the first board window is not the whole project", async () => {
  const full = await request("GET", `/api/projects/${project.id}/tasks?view=board`);
  assert.equal(full.statusCode, 200, full.body);
  const windowed = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=40`);
  assert.equal(windowed.statusCode, 200, windowed.body);
  const fullJson = full.json();
  const windowJson = windowed.json();
  assert.equal(fullJson.data.length, BIG + 3);
  assert.equal(windowJson.data.length, 43);
  assert.ok(windowed.body.length < full.body.length / 10, `${windowed.body.length} vs ${full.body.length}`);
  const openColumn = windowJson.columns.find((column) => column.statusId === open.id);
  const doneColumn = windowJson.columns.find((column) => column.statusId === done.id);
  assert.equal(openColumn.total, BIG);
  assert.equal(openColumn.size, BIG);
  assert.equal(doneColumn.total, 3);
  assert.equal(windowJson.aligned, true);
  assert.equal(windowJson.data.filter((task) => task.statusId === open.id).length, 40);
  assert.deepEqual(
    windowJson.data.filter((task) => task.statusId === open.id).map((task) => task.columnIndex),
    Array.from({ length: 40 }, (_, index) => index),
  );
  console.log(JSON.stringify({
    beforeRows: fullJson.data.length,
    beforeBytes: full.body.length,
    afterRows: windowJson.data.length,
    afterBytes: windowed.body.length,
    openTotal: openColumn.total,
  }));
});

test("a later page continues in board order and a filtered page stays bounded", async () => {
  const page = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=40&status=${open.id}&columnOffset=40`);
  assert.equal(page.statusCode, 200, page.body);
  const json = page.json();
  assert.equal(json.data.length, 40);
  assert.equal(json.columns[0].total, BIG);
  assert.equal(json.columns[0].offset, 40);
  assert.deepEqual(json.data.map((task) => task.columnIndex), Array.from({ length: 40 }, (_, index) => 40 + index));
  assert.equal(json.data[0].title, "keep 0040");

  const filtered = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=40&search=${encodeURIComponent("keep")}`);
  assert.equal(filtered.statusCode, 200, filtered.body);
  const found = filtered.json();
  assert.equal(found.data.length, 40);
  assert.equal(found.columns.find((column) => column.statusId === open.id).total, 80);
  assert.equal(found.aligned, false);
  assert.ok(found.data.every((task) => task.title.startsWith("keep")));
  // The filtered window is not the whole column: the 50th match is not here,
  // and its column index is its place among every active task.
  assert.equal(found.data.at(-1).columnIndex, 39);
});

test("an id page lists ids without task bodies", async () => {
  const page = await request(
    "GET",
    `/api/projects/${project.id}/tasks?view=board&perColumn=500&columnIds=true&status=${open.id}&columnOffset=500`,
  );
  assert.equal(page.statusCode, 200, page.body);
  const json = page.json();
  assert.equal(json.data.length, 0);
  assert.equal(json.columns[0].ids.length, 500);
  assert.equal(json.columns[0].offset, 500);
  const stored = await app.prisma.task.findMany({
    where: { statusId: open.id, archived: false },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    skip: 500,
    take: 500,
    select: { id: true },
  });
  assert.deepEqual(json.columns[0].ids, stored.map((task) => task.id));
});

test("columnOffset without a column and an oversized task page are refused", async () => {
  const offset = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=40&columnOffset=40`);
  assert.equal(offset.statusCode, 400, offset.body);
  const huge = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=101`);
  assert.equal(huge.statusCode, 400, huge.body);
  const unbounded = await request("GET", `/api/projects/${project.id}/tasks?view=board&perColumn=501&columnIds=true`);
  assert.equal(unbounded.statusCode, 400, unbounded.body);
});

test("the move API still indexes the whole column", async () => {
  const moved = await request("PATCH", `/api/tasks/${firstId}/move`, { statusId: open.id, position: 1500 });
  assert.equal(moved.statusCode, 200, moved.body);
  const page = await request(
    "GET",
    `/api/projects/${project.id}/tasks?view=board&perColumn=1&status=${open.id}&columnOffset=1500`,
  );
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().data[0].id, firstId);
  assert.equal(page.json().data[0].columnIndex, 1500);
  // A window-local index (the first page is 40 cards) would have left it near the top.
  const top = await request(
    "GET",
    `/api/projects/${project.id}/tasks?view=board&perColumn=1&status=${open.id}&columnOffset=0`,
  );
  assert.notEqual(top.json().data[0].id, firstId);
});
