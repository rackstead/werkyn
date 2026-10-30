import fs, { type FileHandle } from "node:fs/promises";
import fss from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GoneError } from "../utils/errors.js";

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
  readStream(storagePath: string): fss.ReadStream;
  /** Opens the blob first; a missing blob rejects with MissingBlobError. */
  openReadStream(storagePath: string): Promise<fss.ReadStream>;
  /**
   * Idempotent: a blob that is already gone counts as deleted. Any other
   * storage failure is thrown so durable cleanup can retry it.
   */
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}

export class LocalStorageProvider implements StorageProvider {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private safePath(storagePath: string): string {
    const fullPath = path.resolve(this.rootDir, storagePath);
    if (!fullPath.startsWith(this.rootDir + path.sep) && fullPath !== this.rootDir) {
      throw new Error("Path traversal detected");
    }
    return fullPath;
  }

  private buildPath(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
  ) {
    const relPath = path.join(category, scopeId, `${fileId}${ext}`);
    const fullPath = this.safePath(relPath);
    return { relPath, fullPath };
  }

  async save(
    category: string,
    scopeId: string,
    fileId: string,
    ext: string,
    buffer: Buffer,
  ): Promise<string> {
    const { relPath, fullPath } = this.buildPath(category, scopeId, fileId, ext);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);

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
    const { relPath, fullPath } = this.buildPath(category, scopeId, fileId, ext);
    const maxSize = options?.maxSize ?? 0;
    const dir = path.dirname(fullPath);

    // The file is created before any byte is read. Directories this call
    // creates are removed again if it fails while they are still empty, so a
    // failed write leaves nothing behind; a concurrent failure may remove a
    // directory between mkdir and open, which is retried.
    let created: string | undefined;
    let handle: FileHandle | undefined;
    try {
      for (let attempt = 1; !handle; attempt++) {
        created ??= await fs.mkdir(dir, { recursive: true });
        try {
          handle = await fs.open(fullPath, "w");
        } catch (error) {
          if (!isMissingBlobError(error) || attempt >= 3) throw error;
        }
      }
    } catch (err) {
      stream.destroy();
      await this.removeEmptyDirectories(dir, created);
      throw err;
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
    const writeStream = handle.createWriteStream({
      highWaterMark: 2 * 1024 * 1024, // 2MB buffer for efficient disk writes
    });

    try {
      // pipeline() applies backpressure, fails if the source ends early or
      // was already destroyed, and settles only once the file is closed.
      await pipeline(stream, meter, writeStream);
      return { storagePath: relPath, size: bytesWritten };
    } catch (err) {
      // Clean up partial file on any error
      await fs.unlink(fullPath).catch(() => {});
      await this.removeEmptyDirectories(dir, created);
      throw err;
    }
  }

  /**
   * Remove `dir` and its parents up to `top` (a directory a write created),
   * while they are empty. Never removes the storage root or anything above it.
   */
  private async removeEmptyDirectories(dir: string, top: string | undefined) {
    if (!top) return;
    for (
      let current = dir;
      current.startsWith(this.rootDir + path.sep) &&
      (current === top || current.startsWith(top + path.sep));
      current = path.dirname(current)
    ) {
      try {
        await fs.rmdir(current);
      } catch {
        return; // not empty (another write uses it) or already gone
      }
    }
  }

  async read(storagePath: string): Promise<Buffer> {
    const fullPath = this.safePath(storagePath);
    return fs.readFile(fullPath);
  }

  readStream(storagePath: string): fss.ReadStream {
    const fullPath = this.safePath(storagePath);
    return fss.createReadStream(fullPath);
  }

  async openReadStream(storagePath: string): Promise<fss.ReadStream> {
    const stream = this.readStream(storagePath);
    try {
      await once(stream, "open");
    } catch (error) {
      stream.destroy();
      if (isMissingBlobError(error)) throw new MissingBlobError();
      throw error;
    }
    return stream;
  }

  async delete(storagePath: string): Promise<void> {
    const fullPath = this.safePath(storagePath);
    try {
      await fs.unlink(fullPath);
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    const fullPath = this.safePath(storagePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}
