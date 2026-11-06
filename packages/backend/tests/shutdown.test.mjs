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

test("a stalled step with its own budget does not keep later steps from running", async () => {
  const { log, entries, exits, exit } = recorder();
  const order = [];
  const shutdown = createShutdownHandler({
    log,
    exit,
    timeoutMs: 1000,
    steps: [
      { name: "blob cleanup", run: () => new Promise(() => {}), timeoutMs: 30 },
      { name: "dex", run: async () => order.push("dex"), timeoutMs: 30 },
      { name: "http server", run: async () => order.push("http") },
    ],
  });
  await shutdown("SIGTERM");
  assert.deepEqual(order, ["dex", "http"], "Dex must still be signalled");
  assert.deepEqual(exits, [1]);
  const failure = entries.find((entry) => entry.level === "error");
  assert.equal(failure.args[0].step, "blob cleanup");
  assert.match(failure.args[0].err.message, /blob cleanup did not finish within 30 ms/);
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
  const fatal = entries.find((entry) => entry.level === "fatal");
  assert.ok(fatal, "the deadline must be logged");
  assert.equal(fatal.args[0].step, "http", "the deadline log names the step that hung");
  assert.match(fatal.args[1], /waiting on http/);
});

test("a duplicate signal is ignored, while a later one forces a non-zero exit", async () => {
  const { log, exits, exit } = recorder();
  let release;
  const order = [];
  const shutdown = createShutdownHandler({
    log,
    exit,
    forceAfterMs: 50,
    steps: [
      { name: "dex", run: () => new Promise((resolve) => { release = resolve; }) },
      { name: "http", run: async () => order.push("http") },
    ],
  });
  const first = shutdown("SIGINT");
  // Terminal and process runner both deliver the same Ctrl+C.
  await shutdown("SIGINT");
  assert.deepEqual(exits, [], "a near-simultaneous duplicate must not cut graceful shutdown short");

  await new Promise((resolve) => setTimeout(resolve, 80));
  await shutdown("SIGINT");
  assert.deepEqual(exits, [1]);
  release();
  await first;
  assert.deepEqual(order, ["http"]);
  assert.deepEqual(exits, [1], "the first shutdown must not exit again after a forced exit");
});

test("a duplicate signal does not change a clean exit", async () => {
  const { log, exits, exit } = recorder();
  let release;
  const shutdown = createShutdownHandler({
    log,
    exit,
    steps: [{ name: "http", run: () => new Promise((resolve) => { release = resolve; }) }],
  });
  const first = shutdown("SIGINT");
  await shutdown("SIGINT");
  release();
  await first;
  assert.deepEqual(exits, [0]);
});

test("each step learns the time left before the overall deadline", async () => {
  const { log, exits, exit } = recorder();
  const seen = [];
  // A clock the steps advance, so the expected times are exact.
  let clock = 50_000;
  const shutdown = createShutdownHandler({
    log,
    exit,
    timeoutMs: 1000,
    now: () => clock,
    steps: [
      { name: "slow", run: (left) => { seen.push(left); clock += 120; } },
      { name: "budgeted", run: (left) => { seen.push(left); clock += 30; }, timeoutMs: 300 },
      { name: "http", run: (left) => seen.push(left) },
      { name: "late", run: (left) => { seen.push(left); clock += 5_000; } },
      { name: "after the deadline", run: (left) => seen.push(left) },
    ],
  });
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [0]);
  // A step with its own budget gets the smaller of the two; time past the
  // deadline is reported as none left.
  assert.deepEqual(seen, [1000, 300, 850, 850, 0]);
});

test("the duplicate-signal window uses the same clock as the shutdown", async () => {
  const { log, exits, exit } = recorder();
  let clock = 0;
  let release;
  const shutdown = createShutdownHandler({
    log,
    exit,
    forceAfterMs: 1000,
    now: () => clock,
    steps: [{ name: "http", run: () => new Promise((resolve) => { release = resolve; }) }],
  });
  const first = shutdown("SIGTERM");
  // Within the window by the injected clock: a duplicate, ignored.
  clock = 999;
  await shutdown("SIGTERM");
  assert.deepEqual(exits, []);
  // Past it by the injected clock (wall time has barely moved): forces exit.
  clock = 1000;
  await shutdown("SIGTERM");
  assert.deepEqual(exits, [1]);
  release();
  await first;
  assert.deepEqual(exits, [1]);
});
