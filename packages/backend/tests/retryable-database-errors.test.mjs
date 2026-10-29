import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "retryable-errors-test-jwt",
  COOKIE_SECRET: "retryable-errors-test-cookie",
});
const { Prisma } = await import("@prisma/client");
const { isRetryableDatabaseError } = await import("../src/utils/retryable-database-errors.ts");
const { withWorkspaceLock } = await import("../src/utils/workspace-lock.ts");
const { default: errorsPlugin } = await import("../src/plugins/errors.ts");

const clientVersion = "test";
// The shapes Prisma 6 produces for a PostgreSQL deadlock, as captured from real runs.
const unknown = (state) =>
  new Prisma.PrismaClientUnknownRequestError(
    `Invalid \`tx.task.updateMany()\` invocation:\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${state}", message: "deadlock detected", severity: "ERROR", detail: Some("Process 1 waits for ShareLock on transaction 2; blocked by process 3."), column: None, hint: None }), transient: false })`,
    { clientVersion },
  );
const raw = (state) =>
  new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`. Message: `deadlock detected`", {
    code: "P2010",
    clientVersion,
    meta: { code: state, message: "deadlock detected" },
  });
const known = (code, meta) => new Prisma.PrismaClientKnownRequestError("known", { code, clientVersion, meta });

test("deadlocks and serialization failures are retryable under every Prisma error class", () => {
  for (const state of ["40P01", "40001"]) {
    assert.equal(isRetryableDatabaseError(unknown(state)), true, `unknown request error ${state}`);
    assert.equal(isRetryableDatabaseError(raw(state)), true, `raw query error ${state}`);
  }
  assert.equal(isRetryableDatabaseError(known("P2034")), true);
  // An interactive transaction that expired, for example while waiting for a row lock.
  assert.equal(isRetryableDatabaseError(known("P2028")), true);

  assert.equal(isRetryableDatabaseError(unknown("22021")), false);
  assert.equal(isRetryableDatabaseError(raw("23505")), false);
  // Only P2010 carries a SQLSTATE in meta.code.
  assert.equal(isRetryableDatabaseError(known("P2002", { code: "40P01" })), false);
  assert.equal(isRetryableDatabaseError(known("P2003")), false);
  assert.equal(isRetryableDatabaseError(new Error('code: "40P01"')), false);
  assert.equal(isRetryableDatabaseError(undefined), false);
});

test("the error handler answers a deadlock with the retryable 409 and no internals", async () => {
  const app = Fastify({ logger: false });
  await app.register(errorsPlugin);
  let next;
  app.get("/fail", async () => {
    throw next;
  });
  await app.ready();
  try {
    for (const error of [unknown("40P01"), raw("40P01"), unknown("40001"), known("P2028")]) {
      next = error;
      const response = await app.inject({ method: "GET", url: "/fail" });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), {
        statusCode: 409,
        error: "Conflict",
        message: "The request conflicted with a concurrent change; try again",
      });
      assert.doesNotMatch(response.body, /deadlock|ConnectorError|Process|updateMany/);
    }
    next = unknown("XX000");
    assert.equal((await app.inject({ method: "GET", url: "/fail" })).statusCode, 500);
  } finally {
    await app.close();
  }
});

test("withWorkspaceLock turns a deadlock inside its transaction into the busy 409", async () => {
  for (const error of [unknown("40P01"), raw("40P01")]) {
    const prisma = {
      async $transaction() {
        throw error;
      },
    };
    await assert.rejects(
      withWorkspaceLock(prisma, "workspace", async () => "never"),
      (thrown) => thrown.statusCode === 409 && thrown.message === "The workspace is busy. Please try again.",
    );
  }
});
