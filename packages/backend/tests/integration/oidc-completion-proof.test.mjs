import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import jwt from "jsonwebtoken";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "oidc-completion-owned-jwt-secret";
process.env.COOKIE_SECRET = "oidc-completion-owned-cookie-secret";
process.env.COOKIE_SECURE = "false";
process.env.COOKIE_SAMESITE = "strict";
process.env.FRONTEND_URL = "http://oidc-completion.example.test";
process.env.CORS_ORIGIN = process.env.FRONTEND_URL;
process.env.DEX_CLIENT_SECRET = "oidc-completion-owned-client-secret";
const issuer = `${process.env.FRONTEND_URL}/dex`;
const suffix = crypto.randomUUID();
const domain = `oidc-${suffix}.example.test`;
const connectorId = `audit-${suffix}`;
const secondConnectorId = `other-${suffix}`;
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "audit-rsa",
  alg: "RS256",
  use: "sig",
};
const codes = new Map();
let tokenRequests = 0;
const idp = http.createServer(async (request, response) => {
  if (request.url === "/dex/keys") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (request.url !== "/dex/token" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  tokenRequests++;
  let body = "";
  for await (const chunk of request) body += chunk;
  const params = new URLSearchParams(body);
  const data = codes.get(params.get("code"));
  codes.delete(params.get("code"));
  if (
    !data ||
    params.get("client_id") !== "werkyn" ||
    params.get("client_secret") !== process.env.DEX_CLIENT_SECRET ||
    params.get("code_verifier") !==
      (data.expectedVerifier ?? data.state.codeVerifier) ||
    params.get("redirect_uri") !==
      `${process.env.FRONTEND_URL}/api/auth/oidc/callback`
  ) {
    response
      .writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }
  const claims = {
    iss: issuer,
    aud: "werkyn",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: data.state.nonce,
    sub: `subject-${crypto.randomUUID()}`,
    email: `new-${crypto.randomUUID()}@${domain}`,
    email_verified: true,
    name: "OIDC User",
    federated_claims: {
      connector_id: data.state.connectorId ?? connectorId,
      user_id: "audit-upstream-user",
    },
    ...data.claims,
  };
  for (const key of data.omit ?? []) delete claims[key];
  const idToken = jwt.sign(
    claims,
    data.wrongSignature ? wrongKeys.privateKey : keys.privateKey,
    { algorithm: "RS256", keyid: "audit-rsa" },
  );
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      access_token: "fake-upstream-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    }),
  );
});
idp.listen(0, "127.0.0.1");
await once(idp, "listening");
process.env.DEX_INTERNAL_PORT = String(idp.address().port);
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-oidc-completion-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { hashToken } = await import("../../src/utils/tokens.js");
const { oidcProviderNamespace } =
  await import("../../src/modules/auth/oidc/oidc-identity.js");
let app, origin, originalConfig;
const families = new Set();
const states = [];
let requestNumber = 0;

function cookiesOf(headers) {
  return (headers["set-cookie"] ?? []).map((raw) => {
    const [pair] = raw.split(";"),
      at = pair.indexOf("=");
    return {
      name: pair.slice(0, at),
      value: decodeURIComponent(pair.slice(at + 1)),
      raw,
    };
  });
}
function applyCookies(jar, response) {
  for (const cookie of response.cookies) {
    if (cookie.value) jar[cookie.name] = cookie.value;
    else delete jar[cookie.name];
  }
}
function request(
  method,
  pathname,
  { cookies = {}, payload, rawBody, headers = {} } = {},
) {
  const n = ++requestNumber,
    body =
      rawBody ?? (payload === undefined ? undefined : JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(pathname, origin),
      {
        method,
        localAddress: `127.58.${(n >> 8) & 255}.${n & 255}`,
        headers: {
          ...(Object.keys(cookies).length
            ? {
                cookie: Object.entries(cookies)
                  .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                  .join("; "),
              }
            : {}),
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text,
            json:
              text && response.headers["content-type"]?.includes("json")
                ? JSON.parse(text)
                : null,
            cookies: cookiesOf(response.headers),
            setCookie: response.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () =>
      req.destroy(new Error("Owned fixture HTTP deadline")),
    );
    req.end(body);
  });
}
async function start({ jar = {}, attemptId, returnUrl = "/workspace" } = {}) {
  const query = new URLSearchParams({
    connector_id: connectorId,
    return_url: returnUrl,
    ...(attemptId ? { client_attempt: attemptId } : {}),
  });
  const response = await request("GET", `/api/auth/oidc/login?${query}`, {
    cookies: jar,
  });
  assert.equal(response.status, 302, response.body);
  const authorization = new URL(response.headers.location),
    state = authorization.searchParams.get("state");
  assert.equal(authorization.pathname, "/dex/auth");
  states.push(state);
  const row = await app.prisma.oidcState.findUniqueOrThrow({
    where: { state },
  });
  assert.equal(
    authorization.searchParams.get("code_challenge"),
    crypto.createHash("sha256").update(row.codeVerifier).digest("base64url"),
  );
  assert.equal(authorization.searchParams.get("nonce"), row.nonce);
  assert.ok(
    authorization.searchParams.get("scope").split(" ").includes("federated:id"),
  );
  const cookie = response.cookies.find((c) => c.name === `oidc_state_${state}`);
  assert.ok(cookie?.value);
  applyCookies(jar, response);
  return { state: row, cookie, response, jar, attemptId };
}
function issue(attempt, claims = {}, extra = {}) {
  const code = crypto.randomBytes(16).toString("hex");
  codes.set(code, { state: attempt.state, claims, ...extra });
  return code;
}
async function callback(
  attempt,
  code,
  { cookies = attempt.jar, query = {} } = {},
) {
  const params = new URLSearchParams({
    state: attempt.state.state,
    code,
    ...query,
  });
  const response = await request("GET", `/api/auth/oidc/callback?${params}`, {
    cookies,
  });
  if (cookies === attempt.jar) applyCookies(attempt.jar, response);
  return response;
}
async function succeeded(attempt) {
  const response = await callback(attempt, issue(attempt));
  assert.equal(response.status, 302, response.body);
  const target = new URL(response.headers.location);
  assert.equal(target.pathname, "/auth/oidc/complete");
  assert.equal(target.hash, "");
  assert.equal(target.searchParams.get("return_url"), attempt.state.returnUrl);
  const cookie = response.cookies.find(
    (c) => c.name === "refresh_token" && c.value,
  );
  assert.ok(cookie?.value);
  const token = await app.prisma.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(cookie.value) },
    include: { user: true, family: true },
  });
  families.add(token.familyId);
  assert.equal(token.family.revokedAt, null);
  return { response, cookie, token };
}
function failed(response) {
  assert.equal(response.status, 302, response.body);
  assert.equal(new URL(response.headers.location).pathname, "/login");
  assert.ok(
    !response.cookies.some((c) => c.name === "refresh_token" && c.value),
  );
  assert.equal(response.headers["cache-control"], "no-store");
}
function unsigned(cookie) {
  const result = app.unsignCookie(cookie.value);
  assert.equal(result.valid, true);
  return result.value;
}
async function familyState(id) {
  return {
    family: await app.prisma.refreshTokenFamily.findUniqueOrThrow({
      where: { id },
    }),
    tokens: await app.prisma.refreshToken.findMany({
      where: { familyId: id },
      orderBy: { id: "asc" },
    }),
    rotated: await app.prisma.rotatedRefreshToken.findMany({
      where: { familyId: id },
      orderBy: { tokenHash: "asc" },
    }),
  };
}

const { PrismaClient } = await import("@prisma/client");
const { env } = await import("../../src/config/env.js");
const controlUrl = new URL(process.env.TEST_DATABASE_URL);
controlUrl.searchParams.set("connection_limit", "1");
const control = new PrismaClient({ datasourceUrl: controlUrl.toString() });
const observer = new PrismaClient({ datasourceUrl: controlUrl.toString() });
const workspaces = new Set();

before(async () => {
  await Promise.all([control.$connect(), observer.$connect()]);
  app = await buildApp();
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  originalConfig = await app.prisma.ssoConfig.findUnique({
    where: { id: "singleton" },
  });
  await app.prisma.ssoConfig.upsert({
    where: { id: "singleton" },
    create: { enabled: true },
    update: { enabled: true, autoLinkByEmail: true },
  });
  await app.prisma.ssoConnector.createMany({
    data: [connectorId, secondConnectorId].map((connectorId) => ({
      connectorId,
      name: "Owned signed loopback IdP",
      type: "oidc",
      config: {},
      enabled: true,
    })),
  });
});
after(async () => {
  try {
    await Promise.all([control.$disconnect(), observer.$disconnect()]);
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [...workspaces] } },
      });
      await app.prisma.oidcState.deleteMany({
        where: { state: { in: states } },
      });
      await app.prisma.rotatedRefreshToken.deleteMany({
        where: { familyId: { in: [...families] } },
      });
      await app.prisma.user.deleteMany({
        where: { email: { endsWith: `@${domain}` } },
      });
      await app.prisma.ssoConnector.deleteMany({
        where: { connectorId: { in: [connectorId, secondConnectorId] } },
      });
      if (originalConfig)
        await app.prisma.ssoConfig.update({
          where: { id: "singleton" },
          data: {
            enabled: originalConfig.enabled,
            autoLinkByEmail: originalConfig.autoLinkByEmail,
            passwordLoginEnabled: originalConfig.passwordLoginEnabled,
          },
        });
      else
        await app.prisma.ssoConfig.deleteMany({ where: { id: "singleton" } });
    }
  } finally {
    await app?.close();
    const closed = once(idp, "close");
    idp.close();
    await closed;
    await rm(storageDir, { recursive: true, force: true });
  }
});

const trusted = {
  origin: process.env.FRONTEND_URL,
  "x-werkyn-oidc-completion": "1",
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function noCookie(response) {
  assert.deepEqual(response.setCookie, [], response.body);
  assert.equal(response.headers["cache-control"], "no-store");
}
const complete = (s, extra = {}) =>
  request("POST", "/api/auth/oidc/complete-session", {
    cookies: s.a.jar,
    payload: { attemptId: s.a.attemptId },
    headers: trusted,
    ...extra,
  });
const encodedJar = (jar) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
async function session({ jar = {}, identity } = {}) {
  const a = await start({ jar, attemptId: crypto.randomUUID() }),
    code = issue(a, identity ?? {}),
    response = await callback(a, code);
  assert.equal(
    new URL(response.headers.location).pathname,
    "/auth/oidc/complete",
  );
  const cookie = a.jar.refresh_token;
  assert.ok(cookie);
  const token = await app.prisma.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(cookie) },
  });
  families.add(token.familyId);
  const marker = a.jar[a.cookie.name];
  assert.ok(marker);
  const proof = JSON.parse(unsigned({ value: marker }));
  return { a, code, response, cookie, token, marker, proof };
}
const signed = (s, patch) =>
  app.signCookie(JSON.stringify({ ...s.proof, ...patch }));
async function unchanged(s, run) {
  const before = await familyState(s.token.familyId);
  const response = await run();
  assert.deepEqual(await familyState(s.token.familyId), before);
  return response;
}
function gateMembership() {
  const delegate = app.prisma.workspaceMember,
    original = delegate.findMany;
  let enter,
    release,
    blocked = false;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    released = new Promise((resolve) => {
      release = resolve;
    });
  delegate.findMany = async (...args) => {
    if (!blocked) {
      blocked = true;
      enter();
      await released;
    }
    return original.apply(delegate, args);
  };
  return {
    async entered() {
      let timer;
      try {
        await Promise.race([
          entered,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Membership read was not reached")),
              3_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    release,
    restore() {
      release();
      delegate.findMany = original;
    },
  };
}
async function heldFamily(id, run) {
  let enter, release;
  const entered = new Promise((resolve) => {
      enter = resolve;
    }),
    released = new Promise((resolve) => {
      release = resolve;
    });
  const held = control.$transaction(
    async (tx) => {
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM "RefreshTokenFamily" WHERE id = ${id} FOR UPDATE`;
      enter(pid);
      await released;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
  try {
    const pid = await Promise.race([
      entered,
      held.then(() => {
        throw new Error("Holder ended early");
      }),
    ]);
    return await run(pid, release);
  } finally {
    release();
    await held;
  }
}
async function finishesWithoutLock(run, pid, release) {
  let done = false;
  const pending = run().finally(() => {
    done = true;
  });
  try {
    const deadline = Date.now() + 3_000;
    while (!done) {
      const [{ n }] =
        await observer.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>${pid} AND wait_event_type='Lock' AND query LIKE '%RefreshTokenFamily%'`;
      assert.equal(n, 0, "Completion must not acquire a family row lock");
      assert.ok(Date.now() < deadline);
      await delay(10);
    }
    return await pending;
  } finally {
    release();
    await pending;
  }
}

test("opt-in signed callback retains actual attempt-bound completion proof", async () => {
  const attemptId = crypto.randomUUID(),
    attempt = await start({ attemptId }),
    started = unsigned(attempt.cookie);
  const exchangedBefore = tokenRequests,
    completed = await succeeded(attempt);
  const retained = completed.response.cookies.find(
    (c) => c.name === attempt.cookie.name && c.value,
  );
  let startPayload;
  try {
    startPayload = JSON.parse(started);
  } catch {
    startPayload = null;
  }
  assert.ok(
    retained,
    "validated opt-in callback must retain a signed completed-phase cookie",
  );
  const payload = JSON.parse(unsigned(retained));
  assert.equal(payload.attemptId, attemptId);
  assert.equal(payload.state, attempt.state.state);
  assert.equal(payload.familyId, completed.token.familyId);
});

test("completed SSO session can be obtained without rotating or writing cookies", async () => {
  const attemptId = crypto.randomUUID(),
    attempt = await start({ attemptId }),
    completed = await succeeded(attempt);
  const original = await familyState(completed.token.familyId);
  const response = await request("POST", "/api/auth/oidc/complete-session", {
    cookies: attempt.jar,
    payload: { attemptId },
    headers: {
      origin: process.env.FRONTEND_URL,
      "x-werkyn-oidc-completion": "1",
    },
  });
  const after = await familyState(completed.token.familyId);
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(response.setCookie, []);
  assert.equal(response.json.data.user.id, completed.token.userId);
  assert.equal(
    JSON.parse(
      Buffer.from(response.json.data.accessToken.split(".")[1], "base64url"),
    ).sid,
    completed.token.familyId,
  );
  assert.deepEqual(after, original);
});

test("legacy signed state and callback retain PKCE nonce attributes and ordinary refresh contract", async () => {
  const attempt = await start();
  assert.equal(unsigned(attempt.cookie), attempt.state.state);
  assert.match(attempt.cookie.raw, /HttpOnly/i);
  assert.match(attempt.cookie.raw, /SameSite=Lax/i);
  assert.match(attempt.cookie.raw, /Path=\/api\/auth\/oidc/i);
  assert.match(attempt.cookie.raw, /Max-Age=600/i);
  const completed = await succeeded(attempt);
  assert.equal(attempt.jar[attempt.cookie.name], undefined);
  assert.match(completed.cookie.raw, /SameSite=Strict/i);
  assert.match(completed.cookie.raw, /Max-Age=604800/i);
  const response = await request("POST", "/api/auth/refresh", {
    cookies: attempt.jar,
  });
  assert.equal(response.status, 200, response.body);
  assert.ok(
    response.cookies.some(
      (c) => c.name === "refresh_token" && c.value !== completed.cookie.value,
    ),
  );
  assert.equal(response.json.data.user.id, completed.token.userId);
  assert.equal(
    JSON.parse(
      Buffer.from(response.json.data.accessToken.split(".")[1], "base64url"),
    ).sid,
    completed.token.familyId,
  );
});

test("missing unsigned and foreign browser binding fail before IdP exchange without consuming pending state", async () => {
  const a = await start(),
    b = await start(),
    before = tokenRequests;
  for (const cookies of [
    {},
    { [a.cookie.name]: a.state.state },
    { [a.cookie.name]: b.cookie.value },
  ]) {
    failed(await callback(a, "unused", { cookies }));
    assert.equal(
      await app.prisma.oidcState.count({ where: { state: a.state.state } }),
      1,
    );
  }
  assert.equal(tokenRequests, before);
});

test("actual PKCE nonce and RSA signature failures do not create identities or families", async () => {
  for (const options of [
    { expectedVerifier: "wrong-owned-verifier" },
    { claims: { nonce: "wrong-owned-nonce" } },
    { wrongSignature: true },
  ]) {
    const a = await start(),
      countBefore = await app.prisma.refreshTokenFamily.count(),
      exchangeBefore = tokenRequests;
    const { claims = {}, ...extra } = options;
    failed(await callback(a, issue(a, claims, extra)));
    assert.equal(tokenRequests, exchangeBefore + 1);
    assert.equal(await app.prisma.refreshTokenFamily.count(), countBefore);
    assert.equal(
      await app.prisma.oidcState.count({ where: { state: a.state.state } }),
      0,
    );
  }
});

test("legacy replay cannot exchange twice or change its already-created active family", async () => {
  const a = await start(),
    code = issue(a),
    first = await callback(a, code);
  assert.equal(new URL(first.headers.location).pathname, "/auth/oidc/complete");
  const raw = a.jar.refresh_token;
  assert.ok(raw);
  const current = await app.prisma.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(raw) },
  });
  families.add(current.familyId);
  const original = await familyState(current.familyId),
    exchangeBefore = tokenRequests;
  failed(await callback(a, code));
  assert.equal(tokenRequests, exchangeBefore);
  assert.deepEqual(await familyState(current.familyId), original);
});

test("legacy MAX5 counts owned valid bindings and ignores junk name signature and state mismatches", async () => {
  const jar = {},
    attempts = [];
  for (let index = 0; index < 6; index++) {
    const a = await start({ jar });
    attempts.push(a);
    if (index === 0) {
      jar.oidc_state_not_a_valid_state = "junk";
      jar[`oidc_state_${crypto.randomBytes(32).toString("hex")}`] = "unsigned";
      jar[`oidc_state_${crypto.randomBytes(32).toString("hex")}`] =
        a.cookie.value;
    }
  }
  const valid = Object.entries(jar).filter(([name, value]) => {
    const state = name.slice("oidc_state_".length);
    if (!/^oidc_state_[a-f0-9]{64}$/.test(name)) return false;
    const decoded = app.unsignCookie(value);
    return decoded.valid && decoded.value === state;
  });
  assert.equal(valid.length, 5);
  assert.equal(jar[attempts[0].cookie.name], undefined);
  assert.equal(Object.keys(jar).length, 8);
});

test("completion returns exactly the ordinary refresh DTO and unchanged access lifetime without cookie renewal", async () => {
  const s = await session();
  await app.prisma.user.update({
    where: { id: s.token.userId },
    data: {
      displayName: "Current profile",
      jobTitle: "Reviewer",
      phone: "fixture",
      timezone: "UTC",
    },
  });
  const workspace = await app.prisma.workspace.create({
    data: {
      name: "Owned completion workspace",
      slug: `completion-${crypto.randomUUID()}`,
      members: { create: { userId: s.token.userId, role: "VIEWER" } },
    },
  });
  workspaces.add(workspace.id);
  const result = await unchanged(s, () => complete(s));
  assert.equal(result.status, 200, result.body);
  noCookie(result);
  assert.deepEqual(
    Object.keys(result.json.data.user).sort(),
    [
      "id",
      "email",
      "displayName",
      "avatarUrl",
      "jobTitle",
      "phone",
      "timezone",
      "emailVerified",
    ].sort(),
  );
  assert.deepEqual(Object.keys(result.json.data).sort(), [
    "accessToken",
    "user",
    "workspaces",
  ]);
  const claims = jwt.verify(
    result.json.data.accessToken,
    process.env.JWT_SECRET,
  );
  assert.equal(claims.sid, s.token.familyId);
  assert.equal(claims.sub, s.token.userId);
  assert.equal(claims.exp - claims.iat, 900);
  const allowed = await request("GET", "/api/users/me", {
    headers: { authorization: `Bearer ${result.json.data.accessToken}` },
  });
  assert.equal(allowed.status, 200, allowed.body);
  const ordinary = await request("POST", "/api/auth/refresh", {
    cookies: s.a.jar,
  });
  assert.equal(ordinary.status, 200, ordinary.body);
  assert.deepEqual(result.json.data.user, ordinary.json.data.user);
  assert.deepEqual(result.json.data.workspaces, ordinary.json.data.workspaces);
});

test("retired rotated proof cannot mint; the active same-family successor can", async () => {
  const s = await session(),
    oldCookie = s.cookie;
  const rotated = await request("POST", "/api/auth/refresh", {
    cookies: s.a.jar,
  });
  assert.equal(rotated.status, 200);
  applyCookies(s.a.jar, rotated);
  const denied = await unchanged(s, () =>
    complete(s, { cookies: { ...s.a.jar, refresh_token: oldCookie } }),
  );
  assert.equal(denied.status, 409, denied.body);
  noCookie(denied);
  assert.equal(denied.json.data, undefined);
  const accepted = await unchanged(s, () => complete(s));
  assert.equal(accepted.status, 200, accepted.body);
  noCookie(accepted);
});

test("completed callback replay and duplicate pending/completed credentials cannot clear proof or exchange again", async () => {
  const s = await session(),
    before = tokenRequests,
    original = await familyState(s.token.familyId);
  const replay = await callback(s.a, s.code);
  failed(replay);
  assert.deepEqual(replay.setCookie, []);
  assert.equal(tokenRequests, before);
  const duplicated = await request(
    "GET",
    `/api/auth/oidc/callback?state=${s.a.state.state}&code=${s.code}`,
    {
      headers: {
        cookie: `${s.a.cookie.name}=${encodeURIComponent(s.a.cookie.value)}; ${s.a.cookie.name}=${encodeURIComponent(s.marker)}`,
      },
    },
  );
  failed(duplicated);
  assert.deepEqual(duplicated.setCookie, []);
  assert.equal(tokenRequests, before);
  assert.deepEqual(await familyState(s.token.familyId), original);
  assert.equal(s.a.jar[s.a.cookie.name], s.marker);
  const retry = await complete(s);
  assert.equal(retry.status, 200);
  noCookie(retry);
});

test("provider cancellation consumes pending state without creating completed proof or a session", async () => {
  const a = await start({ attemptId: crypto.randomUUID() }),
    before = tokenRequests;
  const cancelled = await callback(a, "unused", {
    query: {
      error: "access_denied",
      error_description: "owned-provider-private-description",
    },
  });
  failed(cancelled);
  assert.equal(tokenRequests, before);
  assert.equal(a.jar[a.cookie.name], undefined);
  assert.equal(
    await app.prisma.oidcState.count({ where: { state: a.state.state } }),
    0,
  );
  const response = await request("POST", "/api/auth/oidc/complete-session", {
    cookies: { [a.cookie.name]: a.cookie.value },
    payload: { attemptId: a.attemptId },
    headers: trusted,
  });
  assert.equal(response.status, 409);
  noCookie(response);
  assert.ok(!cancelled.headers.location.includes("private-description"));
});

test("completed phase preserves Secure and configured SameSite with a separate sixty-second expiry", async () => {
  const oldSecure = env.COOKIE_SECURE,
    oldSameSite = env.COOKIE_SAMESITE;
  try {
    env.COOKIE_SECURE = "true";
    env.COOKIE_SAMESITE = "none";
    const s = await session();
    assert.match(s.a.cookie.raw, /Secure/);
    assert.match(s.a.cookie.raw, /SameSite=Lax/);
    assert.match(s.a.cookie.raw, /Max-Age=600/);
    const marker = s.response.cookies.find((c) => c.name === s.a.cookie.name);
    assert.match(marker.raw, /HttpOnly/);
    assert.match(marker.raw, /Secure/);
    assert.match(marker.raw, /SameSite=None/);
    assert.match(marker.raw, /Max-Age=60(?:;|$)/);
    assert.match(marker.raw, /Path=\/api\/auth\/oidc/);
    assert.ok(!/Domain=/i.test(marker.raw));
    assert.equal(s.proof.expiresAt - s.proof.issuedAt, 60_000);
    const r = await complete(s);
    assert.equal(r.status, 200);
    noCookie(r);
  } finally {
    env.COOKIE_SECURE = oldSecure;
    env.COOKIE_SAMESITE = oldSameSite;
  }
});

test("jar accounting covers legacy pending completed and expired completed without unrelated deletion", async () => {
  const jar = { unrelated: "keep" },
    legacy = await start({ jar });
  await start({ jar, attemptId: crypto.randomUUID() });
  const completed = await session({ jar });
  await start({ jar });
  await start({ jar, attemptId: crypto.randomUUID() });
  const added = await start({ jar });
  assert.ok(
    added.response.cookies.some(
      (c) => c.name === legacy.cookie.name && !c.value,
    ),
  );
  assert.equal(jar.unrelated, "keep");
  const now = Date.now();
  jar[completed.a.cookie.name] = signed(completed, {
    issuedAt: now - 61_000,
    expiresAt: now - 1_000,
  });
  const fresh = await start({ jar });
  assert.ok(
    fresh.response.cookies.some(
      (c) => c.name === completed.a.cookie.name && !c.value,
    ),
  );
  assert.equal(jar.unrelated, "keep");
  assert.equal(jar.refresh_token, completed.cookie);
  assert.equal(
    Object.keys(jar).filter((name) => /^oidc_state_[a-f0-9]{64}$/.test(name))
      .length,
    5,
  );
});

test("new protocol rejects raw over-MAX5 and duplicate credentials instead of selecting a subset", async () => {
  const s = await session(),
    junk = Object.fromEntries(
      Array.from({ length: 5 }, () => [
        `oidc_state_${crypto.randomBytes(32).toString("hex")}`,
        "invalid",
      ]),
    );
  for (const jar of [
    { ...s.a.jar, ...junk },
    { ...junk, ...s.a.jar },
  ]) {
    const r = await unchanged(s, () => complete(s, { cookies: jar }));
    assert.equal(r.status, 409);
    noCookie(r);
  }
  const countBefore = await app.prisma.oidcState.count();
  const denied = await request(
    "GET",
    `/api/auth/oidc/login?client_attempt=${crypto.randomUUID()}&connector_id=${connectorId}`,
    { cookies: { ...s.a.jar, ...junk } },
  );
  failed(denied);
  assert.deepEqual(denied.setCookie, []);
  assert.equal(await app.prisma.oidcState.count(), countBefore);
  for (const cookie of [
    encodedJar(s.a.jar) + `; refresh_token=${encodeURIComponent(s.cookie)}`,
    encodedJar(s.a.jar) +
      `; ${s.a.cookie.name}=${encodeURIComponent(s.marker)}`,
  ]) {
    const r = await complete(s, { headers: { ...trusted, cookie } });
    assert.equal(r.status, 409);
    noCookie(r);
  }
  const four = Object.fromEntries(Object.entries(junk).slice(0, 4));
  const within = await complete(s, { cookies: { ...four, ...s.a.jar } });
  assert.equal(within.status, 200);
  noCookie(within);
});

test("invalid wrong-purpose swapped expired and future markers cannot issue access", async () => {
  const s = await session(),
    now = Date.now();
  const invalid = [
    undefined,
    JSON.stringify(s.proof),
    s.marker.slice(0, -1) + (s.marker.endsWith("a") ? "b" : "a"),
    s.a.cookie.value,
    signed(s, { purpose: "unrelated-purpose" }),
    signed(s, { version: 2 }),
    signed(s, { extra: true }),
    signed(s, { familyId: "bad" }),
    signed(s, { attemptId: 7 }),
    signed(s, { issuedAt: now - 61_000, expiresAt: now - 1_000 }),
    signed(s, { issuedAt: now + 1_000, expiresAt: now + 61_000 }),
    signed(s, { expiresAt: s.proof.expiresAt + 1 }),
  ];
  for (const marker of invalid) {
    const cookies = { ...s.a.jar };
    if (marker === undefined) delete cookies[s.a.cookie.name];
    else cookies[s.a.cookie.name] = marker;
    const r = await unchanged(s, () => complete(s, { cookies }));
    assert.equal(r.status, 409, r.body);
    noCookie(r);
    assert.equal(r.json.data, undefined);
  }
  const name = `oidc_state_${crypto.randomBytes(32).toString("hex")}`,
    swapped = { refresh_token: s.cookie, [name]: s.marker };
  const wrongName = await complete(s, { cookies: swapped });
  assert.equal(wrongName.status, 409);
  noCookie(wrongName);
});

test("completed marker is neither a bearer token nor pending callback binding", async () => {
  const s = await session();
  const bearer = await request("GET", "/api/users/me", {
    headers: { authorization: `Bearer ${s.marker}` },
  });
  assert.equal(bearer.status, 401);
  const pending = await start({ attemptId: crypto.randomUUID() }),
    before = tokenRequests;
  const value = signed(s, {
    state: pending.state.state,
    attemptId: pending.attemptId,
  });
  const r = await callback(pending, issue(pending), {
    cookies: { [pending.cookie.name]: value },
  });
  failed(r);
  assert.deepEqual(r.setCookie, []);
  assert.equal(tokenRequests, before);
  assert.equal(
    await app.prisma.oidcState.count({ where: { state: pending.state.state } }),
    1,
  );
});

test("marker or JWT or API key alone does not replace the current refresh cookie", async () => {
  const s = await session(),
    valid = await complete(s);
  assert.equal(valid.status, 200);
  const created = await request("POST", "/api/api-keys", {
    payload: { name: "Owned completion key" },
    headers: { authorization: `Bearer ${valid.json.data.accessToken}` },
  });
  assert.equal(created.status, 201);
  const cookies = { [s.a.cookie.name]: s.marker };
  for (const token of [
    undefined,
    valid.json.data.accessToken,
    created.json.data.key,
  ]) {
    const r = await unchanged(s, () =>
      complete(s, {
        cookies,
        headers: {
          ...trusted,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
    );
    assert.equal(r.status, 409);
    noCookie(r);
  }
});

test("actual credentialed preflight and strict actual Origin are both enforced", async () => {
  const preflight = await request(
    "OPTIONS",
    "/api/auth/oidc/complete-session",
    {
      headers: {
        origin: process.env.FRONTEND_URL,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,x-werkyn-oidc-completion",
      },
    },
  );
  assert.equal(preflight.status, 204);
  assert.deepEqual(preflight.setCookie, []);
  assert.equal(
    preflight.headers["access-control-allow-origin"],
    process.env.FRONTEND_URL,
  );
  assert.equal(preflight.headers["access-control-allow-credentials"], "true");
  assert.match(
    preflight.headers["access-control-allow-headers"],
    /x-werkyn-oidc-completion/i,
  );
  const foreign = await request("OPTIONS", "/api/auth/oidc/complete-session", {
    headers: {
      origin: "http://foreign.example.test",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-werkyn-oidc-completion",
    },
  });
  assert.equal(foreign.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(foreign.setCookie, []);
  const s = await session();
  for (const origin of [
    undefined,
    "null",
    "http://foreign.example.test",
    process.env.FRONTEND_URL.toUpperCase(),
    [process.env.FRONTEND_URL, process.env.FRONTEND_URL],
  ]) {
    const headers = {
      "x-werkyn-oidc-completion": "1",
      ...(origin === undefined ? {} : { origin }),
    };
    const r = await unchanged(s, () => complete(s, { headers }));
    assert.equal(r.status, 403, r.body);
    noCookie(r);
  }
});

test("header JSON strict body and malformed requests do not mutate cookies or family", async () => {
  const s = await session();
  for (const value of [undefined, "0", "true", ["1", "1"]]) {
    const headers = {
      origin: process.env.FRONTEND_URL,
      ...(value === undefined ? {} : { "x-werkyn-oidc-completion": value }),
    };
    const r = await unchanged(s, () => complete(s, { headers }));
    assert.equal(r.status, 403);
    noCookie(r);
  }
  for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
    const r = await unchanged(s, () =>
      complete(s, { headers: { ...trusted, "content-type": type } }),
    );
    assert.equal(r.status, 415);
    noCookie(r);
  }
  for (const payload of [
    {},
    null,
    [],
    { attemptId: "invalid" },
    { attemptId: 5 },
    { attemptId: s.a.attemptId, extra: true },
  ]) {
    const r = await unchanged(s, () => complete(s, { payload }));
    assert.equal(r.status, 400, r.body);
    noCookie(r);
  }
  const malformed = await unchanged(s, () => complete(s, { rawBody: "{" }));
  assert.equal(malformed.status, 400);
  noCookie(malformed);
  const upper = await complete(s, {
    payload: { attemptId: s.a.attemptId.toUpperCase() },
    headers: { ...trusted, "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(upper.status, 200);
  noCookie(upper);
});

test("expired active token revoked family and deleted account cannot obtain a session", async () => {
  for (const kind of ["expired", "revoked", "deleted"]) {
    const s = await session();
    if (kind === "expired")
      await app.prisma.refreshToken.update({
        where: { id: s.token.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    if (kind === "revoked")
      await app.prisma.refreshTokenFamily.update({
        where: { id: s.token.familyId },
        data: { revokedAt: new Date(), revokedReason: "logout" },
      });
    if (kind === "deleted")
      await app.prisma.user.delete({ where: { id: s.token.userId } });
    const before =
      kind === "deleted" ? null : await familyState(s.token.familyId);
    const r = await complete(s);
    assert.equal(r.status, 409);
    noCookie(r);
    assert.equal(r.json.data, undefined);
    if (before) assert.deepEqual(await familyState(s.token.familyId), before);
    else
      assert.equal(
        await app.prisma.refreshTokenFamily.findUnique({
          where: { id: s.token.familyId },
        }),
        null,
      );
  }
});

test("ambiguous completed markers for one attempt do not elect a family or reach credential lookup", async () => {
  const s = await session(),
    second = await start({ attemptId: s.a.attemptId }),
    done = await succeeded(second);
  const cookies = {
      ...s.a.jar,
      [second.cookie.name]: second.jar[second.cookie.name],
    },
    delegate = app.prisma.refreshToken,
    original = delegate.findFirst;
  let reads = 0;
  delegate.findFirst = async () => {
    reads++;
    throw new Error("Credential lookup must not run");
  };
  try {
    const r = await complete(s, { cookies });
    assert.equal(r.status, 409);
    noCookie(r);
    assert.equal(reads, 0);
  } finally {
    delegate.findFirst = original;
  }
  assert.equal(done.token.family.revokedAt, null);
});

test("valid completion does not wait for its own family row lock or change it", async () => {
  const s = await session(),
    before = await familyState(s.token.familyId);
  const r = await heldFamily(s.token.familyId, (pid, release) =>
    finishesWithoutLock(() => complete(s), pid, release),
  );
  assert.equal(r.status, 200, r.body);
  noCookie(r);
  assert.deepEqual(await familyState(s.token.familyId), before);
});

for (const sameUser of [true, false])
  test(`newer ${sameUser ? "same-account" : "different-account"} family is not locked read as a session or changed`, async () => {
    const identity = {
      sub: `owned-shared-${crypto.randomUUID()}`,
      email: `shared-${crypto.randomUUID()}@${domain}`,
    };
    const a = await session({ identity }),
      b = await session({ identity: sameUser ? identity : undefined });
    const beforeA = await familyState(a.token.familyId),
      beforeB = await familyState(b.token.familyId);
    const delegate = app.prisma.workspaceMember,
      original = delegate.findMany;
    let membershipReads = 0;
    delegate.findMany = async () => {
      membershipReads++;
      throw new Error("Foreign memberships must not be read");
    };
    try {
      const r = await heldFamily(b.token.familyId, (pid, release) =>
        finishesWithoutLock(
          () =>
            complete(a, {
              cookies: { [a.a.cookie.name]: a.marker, refresh_token: b.cookie },
            }),
          pid,
          release,
        ),
      );
      assert.equal(r.status, 409, r.body);
      noCookie(r);
      assert.equal(r.json.data, undefined);
      assert.equal(membershipReads, 0);
    } finally {
      delegate.findMany = original;
    }
    assert.deepEqual(await familyState(a.token.familyId), beforeA);
    assert.deepEqual(await familyState(b.token.familyId), beforeB);
  });

for (const kind of ["marker", "token"])
  test(`${kind} expiry during awaited memberships is checked again before JWT issuance`, async () => {
    const s = await session(),
      deadline = Date.now() + 1_000;
    if (kind === "marker")
      s.a.jar[s.a.cookie.name] = signed(s, {
        issuedAt: deadline - 60_000,
        expiresAt: deadline,
      });
    else
      await app.prisma.refreshToken.update({
        where: { id: s.token.id },
        data: { expiresAt: new Date(deadline) },
      });
    const before = await familyState(s.token.familyId),
      gate = gateMembership(),
      pending = complete(s);
    try {
      await gate.entered();
      await delay(Math.max(0, deadline - Date.now()) + 50);
      gate.release();
      const r = await pending;
      assert.equal(r.status, 409, r.body);
      noCookie(r);
      assert.equal(r.json.data, undefined);
      assert.ok(Date.now() >= deadline);
    } finally {
      gate.restore();
      await pending;
    }
    assert.deepEqual(await familyState(s.token.familyId), before);
  });

test("real HTTP credential and membership read faults preserve proof and permit cookie-safe retry", async () => {
  const s = await session();
  for (const [delegate, method] of [
    [app.prisma.refreshToken, "findFirst"],
    [app.prisma.workspaceMember, "findMany"],
  ]) {
    const original = delegate[method],
      before = await familyState(s.token.familyId);
    delegate[method] = async () => {
      throw new Error("Owned completion read fault");
    };
    try {
      const r = await complete(s);
      assert.equal(r.status, 500);
      noCookie(r);
      assert.equal(r.json.data, undefined);
    } finally {
      delegate[method] = original;
    }
    assert.deepEqual(await familyState(s.token.familyId), before);
    const retry = await complete(s);
    assert.equal(retry.status, 200);
    noCookie(retry);
  }
});

for (const sameUser of [true, false])
  test(`delayed completion cannot overwrite a later ${sameUser ? "same-account" : "different-account"} callback cookie`, async () => {
    const identity = {
      sub: `owned-delayed-${crypto.randomUUID()}`,
      email: `delayed-${crypto.randomUUID()}@${domain}`,
    };
    const jar = {},
      a = await session({ jar, identity }),
      gate = gateMembership(),
      pending = complete(a);
    try {
      await gate.entered();
      const b = await session({
        jar,
        identity: sameUser ? identity : undefined,
      });
      assert.equal(jar.refresh_token, b.cookie);
      const afterB = await familyState(b.token.familyId),
        afterA = await familyState(a.token.familyId);
      gate.release();
      const r = await pending;
      assert.equal(r.status, 200, r.body);
      noCookie(r);
      applyCookies(jar, r);
      assert.equal(jar.refresh_token, b.cookie);
      assert.deepEqual(await familyState(b.token.familyId), afterB);
      assert.deepEqual(await familyState(a.token.familyId), afterA);
      assert.equal(
        jwt.verify(r.json.data.accessToken, process.env.JWT_SECRET).sid,
        a.token.familyId,
      );
    } finally {
      gate.restore();
      await pending;
    }
  });

test("losing concurrent pending callback cannot delete a winner's completed proof", async () => {
  const a = await start({ attemptId: crypto.randomUUID() });
  const pendingJar = { ...a.jar };
  const delegate = app.prisma.oidcState;
  const original = delegate.findUnique;
  const exchangesBefore = tokenRequests;
  let enter,
    release,
    paused = false;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  delegate.findUnique = async (...args) => {
    const row = await original.apply(delegate, args);
    if (!paused && args[0]?.where?.state === a.state.state) {
      paused = true;
      enter();
      await released;
    }
    return row;
  };
  let losing;
  try {
    losing = callback(a, issue(a), { cookies: pendingJar });
    let timer;
    try {
      await Promise.race([
        entered,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Losing callback did not read pending state")),
            3_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const winner = await succeeded(a);
    const marker = a.jar[a.cookie.name];
    const beforeFamily = await familyState(winner.token.familyId);
    release();
    const lost = await losing;
    failed(lost);
    applyCookies(a.jar, lost);
    const completion = await complete({ a });
    const afterFamily = await familyState(winner.token.familyId);
    assert.equal(tokenRequests, exchangesBefore + 1);
    assert.equal(
      await app.prisma.oidcState.count({ where: { state: a.state.state } }),
      0,
    );
    assert.deepEqual(afterFamily, beforeFamily);
    assert.deepEqual(
      lost.setCookie,
      [],
      "An unclaimed callback must not delete the winner's marker",
    );
    assert.equal(a.jar[a.cookie.name], marker);
    assert.equal(completion.status, 200, completion.body);
    noCookie(completion);
  } finally {
    release();
    delegate.findUnique = original;
    await losing;
  }
});

test("missing-code response applied after success cannot delete completed proof", async () => {
  const a = await start({ attemptId: crypto.randomUUID() });
  const exchangesBefore = tokenRequests;
  // Hold the actual HTTP failure response in this fixture's jar applicator.
  // The successful callback's headers are applied first, then the stale failure.
  const incomplete = await request(
    "GET",
    `/api/auth/oidc/callback?state=${a.state.state}`,
    {
      cookies: { ...a.jar },
    },
  );
  failed(incomplete);
  assert.equal(
    await app.prisma.oidcState.count({ where: { state: a.state.state } }),
    1,
  );
  const winner = await succeeded(a);
  const marker = a.jar[a.cookie.name];
  const beforeFamily = await familyState(winner.token.familyId);
  applyCookies(a.jar, incomplete);
  const completion = await complete({ a });
  assert.equal(tokenRequests, exchangesBefore + 1);
  assert.deepEqual(await familyState(winner.token.familyId), beforeFamily);
  assert.deepEqual(
    incomplete.setCookie,
    [],
    "Missing-code response has not claimed state and must not delete proof",
  );
  assert.equal(a.jar[a.cookie.name], marker);
  assert.equal(completion.status, 200, completion.body);
  noCookie(completion);
});

for (const [kind, options] of [
  ["PKCE", { expectedVerifier: "wrong-owned-verifier" }],
  ["nonce", { claims: { nonce: "wrong-owned-nonce" } }],
  ["signature", { wrongSignature: true }],
]) {
  test(`uniquely claimed opt-in ${kind} failure clears only its pending proof without a session`, async () => {
    const a = await start({ attemptId: crypto.randomUUID() });
    const countBefore = await app.prisma.refreshTokenFamily.count();
    const exchangeBefore = tokenRequests;
    const unrelated = {
      name: `unrelated-${crypto.randomUUID()}`,
      value: "keep",
    };
    a.jar[unrelated.name] = unrelated.value;
    const { claims = {}, ...extra } = options;
    const rejection = await callback(a, issue(a, claims, extra));
    failed(rejection);
    assert.equal(tokenRequests, exchangeBefore + 1);
    assert.equal(await app.prisma.refreshTokenFamily.count(), countBefore);
    assert.equal(
      await app.prisma.oidcState.count({ where: { state: a.state.state } }),
      0,
    );
    assert.equal(a.jar[a.cookie.name], undefined);
    assert.equal(a.jar[unrelated.name], unrelated.value);
    assert.equal(rejection.cookies.length, 1);
    assert.equal(rejection.cookies[0].name, a.cookie.name);
    assert.equal(rejection.cookies[0].value, "");
    const completion = await request(
      "POST",
      "/api/auth/oidc/complete-session",
      {
        cookies: { [a.cookie.name]: a.cookie.value },
        payload: { attemptId: a.attemptId },
        headers: trusted,
      },
    );
    assert.equal(completion.status, 409, completion.body);
    noCookie(completion);
  });
}

const headroomRawCount = (jar) =>
  Object.keys(jar).filter((name) => /^oidc_state_[a-f0-9]{64}$/.test(name))
    .length;
const headroomJunk = (count) =>
  Object.fromEntries(
    Array.from({ length: count }, () => [
      `oidc_state_${crypto.randomBytes(32).toString("hex")}`,
      "owned-fixture-unsigned-junk",
    ]),
  );
const headroomPreserved = (jar, entries) => {
  for (const [name, value] of Object.entries(entries))
    assert.equal(jar[name], value, `Unowned cookie must remain: ${name}`);
};

test("four unowned raw slots leave one opt-in slot and permit completion", async () => {
  const invalid = headroomJunk(4),
    jar = { ...invalid };
  const a = await start({ jar, attemptId: crypto.randomUUID() });
  assert.equal(headroomRawCount(jar), 5);
  assert.equal(a.response.cookies.filter((cookie) => !cookie.value).length, 0);
  headroomPreserved(jar, invalid);
  await succeeded(a);
  const response = await complete({ a });
  assert.equal(response.status, 200, response.body);
  noCookie(response);
  headroomPreserved(jar, invalid);
});

test("five unowned raw slots reject opt-in before state or cookie mutation", async () => {
  const invalid = headroomJunk(5);
  const jar = {
    ...invalid,
    unrelated_headroom: "keep",
    oidc_state_bad_name: "keep",
  };
  const beforeState = await app.prisma.oidcState.count();
  const beforeExchanges = tokenRequests;
  const response = await request(
    "GET",
    `/api/auth/oidc/login?connector_id=${connectorId}&client_attempt=${crypto.randomUUID()}`,
    { cookies: jar },
  );
  failed(response);
  assert.deepEqual(response.setCookie, []);
  assert.equal(await app.prisma.oidcState.count(), beforeState);
  assert.equal(tokenRequests, beforeExchanges);
  applyCookies(jar, response);
  headroomPreserved(jar, invalid);
  assert.equal(headroomRawCount(jar), 5);
  assert.equal(jar.unrelated_headroom, "keep");
  assert.equal(jar.oidc_state_bad_name, "keep");
});

for (let ownedCount = 1; ownedCount <= 5; ownedCount++) {
  test(`opt-in reserves its new slot with ${ownedCount} owned and ${5 - ownedCount} unowned raw cookies`, async () => {
    const jar = {},
      owned = [];
    for (let i = 0; i < ownedCount; i++) {
      const a = await start({
        jar,
        ...(i === 2 ? {} : { attemptId: crypto.randomUUID() }),
      });
      if (i === 0) await succeeded(a);
      owned.push(a.cookie.name);
    }
    const invalid = headroomJunk(5 - ownedCount);
    Object.assign(jar, invalid, {
      unrelated_headroom: "keep",
      oidc_state_bad_name: "keep",
    });
    assert.equal(headroomRawCount(jar), 5);
    const beforeState = await app.prisma.oidcState.count();
    const a = await start({ jar, attemptId: crypto.randomUUID() });
    assert.equal(headroomRawCount(jar), 5);
    assert.equal(jar[owned[0]], undefined);
    for (const name of owned.slice(1)) assert.ok(jar[name]);
    headroomPreserved(jar, invalid);
    assert.equal(jar.unrelated_headroom, "keep");
    assert.equal(jar.oidc_state_bad_name, "keep");
    assert.equal(await app.prisma.oidcState.count(), beforeState + 1);
    assert.deepEqual(
      a.response.cookies
        .filter((cookie) => !cookie.value)
        .map((cookie) => cookie.name),
      [owned[0]],
    );
    assert.equal(a.response.cookies.filter((cookie) => cookie.value).length, 1);
    const winner = await succeeded(a);
    const beforeFamily = await familyState(winner.token.familyId);
    const response = await complete({ a });
    assert.equal(response.status, 200, response.body);
    noCookie(response);
    assert.equal(
      jwt.verify(response.json.data.accessToken, process.env.JWT_SECRET).sid,
      winner.token.familyId,
    );
    assert.deepEqual(await familyState(winner.token.familyId), beforeFamily);
    assert.equal(headroomRawCount(jar), 5);
    headroomPreserved(jar, invalid);
  });
}

test("owned expired completed slot supplies headroom without deleting a live pending slot", async () => {
  const jar = {},
    s = await session({ jar });
  const pending = await start({ jar, attemptId: crypto.randomUUID() });
  const now = Date.now();
  jar[s.a.cookie.name] = signed(s, {
    issuedAt: now - 61_000,
    expiresAt: now - 1_000,
  });
  const invalid = headroomJunk(3);
  Object.assign(jar, invalid);
  assert.equal(headroomRawCount(jar), 5);
  const pendingValue = jar[pending.cookie.name];
  const a = await start({ jar, attemptId: crypto.randomUUID() });
  assert.equal(jar[s.a.cookie.name], undefined);
  assert.equal(jar[pending.cookie.name], pendingValue);
  assert.deepEqual(
    a.response.cookies
      .filter((cookie) => !cookie.value)
      .map((cookie) => cookie.name),
    [s.a.cookie.name],
  );
  assert.equal(headroomRawCount(jar), 5);
  headroomPreserved(jar, invalid);
  await succeeded(a);
  const response = await complete({ a });
  assert.equal(response.status, 200, response.body);
  noCookie(response);
  headroomPreserved(jar, invalid);
});
