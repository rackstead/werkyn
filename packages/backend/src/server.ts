import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { cleanupExpiredTokensAndAttempts } from "./modules/auth/auth.service.js";
import { startChatMessageDeliveryWorker } from "./modules/chat/chat-delivery.js";
import { startNotificationDeliveryWorker } from "./modules/notifications/notification-delivery.js";
import { processDueDateReminders } from "./schedulers/due-date-reminders.js";
import { startPeriodicJob } from "./schedulers/periodic-job.js";
import { processRecurringTasks } from "./schedulers/recurring-tasks.js";
import { processTrashPurge } from "./schedulers/trash-purge.js";
import { startBlobCleanupWorker } from "./services/blob-cleanup.js";
import { dexManager } from "./services/dex-manager.js";
import { logger } from "./utils/logger.js";
import { createShutdownHandler } from "./utils/shutdown.js";

async function start() {
  const app = await buildApp();

  try {
    // Header, request, idle and keep-alive timeouts are set by buildApp();
    // long uploads, downloads and backups are bounded per route instead of
    // by disabling them (see plugins/request-limits.ts).
    await app.listen({ port: env.PORT, host: "0.0.0.0" });

    // Scheduled jobs. Runs of one job never overlap, and stop() signals the
    // run in progress to stop at its next safe point and waits for it.
    const scheduledJobs = [
      // Token cleanup on startup, then every 24 hours
      startPeriodicJob({
        name: "token cleanup",
        initialDelayMs: 0,
        intervalMs: 24 * 60 * 60 * 1000,
        log: app.log,
        run: () => cleanupExpiredTokensAndAttempts(app.prisma),
      }),
      // Due-date reminders after 30s, then every 15 minutes
      startPeriodicJob({
        name: "due-date reminders",
        initialDelayMs: 30_000,
        intervalMs: 15 * 60 * 1000,
        log: app.log,
        run: (signal) => processDueDateReminders(app.prisma, app, { signal }),
      }),
      // Recurring task scheduler after 60s, then every 15 minutes
      startPeriodicJob({
        name: "recurring tasks",
        initialDelayMs: 60_000,
        intervalMs: 15 * 60 * 1000,
        log: app.log,
        run: (signal) => processRecurringTasks(app.prisma, app, { signal }),
      }),
      // Trash purge after 120s, then every 24 hours
      startPeriodicJob({
        name: "trash purge",
        initialDelayMs: 120_000,
        intervalMs: 24 * 60 * 60 * 1000,
        log: app.log,
        run: (signal) => processTrashPurge(app.prisma, app.storage, { signal }),
      }),
    ];

    // Retry notifications whose first delivery failed, every 30s
    scheduledJobs.push(startNotificationDeliveryWorker(app));

    // Remove queued stored blobs after 30s, then every 5 minutes
    const blobCleanup = startBlobCleanupWorker(app);

    // Retry chat notifications/realtime events whose first delivery failed,
    // every 30s
    const chatDeliveries = startChatMessageDeliveryWorker(app);

    // Start embedded Dex (SSO identity provider)
    dexManager.start(app.prisma, app.log).catch((err) => {
      app.log.error(err, "Failed to start Dex");
    });

    // Graceful shutdown: failures and timeouts are logged and exit non-zero.
    // Each step has its own budget inside the 8 s overall deadline, so a
    // stalled cleanup batch cannot keep Dex from being signalled. Dex's own
    // stop sends SIGKILL 5 s after SIGTERM, inside its 5.5 s budget. The
    // scheduled jobs and the notification delivery worker stop first, all at
    // once, so none starts new work against a closing database; each returns
    // at its next unit of work (an occurrence, a reminder batch, a delivery, a
    // trash candidate). Work cut off by a budget is safe: occurrences,
    // reminder batches and purges are single transactions that roll back, and
    // chat and notification deliveries are retried after their lease expires.
    const shutdown = createShutdownHandler({
      log: app.log,
      steps: [
        {
          name: "scheduled jobs",
          run: () => Promise.all(scheduledJobs.map((job) => job.stop())),
          timeoutMs: 500,
        },
        { name: "blob cleanup", run: () => blobCleanup.stop(), timeoutMs: 1_000 },
        { name: "chat deliveries", run: () => chatDeliveries.stop(), timeoutMs: 500 },
        { name: "dex", run: () => dexManager.stop(), timeoutMs: 5_500 },
        { name: "http server", run: () => app.close() },
      ],
    });
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    app.log.fatal({ err }, "Server failed to start");
    process.exit(1);
  }
}

start().catch((err) => {
  logger.fatal({ err }, "Server failed to start");
  process.exit(1);
});
