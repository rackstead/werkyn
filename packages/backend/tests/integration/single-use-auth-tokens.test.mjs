import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
// Up to CONCURRENT application requests wait on PostgreSQL locks at once,
// each holding a connection, so the application pool needs one more. The lock
// holder and pg_stat_activity observer use a separate two-connection pool so
// blocked actors can never starve the control that must release them.
const CONCURRENT = 4;
const DEFAULT_ACTOR_CONNECTIONS = 6;
const MINIMUM_ACTOR_CONNECTIONS = CONCURRENT + 1;
const actorDatabaseUrl = new URL(process.env.TEST_DATABASE_URL);
const requestedActorLimit =
  actorDatabaseUrl.searchParams.get("connection_limit");
const actorConnections =
  requestedActorLimit === null
    ? DEFAULT_ACTOR_CONNECTIONS
    : Number(requestedActorLimit);
assert(
  actorConnections >= MINIMUM_ACTOR_CONNECTIONS,
  `Single-use token fixture requires connection_limit>=${MINIMUM_ACTOR_CONNECTIONS}`,
);
actorDatabaseUrl.searchParams.set("connection_limit", String(actorConnections));
const controlDatabaseUrl = new URL(actorDatabaseUrl);
controlDatabaseUrl.searchParams.set("connection_limit", "2");
process.env.DATABASE_URL = actorDatabaseUrl.toString();
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "single-use-token-integration-jwt-secret";
process.env.COOKIE_SECRET = "single-use-token-integration-cookie-secret";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { hashPassword, verifyPassword } =
  await import("../../src/utils/passwords.ts");
const authService = await import("../../src/modules/auth/auth.service.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const domain = `single-use-${suffix}.example.test`;
const password = "Fixture-password-123";
const HOUR_MS = 60 * 60 * 1000;
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
    await control.user.deleteMany({
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

// Distinct source addresses keep the per-route rate limits out of the way.
function inject(options) {
  address += 1;
  return app.inject({
    ...options,
    remoteAddress: `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
  });
}

function makeUser({ emailVerified = true } = {}) {
  return control.user.create({
    data: {
      email: `user-${++counter}@${domain}`,
      displayName: `Single-use fixture ${counter}`,
      emailVerified,
      passwordHash,
    },
  });
}

function candidatePassword(label) {
  return `Reset-${label}-${crypto.randomBytes(3).toString("hex")}-Aa1`;
}

async function issueResetToken(user, { expiresInMs = HOUR_MS, usedAt } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await control.passwordResetToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + expiresInMs),
      usedAt,
    },
  });
  return token;
}

async function issueVerificationToken(user, { expiresInMs = HOUR_MS } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  await control.emailVerificationToken.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + expiresInMs),
    },
  });
  return token;
}

function reset(token, newPassword) {
  return inject({
    method: "POST",
    url: `/api/auth/reset-password/${token}`,
    payload: { password: newPassword },
  });
}

function verify(token) {
  return inject({ method: "POST", url: `/api/auth/verify-email/${token}` });
}

function login(user, secret) {
  return inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: secret },
  });
}

function refresh(raw) {
  return inject({
    method: "POST",
    url: "/api/auth/refresh",
    cookies: { refresh_token: raw },
  });
}

function cookieOf(response) {
  return response.cookies.find((c) => c.name === "refresh_token" && c.value)
    ?.value;
}

async function signIn(user, secret = password) {
  const response = await login(user, secret);
  assert.equal(response.statusCode, 200, response.body);
  const cookie = cookieOf(response);
  assert(cookie);
  return cookie;
}

// Password login replaces other sessions; an OIDC-style session does not, so
// the user ends up with two live refresh families.
async function twoSessions(user) {
  const first = await signIn(user);
  const second = await authService.createRefreshSession(app.prisma, user.id);
  return [first, second];
}

async function storedPasswordHash(user) {
  const row = await control.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  return row.passwordHash;
}

async function resetTokenRow(token) {
  return control.passwordResetToken.findUnique({ where: { token } });
}

async function families(user) {
  return control.refreshTokenFamily.findMany({
    where: { userId: user.id },
    select: { id: true, revokedAt: true, revokedReason: true },
    orderBy: { createdAt: "asc" },
  });
}

async function isVerified(user) {
  const row = await control.user.findUnique({
    where: { id: user.id },
    select: { emailVerified: true },
  });
  return row.emailVerified;
}

function describe(...responses) {
  return responses.map((r) => `${r.statusCode} ${r.body}`).join(" | ");
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

// The control transaction takes a real lock, starts actors, lets the body
// observe them in PostgreSQL, optionally changes the locked rows itself
// (beforeRelease) and then commits. Cleanup always releases the holder and
// awaits every actor before the caller inspects state.
async function withControlLock(lock, body, { beforeRelease } = {}) {
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
      if ((await unlocked) && beforeRelease) await beforeRelease(tx);
    },
    { timeout: 15_000, maxWait: 2_000 },
  );
  const running = [];
  const start = (actor) => {
    const pending = Promise.resolve().then(actor);
    running.push(pending);
    return pending;
  };
  let completed = false;
  try {
    await Promise.race([
      ready,
      holder.then(() => {
        throw new Error("Control transaction ended before its lock was ready");
      }),
    ]);
    await body(start);
    completed = true;
  } finally {
    unlock(completed);
    await Promise.allSettled([holder, ...running]);
    holderPid = null;
  }
  await holder;
  return Promise.all(running);
}

// Consuming a single-use token must write its row (mark it used or delete
// it), so a row lock on it pauses every implementation after the request has
// read the token as usable and immediately before it can consume it.
function resetTokenRowLock(token) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "PasswordResetToken" WHERE token = ${token} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

function verificationTokenRowLock(token) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "EmailVerificationToken" WHERE token = ${token} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

// Holds the next application transaction until released, to stand for a
// request that passed its token check and was then delayed (scheduling, a
// slow password hash) before writing anything.
function holdNextTransaction() {
  const transaction = app.prisma.$transaction;
  let reached, release;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  app.prisma.$transaction = (...args) => {
    app.prisma.$transaction = transaction;
    reached();
    return released.then(() => transaction.apply(app.prisma, args));
  };
  return {
    arrived: Promise.race([
      arrived,
      sleep(5_000).then(() =>
        assert.fail("The request never reached its transaction"),
      ),
    ]),
    release,
    restore: () => {
      app.prisma.$transaction = transaction;
      release();
    },
  };
}

// ─── Password reset ────────────────────────────────────────

test("concurrent resets with one token: exactly one succeeds, its password stays and every earlier session ends", async () => {
  const user = await makeUser();
  const sessions = await twoSessions(user);
  const token = await issueResetToken(user);
  const candidates = Array.from({ length: CONCURRENT }, (_, i) =>
    candidatePassword(i),
  );
  const responses = await withControlLock(
    resetTokenRowLock(token),
    async (start) => {
      for (const candidate of candidates) start(() => reset(token, candidate));
      // Every request has read the token as unused before any can use it.
      await waitForLockWaiters(CONCURRENT);
    },
  );

  const statuses = responses.map((r) => r.statusCode);
  assert.deepEqual(
    [...statuses].sort(),
    [200, ...Array(CONCURRENT - 1).fill(410)],
    describe(...responses),
  );
  for (const loser of responses.filter((r) => r.statusCode !== 200))
    assert.match(loser.json().message, /already been used/i);
  const winner = candidates[statuses.indexOf(200)];

  const stored = await storedPasswordHash(user);
  assert(await verifyPassword(winner, stored), "the winner's password is kept");
  for (const other of [password, ...candidates.filter((c) => c !== winner)])
    assert.equal(await verifyPassword(other, stored), false);

  const row = await resetTokenRow(token);
  assert(row.usedAt, "the token is used");
  const revoked = await families(user);
  assert.equal(revoked.length, 2);
  for (const family of revoked) {
    assert(family.revokedAt);
    assert.equal(family.revokedReason, "password_reset");
  }
  for (const cookie of sessions)
    assert.equal((await refresh(cookie)).statusCode, 401);

  // The winner's password signs in; the previous one does not.
  const after = await signIn(user, winner);
  assert.equal((await refresh(after)).statusCode, 200);
  assert.equal((await login(user, password)).statusCode, 401);
});

test("a reset that passed its token check before another reset used the token changes nothing", async () => {
  const user = await makeUser();
  const [before] = await twoSessions(user);
  const token = await issueResetToken(user);
  const winner = candidatePassword("winner");
  const stale = candidatePassword("stale");

  const gate = holdNextTransaction();
  let delayed;
  try {
    delayed = reset(token, stale);
    await gate.arrived;
    // The delayed request has read the token as unused. Another reset now
    // uses it, and the user signs in with the new password.
    const first = await reset(token, winner);
    assert.equal(first.statusCode, 200, first.body);
    const current = await signIn(user, winner);
    gate.release();
    const late = await delayed;
    assert.equal(late.statusCode, 410, late.body);
    assert.match(late.json().message, /already been used/i);

    assert(await verifyPassword(winner, await storedPasswordHash(user)));
    assert.equal(
      (await refresh(current)).statusCode,
      200,
      "the session created after the reset is not revoked by the stale one",
    );
    assert.equal((await refresh(before)).statusCode, 401);
    const live = (await families(user)).filter((f) => !f.revokedAt);
    assert.equal(live.length, 1);
  } finally {
    gate.restore();
    await delayed?.catch(() => {});
  }
});

test("an unsynchronized burst of resets with one token lets exactly one through", async () => {
  for (let round = 0; round < 3; round++) {
    const user = await makeUser();
    const token = await issueResetToken(user);
    const candidates = Array.from({ length: 6 }, (_, i) =>
      candidatePassword(`${round}-${i}`),
    );
    const responses = await Promise.all(
      candidates.map((candidate) => reset(token, candidate)),
    );
    const statuses = responses.map((r) => r.statusCode);
    assert.deepEqual(
      [...statuses].sort(),
      [200, 410, 410, 410, 410, 410],
      describe(...responses),
    );
    const winner = candidates[statuses.indexOf(200)];
    assert(await verifyPassword(winner, await storedPasswordHash(user)));
  }
});

test("a reset whose token expires while it waits for the token is refused and changes nothing", async () => {
  const user = await makeUser();
  const [session] = await twoSessions(user);
  const expiresInMs = 3_000;
  const token = await issueResetToken(user, { expiresInMs });
  const expiresAt = Date.now() + expiresInMs;
  const [response] = await withControlLock(
    resetTokenRowLock(token),
    async (start) => {
      start(() => reset(token, candidatePassword("late")));
      await waitForLockWaiters(1);
      await sleep(Math.max(0, expiresAt - Date.now()) + 250);
    },
  );
  assert.equal(response.statusCode, 410, response.body);
  assert.match(response.json().message, /expired/i);
  assert(await verifyPassword(password, await storedPasswordHash(user)));
  assert.equal((await resetTokenRow(token)).usedAt, null);
  assert(!(await families(user)).some((f) => f.revokedAt));
  assert.equal((await refresh(session)).statusCode, 200);
});

test("used, expired and unknown reset tokens are refused without side effects", async () => {
  const user = await makeUser();
  let [session] = await twoSessions(user);
  const cases = [
    [
      await issueResetToken(user, { usedAt: new Date() }),
      410,
      /already been used/i,
    ],
    [await issueResetToken(user, { expiresInMs: -1_000 }), 410, /expired/i],
    [crypto.randomBytes(32).toString("hex"), 404, /invalid reset token/i],
  ];
  for (const [token, status, message] of cases) {
    const response = await reset(token, candidatePassword("refused"));
    assert.equal(response.statusCode, status, response.body);
    assert.match(response.json().message, message);
    assert(await verifyPassword(password, await storedPasswordHash(user)));
    assert(!(await families(user)).some((f) => f.revokedAt));
    const rotated = await refresh(session);
    assert.equal(rotated.statusCode, 200, rotated.body);
    session = cookieOf(rotated);
  }
});

test("a single reset changes the password, uses the token and ends every other session", async () => {
  const user = await makeUser();
  const sessions = await twoSessions(user);
  const requested = await inject({
    method: "POST",
    url: "/api/auth/forgot-password",
    payload: { email: user.email },
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const { token } = await control.passwordResetToken.findFirstOrThrow({
    where: { userId: user.id, usedAt: null },
  });
  const chosen = candidatePassword("single");

  const response = await reset(token, chosen);
  assert.equal(response.statusCode, 200, response.body);
  assert(await verifyPassword(chosen, await storedPasswordHash(user)));
  assert((await resetTokenRow(token)).usedAt);
  for (const family of await families(user))
    assert.equal(family.revokedReason, "password_reset");
  for (const cookie of sessions)
    assert.equal((await refresh(cookie)).statusCode, 401);
  assert.equal((await login(user, password)).statusCode, 401);
  await signIn(user, chosen);

  const again = await reset(token, candidatePassword("again"));
  assert.equal(again.statusCode, 410, again.body);
  assert.match(again.json().message, /already been used/i);
  assert(await verifyPassword(chosen, await storedPasswordHash(user)));
});

// ─── Email verification ────────────────────────────────────

test("concurrent verifications with one token: exactly one succeeds and the rest get the invalid-token error", async () => {
  const user = await makeUser({ emailVerified: false });
  const token = await issueVerificationToken(user);
  const responses = await withControlLock(
    verificationTokenRowLock(token),
    async (start) => {
      for (let i = 0; i < CONCURRENT; i++) start(() => verify(token));
      await waitForLockWaiters(CONCURRENT);
    },
  );
  assert.deepEqual(
    responses.map((r) => r.statusCode).sort(),
    [200, ...Array(CONCURRENT - 1).fill(404)],
    describe(...responses),
  );
  for (const loser of responses.filter((r) => r.statusCode !== 200))
    assert.match(loser.json().message, /invalid verification token/i);
  const winner = responses.find((r) => r.statusCode === 200);
  assert.equal(winner.json().data.user.id, user.id);
  assert.equal(winner.json().data.user.emailVerified, true);
  assert.equal(await isVerified(user), true);
  assert.equal(
    await control.emailVerificationToken.count({ where: { token } }),
    0,
  );
});

test("a verification whose token is replaced while it waits changes nothing", async () => {
  const user = await makeUser({ emailVerified: false });
  const token = await issueVerificationToken(user);
  const [response] = await withControlLock(
    verificationTokenRowLock(token),
    async (start) => {
      start(() => verify(token));
      await waitForLockWaiters(1);
    },
    {
      // A resend (or another use of the link) removes the token first.
      beforeRelease: (tx) =>
        tx.emailVerificationToken.deleteMany({ where: { token } }),
    },
  );
  assert.equal(response.statusCode, 404, response.body);
  assert.match(response.json().message, /invalid verification token/i);
  assert.equal(await isVerified(user), false);
});

test("a verification whose token expires while it waits for the token is refused and changes nothing", async () => {
  const user = await makeUser({ emailVerified: false });
  const expiresInMs = 3_000;
  const token = await issueVerificationToken(user, { expiresInMs });
  const expiresAt = Date.now() + expiresInMs;
  const [response] = await withControlLock(
    verificationTokenRowLock(token),
    async (start) => {
      start(() => verify(token));
      await waitForLockWaiters(1);
      await sleep(Math.max(0, expiresAt - Date.now()) + 250);
    },
  );
  assert.equal(response.statusCode, 410, response.body);
  assert.match(response.json().message, /expired/i);
  assert.equal(await isVerified(user), false);
  assert.equal(
    await control.emailVerificationToken.count({ where: { token } }),
    1,
  );
});

test("verification: a single use verifies and consumes the token; reuse, expiry and unknown tokens are refused", async () => {
  const user = await makeUser({ emailVerified: false });
  const expired = await issueVerificationToken(user, { expiresInMs: -1_000 });
  const refusedExpired = await verify(expired);
  assert.equal(refusedExpired.statusCode, 410, refusedExpired.body);
  assert.equal(await isVerified(user), false);

  const unknown = await verify(crypto.randomBytes(32).toString("hex"));
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.match(unknown.json().message, /invalid verification token/i);

  const token = await issueVerificationToken(user);
  const first = await verify(token);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().data.user.emailVerified, true);
  assert.equal(await isVerified(user), true);
  const again = await verify(token);
  assert.equal(again.statusCode, 404, again.body);
  assert.match(again.json().message, /invalid verification token/i);

  // A link for an account that is already verified still succeeds once.
  const extra = await issueVerificationToken(user);
  const idempotent = await verify(extra);
  assert.equal(idempotent.statusCode, 200, idempotent.body);
  assert.equal(idempotent.json().data.user.emailVerified, true);
  assert.equal(
    await control.emailVerificationToken.count({ where: { userId: user.id } }),
    1,
    "only the expired token remains",
  );
});
