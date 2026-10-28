import { env } from "./config/env.js";
import { buildApp } from "./app.js";
import { cleanupExpiredTokensAndAttempts } from "./modules/auth/auth.service.js";
import { processDueDateReminders } from "./schedulers/due-date-reminders.js";
import { processRecurringTasks } from "./schedulers/recurring-tasks.js";
import { processTrashPurge } from "./schedulers/trash-purge.js";
import { startBlobCleanupWorker } from "./services/blob-cleanup.js";
import { dexManager } from "./services/dex-manager.js";

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

    // Start embedded Dex (SSO identity provider)
    dexManager.start(app.prisma, app.log).catch((err) => {
      app.log.error(err, "Failed to start Dex");
    });

    // Graceful shutdown
    const shutdown = async () => {
      app.log.info("Shutting down...");
      await blobCleanup.stop();
      await dexManager.stop();
      await app.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
