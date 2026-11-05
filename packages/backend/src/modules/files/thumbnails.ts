import os from "node:os";
import sharp from "sharp";
import type { Metadata, SharpOptions } from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { logger } from "../../utils/logger.js";

/**
 * Drive thumbnails: which stored bytes may reach a native image decoder, with
 * which limits, and how many decodes one process runs at a time. Thumbnails
 * are optional, so every refusal or failure here only leaves one out. See
 * docs/remediation/r19.md for the measurements behind these numbers.
 */

/**
 * Thumbnails are made from a copy of the original held in memory, so only
 * images up to this size get one (see docs/remediation/p03a.md).
 */
export const THUMBNAIL_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

export type ThumbnailFormat = "jpeg" | "png" | "webp" | "gif" | "avif";

/**
 * The only formats that are decoded. The format is chosen from the bytes by
 * `thumbnailFormat`; the `file-type` detector and libvips must then agree on
 * it, and libvips may use only the loader listed here.
 */
const FORMATS: Record<
  ThumbnailFormat,
  { detected: ReadonlySet<string>; libvips: string; loader: string }
> = {
  jpeg: { detected: new Set(["image/jpeg"]), libvips: "jpeg", loader: "VipsForeignLoadJpegBuffer" },
  png: { detected: new Set(["image/png", "image/apng"]), libvips: "png", loader: "VipsForeignLoadPngBuffer" },
  webp: { detected: new Set(["image/webp"]), libvips: "webp", loader: "VipsForeignLoadWebpBuffer" },
  gif: { detected: new Set(["image/gif"]), libvips: "gif", loader: "VipsForeignLoadNsgifBuffer" },
  avif: { detected: new Set(["image/avif"]), libvips: "heif", loader: "VipsForeignLoadHeifBuffer" },
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_CHUNKS = new Set(["VP8 ", "VP8L", "VP8X"]);
// HEIC/HEVC and generic HEIF brands are not decoded: the bundled libheif has
// no HEVC decoder. libvips 8.18 does not load the AVIF sequence brand (avis).
const AVIF_BRANDS = new Set(["avif"]);

/** How many leading bytes `thumbnailFormat` needs. */
export const THUMBNAIL_HEAD_BYTES = 64;

/**
 * The allowlisted format a stored file starts as, or null. `buffer` is the
 * file or at least its first THUMBNAIL_HEAD_BYTES bytes, and `size` the
 * file's size. Only fixed signatures at fixed offsets are read: SVG, PDF,
 * TIFF, HEIC and anything else are never sent to the detector or a decoder,
 * whatever their declared type or filename.
 */
export function thumbnailFormat(buffer: Buffer, size = buffer.length): ThumbnailFormat | null {
  const text = (start: number, end: number) => buffer.toString("latin1", start, end);
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer.length >= 16 &&
    buffer.subarray(0, 8).equals(PNG_SIGNATURE) &&
    buffer.readUInt32BE(8) === 13 &&
    text(12, 16) === "IHDR"
  ) {
    return "png";
  }
  if (buffer.length >= 13 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) {
    return "gif";
  }
  if (
    buffer.length >= 16 &&
    text(0, 4) === "RIFF" &&
    text(8, 12) === "WEBP" &&
    WEBP_CHUNKS.has(text(12, 16))
  ) {
    return "webp";
  }
  if (buffer.length >= 16 && text(4, 8) === "ftyp" && AVIF_BRANDS.has(text(8, 12))) {
    // An ordinary 32-bit ftyp box that fits the buffer (see
    // thumbnail-content-boundary.md); other size forms get no thumbnail.
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= size && boxSize <= THUMBNAIL_SOURCE_MAX_BYTES) {
      return "avif";
    }
  }
  return null;
}

/** Output and decoder limits. Every safety option is set, not defaulted. */
export const THUMBNAIL_LIMITS = Object.freeze({
  width: 400,
  quality: 80,
  /** width x height of the first frame; sharp's default, 0x3FFF squared. */
  maxInputPixels: 0x3fff * 0x3fff,
  /** RGBA or CMYK; nothing allowlisted needs more. */
  maxInputChannels: 4,
  /**
   * Estimated decoder working memory for one transform
   * (`estimateDecodeBytes`). Some formats must be decoded whole: a 2 KiB
   * 100-megapixel AVIF needs about 1.7 GiB.
   */
  decodeBudgetBytes: 384 * 1024 * 1024,
  /**
   * Scans in one JPEG. libjpeg reads every scan of a progressive JPEG before
   * libvips' timeout can act, so a long scan script is otherwise limited
   * only by time. Encoders write about 10.
   */
  maxJpegScans: 100,
  /** libvips stops a transform after this long... */
  transformTimeoutSeconds: 10,
  /** ...and the upload stops waiting for it a little after that. */
  transformDeadlineMs: 12_000,
  /** How long reading the first bytes, before admission, may take. */
  headTimeoutMs: 2_000,
});

/** Options for every decode, metadata included. */
const INPUT_OPTIONS: SharpOptions = Object.freeze({
  failOn: "warning",
  limitInputPixels: THUMBNAIL_LIMITS.maxInputPixels,
  limitInputChannels: THUMBNAIL_LIMITS.maxInputChannels,
  unlimited: false,
  sequentialRead: true,
  // Only the first frame (or the primary HEIF image) of animated input.
  pages: 1,
  // Thumbnails have never applied EXIF orientation.
  autoOrient: false,
});

const SAMPLE_BYTES: Record<string, number> = {
  uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4,
};

/** What the container says about the decode, beyond libvips' header. */
export interface DecodeHints {
  /**
   * Pixels the decoder really produces, when more than the reported size:
   * the largest coded AVIF image (a `clap` crop only trims the output) or
   * the WebP canvas.
   */
  codedPixels?: number;
  /** WebP that is lossless or has alpha. */
  webpFullCanvas?: boolean;
  /** Animated WebP. */
  webpAnimated?: boolean;
}

/**
 * Upper estimate of the memory libvips 8.18 and its codecs need to make one
 * thumbnail, from the header alone (measured in docs/remediation/r19.md,
 * plus at least 20% headroom). Formats that cannot be read row by row
 * (interlaced PNG, progressive JPEG, GIF frames, AVIF, lossless, alpha and
 * animated WebP) are charged for the whole decoded image; the others for
 * the buffering seen while they stream through the resize.
 */
export function estimateDecodeBytes(
  meta: Pick<Metadata, "format" | "width" | "height" | "channels" | "depth" | "isProgressive">,
  hints: DecodeHints = {},
): number {
  const { width, height, channels } = meta;
  const sampleBytes = SAMPLE_BYTES[meta.depth ?? ""];
  if (!width || !height || !channels || !sampleBytes) return Infinity;
  const pixels = Math.max(width * height, hints.codedPixels ?? 0);
  const bytes = pixels * channels * sampleBytes;
  switch (meta.format) {
    case "jpeg":
      // Progressive: 16-bit DCT coefficients for every sample, whole image.
      return meta.isProgressive ? pixels * channels * 2.5 : bytes / 4;
    case "png":
      // Interlaced (Adam7) PNG is decoded whole.
      return meta.isProgressive ? bytes * 1.5 : bytes / 4;
    case "gif":
      // Frames are drawn onto an RGBA canvas of the whole image.
      return pixels * 7;
    case "webp":
      // libvips composites animation frames onto a full RGBA canvas;
      // libwebp decodes lossless (VP8L) images whole as 32-bit ARGB, and
      // alpha at full size. Plain lossy VP8 decodes scaled.
      return pixels * (hints.webpAnimated ? 6.5 : hints.webpFullCanvas ? 5.5 : 2);
    case "heif":
      // AV1 frame buffers, then RGB(A) copies in libheif and libvips.
      return pixels * 16 + bytes * 2;
    default:
      return Infinity;
  }
}

/**
 * Boxes, chunks or markers one container check reads before it refuses the
 * file. Real files have tens; the bound keeps a crafted 32 MiB file of tiny
 * entries from blocking the event loop.
 */
const MAX_CONTAINER_ENTRIES = 4096;

/**
 * Bytes of entropy-coded JPEG data that may be 0xFF (each stuffed or a
 * restart marker) before the scan count stops. Noise-like data has one in
 * 256, about 131,000 in 32 MiB.
 */
const MAX_JPEG_ESCAPES = 1 << 20;

interface Box {
  type: string;
  body: number;
  end: number;
}

/**
 * ISO BMFF boxes between `start` and `end`, read one at a time. Throws on a
 * malformed size, or once `budget` boxes have been read in total.
 */
function* isoBoxes(buffer: Buffer, start: number, end: number, budget: { left: number }): Generator<Box> {
  for (let pos = start; pos + 8 <= end; ) {
    if (--budget.left < 0) throw new RangeError("too many boxes");
    let size = buffer.readUInt32BE(pos);
    let header = 8;
    if (size === 1) {
      const large = buffer.readBigUInt64BE(pos + 8);
      if (large > BigInt(end - pos)) throw new RangeError("box");
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) throw new RangeError("box");
    yield { type: buffer.toString("latin1", pos + 4, pos + 8), body: pos + header, end: pos + size };
    pos += size;
  }
}

/** Derived image items, whose output libheif composes from other items. */
const DERIVED_ITEMS = new Set(["grid", "iovl", "iden"]);

/**
 * The AVIF item structure that decides what libheif decodes: the primary
 * item's type, any derived (grid, overlay or identity) items, and the
 * largest coded image size (`ispe`) of any item. libvips reports the size
 * after `clap` cropping, but the whole coded image is decoded; libheif
 * refuses an image whose coded size differs from its `ispe`. Null when the
 * structure cannot be read.
 */
export function avifStructure(
  buffer: Buffer,
): { primaryType: string; derived: string[]; maxCodedPixels: number } | null {
  try {
    const budget = { left: MAX_CONTAINER_ENTRIES };
    let meta: Box | undefined;
    for (const box of isoBoxes(buffer, 0, buffer.length, budget)) {
      if (box.type === "meta") {
        meta = box;
        break;
      }
    }
    if (!meta) return null;
    let primary: number | undefined;
    const types = new Map<number, string>();
    let maxCodedPixels = 0;
    for (const box of isoBoxes(buffer, meta.body + 4, meta.end, budget)) {
      if (box.type === "pitm" && box.end - box.body >= 6) {
        primary = buffer[box.body] === 0 ? buffer.readUInt16BE(box.body + 4) : buffer.readUInt32BE(box.body + 4);
      } else if (box.type === "iinf" && box.end - box.body >= 6) {
        const first = box.body + 4 + (buffer[box.body] === 0 ? 2 : 4);
        for (const infe of isoBoxes(buffer, first, box.end, budget)) {
          const version = buffer[infe.body];
          if (infe.type !== "infe" || version < 2) continue;
          const idBytes = version === 2 ? 2 : 4;
          const typeAt = infe.body + 4 + idBytes + 2;
          if (typeAt + 4 > infe.end) return null;
          const id = idBytes === 2 ? buffer.readUInt16BE(infe.body + 4) : buffer.readUInt32BE(infe.body + 4);
          types.set(id, buffer.toString("latin1", typeAt, typeAt + 4));
        }
      } else if (box.type === "iprp") {
        for (const container of isoBoxes(buffer, box.body, box.end, budget)) {
          if (container.type !== "ipco") continue;
          for (const property of isoBoxes(buffer, container.body, container.end, budget)) {
            if (property.type !== "ispe") continue;
            if (property.end - property.body < 12) return null;
            const pixels = buffer.readUInt32BE(property.body + 4) * buffer.readUInt32BE(property.body + 8);
            maxCodedPixels = Math.max(maxCodedPixels, pixels);
          }
        }
      }
    }
    if (primary === undefined || maxCodedPixels === 0) return null;
    return {
      primaryType: types.get(primary) ?? "unknown",
      derived: [...types.values()].filter((type) => DERIVED_ITEMS.has(type)),
      maxCodedPixels,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a WebP decodes at full size (lossless or alpha), whether it is
 * animated, and its VP8X canvas size, from its RIFF chunks. Null when the
 * container or a chunk overruns the file or there are too many to read.
 */
export function webpFeatures(
  buffer: Buffer,
): { fullCanvas: boolean; animated: boolean; canvasPixels: number } | null {
  // Only the RIFF container's declared length is image data; libwebp
  // ignores anything after it.
  const end = 8 + buffer.readUInt32LE(4);
  if (end > buffer.length) return null;
  let fullCanvas = false;
  let animated = false;
  let canvasPixels = 0;
  let chunks = 0;
  for (let pos = 12; pos + 8 <= end && !animated; ) {
    if (++chunks > MAX_CONTAINER_ENTRIES) return null;
    const type = buffer.toString("latin1", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (body + size > end) return null;
    if (type === "VP8X") {
      if (size < 10) return null;
      // Flags: alpha 0x10, animation 0x02.
      if (buffer[body] & 0x10) fullCanvas = true;
      if (buffer[body] & 0x02) animated = true;
      canvasPixels = (buffer.readUIntLE(body + 4, 3) + 1) * (buffer.readUIntLE(body + 7, 3) + 1);
    } else if (type === "VP8L" || type === "ALPH") {
      fullCanvas = true;
    } else if (type === "ANIM" || type === "ANMF") {
      animated = true;
    }
    pos = body + size + (size & 1);
  }
  return { fullCanvas: fullCanvas || animated, animated, canvasPixels };
}

/**
 * Start-of-scan markers in a JPEG, counting no further than `stopAfter + 1`.
 * Entropy-coded data is skipped by searching for the next marker byte.
 * Infinity when the file has more markers or escaped bytes than are read.
 */
export function jpegScanCount(buffer: Buffer, stopAfter: number): number {
  let scans = 0;
  let pos = 2;
  let markers = 0;
  let escapes = 0;
  while (pos + 4 <= buffer.length && buffer[pos] === 0xff) {
    if (++markers > MAX_CONTAINER_ENTRIES) return Infinity;
    const marker = buffer[pos + 1];
    if (marker === 0xff) {
      pos++; // fill byte
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const length = buffer.readUInt16BE(pos + 2);
    if (length < 2) break;
    pos += 2 + length;
    if (marker !== 0xda) continue;
    if (++scans > stopAfter) break;
    // Skip entropy-coded data: stuffed 0xFF00 bytes and restart markers
    // belong to the scan; any other marker ends it.
    for (;;) {
      const at = buffer.indexOf(0xff, pos);
      if (at === -1 || at + 1 >= buffer.length) return scans;
      if (++escapes > MAX_JPEG_ESCAPES) return Infinity;
      const next = buffer[at + 1];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        pos = at + 2;
      } else if (next === 0xff) {
        pos = at + 1;
      } else {
        pos = at;
        break;
      }
    }
  }
  return scans;
}

/** Concurrent transforms in one process. */
export interface ThumbnailAdmissionLimits {
  /** Transforms decoding at once. */
  maxActive: number;
  /** Uploads waiting for a turn; any more get no thumbnail at once. */
  maxQueued: number;
  /** How long an upload waits for a turn before going without. */
  queueTimeoutMs: number;
}

/**
 * At most half the CPUs and two transforms, each on one libvips thread, so
 * thumbnails never take more than two of libuv's four default threads that
 * file I/O, password hashing and compression also need.
 */
export function defaultAdmissionLimits(
  cpus = os.availableParallelism(),
): ThumbnailAdmissionLimits {
  return {
    maxActive: Math.max(1, Math.min(2, Math.floor(cpus / 2))),
    maxQueued: 8,
    queueTimeoutMs: 5_000,
  };
}

type Release = () => void;

interface Waiter {
  key: string;
  grant: (release: Release | null) => void;
}

/**
 * A semaphore with a bounded queue and a bounded wait, shared fairly between
 * keys (workspaces). A free turn goes to the oldest waiter among the keys
 * with the fewest active transforms, and when the queue is full a key holding
 * fewer turns takes the newest place of the key holding the most, so one
 * workspace cannot keep another's uploads from ever being admitted.
 */
export class TransformAdmission {
  private active = 0;
  private readonly activeByKey = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(readonly limits: ThumbnailAdmissionLimits) {}

  /** A release function once admitted; null when refused or the wait times out. */
  acquire(key = ""): Promise<Release | null> {
    if (this.active < this.limits.maxActive) return Promise.resolve(this.admit(key));
    if (this.queue.length >= this.limits.maxQueued && !this.makeRoomFor(key)) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        key,
        grant: (release) => {
          clearTimeout(timer);
          resolve(release);
        },
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(null);
      }, this.limits.queueTimeoutMs);
      this.queue.push(waiter);
    });
  }

  /** Active plus queued turns of `key`. */
  private held(key: string) {
    return (this.activeByKey.get(key) ?? 0) + this.queue.filter((w) => w.key === key).length;
  }

  /**
   * Refuse the newest waiter of the key holding the most turns, if that is
   * at least two more than `key` holds, so the swap never reverses.
   */
  private makeRoomFor(key: string): boolean {
    let busiest: string | undefined;
    for (const waiter of this.queue) {
      if (busiest === undefined || this.held(waiter.key) > this.held(busiest)) busiest = waiter.key;
    }
    if (busiest === undefined || busiest === key || this.held(busiest) < this.held(key) + 2) {
      return false;
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].key === busiest) {
        const [evicted] = this.queue.splice(i, 1);
        evicted.grant(null);
        return true;
      }
    }
    return false;
  }

  private admit(key: string): Release {
    this.active++;
    this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.activeByKey.get(key) ?? 1) - 1;
      if (left > 0) this.activeByKey.set(key, left);
      else this.activeByKey.delete(key);
      let next: Waiter | undefined;
      for (const waiter of this.queue) {
        const active = this.activeByKey.get(waiter.key) ?? 0;
        if (!next || active < (this.activeByKey.get(next.key) ?? 0)) next = waiter;
      }
      if (next) {
        this.queue.splice(this.queue.indexOf(next), 1);
        next.grant(this.admit(next.key));
      }
    };
  }

  /** Current use, for tests and diagnostics. */
  get usage() {
    return { active: this.active, queued: this.queue.length };
  }
}

export const thumbnailAdmission = new TransformAdmission(defaultAdmissionLimits());

export type ThumbnailOutcome =
  | "created"
  | "busy"
  | "unsupported"
  | "over-budget"
  | "failed"
  | "timed-out";

/** Outcome counts since start, for tests and diagnostics. */
export const thumbnailOutcomes: Record<ThumbnailOutcome, number> = {
  created: 0, busy: 0, unsupported: 0, "over-budget": 0, failed: 0, "timed-out": 0,
};

/**
 * libvips is configured once for this process, which uses sharp only here:
 * one worker thread per transform, no operation cache holding decoded
 * images, and every loader blocked except the allowlisted buffer loaders.
 * A polyglot or disguised file therefore cannot reach SVG, TIFF, PDF,
 * UltraHDR, Radiance or any other loader even if it passed the checks above.
 */
sharp.concurrency(1);
sharp.cache(false);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: Object.values(FORMATS).map((format) => format.loader) });

/** What a skipped thumbnail is logged with. */
interface Details {
  format?: ThumbnailFormat;
  width?: number;
  height?: number;
  estimateBytes?: number;
  reason?: string;
}

class Skip extends Error {
  constructor(
    readonly outcome: ThumbnailOutcome,
    readonly details: Details = {},
  ) {
    super(outcome);
  }
}

const TIMED_OUT = Symbol("timed out");

/** A stored file to make a thumbnail of. */
export interface ThumbnailSource {
  /** Its size in bytes. */
  size: number;
  /**
   * At least its first THUMBNAIL_HEAD_BYTES bytes, or all of a shorter file.
   * `signal` aborts when the caller stops waiting.
   */
  head(signal: AbortSignal): Promise<Buffer>;
  /** The whole file. */
  read(): Promise<Buffer>;
}

/** A source over bytes already in memory. */
export function bufferSource(bytes: Buffer): ThumbnailSource {
  return {
    size: bytes.length,
    head: async () => bytes.subarray(0, THUMBNAIL_HEAD_BYTES),
    read: async () => bytes,
  };
}

export interface ThumbnailOptions {
  /** Admission is shared fairly between workspaces; also logged. */
  workspaceId?: string;
  /** Logged with a skipped thumbnail. */
  fileId?: string;
  admission?: TransformAdmission;
  deadlineMs?: number;
  headTimeoutMs?: number;
}

/**
 * A WebP thumbnail of `source`, or null. The file's first bytes are checked
 * against the allowlisted signatures before it waits for a turn, so other
 * content never takes one. It then waits (at most `queueTimeoutMs`), reads
 * the whole file only once admitted, and stops waiting `transformDeadlineMs`
 * after admission, whether the read or the decoder is slow. The turn is held
 * until that work has actually settled, so work the upload stopped waiting
 * for still counts against the limit, and a read that finishes late starts
 * no decode. Never throws.
 */
export async function createThumbnail(
  source: ThumbnailSource,
  {
    workspaceId,
    fileId,
    admission = thumbnailAdmission,
    deadlineMs = THUMBNAIL_LIMITS.transformDeadlineMs,
    headTimeoutMs = THUMBNAIL_LIMITS.headTimeoutMs,
  }: ThumbnailOptions = {},
): Promise<Buffer | null> {
  const context = { workspaceId, fileId };
  // The head read happens before admission, so it has its own deadline: a
  // stalled read is abandoned and the upload goes on without a thumbnail.
  const stopHead = new AbortController();
  let headTimer: NodeJS.Timeout | undefined;
  try {
    const reading = source.head(stopHead.signal);
    reading.catch(() => {}); // settles after an abandonment
    const head = await Promise.race([
      reading,
      new Promise<typeof TIMED_OUT>((resolve) => {
        headTimer = setTimeout(resolve, headTimeoutMs, TIMED_OUT);
      }),
    ]);
    if (head === TIMED_OUT) {
      stopHead.abort();
      return skipped("timed-out", { ...context, reason: "reading the first bytes" });
    }
    if (!thumbnailFormat(head, source.size)) return skipped("unsupported", context);
  } catch (err) {
    return skipped("failed", { ...context, reason: errorReason(err) });
  } finally {
    clearTimeout(headTimer);
  }
  const release = await admission.acquire(workspaceId);
  if (!release) return skipped("busy", context);
  const abandoned = { value: false };
  const work = produce(source, abandoned);
  let timer: NodeJS.Timeout | undefined;
  let releaseLater = false;
  try {
    const outcome = await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, TIMED_OUT);
      }),
    ]);
    if (outcome === TIMED_OUT) {
      abandoned.value = true;
      releaseLater = true;
      work.then(release, release);
      return skipped("timed-out", context);
    }
    thumbnailOutcomes.created++;
    return outcome;
  } catch (err) {
    if (err instanceof Skip) return skipped(err.outcome, { ...context, ...err.details });
    // Undecodable, truncated, over a pixel or channel limit, stopped by the
    // libvips timeout, or the source could not be read.
    return skipped("failed", { ...context, reason: errorReason(err) });
  } finally {
    clearTimeout(timer);
    if (!releaseLater) release();
  }
}

function errorReason(err: unknown) {
  return err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
}

/** Reads, checks and decodes; stops before native work once abandoned. */
async function produce(
  file: ThumbnailSource,
  abandoned: { value: boolean },
): Promise<Buffer> {
  const giveUpIfAbandoned = () => {
    if (abandoned.value) throw new Skip("timed-out");
  };
  const source = await file.read();
  giveUpIfAbandoned();
  const format = thumbnailFormat(source);
  if (!format) throw new Skip("unsupported");
  const detected = await fileTypeFromBuffer(source);
  if (!detected || !FORMATS[format].detected.has(detected.mime)) {
    throw new Skip("unsupported", { format, reason: detected?.mime ?? "undetected" });
  }
  const hints = containerHints(source, format);
  giveUpIfAbandoned();
  const meta = await sharp(source, INPUT_OPTIONS).metadata();
  const details: Details = { format, width: meta.width, height: meta.height };
  if (meta.format !== FORMATS[format].libvips) {
    throw new Skip("unsupported", { ...details, reason: `libvips ${meta.format}` });
  }
  const estimateBytes = estimateDecodeBytes(meta, hints);
  if (estimateBytes > THUMBNAIL_LIMITS.decodeBudgetBytes) {
    throw new Skip("over-budget", { ...details, estimateBytes });
  }
  // Nobody waits for a decode that would start after the deadline.
  giveUpIfAbandoned();
  return sharp(source, INPUT_OPTIONS)
    .resize(THUMBNAIL_LIMITS.width, undefined, { withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_LIMITS.quality })
    .timeout({ seconds: THUMBNAIL_LIMITS.transformTimeoutSeconds })
    .toBuffer();
}

/**
 * Checks of the container that libvips' header does not show, made before
 * any native call: the JPEG scan count, the AVIF item structure and coded
 * size, and the WebP features that decide its memory.
 */
function containerHints(source: Buffer, format: ThumbnailFormat): DecodeHints {
  if (format === "jpeg") {
    const scans = jpegScanCount(source, THUMBNAIL_LIMITS.maxJpegScans);
    if (scans === Infinity) {
      throw new Skip("unsupported", { format, reason: "too many markers to check" });
    }
    if (scans > THUMBNAIL_LIMITS.maxJpegScans) {
      throw new Skip("over-budget", { format, reason: `more than ${THUMBNAIL_LIMITS.maxJpegScans} scans` });
    }
  } else if (format === "avif") {
    const structure = avifStructure(source);
    if (!structure) throw new Skip("unsupported", { format, reason: "unreadable item structure" });
    if (structure.primaryType !== "av01" || structure.derived.length) {
      const reason = `primary ${structure.primaryType}, derived ${structure.derived.join(",") || "none"}`;
      throw new Skip("unsupported", { format, reason });
    }
    if (structure.maxCodedPixels > THUMBNAIL_LIMITS.maxInputPixels) {
      throw new Skip("over-budget", { format, reason: `coded ${structure.maxCodedPixels} pixels` });
    }
    return { codedPixels: structure.maxCodedPixels };
  } else if (format === "webp") {
    const features = webpFeatures(source);
    if (!features) throw new Skip("unsupported", { format, reason: "chunks overrun the file" });
    return {
      codedPixels: features.canvasPixels,
      webpFullCanvas: features.fullCanvas,
      webpAnimated: features.animated,
    };
  }
  return {};
}

function skipped(
  outcome: ThumbnailOutcome,
  details: Details & { workspaceId?: string; fileId?: string },
): null {
  thumbnailOutcomes[outcome]++;
  // Not decoding a non-allowlisted format is the expected case.
  if (outcome === "unsupported") logger.debug({ outcome, ...details }, "Thumbnail omitted");
  else logger.info({ outcome, ...details }, "Thumbnail omitted");
  return null;
}
