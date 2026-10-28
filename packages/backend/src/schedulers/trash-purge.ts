import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "../services/storage.js";
import { collectDescendantFiles } from "../modules/files/files.service.js";
import { withWorkspaceLock } from "../utils/workspace-lock.js";
import { blobPaths, cleanupBlobsNow } from "../services/blob-cleanup.js";

const BATCH_SIZE = 100;
const PURGE_AFTER_DAYS = 30;

export async function processTrashPurge(
  prisma: PrismaClient,
  storage: StorageProvider,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PURGE_AFTER_DAYS);

  let totalPurged = 0;
  let cursor: string | undefined;
  const skipped: unknown[] = [];

  // Pages by id so a candidate that cannot be purged (a malformed or
  // over-budget tree, or a busy workspace) is skipped for this run instead of
  // being selected first forever and blocking every other workspace.
  while (true) {
    const files = await prisma.file.findMany({
      where: {
        trashedAt: { lt: cutoff },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      select: { id: true, workspaceId: true },
      take: BATCH_SIZE,
    });
    if (files.length === 0) break;
    cursor = files[files.length - 1].id;

    // Each candidate takes only its own workspace lock, never while holding
    // another, and is re-read after it: it may have been restored, or already
    // removed by a parent cascade.
    for (const file of files) {
      let storagePaths: string[] | null;
      try {
        storagePaths = await withWorkspaceLock(
          prisma,
          file.workspaceId,
          async (tx) => {
            const current = await tx.file.findFirst({
              where: { id: file.id, trashedAt: { lt: cutoff } },
              select: { storagePath: true, thumbnailPath: true },
            });
            if (!current) return null;
            const descendants = await collectDescendantFiles(tx, file.id);
            // Delete DB record (cascade deletes children for folders). The
            // delete triggers queue every original and thumbnail durably.
            await tx.file.delete({ where: { id: file.id } });
            return blobPaths([current, ...descendants]);
          },
          { onMissing: () => null },
        );
      } catch (error) {
        skipped.push(error);
        continue;
      }
      if (!storagePaths) continue;

      // Storage failures stay queued with backoff for the cleanup worker.
      await cleanupBlobsNow(prisma, storage, storagePaths);

      totalPurged++;
    }
  }

  if (skipped.length > 0)
    throw new AggregateError(
      skipped,
      `Trash purge removed ${totalPurged} item(s) and skipped ${skipped.length}`,
    );
  return totalPurged;
}
