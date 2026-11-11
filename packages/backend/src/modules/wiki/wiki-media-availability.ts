import type { Prisma } from "@prisma/client";
import { ConflictError } from "../../utils/errors.js";
import type { StorageProvider } from "../../services/storage.js";

type Tx = Prisma.TransactionClient;

/** Storage paths named by this document. Null content names nothing. */
export async function wikiMediaPaths(
  tx: Tx,
  content: unknown,
): Promise<string[]> {
  if (content == null) return [];
  const [row] = await tx.$queryRaw<Array<{ paths: string[] | null }>>`
    SELECT wiki_media_storage_paths(${JSON.stringify(content)}::jsonb) AS paths
  `;
  return row?.paths ?? [];
}

/**
 * Paths `next` names that `previous` does not. A title-only save passes
 * `next` as undefined and adopts nothing.
 */
export async function adoptedWikiMedia(
  tx: Tx,
  previous: unknown,
  next: unknown,
): Promise<string[]> {
  if (next === undefined) return [];
  const kept = new Set(await wikiMediaPaths(tx, previous));
  const named = await wikiMediaPaths(tx, next);
  return named.filter((path) => !kept.has(path));
}

/**
 * Lock each path's BlobCleanup row, then refuse the save if the bytes are
 * gone. The sweeper holds that same row across its reference check and
 * delete: whoever locks it first wins. A save that gets the row keeps the
 * bytes with the reference it is about to commit. A save that arrives after
 * the delete does not commit the reference.
 */
export async function assertWikiMediaAvailable(
  tx: Tx,
  storage: Pick<StorageProvider, "exists">,
  paths: readonly string[],
) {
  for (const storagePath of [...new Set(paths)].sort()) {
    await tx.$queryRaw`
      SELECT "storagePath" FROM "BlobCleanup"
      WHERE "storagePath" = ${storagePath}
      FOR UPDATE
    `;
    if (!(await storage.exists(storagePath))) {
      throw new ConflictError("This wiki image is no longer available");
    }
  }
}
