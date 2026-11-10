import type { Prisma, PrismaClient } from "@prisma/client";
import type { StorageProvider } from "../../services/storage.js";
import type {
  CreateFolderInput,
  UpdateFileInput,
  FileQueryInput,
  CopyFileInput,
} from "@pm/shared";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import crypto from "node:crypto";
import path from "node:path";
import { ZipArchive } from "archiver";
import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../utils/errors.js";
import { batches, graphLimits } from "../../utils/graph-limits.js";
import { withWorkspaceLock } from "../../utils/workspace-lock.js";
import { withSearchPlans } from "../../utils/text-search.js";
import {
  blobPaths,
  cleanupBlobsNow,
  discardStagedBlobs,
} from "../../services/blob-cleanup.js";
import {
  assertFileAccess,
  fileAccessRole,
  fileReadWhere,
  resolveFileDestination,
  type AccessContext,
} from "./file-access.js";
import {
  THUMBNAIL_HEAD_BYTES,
  THUMBNAIL_SOURCE_MAX_BYTES,
  createThumbnail,
} from "./thumbnails.js";

export { THUMBNAIL_SOURCE_MAX_BYTES };

/** The first THUMBNAIL_HEAD_BYTES of a stored file; abandoned when `signal` aborts. */
async function readHead(
  storage: StorageProvider,
  storagePath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const stream = await storage.openReadStream(storagePath, { start: 0, end: THUMBNAIL_HEAD_BYTES - 1 });
  const abandon = () => stream.destroy();
  if (signal.aborted) abandon();
  signal.addEventListener("abort", abandon, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abandon);
    stream.destroy();
  }
}

/**
 * `parentId` is the first ancestor of the row about to be inserted. Delete
 * already returns 409 once a descendant level is past graphLimits.maxDepth,
 * which is a new row with more than maxDepth ancestors. One recursive read
 * follows parents in this workspace and stops on a repeated id, so a legacy
 * cycle cannot loop and the workspace lock is not held for a query per level.
 */
async function assertNewFileWithinDepth(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const maxDepth = graphLimits.maxDepth;
  const over = await tx.$queryRaw<Array<{ depth: number }>>`
    WITH RECURSIVE ancestors AS (
      SELECT id, "parentId", 1 AS depth, ARRAY[id]::text[] AS path
      FROM "File"
      WHERE id = ${parentId} AND "workspaceId" = ${workspaceId}
      UNION ALL
      SELECT parent.id, parent."parentId", ancestors.depth + 1,
             ancestors.path || parent.id
      FROM "File" AS parent
      INNER JOIN ancestors ON parent.id = ancestors."parentId"
      WHERE ancestors.depth <= ${maxDepth}
        AND parent."workspaceId" = ${workspaceId}
        AND NOT (parent.id = ANY(ancestors.path))
    )
    SELECT depth FROM ancestors WHERE depth > ${maxDepth} LIMIT 1
  `;
  if (over.length > 0) graphTooLarge();
}

export async function uploadFileStream(
  prisma: PrismaClient,
  storage: StorageProvider,
  workspaceId: string,
  uploadedById: string,
  parentId: string | undefined,
  fileName: string,
  mimeType: string,
  stream: Readable,
  ctx: AccessContext,
) {
  const destination = await resolveFileDestination(
    prisma,
    { ...ctx, workspaceId },
    parentId,
  );
  const { teamFolderId } = destination;
  const isTeamContext = !!teamFolderId;

  const ext = path.extname(fileName) || "";
  const fileId = crypto.randomUUID();

  const scopeId = isTeamContext ? `groupfolders/${teamFolderId}` : uploadedById;

  // Stream to disk with size enforcement
  const { storagePath, size } = await storage.saveStream(
    `${workspaceId}/files`,
    scopeId,
    fileId,
    ext,
    stream,
    { maxSize: env.MAX_FILE_SIZE },
  );

  // The declared type only decides whether to try. The stored bytes decide
  // whether and how they are decoded, in a memory-limited worker process; a
  // busy server waits a bounded time for a transform turn and then stores the
  // upload without one (thumbnails.ts).
  let thumbnailPath: string | null = null;
  if (
    mimeType.startsWith("image/") &&
    !mimeType.includes("svg") &&
    size <= THUMBNAIL_SOURCE_MAX_BYTES
  ) {
    const thumbBuffer = await createThumbnail(
      {
        size,
        head: (signal) => readHead(storage, storagePath, signal),
        path: await storage.decoderLocation(storagePath),
      },
      { workspaceId, fileId },
    );
    if (thumbBuffer) {
      try {
        thumbnailPath = await storage.save(
          `${workspaceId}/files`,
          scopeId,
          `${fileId}_thumb`,
          ".webp",
          thumbBuffer,
        );
      } catch {
        // Non-blocking: continue without thumbnail
      }
    }
  }

  // Create DB record — clean up file on failure. The destination is resolved
  // again under the workspace graph lock: while bytes streamed, the parent may
  // have been moved to another scope, trashed or deleted, or the uploader's
  // rights may have changed. Stored blob paths are immutable either way.
  try {
    return await withWorkspaceLock(prisma, workspaceId, async (tx) => {
      const current = await resolveFileDestination(
        tx,
        { ...ctx, workspaceId },
        parentId,
      );
      await assertNewFileWithinDepth(tx, workspaceId, current.parentId);
      return tx.file.create({
        data: {
          workspaceId,
          parentId: current.parentId,
          name: fileName,
          mimeType,
          size,
          storagePath,
          isFolder: false,
          uploadedById,
          ownerId: current.ownerId,
          teamFolderId: current.teamFolderId,
          thumbnailPath,
        },
      });
    });
  } catch (err) {
    await discardStagedBlobs(prisma, storage, [storagePath, thumbnailPath]);
    throw err;
  }
}

export async function createFolder(
  prisma: PrismaClient,
  workspaceId: string,
  uploadedById: string,
  input: CreateFolderInput,
  ctx: AccessContext,
) {
  // New children take the workspace graph lock so they cannot escape a
  // concurrent move's scope propagation or land under a deleted parent.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const destination = await resolveFileDestination(
      tx,
      { ...ctx, workspaceId },
      input.parentId,
      input.teamFolderId,
    );
    await assertNewFileWithinDepth(tx, workspaceId, destination.parentId);
    return tx.file.create({
      data: {
        workspaceId,
        ...destination,
        name: input.name,
        isFolder: true,
        uploadedById,
      },
    });
  });
}

/**
 * Files after `at` in the drive listing sorted by size: `isFolder` descending,
 * then `size` and `id` in `order`. Prisma's `cursor` reads every following
 * row without LIMIT when an order column is nullable, so this condition is
 * written out. Null sizes follow PostgreSQL's defaults: last when ascending,
 * first when descending.
 */
function filesAfterBySize(
  at: { id: string; isFolder: boolean; size: bigint | null },
  order: "asc" | "desc",
): Prisma.FileWhereInput {
  const beyond = order === "asc" ? "gt" : "lt";
  const group = { isFolder: at.isFolder };
  const idBeyond = { id: { [beyond]: at.id } };
  const after: Prisma.FileWhereInput[] =
    at.size === null
      ? [
          { ...group, size: null, ...idBeyond },
          ...(order === "desc" ? [{ ...group, size: { not: null } }] : []),
        ]
      : [
          { ...group, size: { [beyond]: at.size } },
          { ...group, size: at.size, ...idBeyond },
          ...(order === "asc" ? [{ ...group, size: null }] : []),
        ];
  // Folders sort before files.
  if (at.isFolder) after.push({ isFolder: false });
  return { OR: after };
}

export async function listFiles(
  prisma: PrismaClient,
  workspaceId: string,
  query: FileQueryInput,
  ctx: AccessContext,
) {
  const {
    parentId,
    teamFolderId,
    search,
    cursor,
    limit,
    trashed,
    sortBy,
    sortOrder,
  } = query;

  const where: Prisma.FileWhereInput = {
    AND: [await fileReadWhere(prisma, { ...ctx, workspaceId }, trashed)],
    workspaceId,
    trashedAt: trashed ? { not: null } : null,
  };
  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  } else if (!trashed && (parentId || teamFolderId)) {
    let folderId = parentId;
    if (!folderId && teamFolderId) {
      const team = await prisma.teamFolder.findFirst({
        where: { id: teamFolderId, workspaceId },
        select: { folderId: true },
      });
      if (!team) throw new NotFoundError("Team folder not found");
      folderId = team.folderId;
    }
    await assertFileAccess(prisma, folderId!, { ...ctx, workspaceId });
    const parent = await prisma.file.findFirst({
      where: { id: folderId!, workspaceId, isFolder: true, trashedAt: null },
      select: { teamFolderId: true, asTeamFolder: { select: { id: true } } },
    });
    if (!parent) throw new NotFoundError("Folder not found");
    if (
      teamFolderId &&
      (parent.asTeamFolder?.id ?? parent.teamFolderId) !== teamFolderId
    )
      throw new ForbiddenError(
        "Destination team folder does not match its parent",
      );
    where.parentId = folderId;
  } else if (!trashed) {
    where.parentId = null;
    where.ownerId = ctx.userId;
  }

  // Folders first, then the sort column, then the unique ID so equal values
  // have one order and the page query can use LIMIT.
  const orderBy: Prisma.FileOrderByWithRelationInput[] = [
    { isFolder: "desc" },
    sortBy === "uploadedBy"
      ? { uploadedBy: { displayName: sortOrder } }
      : { [sortBy]: sortOrder },
    { id: sortOrder },
  ];

  let page: Prisma.FileWhereInput = where;
  let after: { cursor: { id: string }; skip: number } | undefined;
  if (cursor) {
    // A cursor must be one of the listed files; any other ID gives an empty
    // page, as it did before the ID tie-breaker.
    const at = await prisma.file.findFirst({
      where: { AND: [where, { id: cursor }] },
      select: { id: true, isFolder: true, size: true },
    });
    if (!at) return { data: [], nextCursor: null };
    // With the ID last, Prisma's cursor applies LIMIT for the non-null sort
    // columns; size is nullable and takes the written-out condition.
    if (sortBy === "size") page = { AND: [where, filesAfterBySize(at, sortOrder)] };
    else after = { cursor: { id: cursor }, skip: 1 };
  }

  const pageQuery = prisma.file.findMany({
    where: page,
    orderBy,
    take: limit + 1,
    ...after,
    include: {
      uploadedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });
  // A name search is planned for its term (utils/text-search.ts). The cursor
  // lookup above also filters by name but finds one row by ID.
  const files = search ? (await withSearchPlans(prisma, [pageQuery]))[0] : await pageQuery;

  const hasMore = files.length > limit;
  const sliced = hasMore ? files.slice(0, limit) : files;

  // Batch-query starred status for the current user
  const fileIds = sliced.map((f) => f.id);
  const starredSet = new Set(
    fileIds.length > 0
      ? (
          await prisma.starredFile.findMany({
            where: { userId: ctx.userId, fileId: { in: fileIds } },
            select: { fileId: true },
          })
        ).map((s) => s.fileId)
      : [],
  );

  const data = sliced.map((f) => ({ ...f, starred: starredSet.has(f.id) }));

  return {
    data,
    nextCursor: hasMore ? data[data.length - 1].id : null,
  };
}

export async function getFile(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId },
    include: {
      uploadedBy: {
        select: { id: true, displayName: true, avatarUrl: true },
      },
    },
  });

  if (!file) throw new NotFoundError("File not found");

  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  return file;
}

export async function downloadFile(
  storage: StorageProvider,
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId, isFolder: false },
  });

  if (!file || !file.storagePath) {
    throw new NotFoundError("File not found");
  }

  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  const stream = await storage.openReadStream(file.storagePath);
  return { stream, file };
}

export async function updateFile(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  input: UpdateFileInput,
  ctx: AccessContext,
) {
  const access = { ...ctx, workspaceId };
  // Every authorization, ancestry, subtree and scope read is repeated after
  // the workspace graph lock, so concurrent moves, deletes and new children
  // commit in a single order and the subtree update is atomic.
  return withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const existing = await tx.file.findFirst({
      where: { id: fileId, workspaceId },
      include: { asTeamFolder: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundError("File not found");

    await assertFileAccess(tx, fileId, access, true, true);

    if (input.parentId === undefined && input.teamFolderId === undefined) {
      return tx.file.update({
        where: { id: fileId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.trashedAt !== undefined
            ? { trashedAt: input.trashedAt }
            : {}),
        },
      });
    }

    if (existing.asTeamFolder)
      throw new ForbiddenError("Team folder roots cannot be moved");
    const destination = await resolveFileDestination(
      tx,
      access,
      input.parentId,
      input.teamFolderId,
    );
    await assertNotOwnDescendant(tx, workspaceId, fileId, destination.parentId);
    const crossScope =
      existing.teamFolderId !== destination.teamFolderId ||
      existing.ownerId !== destination.ownerId;
    // Walks every child edge (not only folders) so legacy malformed rows are
    // rejected instead of being left in the previous scope.
    const descendants = await collectDescendantFiles(tx, fileId, access);

    const file = await tx.file.update({
      where: { id: fileId, workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...destination,
        ...(input.trashedAt !== undefined
          ? { trashedAt: input.trashedAt }
          : {}),
      },
    });
    if (crossScope)
      for (const batch of batches(descendants.map((d) => d.id)))
        await tx.file.updateMany({
          where: { id: { in: batch }, workspaceId },
          data: {
            teamFolderId: destination.teamFolderId,
            ownerId: destination.ownerId,
          },
        });
    return file;
  });
}

function graphTooLarge(): never {
  throw new ConflictError("Folder tree exceeds the supported depth or size");
}

/** Rejects a destination that is the file itself or inside its subtree,
 * including legacy cycles, with a bounded ancestor walk. */
async function assertNotOwnDescendant(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  fileId: string,
  parentId: string | null,
) {
  if (parentId === fileId)
    throw new ForbiddenError("A folder cannot contain itself");
  const visited = new Set<string>([fileId]);
  let ancestor = parentId;
  while (ancestor) {
    if (visited.has(ancestor))
      throw new ForbiddenError("Invalid folder ancestry");
    if (visited.size > graphLimits.maxDepth) graphTooLarge();
    visited.add(ancestor);
    const row: { parentId: string | null } | null = await tx.file.findFirst({
      where: { id: ancestor, workspaceId },
      select: { parentId: true },
    });
    if (!row) throw new NotFoundError("Destination folder not found");
    ancestor = row.parentId;
  }
}

export async function getFileBreadcrumbs(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  const breadcrumbs: Array<{ id: string; name: string }> = [];
  let currentId: string | null = fileId;

  const visited = new Set<string>();
  // The visited set stops legacy cycles; the depth budget bounds the queries.
  while (
    currentId &&
    !visited.has(currentId) &&
    visited.size < graphLimits.maxDepth
  ) {
    visited.add(currentId);
    try {
      await assertFileAccess(prisma, currentId, { ...ctx, workspaceId });
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError)
        break;
      throw error;
    }
    const found: { id: string; name: string; parentId: string | null } | null =
      await prisma.file.findFirst({
        where: { id: currentId, workspaceId },
        select: { id: true, name: true, parentId: true },
      });

    if (!found) break;
    breadcrumbs.unshift({ id: found.id, name: found.name });
    currentId = found.parentId;
  }

  return breadcrumbs;
}

export async function deleteFile(
  prisma: PrismaClient,
  storage: StorageProvider,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  const access = { ...ctx, workspaceId };
  // Validate the complete current subtree (rights, cycles, foreign or
  // non-folder child edges, budgets) under the graph lock before the cascade.
  // The delete triggers queue every original and thumbnail in the same
  // transaction; they are removed right after the commit when possible and
  // otherwise by the cleanup worker.
  const removed = await withWorkspaceLock(prisma, workspaceId, async (tx) => {
    const file = await tx.file.findFirst({
      where: { id: fileId, workspaceId },
      select: { storagePath: true, thumbnailPath: true },
    });
    if (!file) throw new NotFoundError("File not found");

    await assertFileAccess(tx, fileId, access, true, true);
    const descendants = await collectDescendantFiles(tx, fileId, access);
    await tx.file.delete({ where: { id: fileId } });
    return [file, ...descendants];
  });
  await cleanupBlobsNow(prisma, storage, blobPaths(removed));
}

export async function getFileAttachmentCount(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId },
  });
  if (!file) throw new NotFoundError("File not found");

  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  const count = await prisma.attachment.count({
    where: { fileId },
  });

  return { count };
}

export async function starFile(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId },
  });
  if (!file) throw new NotFoundError("File not found");

  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  await prisma.starredFile.upsert({
    where: { userId_fileId: { userId: ctx.userId, fileId } },
    create: { userId: ctx.userId, fileId },
    update: {},
  });
}

export async function unstarFile(
  prisma: PrismaClient,
  workspaceId: string,
  fileId: string,
  ctx: AccessContext,
) {
  await fileAccessRole(prisma, { ...ctx, workspaceId });
  const file = await prisma.file.findFirst({
    where: { id: fileId, workspaceId },
  });
  if (!file) throw new NotFoundError("File not found");

  await prisma.starredFile.deleteMany({
    where: { userId: ctx.userId, fileId },
  });
}

export async function listStarredFiles(
  prisma: PrismaClient,
  workspaceId: string,
  ctx: AccessContext,
) {
  const starred = await prisma.starredFile.findMany({
    where: {
      userId: ctx.userId,
      file: {
        AND: [await fileReadWhere(prisma, { ...ctx, workspaceId })],
        trashedAt: null,
      },
    },
    include: {
      file: {
        include: {
          uploadedBy: {
            select: { id: true, displayName: true, avatarUrl: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return starred.map((s) => ({ ...s.file, starred: true }));
}

// Same grace as restore staging; expiry can refuse a slow copy.
const STAGED_COPY_GRACE_SECONDS = 60 * 60;

function unavailableCopy() {
  return new AppError(
    503,
    "Service Unavailable",
    "The copy could not keep its stored file; nothing was copied. Please try again.",
  );
}

/** Failure-only cleanup, never a new staging claim followed by a File retry. */
async function discardFailedCopy(
  prisma: PrismaClient,
  storage: StorageProvider,
  plannedPath: string,
) {
  try {
    // Renew the claim identity before cleanup. The worker conditions retirement
    // and retry on attempts + availableAt, so an earlier deletion cannot remove
    // this later write's durable work. Preserve attempts and extend an existing
    // lease by at least one stored millisecond; unclaimed stages become due now.
    // Floor only that due-now instant, retaining its timezone. Dropping to a
    // local wall time would make the repeated fall-back hour ambiguous.
    await prisma.$executeRaw`
      INSERT INTO "BlobCleanup" ("storagePath", "availableAt") VALUES (
        ${plannedPath}, date_trunc('milliseconds', CURRENT_TIMESTAMP))
      ON CONFLICT ("storagePath") DO UPDATE SET "availableAt" =
        CASE WHEN "BlobCleanup"."attempts" = 0
          THEN date_trunc('milliseconds', CURRENT_TIMESTAMP)
        ELSE GREATEST("BlobCleanup"."availableAt" + interval '1 millisecond', CURRENT_TIMESTAMP)
        END`;
  } catch (error) {
    logger.error(
      { err: error, storagePath: plannedPath },
      "Could not renew failed copy cleanup; preserving its known path",
    );
    return;
  }
  // The live-File guard protects an ambiguous successful commit. No File retry
  // follows this failure-only renewal, including when the old row was absent.
  await cleanupBlobsNow(prisma, storage, [plannedPath]);
}

export async function copyFile(
  prisma: PrismaClient,
  storage: StorageProvider,
  workspaceId: string,
  fileId: string,
  input: CopyFileInput,
  ctx: AccessContext,
) {
  const source = await prisma.file.findFirst({
    where: { id: fileId, workspaceId, isFolder: false },
  });

  if (!source || !source.storagePath) {
    throw new NotFoundError("File not found");
  }

  // Assert read access on source
  await assertFileAccess(prisma, fileId, { ...ctx, workspaceId });

  const destination = await resolveFileDestination(
    prisma,
    { ...ctx, workspaceId },
    input.parentId,
    input.teamFolderId,
  );
  const destTeamFolderId = destination.teamFolderId;

  const ext = path.extname(source.name) || "";
  const baseName = source.name.slice(0, source.name.length - ext.length);
  const copyName = `${baseName} (copy)${ext}`;
  const newFileId = crypto.randomUUID();

  const scopeId = destTeamFolderId
    ? `groupfolders/${destTeamFolderId}`
    : ctx.userId;
  // The production LocalStorageProvider uses this same deterministic join.
  const plannedPath = path.join(
    `${workspaceId}/files`, scopeId, `${newFileId}${ext}`,
  );
  let sourceStream: Readable | undefined;
  let staged = false;

  try {
    const inserted = await prisma.$executeRaw`
      INSERT INTO "BlobCleanup" ("storagePath", "availableAt")
      VALUES (${plannedPath}, CURRENT_TIMESTAMP + ${STAGED_COPY_GRACE_SECONDS}::integer * interval '1 second')`;
    if (inserted !== 1) throw unavailableCopy();
    staged = true;

    sourceStream = await storage.openReadStream(source.storagePath);
    const { storagePath, size } = await storage.saveStream(
      `${workspaceId}/files`,
      scopeId,
      newFileId,
      ext,
      sourceStream,
      { maxSize: env.MAX_FILE_SIZE },
    );
    // Do not adopt, queue or delete an arbitrary unexpected returned path.
    if (storagePath !== plannedPath) throw unavailableCopy();

    // Source and destination are rechecked under the existing graph lock.
    return await withWorkspaceLock(prisma, workspaceId, async (tx) => {
      await assertFileAccess(tx, fileId, { ...ctx, workspaceId });
      const current = await resolveFileDestination(
        tx,
        { ...ctx, workspaceId },
        input.parentId,
        input.teamFolderId,
      );
      await assertNewFileWithinDepth(tx, workspaceId, current.parentId);
      const claimed = await tx.$queryRaw<Array<{ storagePath: string }>>`
        DELETE FROM "BlobCleanup"
        WHERE "storagePath" = ${plannedPath} AND "attempts" = 0
        RETURNING "storagePath"`;
      if (claimed.length !== 1) throw unavailableCopy();
      return tx.file.create({
        data: {
          workspaceId,
          ...current,
          name: copyName,
          mimeType: source.mimeType,
          size,
          storagePath,
          isFolder: false,
          uploadedById: ctx.userId,
        },
      });
    });
  } catch (err) {
    if (staged) await discardFailedCopy(prisma, storage, plannedPath);
    throw err;
  } finally {
    sourceStream?.destroy();
  }
}

/**
 * Collects every descendant row with bounded, level-by-level queries. Any
 * cycle, cross-workspace child or child of a non-folder rejects the whole
 * operation, so callers never act on (or let a cascade delete) rows they did
 * not validate. Pass the locked transaction client when the result drives a
 * write.
 */
export async function collectDescendantFiles(
  prisma: Prisma.TransactionClient,
  parentId: string,
  ctx?: AccessContext,
): Promise<
  Array<{ id: string; storagePath: string | null; thumbnailPath: string | null }>
> {
  const root = await prisma.file.findUnique({
    where: { id: parentId },
    select: { workspaceId: true, isFolder: true },
  });
  if (!root || (ctx && root.workspaceId !== ctx.workspaceId))
    throw new NotFoundError("Folder not found");
  const result: Array<{
    id: string;
    storagePath: string | null;
    thumbnailPath: string | null;
  }> = [];
  const isFolder = new Map([[parentId, root.isFolder]]);
  const writableScopes = new Set<string>();
  let parents = [parentId];
  for (let depth = 1; parents.length; depth++) {
    const children = [];
    for (const batch of batches(parents))
      children.push(
        ...(await prisma.file.findMany({
          where: { parentId: { in: batch } },
          select: {
            id: true,
            parentId: true,
            workspaceId: true,
            storagePath: true,
            thumbnailPath: true,
            isFolder: true,
            ownerId: true,
            teamFolderId: true,
            asTeamFolder: { select: { id: true } },
          },
        })),
      );
    if (children.length === 0) break;
    if (depth > graphLimits.maxDepth) graphTooLarge();
    parents = [];
    for (const child of children) {
      if (
        isFolder.has(child.id) ||
        child.workspaceId !== root.workspaceId ||
        !isFolder.get(child.parentId!)
      )
        throw new ForbiddenError("Invalid folder ancestry");
      if (result.length >= graphLimits.maxNodes) graphTooLarge();
      isFolder.set(child.id, child.isFolder);
      // A write check depends only on the effective team and owner, so one
      // check per distinct scope is exact and keeps the locked walk short.
      const scope = `${child.asTeamFolder?.id ?? child.teamFolderId}:${child.ownerId}`;
      if (ctx && !writableScopes.has(scope)) {
        await assertFileAccess(prisma, child.id, ctx, true, true);
        writableScopes.add(scope);
      }
      result.push({
        id: child.id,
        storagePath: child.storagePath,
        thumbnailPath: child.thumbnailPath,
      });
      parents.push(child.id);
    }
  }
  return result;
}

// ── Archive ──────────────────────────────────

interface ArchiveEntry {
  name: string;
  storagePath: string;
}

async function collectFolderEntries(
  prisma: PrismaClient,
  storage: StorageProvider,
  parentId: string,
  prefix: string,
  ctx: AccessContext,
  budget: { nodes: number },
  visited = new Set<string>(),
  depth = 0,
): Promise<ArchiveEntry[]> {
  if (visited.has(parentId))
    throw new ForbiddenError("Invalid folder ancestry");
  visited.add(parentId);
  const children = await prisma.file.findMany({
    where: { parentId, trashedAt: null },
    select: { id: true, name: true, isFolder: true, storagePath: true },
  });
  if (children.length > 0 && depth >= graphLimits.maxDepth) graphTooLarge();

  const entries: ArchiveEntry[] = [];
  for (const child of children) {
    if (++budget.nodes > graphLimits.maxNodes) graphTooLarge();
    await assertFileAccess(prisma, child.id, ctx);
    if (child.isFolder) {
      const nested = await collectFolderEntries(
        prisma,
        storage,
        child.id,
        `${prefix}${child.name}/`,
        ctx,
        budget,
        visited,
        depth + 1,
      );
      entries.push(...nested);
    } else if (child.storagePath) {
      entries.push({
        name: `${prefix}${child.name}`,
        storagePath: child.storagePath,
      });
    }
  }
  return entries;
}

export async function archiveFiles(
  prisma: PrismaClient,
  storage: StorageProvider,
  workspaceId: string,
  fileIds: string[],
  ctx: AccessContext,
): Promise<{ stream: PassThrough; archiveName: string }> {
  // Validate all files belong to workspace and are not trashed
  const files = await prisma.file.findMany({
    where: { id: { in: fileIds }, workspaceId, trashedAt: null },
    select: { id: true, name: true, isFolder: true, storagePath: true },
  });

  if (files.length !== new Set(fileIds).size)
    throw new NotFoundError("File not found");

  // Assert read access on each file
  for (const file of files) {
    await assertFileAccess(prisma, file.id, { ...ctx, workspaceId });
  }

  // Collect all entries, expanding folders within one depth/size budget
  // before any stored bytes are opened.
  const entries: ArchiveEntry[] = [];
  const budget = { nodes: 0 };
  for (const file of files) {
    if (file.isFolder) {
      const nested = await collectFolderEntries(
        prisma,
        storage,
        file.id,
        `${file.name}/`,
        { ...ctx, workspaceId },
        budget,
      );
      entries.push(...nested);
    } else if (file.storagePath) {
      entries.push({ name: file.name, storagePath: file.storagePath });
    }
  }

  // Archive name
  const archiveName =
    files.length === 1 && files[0].isFolder
      ? `${files[0].name}.zip`
      : "files.zip";

  const passthrough = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 6 } });

  archive.on("error", (err) => passthrough.destroy(err));
  archive.pipe(passthrough);

  for (const entry of entries) {
    const fileStream = storage.readStream(entry.storagePath);
    // The archiver pipes each entry without forwarding its errors. A blob that
    // cannot be read (missing, or refused below the storage root) ends the
    // archive and its response instead of becoming an uncaught error.
    fileStream.once("error", (err) => {
      archive.abort();
      passthrough.destroy(err);
    });
    archive.append(fileStream, { name: entry.name });
  }

  archive.finalize();

  return { stream: passthrough, archiveName };
}
