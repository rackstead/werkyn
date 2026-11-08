import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "json-surrogate-body-jwt-secret",
  COOKIE_SECRET: "json-surrogate-body-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-json-surrogate-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const STORED = "The request contains a character that cannot be stored";
const PAIR = "\uD83D\uDE00";
const LEAK = /prisma|Prisma|SELECT |INSERT |UPDATE |hex escape|\bat\s+\S+\s+\(/;

let app;
let user;
let workspace;
let token;
let requests = 0;

function call(method, url, payload, { authorize = true } = {}) {
  const requestHeaders = authorize ? { authorization: `Bearer ${token}` } : {};
  if (payload !== undefined) requestHeaders["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    payload,
    headers: requestHeaders,
    remoteAddress: `10.92.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 8);
  user = await app.prisma.user.create({
    data: { email: `json-surrogate-${suffix}@example.test`, displayName: "Surrogate", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Surrogate",
      slug: `json-surrogate-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  if (workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
  if (user) await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("a lone surrogate in an ordinary JSON field is 400 and is not stored", async () => {
  const before = await app.prisma.project.count({ where: { workspaceId: workspace.id } });
  const response = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    '{"name":"\\uD800"}',
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().message, STORED);
  assert.equal(response.json().stack, undefined);
  assert.doesNotMatch(response.body, LEAK);
  const description = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    '{"name":"ok","description":"tail\\uDFFF"}',
  );
  assert.equal(description.statusCode, 400, description.body);
  assert.equal(description.json().message, STORED);
  assert.doesNotMatch(description.body, LEAK);
  const anonymous = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    '{"name":"\\uDC00"}',
    { authorize: false },
  );
  assert.equal(anonymous.statusCode, 400, anonymous.body);
  assert.equal(anonymous.json().message, STORED);
  const afterCount = await app.prisma.project.count({ where: { workspaceId: workspace.id } });
  assert.equal(afterCount, before);
});

test("a well-formed surrogate pair is stored and returned", async () => {
  const created = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    '{"name":"Smile \\uD83D\\uDE00"}',
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.name, `Smile ${PAIR}`);
  const read = await call("GET", `/api/projects/${created.json().data.id}`);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().data.name, `Smile ${PAIR}`);
});

test("NUL in a JSON field is not refused by the surrogate check", async () => {
  const response = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    '{"name":"nul-color","color":"\\u0000"}',
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().message, "The request contains a value that cannot be stored");
  assert.doesNotMatch(response.body, LEAK);
});

test("ordinary invalid JSON stays 400", async () => {
  const response = await call(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    "{",
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(
    response.json().message,
    "Body is not valid JSON but content-type is set to 'application/json'",
  );
});

test("a my-tasks cursor with a lone surrogate is still 400", async () => {
  const cursor = Buffer.from(JSON.stringify(["\uD800", "project", 0, "task"])).toString("base64url");
  const response = await call(
    "GET",
    `/api/workspaces/${workspace.id}/my-tasks?cursor=${cursor}`,
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().details?.[0]?.message ?? "", /Invalid cursor/);
  assert.doesNotMatch(response.body, LEAK);
});
