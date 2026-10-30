import { Prisma, type PrismaClient } from "@prisma/client";
import {
  BACKUP_INCLUDED_CONTENT,
  BACKUP_OMITTED_CONTENT,
  BACKUP_SCOPE,
  type BackupExportRequest,
  type BackupFile,
} from "@pm/shared";
import type { StorageProvider } from "../../services/storage.js";
import archiver from "archiver";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, pipeline as pipeStreams, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { ConflictError } from "../../utils/errors.js";
import { extractStorageUrls, rewriteStorageUrls } from "./backup-assets.js";
import {
  assertBackupExportAccess,
  resolveBackupAssetPaths,
} from "./backup-asset-access.js";
import {
  BACKUP_ARCHIVE_LIMITS,
  BackupExportBudget,
  type BackupArchiveLimits,
} from "./backup-archive.js";
import { BACKUP_JSON_LIMITS, type BackupJsonLimits } from "./backup-json.js";
import { BackupRequestAbortedError } from "./backup-concurrency.js";
import {
  backupStagingDir,
  stagedFile,
  stagingPath,
  type StagedFile,
} from "./backup-staging.js";

/** Rows read per query at most, so no part of a large workspace is loaded at once. */
const EXPORT_BATCH = 500;
/** Rows in the first query of each list, before their size is known. */
const FIRST_BATCH = 50;
/** Later queries of a list read about this much `backup.json` text each. */
const BATCH_TARGET_CHARS = 4 * 1024 * 1024;
/**
 * How long an export may take, image copy included; its database snapshot
 * stays open that long at most. An export that takes longer fails with a
 * retryable 409.
 */
export const EXPORT_TIMEOUT_MS = 10 * 60_000;

export const EXPORT_TOO_SLOW_MESSAGE =
  "The export took longer than allowed. Try again, or export fewer projects, channels or wiki spaces.";

/** The reason an export's deadline passed. */
class ExportDeadlineError extends Error {}

/** The error an export stopped by `signal` fails with. */
function stopError(signal: AbortSignal): Error {
  return signal.reason instanceof ExportDeadlineError
    ? new ConflictError(EXPORT_TOO_SLOW_MESSAGE)
    : new BackupRequestAbortedError();
}

/** The snapshot every content read of an export goes through. */
type Snapshot = Prisma.TransactionClient;
/** `backup.json` text is handed to the archive in pieces of about this size. */
const JSON_FLUSH_BYTES = 64 * 1024;

export interface BackupExportResult {
  /** The finished archive in the staging area; the caller sends and disposes of it. */
  file: StagedFile;
  filename: string;
}

export interface BackupExportOptions {
  /** Where the archive is built; defaults to the storage staging folder. */
  stagingDir?: string;
  /** Stops the export at its next step once aborted. */
  signal?: AbortSignal;
  /** Most rows per query; tests use small batches. */
  batchSize?: number;
  /** How long the export may take; tests use short deadlines. */
  timeoutMs?: number;
}

export const WIKI_CHANGED_MESSAGE =
  "The wiki changed while it was being exported. Try the export again.";

type ProjectEntry = BackupFile["projects"][number];
type TaskEntry = ProjectEntry["tasks"][number];
type MessageEntry = BackupFile["channels"][number]["messages"][number];
type PageEntry = BackupFile["wikiSpaces"][number]["pages"][number];

/**
 * A ZIP archive written to a staged file one entry at a time. Every byte is
 * counted against the export budget as it is written, so an export stops as
 * soon as restore could no longer read it.
 */
class ExportArchive {
  private readonly archive = archiver("zip", { zlib: { level: 6 } });
  private readonly output: WriteStream;
  private readonly written: Promise<void>;
  /** Why the archive failed or was stopped; every later wait fails with it. */
  private failure: Error | undefined;
  /** Rejecters of the waits in progress, removed as each settles. */
  private readonly waiting = new Set<(error: Error) => void>();
  private isStopped = false;
  private current: Readable | undefined;

  /**
   * `stop` ends the export at once, whatever it is waiting for: the stream
   * being copied is destroyed, so a stalled storage read cannot hold it.
   */
  constructor(
    readonly file: string,
    private readonly budget: BackupExportBudget,
    stop: AbortSignal,
  ) {
    this.output = createWriteStream(file, { flags: "wx", mode: 0o600 });
    this.written = pipeline(this.archive, this.output);
    const fail = (error: Error) => this.fail(error);
    this.archive.on("error", fail);
    this.archive.on("warning", fail);
    this.written.catch(fail);
    const onStop = () => {
      this.isStopped = true;
      this.current?.destroy();
      this.fail(stopError(stop));
    };
    if (stop.aborted) onStop();
    else stop.addEventListener("abort", onStop, { once: true });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const reject of this.waiting) reject(error);
    this.waiting.clear();
  }

  /**
   * Resolves when archiver has written the entry appended next. A failure is
   * reported through `fail`; this promise may outlive the wait for it.
   */
  private nextEntry(): Promise<unknown> {
    const entry = once(this.archive, "entry");
    entry.catch(() => {});
    return entry;
  }

  /**
   * Wait for `promise`, or fail as soon as the archive fails or is stopped.
   * Nothing is kept once the wait settles (a Promise.race against a promise
   * that stays pending would keep every result until the export ends).
   */
  race<T>(promise: Promise<T>): Promise<T> {
    if (this.failure) {
      promise.catch(() => {});
      return Promise.reject(this.failure);
    }
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      promise.then(
        (value) => {
          this.waiting.delete(reject);
          resolve(value);
        },
        (error: unknown) => {
          this.waiting.delete(reject);
          reject(error);
        },
      );
    });
  }

  /** Wait for a stream to open; one that opens after the export stopped is closed. */
  opened(opening: Promise<Readable>): Promise<Readable> {
    opening.then(
      (stream) => {
        if (this.isStopped) stream.destroy();
      },
      () => {},
    );
    return this.race(opening);
  }

  /** Append `source` as `name`, counting its bytes, and wait until it is written. */
  async append(name: string, source: Readable): Promise<void> {
    const budget = this.budget;
    budget.add(name, 0);
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        try {
          budget.add(name, size);
        } catch (error) {
          callback(error as Error);
          return;
        }
        callback(null, chunk);
      },
    });
    // archiver does not always report a source that fails mid-entry, so the
    // failure of `source` or of the count ends the wait directly.
    const sourceFailed = new Promise<never>((_, reject) => {
      this.current = pipeStreams(source, counted, (error) => {
        if (error) reject(error);
      });
    });
    sourceFailed.catch(() => {});
    const entry = this.nextEntry();
    this.archive.append(this.current!, { name });
    await this.race(Promise.race([entry, sourceFailed]));
    this.current = undefined;
  }

  /** Append `backup.json`, written by `produce`, measured as restore will. */
  async appendJson(produce: (write: (text: string) => Promise<void>) => Promise<void>) {
    const budget = this.budget;
    const stream = new PassThrough();
    this.current = stream;
    const entry = this.nextEntry();
    this.archive.append(stream, { name: "backup.json" });
    let pending: string[] = [];
    let pendingLength = 0;
    const flush = async () => {
      if (pendingLength === 0) return;
      const chunk = Buffer.from(pending.join(""));
      pending = [];
      pendingLength = 0;
      budget.writeJson(chunk);
      if (!stream.write(chunk)) await this.race(once(stream, "drain"));
    };
    await produce(async (text) => {
      pending.push(text);
      pendingLength += text.length;
      if (pendingLength >= JSON_FLUSH_BYTES) await flush();
    });
    await flush();
    stream.end();
    await this.race(entry);
    this.current = undefined;
  }

  /** Finish the archive and return its size. */
  async finish(): Promise<number> {
    await this.archive.finalize();
    await this.race(this.written);
    return this.archive.pointer();
  }

  /** Stop writing, close the partial file and remove it. */
  async discard() {
    this.current?.destroy();
    this.archive.abort();
    this.archive.destroy();
    if (!this.output.closed) {
      const closed = once(this.output, "close").catch(() => {});
      this.output.destroy();
      await closed;
    }
    await rm(this.file, { force: true });
  }
}

/**
 * Writes JSON formatted as `JSON.stringify(value, null, 2)` would, a value or
 * a bracket at a time, so a large document never exists as one string.
 */
class PrettyJsonWriter {
  private depth = 0;
  private readonly empty: boolean[] = [];
  /** Characters written so far. */
  written = 0;

  constructor(private readonly sink: (text: string) => Promise<void>) {}

  private write(text: string) {
    this.written += text.length;
    return this.sink(text);
  }

  private prefix(key?: string) {
    const first = this.empty.length === 0 || this.empty[this.empty.length - 1];
    if (this.empty.length > 0) this.empty[this.empty.length - 1] = false;
    const separator = first ? "" : ",";
    const indent = this.depth > 0 ? `\n${"  ".repeat(this.depth)}` : "";
    return `${separator}${indent}${key === undefined ? "" : `${JSON.stringify(key)}: `}`;
  }

  /** Write a complete value; inside an object, `key` names it. */
  value(value: unknown, key?: string) {
    if (value === undefined) return Promise.resolve();
    const text = JSON.stringify(value, null, 2).replace(/\n/g, `\n${"  ".repeat(this.depth)}`);
    return this.write(`${this.prefix(key)}${text}`);
  }

  /** Open an object or array; inside an object, `key` names it. */
  open(bracket: "{" | "[", key?: string) {
    const text = `${this.prefix(key)}${bracket}`;
    this.empty.push(true);
    this.depth++;
    return this.write(text);
  }

  close(bracket: "}" | "]") {
    const wasEmpty = this.empty.pop();
    this.depth--;
    return this.write(wasEmpty ? bracket : `\n${"  ".repeat(this.depth)}${bracket}`);
  }
}

/** A row's place in `createdAt`, then `id`, order. */
interface Position {
  createdAt: Date;
  id: string;
}

/**
 * Sizes the queries of one list. The first reads FIRST_BATCH rows; each later
 * one reads about BATCH_TARGET_CHARS of output at the average size of the rows
 * so far, between 1 and `max` rows, so a list of large rows (a page or a
 * description can be about 1 MiB) is read a few rows at a time.
 */
class BatchSizer {
  size: number;

  constructor(private readonly max: number) {
    this.size = Math.min(FIRST_BATCH, max);
  }

  /** Report the output of the batch just read. */
  record(rows: number, chars: number) {
    const perRow = Math.max(1, chars / Math.max(1, rows));
    this.size = Math.max(1, Math.min(this.max, Math.floor(BATCH_TARGET_CHARS / perRow)));
  }
}

/**
 * Read rows ordered by `createdAt`, then `id`, in batches sized by `sizer`.
 * Each query asks for rows after the last one read by value, so a row
 * deleted between queries cannot end the walk early. The caller reports each
 * batch's output to `sizer` before asking for the next.
 */
async function* batches<T extends Position>(
  read: (page: { where: object; take: number }) => Promise<T[]>,
  sizer: BatchSizer,
  checkStopped: () => void,
): AsyncGenerator<T[]> {
  let last: Position | undefined;
  for (;;) {
    checkStopped();
    const take = sizer.size;
    const rows = await read({
      take,
      where: last
        ? {
            OR: [
              { createdAt: { gt: last.createdAt } },
              { createdAt: last.createdAt, id: { gt: last.id } },
            ],
          }
        : {},
    });
    if (rows.length > 0) yield rows;
    if (rows.length < take) return;
    last = rows[rows.length - 1];
  }
}

/**
 * Build a backup archive of the selected projects, channels and wiki spaces
 * in the staging area. Embedded wiki images are copied into the archive first,
 * straight from storage, then `backup.json` is written in pieces as rows are
 * read; neither is held in memory as a whole. The archive and its
 * `backup.json` are measured against the restore limits as they are written,
 * and an export that would exceed them stops with a 400 and leaves no file.
 *
 * Every read runs in one read-only REPEATABLE READ transaction, so the archive
 * is one consistent snapshot of the workspace, as pg_dump takes it: edits made
 * during the export are not in it at all. The ADMIN check runs on current data
 * just before the snapshot opens; each image's access is then read in the
 * snapshot, so the export needs one database connection only.
 */
export async function exportBackup(
  prisma: PrismaClient,
  workspaceId: string,
  request: BackupExportRequest,
  storage: StorageProvider,
  actorId: string,
  limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
  jsonLimits: BackupJsonLimits = BACKUP_JSON_LIMITS,
  options: BackupExportOptions = {},
): Promise<BackupExportResult> {
  await assertBackupExportAccess(prisma, workspaceId, actorId);
  const maxBatch = options.batchSize ?? EXPORT_BATCH;
  const timeoutMs = options.timeoutMs ?? EXPORT_TIMEOUT_MS;
  // The client leaving or the deadline passing stops the export at once.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ExportDeadlineError()), timeoutMs);
  const stop = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const checkStopped = () => {
    if (stop.aborted) throw stopError(stop);
  };

  const file = await stagingPath("export", options.stagingDir ?? backupStagingDir(env.STORAGE_DIR));
  const archive = new ExportArchive(file, new BackupExportBudget(limits, jsonLimits), stop);
  let workspace: { name: string; slug: string };
  let size: number;
  try {
    // Any failure inside rolls the snapshot back, and the archive is removed.
    workspace = await prisma.$transaction(
      async (db) => {
        await db.$executeRaw`SET TRANSACTION READ ONLY`;
        const current = await db.workspace.findUniqueOrThrow({
          where: { id: workspaceId },
          select: { name: true, slug: true },
        });
        const assets = request.includeFiles
          ? await archiveWikiAssets(db, workspaceId, request, storage, actorId, archive, maxBatch, checkStopped)
          : undefined;
        await archive.appendJson((write) =>
          writeBackupJson(db, workspaceId, current, request, assets, write, maxBatch, checkStopped),
        );
        return current;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        // A little longer than the export's own deadline, which ends it first.
        timeout: timeoutMs + 5_000,
      },
    );
    size = await archive.finish();
  } catch (error) {
    await archive.discard();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const filename = `backup-${workspace.slug}-${new Date().toISOString().slice(0, 10)}.zip`;
  return { file: stagedFile(file, size), filename };
}

interface ArchivedAssets {
  /** Every URL looked at, whether or not its file was copied. */
  examined: Set<string>;
  /** Each copied URL's archive path. */
  rewrites: Map<string, string>;
}

/**
 * Copy every authorized image the selected wiki pages embed into the archive
 * and return the rewrite from each copied URL to its archive path. Pages are
 * read here from the snapshot for their content only; `backup.json` reads the
 * same snapshot again. Each image's access is checked in the snapshot too.
 */
async function archiveWikiAssets(
  db: Snapshot,
  workspaceId: string,
  request: BackupExportRequest,
  storage: StorageProvider,
  actorId: string,
  archive: ExportArchive,
  maxBatch: number,
  checkStopped: () => void,
): Promise<ArchivedAssets> {
  const allStorageUrls = new Set<string>();
  for (const opt of request.wikiSpaces) {
    const space = await db.wikiSpace.findUnique({
      where: { id: opt.spaceId, workspaceId },
      select: { id: true },
    });
    if (!space) continue;
    const sizer = new BatchSizer(maxBatch);
    for await (const pages of batches(
      ({ where, take }) =>
        db.wikiPage.findMany({
          where: { spaceId: opt.spaceId, ...where },
          select: { id: true, createdAt: true, content: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
        }),
      sizer,
      checkStopped,
    )) {
      let chars = 0;
      for (const page of pages) {
        if (page.content) {
          chars += JSON.stringify(page.content).length;
          for (const url of extractStorageUrls(page.content)) allStorageUrls.add(url);
        }
      }
      sizer.record(pages.length, chars);
    }
  }

  const urlRewriteMap = new Map<string, string>();
  // One archive entry per stored file, however many URLs spell it.
  const archived = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const url of allStorageUrls) {
    checkStopped();
    const ctx = await assertBackupExportAccess(db, workspaceId, actorId);
    const storagePaths = await resolveBackupAssetPaths(db, ctx, url);
    for (const storagePath of storagePaths) {
      const known = archived.get(storagePath);
      if (known) {
        urlRewriteMap.set(url, known);
        break;
      }
      let source: Readable;
      try {
        // Resolve literal upload filenames before URI alternatives. Stat only
        // independently authorized candidates; storage never decodes them.
        // A missing literal spelling of URI syntax must not become a read.
        if (
          (storagePaths.length > 1 || /[%?#]/.test(url)) &&
          !(await archive.race(storage.exists(storagePath)))
        ) continue;
        source = await archive.opened(storage.openReadStream(storagePath));
      } catch {
        checkStopped();
        // File not found on disk — skip, leave original URL in JSON
        continue;
      }
      const base = path.basename(storagePath);
      let assetPath = `assets/${base}`;
      for (let n = 2; usedNames.has(assetPath); n++) assetPath = `assets/${n}-${base}`;
      usedNames.add(assetPath);
      await archive.append(assetPath, source);
      archived.set(storagePath, assetPath);
      urlRewriteMap.set(url, assetPath);
      break;
    }
  }
  return { examined: allStorageUrls, rewrites: urlRewriteMap };
}

/** Write `backup.json`: the selected content, then the metadata it refers to. */
async function writeBackupJson(
  db: Snapshot,
  workspaceId: string,
  workspace: { name: string; slug: string },
  request: BackupExportRequest,
  assets: ArchivedAssets | undefined,
  write: (text: string) => Promise<void>,
  maxBatch: number,
  checkStopped: () => void,
) {
  const json = new PrettyJsonWriter(write);
  // Collect all user IDs referenced across the backup
  const userIdSet = new Set<string>();
  await json.open("{");

  // ─── Export Projects ──────────────────────────────────

  await json.open("[", "projects");
  for (const opt of request.projects) {
    const project = await db.project.findUnique({
      where: { id: opt.projectId, workspaceId },
      select: {
        name: true,
        description: true,
        color: true,
        icon: true,
      },
    });
    if (!project) continue;

    const statuses = opt.includeStatuses
      ? await db.statusColumn.findMany({
          where: { projectId: opt.projectId },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        })
      : [];

    const labels = opt.includeLabels
      ? await db.label.findMany({
          where: { projectId: opt.projectId },
        })
      : [];

    const customFields = opt.includeCustomFields
      ? await db.customField.findMany({
          where: { projectId: opt.projectId },
          orderBy: { position: "asc" },
        })
      : [];

    const members = opt.includeMembers
      ? await db.projectMember.findMany({
          where: { projectId: opt.projectId },
          select: { userId: true },
        })
      : [];

    for (const m of members) userIdSet.add(m.userId);

    await json.open("{");
    await json.value(
      {
        name: project.name,
        description: project.description,
        color: project.color,
        icon: project.icon,
      } satisfies ProjectEntry["project"],
      "project",
    );
    await json.value(
      statuses.map((s) => ({
        _originalId: s.id,
        name: s.name,
        color: s.color,
        position: s.position,
        isCompletion: s.isCompletion,
      })) satisfies ProjectEntry["statuses"],
      "statuses",
    );
    await json.value(
      labels.map((l) => ({
        _originalId: l.id,
        name: l.name,
        color: l.color,
      })) satisfies ProjectEntry["labels"],
      "labels",
    );
    await json.value(
      customFields.map((f) => ({
        _originalId: f.id,
        name: f.name,
        type: f.type,
        options: f.options,
        required: f.required,
        position: f.position,
      })) satisfies ProjectEntry["customFields"],
      "customFields",
    );
    await json.value(
      members.map((m) => ({ userRef: m.userId })) satisfies ProjectEntry["members"],
      "members",
    );

    // Tasks
    await json.open("[", "tasks");
    if (opt.includeTasks) {
      const sizer = new BatchSizer(maxBatch);
      for await (const dbTasks of batches(
        ({ where, take }) =>
          db.task.findMany({
            where: { projectId: opt.projectId, ...where },
            include: {
              assignees: { select: { userId: true } },
              labels: { select: { labelId: true } },
              subtasks: { orderBy: { position: "asc" } },
              customFieldValues: true,
              blockedBy: { select: { blockingTaskId: true } },
              comments: opt.includeComments
                ? { orderBy: { createdAt: "asc" } }
                : false,
              activities: opt.includeActivityLogs
                ? { orderBy: { createdAt: "asc" } }
                : false,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take,
          }),
        sizer,
        checkStopped,
      )) {
        const start = json.written;
        for (const t of dbTasks) {
          for (const a of t.assignees) userIdSet.add(a.userId);
          for (const s of t.subtasks) {
            if (s.assigneeId) userIdSet.add(s.assigneeId);
          }

          const comments = t.comments
            ? t.comments.map((c) => {
                if (c.authorId) userIdSet.add(c.authorId);
                return {
                  _originalId: c.id,
                  body: c.body,
                  authorRef: c.authorId,
                  createdAt: c.createdAt.toISOString(),
                };
              })
            : [];

          const activityLogs = t.activities
            ? t.activities.map((a) => {
                if (a.actorId) userIdSet.add(a.actorId);
                return {
                  _originalId: a.id,
                  action: a.action,
                  details: a.details,
                  actorRef: a.actorId,
                  createdAt: a.createdAt.toISOString(),
                };
              })
            : [];

          await json.value({
            _originalId: t.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            position: t.position,
            dueDate: t.dueDate,
            startDate: t.startDate,
            statusRef: t.statusId,
            createdByRef: null as string | null,
            assignees: t.assignees.map((a) => a.userId),
            labels: t.labels.map((l) => l.labelId),
            subtasks: t.subtasks.map((s) => ({
              _originalId: s.id,
              title: s.title,
              completed: s.completed,
              position: s.position,
              assigneeRef: s.assigneeId,
              dueDate: s.dueDate,
            })),
            customFieldValues: t.customFieldValues.map((v) => ({
              fieldRef: v.fieldId,
              value: v.value,
            })),
            dependencies: t.blockedBy.map((d) => ({
              blockingTaskRef: d.blockingTaskId,
              type: "blocks",
            })),
            comments,
            activityLogs,
          } satisfies TaskEntry);
        }
        sizer.record(dbTasks.length, json.written - start);
      }
    }
    await json.close("]");
    await json.value([] satisfies ProjectEntry["attachments"], "attachments");
    await json.close("}");
  }
  await json.close("]");

  // ─── Export Channels ──────────────────────────────────

  await json.open("[", "channels");
  for (const opt of request.channels) {
    const channel = await db.chatChannel.findUnique({
      where: { id: opt.channelId, workspaceId },
      select: {
        name: true,
        description: true,
        type: true,
        createdById: true,
      },
    });
    if (!channel || channel.type === "DM") continue;

    const members = opt.includeMembers
      ? await db.chatChannelMember.findMany({
          where: { channelId: opt.channelId },
          select: { userId: true },
        })
      : [];

    for (const m of members) userIdSet.add(m.userId);
    userIdSet.add(channel.createdById);

    await json.open("{");
    await json.value(
      {
        name: channel.name,
        description: channel.description,
        type: channel.type as "PUBLIC" | "PRIVATE",
      },
      "channel",
    );
    await json.value(members.map((m) => ({ userRef: m.userId })), "members");
    await json.open("[", "messages");
    if (opt.includeMessages) {
      const sizer = new BatchSizer(maxBatch);
      for await (const dbMessages of batches(
        ({ where, take }) =>
          db.chatMessage.findMany({
            where: { channelId: opt.channelId, deletedAt: null, ...where },
            include: opt.includeReactions
              ? { reactions: { select: { userId: true, emoji: true } } }
              : undefined,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take,
          }),
        sizer,
        checkStopped,
      )) {
        const start = json.written;
        for (const m of dbMessages) {
          userIdSet.add(m.userId);
          const mWithReactions = m as typeof m & { reactions?: Array<{ userId: string; emoji: string }> };
          const reactions = mWithReactions.reactions
            ? mWithReactions.reactions.map((r) => {
                userIdSet.add(r.userId);
                return { userRef: r.userId, emoji: r.emoji };
              })
            : [];

          await json.value({
            _originalId: m.id,
            content: m.content,
            userRef: m.userId,
            parentRef: m.parentId,
            createdAt: m.createdAt.toISOString(),
            reactions,
          } satisfies MessageEntry);
        }
        sizer.record(dbMessages.length, json.written - start);
      }
    }
    await json.close("]");
    await json.close("}");
  }
  await json.close("]");

  // ─── Export Wiki Spaces ──────────────────────────────

  await json.open("[", "wikiSpaces");
  for (const opt of request.wikiSpaces) {
    const space = await db.wikiSpace.findUnique({
      where: { id: opt.spaceId, workspaceId },
      select: { name: true, description: true, icon: true },
    });
    if (!space) continue;

    await json.open("{");
    await json.value(
      {
        name: space.name,
        description: space.description,
        icon: space.icon,
      },
      "space",
    );
    await json.open("[", "pages");
    const sizer = new BatchSizer(maxBatch);
    for await (const dbPages of batches(
      ({ where, take }) =>
        db.wikiPage.findMany({
          where: { spaceId: opt.spaceId, ...where },
          include: opt.includeComments
            ? { comments: { orderBy: { createdAt: "asc" } } }
            : undefined,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
        }),
      sizer,
      checkStopped,
    )) {
      const start = json.written;
      for (const p of dbPages) {
        if (p.createdById) userIdSet.add(p.createdById);

        type WikiComment = {
          id: string;
          body: string;
          authorId: string;
          resolved: boolean;
          highlightId: string;
          selectionStart: unknown;
          selectionEnd: unknown;
          createdAt: Date;
        };
        const pWithComments = p as typeof p & { comments?: WikiComment[] };
        const comments = pWithComments.comments
          ? pWithComments.comments.map((c) => {
              if (c.authorId) userIdSet.add(c.authorId);
              return {
                _originalId: c.id,
                body: c.body,
                authorRef: c.authorId,
                resolved: c.resolved,
                highlightId: c.highlightId,
                selectionStart: c.selectionStart,
                selectionEnd: c.selectionEnd,
                createdAt: c.createdAt.toISOString(),
              };
            })
          : [];

        let content: unknown = p.content;
        if (assets && content) {
          // Both reads of a page come from the same snapshot, so every URL
          // was examined; this only guards against that ever changing, since
          // the page would refer to a file the archive lacks.
          for (const url of extractStorageUrls(content)) {
            if (!assets.examined.has(url)) throw new ConflictError(WIKI_CHANGED_MESSAGE);
          }
          // Rewrite URLs of images copied into the archive.
          if (assets.rewrites.size > 0) content = rewriteStorageUrls(content, assets.rewrites);
        }

        await json.value({
          _originalId: p.id,
          title: p.title,
          content,
          icon: p.icon,
          position: p.position,
          parentRef: p.parentId,
          createdByRef: p.createdById,
          comments,
        } satisfies PageEntry);
      }
      sizer.record(dbPages.length, json.written - start);
    }
    await json.close("]");
    await json.close("}");
  }
  await json.close("]");

  // ─── Metadata and user references ─────────────────────
  // Written last: it lists every user the content above refers to.

  checkStopped();
  const userRefs = await db.user.findMany({
    where: { id: { in: Array.from(userIdSet) } },
    select: { id: true, email: true, displayName: true },
  });
  await json.value(
    {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      scope: BACKUP_SCOPE,
      included: BACKUP_INCLUDED_CONTENT.map((item) => item.key),
      omitted: BACKUP_OMITTED_CONTENT.map((item) => item.key),
      sourceWorkspace: { name: workspace.name, slug: workspace.slug },
      userRefs: userRefs.map((u) => ({
        originalId: u.id,
        email: u.email,
        displayName: u.displayName,
      })),
    } satisfies BackupFile["metadata"],
    "metadata",
  );
  await json.close("}");
}
