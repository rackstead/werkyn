import assert from "node:assert/strict";
import test from "node:test";

const { createShutdownHandler } = await import("../src/utils/shutdown.ts");

function recorder() {
  const entries = [];
  const log = {};
  for (const level of ["info", "warn", "error", "fatal"]) {
    log[level] = (...args) => entries.push({ level, args });
  }
  const exits = [];
  return { log, entries, exits, exit: (code) => exits.push(code) };
}

test("a clean shutdown runs every step in order and exits 0", async () => {
  const { log, exits, exit } = recorder();
  const order = [];
  const shutdown = createShutdownHandler({
    log,
    exit,
    steps: [
      { name: "dex", run: async () => order.push("dex") },
      { name: "http", run: async () => order.push("http") },
    ],
  });
  await shutdown("SIGTERM");
  assert.deepEqual(order, ["dex", "http"]);
  assert.deepEqual(exits, [0]);
});

test("a failing step is logged, later steps still run, and the exit code is 1", async () => {
  const { log, entries, exits, exit } = recorder();
  const order = [];
  const failure = new Error("dex did not stop");
  const shutdown = createShutdownHandler({
    log,
    exit,
    steps: [
      { name: "dex", run: async () => { throw failure; } },
      { name: "http", run: async () => order.push("http") },
    ],
  });
  await assert.doesNotReject(shutdown("SIGTERM"));
  assert.deepEqual(order, ["http"]);
  assert.deepEqual(exits, [1]);
  const logged = entries.find((entry) => entry.level === "error");
  assert.ok(logged, "failure must be logged");
  assert.equal(logged.args[0].err, failure);
  assert.equal(logged.args[0].step, "dex");
});

test("a hung step hits the deadline and exits 1 instead of waiting forever", async () => {
  const { log, entries, exits, exit } = recorder();
  const shutdown = createShutdownHandler({
    log,
    exit,
    timeoutMs: 50,
    steps: [{ name: "http", run: () => new Promise(() => {}) }],
  });
  shutdown("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1]);
  assert.ok(entries.some((entry) => entry.level === "fatal"));
});

test("a second signal during shutdown forces a non-zero exit", async () => {
  const { log, exits, exit } = recorder();
  let release;
  const shutdown = createShutdownHandler({
    log,
    exit,
    steps: [{ name: "http", run: () => new Promise((resolve) => { release = resolve; }) }],
  });
  const first = shutdown("SIGTERM");
  await shutdown("SIGINT");
  assert.deepEqual(exits, [1]);
  release();
  await first;
  assert.deepEqual(exits, [1], "the first shutdown must not exit again after a forced exit");
});
