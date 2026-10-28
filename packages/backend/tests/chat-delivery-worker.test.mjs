import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "unit-chat-delivery-worker-jwt-secret";
process.env.COOKIE_SECRET = "unit-chat-delivery-worker-cookie-secret";

const { startChatMessageDeliveryWorker } = await import("../src/modules/chat/chat-delivery.ts");

test("the chat delivery worker runs one pass at a time and stop waits for the pass in progress", async () => {
  let release;
  let passes = 0;
  const prisma = {
    chatMessageDelivery: {
      findMany: () => {
        passes++;
        return new Promise((resolve) => { release = () => resolve([]); });
      },
    },
  };
  const errors = [];
  const worker = startChatMessageDeliveryWorker({ prisma, log: { error: (...args) => errors.push(args) } }, { intervalMs: 60_000 });

  const first = worker.run();
  assert.equal(worker.run(), first, "a pass in progress is not started twice");
  assert.equal(passes, 1);

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop waits for the running pass");
  release();
  await stopping;
  assert.equal(stopped, true);

  await worker.run();
  assert.equal(passes, 1, "no pass starts after stop");
  assert.deepEqual(errors, []);
});

test("a failed pass is logged and the next pass still runs", async () => {
  let passes = 0;
  const prisma = {
    chatMessageDelivery: {
      findMany: async () => {
        passes++;
        if (passes === 1) throw new Error("database unavailable");
        return [];
      },
    },
  };
  const errors = [];
  const worker = startChatMessageDeliveryWorker({ prisma, log: { error: (...args) => errors.push(args) } }, { intervalMs: 60_000 });
  await worker.run();
  await worker.run();
  await worker.stop();
  assert.equal(passes, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0].message, /database unavailable/);
});
