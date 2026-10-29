import { describe, expect, it } from "vitest";
import { settleWithConcurrency } from "./settle-with-concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleWithConcurrency", () => {
  it("settles every item in input order when they finish in reverse order", async () => {
    const pending = new Map<number, ReturnType<typeof deferred<string>>>();
    const run = settleWithConcurrency([0, 1, 2], 4, (item) => {
      const d = deferred<string>();
      pending.set(item, d);
      return d.promise;
    });
    await flush();
    expect([...pending.keys()]).toEqual([0, 1, 2]);
    pending.get(2)!.resolve("c");
    pending.get(1)!.reject(new Error("b failed"));
    pending.get(0)!.resolve("a");
    expect(await run).toEqual([
      { status: "fulfilled", value: "a" },
      { status: "rejected", reason: new Error("b failed") },
      { status: "fulfilled", value: "c" },
    ]);
  });

  it("never has more than the limit in flight and still runs every item", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const pending: Array<{ item: number; d: ReturnType<typeof deferred<number>> }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const run = settleWithConcurrency(items, 4, (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const d = deferred<number>();
      pending.push({ item, d });
      return d.promise.finally(() => inFlight--);
    });
    // Finish whatever is in flight, newest first, until everything has run.
    for (let started = 0; started < 60; started++) {
      await flush();
      const batch = pending.splice(0).reverse();
      if (batch.length === 0) break;
      for (const { item, d } of batch) {
        if (item % 7 === 3) d.reject(new Error(`failed ${item}`));
        else d.resolve(item * 10);
      }
    }
    const results = await run;
    expect(maxInFlight).toBe(4);
    expect(results).toHaveLength(50);
    results.forEach((result, i) => {
      if (i % 7 === 3) expect(result).toEqual({ status: "rejected", reason: new Error(`failed ${i}`) });
      else expect(result).toEqual({ status: "fulfilled", value: i * 10 });
    });
  });

  it("records a task that throws synchronously as rejected and keeps going", async () => {
    const results = await settleWithConcurrency(["ok", "throws", "ok too"], 2, async (item) => {
      if (item === "throws") throw new Error("sync");
      return item.toUpperCase();
    });
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("settles immediately with no items and treats a bad limit as one at a time", async () => {
    expect(await settleWithConcurrency([], 4, async () => 1)).toEqual([]);
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await settleWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBe(1);
    expect(results.map((r) => r.status === "fulfilled" && r.value)).toEqual([1, 2, 3]);
  });
});
