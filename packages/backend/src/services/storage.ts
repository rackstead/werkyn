import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

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

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    let bytesWritten = 0;

    const writeStream = fss.createWriteStream(fullPath, {
      highWaterMark: 2 * 1024 * 1024, // 2MB buffer for efficient disk writes
    });

    try {
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (chunk: Buffer) => {
          bytesWritten += chunk.length;
          if (maxSize > 0 && bytesWritten > maxSize) {
            stream.destroy(
              new Error(`File size exceeds limit of ${maxSize} bytes`),
            );
            return;
          }
          const ok = writeStream.write(chunk);
          if (!ok) {
            stream.pause();
            writeStream.once("drain", () => stream.resume());
          }
        });

        stream.on("end", () => {
          writeStream.end(() => resolve());
        });

        stream.on("error", (err) => {
          writeStream.destroy();
          reject(err);
        });

        writeStream.on("error", (err) => {
          stream.destroy();
          reject(err);
        });
      });

      return { storagePath: relPath, size: bytesWritten };
    } catch (err) {
      // Clean up partial file on any error
      await fs.unlink(fullPath).catch(() => {});
      throw err;
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

  async delete(storagePath: string): Promise<void> {
    const fullPath = this.safePath(storagePath);
    await fs.unlink(fullPath).catch(() => {
      // Ignore if file already deleted
    });
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
