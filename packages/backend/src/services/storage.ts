import fs from "node:fs/promises";
import type fss from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GoneError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  StorageRefusedError,
  StorageRoot,
  storagePathNames,
  type OpenedFile,
  type StorageRootOptions,
} from "./storage-paths.js";

export { StorageRefusedError, isStorageRefusedError } from "./storage-paths.js";

/**
 * A record exists but its stored bytes do not (for example a blob removed
 * outside the application or lost in a restore). Reported as 410 JSON before
 * any response headers are written, never as an unhandled stream error.
 */
export class MissingBlobError extends GoneError {
  constructor() {
    super("File content is no longer available");
  }
}

/** ENOENT/ENOTDIR: the blob (or a parent directory) does not exist. */
export function isMissingBlobError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Where a decoder process finds a blob: the storage root's real path and the
 * blob's path below it. The decoder opens it there without following links.
 */
export interface StoredFileLocation {
  root: string;
  path: string;
}

/** A blob opened for an HTTP response (see sendStoredFile). */
export interface OpenedBlob extends OpenedFile {
  storagePath: string;
  /** The storage root's real path. */
  root: string;
}

export interface StorageProvider {
  save(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
    buffer: Buffer,
  ): Promise<string>;
  saveStream(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
    stream: Readable,
    options?: { maxSize?: number },
  ): Promise<{ storagePath: string; size: number }>;
  read(storagePath: string): Promise<Buffer>;
  /** Where a decoder process reads the blob (see StoredFileLocation). */
  decoderLocation(storagePath: string): Promise<StoredFileLocation>;
  /**
   * The blob's bytes, opened when first read. `range` selects bytes `start`
   * to `end` inclusive, as in `fs.createReadStream`.
   */
  readStream(storagePath: string, range?: ByteRange): Readable;
  /** Opens the blob first; a missing blob rejects with MissingBlobError. */
  openReadStream(storagePath: string, range?: ByteRange): Promise<fss.ReadStream>;
  /** The open, checked blob for an HTTP response; missing rejects with MissingBlobError. */
  open(storagePath: string): Promise<OpenedBlob>;
  /**
   * Idempotent: a blob that is already gone counts as deleted. Any other
   * storage failure is thrown so durable cleanup can retry it.
   */
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}

type Log = Pick<typeof logger, "warn" | "info">;

export interface LocalStorageOptions extends StorageRootOptions {
  /** Where refusals are logged (default: the application logger). */
  log?: Log;
}

/**
 * Blobs below a local directory. The directory (STORAGE_DIR) may be a link
 * or a mount point and is resolved to its real path once. Below it, no
 * symbolic link is ever followed and only regular files are read: every
 * access goes through StorageRoot (storage-paths.ts). A refused access is
 * logged and fails with StorageRefusedError (403).
 */
export class LocalStorageProvider implements StorageProvider {
  private readonly configured: string;
  private resolved: StorageRoot | undefined;
  private readonly log: Log;

  constructor(
    rootDir: string,
    private readonly options: LocalStorageOptions = {},
  ) {
    this.configured = path.resolve(rootDir);
    this.log = options.log ?? logger;
  }

  /**
   * Resolve the root once: create it if it is missing, then follow any link
   * or mount to its real path, which every later access uses. Returns it.
   */
  async init(): Promise<string> {
    return (await this.root(true)).path;
  }

  /** How accesses below the root are checked (see StorageRoot.accessMode). */
  async accessMode() {
    return (await this.root()).accessMode();
  }

  /** The root's real path; available once `init` (or any access) has resolved it. */
  get rootPath(): string {
    if (!this.resolved) throw new Error("The storage root has not been resolved yet");
    return this.resolved.path;
  }

  private async root(create = false): Promise<StorageRoot> {
    if (this.resolved) return this.resolved;
    let real: string;
    try {
      real = await fs.realpath(this.configured);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(this.configured, { recursive: true });
      real = await fs.realpath(this.configured);
    }
    const { log: _log, ...rootOptions } = this.options;
    return (this.resolved ??= new StorageRoot(real, rootOptions));
  }

  /** Log a refusal, then pass the error on. */
  private refused(error: unknown, operation: string): unknown {
    if (error instanceof StorageRefusedError) {
      this.log.warn(
        { storagePath: error.storagePath, reason: error.reason, operation },
        "Refused stored file access: links and special files below the storage root are never followed",
      );
    }
    return error;
  }

  private buildPath(category: string, scopeId: string, fileId: string, ext: string) {
    const relPath = path.join(category, scopeId, `${fileId}${ext}`);
    // Refuse traversal before the root is created or resolved.
    storagePathNames(this.configured, relPath);
    return relPath;
  }

  async save(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
    buffer: Buffer,
  ): Promise<string> {
    const relPath = this.buildPath(category, scopeId, fileId, ext);
    const root = await this.root(true);
    let created;
    try {
      created = await root.createFile(relPath);
    } catch (error) {
      throw this.refused(error, "write");
    }
    try {
      await created.handle.writeFile(buffer);
      await created.handle.close();
    } catch (error) {
      await created.handle.close().catch(() => {});
      await this.discard(root, relPath, created.createdFrom);
      throw error;
    }
    return relPath;
  }

  async saveStream(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
    stream: Readable,
    options?: { maxSize?: number },
  ): Promise<{ storagePath: string; size: number }> {
    const maxSize = options?.maxSize ?? 0;

    // The file is created before any byte is read. Directories this call
    // creates are removed again if it fails while they are still empty, so a
    // failed write leaves nothing behind. Concurrent cleanup may remove one
    // of them meanwhile; createFile then repeats the whole attempt.
    let relPath: string;
    let root: StorageRoot;
    let created;
    try {
      relPath = this.buildPath(category, scopeId, fileId, ext);
      root = await this.root(true);
      created = await root.createFile(relPath);
    } catch (err) {
      stream.destroy();
      throw this.refused(err, "write");
    }

    let bytesWritten = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesWritten += chunk.length;
        if (maxSize > 0 && bytesWritten > maxSize) {
          callback(new Error(`File size exceeds limit of ${maxSize} bytes`));
          return;
        }
        callback(null, chunk);
      },
    });
    const writeStream = created.handle.createWriteStream({
      highWaterMark: 2 * 1024 * 1024, // 2MB buffer for efficient disk writes
    });

    try {
      // pipeline() applies backpressure, fails if the source ends early or
      // was already destroyed, and settles only once the file is closed.
      await pipeline(stream, meter, writeStream);
      return { storagePath: relPath, size: bytesWritten };
    } catch (err) {
      // Clean up partial file on any error
      await this.discard(root, relPath, created.createdFrom);
      throw err;
    }
  }

  /** Remove a partly written file and the directories its write made. */
  private async discard(root: StorageRoot, relPath: string, createdFrom: number | undefined) {
    await root.unlink(relPath).catch(() => {});
    if (createdFrom !== undefined) await root.removeEmptyDirectories(relPath, createdFrom);
  }

  /** The blob, checked and opened; missing is MissingBlobError, a refusal is logged. */
  private async openBlob(storagePath: string, operation: string): Promise<OpenedBlob> {
    try {
      const root = await this.root();
      return { ...(await root.openFile(storagePath)), storagePath, root: root.path };
    } catch (error) {
      if (isMissingBlobError(error)) throw new MissingBlobError();
      throw this.refused(error, operation);
    }
  }

  async read(storagePath: string): Promise<Buffer> {
    const { handle } = await this.openBlob(storagePath, "read");
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async decoderLocation(storagePath: string): Promise<StoredFileLocation> {
    const root = await this.root();
    root.names(storagePath);
    return { root: root.path, path: storagePath };
  }

  readStream(storagePath: string, range?: ByteRange): Readable {
    // Opened on the first read, so a caller may queue many (a zip archive)
    // without holding a descriptor for each.
    const open = () => this.openReadStream(storagePath, range);
    return Readable.from(
      (async function* () {
        const stream = await open();
        try {
          yield* stream;
        } finally {
          stream.destroy();
        }
      })(),
      { objectMode: false },
    );
  }

  async openReadStream(storagePath: string, range?: ByteRange): Promise<fss.ReadStream> {
    const { handle } = await this.openBlob(storagePath, "read");
    return handle.createReadStream(range);
  }

  open(storagePath: string): Promise<OpenedBlob> {
    return this.openBlob(storagePath, "read");
  }

  async delete(storagePath: string): Promise<void> {
    let root: StorageRoot;
    try {
      root = await this.root();
    } catch (error) {
      if (isMissingBlobError(error)) return;
      throw error;
    }
    let result;
    try {
      result = await root.unlink(storagePath);
    } catch (error) {
      throw this.refused(error, "delete");
    }
    if (result === "link-removed") {
      this.log.warn(
        { storagePath, operation: "delete" },
        "Removed a symbolic link found at a stored file's path; what it pointed to was not touched",
      );
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    let root: StorageRoot;
    try {
      root = await this.root();
    } catch (error) {
      if (isMissingBlobError(error)) return false;
      throw error;
    }
    try {
      return await root.exists(storagePath);
    } catch (error) {
      throw this.refused(error, "exists");
    }
  }
}
