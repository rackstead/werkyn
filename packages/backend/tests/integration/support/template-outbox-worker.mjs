import path from 'node:path';
import { pathToFileURL } from 'node:url';
const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
const { buildApp } = await load('src/app.ts');
const { startNotificationDeliveryWorker } = await load('src/modules/notifications/notification-delivery.ts');
const app = await buildApp();
const mode = process.argv[2];
let retry;
const broadcast = app.broadcast.bind(app);
app.broadcast = (...args) => {
  if (args[1] === 'task_created') {
    // This supplied callback cutoff precedes the actual broadcast invocation.
    if (mode === 'kill-after-commit') process.kill(process.pid, 'SIGKILL');
    process.send?.({ type: 'task-broadcast', projectId: args[0], data: args[2] });
  }
  return broadcast(...args);
};
await app.listen({ host: '127.0.0.1', port: 0 });
if (mode === 'retry') retry = startNotificationDeliveryWorker(app);
process.send?.({ type: 'ready', port: app.server.address().port });
process.on('message', (message) => {
  if (message?.type === 'drain' && retry) {
    void retry.run().then(
      () => process.send?.({ type: 'drained', id: message.id }),
      () => process.send?.({ type: 'drain-failed', id: message.id }),
    );
  }
  if (message?.type === 'stop') {
    void (async () => { await retry?.stop(); await app.close(); process.disconnect?.(); })();
  }
});
