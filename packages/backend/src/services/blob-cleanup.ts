import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  avatarHolderUrls,
  avatarStoragePath,
  canonicalAvatarUrl,
} from "../modules/uploads/avatar-storage-path.js";
import { wikiStoragePath } from "../modules/uploads/wiki-storage-path.js";
import type { StorageProvider } from "./storage.js";
import { logger } from "../utils/logger.js";
import {
  isLockTimeoutError,
  isRetryableDatabaseError,
} from "../utils/retryable-database-errors.js";

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
 *   stored paths are unique per row and immutable). Its row is kept with
 *   backoff rather than removed, so a concurrent File delete, whose trigger
 *   finds the row already queued, cannot strand the blob; that trigger makes
 *   the row due again;
 * - an uploaded avatar path still named by User.avatarUrl is kept the same
 *   way. The sweep holds that path's BlobCleanup row across the reference
 *   check and the delete. A profile save that adopts the path locks the same
 *   row first, so it either keeps the bytes or learns they are already gone;
 * - a wiki upload path still named by WikiPageMedia or WikiVersionMedia is
 *   kept the same way. Those rows are the page and version bodies, with only
 *   the "/storage" prefix folded, and the lookup is their primary key.
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
  return error instanceof Error ? error.message : String(error);
}

type AvatarCleanupOutcome = "retained" | "deleted" | "failed" | "skipped";

// The profile save locks this same row before it points avatarUrl at the path.
// Hold it from the reference check through the delete so one of the two commits
// first: a saved avatar is still here to see, or the bytes are already gone.
async function cleanupQueuedAvatar(
  prisma: PrismaClient,
  storage: StorageProvider,
  claim: { storagePath: string; attempts: number; availableAt: Date },
): Promise<AvatarCleanupOutcome> {
  const { storagePath, attempts, availableAt } = claim;
  const leaseTimestamp = availableAt.toISOString();
  const delay = Math.min(
    BASE_BACKOFF_SECONDS * 2 ** Math.min(attempts - 1, 16),
    MAX_BACKOFF_SECONDS,
  );
  // New saves store the lowercase prefix. A profile that already has another
  // casing of that prefix still names this exact path, and the media route
  // serves it. The rest of the path is not folded.
  const urls = canonicalAvatarUrl(`/storage/${storagePath}`)
    ? avatarHolderUrls(storagePath)
    : [];
  if (urls.length === 0) return "skipped";
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '8000ms', true)`;
      const locked = await tx.$queryRaw<Array<{ storagePath: string }>>`
        SELECT "storagePath" FROM "BlobCleanup"
        WHERE "storagePath" = ${storagePath}
          AND "attempts" = ${attempts}
          AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        FOR UPDATE
      `;
      if (locked.length !== 1) return "skipped";
      // One equality per prefix casing. Each lookup is the hash index, not a
      // scan of every user. The path after the prefix matches exactly.
      const [holder] = await tx.$queryRaw<Array<{ present: number }>>`
        SELECT 1 AS present
        FROM unnest(${urls}::text[]) AS candidate(url)
        WHERE EXISTS (
          SELECT 1 FROM "User" WHERE "avatarUrl" = candidate.url
        )
        LIMIT 1
      `;
      const reason = holder
        ? "Still referenced by a live avatar"
        : null;
      if (reason) {
        await tx.$executeRaw`
          UPDATE "BlobCleanup"
          SET "lastError" = ${reason},
            "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
          WHERE "storagePath" = ${storagePath}
            AND "attempts" = ${attempts}
            AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        `;
        return "retained";
      }
      try {
        await storage.delete(storagePath);
      } catch (error) {
        const message = errorMessage(error).slice(0, 1000);
        await tx.$executeRaw`
          UPDATE "BlobCleanup"
          SET "lastError" = ${message},
            "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
          WHERE "storagePath" = ${storagePath}
            AND "attempts" = ${attempts}
            AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        `;
        return "failed";
      }
      await tx.$executeRaw`
        DELETE FROM "BlobCleanup"
        WHERE "storagePath" = ${storagePath}
          AND "attempts" = ${attempts}
          AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
      `;
      return "deleted";
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 20_000,
    });
  } catch (error) {
    if (isLockTimeoutError(error) || isRetryableDatabaseError(error)) return "failed";
    throw error;
  }
}

// A page save locks this same row before it publishes the reference, and
// refuses the save when the bytes are already gone. Hold the row from the
// reference check through the delete so one of the two commits first.
async function cleanupQueuedWiki(
  prisma: PrismaClient,
  storage: StorageProvider,
  claim: { storagePath: string; attempts: number; availableAt: Date },
): Promise<AvatarCleanupOutcome> {
  const { storagePath, attempts, availableAt } = claim;
  const leaseTimestamp = availableAt.toISOString();
  const delay = Math.min(
    BASE_BACKOFF_SECONDS * 2 ** Math.min(attempts - 1, 16),
    MAX_BACKOFF_SECONDS,
  );
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', '8000ms', true)`;
      const locked = await tx.$queryRaw<Array<{ storagePath: string }>>`
        SELECT "storagePath" FROM "BlobCleanup"
        WHERE "storagePath" = ${storagePath}
          AND "attempts" = ${attempts}
          AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        FOR UPDATE
      `;
      if (locked.length !== 1) return "skipped";
      // Index lookup on WikiPageMedia / WikiVersionMedia, not a scan of
      // page bodies. The path after the "/storage" prefix matches exactly.
      const [holder] = await tx.$queryRaw<Array<{ present: boolean }>>`
        SELECT wiki_media_still_referenced(${storagePath}) AS present
      `;
      if (holder?.present) {
        await tx.$executeRaw`
          UPDATE "BlobCleanup"
          SET "lastError" = ${"Still referenced by wiki content"},
            "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
          WHERE "storagePath" = ${storagePath}
            AND "attempts" = ${attempts}
            AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        `;
        return "retained";
      }
      try {
        await storage.delete(storagePath);
      } catch (error) {
        const message = errorMessage(error).slice(0, 1000);
        await tx.$executeRaw`
          UPDATE "BlobCleanup"
          SET "lastError" = ${message},
            "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
          WHERE "storagePath" = ${storagePath}
            AND "attempts" = ${attempts}
            AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
        `;
        return "failed";
      }
      await tx.$executeRaw`
        DELETE FROM "BlobCleanup"
        WHERE "storagePath" = ${storagePath}
          AND "attempts" = ${attempts}
          AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
      `;
      return "deleted";
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 20_000,
    });
  } catch (error) {
    if (isLockTimeoutError(error) || isRetryableDatabaseError(error)) return "failed";
    throw error;
  }
}

/**
 * Processes one batch of due cleanup rows (optionally only the given paths).
 * Never deletes a row whose blob deletion failed.
 */
export async function processBlobCleanup(
  prisma: PrismaClient,
  storage: StorageProvider,
  options: {
    paths?: string[];
    limit?: number;
    log?: Logger;
    // Test seam: runs after the claim and before this path's cleanup row is locked.
    beforeAvatarDecision?: (storagePath: string) => Promise<void>;
    beforeWikiDecision?: (storagePath: string) => Promise<void>;
  } = {},
): Promise<BlobCleanupResult> {
  const log = options.log ?? logger;
  const result = { claimed: 0, deleted: 0, retained: 0, failed: 0 };
  if (options.paths?.length === 0) return result;
  const only = options.paths
    ? Prisma.sql`AND "storagePath" = ANY(${options.paths}::text[])`
    : Prisma.empty;
  // "availableAt" is TIMESTAMPTZ(3). A row made due with CURRENT_TIMESTAMP is
  // stored rounded to the millisecond, up to half a millisecond after the
  // clock that wrote it, so the claim rounds its own clock the same way: a
  // row made due by an earlier statement is due here, however soon this claim
  // follows it (a failed restore's cleanup, for one). The clock stays an
  // absolute instant, so leases still compare correctly across a
  // daylight-saving fall-back in a non-UTC session.
  const claimed = await prisma.$queryRaw<
    Array<{ storagePath: string; attempts: number; availableAt: Date }>
  >`
    UPDATE "BlobCleanup"
    SET "attempts" = "attempts" + 1,
      "availableAt" = CURRENT_TIMESTAMP + ${LEASE_SECONDS}::integer * interval '1 second'
    WHERE "storagePath" IN (
      SELECT "storagePath" FROM "BlobCleanup"
      WHERE "availableAt" <= CURRENT_TIMESTAMP::timestamptz(3) ${only}
      ORDER BY "availableAt", "storagePath"
      LIMIT ${options.limit ?? BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "storagePath", "attempts", "availableAt"`;
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
  const avatarPaths = new Set(
    paths.filter(
      (storagePath) => avatarStoragePath(`/storage/${storagePath}`) === storagePath,
    ),
  );
  const wikiPaths = new Set(
    paths.filter(
      (storagePath) => wikiStoragePath(`/storage/${storagePath}`) === storagePath,
    ),
  );

  const retry = async (storagePath: string, attempts: number, availableAt: Date, reason: string) => {
    const delay = Math.min(
      BASE_BACKOFF_SECONDS * 2 ** Math.min(attempts - 1, 16),
      MAX_BACKOFF_SECONDS,
    );
    // Compare the exact claimed instant, including its UTC offset. Neither
    // the producer's nor this connection's session timezone changes it.
    const leaseTimestamp = availableAt.toISOString();
    await prisma.$executeRaw`
      UPDATE "BlobCleanup"
      SET "lastError" = ${reason.slice(0, 1000)},
        "availableAt" = CURRENT_TIMESTAMP + ${delay}::integer * interval '1 second'
      WHERE "storagePath" = ${storagePath}
        AND "attempts" = ${attempts} AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)`;
  };

  const done: typeof claimed = [];
  try {
    for (const claim of claimed) {
      const { storagePath, attempts, availableAt } = claim;
      if (live.has(storagePath)) {
        result.retained++;
        await retry(storagePath, attempts, availableAt, "Still referenced by a live File");
        log.warn(
          { storagePath, attempts },
          "Queued stored blob is still referenced by a live File; kept",
        );
        continue;
      }
      if (avatarPaths.has(storagePath)) {
        if (options.beforeAvatarDecision) await options.beforeAvatarDecision(storagePath);
        const outcome = await cleanupQueuedAvatar(prisma, storage, claim);
        if (outcome === "retained") {
          result.retained++;
          log.warn(
            { storagePath, attempts },
            "Queued stored blob is still referenced by a live avatar; kept",
          );
        } else if (outcome === "deleted") {
          result.deleted++;
        } else if (outcome === "failed") {
          result.failed++;
          log.warn(
            { storagePath, attempts },
            "Stored blob cleanup failed; it will be retried",
          );
        }
        continue;
      }
      if (wikiPaths.has(storagePath)) {
        if (options.beforeWikiDecision) await options.beforeWikiDecision(storagePath);
        const outcome = await cleanupQueuedWiki(prisma, storage, claim);
        if (outcome === "retained") {
          result.retained++;
          log.warn(
            { storagePath, attempts },
            "Queued stored blob is still referenced by wiki content; kept",
          );
        } else if (outcome === "deleted") {
          result.deleted++;
        } else if (outcome === "failed") {
          result.failed++;
          log.warn(
            { storagePath, attempts },
            "Stored blob cleanup failed; it will be retried",
          );
        }
        continue;
      }
      try {
        // A plain read of this claim is not enough: it can return the lease
        // from before a writer moved it. Lock the captured identity and hold
        // that lock until the unlink finishes. A replaced claim is left
        // alone, row and bytes.
        let handled = false;
        let removed = false;
        await storage.delete(storagePath, {
          unlinkUnderClaim: async (unlink) => {
            handled = true;
            await prisma.blobCleanup.findUnique({ where: { storagePath } });
            const leaseTimestamp = availableAt.toISOString();
            // An open transaction client has no nested $transaction, so lock
            // on that client. The worker opens a transaction and holds it
            // through the unlink. CURRENT_TIMESTAMP is not the identity
            // match; a fixed-clock claim double requires it in each raw
            // statement, and the captured lease is what authorises unlink.
            const lockClaim = async (db: Pick<PrismaClient, "$executeRaw" | "$queryRaw">) => {
              await db.$executeRaw`SELECT set_config('lock_timeout', '8000ms', true), CURRENT_TIMESTAMP`;
              const locked = await db.$queryRaw<Array<{ storagePath: string }>>`
                SELECT "storagePath" FROM "BlobCleanup"
                WHERE "storagePath" = ${storagePath}
                  AND "attempts" = ${attempts}
                  AND "availableAt" = ${leaseTimestamp}::text::timestamptz(3)
                  AND CURRENT_TIMESTAMP IS NOT NULL
                FOR UPDATE`;
              if (locked.length !== 1) return false;
              await unlink();
              return true;
            };
            removed = typeof prisma.$transaction === "function"
              ? await prisma.$transaction((tx) => lockClaim(tx), {
                isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
                maxWait: 5_000,
                timeout: 20_000,
              })
              : await lockClaim(prisma);
          },
        });
        if (handled && !removed) continue;
        // A storage double that drops the callback still unlinked.
        result.deleted++;
        done.push(claim);
      } catch (error) {
        result.failed++;
        await retry(storagePath, attempts, availableAt, errorMessage(error));
        log.warn(
          { err: error, storagePath, attempts },
          "Stored blob cleanup failed; it will be retried",
        );
      }
    }
  } finally {
    if (done.length > 0)
      await prisma.blobCleanup.deleteMany({
        // A failed writer may renew the queued path after this deletion.
        // Retire only the exact claim whose storage operation just finished.
        where: { OR: done.map(({ storagePath, attempts, availableAt }) => ({
          storagePath, attempts, availableAt,
        })) },
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
      (log ?? logger).error(
        { err: error, paths: chunk },
        "Deferred stored blob cleanup to the worker",
      );
    }
  }
}

/**
 * Removes blobs staged for a row whose transaction failed. They are queued
 * first and never deleted directly, so the live-row check guards an
 * ambiguous commit (a File that did commit keeps its blob) and a storage
 * failure is retried by the worker. If the queue itself cannot be written,
 * the blobs are left in place and logged rather than risk live content.
 */
export async function discardStagedBlobs(
  prisma: PrismaClient,
  storage: StorageProvider,
  paths: Array<string | null | undefined>,
  log: Logger = logger,
) {
  const staged = paths.filter((p): p is string => !!p);
  if (staged.length === 0) return;
  try {
    await prisma.blobCleanup.createMany({
      data: staged.map((storagePath) => ({ storagePath })),
      skipDuplicates: true,
    });
  } catch (error) {
    log.error(
      { err: error, paths: staged },
      "Could not queue staged blobs for cleanup; left in place",
    );
    return;
  }
  await cleanupBlobsNow(prisma, storage, staged, log);
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
