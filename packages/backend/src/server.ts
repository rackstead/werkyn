import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { cleanupExpiredTokensAndAttempts } from "./modules/auth/auth.service.js";
import { processDueChatMessageDeliveries } from "./modules/chat/chat-delivery.js";
import { processDueDateReminders } from "./schedulers/due-date-reminders.js";
import { processRecurringTasks } from "./schedulers/recurring-tasks.js";
import { processTrashPurge } from "./schedulers/trash-purge.js";
import { startBlobCleanupWorker } from "./services/blob-cleanup.js";
import { dexManager } from "./services/dex-manager.js";
import { logger } from "./utils/logger.js";
import { createShutdownHandler } from "./utils/shutdown.js";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });

    // Disable default timeouts for large file uploads
    app.server.requestTimeout = 0;
    app.server.headersTimeout = 0;

    // Run cleanup on startup
    cleanupExpiredTokensAndAttempts(app.prisma).catch((err) => {
      app.log.error(err, "Failed to run initial token cleanup");
    });

    // Schedule cleanup every 24 hours
    setInterval(
      () => {
        cleanupExpiredTokensAndAttempts(app.prisma).catch((err) => {
          app.log.error(err, "Failed to run scheduled token cleanup");
        });
      },
      24 * 60 * 60 * 1000,
    );

    // Run due-date reminders after 30s delay, then every 15 minutes
    setTimeout(() => {
      processDueDateReminders(app.prisma, app).catch((err) => {
        app.log.error(err, "Failed to run initial due-date reminders");
      });
    }, 30_000);

    setInterval(
      () => {
        processDueDateReminders(app.prisma, app).catch((err) => {
          app.log.error(err, "Failed to run scheduled due-date reminders");
        });
      },
      15 * 60 * 1000,
    );

    // Run recurring task scheduler after 60s delay, then every 15 minutes
    setTimeout(() => {
      processRecurringTasks(app.prisma, app).catch((err) => {
        app.log.error(err, "Failed to run initial recurring tasks");
      });
    }, 60_000);

    setInterval(
      () => {
        processRecurringTasks(app.prisma, app).catch((err) => {
          app.log.error(err, "Failed to run scheduled recurring tasks");
        });
      },
      15 * 60 * 1000,
    );

    // Run trash purge after 120s delay, then every 24 hours
    setTimeout(() => {
      processTrashPurge(app.prisma, app.storage).catch((err) => {
        app.log.error(err, "Failed to run initial trash purge");
      });
    }, 120_000);

    setInterval(
      () => {
        processTrashPurge(app.prisma, app.storage).catch((err) => {
          app.log.error(err, "Failed to run scheduled trash purge");
        });
      },
      24 * 60 * 60 * 1000,
    );

    // Remove queued stored blobs after 30s, then every 5 minutes
    const blobCleanup = startBlobCleanupWorker(app);

    // Retry chat notifications/realtime events whose first delivery failed
    setInterval(
      () => {
        processDueChatMessageDeliveries(app.prisma, { log: app.log }).catch((err) => {
          app.log.error(err, "Failed to run chat message delivery retries");
        });
      },
      30 * 1000,
    );

    // Start embedded Dex (SSO identity provider)
    dexManager.start(app.prisma, app.log).catch((err) => {
      app.log.error(err, "Failed to start Dex");
    });

    // Graceful shutdown: failures and timeouts are logged and exit non-zero.
    // Each step has its own budget inside the 8 s overall deadline, so a
    // stalled cleanup batch cannot keep Dex from being signalled. Dex's own
    // stop sends SIGKILL 5 s after SIGTERM, inside its 5.5 s budget.
    const shutdown = createShutdownHandler({
      log: app.log,
      steps: [
        { name: "blob cleanup", run: () => blobCleanup.stop(), timeoutMs: 1_000 },
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
