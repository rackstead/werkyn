import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { parseMessage, startSmtpCapture } from "../fixtures/smtp-capture.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
const smtp = await startSmtpCapture();
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-http-session-"));
const secret = "http-session-validity-fixture-signing-secret";
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: secret,
  COOKIE_SECRET: "http-session-validity-fixture-cookie-secret",
  STORAGE_DIR: storageDir,
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(smtp.port),
  SMTP_SECURE: "false",
  SMTP_FROM: "fixture@example.test",
  SMTP_USER: "",
  SMTP_PASS: "",
});
const { buildApp } = await import("../../src/app.ts");
const { hashPassword } = await import("../../src/utils/passwords.ts");
const { hashToken } = await import("../../src/utils/tokens.ts");
const { authenticate } = await import("../../src/middleware/authenticate.ts");
const { default: errors } = await import("../../src/plugins/errors.ts");
const { baseLoggerOptions } = await import("../../src/utils/logger.ts");
const { resetTransporter } = await import("../../src/utils/mailer.ts");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");
const { Prisma, PrismaClient } = await import("@prisma/client");

const domain = `http-session-${crypto.randomBytes(5).toString("hex")}.example.test`;
const password = "Fixture-password-123";
let app, origin, passwordHash;
let users = 0;
let requests = 0;
const workspaces = [];
const families = new Set();
const extraUserIds = [];
before(async () => {
  resetTransporter();
  app = await buildApp();
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  passwordHash = await hashPassword(password);
});
after(async () => {
  try {
    await app?.prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await app?.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: [...families] } } });
    await app?.prisma.user.deleteMany({ where: { OR: [{ email: { endsWith: `@${domain}` } }, { id: { in: extraUserIds } }] } });
    await app?.prisma.loginAttempt.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  } finally {
    await app?.close();
    resetTransporter();
    await smtp.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

// Each request uses a separate loopback source address so route limits remain
// enabled without turning session-policy assertions into rate-limit assertions.
function request(method, pathname, { token, cookie, payload, base = origin } = {}) {
  const n = ++requests;
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(new URL(pathname, base), {
      method,
      localAddress: `127.47.${(n >> 8) & 255}.${n & 255}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}),
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body,
        json: body ? JSON.parse(body) : null,
        cookie: /refresh_token=([^;]+)/.exec(response.headers["set-cookie"]?.join(";") ?? "")?.[1],
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
function makeUser() {
  return app.prisma.user.create({ data: {
    email: `user-${++users}@${domain}`, displayName: "HTTP session fixture",
    emailVerified: true, passwordHash,
  } });
}
async function login(user, currentPassword = password) {
  const response = await request("POST", "/api/auth/login", { payload: { email: user.email, password: currentPassword } });
  assert.equal(response.status, 200, response.body);
  const token = response.json.data.accessToken;
  assert.ok(response.cookie);
  const sid = jwt.decode(token).sid;
  families.add(sid);
  return { token, cookie: response.cookie, sid };
}
function me(token, extra = {}) { return request("GET", "/api/users/me", { token, ...extra }); }
function sign(user, claims = {}, options = { expiresIn: "15m" }) {
  return jwt.sign({ sub: user.id, email: user.email, ...claims }, secret, options);
}
async function denied(user, token) {
  const before = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const keysBefore = await app.prisma.apiKey.count({ where: { userId: user.id } });
  const responses = await Promise.all([
    me(token),
    request("PATCH", "/api/users/me", { token, payload: { displayName: "Denied write" } }),
    request("POST", "/api/api-keys", { token, payload: { name: "Denied credential" } }),
  ]);
  assert.deepEqual(responses.map((r) => r.status), [401, 401, 401], "ended session must be refused before protected work");
  assert.deepEqual(await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }), before);
  assert.equal(await app.prisma.apiKey.count({ where: { userId: user.id } }), keysBefore);
  for (const response of responses) {
    assert.equal(response.json.error, "Unauthorized");
    assert.equal(response.body.includes(token), false);
    assert.equal(response.body.includes(user.id), false);
  }
}
async function refresh(session) {
  return request("POST", "/api/auth/refresh", { cookie: session.cookie });
}
// Model OIDC's second family with its session-creation primitive. Obtain the
// access token through the real refresh API, never fabricated JWT/token rows.
async function additionalSession(user) {
  const first = await startRefreshSession(app.prisma, user.id);
  families.add(first.familyId);
  const response = await refresh({ cookie: first.refreshToken });
  assert.equal(response.status, 200, response.body);
  return { token: response.json.data.accessToken, cookie: response.cookie, sid: first.familyId };
}
async function resetLink(user) {
  const response = await request("POST", "/api/auth/forgot-password", { payload: { email: user.email } });
  assert.equal(response.status, 200, response.body);
  const message = smtp.messages.findLast((m) => m.envelope.to.includes(`<${user.email}>`));
  assert.ok(message, "forgot-password must deliver its link to the local SMTP capture");
  const textOf = (part) => part.text ?? part.parts.map(textOf).join("\n");
  const link = /https?:\/\/[^\s"<>]*\/reset-password\/([a-f0-9]{64})/.exec(textOf(parseMessage(message.data)));
  assert.ok(link, "reset link must come from the actual message, never from token storage");
  return link[1];
}

test("current login and refresh tokens authorize header reads and writes; query credentials are refused; refused change and unknown logout keep the session", async () => {
  const user = await makeUser();
  const session = await login(user);
  assert.equal((await me(session.token)).status, 200);
  assert.equal((await request("GET", `/api/users/me?token=${session.token}`)).status, 401);
  const rotated = await refresh(session);
  assert.equal(rotated.status, 200, rotated.body);
  assert.equal(jwt.decode(rotated.json.data.accessToken).sid, session.sid);
  assert.equal((await me(session.token)).status, 200, "rotation does not revoke issued access tokens");
  assert.equal((await me(rotated.json.data.accessToken)).status, 200);
  assert.equal((await request("PATCH", "/api/users/me", { token: session.token, payload: { displayName: "Valid write" } })).status, 200);
  assert.equal((await request("PATCH", `/api/users/${user.id}/password`, { token: session.token, payload: { currentPassword: "wrong-password", newPassword: "New-password-123" } })).status, 400);
  assert.equal((await request("POST", "/api/auth/logout", { token: session.token, cookie: "unknown-cookie" })).status, 204);
  assert.equal((await me(session.token)).status, 200);
});

test("logout refuses subsequent protected reads, writes and credential creation; another account and a newer login survive stale work", async () => {
  const user = await makeUser();
  const other = await login(await makeUser());
  const session = await login(user);
  const sameUser = await additionalSession(user);
  assert.equal((await me(session.token)).status, 200);
  assert.equal((await request("POST", "/api/auth/logout", session)).status, 204);
  await denied(user, session.token);
  assert.equal((await refresh(session)).status, 401);
  assert.equal((await me(sameUser.token)).status, 200, "logout affects only the cookie's family");
  const newer = await login(user);
  assert.equal((await request("POST", "/api/auth/logout", { token: session.token, cookie: newer.cookie })).status, 401);
  assert.equal((await me(newer.token)).status, 200);
  assert.equal((await me(other.token)).status, 200);
  assert.equal((await refresh(newer)).status, 200);
});

test("password login replaces the earlier family before subsequent HTTP work", async () => {
  const user = await makeUser();
  const first = await login(user);
  const latest = await login(user);
  assert.notEqual(first.sid, latest.sid);
  await denied(user, first.token);
  assert.equal((await me(latest.token)).status, 200);
});

test("concurrent HTTP reads stay valid across atomic refresh rotation without a cached family decision", async () => {
  const user = await makeUser();
  let session = await login(user);
  const original = session.token;
  for (let round = 0; round < 12; round++) {
    const [rotated, ...reads] = await Promise.all([refresh(session), ...Array.from({ length: 4 }, () => me(original))]);
    assert.equal(rotated.status, 200, rotated.body);
    assert.deepEqual(reads.map((r) => r.status), [200, 200, 200, 200]);
    session = { token: rotated.json.data.accessToken, cookie: rotated.cookie };
  }
  assert.equal((await request("POST", "/api/auth/logout", session)).status, 204);
  await denied(user, original);
});

test("password change ends the caller's HTTP session and preserves another user and a later sign-in", async () => {
  const user = await makeUser();
  const session = await login(user);
  const sameUser = await additionalSession(user);
  const other = await login(await makeUser());
  const response = await request("PATCH", `/api/users/${user.id}/password`, { token: session.token, payload: { currentPassword: password, newPassword: "Changed-password-123" } });
  assert.equal(response.status, 200, response.body);
  await denied(user, session.token);
  await denied(user, sameUser.token);
  const newer = await login(user, "Changed-password-123");
  assert.equal((await request("PATCH", `/api/users/${user.id}/password`, { token: session.token, payload: { currentPassword: password, newPassword: "Stale-password-123" } })).status, 401);
  assert.equal((await me(newer.token)).status, 200);
  assert.equal((await me(other.token)).status, 200);
});

test("a reset delivered by the actual forgot-password API ends HTTP access; a used link and stale logout leave the new login live", async () => {
  const user = await makeUser();
  const session = await login(user);
  const sameUser = await additionalSession(user);
  const other = await login(await makeUser());
  const raw = await resetLink(user);
  const response = await request("POST", `/api/auth/reset-password/${raw}`, { payload: { password: "Reset-password-123" } });
  assert.equal(response.status, 200, response.body);
  await denied(user, session.token);
  await denied(user, sameUser.token);
  const newer = await login(user, "Reset-password-123");
  assert.equal((await request("POST", `/api/auth/reset-password/${raw}`, { payload: { password: "Replayed-password-123" } })).status, 410);
  assert.equal((await request("POST", "/api/auth/logout", { token: session.token, cookie: newer.cookie })).status, 401);
  assert.equal((await me(newer.token)).status, 200);
  assert.equal((await me(other.token)).status, 200);
});

test("refresh reuse outside the grace window ends only that family's HTTP access", async () => {
  const user = await makeUser();
  const session = await login(user);
  const sameUser = await additionalSession(user);
  const other = await login(await makeUser());
  assert.equal((await refresh(session)).status, 200);
  assert.equal((await refresh(session)).status, 409);
  assert.equal((await me(session.token)).status, 200);
  // Control the elapsed time of a real API rotation without waiting 30 s.
  await app.prisma.rotatedRefreshToken.update({ where: { tokenHash: hashToken(session.cookie) }, data: { rotatedAt: new Date(Date.now() - 31_000) } });
  assert.equal((await refresh(session)).status, 401);
  await denied(user, session.token);
  assert.equal((await me(sameUser.token)).status, 200, "reuse affects only the replayed family");
  const newer = await login(user);
  assert.equal((await refresh(session)).status, 401);
  assert.equal((await me(newer.token)).status, 200);
  assert.equal((await me(other.token)).status, 200);
});

test("a family whose current refresh token expired cannot authorize a still-unexpired access JWT, including after expired-token cleanup", async () => {
  const user = await makeUser();
  const session = await login(user);
  await app.prisma.refreshToken.update({ where: { token: hashToken(session.cookie) }, data: { expiresAt: new Date(Date.now() - 1) } });
  await denied(user, session.token);
  assert.equal((await refresh(session)).status, 401);
  assert.equal(await app.prisma.refreshToken.count({ where: { familyId: session.sid } }), 0);
  await denied(user, session.token);
  const latest = await login(user);
  assert.equal((await me(latest.token)).status, 200);
});

test("malformed present sid, unknown family and wrong-owner family refuse all protected work", async () => {
  const user = await makeUser();
  const session = await login(user);
  const other = await login(await makeUser());
  for (const sid of [null, false, 42, {}, [], "", "not-a-family", crypto.randomUUID(), other.sid]) {
    await denied(user, sign(user, { sid }));
  }
  assert.equal((await me(session.token)).status, 200);
  assert.equal((await me(other.token)).status, 200);
});

test("legacy tokens without sid retain only their JWT expiry grace; invalid, expired and expiry-less tokens fail", async () => {
  const user = await makeUser();
  const session = await login(user);
  assert.equal((await request("POST", "/api/auth/logout", session)).status, 204);
  assert.equal((await me(sign(user))).status, 200, "legacy no-sid grace remains explicit");
  assert.equal((await request("GET", `/api/users/me?token=${sign(user)}`)).status, 401);
  for (const token of ["invalid", sign(user, {}, { expiresIn: -1 }), sign(user, {}, {}), jwt.sign({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 60 }, "another-secret"), sign(user, { sub: null })]) {
    assert.equal((await me(token)).status, 401);
  }
});

test("deleted accounts and deleted families cannot authorize with their earlier access token", async () => {
  const user = await makeUser();
  const session = await login(user);
  await app.prisma.refreshTokenFamily.delete({ where: { id: session.sid } });
  await denied(user, session.token);
  const later = await login(user);
  await app.prisma.user.delete({ where: { id: user.id } });
  assert.equal((await me(later.token)).status, 401);
});

test("API keys remain independent header credentials with expiry/revocation and header-over-query precedence", async () => {
  const user = await makeUser();
  const session = await login(user);
  const response = await request("POST", "/api/api-keys", { token: session.token, payload: { name: "Fixture key", expiresInDays: null } });
  assert.equal(response.status, 201, response.body);
  const key = response.json.data;
  assert.equal((await me(key.key)).status, 200);
  assert.equal((await request("GET", `/api/users/me?token=${key.key}`)).status, 401);
  assert.equal((await request("GET", `/api/users/me?token=invalid`, { token: key.key })).status, 200);
  assert.equal((await request("GET", `/api/users/me?token=${session.token}`, { token: "invalid" })).status, 401);
  assert.equal((await request("POST", "/api/api-keys", { token: key.key, payload: { name: "Denied" } })).status, 403);
  assert.equal((await request("PATCH", `/api/users/${user.id}/password`, { token: session.token, payload: { currentPassword: password, newPassword: "Key-owner-password-123" } })).status, 200);
  assert.equal((await me(key.key)).status, 200, "password change does not revoke independent API keys");
  const latest = await login(user, "Key-owner-password-123");
  assert.equal((await request("POST", "/api/auth/logout", latest)).status, 204);
  assert.equal((await me(key.key)).status, 200, "logout does not revoke independent API keys");
  await app.prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal((await me(key.key)).status, 401);
  await app.prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: null } });
  const managing = await login(user, "Key-owner-password-123");
  assert.equal((await request("DELETE", `/api/api-keys/${key.id}`, managing)).status, 204);
  assert.equal((await me(key.key)).status, 401);
});

test("public shares retain their unauthenticated contract even when the caller supplies an ended access token", async () => {
  const user = await makeUser();
  const session = await login(user);
  const workspace = await app.prisma.workspace.create({ data: { name: "Public fixture", slug: crypto.randomUUID() } });
  workspaces.push(workspace.id);
  const link = await app.prisma.fileShareLink.create({ data: { workspaceId: workspace.id, token: crypto.randomBytes(32).toString("hex"), createdById: user.id } });
  assert.equal((await request("POST", "/api/auth/logout", session)).status, 204);
  for (const token of [undefined, session.token]) {
    assert.equal((await request("GET", `/api/public/files/${link.token}`, { token })).status, 200);
  }
});

test("real operational failures answer503; schema/programming faults answer500 with bounded credential-free diagnostics before protected work", async () => {
  const user = await makeUser();
  const session = await login(user);
  const keyResponse = await request("POST", "/api/api-keys", { token: session.token, payload: { name: "Failure fixture" } });
  assert.equal(keyResponse.status, 201, keyResponse.body);
  const logLines = [];
  let downstream = 0;
  const probe = Fastify({ logger: { ...baseLoggerOptions("error"), stream: { write: (line) => logLines.push(line) } } });
  probe.decorate("prisma", app.prisma);
  await probe.register(errors);
  probe.get("/protected", { preHandler: authenticate }, () => { downstream++; return { ok: true }; });
  const base = await probe.listen({ host: "127.0.0.1", port: 0 });
  const before = await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  try {
    // A real missing relation generates Prisma P2021. Restore before any
    // fixture cleanup; no other test process shares this disposable database.
    for (const table of ["User", "RefreshTokenFamily", "ApiKey"]) {
      await app.prisma.$executeRawUnsafe(`ALTER TABLE "${table}" RENAME TO "HttpSessionUnavailable"`);
      try {
        const tokens = table === "User" ? [session.token, sign(user), keyResponse.json.data.key] : table === "ApiKey" ? [keyResponse.json.data.key] : [session.token];
        for (const token of tokens) {
          const response = await request("GET", "/protected", { token, base });
          assert.equal(response.status, 500, response.body);
          assert.deepEqual(response.json, { statusCode: 500, error: "Internal Server Error", message: "An unexpected error occurred" });
        }
        assert.equal((await request("GET", "/protected", { token: "invalid-jwt", base })).status, 401);
        assert.equal((await request("GET", "/protected", { token: sign(user, { sid: null }), base })).status, 401);
        assert.equal(downstream, 0);
      } finally {
        await app.prisma.$executeRawUnsafe(`ALTER TABLE "HttpSessionUnavailable" RENAME TO "${table}"`);
      }
    }
    const socket = http.createServer();
    await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const unavailablePort = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const unavailableUrl = new URL(process.env.TEST_DATABASE_URL);
    unavailableUrl.hostname = "127.0.0.1";
    unavailableUrl.port = String(unavailablePort);
    unavailableUrl.searchParams.set("connect_timeout", "1");
    const unavailable = new PrismaClient({ datasourceUrl: unavailableUrl.href });
    try {
      probe.prisma = unavailable;
      const response = await request("GET", "/protected", { token: session.token, base });
      assert.equal(response.status, 503, response.body);
      assert.deepEqual(response.json, { statusCode: 503, error: "Service Unavailable", message: "Authentication is temporarily unavailable. Try again in a moment." });
    } finally {
      probe.prisma = app.prisma;
      await unavailable.$disconnect();
    }
    for (const error of [new TypeError(`private-code-error ${session.token}`), new Prisma.PrismaClientValidationError(`private-query-shape ${session.cookie}`, { clientVersion: "test" })]) {
      probe.prisma = new Proxy(app.prisma, { get(target, key) {
        if (key === "user") return new Proxy(target.user, { get(delegate, operation) {
          if (operation === "findUnique") return async () => { throw error; };
          return Reflect.get(delegate, operation);
        } });
        return Reflect.get(target, key);
      } });
      const response = await request("GET", "/protected", { token: session.token, base });
      assert.equal(response.status, 500, response.body);
      assert.deepEqual(response.json, { statusCode: 500, error: "Internal Server Error", message: "An unexpected error occurred" });
    }
    probe.prisma = app.prisma;
    assert.equal(downstream, 0);
    assert.deepEqual(await app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }), before);
    assert.equal((await me(session.token)).status, 200, "operational failure must not revoke the session");
    const logs = logLines.join("");
    assert.match(logs, /Authentication lookup failed/);
    for (const privateValue of [session.token, session.cookie, session.sid, keyResponse.json.data.key, user.email, password, secret, unavailableUrl.href, "HttpSessionUnavailable", "SELECT", "private-code-error", "private-query-shape"]) assert.equal(logs.includes(privateValue), false, privateValue);
    const diagnostics = logLines.map((line) => JSON.parse(line).authentication);
    assert.ok(diagnostics.some((d) => d.stage === "session_account" && d.category === "schema" && d.code === "P2021"));
    assert.ok(diagnostics.some((d) => d.stage === "api_key" && d.category === "schema"));
    assert.ok(diagnostics.some((d) => d.category === "initialization" && d.statusCode === 503));
    assert.ok(diagnostics.some((d) => d.category === "programming" && d.statusCode === 500));
    assert.ok(diagnostics.some((d) => d.category === "query_validation" && d.statusCode === 500));
  } finally {
    await probe.close();
  }
});

test("the actual performance benchmark uses real actor sessions outside timings and cleans them after success and failure", async () => {
  const admin = await app.prisma.user.create({ data: { email: "perf-user-0000@perf.invalid", displayName: "Benchmark admin", emailVerified: true } });
  extraUserIds.push(admin.id);
  const member = await makeUser();
  const preserved = await additionalSession(member);
  const unrelated = await login(await makeUser());
  const workspace = await app.prisma.workspace.create({ data: { name: "Bounded benchmark smoke", slug: "perf-large", members: { create: [{ userId: admin.id, role: "ADMIN" }, { userId: member.id, role: "MEMBER" }] } } });
  workspaces.push(workspace.id);
  const project = await app.prisma.project.create({ data: { name: "Benchmark", workspaceId: workspace.id, members: { create: { userId: member.id } } } });
  const status = await app.prisma.statusColumn.create({ data: { name: "Open", projectId: project.id } });
  await app.prisma.task.create({ data: { title: "Benchmark", projectId: project.id, statusId: status.id, assignees: { create: { userId: member.id } }, activities: { create: { actorId: member.id, action: "created" } } } });
  await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, name: "general", createdById: member.id } });
  const actorIds = [admin.id, member.id];
  const actorFamilies = () => app.prisma.refreshTokenFamily.count({ where: { userId: { in: actorIds } } });
  const cliEnvironment = { ...process.env };
  delete cliEnvironment.COOKIE_SECRET;
  const run = (base) => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/perf/bench.ts", "read", "--samples=1", "--warmup=1", "--only=dashboard"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...cliEnvironment, BENCH_URL: base }, timeout: 30_000,
  });
  assert.equal(await actorFamilies(), 1);
  const success = await run(origin);
  assert.match(success.stdout, /workspace: dashboard \(member\).*1 items/);
  assert.match(success.stdout, /workspace: dashboard \(admin\).*1 items/);
  assert.equal(await actorFamilies(), 1, "success must remove only benchmark-created families");
  assert.equal((await me(preserved.token)).status, 200);
  const socket = http.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const unavailablePort = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  await assert.rejects(run(`http://127.0.0.1:${unavailablePort}`), { code: 1 });
  assert.equal(await actorFamilies(), 1, "failure must also remove only benchmark-created families");
  assert.equal((await me(preserved.token)).status, 200);
  assert.equal((await me(unrelated.token)).status, 200);
});
