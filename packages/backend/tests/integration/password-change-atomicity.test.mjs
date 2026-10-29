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
  `Password change fixture requires connection_limit>=${MINIMUM_ACTOR_CONNECTIONS}`,
);
actorDatabaseUrl.searchParams.set("connection_limit", String(actorConnections));
const controlDatabaseUrl = new URL(actorDatabaseUrl);
controlDatabaseUrl.searchParams.set("connection_limit", "2");
process.env.DATABASE_URL = actorDatabaseUrl.toString();
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "password-change-integration-jwt-secret";
process.env.COOKIE_SECRET = "password-change-integration-cookie-secret";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.SMTP_SECURE = "false";

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { hashPassword, verifyPassword } =
  await import("../../src/utils/passwords.ts");
const { hashToken } = await import("../../src/utils/tokens.ts");
const authService = await import("../../src/modules/auth/auth.service.ts");
const { refreshLockLimits, refreshTransactionOptions } =
  await import("../../src/modules/auth/refresh-sessions.ts");

const suffix = crypto.randomBytes(5).toString("hex");
const domain = `password-change-${suffix}.example.test`;
const password = "Fixture-password-123";
const HOUR_MS = 60 * 60 * 1000;
const writeLog = `password_write_log_${suffix}`;
const writeTrigger = `password_write_${suffix}`;
// The response to a wrong current password. A change refused because the
// password changed after its check must be indistinguishable from it.
const INCORRECT = {
  statusCode: 400,
  error: "Bad Request",
  message: "Current password is incorrect",
};
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
    await dropWriteLog();
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

function makeUser({ hash = passwordHash } = {}) {
  return control.user.create({
    data: {
      email: `user-${++counter}@${domain}`,
      displayName: `Password change fixture ${counter}`,
      emailVerified: true,
      passwordHash: hash,
    },
  });
}

function candidatePassword(label) {
  return `New-${label}-${crypto.randomBytes(3).toString("hex")}-Aa1`;
}

function login(user, secret = password) {
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

function changePassword(user, access, currentPassword, newPassword) {
  return inject({
    method: "PATCH",
    url: `/api/users/${user.id}/password`,
    headers: { authorization: `Bearer ${access}` },
    payload: { currentPassword, newPassword },
  });
}

function reset(token, newPassword) {
  return inject({
    method: "POST",
    url: `/api/auth/reset-password/${token}`,
    payload: { password: newPassword },
  });
}

async function issueResetToken(user) {
  const token = crypto.randomBytes(32).toString("hex");
  await control.passwordResetToken.create({
    data: { userId: user.id, token, expiresAt: new Date(Date.now() + HOUR_MS) },
  });
  return token;
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
  return { refresh: cookie, access: response.json().data.accessToken };
}

async function storedPasswordHash(user) {
  const row = await control.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  return row.passwordHash;
}

function families(user) {
  return control.refreshTokenFamily.findMany({
    where: { userId: user.id },
    select: { id: true, revokedAt: true, revokedReason: true },
    orderBy: { createdAt: "asc" },
  });
}

function activeTokenCount(user) {
  return control.refreshToken.count({ where: { userId: user.id } });
}

async function familyOf(raw) {
  const { familyId } = await control.refreshToken.findUniqueOrThrow({
    where: { token: hashToken(raw) },
    select: { familyId: true },
  });
  return familyId;
}

async function assertPassword(user, expected, ...refused) {
  const stored = await storedPasswordHash(user);
  assert(
    await verifyPassword(expected, stored),
    "the expected password is stored",
  );
  for (const other of refused)
    assert.equal(
      await verifyPassword(other, stored),
      false,
      `${other} is not stored`,
    );
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
// observe them in PostgreSQL and then commits. Cleanup always releases the
// holder and awaits every actor before the caller inspects state.
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

// Any password write must update the user row, so a row lock on it pauses
// every implementation after the request verified the current password and
// before it can write the new one.
function userRowLock(user) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

function familyRowLock(familyId) {
  return async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id FROM "RefreshTokenFamily" WHERE id = ${familyId} FOR UPDATE
    `;
    assert.equal(rows.length, 1);
  };
}

// Holds the next application transaction until released, to stand for a
// change that verified the current password and was then delayed (scheduling,
// the new password's hash) before writing anything.
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

// Runs the actor against a lock the control keeps holding, with the lock wait
// capped at 300 ms. The answer must arrive while the lock is still held.
async function answeredWhileHeld(lock, actor) {
  const limit = refreshLockLimits.lockTimeoutMs;
  refreshLockLimits.lockTimeoutMs = 300;
  let response;
  try {
    await withControlLock(lock, async (start) => {
      const pending = start(actor);
      await waitForLockWaiters(1);
      let timer;
      try {
        response = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("the request waited for the lock holder")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
  } finally {
    refreshLockLimits.lockTimeoutMs = limit;
  }
  return response;
}

// Records every committed password write of the fixture users with the hash
// it replaced, in commit order: writes to one user row are serialized by its
// row lock, which each writer holds from its trigger until commit.
async function createWriteLog() {
  await control.$executeRawUnsafe(
    `CREATE TABLE "${writeLog}" (seq bigserial PRIMARY KEY, "userId" text NOT NULL, "oldHash" text, "newHash" text)`,
  );
  await control.$executeRawUnsafe(
    `CREATE FUNCTION ${writeTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${writeLog}" ("userId", "oldHash", "newHash") VALUES (NEW.id, OLD."passwordHash", NEW."passwordHash"); RETURN NEW; END $$`,
  );
  await control.$executeRawUnsafe(
    `CREATE TRIGGER ${writeTrigger} AFTER UPDATE OF "passwordHash" ON "User" FOR EACH ROW WHEN (NEW.email LIKE '%@${domain}') EXECUTE FUNCTION ${writeTrigger}()`,
  );
}

async function dropWriteLog() {
  await control.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${writeTrigger} ON "User"`,
  );
  await control.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${writeTrigger}()`);
  await control.$executeRawUnsafe(`DROP TABLE IF EXISTS "${writeLog}"`);
}

async function deadlockCount() {
  const [row] = await control.$queryRaw`
    SELECT deadlocks::int AS total FROM pg_stat_database
    WHERE datname = current_database()
  `;
  return row.total;
}

// ─── A single change ───────────────────────────────────────

test("a password change verifies the current password, replaces it and ends every session", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const oidcStyle = await authService.createRefreshSession(app.prisma, user.id);

  const wrong = await changePassword(
    user,
    session.access,
    "Not-the-password-1",
    candidatePassword("wrong"),
  );
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.deepEqual(wrong.json(), INCORRECT);
  const other = await makeUser();
  const foreign = await changePassword(
    other,
    session.access,
    password,
    candidatePassword("foreign"),
  );
  assert.equal(foreign.statusCode, 403, foreign.body);
  assert.equal(await storedPasswordHash(user), passwordHash);
  assert.equal(await storedPasswordHash(other), passwordHash);
  assert(!(await families(user)).some((f) => f.revokedAt));

  const sso = await makeUser({ hash: null });
  const ssoSession = await refresh(
    await authService.createRefreshSession(app.prisma, sso.id),
  );
  assert.equal(ssoSession.statusCode, 200, ssoSession.body);
  const noPassword = await changePassword(
    sso,
    ssoSession.json().data.accessToken,
    password,
    candidatePassword("sso"),
  );
  assert.equal(noPassword.statusCode, 400, noPassword.body);
  assert.match(noPassword.json().message, /SSO/);
  assert.equal(await storedPasswordHash(sso), null);

  const chosen = candidatePassword("single");
  const response = await changePassword(user, session.access, password, chosen);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().message, "Password updated");
  await assertPassword(user, chosen, password);
  const ended = await families(user);
  assert.equal(ended.length, 2);
  for (const family of ended) {
    assert(family.revokedAt);
    assert.equal(family.revokedReason, "password_change");
  }
  for (const cookie of [session.refresh, oidcStyle])
    assert.equal((await refresh(cookie)).statusCode, 401);
  assert.equal((await login(user, password)).statusCode, 401);
  const next = await signIn(user, chosen);
  assert.equal((await refresh(next.refresh)).statusCode, 200);
});

// ─── Change against reset ──────────────────────────────────

test("a change that verified the old password before a reset committed is refused and writes nothing", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const token = await issueResetToken(user);
  const resetTo = candidatePassword("reset");
  const changeTo = candidatePassword("change");

  const gate = holdNextTransaction();
  let delayed;
  try {
    delayed = changePassword(user, session.access, password, changeTo);
    // The change has verified the old password and hashed the new one.
    await gate.arrived;
    const done = await reset(token, resetTo);
    assert.equal(done.statusCode, 200, done.body);
    const current = await signIn(user, resetTo);
    gate.release();
    const late = await delayed;
    assert.equal(late.statusCode, 400, late.body);
    assert.deepEqual(late.json(), INCORRECT);

    await assertPassword(user, resetTo, changeTo, password);
    assert.equal(
      (await refresh(current.refresh)).statusCode,
      200,
      "the session opened after the reset is not revoked by the refused change",
    );
    assert(
      !(await families(user)).some(
        (f) => f.revokedReason === "password_change",
      ),
    );
  } finally {
    gate.restore();
    await delayed?.catch(() => {});
  }
});

for (const first of ["reset", "change"]) {
  test(`a reset and a change queued on the user row (${first} first) leave the reset's password and no session`, async () => {
    const user = await makeUser();
    const session = await signIn(user);
    const token = await issueResetToken(user);
    const resetTo = candidatePassword("reset");
    const changeTo = candidatePassword("change");
    const actors = {
      reset: () => reset(token, resetTo),
      change: () => changePassword(user, session.access, password, changeTo),
    };
    const second = first === "reset" ? "change" : "reset";
    const responses = await withControlLock(
      userRowLock(user),
      async (start) => {
        start(actors[first]);
        await waitForLockWaiters(1);
        start(actors[second]);
        await waitForLockWaiters(2);
      },
    );
    const byName = { [first]: responses[0], [second]: responses[1] };

    assert.equal(byName.reset.statusCode, 200, describe(...responses));
    if (first === "reset") {
      // The change verified the password the reset replaced.
      assert.equal(byName.change.statusCode, 400, describe(...responses));
      assert.deepEqual(byName.change.json(), INCORRECT);
    } else {
      assert.equal(byName.change.statusCode, 200, describe(...responses));
    }
    await assertPassword(user, resetTo, changeTo, password);
    const used = await control.passwordResetToken.findUnique({
      where: { token },
    });
    assert(used.usedAt);
    assert.equal(await activeTokenCount(user), 0);
    for (const family of await families(user)) assert(family.revokedAt);
    assert.equal((await refresh(session.refresh)).statusCode, 401);
    assert.equal((await login(user, changeTo)).statusCode, 401);
    await signIn(user, resetTo);
  });
}

// ─── Changes against changes ───────────────────────────────

test("concurrent changes from one current password: exactly one succeeds and the others write nothing", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const candidates = Array.from({ length: CONCURRENT }, (_, i) =>
    candidatePassword(`change-${i}`),
  );
  const responses = await withControlLock(userRowLock(user), async (start) => {
    for (const candidate of candidates)
      start(() => changePassword(user, session.access, password, candidate));
    // Every request has verified the old password before any can write.
    await waitForLockWaiters(CONCURRENT);
  });

  const statuses = responses.map((r) => r.statusCode);
  assert.deepEqual(
    [...statuses].sort(),
    [200, ...Array(CONCURRENT - 1).fill(400)],
    describe(...responses),
  );
  for (const loser of responses.filter((r) => r.statusCode !== 200))
    assert.deepEqual(loser.json(), INCORRECT);
  const winner = candidates[statuses.indexOf(200)];
  await assertPassword(
    user,
    winner,
    password,
    ...candidates.filter((c) => c !== winner),
  );
  for (const family of await families(user))
    assert.equal(family.revokedReason, "password_change");
  assert.equal((await refresh(session.refresh)).statusCode, 401);
  await signIn(user, winner);
});

// ─── Change against login and refresh ──────────────────────

for (const first of ["login", "change"]) {
  test(`a password login with the old password and a change queued on the user row (${first} first)`, async () => {
    const user = await makeUser();
    const session = await signIn(user);
    const changeTo = candidatePassword("change");
    const actors = {
      login: () => login(user, password),
      change: () => changePassword(user, session.access, password, changeTo),
    };
    const second = first === "login" ? "change" : "login";
    const responses = await withControlLock(
      userRowLock(user),
      async (start) => {
        start(actors[first]);
        await waitForLockWaiters(1);
        start(actors[second]);
        await waitForLockWaiters(2);
      },
    );
    const byName = { [first]: responses[0], [second]: responses[1] };

    assert.equal(byName.change.statusCode, 200, describe(...responses));
    if (first === "login") {
      // The login committed first; the change then revoked its session.
      assert.equal(byName.login.statusCode, 200, describe(...responses));
      const replay = await refresh(cookieOf(byName.login));
      assert.equal(replay.statusCode, 401, replay.body);
    } else {
      // The login verified the password the change replaced.
      assert.equal(byName.login.statusCode, 401, describe(...responses));
    }
    await assertPassword(user, changeTo, password);
    assert.equal(await activeTokenCount(user), 0);
    assert.equal((await refresh(session.refresh)).statusCode, 401);
    await signIn(user, changeTo);
  });
}

for (const first of ["refresh", "change"]) {
  test(`a refresh and a change queued on the session's family (${first} first) leave no usable token`, async () => {
    const user = await makeUser();
    const session = await signIn(user);
    const familyId = await familyOf(session.refresh);
    const changeTo = candidatePassword("change");
    const actors = {
      refresh: () => refresh(session.refresh),
      change: () => changePassword(user, session.access, password, changeTo),
    };
    const second = first === "refresh" ? "change" : "refresh";
    const responses = await withControlLock(
      familyRowLock(familyId),
      async (start) => {
        start(actors[first]);
        await waitForLockWaiters(1);
        start(actors[second]);
        await waitForLockWaiters(2);
      },
    );
    const byName = { [first]: responses[0], [second]: responses[1] };

    // The change holds the user row while it waits for the family; the
    // rotation's foreign-key check on the user row must not deadlock with it.
    assert.equal(byName.change.statusCode, 200, describe(...responses));
    if (first === "refresh") {
      assert.equal(byName.refresh.statusCode, 200, describe(...responses));
      const replay = await refresh(cookieOf(byName.refresh));
      assert.equal(replay.statusCode, 401, replay.body);
    } else {
      assert.equal(byName.refresh.statusCode, 401, describe(...responses));
    }
    await assertPassword(user, changeTo, password);
    assert.equal(await activeTokenCount(user), 0);
    const [family] = await families(user);
    assert.equal(family.revokedReason, "password_change");
  });
}

// ─── Busy ──────────────────────────────────────────────────

for (const [name, lockOf] of [
  ["the user row", (user) => userRowLock(user)],
  ["a session's family", (_user, familyId) => familyRowLock(familyId)],
]) {
  test(`a change blocked on ${name} past the lock timeout is a retryable 503 that changes nothing`, async () => {
    const user = await makeUser();
    const session = await signIn(user);
    const familyId = await familyOf(session.refresh);
    const response = await answeredWhileHeld(lockOf(user, familyId), () =>
      changePassword(user, session.access, password, candidatePassword("busy")),
    );
    assert.equal(response.statusCode, 503, response.body);
    assert.match(response.json().message, /busy/i);
    assert.equal(await storedPasswordHash(user), passwordHash);
    assert(!(await families(user)).some((f) => f.revokedAt));
    const rotated = await refresh(session.refresh);
    assert.equal(rotated.statusCode, 200, rotated.body);

    const chosen = candidatePassword("retry");
    const retried = await changePassword(
      user,
      session.access,
      password,
      chosen,
    );
    assert.equal(retried.statusCode, 200, retried.body);
    await assertPassword(user, chosen, password);
    assert.equal((await refresh(cookieOf(rotated))).statusCode, 401);
  });
}

test("a change that exhausts its transaction budget is a retryable 503 that changes nothing", async () => {
  const user = await makeUser();
  const session = await signIn(user);
  const budget = refreshTransactionOptions.timeout;
  let response;
  refreshTransactionOptions.timeout = 300;
  try {
    [response] = await withControlLock(userRowLock(user), async (start) => {
      start(() =>
        changePassword(
          user,
          session.access,
          password,
          candidatePassword("late"),
        ),
      );
      await waitForLockWaiters(1);
      await sleep(1_000);
    });
  } finally {
    refreshTransactionOptions.timeout = budget;
  }
  assert.equal(response.statusCode, 503, response.body);
  assert.match(response.json().message, /busy/i);
  assert.equal(await storedPasswordHash(user), passwordHash);
  assert(!(await families(user)).some((f) => f.revokedAt));
  assert.equal((await refresh(session.refresh)).statusCode, 200);
});

// ─── Mixed storm ───────────────────────────────────────────

test("a mixed storm of changes, resets, logins and refreshes never deadlocks, and every successful change replaced the hash it verified", async (t) => {
  await createWriteLog();
  try {
    const states = [];
    for (let i = 0; i < 2; i++) {
      const user = await makeUser();
      const session = await signIn(user);
      states.push({
        user,
        access: session.access,
        cookie: session.refresh,
        known: password,
      });
    }
    const outcomes = [];
    const tokens = new Map();
    const record = (state, kind, response, extra = {}) => {
      outcomes.push({
        state,
        kind,
        status: response.statusCode,
        body: response.body,
        at: performance.now(),
        ...extra,
      });
      return response;
    };
    const deadlocksBefore = await deadlockCount();

    // Copies start from the same known password; a refused copy retries
    // once with the password known by then, as a user would.
    async function changes(state, copies) {
      const known = state.known;
      await Promise.all(
        Array.from({ length: copies }, async (_, i) => {
          let current = known;
          for (let attempt = 0; attempt < 2; attempt++) {
            const next = candidatePassword(`storm-change-${i}-${attempt}`);
            const response = await changePassword(
              state.user,
              state.access,
              current,
              next,
            );
            record(state, "change", response, { current, next });
            if (response.statusCode === 200) {
              state.known = next;
              return;
            }
            if (state.known === current) return;
            current = state.known;
          }
        }),
      );
    }
    async function resets(state, copies, distinctTokens) {
      const issued = [];
      for (let i = 0; i < (distinctTokens ? copies : 1); i++) {
        const token = await issueResetToken(state.user);
        tokens.set(token, []);
        issued.push(token);
      }
      await Promise.all(
        Array.from({ length: copies }, async (_, i) => {
          const token = issued[i % issued.length];
          const next = candidatePassword(`storm-reset-${i}`);
          const response = await reset(token, next);
          record(state, "reset", response, { next, token });
          tokens.get(token).push(response.statusCode);
          if (response.statusCode === 200) state.known = next;
        }),
      );
    }
    async function signInAgain(state) {
      const response = record(
        state,
        "login",
        await login(state.user, state.known),
      );
      if (response.statusCode === 200) state.cookie = cookieOf(response);
    }
    async function rotate(state) {
      const response = record(state, "refresh", await refresh(state.cookie));
      if (response.statusCode === 200) state.cookie = cookieOf(response);
    }

    const operations = [
      (state) => changes(state, 1),
      (state) => changes(state, 2),
      (state) => changes(state, 3),
      (state) => changes(state, 2),
      (state) => resets(state, 2, false),
      (state) => resets(state, 2, true),
      (state) => signInAgain(state),
      (state) => rotate(state),
    ];
    await Promise.all(
      Array.from({ length: 4 }, async (_, worker) => {
        for (let step = 0; step < 8; step++) {
          const state = states[crypto.randomInt(states.length)];
          await operations[
            (worker * 3 + step * 5 + crypto.randomInt(2)) % operations.length
          ](state);
        }
      }),
    );

    const allowed = {
      change: [200, 400],
      reset: [200, 404, 410],
      login: [200, 401, 423],
      refresh: [200, 401, 409],
    };
    for (const outcome of outcomes) {
      assert(
        allowed[outcome.kind].includes(outcome.status),
        `${outcome.kind} answered ${outcome.status} ${outcome.body}`,
      );
      if (outcome.kind === "refresh" && outcome.status === 409)
        assert.match(
          JSON.parse(outcome.body).message,
          /already been refreshed/,
        );
      if (outcome.kind === "change" && outcome.status === 400)
        assert.deepEqual(JSON.parse(outcome.body), INCORRECT);
    }
    const mix = {};
    for (const { kind, status } of outcomes)
      mix[`${kind} ${status}`] = (mix[`${kind} ${status}`] ?? 0) + 1;
    t.diagnostic(`storm responses: ${JSON.stringify(mix)}`);
    assert(
      mix["change 200"] > 0 && mix["reset 200"] > 0,
      "the storm changed and reset passwords",
    );

    for (const [token, statuses] of tokens) {
      const winners = statuses.filter((s) => s === 200).length;
      assert(winners <= 1, `reset token used ${winners} times`);
      const row = await control.passwordResetToken.findUnique({
        where: { token },
      });
      if (winners === 1) assert(row?.usedAt, "a used token is marked used");
    }

    for (const state of states) {
      const writes = await control.$queryRawUnsafe(
        `SELECT "oldHash", "newHash" FROM "${writeLog}" WHERE "userId" = $1 ORDER BY seq`,
        state.user.id,
      );
      const successes = outcomes
        .filter(
          (o) =>
            o.state === state &&
            ["change", "reset"].includes(o.kind) &&
            o.status === 200,
        )
        .sort((a, b) => a.at - b.at);
      assert.equal(
        writes.length,
        successes.length,
        "every committed password write was answered 200 and no refused request wrote",
      );
      let previous = passwordHash;
      for (const write of writes) {
        assert.equal(write.oldHash, previous);
        let index = -1;
        for (let i = 0; i < successes.length && index < 0; i++)
          if (await verifyPassword(successes[i].next, write.newHash)) index = i;
        assert(index >= 0, "each write belongs to a successful request");
        const [writer] = successes.splice(index, 1);
        if (writer.kind === "change")
          assert(
            await verifyPassword(writer.current, write.oldHash),
            "a successful change replaced only the hash of the password it verified",
          );
        previous = write.newHash;
      }
      assert.equal(await storedPasswordHash(state.user), previous);

      const [orphans] = await control.$queryRaw`
        SELECT count(*)::int AS total FROM "RefreshToken" t
        JOIN "RefreshTokenFamily" f ON f.id = t."familyId"
        WHERE t."userId" = ${state.user.id} AND f."revokedAt" IS NOT NULL
      `;
      assert.equal(orphans.total, 0, "no active token in a revoked family");
      const forked = await control.$queryRaw`
        SELECT "familyId" FROM "RefreshToken" WHERE "userId" = ${state.user.id}
        GROUP BY "familyId" HAVING count(*) > 1
      `;
      assert.deepEqual(forked, []);
    }

    // Deadlock statistics are flushed when a backend goes idle, at most once
    // a second.
    await sleep(1_500);
    assert.equal(await deadlockCount(), deadlocksBefore, "no deadlock");
  } finally {
    await dropWriteLog();
  }
});
