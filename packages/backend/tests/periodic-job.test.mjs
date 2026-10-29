import assert from "node:assert/strict";
import test from "node:test";

const { startPeriodicJob } = await import("../src/schedulers/periodic-job.ts");

function logger() {
  const errors = [];
  return { errors, log: { error: (...args) => errors.push(args) } };
}

test("runs never overlap, stop signals and waits for the run in progress, and no run starts after stop", async () => {
  const { errors, log } = logger();
  let release;
  let runs = 0;
  let seenSignal;
  const job = startPeriodicJob({
    name: "test job",
    intervalMs: 60_000,
    log,
    run: (signal) => {
      runs++;
      seenSignal = signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const first = job.run();
  assert.equal(job.run(), first, "a run in progress is joined, not started twice");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal(seenSignal.aborted, false);

  let stopped = false;
  const stopping = job.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seenSignal.aborted, true, "the run in progress is told to stop");
  assert.equal(stopped, false, "stop waits for the run in progress");
  release();
  await stopping;
  assert.equal(stopped, true);

  await job.run();
  assert.equal(runs, 1, "no run starts after stop");
  assert.deepEqual(errors, []);
});

test("a failed run is logged and the next run still starts", async () => {
  const { errors, log } = logger();
  let runs = 0;
  const job = startPeriodicJob({
    name: "flaky job",
    intervalMs: 60_000,
    log,
    run: async () => {
      runs++;
      if (runs === 1) throw new Error("database unavailable");
    },
  });
  await job.run();
  await job.run();
  await job.stop();
  assert.equal(runs, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0].message, /database unavailable/);
  assert.match(errors[0][1], /flaky job/);
});

test("the timers start runs after the initial delay and every interval, and stop clears them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { log } = logger();
  let runs = 0;
  const job = startPeriodicJob({
    name: "timed job",
    initialDelayMs: 1_000,
    intervalMs: 10_000,
    log,
    run: async () => { runs++; },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  t.mock.timers.tick(999);
  await settle();
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(runs, 1, "first run after the initial delay");
  t.mock.timers.tick(9_000);
  await settle();
  assert.equal(runs, 2, "then every interval");
  await job.stop();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(runs, 2, "no timer fires after stop");
});

test("without an initial delay the first run waits one interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { log } = logger();
  let runs = 0;
  const job = startPeriodicJob({ name: "plain job", intervalMs: 5_000, log, run: async () => { runs++; } });
  t.mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(runs, 0);
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(runs, 1, "the interval's first tick is the first run");
  await job.stop();
});
