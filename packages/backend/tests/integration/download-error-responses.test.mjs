import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { png, webp } from "../fixtures/passive-media.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "download-errors-integration-secret",
  COOKIE_SECRET: "download-errors-cookie-secret",
});

let app, directory, workspace, address, source, healthy, attachment, shareLink;
const users = {},
  tokens = {};
const effects = { reads: 0, writes: 0, deletes: 0, events: 0 };
const api = (suffix) => `/api/workspaces/${workspace.id}${suffix}`;

async function assertCapturedJSONContract() {
  const { default: errors } = await import("../../src/plugins/errors.ts");
  let handler;
  await errors({
    setErrorHandler(value) {
      handler = value;
    },
  });
  const headers = new Map([
    ["content-type", "application/octet-stream"],
    ["content-disposition", 'attachment; filename="guard.txt"'],
  ]);
  const raw = new ServerResponse({
    method: "GET",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
  });
  raw.setHeader("Content-Disposition", 'attachment; filename="guard.txt"');
  const reply = {
    raw,
    type(value) {
      headers.set("content-type", value);
      return this;
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.payload = value;
      return this;
    },
  };
  handler(
    new Error("Captured fixture failure"),
    { log: { error() {} } },
    reply,
  );
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.has("content-disposition"), false);
  assert.equal(raw.getHeader("Content-Disposition"), undefined);
  assert.equal(reply.statusCode, 500);
  assert.equal(reply.payload.statusCode, 500);
}

async function request(method, url, body, actor = "OWNER") {
  const response = await fetch(address + url, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    json: () => JSON.parse(bytes.toString()),
  };
}
async function makeFile(thumbnail = false) {
  const storagePath = await app.storage.save(
    `${workspace.id}/files`,
    users.OWNER.id,
    crypto.randomUUID(),
    ".png",
    png,
  );
  const thumbnailPath = thumbnail
    ? await app.storage.save(
        `${workspace.id}/files`,
        users.OWNER.id,
        crypto.randomUUID(),
        ".webp",
        webp,
      )
    : null;
  return app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: "Owned fixture.png",
      mimeType: "image/png",
      size: png.length,
      storagePath,
      thumbnailPath,
      uploadedById: users.OWNER.id,
      ownerId: users.OWNER.id,
    },
  });
}
before(async () => {
  directory = await mkdtemp(
    path.join(os.tmpdir(), "werkyn-app-download-errors-"),
  );
  process.env.STORAGE_DIR = directory;
  // This real-handler/native-header capture MUST pass before app creation or
  // any missing-blob request. An older handler stops safely here without a
  // failing live stream or an interrupted fixture process.
  await assertCapturedJSONContract();
  const { buildApp } = await import("../../src/app.ts");
  const { signAccessToken } = await import("../../src/utils/tokens.ts");
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  for (const actor of ["OWNER", "DENIED"]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `error-${actor}-${suffix}@example.test`,
        displayName: actor,
        emailVerified: true,
      },
    });
    tokens[actor] = signAccessToken({
      sub: users[actor].id,
      email: users[actor].email,
    });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Download error audit",
      slug: `errors-${suffix}`,
      members: {
        create: Object.values(users).map((user) => ({
          userId: user.id,
          role: "MEMBER",
        })),
      },
    },
  });
  const project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Authorized discussion",
      members: { create: { userId: users.OWNER.id } },
      statuses: { create: { name: "Open" } },
    },
    include: { statuses: true },
  });
  const task = await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: project.statuses[0].id,
      title: "Unassigned participant",
    },
  });
  source = await makeFile(true);
  healthy = await makeFile();
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  const linked = await request("POST", api("/attachments/link"), {
    entityType: "task",
    entityId: task.id,
    fileId: source.id,
  });
  assert.equal(linked.status, 201, linked.bytes.toString());
  attachment = linked.json().data;
  const shared = await request("POST", api("/files/share-links"), {
    fileIds: [source.id],
  });
  assert.equal(shared.status, 201, shared.bytes.toString());
  shareLink = shared.json().data;
});
after(async () => {
  try {
    if (workspace) {
      await app.prisma.task.deleteMany({
        where: { project: { workspaceId: workspace.id } },
      });
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    }
    if (app)
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((user) => user.id) } },
      });
  } finally {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function state() {
  return {
    files: await app.prisma.file.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { id: "asc" },
    }),
    attachments: await app.prisma.attachment.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { id: "asc" },
    }),
    links: await app.prisma.fileShareLink.findMany({
      where: { workspaceId: workspace.id },
      include: { files: true },
    }),
    shares: await app.prisma.fileShare.findMany({
      where: { workspaceId: workspace.id },
    }),
    notifications: await app.prisma.notification.count({
      where: { userId: { in: Object.values(users).map((user) => user.id) } },
    }),
  };
}
const security = (response) =>
  Object.fromEntries(
    ["cache-control", "content-security-policy", "x-content-type-options"].map(
      (name) => [name, response.headers.get(name)],
    ),
  );

test("guarded authorized app downloads return JSON for early blob errors, keep denials before reads, and preserve valid bytes", async () => {
  const routes = [
    {
      url: api(`/files/${source.id}/download?inline=true`),
      actor: "OWNER",
      bytes: png,
      mime: "image/png",
    },
    {
      url: api(`/attachments/${attachment.id}/download`),
      actor: "OWNER",
      bytes: png,
      mime: "application/octet-stream",
    },
    {
      url: `/api/public/files/${shareLink.token}/${source.id}/download`,
      actor: null,
      bytes: png,
      mime: "application/octet-stream",
    },
    {
      url: api(`/files/${source.id}/thumbnail`),
      actor: "OWNER",
      bytes: webp,
      mime: "image/webp",
    },
  ];
  for (const route of routes) {
    const response = await request("GET", route.url, undefined, route.actor);
    assert.equal(response.status, 200, response.bytes.toString());
    assert.equal(response.headers.get("content-type"), route.mime);
    assert.deepEqual(response.bytes, route.bytes);
    route.security = security(response);
  }
  // Only owned fixture blobs are removed; valid File/link records deliberately
  // remain, modelling early ENOENT rather than SetNull/missing-resource404.
  await app.storage.delete(source.storagePath);
  await app.storage.delete(source.thumbnailPath);
  for (const [method, kind] of [
    ["read", "reads"],
    ["readStream", "reads"],
    ["save", "writes"],
    ["saveStream", "writes"],
    ["delete", "deletes"],
  ]) {
    const original = app.storage[method].bind(app.storage);
    app.storage[method] = (...args) => {
      effects[kind]++;
      return original(...args);
    };
  }
  app.broadcastToWorkspace = app.broadcastToUser = () => {
    effects.events++;
  };
  const initial = await state();
  for (const url of [routes[0].url, routes[1].url, routes[3].url]) {
    const response = await request("GET", url, undefined, "DENIED");
    assert([403, 404].includes(response.status), response.bytes.toString());
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.deepEqual(effects, { reads: 0, writes: 0, deletes: 0, events: 0 });
    assert.deepEqual(await state(), initial);
  }
  const absent = await request(
    "GET",
    api(`/files/${crypto.randomUUID()}/download`),
  );
  assert.equal(absent.status, 404);
  assert.equal(absent.headers.get("content-disposition"), null);
  assert.deepEqual(effects, { reads: 0, writes: 0, deletes: 0, events: 0 });
  for (const route of routes) {
    const response = await request("GET", route.url, undefined, route.actor);
    assert.equal(response.status, 500, response.bytes.toString());
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.json().statusCode, 500);
    assert.match(response.json().message, /ENOENT/);
    assert.equal(
      Number(response.headers.get("content-length")),
      response.bytes.length,
    );
    assert.deepEqual(security(response), route.security);
    const health = await request("GET", "/api/health");
    assert.equal(health.status, 200, health.bytes.toString());
    assert.equal(health.json().status, "ok");
    assert.deepEqual(await state(), initial);
  }
  assert.deepEqual(effects, { reads: 4, writes: 0, deletes: 0, events: 0 });
  const success = await request(
    "GET",
    api(`/files/${healthy.id}/download?inline=true`),
  );
  assert.equal(success.status, 200, success.bytes.toString());
  assert.equal(success.headers.get("content-type"), "image/png");
  assert.match(success.headers.get("content-disposition"), /^inline;/);
  assert.deepEqual(success.bytes, png);
  assert.deepEqual(effects, { reads: 5, writes: 0, deletes: 0, events: 0 });
  assert.deepEqual(await state(), initial);
});
