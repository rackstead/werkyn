import { randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline, Transform, type Readable } from "node:stream";
import { pipeline as pipeStreams } from "node:stream/promises";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { AppError, ValidationError } from "../../utils/errors.js";
import { BACKUP_ARCHIVE_LIMITS } from "./backup-archive.js";
import { CREATE_NO_FOLLOW, StorageRoot, type StorageDirectory } from "../../services/storage-paths.js";

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

/**
 * Open the staging directory `dir`, which is always two folders below the
 * storage root (`<root>/.tmp/backup`). Those two are opened, and made if
 * `create`, without following links (R33): a link there is refused rather
 * than letting staged files be written, read or swept elsewhere. Staged
 * files themselves are created with O_EXCL and O_NOFOLLOW and read with
 * O_NOFOLLOW, so a link planted in place of one is never followed either.
 */
async function openStagingDirectory(dir: string, create: boolean): Promise<StorageDirectory> {
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  const root = path.dirname(parent);
  // The storage root itself may be a link or mount point.
  if (create) await mkdir(root, { recursive: true });
  return new StorageRoot(root).openDirectory(
    path.join(path.basename(parent), path.basename(resolved)),
    { create, mode: 0o700 },
  );
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

export class BackupUploadTooSlowError extends AppError {
  constructor(readonly bytesPerSecond: number) {
    super(
      408,
      "Request Timeout",
      `The backup upload was too slow and was abandoned. Uploads must average at least ${bytesPerSecond} bytes per second.`,
    );
  }
}

export const UPLOAD_INTERRUPTED_MESSAGE = "The backup upload did not complete";

/**
 * The slowest a backup upload may arrive (see
 * docs/remediation/r42-backup-limits.md). Every value comes from the
 * BACKUP_UPLOAD_* settings; tests pass short ones.
 */
export interface MinimumUploadRate {
  /** Bytes per second the upload must average over the window. */
  bytesPerSecond: number;
  /** The sliding window the average is taken over. */
  windowMs: number;
  /** Time from the start of the upload before the rate is enforced. */
  graceMs: number;
}

export interface RateWatch {
  /** Count `bytes` received now. */
  add(bytes: number): void;
  /**
   * The server has stopped reading (its staging write is behind), until
   * resume(). That time is not held against the client.
   */
  pause(): void;
  resume(): void;
  /** Stop watching. Safe to call more than once. */
  stop(): void;
}

/**
 * Count an upload's bytes as they arrive, and call `onTooSlow` once if, at
 * any check from `graceMs` after the start, the bytes received over the last
 * `windowMs` (or since the start, when that is shorter) average less than
 * `bytesPerSecond`. The check runs every tenth of the window, and at least
 * once a second, so a client that sends nothing at all is caught too.
 *
 * Time is measured, so a check that runs late does not count a shorter
 * period than it covers, but only while the server is reading: the grace
 * period and the window leave out every pause() to resume() span.
 */
export function watchRate(rate: MinimumUploadRate, onTooSlow: () => void): RateWatch {
  const checkMs = Math.max(1, Math.min(1000, Math.floor(rate.windowMs / 10)));
  const started = performance.now();
  let total = 0;
  let stopped = false;
  let pausedMs = 0;
  let pausedAt: number | undefined;
  /** Milliseconds since the start during which the server was reading. */
  const reading = (now: number) => now - started - pausedMs - (pausedAt === undefined ? 0 : now - pausedAt);
  // Totals at each check, oldest first. The first one is the newest at or
  // before the start of the window, so the window is always covered.
  const samples = [{ reading: 0, total: 0 }];
  const tooSlow = (now: number) =>
    total - samples[0].total < (rate.bytesPerSecond * (reading(now) - samples[0].reading)) / 1000;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    const now = reading(performance.now());
    samples.push({ reading: now, total });
    while (samples.length > 1 && samples[1].reading <= now - rate.windowMs) samples.shift();
    if (now < rate.graceMs || !tooSlow(performance.now())) return;
    // Timers run before pending socket reads. After synchronous work has
    // held up the process (parsing another backup, say), bytes the client
    // sent meanwhile are still waiting, so confirm once they have been read.
    setImmediate(() => {
      if (stopped || !tooSlow(performance.now())) return;
      stop();
      onTooSlow();
    });
  }, checkMs);
  timer.unref();
  return {
    add(bytes) {
      total += bytes;
    },
    pause() {
      pausedAt ??= performance.now();
    },
    resume() {
      if (pausedAt === undefined) return;
      pausedMs += performance.now() - pausedAt;
      pausedAt = undefined;
    },
    stop,
  };
}

/**
 * A new, unused staging path of `kind` in `dir`, which is created if needed.
 * Nothing is staged until leftovers of an earlier process have been swept.
 */
export async function stagingPath(kind: "upload" | "export", dir: string) {
  await prepareBackupStaging(dir);
  return (await stagingDirectory(dir)).entry(`${kind}-${randomUUID()}.part`);
}

/** Staging directories kept open, by path. */
const openStaging = new Map<string, Promise<StorageDirectory>>();

/**
 * The staging directory `dir`, checked and opened once and then kept open.
 * Staged files are named inside it (StorageDirectory.entry): with /proc each
 * staged path is `/proc/self/fd/<fd>/<name>`, so every later create, read
 * and removal of the file resolves inside the folder that was checked, even
 * if the folder is replaced by a link meanwhile. A folder removed since is
 * opened again; the earlier one stays open, as paths into it may be in use.
 */
async function stagingDirectory(dir: string): Promise<StorageDirectory> {
  const key = path.resolve(dir);
  const cached = openStaging.get(key);
  if (cached) {
    const directory = await cached.catch(() => undefined);
    if (directory && (await directory.exists())) return directory;
    if (openStaging.get(key) !== cached) return stagingDirectory(dir);
  }
  const opening = openStagingDirectory(dir, true);
  openStaging.set(key, opening);
  opening.catch(() => {
    if (openStaging.get(key) === opening) openStaging.delete(key);
  });
  return opening;
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
  /** Aborting it stops the copy with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Write `source` to a new staged file without holding it in memory. Over
 * `maxBytes`, or idle for `idleTimeoutMs`, the copy stops with a 413 or 408;
 * if `signal` is aborted, with its reason. On any failure the partial file is
 * closed and removed before the error is thrown.
 */
export async function stageStream(source: Readable, options: StageOptions): Promise<StagedFile> {
  const { signal } = options;
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
  const abort = () => meter.destroy(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let handle: FileHandle | undefined;
  let output: WriteStream | undefined;
  try {
    signal?.throwIfAborted();
    // A new file; a link planted at its name is never followed (R33).
    handle = await open(file, CREATE_NO_FOLLOW, 0o600);
    // Stopped while the file was being opened.
    signal?.throwIfAborted();
    output = handle.createWriteStream();
    await pipeStreams(source, meter, output);
  } catch (error) {
    // Release the source, and close the file before removing it.
    source.destroy();
    const stream = output;
    if (stream) {
      if (!stream.closed) {
        const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));
        stream.destroy();
        await closed;
      }
    } else {
      await handle?.close().catch(() => {});
    }
    await rm(file, { force: true });
    if (error instanceof AppError) throw error;
    // Disk errors are server errors; anything else came from the request.
    if (typeof (error as NodeJS.ErrnoException).syscall === "string") throw error;
    throw new ValidationError(UPLOAD_INTERRUPTED_MESSAGE);
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", abort);
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
 * during the file, is dropped. With `minRate`, a request whose body arrives
 * more slowly than that, before or during the file, is refused with a 408
 * (BackupUploadTooSlowError). The caller must dispose of the result once it
 * has finished with it.
 */
export async function receiveBackupUpload(
  request: FastifyRequest,
  {
    dir,
    maxBytes,
    idleTimeoutMs = BACKUP_TRANSFER_LIMITS.idleTimeoutMs,
    minRate,
    onFile,
  }: {
    dir: string;
    maxBytes: number;
    idleTimeoutMs?: number;
    /** The slowest the request body may arrive, from this call on. */
    minRate?: MinimumUploadRate;
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

  // Every byte of the body counts towards the minimum rate, multipart framing
  // included, until the file is staged. A body that has fully arrived is no
  // longer up to the client, so it is never refused as too slow. While the
  // request is paused because staging is behind, the server is not reading,
  // so that time does not count either.
  const tooSlow = new AbortController();
  const rate =
    minRate &&
    watchRate(minRate, () => {
      if (!raw.complete) tooSlow.abort(new BackupUploadTooSlowError(minRate.bytesPerSecond));
    });
  const count = (chunk: Buffer) => rate?.add(chunk.length);
  const paused = () => rate?.pause();
  const resumed = () => rate?.resume();
  if (raw.isPaused()) paused();
  raw.on("data", count);
  raw.on("pause", paused);
  raw.on("resume", resumed);
  const slow = new Promise<never>((_, reject) => {
    tooSlow.signal.addEventListener("abort", () => reject(tooSlow.signal.reason), { once: true });
  });
  slow.catch(() => {});

  try {
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
      file = await Promise.race([pending, stalled, slow]);
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
      staged = await stageStream(file.file, { dir, maxBytes, idleTimeoutMs, signal: tooSlow.signal });
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
  } finally {
    rate?.stop();
    raw.off("data", count);
    raw.off("pause", paused);
    raw.off("resume", resumed);
  }
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
  let directory: StorageDirectory;
  try {
    directory = await openStagingDirectory(dir, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  try {
    for (const name of await directory.list()) {
      if (!STAGED_NAME.test(name)) continue;
      // Inside the opened folder; a link of that name is removed itself.
      await rm(directory.entry(name), { force: true });
      removed++;
    }
  } finally {
    await directory.close();
  }
  if (removed > 0) log?.warn({ removed }, "Removed staged backup files left by an earlier process");
  return removed;
}
