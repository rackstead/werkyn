import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { StorageProvider } from "./storage.js";

/**
 * Durable blob cleanup.
 *
 * Database triggers write a "BlobCleanup" row in the same transaction that
 * deletes a File (original and thumbnail), a legacy Attachment upload, or the
 * Task/Comment/workspace that cascades them. This module removes the stored
 * blob and then the row:
 *
 * - claims are leased with FOR UPDATE SKIP LOCKED, so concurrent workers and
 *   request-time cleanup never process a row twice at once, and a worker that
 *   dies mid-batch only delays its rows until the lease expires;
 * - a blob that is already gone counts as deleted, so every retry converges;
 * - other storage errors keep the row with exponential backoff and the error;
 * - a path still named by a live File row is never deleted (defense in depth;
 *   stored paths are unique per row and immutable).
 */

const BATCH_SIZE = 100;
const LEASE_SECONDS = 15 * 60;
const BASE_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 6 * 60 * 60;

type Logger = Pick<FastifyBaseLogger, "warn" | "error">;

export interface BlobCleanupResult {
  claimed: number;
  deleted: number;
  retained: number;
  failed: number;
}

/** Original and thumbnail paths of the given rows. */
export function blobPaths(
  rows: Array<{ storagePath?: string | null; thumbnailPath?: string | null }>,
) {
  return rows.flatMap((row) =>
    [row.storagePath, row.thumbnailPath].filter((p): p is string => !!p),
  );
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

/**
 * Processes one batch of due cleanup rows (optionally only the given paths).
 * Never deletes a row whose blob deletion failed.
 */
export async function processBlobCleanup(
  prisma: PrismaClient,
  storage: StorageProvider,
  options: { paths?: string[]; limit?: number; log?: Logger } = {},
): Promise<BlobCleanupResult> {
  const result = { claimed: 0, deleted: 0, retained: 0, failed: 0 };
  if (options.paths?.length === 0) return result;
  const only = options.paths
    ? Prisma.sql`AND "storagePath" = ANY(${options.paths}::text[])`
    : Prisma.empty;
  const claimed = await prisma.$queryRaw<
    Array<{ storagePath: string; attempts: number }>
  >`
    UPDATE "BlobCleanup"
    SET "attempts" = "attempts" + 1,
      "availableAt" = CURRENT_TIMESTAMP + ${LEASE_SECONDS}::integer * interval '1 second'
    WHERE "storagePath" IN (
      SELECT "storagePath" FROM "BlobCleanup"
      WHERE "availableAt" <= CURRENT_TIMESTAMP ${only}
      ORDER BY "availableAt", "storagePath"
      LIMIT ${options.limit ?? BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "storagePath", "attempts"`;
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const paths = claimed.map((row) => row.storagePath);
  const live = new Set(
    blobPaths(
      await prisma.file.findMany({
        where: {
          OR: [{ storagePath: { in: paths } }, { thumbnailPath: { in: paths } }],
        },
        select: { storagePath: true, thumbnailPath: true },
      }),
    ),
  );

  const done: string[] = [];
  try {
    for (const { storagePath, attempts } of claimed) {
      if (live.has(storagePath)) {
        result.retained++;
        done.push(storagePath);
        continue;
      }
      try {
        await storage.delete(storagePath);
        result.deleted++;
        done.push(storagePath);
      } catch (error) {
        result.failed++;
        const delay = Math.min(
          BASE_BACKOFF_SECONDS * 2 ** Math.min(attempts - 1, 16),
          MAX_BACKOFF_SECONDS,
        );
        await prisma.$executeRaw`
          UPDATE "BlobCleanup"
          SET "lastError" = ${errorMessage(error)},
            "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
          WHERE "storagePath" = ${storagePath}`;
        options.log?.warn(
          { err: error, storagePath, attempts },
          "Stored blob cleanup failed; it will be retried",
        );
      }
    }
  } finally {
    if (done.length > 0)
      await prisma.blobCleanup.deleteMany({
        where: { storagePath: { in: done } },
      });
  }
  return result;
}

/**
 * Request-time cleanup right after the deleting transaction committed. The
 * rows are already durable, so a failure here only defers the work to the
 * background worker and never fails the committed request.
 */
export async function cleanupBlobsNow(
  prisma: PrismaClient,
  storage: StorageProvider,
  paths: string[],
  log?: Logger,
) {
  const unique = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    try {
      await processBlobCleanup(prisma, storage, {
        paths: chunk,
        limit: chunk.length,
        log,
      });
    } catch (error) {
      log?.error(error, "Deferred stored blob cleanup to the worker");
    }
  }
}

/**
 * Removes blobs staged for a row whose transaction failed. They are queued
 * first, so the live-row check guards an ambiguous commit and a storage
 * failure is retried by the worker.
 */
export async function discardStagedBlobs(
  prisma: PrismaClient,
  storage: StorageProvider,
  paths: Array<string | null | undefined>,
) {
  const staged = paths.filter((p): p is string => !!p);
  if (staged.length === 0) return;
  try {
    await prisma.blobCleanup.createMany({
      data: staged.map((storagePath) => ({ storagePath })),
      skipDuplicates: true,
    });
  } catch {
    // Database unavailable: fall back to a best-effort direct delete.
    for (const storagePath of staged)
      await storage.delete(storagePath).catch(() => {});
    return;
  }
  await cleanupBlobsNow(prisma, storage, staged);
}

export interface BlobCleanupWorker {
  /** Runs a sweep now, or joins the one in progress. */
  run(): Promise<void>;
  /** Stops scheduling and waits for the batch in progress to finish. */
  stop(): Promise<void>;
}

/**
 * Background sweeper for queued rows left by crashes, storage failures and
 * cascades without request-time cleanup (task, comment, workspace and user
 * deletion). Each run is bounded; remaining rows wait for the next interval.
 */
export function startBlobCleanupWorker(
  app: { prisma: PrismaClient; storage: StorageProvider; log: Logger },
  options: {
    initialDelayMs?: number;
    intervalMs?: number;
    maxBatchesPerRun?: number;
  } = {},
): BlobCleanupWorker {
  const {
    initialDelayMs = 30_000,
    intervalMs = 5 * 60_000,
    maxBatchesPerRun = 50,
  } = options;
  let stopped = false;
  let running: Promise<void> | undefined;

  const run = () => {
    if (stopped) return running ?? Promise.resolve();
    running ??= (async () => {
      for (let batch = 0; batch < maxBatchesPerRun && !stopped; batch++) {
        const result = await processBlobCleanup(app.prisma, app.storage, {
          log: app.log,
        });
        if (result.claimed < BATCH_SIZE) break;
      }
    })()
      .catch((error) => app.log.error(error, "Stored blob cleanup sweep failed"))
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const initial = setTimeout(run, initialDelayMs);
  const interval = setInterval(run, intervalMs);
  return {
    run,
    async stop() {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
      await running;
    },
  };
}
