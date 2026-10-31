import { open, readFile, type FileHandle } from "node:fs/promises";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { BackupExportRequest, RestoreSummary } from "@pm/shared";
import { exportBackup } from "./backup.service.js";
import { previewRestore, executeRestore } from "./restore.service.js";
import {
  BACKUP_ARCHIVE_LIMITS,
  BackupArchiveError,
  readBackupArchive,
  type BackupArchiveContents,
} from "./backup-archive.js";
import { BACKUP_JSON_LIMITS, BackupJsonError } from "./backup-json.js";
import {
  backupConcurrency,
  clientAbortSignal,
  releaseBackupAdmission,
} from "./backup-concurrency.js";
import {
  BACKUP_TRANSFER_LIMITS,
  backupStagingDir,
  onLastByte,
  receiveBackupUpload,
  watchIdle,
  type StagedUpload,
} from "./backup-staging.js";
import { env } from "../../config/env.js";
import { liftRequestTimeout } from "../../plugins/request-limits.js";
import { ValidationError } from "../../utils/errors.js";
import { formatContentDisposition } from "../../utils/content-disposition.js";

export async function exportHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  const body = request.body as BackupExportRequest;

  if (body.projects.length === 0 && body.channels.length === 0 && body.wikiSpaces.length === 0) {
    throw new ValidationError("Select at least one project, channel, or wiki space to export");
  }

  const signal = clientAbortSignal(reply);
  // Build the archive in the exclusive section; it is staged on disk, so the
  // download that follows runs outside it.
  const { file, filename } = await backupConcurrency.exclusive(
    () =>
      exportBackup(
        request.server.prisma,
        wid,
        body,
        request.server.storage,
        request.user!.id,
        BACKUP_ARCHIVE_LIMITS,
        BACKUP_JSON_LIMITS,
        { stagingDir: backupStagingDir(env.STORAGE_DIR), signal },
      ),
    signal,
  );

  // Open the finished archive, then remove its name: the open file stays
  // readable until the response ends or is abandoned, and nothing is left on
  // disk either way.
  let handle: FileHandle;
  try {
    handle = await open(file.path, "r");
  } finally {
    await file.dispose();
  }
  // A client that reads nothing for the idle timeout is dropped, which
  // destroys the stream and ends this request.
  const watched = watchIdle(handle.createReadStream(), BACKUP_TRANSFER_LIMITS.idleTimeoutMs, () =>
    reply.raw.destroy(),
  );
  // The admission is held until the archive's last chunk is handed to the
  // response, and released in that same synchronous step, so a client that
  // has the whole file can start its next backup request at once. A download
  // that is abandoned or fails first releases it when its stream closes.
  const download = onLastByte(watched, file.size, () => releaseBackupAdmission(request));
  download.once("close", () => releaseBackupAdmission(request));
  reply
    .header("Content-Type", "application/zip")
    .header("Content-Length", String(file.size))
    .header("Content-Disposition", formatContentDisposition(filename))
    .send(download);
  return reply;
}


/** Quick check: ZIP files start with PK\x03\x04 */
function isZipSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

async function startsWithZipSignature(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return isZipSignature(head.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Read a staged upload as a .zip archive or a legacy plain .json file. Only
 * `backup.json` is read into memory; a plain file over the JSON byte limit is
 * refused before it is read.
 */
async function openStagedBackup(upload: StagedUpload): Promise<BackupArchiveContents> {
  if (upload.filename.endsWith(".zip") || (await startsWithZipSignature(upload.path))) {
    return readBackupArchive(upload.path);
  }
  if (upload.size > BACKUP_JSON_LIMITS.maxBytes) throw new BackupJsonError("json-size");
  return { jsonBuffer: await readFile(upload.path), assets: new Map() };
}

/** Log the fixed reason code of a refused upload, never its content. */
async function logRejection<T>(request: FastifyRequest, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BackupArchiveError) {
      request.log.warn({ reason: error.reason }, "Rejected backup archive");
    } else if (error instanceof BackupJsonError) {
      request.log.warn({ reason: error.reason }, "Rejected backup file");
    }
    throw error;
  }
}

/**
 * Stage the upload on disk, then read and process it in the exclusive
 * section. The staged file is removed on every path before the response is
 * sent, so a client that receives it can start its next backup request.
 */
async function handleUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (contents: BackupArchiveContents) => Promise<RestoreSummary>,
) {
  const signal = clientAbortSignal(reply);
  const upload = await receiveBackupUpload(request, {
    dir: backupStagingDir(env.STORAGE_DIR),
    maxBytes: Math.min(env.MAX_FILE_SIZE, BACKUP_TRANSFER_LIMITS.maxUploadBytes),
    // Authorized, admitted and its file started: the upload is bounded by
    // its own idle timeout and size limit from here on, not by the
    // whole-request deadline.
    onFile: () => liftRequestTimeout(request, reply),
  });
  let summary: RestoreSummary;
  try {
    summary = await logRejection(request, () =>
      backupConcurrency.exclusive(async () => run(await openStagedBackup(upload)), signal),
    );
  } finally {
    await upload.dispose();
  }
  return reply.send({ data: summary });
}

export async function previewHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  return handleUpload(request, reply, ({ jsonBuffer, assets }) =>
    previewRestore(request.server.prisma, wid, request.user!.id, jsonBuffer, assets),
  );
}

export async function restoreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const { wid } = request.params as { wid: string };
  return handleUpload(request, reply, ({ jsonBuffer, assets }) =>
    executeRestore(
      request.server.prisma,
      wid,
      request.user!.id,
      jsonBuffer,
      assets,
      request.server.storage,
    ),
  );
}
