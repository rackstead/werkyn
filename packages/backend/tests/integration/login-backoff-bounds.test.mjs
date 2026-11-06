// Bounded failed sign-in tracking (docs/remediation/r31-login-backoff.md): a
// flood of attacker-chosen addresses never grows "LoginThrottle" beyond
// LOGIN_BACKOFF_SLOTS rows, and the cleanup job removes forgotten rows.
// This file runs with the smallest slot count so the bound is reached.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
for (const name of Object.keys(process.env))
  if (name.startsWith("LOGIN_BACKOFF_")) delete process.env[name];
const SLOTS = 256;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "login-backoff-bounds-jwt-secret",
  COOKIE_SECRET: "login-backoff-bounds-cookie-secret",
  LOGIN_BACKOFF_SLOTS: String(SLOTS),
});

const { buildApp } = await import("../../src/app.ts");
const { createLoginThrottle, loginThrottle, loginSlot, DEVICE_LANES } = await import(
  "../../src/modules/auth/login-throttle.ts"
);
const { cleanupExpiredTokensAndAttempts } = await import(
  "../../src/modules/auth/auth.service.ts"
);

const suffix = crypto.randomBytes(5).toString("hex");
let app;
let address = 0;

const rows = async () => Number((await app.prisma.loginThrottle.count()));

before(async () => {
  app = await buildApp();
  await app.ready();
  // Tests run one file at a time; earlier files' counters are not this
  // file's to bound.
  await app.prisma.loginThrottle.deleteMany();
});

after(async () => {
  try {
    await app.prisma.loginThrottle.deleteMany();
  } finally {
    await app?.close();
  }
});

test("a flood of unique unknown addresses through the sign-in route stays within the slot count", async () => {
  assert.equal(loginThrottle().policy.slots, SLOTS);
  const total = 600;
  const statuses = new Map();
  let next = 0;
  // Two at a time: one process admits two password checks at once.
  const worker = async () => {
    while (next < total) {
      const i = next++;
      address++;
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: {
          email: `flood-${suffix}-${i}@unknown-${i}.example.test`,
          password: "Wrong-password-123",
        },
        remoteAddress: `10.99.${(address >> 8) & 255}.${address & 255}`,
      });
      statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
    }
  };
  await Promise.all([worker(), worker()]);
  const count = await rows();
  assert.ok(count <= SLOTS, `${count} rows`);
  // 600 addresses over 256 slots leave few slots unused.
  assert.ok(count >= 200, `${count} rows`);
  assert.deepEqual(
    [...statuses.keys()].filter((s) => ![401, 429].includes(s)),
    [],
    JSON.stringify([...statuses]),
  );
  assert.equal(
    [...statuses.values()].reduce((sum, n) => sum + n, 0),
    total,
  );
});

test("two thousand more unique addresses admitted directly still leave at most the slot count", async () => {
  const throttle = createLoginThrottle({
    threshold: 5,
    baseSeconds: 2,
    maxSeconds: 60,
    resetSeconds: 3600,
    slots: SLOTS,
  });
  let admitted = 0;
  for (let i = 0; i < 2000; i++) {
    const result = await throttle.admit(
      app.prisma,
      `direct-${suffix}-${i}@unknown.example.test`,
    );
    if (result.admitted) admitted++;
    else assert.ok(result.retryAfter >= 1 && result.retryAfter <= 60);
  }
  const count = await rows();
  assert.ok(count <= SLOTS && count >= SLOTS - 6, `${count} rows`);
  const [{ maxSlot }] = await app.prisma.$queryRaw`
    SELECT max("slot")::integer AS "maxSlot" FROM "LoginThrottle"
  `;
  assert.ok(maxSlot < SLOTS);
  // Shared slots back off: far fewer than all 2000 were admitted.
  assert.ok(admitted < 2000, `${admitted}`);
});

test("cleanup removes forgotten rows and rows outside the address and device ranges, keeping recent ones", async () => {
  await app.prisma.loginThrottle.deleteMany();
  const recent = loginSlot(`recent-${suffix}@example.test`, SLOTS);
  const forgotten = (recent + 1) % SLOTS;
  const device = DEVICE_LANES + 10;
  // Rows left by a larger LOGIN_BACKOFF_SLOTS setting, in either range.
  await app.prisma.$executeRaw`
    INSERT INTO "LoginThrottle" ("slot", "failures", "lastFailureAt") VALUES
      (${recent}::integer, 7, (clock_timestamp() AT TIME ZONE 'UTC') - interval '59 minutes'),
      (${forgotten}::integer, 7, (clock_timestamp() AT TIME ZONE 'UTC') - interval '61 minutes'),
      (${device}::integer, 1, clock_timestamp() AT TIME ZONE 'UTC'),
      (${SLOTS + 10}::integer, 1, clock_timestamp() AT TIME ZONE 'UTC'),
      (${DEVICE_LANES + SLOTS + 10}::integer, 1, clock_timestamp() AT TIME ZONE 'UTC')
  `;
  await cleanupExpiredTokensAndAttempts(app.prisma);
  const left = await app.prisma.loginThrottle.findMany({
    select: { slot: true },
    orderBy: { slot: "asc" },
  });
  assert.deepEqual(left.map((r) => r.slot), [recent, device]);
});

test("each process starts at most 600 reset requests a minute, refusing any address alike past that", async () => {
  const { settlePasswordResetRequests } = await import(
    "../../src/modules/auth/auth.service.ts"
  );
  const forgot = async (email) => {
    address++;
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email },
      remoteAddress: `10.98.${(address >> 8) & 255}.${address & 255}`,
    });
    return { status: response.statusCode, retryAfter: response.headers["retry-after"], body: response.json() };
  };
  const owner = await app.prisma.user.create({
    data: { email: `budget-${suffix}@example.test`, displayName: "budget", emailVerified: true },
  });
  try {
    const statuses = new Map();
    for (let i = 0; i < 600; i++) {
      const { status } = await forgot(`budget-${suffix}-${i}@unknown.example.test`);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    // Earlier tests in this process did not request resets, so all 600 start.
    assert.deepEqual([...statuses], [[200, 600]]);
    const unknown = await forgot(`budget-${suffix}-over@unknown.example.test`);
    const existing = await forgot(owner.email);
    assert.equal(unknown.status, 429);
    assert.ok(Number(unknown.retryAfter) >= 1 && Number(unknown.retryAfter) <= 60);
    // The refusal does not depend on whether the address has an account.
    assert.deepEqual({ ...existing, retryAfter: undefined }, { ...unknown, retryAfter: undefined });
    assert.match(existing.body.message, /^Too many password reset requests right now\. Try again in \d+ seconds?\.$/);
    await settlePasswordResetRequests();
    assert.equal(
      await app.prisma.passwordResetToken.count({ where: { userId: owner.id } }),
      0,
    );
  } finally {
    await app.prisma.user.delete({ where: { id: owner.id } });
  }
});
