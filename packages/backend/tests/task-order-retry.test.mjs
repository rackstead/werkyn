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
const { withProjectOrder, ORDER_TRANSACTION_ATTEMPTS, ORDER_LOCK_TIMEOUT_MS, ProjectBusyError } = await import("../src/utils/task-order.ts");
const { isLockTimeoutError, isRetryableDatabaseError } = await import("../src/utils/retryable-database-errors.ts");
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
// A lock wait past lock_timeout, as a raw query (the project lock) and as a model query reports it.
const lockTimeoutRaw = () =>
  new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`", {
    code: "P2010",
    clientVersion,
    meta: { code: "55P03", message: "canceling statement due to lock timeout" },
  });
const statementTimeoutRaw = () =>
  new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`", {
    code: "P2010",
    clientVersion,
    meta: { code: "57014", message: "canceling statement due to statement timeout" },
  });
const lockTimeoutModel = () =>
  new Prisma.PrismaClientUnknownRequestError(
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "55P03", message: "canceling statement due to lock timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
    { clientVersion },
  );

/** A root client whose transactions lock `project` (or find nothing) and record their options. */
function fakeClient(project = { id: "p1", archived: false }) {
  const calls = { transactions: 0, locks: [], settings: [], statements: [], options: [] };
  const tx = {
    $executeRaw: async (strings, ...values) => {
      calls.settings.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      calls.statements.push("setting");
      return 1;
    },
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join("?");
      if (sql.includes("current_setting")) {
        calls.statements.push("read setting");
        return [{ previous: "0" }];
      }
      calls.locks.push({ sql, values });
      calls.statements.push("lock");
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
    // Every attempt bounds its waits, locks the project row and restores the
    // statement timeout, in a READ COMMITTED transaction.
    assert.deepEqual(
      client.calls.statements,
      Array(ORDER_TRANSACTION_ATTEMPTS).fill(["read setting", "setting", "lock", "setting"]).flat(),
    );
    for (const lock of client.calls.locks) {
      assert.match(lock.sql, /FROM "Project" WHERE id = \? FOR NO KEY UPDATE/);
      assert.deepEqual(lock.values, ["p1"]);
    }
    const bound = `${ORDER_LOCK_TIMEOUT_MS}ms`;
    for (let i = 0; i < client.calls.settings.length; i += 2) {
      assert.deepEqual(client.calls.settings[i], {
        sql: "SELECT set_config('statement_timeout', ?, true), set_config('lock_timeout', ?, true)",
        values: [bound, bound],
      });
      assert.deepEqual(client.calls.settings[i + 1], {
        sql: "SELECT set_config('statement_timeout', ?, true)",
        values: ["0"],
      });
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

test("a lock wait past the lock timeout is answered 503 and not retried", async () => {
  assert.equal(ORDER_LOCK_TIMEOUT_MS, 5_000);
  for (const failure of [lockTimeoutRaw, lockTimeoutModel, statementTimeoutRaw]) {
    assert.equal(isLockTimeoutError(failure()), true);
    assert.equal(isRetryableDatabaseError(failure()), false);
  }
  assert.equal(isLockTimeoutError(deadlock()), false);
  assert.equal(isLockTimeoutError(known("P2028")), false);
  for (const failure of [lockTimeoutRaw, lockTimeoutModel, statementTimeoutRaw]) {
    const client = fakeClient();
    const warnings = await capturingWarnings(() =>
      assert.rejects(
        withProjectOrder(client, "p1", async () => { throw failure(); }),
        (error) =>
          error instanceof ProjectBusyError &&
          error.statusCode === 503 &&
          error.error === "Service Unavailable" &&
          error.message === "The project is busy. Try again in a moment.",
      ));
    assert.equal(client.calls.transactions, 1, "a lock timeout was retried");
    assert.equal(warnings.length, 0);
  }
  // In a caller's transaction the caller sees the database error itself.
  const client = fakeClient();
  const error = lockTimeoutRaw();
  await assert.rejects(withProjectOrder(client.tx, "p1", async () => { throw error; }), (thrown) => thrown === error);
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
  // The bound applies to the caller's transaction too.
  assert.deepEqual(client.calls.statements, ["read setting", "setting", "lock", "setting"]);
  assert.equal(await withProjectOrder(client.tx, "p1", async (tx) => (tx === client.tx ? "same" : "other")), "same");
});
