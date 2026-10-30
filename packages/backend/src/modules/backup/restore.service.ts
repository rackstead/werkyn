import crypto from "node:crypto";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BackupFile, RestoreSummary } from "@pm/shared";
import type { StorageProvider } from "../../services/storage.js";
import { cleanupBlobsNow } from "../../services/blob-cleanup.js";
import { AppError, ForbiddenError, NotFoundError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { lockWorkspace } from "../../utils/workspace-lock.js";
import type { BackupArchiveAsset } from "./backup-archive.js";
import { parseBackupJson } from "./backup-json.js";
import {
  RESTORE_TABLES,
  assetMatcher,
  emptyCounts,
  mapUsers,
  planRestore,
  restoreSummary,
  rewriteAssetPaths,
  type RestoreRow,
  type RestoreRows,
  type RestoreTable,
  type RestoreTarget,
} from "./restore-plan.js";
import { MAX_RESTORE_JSON_DEPTH, validateBackup } from "./restore-validation.js";

/**
 * Backup restore (docs/remediation/backup-restore.md).
 *
 * 1. The file is parsed within the restore limits and validated as a whole
 *    (restore-validation.ts); any refusal happens before a write.
 * 2. Archive files that a wiki page refers to are written to storage. Each
 *    one is first queued for deletion in "BlobCleanup", due an hour later,
 *    so a crash at any later point leaves nothing behind for long.
 * 3. One transaction locks the workspace, re-checks the administrator,
 *    takes the restored files off the cleanup queue, and inserts the planned
 *    rows (restore-plan.ts) in batches. Any failure rolls every row back and
 *    the files are removed right away; a commit keeps both.
 *
 * Preview runs steps 1 and the plan without writing, so its counts, warnings
 * and refusals are the ones restore produces for the same file and members.
 */

/** Parse and validate a backup JSON buffer within the restore limits. */
function parseBackupFile(buffer: Buffer): BackupFile {
  const backup = parseBackupJson(buffer);
  validateBackup(backup);
  return backup;
}

type Db = PrismaClient | Prisma.TransactionClient;

async function loadTarget(
  db: Db,
  workspaceId: string,
  adminUserId: string,
  assetUrls: ReadonlyMap<string, string>,
): Promise<RestoreTarget> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId },
    select: { role: true, user: { select: { id: true, email: true, displayName: true } } },
  });
  const spaces = await db.wikiSpace.findMany({
    where: { workspaceId },
    select: { slug: true, position: true },
  });
  return {
    workspaceId,
    adminUserId,
    members: members.map((m) => ({ ...m.user, role: m.role })),
    takenSlugs: new Set(spaces.map((s) => s.slug)),
    nextWikiSpacePosition: spaces.reduce((max, s) => Math.max(max, s.position), -1) + 1,
    assetUrls,
  };
}

// ─── Assets ─────────────────────────────────────────────

interface PlannedAsset {
  assetPath: string;
  asset: BackupArchiveAsset;
  fileId: string;
  ext: string;
  storagePath: string;
}

interface AssetPlan {
  /** Archive files some wiki page refers to, in archive order. */
  used: PlannedAsset[];
  unused: number;
}

const assetCategory = (workspaceId: string) => `${workspaceId}/uploads`;
const ASSET_SCOPE = "wiki/imports";
const assetUrl = (storagePath: string) => `/storage/${storagePath}`;

/**
 * Names a storage path for every `assets/` entry and keeps the ones that a
 * wiki page refers to; the others would be files nothing points at, so they
 * are not written. The check uses the same matcher as the content rewrite,
 * which then replaces exactly these paths.
 */
function planAssets(
  workspaceId: string,
  backup: BackupFile,
  assets: ReadonlyMap<string, BackupArchiveAsset> | undefined,
): AssetPlan {
  const planned: PlannedAsset[] = [];
  for (const [assetPath, asset] of assets ?? []) {
    if (!assetPath.startsWith("assets/")) continue;
    const ext = path.extname(path.basename(assetPath)) || ".bin";
    const fileId = crypto.randomUUID();
    const storagePath = path.join(assetCategory(workspaceId), ASSET_SCOPE, `${fileId}${ext}`);
    planned.push({ assetPath, asset, fileId, ext, storagePath });
  }
  if (planned.length === 0) return { used: [], unused: 0 };
  const matcher = assetMatcher(new Map(planned.map((a) => [a.assetPath, assetUrl(a.storagePath)])));
  const hits = new Set<string>();
  for (const space of backup.wikiSpaces)
    for (const page of space.pages) rewriteAssetPaths(page.content, matcher, hits);
  const used = planned.filter((a) => hits.has(a.assetPath));
  return { used, unused: planned.length - used.length };
}

/**
 * How long a restored file stays queued for deletion if its restore never
 * commits or rolls back (a crash). Restore removes the queue entry in its
 * transaction, which takes far less than this.
 */
const STAGED_ASSET_GRACE_SECONDS = 60 * 60;

/** Queue the paths, then write the files; a failure removes what was written. */
async function stageAssets(
  prisma: PrismaClient,
  storage: StorageProvider,
  workspaceId: string,
  assets: PlannedAsset[],
): Promise<void> {
  if (assets.length === 0) return;
  const paths = assets.map((a) => a.storagePath);
  await prisma.$executeRaw`
    INSERT INTO "BlobCleanup" ("storagePath", "availableAt")
    SELECT p, CURRENT_TIMESTAMP + ${STAGED_ASSET_GRACE_SECONDS}::integer * interval '1 second'
    FROM unnest(${paths}::text[]) AS p`;
  try {
    for (const a of assets) {
      // Streamed from the staged archive; never held in memory whole.
      const content = a.asset.open();
      let saved: string;
      try {
        ({ storagePath: saved } = await storage.saveStream(
          assetCategory(workspaceId),
          ASSET_SCOPE,
          a.fileId,
          a.ext,
          content,
        ));
      } finally {
        content.destroy();
      }
      if (saved !== a.storagePath) {
        await storage.delete(saved).catch(() => {});
        throw new Error("Storage stored a restored file under an unexpected path");
      }
    }
  } catch (error) {
    await discardStagedAssets(prisma, storage, paths);
    throw error;
  }
}

/**
 * Inside the restore transaction: the queued paths stop being cleanup work
 * when (and only if) the transaction commits. A row the cleanup worker has
 * already claimed (attempts > 0) may have lost its file, so the restore stops.
 */
async function claimStagedAssets(tx: Prisma.TransactionClient, paths: string[]) {
  if (paths.length === 0) return;
  const claimed = await tx.$queryRaw<Array<{ storagePath: string }>>`
    DELETE FROM "BlobCleanup"
    WHERE "storagePath" = ANY(${paths}::text[]) AND "attempts" = 0
    RETURNING "storagePath"`;
  if (claimed.length !== paths.length)
    throw new AppError(
      503,
      "Service Unavailable",
      "The restore took too long to keep its files; nothing was restored. Please try again.",
    );
}

/**
 * After a failed restore: make the queued paths due now and remove them. If
 * the transaction did commit after all, its rows are gone and nothing is
 * removed. When the queue cannot be updated, the worker removes the files
 * once the grace period ends.
 */
async function discardStagedAssets(prisma: PrismaClient, storage: StorageProvider, paths: string[]) {
  if (paths.length === 0) return;
  try {
    await prisma.$executeRaw`
      UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP
      WHERE "storagePath" = ANY(${paths}::text[])`;
  } catch (error) {
    logger.error({ err: error }, "Could not schedule removal of files from a failed restore; the cleanup worker removes them later");
    return;
  }
  await cleanupBlobsNow(prisma, storage, paths);
}

// ─── Writing ────────────────────────────────────────────

/**
 * Row IDs in Prisma's cuid shape (25 lowercase characters, time first), made
 * here so batched inserts can reference rows they have not read back.
 */
let idCounter = 0;
function newRowId(): string {
  idCounter = (idCounter + 1) % 1_679_616;
  return (
    "c" +
    Date.now().toString(36).padStart(8, "0") +
    idCounter.toString(36).padStart(4, "0") +
    crypto.randomUUID().replace(/-/g, "").slice(0, 12)
  );
}

const INSERT: { [K in RestoreTable]: (tx: Prisma.TransactionClient, data: RestoreRows[K][]) => Promise<unknown> } = {
  project: (tx, data) => tx.project.createMany({ data }),
  statusColumn: (tx, data) => tx.statusColumn.createMany({ data }),
  label: (tx, data) => tx.label.createMany({ data }),
  customField: (tx, data) => tx.customField.createMany({ data }),
  projectMember: (tx, data) => tx.projectMember.createMany({ data }),
  task: (tx, data) => tx.task.createMany({ data }),
  taskAssignee: (tx, data) => tx.taskAssignee.createMany({ data }),
  taskLabel: (tx, data) => tx.taskLabel.createMany({ data }),
  subtask: (tx, data) => tx.subtask.createMany({ data }),
  customFieldValue: (tx, data) => tx.customFieldValue.createMany({ data }),
  comment: (tx, data) => tx.comment.createMany({ data }),
  activityLog: (tx, data) => tx.activityLog.createMany({ data }),
  taskDependency: (tx, data) => tx.taskDependency.createMany({ data }),
  chatChannel: (tx, data) => tx.chatChannel.createMany({ data }),
  chatChannelMember: (tx, data) => tx.chatChannelMember.createMany({ data }),
  chatMessage: (tx, data) => tx.chatMessage.createMany({ data }),
  chatReaction: (tx, data) => tx.chatReaction.createMany({ data }),
  wikiSpace: (tx, data) => tx.wikiSpace.createMany({ data }),
  wikiPage: (tx, data) => tx.wikiPage.createMany({ data }),
  wikiPageComment: (tx, data) => tx.wikiPageComment.createMany({ data }),
};

/**
 * Rows whose JSON nests deeper than this go in one by one: a batched insert
 * holds one level less than a single-row one (MAX_RESTORE_JSON_DEPTH).
 */
const BATCHED_JSON_DEPTH = MAX_RESTORE_JSON_DEPTH - 1;

/** Tables with JSON columns, for rows too deep to batch. */
const INSERT_ONE: Partial<{
  [K in RestoreTable]: (tx: Prisma.TransactionClient, data: RestoreRows[K]) => Promise<unknown>;
}> = {
  customField: (tx, data) => tx.customField.create({ data, select: { id: true } }),
  customFieldValue: (tx, data) => tx.customFieldValue.create({ data, select: { id: true } }),
  activityLog: (tx, data) => tx.activityLog.create({ data, select: { id: true } }),
  wikiPage: (tx, data) => tx.wikiPage.create({ data, select: { id: true } }),
  wikiPageComment: (tx, data) => tx.wikiPageComment.create({ data, select: { id: true } }),
};

/** Rows and approximate UTF-16 bytes buffered before one round of inserts. */
const BATCH_ROWS = 1_000;
const BATCH_BYTES = 4 * 1024 * 1024;

/** Approximate bytes of `value`; records its nesting (objects and arrays) in `size.depth`. */
function measure(value: unknown, level: number, size: { depth: number }): number {
  if (typeof value === "string") return 2 * value.length + 8;
  if (value === null || typeof value !== "object" || value instanceof Date) return 8;
  if (level + 1 > size.depth) size.depth = level + 1;
  let total = 16;
  if (Array.isArray(value)) for (const item of value) total += measure(item, level + 1, size);
  else
    for (const key in value as Record<string, unknown>)
      total += 2 * key.length + measure((value as Record<string, unknown>)[key], level + 1, size);
  return total;
}

/**
 * Buffers planned rows and inserts them with one createMany per table, in
 * RESTORE_TABLES order. The plan yields every row after the rows it
 * references, so each insert only references rows inserted before it or in
 * the same statement (PostgreSQL checks foreign keys at the end of it).
 */
class BatchWriter {
  private buffers = new Map<RestoreTable, unknown[]>();
  private rows = 0;
  private bytes = 0;

  constructor(private readonly tx: Prisma.TransactionClient) {}

  async add(entry: RestoreRow) {
    const size = { depth: 0 };
    let bytes = 0;
    const data = entry.data as Record<string, unknown>;
    for (const key in data) bytes += measure(data[key], 0, size);
    if (size.depth > BATCHED_JSON_DEPTH) {
      // Everything it may reference goes in first.
      await this.flush();
      const insert = INSERT_ONE[entry.table] as
        | ((tx: Prisma.TransactionClient, row: unknown) => Promise<unknown>)
        | undefined;
      if (!insert) throw new Error(`No single-row insert for ${entry.table}`);
      await insert(this.tx, entry.data);
      return;
    }
    let buffer = this.buffers.get(entry.table);
    if (!buffer) this.buffers.set(entry.table, (buffer = []));
    buffer.push(entry.data);
    this.rows++;
    this.bytes += bytes;
    if (this.rows >= BATCH_ROWS || this.bytes >= BATCH_BYTES) await this.flush();
  }

  async flush() {
    for (const table of RESTORE_TABLES) {
      const data = this.buffers.get(table);
      if (!data || data.length === 0) continue;
      this.buffers.set(table, []);
      await (INSERT[table] as (tx: Prisma.TransactionClient, rows: unknown[]) => Promise<unknown>)(
        this.tx,
        data,
      );
    }
    this.rows = 0;
    this.bytes = 0;
  }
}

/**
 * The transaction keeps the workspace row locked, so other workspace writers
 * wait for it. Batched inserts restored 112,000 rows (75% of the backup.json
 * object limit) in about 4 s locally, where one insert per row took 57 s. A
 * restore that has not committed by this deadline is rolled back whole and
 * answered with a 503.
 */
const RESTORE_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 60_000,
} as const;

/** Runs the plan, handing each row to `write`, and summarizes what it produced. */
async function runPlan(
  backup: BackupFile,
  target: RestoreTarget,
  assets: AssetPlan,
  newId: () => string,
  write: (row: RestoreRow) => void | Promise<void>,
): Promise<RestoreSummary> {
  const users = mapUsers(backup, target.members, target.adminUserId);
  const warnings = [...users.getWarnings()];
  const counts = emptyCounts();
  for (const row of planRestore(backup, target, users, newId, warnings)) {
    counts[row.table]++;
    await write(row);
  }
  if (assets.unused > 0)
    warnings.push(
      `${assets.unused} file(s) in the archive are not used by any wiki page and were not restored`,
    );
  return restoreSummary(counts, assets.used.length, users, warnings);
}

/** Generate a preview summary without modifying the database. */
export async function previewRestore(
  prisma: PrismaClient,
  workspaceId: string,
  adminUserId: string,
  fileBuffer: Buffer,
  assets?: ReadonlyMap<string, BackupArchiveAsset>,
): Promise<RestoreSummary> {
  const backup = parseBackupFile(fileBuffer);
  const assetPlan = planAssets(workspaceId, backup, assets);
  const target = await loadTarget(prisma, workspaceId, adminUserId, new Map());
  let previewIds = 0;
  return runPlan(backup, target, assetPlan, () => `preview-${++previewIds}`, () => {});
}

/** Restore a backup file into the workspace, creating new entities with new IDs. */
export async function executeRestore(
  prisma: PrismaClient,
  workspaceId: string,
  adminUserId: string,
  fileBuffer: Buffer,
  assets?: ReadonlyMap<string, BackupArchiveAsset>,
  storage?: StorageProvider,
): Promise<RestoreSummary> {
  const backup = parseBackupFile(fileBuffer);
  const assetPlan = planAssets(workspaceId, backup, assets);
  if (assetPlan.used.length > 0 && !storage)
    throw new Error("Restoring backup files requires a storage provider");
  const paths = assetPlan.used.map((a) => a.storagePath);
  const assetUrls = new Map(assetPlan.used.map((a) => [a.assetPath, assetUrl(a.storagePath)]));
  await stageAssets(prisma, storage!, workspaceId, assetPlan.used);

  try {
    return await prisma.$transaction(async (tx) => {
      // New wiki spaces/pages are appended under the same workspace lock as
      // runtime wiki writers, with the administrator role re-read after it.
      if (!(await lockWorkspace(tx, workspaceId)))
        throw new NotFoundError("Workspace not found");
      const admin = await tx.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: adminUserId, workspaceId } },
        select: { role: true },
      });
      if (admin?.role !== "ADMIN") throw new ForbiddenError("Insufficient permissions");
      await claimStagedAssets(tx, paths);

      // Members are read under the lock that membership changes also take.
      const target = await loadTarget(tx, workspaceId, adminUserId, assetUrls);
      const writer = new BatchWriter(tx);
      const summary = await runPlan(backup, target, assetPlan, newRowId, (row) => writer.add(row));
      await writer.flush();
      return summary;
    }, RESTORE_TRANSACTION);
  } catch (error) {
    if (storage) await discardStagedAssets(prisma, storage, paths);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028")
      throw new AppError(
        503,
        "Service Unavailable",
        "The restore did not finish in time and nothing was restored. Please try again.",
      );
    throw error;
  }
}
