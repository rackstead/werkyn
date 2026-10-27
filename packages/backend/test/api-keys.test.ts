import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { User, Workspace, Project } from "@prisma/client";

// Only run against a database explicitly designated for integration tests.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "werkyn-integration-tests-jwt-secret";
process.env.COOKIE_SECRET = "werkyn-integration-tests-cookie-secret";
process.env.STORAGE_DIR = "/tmp/werkyn-api-key-integration-storage";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("../src/app.js");
const { signAccessToken, hashToken } = await import("../src/utils/tokens.js");
const { hashPassword } = await import("../src/utils/passwords.js");

let app: FastifyInstance;
let owner: User;
let other: User;
let workspace: Workspace;
let otherWorkspace: Workspace;
let project: Project;
let otherProject: Project;
let ownerSession: string;
let otherSession: string;
let requestNumber = 0;

function request(options: InjectOptions) {
  // Give each injected request its own IP to keep auth tests independent of rate limits.
  return app.inject({
    ...options,
    remoteAddress: `127.0.0.${++requestNumber}`,
  });
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createKey(
  input: Record<string, unknown> = { name: "Integration" },
  session = ownerSession,
) {
  const response = await request({
    method: "POST",
    url: "/api/api-keys",
    headers: bearer(session),
    payload: input,
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  return response.json().data as {
    id: string;
    key: string;
    name: string;
    prefix: string;
    expiresAt: string | null;
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  owner = await app.prisma.user.create({
    data: {
      email: `api-owner-${suffix}@example.test`,
      displayName: "API owner",
      emailVerified: true,
      passwordHash: await hashPassword("test-password-123!"),
    },
  });
  other = await app.prisma.user.create({
    data: {
      email: `api-other-${suffix}@example.test`,
      displayName: "Other user",
    },
  });
  ownerSession = signAccessToken({ sub: owner.id, email: owner.email });
  otherSession = signAccessToken({ sub: other.id, email: other.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "API integration",
      slug: `api-${suffix}`,
      members: {
        create: [
          { userId: owner.id, role: "ADMIN" },
          { userId: other.id, role: "VIEWER" },
        ],
      },
    },
  });
  otherWorkspace = await app.prisma.workspace.create({
    data: {
      name: "Other workspace",
      slug: `other-${suffix}`,
      members: { create: { userId: other.id, role: "ADMIN" } },
    },
  });
  project = await app.prisma.project.create({
    data: { name: "Test project", workspaceId: workspace.id },
  });
  otherProject = await app.prisma.project.create({
    data: { name: "Other project", workspaceId: otherWorkspace.id },
  });
});

after(async () => {
  if (!app) return;
  for (const record of [workspace, otherWorkspace]) {
    if (record) await app.prisma.workspace.delete({ where: { id: record.id } });
  }
  for (const user of [owner, other]) {
    if (user) await app.prisma.user.delete({ where: { id: user.id } });
  }
  await app.close();
});

test("creation returns a random key once and stores only its hash and metadata", async () => {
  const created = await createKey({
    name: "  CI pipeline  ",
    expiresInDays: 7,
  });
  assert.match(created.key, /^wk_[a-f0-9]{64}$/);
  assert.equal(created.name, "CI pipeline");
  assert.equal(created.prefix, created.key.slice(0, 11));
  const stored = await app.prisma.apiKey.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal(stored.tokenHash, hashToken(created.key));
  assert.ok(!JSON.stringify(stored).includes(created.key));
  const listed = await request({
    method: "GET",
    url: "/api/api-keys",
    headers: bearer(ownerSession),
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const metadata = listed
    .json()
    .data.find((key: { id: string }) => key.id === created.id);
  assert.equal(metadata.key, undefined);
  assert.equal(metadata.tokenHash, undefined);
  assert.ok(!listed.body.includes(created.key));
});

test("expiration defaults to 30 days and accepts the supported lifetimes or no expiration", async () => {
  for (const days of [undefined, 1, 7, 30, 90, 365, null]) {
    const start = Date.now();
    const created = await createKey({
      name: "Lifetime",
      ...(days === undefined ? {} : { expiresInDays: days }),
    });
    if (days === null) assert.equal(created.expiresAt, null);
    else {
      const expected = (days ?? 30) * 86_400_000;
      assert.ok(Date.parse(created.expiresAt!) >= start + expected);
      assert.ok(Date.parse(created.expiresAt!) <= Date.now() + expected);
    }
  }
});

test("invalid names and expiration values are rejected", async () => {
  for (const payload of [
    { name: " " },
    { name: "x".repeat(101) },
    { expiresInDays: 7 },
    ...[0, -1, 366, 1.5, "30"].map((expiresInDays) => ({
      name: "Invalid",
      expiresInDays,
    })),
  ]) {
    const response = await request({
      method: "POST",
      url: "/api/api-keys",
      headers: bearer(ownerSession),
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
});

test("a valid Bearer key works on existing endpoints and records last use", async () => {
  const created = await createKey();
  const response = await request({
    method: "GET",
    url: "/api/users/me",
    headers: bearer(created.key),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.id, owner.id);
  const stored = await app.prisma.apiKey.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.ok(stored.lastUsedAt);
});

test("expired, revoked, unknown, malformed and URL-supplied keys are rejected", async () => {
  const expired = await createKey();
  await app.prisma.apiKey.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const revoked = await createKey();
  const revoke = await request({
    method: "DELETE",
    url: `/api/api-keys/${revoked.id}`,
    headers: bearer(ownerSession),
  });
  assert.equal(revoke.statusCode, 204, revoke.body);
  for (const token of [
    expired.key,
    revoked.key,
    `wk_${"0".repeat(64)}`,
    "wk_invalid",
    "invalid-jwt",
  ]) {
    const response = await request({
      method: "GET",
      url: "/api/users/me",
      headers: bearer(token),
    });
    assert.equal(response.statusCode, 401, response.body);
  }
  const valid = await createKey();
  const response = await request({
    method: "GET",
    url: `/api/users/me?token=${valid.key}`,
  });
  assert.equal(response.statusCode, 401, response.body);
});

test("revocation is immediate and does not affect other keys or JWT sessions", async () => {
  const first = await createKey();
  const second = await createKey();
  assert.notEqual(first.key, second.key);
  const revoke = await request({
    method: "DELETE",
    url: `/api/api-keys/${first.id}`,
    headers: bearer(ownerSession),
  });
  assert.equal(revoke.statusCode, 204, revoke.body);
  for (const [token, expected] of [
    [first.key, 401],
    [second.key, 200],
    [ownerSession, 200],
  ] as const) {
    const response = await request({
      method: "GET",
      url: "/api/users/me",
      headers: bearer(token),
    });
    assert.equal(response.statusCode, expected, response.body);
  }
});

test("users cannot list or revoke another user's keys", async () => {
  const created = await createKey();
  const listed = await request({
    method: "GET",
    url: "/api/api-keys",
    headers: bearer(otherSession),
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.ok(!listed.body.includes(created.id));
  const revoke = await request({
    method: "DELETE",
    url: `/api/api-keys/${created.id}`,
    headers: bearer(otherSession),
  });
  assert.equal(revoke.statusCode, 404, revoke.body);
  const stillValid = await request({
    method: "GET",
    url: "/api/users/me",
    headers: bearer(created.key),
  });
  assert.equal(stillValid.statusCode, 200, stillValid.body);
});

test("keys cannot list, create, or revoke credentials", async () => {
  const created = await createKey();
  for (const [method, url] of [
    ["GET", "/api/api-keys"],
    ["POST", "/api/api-keys"],
    ["DELETE", `/api/api-keys/${created.id}`],
  ] as const) {
    const response = await request({
      method,
      url,
      headers: bearer(created.key),
      ...(method === "POST" ? { payload: { name: "Nested key" } } : {}),
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  const anonymous = await request({ method: "GET", url: "/api/api-keys" });
  assert.equal(anonymous.statusCode, 401, anonymous.body);
});

test("keys preserve workspace boundaries, roles, and changes to current membership", async () => {
  const created = await createKey();
  const headers = bearer(created.key);
  const readable = await request({
    method: "GET",
    url: `/api/projects/${project.id}`,
    headers,
  });
  assert.equal(readable.statusCode, 200, readable.body);
  const otherScope = await request({
    method: "GET",
    url: `/api/projects/${otherProject.id}`,
    headers,
  });
  assert.equal(otherScope.statusCode, 403, otherScope.body);
  const userId_workspaceId = { userId: owner.id, workspaceId: workspace.id };
  await app.prisma.workspaceMember.update({
    where: { userId_workspaceId },
    data: { role: "VIEWER" },
  });
  const cannotWrite = await request({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/projects`,
    headers,
    payload: { name: "Forbidden" },
  });
  assert.equal(cannotWrite.statusCode, 403, cannotWrite.body);
  await app.prisma.workspaceMember.delete({ where: { userId_workspaceId } });
  const removed = await request({
    method: "GET",
    url: `/api/projects/${project.id}`,
    headers,
  });
  assert.equal(removed.statusCode, 403, removed.body);
  await app.prisma.workspaceMember.create({
    data: { ...userId_workspaceId, role: "ADMIN" },
  });
  const canWrite = await request({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/projects`,
    headers,
    payload: { name: "Created by API key" },
  });
  assert.equal(canWrite.statusCode, 201, canWrite.body);
});

test("deleting an owner cascades to their keys and invalidates access", async () => {
  const temporary = await app.prisma.user.create({
    data: {
      email: `temporary-${crypto.randomUUID()}@example.test`,
      displayName: "Temporary",
    },
  });
  const session = signAccessToken({
    sub: temporary.id,
    email: temporary.email,
  });
  const created = await createKey({ name: "Temporary" }, session);
  await app.prisma.user.delete({ where: { id: temporary.id } });
  assert.equal(
    await app.prisma.apiKey.findUnique({ where: { id: created.id } }),
    null,
  );
  const response = await request({
    method: "GET",
    url: "/api/users/me",
    headers: bearer(created.key),
  });
  assert.equal(response.statusCode, 401, response.body);
});

test("browser login and refresh cookies continue to work", async () => {
  const login = await request({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: owner.email, password: "test-password-123!" },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.ok(login.json().data.accessToken);
  const cookie = login.cookies.find(
    (cookie) => cookie.name === "refresh_token",
  );
  assert.ok(cookie);
  const refresh = await request({
    method: "POST",
    url: "/api/auth/refresh",
    cookies: { refresh_token: cookie.value },
  });
  assert.equal(refresh.statusCode, 200, refresh.body);
  assert.ok(refresh.json().data.accessToken);
});
