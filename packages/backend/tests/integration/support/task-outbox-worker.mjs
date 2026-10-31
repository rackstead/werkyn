// Owned process fixture; production modules load from the backend working directory.
import path from "node:path";
import { pathToFileURL } from "node:url";
const load = (p) => import(pathToFileURL(path.join(process.cwd(), p)).href);
const { buildApp } = await load("src/app.ts");
const { startNotificationDeliveryWorker } = await load("src/modules/notifications/notification-delivery.ts");
const app = await buildApp();
const mode = process.argv[2];
const broadcast = app.broadcast.bind(app);
app.broadcast = (...args) => {
  if (["task_updated", "task_moved", "task_created"].includes(args[1])) {
    // Supplied callback cutoff is before the normal broadcaster and first delivery.
    // Killing here establishes no claim that a client received an event frame.
    if (mode === "kill-after-commit") process.kill(process.pid, "SIGKILL");
    process.send?.({ type: "task-broadcast", projectId: args[0], data: args[2] });
  }
  return broadcast(...args);
};
await app.listen({ host: "127.0.0.1", port: 0 });
// The parent explicitly runs this actual worker after its socket is authenticated.
// The default timer stays unchanged; the test makes no elapsed-interval claim.
const retry = mode === "retry" ? startNotificationDeliveryWorker(app) : undefined;
process.send?.({ type: "ready", port: app.server.address().port });
process.on("message", (m) => {
  if (m?.type === "drain" && retry) void retry.run().then(
    () => process.send?.({ type: "drained", id: m.id }),
    () => process.send?.({ type: "drain-failed", id: m.id }),
  );
  if (m?.type === "stop") void (async () => {
    await retry?.stop(); await app.close(); process.disconnect?.();
  })();
});
