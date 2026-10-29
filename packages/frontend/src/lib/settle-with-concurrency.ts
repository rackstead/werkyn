/**
 * Runs `task` once per item with at most `limit` tasks in flight, and settles
 * when every task has settled. One failure never stops the others. Results
 * are in the items' order whatever order the tasks finish in.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
