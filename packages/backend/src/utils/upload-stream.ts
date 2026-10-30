import { pipeline, Transform, type Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { AppError, ValidationError } from "./errors.js";

/**
 * Streamed uploads (Drive files, wiki media, avatars): limits and failures.
 * See docs/remediation/p03a.md. Backup uploads have their own staging
 * (modules/backup/backup-staging.ts) with the same rules.
 */

export class UploadTooLargeError extends AppError {
  constructor(readonly maxBytes: number) {
    super(413, "Payload Too Large", `Upload exceeds ${maxBytes} bytes`);
  }
}

export class UploadStalledError extends AppError {
  constructor() {
    super(408, "Request Timeout", "The upload stalled and was abandoned");
  }
}

export const UPLOAD_INTERRUPTED_MESSAGE = "The upload did not complete";

/** The client went away, or sent a malformed or truncated multipart body. */
export class UploadInterruptedError extends ValidationError {
  constructor() {
    super(UPLOAD_INTERRUPTED_MESSAGE);
  }
}

export interface UploadLimits {
  /** Bytes of the file itself; one more is refused with a 413. */
  maxBytes: number;
  /** A request that sends no bytes for this long gets a 408. */
  idleTimeoutMs: number;
}

export interface ReceivedUpload {
  filename: string;
  mimetype: string;
  fields: MultipartFile["fields"];
  /**
   * The file's bytes. The stream fails with UploadTooLargeError past
   * maxBytes, UploadStalledError when idle, and UploadInterruptedError when
   * the client disconnects or the multipart body is malformed. Consume it at
   * once: it times out while nobody reads it.
   */
  stream: Readable;
}

/**
 * Wait for the request's file part and return it as a bounded stream.
 *
 * Until the file part starts, a client that sends nothing for
 * `idleTimeoutMs` gets a 408. A stalled client is not sending, so its
 * connection is closed after that response.
 */
export async function receiveUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  limits: UploadLimits,
): Promise<ReceivedUpload> {
  // The parser stops a file at its size limit without an error, which would
  // store a silently truncated file. One byte over the limit is allowed
  // through so the meter below refuses it.
  const pending = request.file({ limits: { fileSize: limits.maxBytes + 1 } });
  pending.catch(() => {});
  const raw = request.raw;
  let idle: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    idle = setTimeout(() => reject(new UploadStalledError()), limits.idleTimeoutMs);
  });
  stalled.catch(() => {});
  const onData = () => idle?.refresh();
  raw.on("data", onData);
  let file: MultipartFile | undefined;
  try {
    file = await Promise.race([pending, stalled]);
  } catch (error) {
    if (error instanceof UploadStalledError) reply.header("Connection", "close");
    throw error;
  } finally {
    clearTimeout(idle);
    raw.off("data", onData);
  }
  if (!file) throw new ValidationError("No file uploaded");
  return {
    filename: file.filename,
    mimetype: file.mimetype,
    fields: file.fields,
    stream: boundedFileStream(request, reply, file, limits),
  };
}

function boundedFileStream(
  request: FastifyRequest,
  reply: FastifyReply,
  file: MultipartFile,
  { maxBytes, idleTimeoutMs }: UploadLimits,
): Readable {
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new UploadTooLargeError(maxBytes));
        return;
      }
      idle.refresh();
      callback(null, chunk);
    },
    flush(callback) {
      // Unreachable while the parser's limit is maxBytes + 1; kept so a file
      // the parser cut short is never stored as if it were complete.
      if (file.file.truncated) callback(new UploadTooLargeError(maxBytes));
      else callback();
    },
  });
  const idle = setTimeout(() => {
    reply.header("Connection", "close");
    meter.destroy(new UploadStalledError());
  }, idleTimeoutMs);
  const raw = request.raw;
  const onClose = () => {
    if (!raw.complete) meter.destroy(new UploadInterruptedError());
  };
  raw.once("close", onClose);
  meter.once("close", () => {
    clearTimeout(idle);
    raw.off("close", onClose);
  });
  // A disconnect, or a multipart body that is cut short or malformed, is the
  // client's failure: a 400, never a 500. These listeners are registered
  // before pipeline()'s own, so their error is the one the consumer sees.
  const source = file.file;
  let ended = false;
  source.once("end", () => (ended = true));
  source.once("error", (error) => {
    meter.destroy(error instanceof AppError ? error : new UploadInterruptedError());
  });
  source.once("close", () => {
    if (!ended) meter.destroy(new UploadInterruptedError());
  });
  // The parser destroys the file when the client leaves, which may already
  // have happened while the handler checked access.
  if (source.destroyed || (raw.destroyed && !raw.complete)) {
    meter.destroy(new UploadInterruptedError());
  }
  pipeline(source, meter, () => {});
  return meter;
}
