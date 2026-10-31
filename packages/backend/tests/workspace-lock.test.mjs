import assert from "node:assert/strict";
import test from "node:test";

const { Prisma } = await import("@prisma/client");
const { withWorkspaceLock, lockWorkspace, lockWorkspaces, WORKSPACE_LOCK_TIMEOUT_MS, WorkspaceBusyError } =
  await import("../src/utils/workspace-lock.ts");
const raw = (state) => new Prisma.PrismaClientKnownRequestError("database failure", {
  code: "P2010", clientVersion: "test", meta: { code: state },
});
const model = (state) => new Prisma.PrismaClientUnknownRequestError(`PostgresError { code: "${state}" }`, { clientVersion: "test" });
const isBusy = (error) => error instanceof WorkspaceBusyError && error.statusCode === 409 &&
  error.message === "The workspace is busy. Please try again.";

function fake({ statement = 0, lock = 0, missing = [], error, setupError } = {}) {
  const calls = [];
  const tx = {
    async $queryRaw(strings, ...values) {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      if (sql.includes("pg_settings")) {
        calls.push({ kind: "read" });
        if (setupError) throw setupError;
        return [{ name: "statement_timeout", timeoutMs: statement }, { name: "lock_timeout", timeoutMs: lock }];
      }
      calls.push({ kind: "lock", sql, values });
      if (error) throw error;
      return missing.includes(values[0]) ? [] : [{ id: values[0] }];
    },
    async $executeRaw(strings, ...values) {
      calls.push({ kind: "set", sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    },
  };
  const client = { async $transaction(callback, options) { calls.push({ kind: "transaction", options }); return callback(tx); } };
  return { tx, client, calls };
}

test("workspace acquisition preserves stricter settings and restores statement runtime after NKU", async () => {
  assert.equal(WORKSPACE_LOCK_TIMEOUT_MS, 5000);
  for (const [statement, lock, boundedStatement, boundedLock] of [[0, 0, 5000, 5000], [250, 0, 250, 5000], [60000, 125, 5000, 125]]) {
    const f = fake({ statement, lock });
    assert.equal(await lockWorkspace(f.tx, "workspace"), true);
    assert.deepEqual(f.calls.map(({ kind }) => kind), ["read", "set", "lock", "set"]);
    assert.deepEqual(f.calls[1].values, [`${boundedStatement}ms`, `${boundedLock}ms`]);
    assert.match(f.calls[1].sql, /set_config\('statement_timeout', \?, true\).*set_config\('lock_timeout', \?, true\)/);
    assert.match(f.calls[2].sql, /FROM "Workspace" WHERE id = \? FOR NO KEY UPDATE/);
    assert.deepEqual(f.calls[3], { kind: "set", sql: "SELECT set_config('statement_timeout', ?, true)", values: [`${statement}ms`] });
  }
});

test("only timeouts from the bounded acquisition statement are classified as workspace busy", async () => {
  for (const error of [raw("55P03"), raw("57014"), model("55P03"), model("57014")]) {
    const f = fake({ error });
    await assert.rejects(lockWorkspace(f.tx, "workspace"), isBusy);
    assert.deepEqual(f.calls.map(({ kind }) => kind), ["read", "set", "lock"]);
  }
  for (const error of [raw("40P01"), raw("XX000"), new Error("not a database timeout")]) {
    const f = fake({ error });
    await assert.rejects(lockWorkspace(f.tx, "workspace"), (thrown) => thrown === error);
  }
  const error = raw("57014"), f = fake({ setupError: error });
  await assert.rejects(lockWorkspace(f.tx, "workspace"), (thrown) => thrown === error);
});

test("ordered multi-workspace acquisition removes duplicates and returns only existing rows", async () => {
  const f = fake({ missing: ["b"] });
  assert.deepEqual(await lockWorkspaces(f.tx, ["z", "b", "a", "z"]), new Set(["a", "z"]));
  assert.deepEqual(f.calls.filter(({ kind }) => kind === "lock").map(({ values }) => values[0]), ["a", "b", "z"]);
});

test("wrapper retains missing/onMissing, transaction options and callback result", async () => {
  const f = fake();
  assert.equal(await withWorkspaceLock(f.client, "exists", async (tx) => { assert.equal(tx, f.tx); return 42; }), 42);
  assert.deepEqual(f.calls[0], { kind: "transaction", options: { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 } });
  const missing = fake({ missing: ["gone"] });
  let ran = false;
  await assert.rejects(withWorkspaceLock(missing.client, "gone", async () => { ran = true; }), (error) => error.statusCode === 404);
  assert.equal(await withWorkspaceLock(missing.client, "gone", async () => { ran = true; }, { onMissing: () => "missing" }), "missing");
  assert.equal(ran, false);
});

test("wrapper maps later lock timeouts and deadlocks while later statement cancels retain their error", async () => {
  for (const error of [raw("55P03"), model("55P03"), raw("40P01"), raw("40001")]) {
    const f = fake();
    await assert.rejects(withWorkspaceLock(f.client, "exists", async () => { throw error; }), isBusy);
    assert.equal(f.calls.filter(({ kind }) => kind === "transaction").length, 1, "busy work was retried");
  }
  for (const error of [raw("57014"), model("57014"), raw("XX000")]) {
    const f = fake();
    await assert.rejects(withWorkspaceLock(f.client, "exists", async () => { throw error; }), (thrown) => thrown === error);
  }
});
