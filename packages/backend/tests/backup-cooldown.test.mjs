import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "unit-backup-cooldown-jwt-secret";
process.env.COOKIE_SECRET = "unit-backup-cooldown-cookie-secret";
const {
  BACKUP_UPLOAD_COOLDOWN_CODE,
  backupUploadCooldown,
  createBackupUploadCooldown,
  refuseDuringUploadCooldown,
} = await import("../src/modules/backup/backup-cooldown.ts");
const { default: errorsPlugin } = await import("../src/plugins/errors.ts");

// The SQL itself runs against PostgreSQL in
// tests/integration/backup-upload-cooldown.test.mjs; these cases check what
// is asked of it, and when nothing is.

/** A Prisma stand-in that records the values of each raw query. */
function fakePrisma(rows = [], error) {
  const queries = [];
  return {
    queries,
    async $queryRaw(_strings, ...values) {
      queries.push(values);
      if (error) throw error;
      return rows;
    },
  };
}

function fakeRequest(prisma) {
  const logged = [];
  return {
    logged,
    server: { prisma },
    user: { id: "user-1" },
    log: {
      info: (fields, message) => logged.push(["info", message, fields]),
      warn: (fields, message) => logged.push(["warn", message, fields]),
      error: (fields, message) => logged.push(["error", message, fields]),
    },
  };
}

test("the default cooldown follows the settings: two minutes after a 30-second grace period", () => {
  assert.deepEqual(backupUploadCooldown.policy, { cooldownSeconds: 120, graceSeconds: 30 });
  assert.equal(backupUploadCooldown.enabled, true);
});

test("a refusal for the rate owes the full cooldown plus the forgiven fifth; a shortfall owes cooldown / grace per second", async () => {
  const cooldown = createBackupUploadCooldown({ cooldownSeconds: 120, graceSeconds: 30 });
  const charged = async (outcome) => {
    const prisma = fakePrisma([{ seconds: 1 }]);
    await cooldown.charge(fakeRequest(prisma), outcome);
    return prisma.queries;
  };
  // Owed wait in ms, the cap (1.2 x 120 s) and the allowance (24 s) are sent.
  const refused = await charged("refused");
  assert.equal(refused.length, 1);
  assert.ok(refused[0].includes(144_000), JSON.stringify(refused[0]));
  assert.ok(refused[0].includes(24), JSON.stringify(refused[0]));
  const shortfall = await charged(1_500);
  assert.ok(shortfall[0].includes(6_000), JSON.stringify(shortfall[0]));
  // Never more than the cap, however long the shortfall.
  const long = await charged(10 * 60_000);
  assert.ok(long[0].includes(144_000) && !long[0].some((value) => typeof value === "number" && value > 144_000));
  // No shortfall: nothing is written.
  assert.deepEqual(await charged(0), []);
  assert.deepEqual(await charged(-5), []);
});

test("a failed write is logged and never changes the request's own answer", async () => {
  const cooldown = createBackupUploadCooldown({ cooldownSeconds: 120, graceSeconds: 30 });
  const request = fakeRequest(fakePrisma([], new Error("database unavailable")));
  await cooldown.charge(request, "refused");
  assert.deepEqual(request.logged.map(([level, message]) => [level, message]), [
    ["error", "Could not record a backup upload cooldown"],
  ]);
});

test("0 turns the cooldown off: nothing is read or written", async () => {
  const cooldown = createBackupUploadCooldown({ cooldownSeconds: 0, graceSeconds: 30 });
  const prisma = fakePrisma([{ seconds: 99 }]);
  assert.equal(cooldown.enabled, false);
  assert.equal(await cooldown.retryAfter(prisma, "user-1"), 0);
  await cooldown.charge(fakeRequest(prisma), "refused");
  await cooldown.charge(fakeRequest(prisma), 60_000);
  assert.deepEqual(prisma.queries, []);
});

test("an upload is refused with 429, Retry-After and a code while its user owes a wait, before its handler runs", async () => {
  let owed = 7;
  let handled = 0;
  const stub = { retryAfter: async () => owed };
  const app = Fastify();
  await app.register(errorsPlugin);
  app.get(
    "/upload",
    {
      preHandler: async (request) => {
        request.user = { id: "user-1" };
      },
    },
    refuseDuringUploadCooldown(async () => {
      handled++;
      return { ok: true };
    }, stub),
  );
  await app.ready();
  try {
    const refused = await app.inject({ method: "GET", url: "/upload" });
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.headers["retry-after"], "7");
    assert.deepEqual(refused.json(), {
      statusCode: 429,
      error: "Too Many Requests",
      message: "Backup uploads from your account are paused because a recent one was too slow. Try again in 7 seconds.",
      code: BACKUP_UPLOAD_COOLDOWN_CODE,
    });
    owed = 1;
    assert.match((await app.inject({ method: "GET", url: "/upload" })).json().message, /Try again in 1 second\.$/);
    assert.equal(handled, 0);
    owed = 0;
    const admitted = await app.inject({ method: "GET", url: "/upload" });
    assert.equal(admitted.statusCode, 200);
    assert.equal(handled, 1);
  } finally {
    await app.close();
  }
});
