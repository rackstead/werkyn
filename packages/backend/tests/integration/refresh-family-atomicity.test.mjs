import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
// At most two application transactions wait on PostgreSQL locks at once, so
// the application pool defaults to five connections and accepts any explicit
// connection_limit of four or more. The lock holder and pg_stat_activity
// observer use a separate two-connection pool so blocked actors can never
// starve the control that must release them.
const DEFAULT_ACTOR_CONNECTIONS = 5;
const MINIMUM_ACTOR_CONNECTIONS = 4;
const actorDatabaseUrl = new URL(process.env.TEST_DATABASE_URL);
const requestedActorLimit =
  actorDatabaseUrl.searchParams.get("connection_limit");
const actorConnections =
  requestedActorLimit === null
    ? DEFAULT_ACTOR_CONNECTIONS
    : Number(requestedActorLimit);
assert(
  actorConnections >= MINIMUM_ACTOR_CONNECTIONS,
  `Refresh family fixture requires connection_limit>=${MINIMUM_ACTOR_CONNECTIONS}`,
);
actorDatabaseUrl.searchParams.set("connection_limit", String(actorConnections));
const controlDatabaseUrl = new URL(actorDatabaseUrl);
controlDatabaseUrl.searchParams.set("connection_limit", "2");
process.env.DATABASE_URL = actorDatabaseUrl.toString();
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "refresh-family-integration-jwt-secret";
process.env.COOKIE_SECRET = "refresh-family-integration-cookie-secret";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { hashToken } = await import("../../src/utils/tokens.ts");
const { hashPassword } = await import("../../src/utils/passwords.ts");
const authService = await import("../../src/modules/auth/auth.service.ts");
const { refreshLockLimits, refreshTransactionOptions } =
  await import("../../src/modules/auth/refresh-sessions.ts");

// Policy under test: a rotated token presented within this window of its
// rotation is a benign concurrent use (another tab sharing the same cookie):
// it mints nothing and revokes nothing. Later presentation is reuse and
// revokes the whole family.
const GRACE_MS = 30_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const suffix = crypto.randomBytes(5).toString("hex");
const domain = `refresh-${suffix}.example.test`;
const password = "Fixture-password-123";
const newPassword = "Changed-password-456";
const barrierFn = `refresh_barrier_${suffix}`;
const barrierKey = crypto.randomInt(1, 2 ** 31 - 1);
let app, control, passwordHash;
let counter = 0;
let address = 0;
let holderPid = null;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlDatabaseUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  passwordHash = await hashPassword(password);
});

after(async () => {
  try {
    for (const table of ["RefreshToken", "RefreshTokenFamily"])
      await control.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${barrierFn} ON "${table}"`,
      );
    await control.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS ${barrierFn}() CASCADE`,
    );
    await app.prisma.user.deleteMany({
      where: { email: { endsWith: `@${domain}` } },
    });
  } finally {
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
});

// ─── Fixtures ──────────────────────────────────────────────

function inject(options) {
  address += 1;
  return app.inject({
    ...options,
    remoteAddress: `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
  });
}

function makeUser() {
  return app.prisma.user.create({
    data: {
      email: `user-${++counter}@${domain}`,
      displayName: `Refresh fixture ${counter}`,
      emailVerified: true,
      passwordHash,
    },
  });
}

function cookieOf(response) {
  return response.cookies.find((c) => c.name === "refresh_token" && c.value)
    ?.value;
}

function loginRequest(user) {
  return inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password },
  });
}

async function signIn(user) {
  const response = await loginRequest(user);
  assert.equal(response.statusCode, 200, response.body);
  const refresh = cookieOf(response);
  assert(refresh);
  return { refresh, access: response.json().data.accessToken };
}

function refresh(raw) {
  return inject({
    method: "POST",
    url: "/api/auth/refresh",
    cookies: { refresh_token: raw },
  });
}

async function rotate(raw) {
  const response = await refresh(raw);
  assert.equal(response.statusCode, 200, response.body);
  const next = cookieOf(response);
  assert(next);
  return next;
}

function logout(raw, access) {
  return inject({
    method: "POST",
    url: "/api/auth/logout",
    cookies: { refresh_token: raw },
    headers: { authorization: `Bearer ${access}` },
  });
}

function changePassword(user, access) {
  return inject({
    method: "PATCH",
    url: `/api/users/${user.id}/password`,
    headers: { authorization: `Bearer ${access}` },
    payload: { currentPassword: password, newPassword },
  });
}

async function resetPassword(user) {
  const token = crypto.randomBytes(32).toString("hex");
  await app.prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return () =>
    inject({
      method: "POST",
      url: `/api/auth/reset-password/${token}`,
      payload: { password: newPassword },
    });
}

async function familyOf(raw) {
  const hash = hashToken(raw);
  const [row] = await control.$queryRaw`
    SELECT "familyId" FROM "RefreshToken" WHERE token = ${hash}
    UNION ALL
    SELECT "familyId" FROM "RotatedRefreshToken" WHERE "tokenHash" = ${hash}
    LIMIT 1
  `;
  assert(row, "fixture token has a family");
  return row.familyId;
}

async function activeTokens(familyId) {
  const rows = await control.$queryRaw`
    SELECT token FROM "RefreshToken" WHERE "familyId" = ${familyId}
    ORDER BY token
  `;
  return rows.map((row) => row.token);
}

function userTokenCount(user) {
  return control.refreshToken.count({ where: { userId: user.id } });
}

async function familyRecord(familyId) {
  const [row] = await control.$queryRaw`
    SELECT "userId", "revokedAt", "revokedReason"
    FROM "RefreshTokenFamily" WHERE id = ${familyId}
  `;
  return row;
}

async function ageRotation(raw, ageMs) {
  const updated = await control.$executeRaw`
    UPDATE "RotatedRefreshToken"
    SET "rotatedAt" = now() - make_interval(secs => ${ageMs / 1000}::float8)
    WHERE "tokenHash" = ${hashToken(raw)}
  `;
  assert.equal(updated, 1);
}

async function expireAt(raw, offsetMs) {
  const updated = await control.$executeRaw`
    UPDATE "RefreshToken"
    SET "expiresAt" = now() + make_interval(secs => ${offsetMs / 1000}::float8)
    WHERE token = ${hashToken(raw)}
  `;
  assert.equal(updated, 1);
}

// ─── Real PostgreSQL lock barriers ─────────────────────────

async function lockWaiterCount() {
  const [row] = await control.$queryRaw`
    SELECT count(*)::int AS total
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
      AND pid IS DISTINCT FROM ${holderPid}::int
  `;
  return row.total;
}

async function waitForLockWaiters(expected) {
  const deadline = performance.now() + 5000;
  let observed = 0;
  while (performance.now() < deadline) {
    observed = await lockWaiterCount();
    if (observed >= expected) return observed;
    await sleep(10);
  }
  assert.fail(
    `Expected ${expected} real PostgreSQL lock waiters, observed ${observed}`,
  );
}

// Resolves "settled" when the actor finished without blocking, or "waiting"
// once PostgreSQL reports the expected number of lock waiters.
async function settlesOrWaits(pending, expectedWaiters) {
  let settled = false;
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (settled) return "settled";
    if ((await lockWaiterCount()) >= expectedWaiters) return "waiting";
    await sleep(10);
  }
  assert.fail("Actor neither finished nor waited on a PostgreSQL lock");
}

// The control transaction takes a real lock, starts actors, lets the body
// observe them in PostgreSQL, then commits. Cleanup always releases the holder
// and awaits every actor before the caller inspects state.
async function withControlLock(lock, body) {
  let unlock, locked;
  const unlocked = new Promise((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise((resolve) => {
    locked = resolve;
  });
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await lock(tx);
      locked();
      await unlocked;
    },
    { timeout: 15_000, maxWait: 2_000 },
  );
  const running = [];
  const start = (actor) => {
    const pending = Promise.resolve().then(actor);
    running.push(pending);
    return pending;
  };
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    await body(start);
  } finally {
    unlock();
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

// Any rotation must change the presented token's row, so a row lock on it
// pauses every implementation after it has read the token as active.
function familyRowLock(familyId) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "RefreshTokenFamily" WHERE id = ${familyId} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

function tokenRowLock(raw) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "RefreshToken" WHERE token = ${hashToken(raw)} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

// Pauses the INSERT of any new token of one family (or one user) immediately
// before it happens, in whichever transaction the application performs it.
async function withTokenInsertBarrier(column, value, body) {
  assert(["familyId", "userId"].includes(column));
  assert.match(value, /^[A-Za-z0-9-]+$/);
  await control.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${barrierFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${barrierKey}); RETURN NEW; END $$`,
  );
  await control.$executeRawUnsafe(
    `CREATE TRIGGER ${barrierFn} BEFORE INSERT ON "RefreshToken" FOR EACH ROW WHEN (NEW."${column}" = '${value}') EXECUTE FUNCTION ${barrierFn}()`,
  );
  try {
    return await withControlLock(
      (tx) =>
        tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${barrierKey})`),
      body,
    );
  } finally {
    await control.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${barrierFn} ON "RefreshToken"`,
    );
  }
}

function describe(...responses) {
  return responses.map((r) => `${r.statusCode} ${r.body}`).join(" | ");
}

// A successor handed to a client before its family was revoked must not work.
async function assertUnusable(response) {
  if (response.statusCode !== 200) return;
  const successor = cookieOf(response);
  assert(successor);
  const replay = await refresh(successor);
  assert.equal(replay.statusCode, 401, replay.body);
}

// ─── Concurrent use of one cookie ──────────────────────────

test("two concurrent refreshes of one cookie mint exactly one successor and keep the session", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const responses = await withControlLock(
    tokenRowLock(session.refresh),
    async (start) => {
      start(() => refresh(session.refresh));
      start(() => refresh(session.refresh));
      await waitForLockWaiters(2);
    },
  );
  assert.deepEqual(
    responses.map((r) => r.statusCode).sort(),
    [200, 409],
    describe(...responses),
  );
  const winner = responses.find((r) => r.statusCode === 200);
  const loser = responses.find((r) => r.statusCode === 409);
  assert.equal(cookieOf(loser), undefined, "a superseded use mints nothing");
  assert.match(loser.json().message, /already been refreshed/i);
  const successor = cookieOf(winner);
  assert.deepEqual(await activeTokens(familyId), [hashToken(successor)]);
  // The browser retries with the shared cookie jar's successor.
  await rotate(successor);
  assert.equal((await activeTokens(familyId)).length, 1);
  assert.equal((await familyRecord(familyId)).revokedAt, null);
});

test("a burst of concurrent refreshes never fails with a server error or forks the family", async () => {
  for (let round = 0; round < 3; round++) {
    const user = await makeUser();
    const session = await signIn(user);
    const familyId = await familyOf(session.refresh);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => refresh(session.refresh)),
    );
    const statuses = responses.map((r) => r.statusCode).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409], describe(...responses));
    const successor = cookieOf(responses.find((r) => r.statusCode === 200));
    assert.deepEqual(await activeTokens(familyId), [hashToken(successor)]);
  }
});

// ─── Reuse detection ───────────────────────────────────────

test("reuse of a rotated token revokes the family, including a successor being minted concurrently", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const second = await rotate(session.refresh);
  const familyId = await familyOf(second);
  await ageRotation(session.refresh, GRACE_MS + 60_000);
  let replayOrder;
  const [legitimate, replay] = await withTokenInsertBarrier(
    "familyId",
    familyId,
    async (start) => {
      start(() => refresh(second));
      // The legitimate rotation is paused immediately before its INSERT.
      await waitForLockWaiters(1);
      const replayed = start(() => refresh(session.refresh));
      replayOrder = await settlesOrWaits(replayed, 2);
    },
  );
  assert.equal(replay.statusCode, 401, describe(legitimate, replay));
  assert([200, 401].includes(legitimate.statusCode), legitimate.body);
  assert.deepEqual(
    await activeTokens(familyId),
    [],
    `no successor survives reuse revocation (replay ${replayOrder})`,
  );
  await assertUnusable(legitimate);
  assert.equal(
    replayOrder,
    "waiting",
    "reuse revocation serializes behind rotation",
  );
  const family = await familyRecord(familyId);
  assert(family.revokedAt);
  assert.equal(family.revokedReason, "reuse");
});

test("a revoked family can never mint again, whichever of its tokens is presented", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const second = await rotate(session.refresh);
  const third = await rotate(second);
  const familyId = await familyOf(third);
  await ageRotation(session.refresh, GRACE_MS + 60_000);
  const out = await logout(third, session.access);
  assert.equal(out.statusCode, 204, out.body);
  // Active, rotated-within-grace and rotated-outside-grace tokens all fail.
  for (const raw of [third, second, session.refresh, third]) {
    const response = await refresh(raw);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(cookieOf(response), undefined);
  }
  assert.deepEqual(await activeTokens(familyId), []);
  assert.equal(await userTokenCount(user), 0);
  const family = await familyRecord(familyId);
  assert(family.revokedAt);
  assert.equal(family.revokedReason, "logout");
});

test("the reuse grace boundary: just inside supersedes without revoking, just outside revokes", async () => {
  assert.equal(authService.REFRESH_REUSE_GRACE_MS, GRACE_MS);
  const user = await makeUser();
  const session = await signIn(user);
  const second = await rotate(session.refresh);
  const familyId = await familyOf(second);

  await ageRotation(session.refresh, GRACE_MS - 5_000);
  const inside = await refresh(session.refresh);
  assert.equal(inside.statusCode, 409, inside.body);
  assert.equal(cookieOf(inside), undefined);
  assert.deepEqual(await activeTokens(familyId), [hashToken(second)]);
  const third = await rotate(second);

  await ageRotation(session.refresh, GRACE_MS + 5_000);
  const outside = await refresh(session.refresh);
  assert.equal(outside.statusCode, 401, outside.body);
  assert.deepEqual(await activeTokens(familyId), []);
  const replay = await refresh(third);
  assert.equal(replay.statusCode, 401, replay.body);
});

// ─── Revocation racing an in-flight rotation ───────────────

for (const [name, prepare, expected] of [
  [
    "logout",
    (_user, session) => () => logout(session.refresh, session.access),
    204,
  ],
  [
    "password change",
    (user, session) => () => changePassword(user, session.access),
    200,
  ],
  ["password reset", (user) => resetPassword(user), 200],
  ["login elsewhere", (user) => () => loginRequest(user), 200],
]) {
  test(`${name} revokes a family whose rotation is in flight`, async () => {
    const user = await makeUser();
    const session = await signIn(user);
    const familyId = await familyOf(session.refresh);
    const revoke = await prepare(user, session);
    let order;
    const [rotation, revocation] = await withTokenInsertBarrier(
      "familyId",
      familyId,
      async (start) => {
        start(() => refresh(session.refresh));
        await waitForLockWaiters(1);
        const revoking = start(revoke);
        order = await settlesOrWaits(revoking, 2);
      },
    );
    assert.equal(revocation.statusCode, expected, revocation.body);
    assert([200, 401].includes(rotation.statusCode), rotation.body);
    assert.deepEqual(
      await activeTokens(familyId),
      [],
      `${name} leaves no surviving successor (revocation ${order})`,
    );
    await assertUnusable(rotation);
    assert.equal(order, "waiting", `${name} serializes behind the rotation`);
    const family = await familyRecord(familyId);
    assert(family.revokedAt, `${name} durably revokes the family`);
  });
}

// Every new session (password login, OIDC sign-in, registration) is created
// while its user row is held, so a racing reset revokes it or commits first.
for (const [name, create, stale] of [
  [
    "a login with the old password",
    (user) => loginRequest(user),
    (user) => loginRequest(user),
  ],
  [
    "a new session from OIDC sign-in",
    async (user) => ({
      statusCode: 200,
      cookies: [
        {
          name: "refresh_token",
          value: await authService.createRefreshSession(app.prisma, user.id),
        },
      ],
    }),
    null,
  ],
]) {
  test(`a password reset racing ${name} leaves no session from before it`, async () => {
    const user = await makeUser();
    const reset = await resetPassword(user);
    let order;
    const [created, done] = await withTokenInsertBarrier(
      "userId",
      user.id,
      async (start) => {
        // The new session pauses immediately before its token INSERT.
        start(() => create(user));
        await waitForLockWaiters(1);
        const resetting = start(reset);
        order = await settlesOrWaits(resetting, 2);
      },
    );
    assert.equal(done.statusCode, 200, done.body);
    assert([200, 401].includes(created.statusCode), created.body);
    assert.equal(
      await userTokenCount(user),
      0,
      `no session created before the reset survives (reset ${order})`,
    );
    await assertUnusable(created);
    assert.equal(order, "waiting", "the reset serializes behind the session");
    if (stale) {
      const response = await stale(user);
      assert.equal(response.statusCode, 401, response.body);
    }
  });
}

test("a refresh waiting on a busy family past Prisma's default budget completes", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const [response] = await withControlLock(
    familyRowLock(familyId),
    async (start) => {
      start(() => refresh(session.refresh));
      await waitForLockWaiters(1);
      await sleep(6_000);
    },
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(await activeTokens(familyId), [
    hashToken(cookieOf(response)),
  ]);
});

test("a refresh that exhausts its transaction budget is a retryable 503 that changes nothing", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const budget = refreshTransactionOptions.timeout;
  let response;
  refreshTransactionOptions.timeout = 300;
  try {
    [response] = await withControlLock(
      familyRowLock(familyId),
      async (start) => {
        start(() => refresh(session.refresh));
        await waitForLockWaiters(1);
        await sleep(1_000);
      },
    );
  } finally {
    refreshTransactionOptions.timeout = budget;
  }
  assert.equal(response.statusCode, 503, response.body);
  assert.match(response.json().message, /busy/i);
  assert.equal(cookieOf(response), undefined);
  assert.deepEqual(await activeTokens(familyId), [hashToken(session.refresh)]);
  assert.equal((await familyRecord(familyId)).revokedAt, null);
  await rotate(session.refresh);
});

test("a refresh blocked on a held family lock is answered 503 before the lock is released", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const limit = refreshLockLimits.lockTimeoutMs;
  let response, elapsed;
  refreshLockLimits.lockTimeoutMs = 300;
  try {
    await withControlLock(familyRowLock(familyId), async (start) => {
      const started = performance.now();
      const pending = start(() => refresh(session.refresh));
      await waitForLockWaiters(1);
      // The control still holds the lock: the answer must not wait for it.
      let timer;
      try {
        response = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("refresh waited for the lock holder")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      elapsed = performance.now() - started;
    });
  } finally {
    refreshLockLimits.lockTimeoutMs = limit;
  }
  assert.equal(response.statusCode, 503, response.body);
  assert.match(response.json().message, /busy/i);
  assert(elapsed < 3_000, `answered after ${Math.round(elapsed)} ms`);
  assert.equal(cookieOf(response), undefined);
  assert.deepEqual(await activeTokens(familyId), [hashToken(session.refresh)]);
  assert.equal((await familyRecord(familyId)).revokedAt, null);
  await rotate(session.refresh);
});

test("logout clears the cookie even when revoking its family fails", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  assert.match(familyId, /^[A-Za-z0-9-]+$/);
  await control.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION ${barrierFn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced revocation failure'; END $$`,
  );
  await control.$executeRawUnsafe(
    `CREATE TRIGGER ${barrierFn} BEFORE UPDATE ON "RefreshTokenFamily" FOR EACH ROW WHEN (NEW.id = '${familyId}') EXECUTE FUNCTION ${barrierFn}()`,
  );
  let response;
  try {
    response = await logout(session.refresh, session.access);
  } finally {
    await control.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS ${barrierFn} ON "RefreshTokenFamily"`,
    );
  }
  assert.equal(response.statusCode, 500, response.body);
  const cleared = response.cookies.find((c) => c.name === "refresh_token");
  assert(cleared, "the failed logout still clears the cookie");
  assert.equal(cleared.value, "");
  assert(cleared.expires.getTime() <= Date.now());
  // Revocation rolled back; a retried logout completes it.
  assert.deepEqual(await activeTokens(familyId), [hashToken(session.refresh)]);
  const retried = await logout(session.refresh, session.access);
  assert.equal(retried.statusCode, 204, retried.body);
  assert.deepEqual(await activeTokens(familyId), []);
});

test("concurrent revocation and refresh storms never leave a usable token", async () => {
  for (let round = 0; round < 5; round++) {
    const user = await makeUser();
    const session = await signIn(user);
    const familyId = await familyOf(session.refresh);
    const [out, ...refreshes] = await Promise.all([
      logout(session.refresh, session.access),
      refresh(session.refresh),
      refresh(session.refresh),
      refresh(session.refresh),
    ]);
    assert.equal(out.statusCode, 204, out.body);
    for (const response of refreshes)
      assert([200, 401, 409].includes(response.statusCode), describe(response));
    assert.deepEqual(await activeTokens(familyId), [], describe(...refreshes));
    for (const response of refreshes) await assertUnusable(response);
  }
});

// ─── Expiry, logout scope and lifecycle ────────────────────

test("an expired refresh token cannot rotate; one just inside its lifetime can", async () => {
  const user = await makeUser();
  const expired = await signIn(user);
  const expiredFamily = await familyOf(expired.refresh);
  await expireAt(expired.refresh, -1);
  const rejected = await refresh(expired.refresh);
  assert.equal(rejected.statusCode, 401, rejected.body);
  assert.match(rejected.json().message, /expired/i);
  assert.deepEqual(await activeTokens(expiredFamily), []);

  const live = await signIn(user);
  const liveFamily = await familyOf(live.refresh);
  await expireAt(live.refresh, 5_000);
  const before = Date.now();
  const response = await refresh(live.refresh);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json().data;
  assert.equal(body.user.id, user.id);
  assert.ok(body.accessToken);
  assert(Array.isArray(body.workspaces));
  const successor = await control.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(cookieOf(response)) },
  });
  assert.equal(successor.familyId, liveFamily);
  const ttl = successor.expiresAt.getTime() - before;
  assert(
    ttl > SESSION_TTL_MS - 60_000 && ttl <= SESSION_TTL_MS + 60_000,
    `${ttl}`,
  );
});

test("logout with an unknown cookie changes nothing; logout revokes only its own family", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const unknown = await logout(
    crypto.randomBytes(32).toString("hex"),
    session.access,
  );
  assert.equal(unknown.statusCode, 204, unknown.body);
  assert.deepEqual(await activeTokens(familyId), [hashToken(session.refresh)]);
  assert.equal((await familyRecord(familyId)).revokedAt, null);

  // A second concurrent session of the same user (as OIDC sign-in creates).
  const other = await authService.createRefreshSession(app.prisma, user.id);
  const otherFamily = await familyOf(other);
  const out = await logout(session.refresh, session.access);
  assert.equal(out.statusCode, 204, out.body);
  assert.deepEqual(await activeTokens(familyId), []);
  assert.deepEqual(await activeTokens(otherFamily), [hashToken(other)]);
  await rotate(other);
});

test("every refresh token belongs to a durable family of the same user", async () => {
  const user = await makeUser();
  const other = await makeUser();
  const session = await signIn(user);
  const familyId = await familyOf(session.refresh);
  const family = await familyRecord(familyId);
  assert.equal(family.userId, user.id);
  assert.equal(family.revokedAt, null);
  for (const [family, owner] of [
    [crypto.randomUUID(), user.id],
    [familyId, other.id],
  ]) {
    await assert.rejects(
      control.$executeRaw`
        INSERT INTO "RefreshToken" (id, token, "familyId", "userId", "expiresAt")
        VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${family}, ${owner}, now() + interval '1 minute')
      `,
      /foreign key/i,
    );
  }
});

test("a rotated token whose family no longer exists is rejected without side effects", async () => {
  const raw = crypto.randomBytes(32).toString("hex");
  await control.rotatedRefreshToken.create({
    data: {
      tokenHash: hashToken(raw),
      familyId: crypto.randomUUID(),
      rotatedAt: new Date(Date.now() - GRACE_MS - 60_000),
    },
  });
  try {
    const response = await refresh(raw);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(cookieOf(response), undefined);
  } finally {
    await control.rotatedRefreshToken.deleteMany({
      where: { tokenHash: hashToken(raw) },
    });
  }
});

test("cleanup removes dead families but never a family with a live token", async () => {
  const user = await makeUser();
  const live = await signIn(user);
  const liveFamily = await familyOf(live.refresh);
  const dead = crypto.randomUUID();
  const revoked = crypto.randomUUID();
  await control.$executeRaw`
    INSERT INTO "RefreshTokenFamily" (id, "userId", "createdAt", "revokedAt", "revokedReason")
    VALUES
      (${dead}, ${user.id}, now() - interval '8 days', NULL, NULL),
      (${revoked}, ${user.id}, now() - interval '9 days', now() - interval '8 days', 'logout')
  `;
  await control.$executeRaw`
    UPDATE "RefreshTokenFamily" SET "createdAt" = now() - interval '30 days'
    WHERE id = ${liveFamily}
  `;
  await authService.cleanupExpiredTokensAndAttempts(app.prisma);
  const remaining = await control.$queryRaw`
    SELECT id FROM "RefreshTokenFamily" WHERE "userId" = ${user.id}
  `;
  assert.deepEqual(
    remaining.map((row) => row.id),
    [liveFamily],
  );
  await rotate(live.refresh);
});
