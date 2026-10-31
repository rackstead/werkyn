import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Real HTTP, PostgreSQL family locks, and local WebSocket clients. This server
// prerequisite does not implement persistent browser logout intent or SSO ordering.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Owned TEST_DATABASE_URL required");
const applicationUrl = new URL(process.env.TEST_DATABASE_URL);
applicationUrl.searchParams.set("connection_limit", "5");
Object.assign(process.env, {
  DATABASE_URL: applicationUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "pending-logout-owned-local-signing-key-20261031",
  COOKIE_SECRET: "pending-logout-owned-cookie-key-20261031",
  FRONTEND_URL: "http://localhost:5173",
  CORS_ORIGIN: "http://localhost:5173,http://secondary.example.test",
  COOKIE_SECURE: "false",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-logout-recovery-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { hashToken } = await import("../../src/utils/tokens.js");
const { hashPassword } = await import("../../src/utils/passwords.js");
const { startRefreshSession } =
  await import("../../src/modules/auth/refresh-sessions.js");
const domain = `pending-logout-${crypto.randomBytes(5).toString("hex")}.example.test`;
const password = "Owned-fixture-Password-123";
const families = new Set();
let app,
  origin,
  passwordHash,
  users = 0,
  requests = 0;
before(async () => {
  assert.equal(
    new URL(process.env.DATABASE_URL).searchParams.get("connection_limit"),
    "5",
  );
  await Promise.all([control.$connect(), observer.$connect()]);
  app = await buildApp();
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  passwordHash = await hashPassword(password);
});
after(async () => {
  try {
    for (const socket of sockets) socket.destroy();
    await Promise.all([control.$disconnect(), observer.$disconnect()]);
    await app?.prisma.rotatedRefreshToken.deleteMany({
      where: { familyId: { in: [...families] } },
    });
    await app?.prisma.user.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
    await app?.prisma.loginAttempt.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});
function request(
  method,
  pathname,
  { token, cookie, payload, rawBody, headers = {} } = {},
) {
  const n = ++requests;
  const body =
    rawBody ?? (payload === undefined ? undefined : JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(pathname, origin),
      {
        method,
        localAddress: `127.57.${(n >> 8) & 255}.${n & 255}`,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}),
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (c) => {
          text += c;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: text,
            json: text ? JSON.parse(text) : null,
            headers: response.headers,
            setCookie: response.headers["set-cookie"] ?? [],
            cookie: /refresh_token=([^;]+)/.exec(
              response.headers["set-cookie"]?.join(";") ?? "",
            )?.[1],
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () =>
      req.destroy(new Error("Owned HTTP fixture timeout")),
    );
    req.end(body);
  });
}
async function user() {
  return app.prisma.user.create({
    data: {
      email: `user-${++users}@${domain}`,
      displayName: "Owned pending logout fixture",
      passwordHash,
      emailVerified: true,
    },
  });
}
function sid(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    .sid;
}
async function login(person) {
  const r = await request("POST", "/api/auth/login", {
    payload: { email: person.email, password },
  });
  assert.equal(r.status, 200, r.body);
  const s = {
    token: r.json.data.accessToken,
    cookie: r.cookie,
    sid: sid(r.json.data.accessToken),
  };
  assert.ok(s.cookie);
  families.add(s.sid);
  return s;
}
async function record(id) {
  return app.prisma.refreshTokenFamily.findUniqueOrThrow({
    where: { id },
    select: { revokedAt: true },
  });
}

const { PrismaClient } = await import("@prisma/client");
const { refreshLockLimits } =
  await import("../../src/modules/auth/refresh-sessions.js");
const { openRawSocket } = await import("./support/raw-websocket.mjs");
const controlUrl = new URL(process.env.TEST_DATABASE_URL);
controlUrl.searchParams.set("connection_limit", "1");
const control = new PrismaClient({ datasourceUrl: controlUrl.toString() });
// The holder and observer have separate single-connection pools. Observation
// cannot queue behind either blocked HTTP actor in the application pool.
const observer = new PrismaClient({ datasourceUrl: controlUrl.toString() });
const sockets = new Set();
const trusted = {
  origin: "http://localhost:5173",
  "x-werkyn-session-recovery": "1",
};
const recover = (sessionId, cookie, extra = {}) =>
  request("POST", "/api/auth/logout/recover", {
    cookie,
    payload: { sessionId },
    headers: trusted,
    ...extra,
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function state(id) {
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
async function secondSession(person) {
  const raw = await startRefreshSession(app.prisma, person.id);
  families.add(raw.familyId);
  const r = await request("POST", "/api/auth/refresh", {
    cookie: raw.refreshToken,
  });
  assert.equal(r.status, 200, r.body);
  return {
    token: r.json.data.accessToken,
    cookie: r.cookie,
    sid: sid(r.json.data.accessToken),
  };
}
async function heldFamily(id, run) {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const released = new Promise((resolve) => {
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
        throw new Error("Holder ended before entry");
      }),
    ]);
    return await run(pid, release);
  } finally {
    release();
    await held;
  }
}
async function waiterCount(holderPid) {
  const [{ n }] = await observer.$queryRaw`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> ${holderPid}
      AND wait_event_type = 'Lock' AND query LIKE '%RefreshTokenFamily%'
  `;
  return n;
}
async function waiters(n, pid) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await waiterCount(pid)) === n) return;
    await delay(10);
  }
  throw new Error(`Did not observe ${n} actual family-lock waiters`);
}
async function mustNotWait(run, pid, release) {
  let done = false;
  const pending = run().finally(() => {
    done = true;
  });
  const observer = (async () => {
    const deadline = Date.now() + 3_000;
    while (!done) {
      assert.equal(
        await waiterCount(pid),
        0,
        "A newer family must not be locked",
      );
      assert.ok(
        Date.now() < deadline,
        "Recovery must finish while the newer family is locked",
      );
      await delay(10);
    }
  })();
  try {
    const result = await Promise.race([pending, observer.then(() => pending)]);
    await observer;
    return result;
  } finally {
    if (!done) release();
    await pending;
  }
}
async function socket(session) {
  const n = ++requests;
  const client = await openRawSocket(new URL(origin).port, {
    localAddress: `127.57.${(n >> 8) & 255}.${n & 255}`,
  });
  sockets.add(client.socket);
  client.sendJSON({ type: "auth", token: session.token });
  await client.next((frame) => frame.event === "authenticated");
  return {
    closed: () => client.closed(3_000),
    async ping() {
      client.sendJSON({ type: "ping" });
      await client.next((frame) => frame.event === "pong", 3_000);
    },
  };
}
function noCookie(r) {
  assert.deepEqual(r.setCookie, [], r.body);
  assert.equal(r.headers["cache-control"], "no-store");
}

test("matching owned session has cookie-safe conditional logout recovery", async () => {
  const person = await user(),
    session = await login(person);
  const r = await request("POST", "/api/auth/logout/recover", {
    cookie: session.cookie,
    payload: { sessionId: session.sid },
    headers: {
      origin: "http://localhost:5173",
      "x-werkyn-session-recovery": "1",
    },
  });
  const family = await record(session.sid);
  assert.equal(r.status, 200, r.body);
  assert.equal(r.setCookie.length, 0);
  assert.equal(r.json.data.status, "revoked");
  assert.ok(family.revokedAt);
});
test("ordinary logout retains current-cookie revocation and clearing", async () => {
  const person = await user(),
    session = await login(person);
  const r = await request("POST", "/api/auth/logout", {
    token: session.token,
    cookie: session.cookie,
  });
  const family = await record(session.sid);
  assert.equal(r.status, 204, r.body);
  assert.ok(r.setCookie.some((x) => x.startsWith("refresh_token=;")));
  assert.ok(family.revokedAt);
});
test("ordinary refresh keeps its family and rotates the cookie", async () => {
  const person = await user(),
    session = await login(person);
  const r = await request("POST", "/api/auth/refresh", {
    cookie: session.cookie,
  });
  assert.equal(r.status, 200, r.body);
  assert.equal(sid(r.json.data.accessToken), session.sid);
  assert.ok(r.cookie);
  assert.notEqual(r.cookie, session.cookie);
  assert.equal((await record(session.sid)).revokedAt, null);
});
test("ordinary logout remains cookie-centric when a different live header session exists", async () => {
  const person = await user(),
    first = await login(person);
  const secondRaw = await startRefreshSession(app.prisma, person.id);
  families.add(secondRaw.familyId);
  const r = await request("POST", "/api/auth/logout", {
    token: first.token,
    cookie: secondRaw.refreshToken,
  });
  const a = await record(first.sid),
    b = await record(secondRaw.familyId);
  assert.equal(r.status, 204, r.body);
  assert.equal(a.revokedAt, null);
  assert.ok(b.revokedAt);
  assert.ok(r.setCookie.length);
});

test("actual CORS preflight permits configured origins and the recovery header", async () => {
  for (const origin of [
    "http://localhost:5173",
    "http://secondary.example.test",
  ]) {
    const r = await request("OPTIONS", "/api/auth/logout/recover", {
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers":
          "content-type,x-werkyn-session-recovery",
      },
    });
    assert.equal(r.status, 204, r.body);
    assert.deepEqual(r.setCookie, []);
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.match(
      r.headers["access-control-allow-headers"],
      /x-werkyn-session-recovery/i,
    );
    assert.match(r.headers["access-control-allow-headers"], /content-type/i);
  }
  const denied = await request("OPTIONS", "/api/auth/logout/recover", {
    headers: {
      origin: "http://foreign.example.test",
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "content-type,x-werkyn-session-recovery",
    },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(denied.setCookie, []);
  const s = await login(await user());
  const r = await recover(s.sid.toUpperCase(), s.cookie, {
    headers: {
      ...trusted,
      origin: "http://secondary.example.test",
      "content-type": "application/json; charset=utf-8",
    },
  });
  assert.equal(r.status, 200, r.body);
  noCookie(r);
  assert.equal(r.json.data.status, "revoked");
});

test("Origin denial preserves family state even with a valid access token", async () => {
  const s = await login(await user()),
    original = await state(s.sid);
  for (const origin of [
    undefined,
    "null",
    "http://foreign.example.test",
    "http://LOCALHOST:5173",
    ["http://localhost:5173", "http://foreign.example.test"],
  ]) {
    const headers = {
      "x-werkyn-session-recovery": "1",
      ...(origin === undefined ? {} : { origin }),
    };
    const r = await recover(s.sid, s.cookie, { token: s.token, headers });
    assert.equal(r.status, 403, r.body);
    noCookie(r);
    assert.deepEqual(await state(s.sid), original);
  }
});

test("missing, incorrect, and duplicate recovery headers cannot revoke", async () => {
  const s = await login(await user()),
    original = await state(s.sid);
  for (const value of [undefined, "0", "true", ["1", "1"]]) {
    const headers = {
      origin: trusted.origin,
      ...(value === undefined ? {} : { "x-werkyn-session-recovery": value }),
    };
    const r = await recover(s.sid, s.cookie, { headers });
    assert.equal(r.status, 403, r.body);
    noCookie(r);
    assert.deepEqual(await state(s.sid), original);
  }
});

test("non-JSON, malformed JSON, and invalid strict UUID bodies do not mutate", async () => {
  const s = await login(await user()),
    original = await state(s.sid);
  for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
    const r = await recover(s.sid, s.cookie, {
      headers: { ...trusted, "content-type": type },
    });
    assert.equal(r.status, 415, r.body);
    noCookie(r);
  }
  for (const payload of [
    {},
    null,
    { sessionId: 12 },
    { sessionId: "not-a-uuid" },
    { sessionId: s.sid, extra: true },
    [],
  ]) {
    const r = await recover(s.sid, s.cookie, { payload });
    assert.equal(r.status, 400, r.body);
    noCookie(r);
  }
  const malformed = await recover(s.sid, s.cookie, { rawBody: "{" });
  assert.equal(malformed.status, 400, malformed.body);
  noCookie(malformed);
  assert.deepEqual(await state(s.sid), original);
});

test("missing or unknown cookies are unknown; JWT and API keys do not replace proof", async () => {
  const s = await login(await user()),
    original = await state(s.sid);
  const created = await request("POST", "/api/api-keys", {
    token: s.token,
    payload: { name: "Owned recovery proof" },
  });
  assert.equal(created.status, 201, created.body);
  const key = created.json.data.key;
  assert.ok(key);
  for (const extra of [
    {},
    { cookie: "unknown-owned-fixture" },
    { token: s.token },
    { token: key },
  ]) {
    const r = await recover(s.sid, undefined, extra);
    assert.equal(r.status, 200, r.body);
    noCookie(r);
    assert.deepEqual(r.json, { data: { status: "absent" } });
    assert.deepEqual(await state(s.sid), original);
  }
});

for (const sameUser of [true, false])
  test(`newer ${sameUser ? "same-account" : "different-account"} cookie is neither locked nor changed`, async () => {
    const person = await user(),
      a = await login(person),
      b = await secondSession(sameUser ? person : await user());
    const aBefore = await state(a.sid),
      bBefore = await state(b.sid);
    const r = await heldFamily(b.sid, (pid, release) =>
      mustNotWait(() => recover(a.sid, b.cookie), pid, release),
    );
    assert.equal(r.status, 200, r.body);
    noCookie(r);
    assert.deepEqual(r.json, { data: { status: "superseded" } });
    assert.deepEqual(await state(a.sid), aBefore);
    assert.deepEqual(await state(b.sid), bBefore);
  });

test("a real revocation rollback leaves the cookie, family, and socket usable for retry", async () => {
  const s = await login(await user()),
    peer = await socket(s),
    original = await state(s.sid);
  const suffix = crypto.randomBytes(5).toString("hex"),
    name = `pending_logout_${suffix}`,
    sequence = `${name}_seq`;
  let installed = false;
  try {
    await control.$executeRawUnsafe(`CREATE SEQUENCE ${sequence}`);
    await control.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id = '${s.sid}' THEN PERFORM nextval('${sequence}'); RAISE EXCEPTION 'Owned recovery rollback fixture'; END IF; RETURN NEW; END $$`);
    await control.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE UPDATE ON "RefreshTokenFamily" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    installed = true;
    const r = await recover(s.sid, s.cookie);
    assert.equal(r.status, 500, r.body);
    noCookie(r);
    assert.deepEqual(await state(s.sid), original);
    const [{ is_called }] = await control.$queryRawUnsafe(
      `SELECT is_called FROM ${sequence}`,
    );
    assert.equal(
      is_called,
      true,
      "Nontransactional sequence proves the rollback fixture was reached",
    );
    await peer.ping();
  } finally {
    if (installed)
      await control.$executeRawUnsafe(
        `DROP TRIGGER ${name} ON "RefreshTokenFamily"`,
      );
    await control.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    await control.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS ${sequence}`);
  }
  const retry = await recover(s.sid, s.cookie);
  assert.equal(retry.status, 200, retry.body);
  noCookie(retry);
  assert.equal(retry.json.data.status, "revoked");
  const closed = await peer.closed();
  assert.equal(closed.code, 4005);
});

test("bounded lock contention returns cookie-safe 503 and allows retry after release", async () => {
  const s = await login(await user()),
    original = await state(s.sid),
    previous = refreshLockLimits.lockTimeoutMs;
  try {
    // Exercise the existing timeout classification without spending eight seconds per fixture.
    refreshLockLimits.lockTimeoutMs = 250;
    await heldFamily(s.sid, async (pid, release) => {
      const pending = recover(s.sid, s.cookie);
      try {
        await waiters(1, pid);
        const r = await pending;
        assert.equal(r.status, 503, r.body);
        noCookie(r);
        assert.deepEqual(await state(s.sid), original);
      } finally {
        release();
        await pending;
      }
    });
  } finally {
    refreshLockLimits.lockTimeoutMs = previous;
  }
  const retry = await recover(s.sid, s.cookie);
  assert.equal(retry.status, 200, retry.body);
  noCookie(retry);
  assert.equal(retry.json.data.status, "revoked");
});

test("recovery queued behind rotation revokes its committed successor", async () => {
  const s = await login(await user());
  await heldFamily(s.sid, async (pid, release) => {
    let recovery;
    const rotation = request("POST", "/api/auth/refresh", { cookie: s.cookie });
    try {
      await waiters(1, pid);
      recovery = recover(s.sid, s.cookie);
      await waiters(2, pid);
      release();
      const [r, ended] = await Promise.all([rotation, recovery]);
      assert.equal(r.status, 200, r.body);
      assert.ok(r.cookie);
      assert.equal(sid(r.json.data.accessToken), s.sid);
      assert.equal(ended.status, 200, ended.body);
      noCookie(ended);
      assert.equal(ended.json.data.status, "revoked");
    } finally {
      release();
      await Promise.allSettled([rotation, recovery]);
    }
  });
  const final = await state(s.sid);
  assert.ok(final.family.revokedAt);
  assert.equal(final.tokens.length, 0);
});

test("rotation queued behind recovery cannot mint a successor", async () => {
  const s = await login(await user());
  await heldFamily(s.sid, async (pid, release) => {
    let rotation;
    const recovery = recover(s.sid, s.cookie);
    try {
      await waiters(1, pid);
      rotation = request("POST", "/api/auth/refresh", { cookie: s.cookie });
      await waiters(2, pid);
      release();
      const [ended, r] = await Promise.all([recovery, rotation]);
      assert.equal(ended.status, 200, ended.body);
      noCookie(ended);
      assert.equal(ended.json.data.status, "revoked");
      assert.equal(r.status, 401, r.body);
    } finally {
      release();
      await Promise.allSettled([recovery, rotation]);
    }
  });
  const final = await state(s.sid);
  assert.ok(final.family.revokedAt);
  assert.equal(final.tokens.length, 0);
});

test("committed recovery closes only its local family sockets and preserves API keys", async () => {
  const person = await user(),
    a = await login(person),
    b = await secondSession(person);
  const created = await request("POST", "/api/api-keys", {
    token: a.token,
    payload: { name: "Owned independent key" },
  });
  assert.equal(created.status, 201, created.body);
  const oldPeer = await socket(a),
    newerPeer = await socket(b);
  const r = await recover(a.sid, a.cookie);
  assert.equal(r.status, 200, r.body);
  noCookie(r);
  assert.equal(r.json.data.status, "revoked");
  const closed = await oldPeer.closed();
  assert.equal(closed.code, 4005);
  await newerPeer.ping();
  const keyUse = await request("GET", "/api/users/me", {
    token: created.json.data.key,
  });
  assert.equal(keyUse.status, 200, keyUse.body);
  assert.equal(keyUse.json.data.id, person.id);
  assert.equal((await record(b.sid)).revokedAt, null);
});

test("retained rotated proof revokes its successor outside refresh grace and repeats safely", async () => {
  const s = await login(await user());
  const rotation = await request("POST", "/api/auth/refresh", {
    cookie: s.cookie,
  });
  assert.equal(rotation.status, 200, rotation.body);
  assert.ok(rotation.cookie);
  await app.prisma.rotatedRefreshToken.update({
    where: { tokenHash: hashToken(s.cookie) },
    data: { rotatedAt: new Date(Date.now() - 90_000) },
  });
  const r = await recover(s.sid, s.cookie);
  assert.equal(r.status, 200, r.body);
  noCookie(r);
  assert.deepEqual(r.json, { data: { status: "revoked" } });
  const ended = await state(s.sid);
  assert.ok(ended.family.revokedAt);
  assert.equal(ended.family.revokedReason, "logout");
  assert.equal(ended.tokens.length, 0);
  const repeated = await recover(s.sid, s.cookie);
  assert.equal(repeated.status, 200, repeated.body);
  noCookie(repeated);
  assert.equal(repeated.json.data.status, "revoked");
  assert.deepEqual(await state(s.sid), ended);
});
test("retained proof with erased family returns absent without claiming revocation", async () => {
  const raw = crypto.randomBytes(32).toString("hex"),
    familyId = crypto.randomUUID();
  families.add(familyId);
  await app.prisma.rotatedRefreshToken.create({
    data: { tokenHash: hashToken(raw), familyId },
  });
  const r = await recover(familyId, raw);
  assert.equal(r.status, 200, r.body);
  noCookie(r);
  assert.deepEqual(r.json, { data: { status: "absent" } });
  assert.equal(
    await app.prisma.refreshTokenFamily.findUnique({ where: { id: familyId } }),
    null,
  );
});
