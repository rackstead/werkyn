import { buildApp } from '../../../src/app.ts';
import { processDueNotificationDeliveries, startNotificationDeliveryWorker } from '../../../src/modules/notifications/notification-delivery.ts';
const app = await buildApp();
let worker;
await app.listen({ host: '127.0.0.1', port: 0 });
process.send?.({ kind: 'ready', port: app.server.address().port });
process.on('message', async message => {
  try {
    if (message.kind === 'drain') { const result = await processDueNotificationDeliveries(app.prisma, app, { now: new Date(message.now), log: app.log }); process.send?.({ kind: 'drained', result }); }
    if (message.kind === 'start-worker') { worker = startNotificationDeliveryWorker(app, { intervalMs: 20 }); process.send?.({ kind: 'worker-started' }); }
    if (message.kind === 'stop') { await worker?.stop(); await app.close(); process.exit(0); }
  } catch { process.send?.({ kind: 'worker-error' }); process.exitCode = 1; }
});
