import type { PrismaClient } from "@prisma/client";
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

/** Rows read per query, so no part of a large workspace is loaded at once. */
const EXPORT_BATCH = 500;
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
  /** Rows per query; tests use small batches. */
  batchSize?: number;
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
  private readonly failed: Promise<never>;
  private current: Readable | undefined;

  constructor(
    readonly file: string,
    private readonly budget: BackupExportBudget,
  ) {
    this.output = createWriteStream(file, { flags: "wx", mode: 0o600 });
    this.written = pipeline(this.archive, this.output);
    this.failed = new Promise<never>((_, reject) => {
      this.archive.on("error", reject);
      this.archive.on("warning", reject);
      this.written.catch(reject);
    });
    this.failed.catch(() => {});
  }

  /**
   * Resolves when archiver has written the entry appended next. A failure is
   * reported through `failed`; this promise may outlive the wait for it.
   */
  private nextEntry(): Promise<unknown> {
    const entry = once(this.archive, "entry");
    entry.catch(() => {});
    return entry;
  }

  /** Wait for `promise`, or fail as soon as the archive does. */
  private race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.failed]);
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

  constructor(private readonly write: (text: string) => Promise<void>) {}

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
 * Read rows ordered by `createdAt`, then `id`, `size` at a time. Each query
 * asks for rows after the last one read by value, so a row deleted between
 * queries cannot end the walk early.
 */
async function* batches<T extends Position>(
  read: (page: { where: object; take: number }) => Promise<T[]>,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<T[]> {
  let last: Position | undefined;
  for (;;) {
    if (signal?.aborted) throw new BackupRequestAbortedError();
    const rows = await read({
      take: size,
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
    if (rows.length < size) return;
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
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, slug: true },
  });
  const { signal } = options;
  const batchSize = options.batchSize ?? EXPORT_BATCH;
  const checkAborted = () => {
    if (signal?.aborted) throw new BackupRequestAbortedError();
  };

  const file = await stagingPath("export", options.stagingDir ?? backupStagingDir(env.STORAGE_DIR));
  const archive = new ExportArchive(file, new BackupExportBudget(limits, jsonLimits));
  let size: number;
  try {
    const assets = request.includeFiles
      ? await archiveWikiAssets(prisma, workspaceId, request, storage, actorId, archive, batchSize, checkAborted)
      : undefined;
    await archive.appendJson((write) =>
      writeBackupJson(prisma, workspaceId, workspace, request, assets, write, batchSize, signal),
    );
    size = await archive.finish();
  } catch (error) {
    await archive.discard();
    throw error;
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
 * read here for their content only; `backup.json` reads them again and
 * refuses a page that gained a URL in between.
 */
async function archiveWikiAssets(
  prisma: PrismaClient,
  workspaceId: string,
  request: BackupExportRequest,
  storage: StorageProvider,
  actorId: string,
  archive: ExportArchive,
  batchSize: number,
  checkAborted: () => void,
): Promise<ArchivedAssets> {
  const allStorageUrls = new Set<string>();
  for (const opt of request.wikiSpaces) {
    const space = await prisma.wikiSpace.findUnique({
      where: { id: opt.spaceId, workspaceId },
      select: { id: true },
    });
    if (!space) continue;
    for await (const pages of batches(
      ({ where, take }) =>
        prisma.wikiPage.findMany({
          where: { spaceId: opt.spaceId, ...where },
          select: { id: true, createdAt: true, content: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
        }),
      batchSize,
    )) {
      checkAborted();
      for (const page of pages) {
        if (page.content) {
          for (const url of extractStorageUrls(page.content)) allStorageUrls.add(url);
        }
      }
    }
  }

  const urlRewriteMap = new Map<string, string>();
  // One archive entry per stored file, however many URLs spell it.
  const archived = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const url of allStorageUrls) {
    checkAborted();
    const ctx = await assertBackupExportAccess(prisma, workspaceId, actorId);
    const storagePaths = await resolveBackupAssetPaths(prisma, ctx, url);
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
          !(await storage.exists(storagePath))
        ) continue;
        source = await storage.openReadStream(storagePath);
      } catch {
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
  prisma: PrismaClient,
  workspaceId: string,
  workspace: { name: string; slug: string },
  request: BackupExportRequest,
  assets: ArchivedAssets | undefined,
  write: (text: string) => Promise<void>,
  batchSize: number,
  signal?: AbortSignal,
) {
  const json = new PrettyJsonWriter(write);
  // Collect all user IDs referenced across the backup
  const userIdSet = new Set<string>();
  await json.open("{");

  // ─── Export Projects ──────────────────────────────────

  await json.open("[", "projects");
  for (const opt of request.projects) {
    const project = await prisma.project.findUnique({
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
      ? await prisma.statusColumn.findMany({
          where: { projectId: opt.projectId },
          orderBy: [{ position: "asc" }, { id: "asc" }],
        })
      : [];

    const labels = opt.includeLabels
      ? await prisma.label.findMany({
          where: { projectId: opt.projectId },
        })
      : [];

    const customFields = opt.includeCustomFields
      ? await prisma.customField.findMany({
          where: { projectId: opt.projectId },
          orderBy: { position: "asc" },
        })
      : [];

    const members = opt.includeMembers
      ? await prisma.projectMember.findMany({
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
      for await (const dbTasks of batches(
        ({ where, take }) =>
          prisma.task.findMany({
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
        batchSize,
        signal,
      )) {
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
    const channel = await prisma.chatChannel.findUnique({
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
      ? await prisma.chatChannelMember.findMany({
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
      for await (const dbMessages of batches(
        ({ where, take }) =>
          prisma.chatMessage.findMany({
            where: { channelId: opt.channelId, deletedAt: null, ...where },
            include: opt.includeReactions
              ? { reactions: { select: { userId: true, emoji: true } } }
              : undefined,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take,
          }),
        batchSize,
        signal,
      )) {
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
      }
    }
    await json.close("]");
    await json.close("}");
  }
  await json.close("]");

  // ─── Export Wiki Spaces ──────────────────────────────

  await json.open("[", "wikiSpaces");
  for (const opt of request.wikiSpaces) {
    const space = await prisma.wikiSpace.findUnique({
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
    for await (const dbPages of batches(
      ({ where, take }) =>
        prisma.wikiPage.findMany({
          where: { spaceId: opt.spaceId, ...where },
          include: opt.includeComments
            ? { comments: { orderBy: { createdAt: "asc" } } }
            : undefined,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
        }),
      batchSize,
      signal,
    )) {
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
          // A URL added since the images were copied would point at a file
          // the archive lacks; the export is refused rather than incomplete.
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
    }
    await json.close("]");
    await json.close("}");
  }
  await json.close("]");

  // ─── Metadata and user references ─────────────────────
  // Written last: it lists every user the content above refers to.

  if (signal?.aborted) throw new BackupRequestAbortedError();
  const userRefs = await prisma.user.findMany({
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
