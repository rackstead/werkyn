/**
 * The wire format between the server and a thumbnail decoder worker, over
 * the socket at the worker's fd 3. Requests are JSON lines: a decode
 * (`id`, `root`, `path`) or a liveness ping (`{"type":"ping","id":N}`).
 * Each reply is one frame: a result, `ready`, or `{"type":"pong","id":N}`.
 *
 *   u32 header length | u32 body length | JSON header | body (thumbnail bytes)
 *
 * A worker can be taken over through a decoder bug, so the server reads
 * replies with FrameReader, which checks both lengths before it buffers
 * anything more: a worker can never make the server hold more than one
 * frame of at most MAX_HEADER_BYTES + MAX_BODY_BYTES. Node's own IPC
 * channel is not used, since it parses a message of any size before the
 * receiver sees it.
 */

import path from "node:path";

/** A header is a few hundred bytes of JSON. */
export const MAX_HEADER_BYTES = 64 * 1024;
/** A thumbnail is a 400-pixel-wide WebP; anything larger is not one. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/**
 * A stored file for a decoder: `path` below the trusted directory `root` (the
 * storage root), opened there without following any link (R33). A plain
 * string is a file whose own directory is trusted.
 */
export type ThumbnailFile = string | { root: string; path: string };

/** The trusted directory and the path below it. */
export function thumbnailFileLocation(file: ThumbnailFile): { root: string; path: string } {
  return typeof file === "string"
    ? { root: path.dirname(file), path: path.basename(file) }
    : { root: file.root, path: file.path };
}

/** A request line (an id, a root and a path). */
export const MAX_REQUEST_BYTES = 64 * 1024;

export function encodeFrame(header: unknown, body: Uint8Array = new Uint8Array(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(json.length, 0);
  lengths.writeUInt32BE(body.length, 4);
  return Buffer.concat([lengths, json, body]);
}

export class ProtocolError extends Error {}

export interface Frame {
  header: unknown;
  body: Buffer;
}

/** Splits a byte stream into frames, refusing any that is too large. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;

  /** The frames completed by `chunk`. Throws ProtocolError on a bad frame. */
  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffered < 8) return frames;
      const lengths = this.peek(8);
      const headerBytes = lengths.readUInt32BE(0);
      const bodyBytes = lengths.readUInt32BE(4);
      if (headerBytes > MAX_HEADER_BYTES || bodyBytes > MAX_BODY_BYTES) {
        throw new ProtocolError(`a reply frame of ${headerBytes} + ${bodyBytes} bytes`);
      }
      const size = 8 + headerBytes + bodyBytes;
      if (this.buffered < size) return frames;
      const frame = this.take(size);
      let header: unknown;
      try {
        header = JSON.parse(frame.toString("utf8", 8, 8 + headerBytes));
      } catch {
        throw new ProtocolError("a reply header that is not JSON");
      }
      frames.push({ header, body: frame.subarray(8 + headerBytes) });
    }
  }

  private peek(bytes: number): Buffer {
    if (this.chunks[0].length < bytes) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0].subarray(0, bytes);
  }

  private take(bytes: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = all.length > bytes ? [all.subarray(bytes)] : [];
    this.buffered -= bytes;
    return all.subarray(0, bytes);
  }
}
