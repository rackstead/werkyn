// Child process for backup-transport.test.mjs. It builds the real app, listens
// on a loopback port and prints {"port":N}. Each line on stdin is answered with
// one JSON line: "rss" with the peak resident set size and the peak V8 heap in
// use (sampled every 5 ms) so far, "quit" exits.
// Usage: node --import tsx backup-server-child.mjs
import { createInterface } from "node:readline";

let peakHeap = 0;
const sampler = setInterval(() => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}, 5);
sampler.unref();

const { buildApp } = await import("../../../src/app.ts");
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
report({ port: app.server.address().port });

for await (const line of createInterface({ input: process.stdin })) {
  if (line === "rss") {
    report({
      maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      peakHeapMiB: Math.round(peakHeap / 1048576),
    });
  } else if (line === "quit") {
    break;
  }
}
await app.close();
