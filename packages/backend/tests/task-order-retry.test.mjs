import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "task-order-retry-test-jwt",
  COOKIE_SECRET: "task-order-retry-test-cookie",
});
const { Prisma } = await import("@prisma/client");
const { withProjectOrder, ORDER_TRANSACTION_ATTEMPTS } = await import("../src/utils/task-order.ts");
const { isRetryableDatabaseError } = await import("../src/utils/retryable-database-errors.ts");
const { NotFoundError, ValidationError } = await import("../src/utils/errors.ts");
const { logger } = await import("../src/utils/logger.ts");

/** Captures logger.warn calls made while `fn` runs. */
async function capturingWarnings(fn) {
  const warnings = [];
  const original = logger.warn;
  logger.warn = (...args) => { warnings.push(args); };
  try {
    await fn();
  } finally {
    logger.warn = original;
  }
  return warnings;
}

const clientVersion = "test";
// The shape Prisma 6 produces for a deadlock inside an interactive transaction.
const deadlock = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
    { clientVersion },
  );
const serialization = () =>
  new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40001`.", {
    code: "P2010",
    clientVersion,
    meta: { code: "40001" },
  });
const known = (code) => new Prisma.PrismaClientKnownRequestError(code, { code, clientVersion });

/** A root client whose transactions lock `project` (or find nothing) and record their options. */
function fakeClient(project = { id: "p1", archived: false }) {
  const calls = { transactions: 0, locks: [], options: [] };
  const tx = {
    $queryRaw: async (strings, ...values) => {
      calls.locks.push({ sql: strings.join("?"), values });
      return project ? [project] : [];
    },
  };
  const client = {
    calls,
    tx,
    $transaction: async (fn, options) => {
      calls.transactions++;
      calls.options.push(options);
      return fn(tx);
    },
  };
  return client;
}

test("a deadlocked or serialization-failed transaction is retried, up to the attempt limit", async () => {
  assert.equal(ORDER_TRANSACTION_ATTEMPTS, 3);
  for (const [failure, code] of [[deadlock, "40P01"], [serialization, "40001"], [() => known("P2034"), "P2034"]]) {
    const client = fakeClient();
    let runs = 0;
    let result;
    const warnings = await capturingWarnings(async () => {
      result = await withProjectOrder(client, "p1", async (tx, project) => {
        runs++;
        assert.equal(tx, client.tx);
        assert.deepEqual(project, { id: "p1", archived: false });
        if (runs < ORDER_TRANSACTION_ATTEMPTS) throw failure();
        return "done";
      });
    });
    assert.equal(result, "done");
    // Each retry is logged with the project, the attempt and the database code (not the query).
    assert.deepEqual(
      warnings.map(([fields]) => fields),
      [1, 2].map((attempt) => ({ projectId: "p1", attempt, attempts: ORDER_TRANSACTION_ATTEMPTS, code })),
    );
    assert.equal(client.calls.transactions, ORDER_TRANSACTION_ATTEMPTS, "one transaction per attempt");
    // Every attempt locks the project row first, in a READ COMMITTED transaction.
    assert.equal(client.calls.locks.length, ORDER_TRANSACTION_ATTEMPTS);
    for (const lock of client.calls.locks) {
      assert.match(lock.sql, /FROM "Project" WHERE id = \? FOR NO KEY UPDATE/);
      assert.deepEqual(lock.values, ["p1"]);
    }
    assert.deepEqual(client.calls.options[0], { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 });
  }

  // Past the limit the last error reaches the error handler, which answers the retryable 409.
  const client = fakeClient();
  const error = deadlock();
  await assert.rejects(withProjectOrder(client, "p1", async () => { throw error; }), (thrown) => thrown === error);
  assert.equal(client.calls.transactions, ORDER_TRANSACTION_ATTEMPTS);
  assert.equal(isRetryableDatabaseError(error), true);
});

test("expired transactions and ordinary errors are not retried", async () => {
  for (const error of [
    known("P2028"),
    new ValidationError("Cannot add dependency: would create a circular dependency"),
    known("P2002"),
    new Error("boom"),
  ]) {
    const client = fakeClient();
    const warnings = await capturingWarnings(() =>
      assert.rejects(withProjectOrder(client, "p1", async () => { throw error; }), (thrown) => thrown === error));
    assert.equal(client.calls.transactions, 1, `${error.message} was retried`);
    assert.equal(warnings.length, 0);
  }
});

test("a missing project is a 404 and is not retried", async () => {
  const client = fakeClient(null);
  let ran = false;
  await assert.rejects(
    withProjectOrder(client, "gone", async () => { ran = true; }),
    (error) => error instanceof NotFoundError && error.message === "Project not found",
  );
  assert.equal(ran, false);
  assert.equal(client.calls.transactions, 1);
});

test("inside a caller's transaction the lock is taken there and the caller owns retrying", async () => {
  const client = fakeClient();
  const error = deadlock();
  // A transaction client has no $transaction of its own.
  await assert.rejects(withProjectOrder(client.tx, "p1", async () => { throw error; }), (thrown) => thrown === error);
  assert.equal(client.calls.transactions, 0);
  assert.equal(client.calls.locks.length, 1);
  assert.equal(await withProjectOrder(client.tx, "p1", async (tx) => (tx === client.tx ? "same" : "other")), "same");
});
