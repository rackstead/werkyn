import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "unit-chat-delivery-worker-jwt-secret";
process.env.COOKIE_SECRET = "unit-chat-delivery-worker-cookie-secret";

const { startChatMessageDeliveryWorker, processDueChatMessageDeliveries } = await import("../src/modules/chat/chat-delivery.ts");

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

test("stopping a chat delivery pass finishes its current delivery without starting the next", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const firstClaim = new Promise((resolve) => { entered = resolve; });
  const claims = [];
  const completed = [];
  const errors = [];
  const prisma = {
    chatMessageDelivery: {
      findMany: async () => [{ messageId: "first" }, { messageId: "second" }],
      findUnique: async () => ({ attempts: 0 }),
      updateMany: async ({ where }) => {
        claims.push(where.messageId);
        if (where.messageId === "first") {
          entered();
          await held;
        }
        return { count: 1 };
      },
      deleteMany: async ({ where }) => {
        completed.push(where.messageId);
        return { count: 1 };
      },
    },
    // A message deleted before delivery needs no notification or broadcast.
    chatMessage: { findUnique: async () => null },
  };
  const worker = startChatMessageDeliveryWorker(
    { prisma, log: { error: (...args) => errors.push(args) } },
    { intervalMs: 60_000 },
  );
  const running = worker.run();
  await firstClaim;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "the current delivery must actually settle");
  release();
  await stopping;
  await running;
  assert.deepEqual(claims, ["first"], "the next queued delivery stays available for a later worker");
  assert.deepEqual(completed, ["first"]);
  await worker.run();
  assert.deepEqual(claims, ["first"], "a stopped worker cannot start another pass");
  assert.deepEqual(errors, []);
});

test("an already aborted chat delivery pass does not read or claim queued work", async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const prisma = {
    chatMessageDelivery: {
      findMany: async () => { reads++; return []; },
    },
  };
  const result = await processDueChatMessageDeliveries(prisma, { signal: controller.signal });
  assert.deepEqual(result, { completed: 0, pending: 0, skipped: 0 });
  assert.equal(reads, 0);
});
