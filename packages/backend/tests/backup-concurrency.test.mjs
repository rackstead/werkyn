import assert from "node:assert/strict";
import { test } from "node:test";

const {
  BACKUP_CONCURRENCY_LIMITS,
  BackupBusyError,
  BackupConcurrency,
  BackupRequestAbortedError,
  SERVER_BUSY_MESSAGE,
  WORKSPACE_BUSY_MESSAGE,
  limitBackupRequests,
} = await import("../src/modules/backup/backup-concurrency.ts");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the documented concurrency limits", () => {
  assert.deepEqual({ ...BACKUP_CONCURRENCY_LIMITS }, {
    perWorkspace: 1,
    global: 3,
    retryAfterSeconds: 30,
  });
  assert.ok(Object.isFrozen(BACKUP_CONCURRENCY_LIMITS));
});

test("admission is limited per workspace and per process", () => {
  const limits = new BackupConcurrency();
  const a = limits.admit("a");
  assert.throws(() => limits.admit("a"), (error) => {
    assert.ok(error instanceof BackupBusyError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.scope, "workspace");
    assert.equal(error.retryAfter, 30);
    assert.equal(error.message, WORKSPACE_BUSY_MESSAGE);
    return true;
  });
  const b = limits.admit("b");
  const c = limits.admit("c");
  assert.throws(() => limits.admit("d"), (error) => {
    assert.ok(error instanceof BackupBusyError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.scope, "server");
    assert.equal(error.message, SERVER_BUSY_MESSAGE);
    return true;
  });
  // A busy workspace is reported as such even when the process is full.
  assert.throws(() => limits.admit("a"), { statusCode: 429 });
  assert.deepEqual(limits.usage, { admitted: 3, workspaces: 3, exclusiveRunning: 0 });

  // Releasing is idempotent and frees exactly one admission.
  a();
  a();
  assert.deepEqual(limits.usage, { admitted: 2, workspaces: 2, exclusiveRunning: 0 });
  const d = limits.admit("d");
  assert.throws(() => limits.admit("a"), { statusCode: 503 });
  for (const release of [b, c, d]) release();
  assert.deepEqual(limits.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
});

test("exclusive sections run one at a time in arrival order", async () => {
  const limits = new BackupConcurrency();
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const gates = [];
  const run = (label) =>
    limits.exclusive(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start ${label}`);
      await new Promise((resolve) => gates.push(resolve));
      order.push(`end ${label}`);
      running--;
      if (label === "b") throw new Error("b failed");
      return label;
    });
  const results = ["a", "b", "c"].map((label) => run(label).catch((error) => error.message));
  for (let i = 0; i < 3; i++) {
    await tick();
    assert.equal(gates.length, i + 1, "only one section may run");
    assert.equal(limits.usage.exclusiveRunning, 1);
    gates[i]();
  }
  assert.deepEqual(await Promise.all(results), ["a", "b failed", "c"]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(limits.usage.exclusiveRunning, 0);
});

test("a request aborted while it waits never starts its exclusive section", async () => {
  const limits = new BackupConcurrency();
  let open;
  const first = limits.exclusive(() => new Promise((resolve) => (open = resolve)));
  const controller = new AbortController();
  let started = false;
  const waiting = limits.exclusive(async () => {
    started = true;
  }, controller.signal);
  const after = limits.exclusive(async () => "after");
  await tick();
  controller.abort();
  open("first");
  assert.equal(await first, "first");
  await assert.rejects(waiting, (error) => error instanceof BackupRequestAbortedError);
  assert.equal(started, false);
  // The queue moves on past the abandoned request.
  assert.equal(await after, "after");
});

/** A minimal request and reply for the route wrapper. */
function fakeRoute(wid) {
  const headers = {};
  return {
    request: { params: { wid }, log: { warn() {} } },
    reply: { header: (name, value) => (headers[name] = value), headers },
  };
}

test("the route wrapper holds an admission until the handler settles", async () => {
  const limits = new BackupConcurrency();
  let finish;
  const slow = limitBackupRequests(
    () => new Promise((resolve, reject) => (finish = { resolve, reject })),
    limits,
  );
  const first = fakeRoute("w");
  const pending = slow(first.request, first.reply);
  assert.equal(limits.usage.admitted, 1);

  const second = fakeRoute("w");
  await assert.rejects(slow(second.request, second.reply), { statusCode: 429 });
  assert.equal(second.reply.headers["Retry-After"], "30");

  finish.reject(new Error("handler failed"));
  await assert.rejects(pending, /handler failed/);
  assert.equal(limits.usage.admitted, 0, "released after an error");

  const third = fakeRoute("w");
  const ok = slow(third.request, third.reply);
  finish.resolve("done");
  assert.equal(await ok, "done");
  assert.equal(limits.usage.admitted, 0, "released after success");
});
