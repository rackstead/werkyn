import path from "node:path";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import type { OpenedBlob } from "../../services/storage.js";

/** Closers of blobs whose response has not been handed its body yet. */
const pending = new WeakMap<FastifyReply, () => void>();

/**
 * Send a blob that StorageProvider.open has checked and opened, with the
 * static file server's HEAD, range and validator handling. `type`, if given,
 * is the Content-Type; the static server sets none.
 *
 * With /proc, the static server reads `/proc/self/fd/<fd>`, which reopens
 * exactly the file that was checked: a link planted after the check is never
 * followed. The descriptor stays open until the response body has closed
 * (released from the onSend hook in plugins/static.ts). Without /proc
 * (development on macOS), the file is served by its path just after the
 * check.
 */
export function sendStoredFile(reply: FastifyReply, blob: OpenedBlob, type?: string) {
  if (type) reply.type(type);
  if (!blob.procPath) {
    void blob.handle.close().catch(() => {});
    return reply.sendFile(blob.storagePath, blob.root, { contentType: false });
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void blob.handle.close().catch(() => {});
  };
  pending.set(reply, close);
  // If the response ends before onSend ever ran, nothing reads the file.
  reply.raw.once("close", () => {
    if (pending.get(reply) !== close) return;
    pending.delete(reply);
    close();
  });
  return reply.sendFile(path.basename(blob.procPath), path.dirname(blob.procPath), {
    contentType: false,
  });
}

/**
 * onSend receives the static server's body: a stream that opens its own
 * descriptor of the checked file, or an empty or error body. The checked
 * descriptor is closed once that stream has closed, so its number cannot be
 * reused by another file before the stream has opened it.
 */
export function releaseStoredFile(reply: FastifyReply, payload: unknown) {
  const close = pending.get(reply);
  if (!close) return;
  pending.delete(reply);
  if (payload instanceof Readable && !payload.closed) payload.once("close", close);
  else close();
}
