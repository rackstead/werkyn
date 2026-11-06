// Child process for login-backoff.test.mjs: a second server process on the
// same database. It builds the real app, listens on a loopback port and
// prints {"port":N}; the line "quit" on stdin closes it.
// Usage: node --import tsx login-server-child.mjs (environment from parent)
import { createInterface } from "node:readline";

const { buildApp } = await import("../../../src/app.ts");
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`${JSON.stringify({ port: app.server.address().port })}\n`);

for await (const line of createInterface({ input: process.stdin })) {
  if (line === "quit") break;
}
await app.close();
