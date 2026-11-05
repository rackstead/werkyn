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
// no HEVC decoder, and only AVIF is supported.
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * The allowlisted format these bytes start as, or null. Only fixed
 * signatures at fixed offsets are read: SVG, PDF, TIFF, HEIC and anything
 * else are never sent to the detector or a decoder, whatever their declared
 * type or filename.
 */
export function thumbnailFormat(buffer: Buffer): ThumbnailFormat | null {
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
    if (boxSize >= 16 && boxSize <= buffer.length && boxSize <= THUMBNAIL_SOURCE_MAX_BYTES) {
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
  /** libvips stops a transform after this long... */
  transformTimeoutSeconds: 10,
  /** ...and the upload stops waiting for it a little after that. */
  transformDeadlineMs: 12_000,
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

/**
 * Upper estimate of the memory libvips 8.18 and its codecs need to make one
 * thumbnail, from the header alone (measured in docs/remediation/r19.md,
 * plus at least 20% headroom). Formats that cannot be read row by row
 * (interlaced PNG, progressive JPEG, GIF frames, AVIF) are charged for the
 * whole decoded image; the others for the buffering seen while they stream
 * through the resize.
 */
export function estimateDecodeBytes(
  meta: Pick<Metadata, "format" | "width" | "height" | "channels" | "depth" | "isProgressive">,
): number {
  const { width, height, channels } = meta;
  const sampleBytes = SAMPLE_BYTES[meta.depth ?? ""];
  if (!width || !height || !channels || !sampleBytes) return Infinity;
  const pixels = width * height;
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
      // libwebp decodes still and animated frames at the reduced size.
      return pixels * 1.5;
    case "heif":
      // AV1 frame buffers, then RGB(A) copies in libheif and libvips.
      return pixels * 16 + bytes * 2;
    default:
      return Infinity;
  }
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

/** A FIFO semaphore with a bounded queue and a bounded wait. */
export class TransformAdmission {
  private active = 0;
  private readonly queue: Array<(release: Release | null) => void> = [];

  constructor(readonly limits: ThumbnailAdmissionLimits) {}

  /** A release function once admitted; null when the queue is full or the wait times out. */
  acquire(): Promise<Release | null> {
    if (this.active < this.limits.maxActive) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.limits.maxQueued) return Promise.resolve(null);
    return new Promise((resolve) => {
      const grant = (release: Release | null) => {
        clearTimeout(timer);
        resolve(release);
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(grant);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(null);
      }, this.limits.queueTimeoutMs);
      this.queue.push(grant);
    });
  }

  private releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand the slot straight to the next waiter, if any.
      const next = this.queue.shift();
      if (next) next(this.releaser());
      else this.active--;
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

class Skip extends Error {
  constructor(readonly outcome: ThumbnailOutcome) {
    super(outcome);
  }
}

const TIMED_OUT = Symbol("timed out");

/**
 * A WebP thumbnail of the bytes `read` returns, or null. Waits for a turn
 * first (at most `queueTimeoutMs`), reads the source only once admitted, and
 * gives up waiting on the decoder after `transformDeadlineMs`. The turn is
 * held until libvips has actually finished, so a transform the upload
 * stopped waiting for still counts against the limit. Never throws.
 */
export async function createThumbnail(
  read: () => Promise<Buffer>,
  {
    admission = thumbnailAdmission,
    deadlineMs = THUMBNAIL_LIMITS.transformDeadlineMs,
  }: { admission?: TransformAdmission; deadlineMs?: number } = {},
): Promise<Buffer | null> {
  const release = await admission.acquire();
  if (!release) return skipped("busy");
  let releaseNow = true;
  try {
    const source = await read();
    const format = thumbnailFormat(source);
    if (!format) return skipped("unsupported");
    const detected = await fileTypeFromBuffer(source);
    if (!detected || !FORMATS[format].detected.has(detected.mime)) return skipped("unsupported");

    const abandoned = { value: false };
    const work = transform(source, format, abandoned);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, TIMED_OUT);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === TIMED_OUT) {
      abandoned.value = true;
      releaseNow = false;
      work.then(release, release);
      return skipped("timed-out");
    }
    thumbnailOutcomes.created++;
    return outcome;
  } catch (err) {
    if (err instanceof Skip) return skipped(err.outcome);
    // Undecodable, truncated, over a pixel or channel limit, or stopped by
    // the libvips timeout.
    logger.debug({ err }, "Thumbnail omitted");
    return skipped("failed");
  } finally {
    if (releaseNow) release();
  }
}

async function transform(
  source: Buffer,
  format: ThumbnailFormat,
  abandoned: { value: boolean },
): Promise<Buffer> {
  const meta = await sharp(source, INPUT_OPTIONS).metadata();
  if (meta.format !== FORMATS[format].libvips) throw new Skip("unsupported");
  if (estimateDecodeBytes(meta) > THUMBNAIL_LIMITS.decodeBudgetBytes) throw new Skip("over-budget");
  // Nobody waits for a decode that would start after the deadline.
  if (abandoned.value) throw new Skip("timed-out");
  return sharp(source, INPUT_OPTIONS)
    .resize(THUMBNAIL_LIMITS.width, undefined, { withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_LIMITS.quality })
    .timeout({ seconds: THUMBNAIL_LIMITS.transformTimeoutSeconds })
    .toBuffer();
}

function skipped(outcome: ThumbnailOutcome): null {
  thumbnailOutcomes[outcome]++;
  if (outcome === "busy" || outcome === "timed-out" || outcome === "over-budget") {
    logger.info({ outcome }, "Thumbnail omitted");
  }
  return null;
}
