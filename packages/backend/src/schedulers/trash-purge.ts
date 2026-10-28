import type { PrismaClient } from "@prisma/client";
import type { StorageProvider } from "../services/storage.js";
import { collectDescendantFiles } from "../modules/files/files.service.js";
import { withWorkspaceLock } from "../utils/workspace-lock.js";

const BATCH_SIZE = 100;
const PURGE_AFTER_DAYS = 30;

export async function processTrashPurge(
  prisma: PrismaClient,
  storage: StorageProvider,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PURGE_AFTER_DAYS);

  let totalPurged = 0;
  let hasMore = true;

  while (hasMore) {
    const files = await prisma.file.findMany({
      where: {
        trashedAt: { lt: cutoff },
        workspaceId: { not: undefined },
      },
      select: { id: true, workspaceId: true },
      take: BATCH_SIZE,
    });

    if (files.length === 0) {
      hasMore = false;
      break;
    }

    // One workspace at a time, in id order, without holding any file lock
    // while waiting for a Workspace lock. Each candidate is re-read after the
    // lock: it may have been restored, or already removed by a parent cascade.
    files.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    for (const file of files) {
      const storagePaths = await withWorkspaceLock(
        prisma,
        file.workspaceId,
        async (tx) => {
          const current = await tx.file.findFirst({
            where: { id: file.id, trashedAt: { lt: cutoff } },
            select: { storagePath: true, thumbnailPath: true },
          });
          if (!current) return null;
          const descendants = await collectDescendantFiles(tx, file.id);
          // Delete DB record (cascade deletes children for folders)
          await tx.file.delete({ where: { id: file.id } });
          return [
            current.storagePath,
            current.thumbnailPath,
            ...descendants.map((d) => d.storagePath),
          ].filter((sp): sp is string => !!sp);
        },
        { onMissing: () => null },
      );
      if (!storagePaths) continue;

      // Delete storage files
      for (const sp of storagePaths) {
        await storage.delete(sp).catch(() => {});
      }

      totalPurged++;
    }

    hasMore = files.length === BATCH_SIZE;
  }

  return totalPurged;
}
