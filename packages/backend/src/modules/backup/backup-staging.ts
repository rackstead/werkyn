import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline, Transform, type Readable } from "node:stream";
import { pipeline as pipeStreams } from "node:stream/promises";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { AppError, ValidationError } from "../../utils/errors.js";
import { BACKUP_ARCHIVE_LIMITS } from "./backup-archive.js";

const MiB = 1024 * 1024;

/**
 * Limits on moving one backup file between the client and the staging area
 * (see docs/remediation/b03-backup-transport.md).
 */
export const BACKUP_TRANSFER_LIMITS = Object.freeze({
  /**
   * Bytes of one uploaded backup file. An accepted archive declares at most
   * BACKUP_ARCHIVE_LIMITS.maxTotalBytes of content. Deflate adds well under
   * 1% to incompressible data, and the headers and directory of 10,000 entries
   * with 1,024-byte names take about 21 MiB.
   */
  maxUploadBytes: BACKUP_ARCHIVE_LIMITS.maxTotalBytes + 64 * MiB,
  /** A transfer that moves no bytes for this long is abandoned. */
  idleTimeoutMs: 60_000,
});

/** Staged files: `<kind>-<uuid>.part`. Nothing else is ever written here. */
const STAGED_NAME = /^(upload|export)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/;

/**
 * Where uploads and exports are staged: a hidden folder in the storage root,
 * so staged files share the storage volume and its free space. No static or
 * storage route serves it (workspace ids never contain a dot).
 */
export function backupStagingDir(storageDir: string): string {
  return path.join(path.resolve(storageDir), ".tmp", "backup");
}

export interface StagedFile {
  readonly path: string;
  readonly size: number;
  /** Remove the file. Safe to call more than once and after a failure. */
  dispose(): Promise<void>;
}

export class BackupUploadTooLargeError extends AppError {
  constructor(readonly maxBytes: number) {
    super(413, "Payload Too Large", `Backup files are limited to ${maxBytes} bytes`);
  }
}

export class BackupTransferStalledError extends AppError {
  constructor() {
    super(408, "Request Timeout", "The backup transfer stalled and was abandoned");
  }
}

export const UPLOAD_INTERRUPTED_MESSAGE = "The backup upload did not complete";

/**
 * A new, unused staging path of `kind` in `dir`, which is created if needed.
 * Nothing is staged until leftovers of an earlier process have been swept.
 */
export async function stagingPath(kind: "upload" | "export", dir: string) {
  await prepareBackupStaging(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${kind}-${randomUUID()}.part`);
}

/** A handle that removes `file` once, ignoring a file that is already gone. */
export function stagedFile(file: string, size: number): StagedFile {
  let disposed: Promise<void> | undefined;
  return {
    path: file,
    size,
    dispose: () => (disposed ??= rm(file, { force: true })),
  };
}

export interface StageOptions {
  /** The staging directory, normally backupStagingDir(STORAGE_DIR). */
  dir: string;
  maxBytes: number;
  idleTimeoutMs: number;
}

/**
 * Write `source` to a new staged file without holding it in memory. Over
 * `maxBytes`, or idle for `idleTimeoutMs`, the copy stops with a 413 or 408.
 * On any failure the partial file is removed before the error is thrown.
 */
export async function stageStream(source: Readable, options: StageOptions): Promise<StagedFile> {
  const file = await stagingPath("upload", options.dir);
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > options.maxBytes) {
        callback(new BackupUploadTooLargeError(options.maxBytes));
        return;
      }
      idle.refresh();
      callback(null, chunk);
    },
  });
  const idle = setTimeout(
    () => meter.destroy(new BackupTransferStalledError()),
    options.idleTimeoutMs,
  );
  try {
    await pipeStreams(source, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(file, { force: true });
    if (error instanceof AppError) throw error;
    // Disk errors are server errors; anything else came from the request.
    if (typeof (error as NodeJS.ErrnoException).syscall === "string") throw error;
    throw new ValidationError(UPLOAD_INTERRUPTED_MESSAGE);
  } finally {
    clearTimeout(idle);
  }
  return stagedFile(file, size);
}

/**
 * Pass `source` through, calling `onIdle` once if no bytes move for
 * `idleTimeoutMs`. Piped to a response, the stream stops moving as soon as
 * the client stops reading, so this drops a stalled download after exactly
 * that long. A socket timeout is not exact: Node skips its first expiry while
 * a write is still pending, which roughly doubles the wait.
 */
export function watchIdle(source: Readable, idleTimeoutMs: number, onIdle: () => void): Readable {
  const idle = setTimeout(onIdle, idleTimeoutMs);
  const watched = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      idle.refresh();
      callback(null, chunk);
    },
  });
  watched.once("close", () => clearTimeout(idle));
  return pipeline(source, watched, () => {});
}

/**
 * Pass `source` through, calling `onSent` when the chunk that completes its
 * first `size` bytes is handed on, in the same synchronous step and just
 * before it, so before anything reading the stream can have every byte.
 * Waiting for the stream to end or close would also wait for the read that
 * finds the end of the file, which can finish after the client has it all.
 */
export function onLastByte(source: Readable, size: number, onSent: () => void): Readable {
  let passed = 0;
  let sent = false;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      passed += chunk.length;
      if (!sent && passed >= size) {
        sent = true;
        onSent();
      }
      callback(null, chunk);
    },
  });
  return pipeline(source, counted, () => {});
}

export interface StagedUpload extends StagedFile {
  readonly filename: string;
}

/**
 * Stream the request's uploaded backup file into `dir`, refusing it beyond
 * `maxBytes`. A request that sends nothing for `idleTimeoutMs`, before or
 * during the file, is dropped. The caller must dispose of the result once it
 * has finished with it.
 */
export async function receiveBackupUpload(
  request: FastifyRequest,
  {
    dir,
    maxBytes,
    idleTimeoutMs = BACKUP_TRANSFER_LIMITS.idleTimeoutMs,
    onFile,
  }: {
    dir: string;
    maxBytes: number;
    idleTimeoutMs?: number;
    /** Called once the file part has started, before it is staged. */
    onFile?: () => void;
  },
): Promise<StagedUpload> {
  // The multipart parser reads the request from here on. Until the file part
  // starts, a request that stops sending is dropped, so it cannot hold its
  // admission; stageStream watches the file itself.
  const pending = request.file({ limits: { fileSize: maxBytes } });
  pending.catch(() => {});
  const raw = request.raw;
  let idle: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    idle = setTimeout(() => {
      reject(new BackupTransferStalledError());
      raw.destroy();
    }, idleTimeoutMs);
  });
  const onData = () => idle?.refresh();
  raw.on("data", onData);
  let file: Awaited<typeof pending>;
  try {
    file = await Promise.race([pending, stalled]);
  } finally {
    clearTimeout(idle);
    raw.off("data", onData);
  }
  if (!file) {
    throw new ValidationError("No file uploaded");
  }
  if (!file.filename.endsWith(".json") && !file.filename.endsWith(".zip")) {
    throw new ValidationError("Only .json and .zip files are accepted");
  }
  onFile?.();
  let staged: StagedFile;
  try {
    staged = await stageStream(file.file, { dir, maxBytes, idleTimeoutMs });
  } catch (error) {
    // Drop a client that stalled mid-file; it is not reading a response.
    if (error instanceof BackupTransferStalledError) raw.destroy();
    throw error;
  }
  // The multipart parser ends a file at its size limit instead of failing.
  if (file.file.truncated) {
    await staged.dispose();
    throw new BackupUploadTooLargeError(maxBytes);
  }
  return { ...staged, filename: file.filename };
}

const sweeps = new Map<string, Promise<void>>();

/**
 * Sweep `dir` once per process. The server does this at startup; until a
 * sweep has succeeded, every attempt to stage a file retries it first, so
 * leftovers are never kept alongside new files.
 */
export function prepareBackupStaging(dir: string, log?: FastifyBaseLogger): Promise<void> {
  let sweep = sweeps.get(dir);
  if (!sweep) {
    sweep = sweepBackupStaging(log, dir).then(
      () => {},
      (error: unknown) => {
        sweeps.delete(dir);
        throw error;
      },
    );
    sweeps.set(dir, sweep);
  }
  return sweep;
}

/**
 * Remove staged files left behind by a process that stopped mid-request.
 * Staged files are only ever used by the request that created them, so this
 * runs before any are created. Returns how many it removed.
 */
export async function sweepBackupStaging(
  log: Pick<FastifyBaseLogger, "warn"> | undefined,
  dir: string,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    if (!STAGED_NAME.test(name)) continue;
    await rm(path.join(dir, name), { force: true });
    removed++;
  }
  if (removed > 0) log?.warn({ removed }, "Removed staged backup files left by an earlier process");
  return removed;
}
