import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "calendar-colors-integration-secret";
process.env.COOKIE_SECRET = "calendar-colors-cookie-secret";
const storage = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-calendar-colors-"),
);
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, user, workspace, project, token;
const events = [];
let requests = 0;

function request(method, suffix, payload) {
  return app.inject({
    method,
    url: `/api/projects/${project.id}/${suffix}`,
    payload,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.44.0.${++requests}`,
  });
}
async function snapshot() {
  return {
    statuses: await app.prisma.statusColumn.findMany({
      where: { projectId: project.id },
      orderBy: { id: "asc" },
    }),
    labels: await app.prisma.label.findMany({
      where: { projectId: project.id },
      orderBy: { id: "asc" },
    }),
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID();
  user = await app.prisma.user.create({
    data: {
      email: `calendar-${suffix}@example.test`,
      displayName: "Color fixture",
      emailVerified: true,
    },
  });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Color fixture",
      slug: `color-${suffix}`,
      members: { create: { userId: user.id, role: "MEMBER" } },
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Color fixture",
      members: { create: { userId: user.id } },
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
});
after(async () => {
  try {
    if (workspace)
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (user) await app.prisma.user.delete({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test("MEMBER can create/update supported hex colors and omit colors in partial updates", async () => {
  for (const [i, color] of [
    "#abc",
    "#abcd",
    "#abcdef",
    "#ABCDEF",
    "#abcdef12",
  ].entries()) {
    for (const type of ["statuses", "labels"]) {
      const created = await request("POST", type, {
        name: `Color ${type} ${i}`,
        color,
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().data.color, color);
      const id = created.json().data.id;
      const changed = await request("PATCH", `${type}/${id}`, {
        color: "#22c55e",
      });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal(changed.json().data.color, "#22c55e");
      const renamed = await request("PATCH", `${type}/${id}`, {
        name: `Renamed ${type} ${i}`,
      });
      assert.equal(renamed.statusCode, 200, renamed.body);
      assert.equal(renamed.json().data.color, "#22c55e");
      const empty = await request("PATCH", `${type}/${id}`, {});
      assert.equal(empty.statusCode, 200, empty.body);
      assert.equal(empty.json().data.color, "#22c55e");
    }
  }
  const defaults = await request("POST", "statuses", {
    name: "Default status",
  });
  assert.equal(defaults.statusCode, 201, defaults.body);
  assert.equal(defaults.json().data.color, "#94a3b8");
  assert.equal(defaults.json().data.isCompletion, false);
  assert.equal(
    (await request("POST", "labels", { name: "Color required" })).statusCode,
    400,
  );
});

test("invalid create/update colors reject without row changes or status broadcasts", async () => {
  const initial = await snapshot();
  events.length = 0;
  for (const color of [
    "red",
    "red; border: 4px solid blue",
    "rgb(12, 34, 56)",
    "#12345",
    "",
    null,
  ]) {
    for (const [type, id] of [
      ["statuses", initial.statuses[0].id],
      ["labels", initial.labels[0].id],
    ]) {
      for (const [method, suffix] of [
        ["POST", type],
        ["PATCH", `${type}/${id}`],
      ]) {
        const result = await request(method, suffix, {
          name: "Rejected color",
          color,
        });
        assert.equal(result.statusCode, 400, result.body);
      }
    }
  }
  assert.deepEqual(await snapshot(), initial);
  assert.deepEqual(events, []);
});

test("legacy nonhex stored colors remain readable and permit name-only updates", async () => {
  const status = await app.prisma.statusColumn.create({
    data: {
      projectId: project.id,
      name: "Legacy status",
      color: "red; border: 4px solid blue",
    },
  });
  const label = await app.prisma.label.create({
    data: {
      projectId: project.id,
      name: "Legacy label",
      color: "rgb(12, 34, 56)",
    },
  });
  for (const [type, row] of [
    ["statuses", status],
    ["labels", label],
  ]) {
    const result = await request("PATCH", `${type}/${row.id}`, {
      name: `${row.name} renamed`,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().data.color, row.color);
    const list = await request("GET", type);
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(
      list.json().data.find((item) => item.id === row.id).color,
      row.color,
    );
  }
});
