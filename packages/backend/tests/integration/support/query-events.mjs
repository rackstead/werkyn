// Records the SQL a Prisma client sends, for tests that check generated
// statements or their plans.
//
// Prisma reports each statement to `$on("query")` listeners through the query
// engine's log callback. Node runs that callback as its own task, apart from
// the one that resolves the statement's result, so on a busy event loop an
// awaited call can return before the events of its statements arrive. A
// recording that stops when the call returns, or after a fixed sleep, then
// misses them.
//
// The engine reports a statement before it returns the statement's result,
// and the log callback delivers events in the order they were reported. So
// once the operation has returned, the event of one more statement sent on the
// same client arrives after every event of the operation. recordQueries sends
// such a marker statement and stops recording when its event arrives.

import crypto from "node:crypto";

const recorders = new WeakMap();

/**
 * Runs `run(client)` and returns its result with every query event the client
 * reported while it ran, in order. `client` must be created with
 * `log: [{ level: "query", emit: "event" }]`. One recording per client at a
 * time. `timeoutMs` bounds only a failure: the marker's event never arriving.
 */
export async function recordQueries(client, run, { timeoutMs = 10_000 } = {}) {
  let recorder = recorders.get(client);
  if (!recorder) {
    recorder = { receive: null };
    client.$on("query", (event) => recorder.receive?.(event));
    recorders.set(client, recorder);
  }
  if (recorder.receive) throw new Error("recordQueries: this client is already recording");
  const events = [];
  const marker = `query-events-marker-${crypto.randomUUID()}`;
  let markerArrived;
  const arrived = new Promise((resolve) => { markerArrived = resolve; });
  recorder.receive = (event) => {
    if (event.params.includes(marker)) markerArrived();
    else events.push(event);
  };
  let timer;
  try {
    const result = await run(client);
    await client.$queryRaw`SELECT ${marker}::text AS marker`;
    await Promise.race([
      arrived,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The marker statement's query event did not arrive within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { result, events };
  } finally {
    clearTimeout(timer);
    recorder.receive = null;
  }
}
