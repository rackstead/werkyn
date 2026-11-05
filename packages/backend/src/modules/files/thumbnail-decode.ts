import fs from "node:fs/promises";
import { constants } from "node:fs";
import sharp from "sharp";
import type { SharpOptions } from "sharp";
import { fileTypeFromBuffer } from "file-type";
import {
  THUMBNAIL_LIMITS,
  THUMBNAIL_SOURCE_MAX_BYTES,
  checkAvif,
  estimateDecodeBytes,
  jpegMarkers,
  pngMetadata,
  thumbnailFormat,
  webpFeatures,
  type DecodeHints,
  type ThumbnailFormat,
} from "./thumbnail-checks.js";

/**
 * The decoding half of Drive thumbnails. Only the decoder worker processes
 * (thumbnail-worker.ts) load this module, so sharp and its codecs never run
 * in the server process. A worker reads the stored file, checks it and
 * decodes it; a decode that needs more memory than the worker's hard limit
 * fails or ends that worker, not the server (thumbnail-workers.ts).
 */

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

/**
 * libvips is configured once for the worker process, which uses sharp only
 * here: one libvips thread per transform, no operation cache holding
 * decoded images, and every loader blocked except the allowlisted buffer
 * loaders. A polyglot or disguised file therefore cannot reach SVG, TIFF,
 * PDF, UltraHDR, Radiance or any other loader even if it passed the checks.
 */
sharp.concurrency(1);
sharp.cache(false);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: Object.values(FORMATS).map((format) => format.loader) });

/** Why a decode stopped short of a thumbnail. */
export type DecodeOutcome = "unsupported" | "over-budget" | "failed";

/** How far a decode got: each step runs only after the previous one passed. */
export const DECODE_STAGES = ["read", "signature", "detector", "container", "header", "transform"] as const;
export type DecodeStage = (typeof DECODE_STAGES)[number];

/** What a skipped thumbnail is logged with. */
export interface DecodeDetails {
  format?: ThumbnailFormat;
  width?: number;
  height?: number;
  estimateBytes?: number;
  reason?: string;
  /** The last step started. */
  stage?: DecodeStage;
}

export type DecodeResult =
  | { ok: true; thumbnail: Buffer; details: DecodeDetails }
  | { ok: false; outcome: DecodeOutcome; details: DecodeDetails };

export interface DecodeOptions {
  /**
   * The container checks and the memory estimate (on by default). Turned
   * off only by tests, to show that the worker's own limit holds when an
   * input gets past them.
   */
  memoryChecks?: boolean;
}

class Skip extends Error {
  constructor(
    readonly outcome: DecodeOutcome,
    readonly details: DecodeDetails = {},
  ) {
    super(outcome);
  }
}

/**
 * The stored file at `path`, read whole. Only a regular file of at most
 * THUMBNAIL_SOURCE_MAX_BYTES is read; it is opened without blocking, so a
 * FIFO or device cannot stall the worker.
 */
export async function readThumbnailSource(path: string): Promise<Buffer> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Skip("unsupported", { reason: "not a regular file" });
    if (stat.size > THUMBNAIL_SOURCE_MAX_BYTES) throw new Skip("unsupported", { reason: "over the source limit" });
    const bytes = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return bytes.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/** Reads, checks and decodes the stored file at `path`. Never throws. */
export async function thumbnailFromFile(path: string, options: DecodeOptions = {}): Promise<DecodeResult> {
  const progress: DecodeDetails = { stage: "read" };
  try {
    const source = await readThumbnailSource(path);
    return { ok: true, thumbnail: await decode(source, progress, options), details: progress };
  } catch (err) {
    if (err instanceof Skip) return { ok: false, outcome: err.outcome, details: { ...progress, ...err.details } };
    // Undecodable, truncated, over a pixel or channel limit, stopped by the
    // libvips timeout, out of memory under the worker's limit, or the file
    // could not be read.
    return { ok: false, outcome: "failed", details: { ...progress, reason: errorReason(err) } };
  }
}

/** Checks and decodes `source`; `progress` records how far it got. */
async function decode(source: Buffer, progress: DecodeDetails, { memoryChecks = true }: DecodeOptions): Promise<Buffer> {
  progress.stage = "signature";
  const format = thumbnailFormat(source);
  if (!format) throw new Skip("unsupported");
  progress.format = format;
  progress.stage = "detector";
  const detected = await fileTypeFromBuffer(source);
  if (!detected || !FORMATS[format].detected.has(detected.mime)) {
    throw new Skip("unsupported", { reason: detected?.mime ?? "undetected" });
  }
  progress.stage = "container";
  const hints = memoryChecks ? containerHints(source, format) : {};
  if (memoryChecks && format === "webp") {
    // A WebP's cost follows from its chunks alone, and libvips' header
    // read already allocates the canvas: refuse before it.
    const estimateBytes = estimateDecodeBytes({ format: "webp", width: 1, height: 1, channels: 3, depth: "uchar", isProgressive: false }, hints);
    if (estimateBytes > THUMBNAIL_LIMITS.decodeBudgetBytes) throw new Skip("over-budget", { estimateBytes });
  }
  progress.stage = "header";
  const meta = await sharp(source, INPUT_OPTIONS).metadata();
  Object.assign(progress, { width: meta.width, height: meta.height });
  if (meta.format !== FORMATS[format].libvips) {
    throw new Skip("unsupported", { reason: `libvips ${meta.format}` });
  }
  if (memoryChecks) {
    const estimateBytes = estimateDecodeBytes(meta, hints);
    progress.estimateBytes = estimateBytes;
    if (estimateBytes > THUMBNAIL_LIMITS.decodeBudgetBytes) throw new Skip("over-budget");
  }
  progress.stage = "transform";
  return sharp(source, INPUT_OPTIONS)
    .resize(THUMBNAIL_LIMITS.width, undefined, { withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_LIMITS.quality })
    .timeout({ seconds: THUMBNAIL_LIMITS.transformTimeoutSeconds })
    .toBuffer();
}

/** libvips stacks its messages; the cause (such as an allocation failure) is often the last. */
function errorReason(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n").map((line) => line.trim()).filter(Boolean).join("; ").slice(0, 200);
}

/**
 * Checks of the container that libvips' header does not show, made before
 * any native call: the JPEG scan count, the AVIF item structure and coded
 * size, the WebP features that decide its memory, the PNG chunks, and the
 * ICC profile and metadata every format carries.
 */
function containerHints(source: Buffer, format: ThumbnailFormat): DecodeHints {
  const hints = formatHints(source, format);
  if ((hints.iccBytes ?? 0) > THUMBNAIL_LIMITS.maxIccBytes) {
    throw new Skip("over-budget", { reason: `ICC profile of ${hints.iccBytes} bytes` });
  }
  return hints;
}

function formatHints(source: Buffer, format: ThumbnailFormat): DecodeHints {
  if (format === "jpeg") {
    const { scans, iccBytes, metadataBytes } = jpegMarkers(source, THUMBNAIL_LIMITS.maxJpegScans);
    if (scans === Infinity) {
      throw new Skip("unsupported", { reason: "marker structure not walked to EOI" });
    }
    if (scans > THUMBNAIL_LIMITS.maxJpegScans) {
      throw new Skip("over-budget", { reason: `more than ${THUMBNAIL_LIMITS.maxJpegScans} scans` });
    }
    return { iccBytes, metadataBytes };
  } else if (format === "png") {
    const png = pngMetadata(source);
    if ("refused" in png) throw new Skip("unsupported", { reason: png.refused });
    return png;
  } else if (format === "avif") {
    const avif = checkAvif(source);
    if ("refused" in avif) throw new Skip("unsupported", { reason: avif.refused });
    if (avif.codedPixels > THUMBNAIL_LIMITS.maxInputPixels) {
      throw new Skip("over-budget", { reason: `coded ${avif.codedPixels} pixels` });
    }
    return avif;
  } else if (format === "webp") {
    const features = webpFeatures(source);
    if (!features) throw new Skip("unsupported", { reason: "chunks overrun the file" });
    return {
      codedPixels: features.canvasPixels,
      webpFullCanvas: features.fullCanvas,
      webpAnimated: features.animated,
      iccBytes: features.iccBytes,
      metadataBytes: features.metadataBytes,
    };
  }
  return {};
}
