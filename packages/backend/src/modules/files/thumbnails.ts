import os from "node:os";
import zlib from "node:zlib";
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
  /**
   * An embedded ICC profile, in any format. libvips copies it while reading
   * the header and lcms builds transforms from it: about 9 bytes of memory
   * per profile byte were measured, so the estimate also charges that.
   */
  maxIccBytes: 4 * 1024 * 1024,
  /**
   * PNG zTXt, compressed iTXt and iCCP inflate while libvips reads the
   * header, before the budget is checked (libpng allows 50 MB per chunk):
   * their inflated total, and separately the raw tEXt/iTXt/eXIf total.
   */
  maxPngMetadataBytes: 4 * 1024 * 1024,
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
  /** Bytes of embedded ICC profile. */
  iccBytes?: number;
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
  return decodeBytes(meta, pixels, bytes, hints) + 9 * (hints.iccBytes ?? 0);
}

function decodeBytes(
  meta: Pick<Metadata, "format" | "channels" | "isProgressive">,
  pixels: number,
  bytes: number,
  hints: DecodeHints,
): number {
  const channels = meta.channels!;
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
      // libvips composites animation frames onto a full RGBA canvas, and a
      // frame with alpha is decoded and blended at full size too; libwebp
      // decodes lossless (VP8L) images whole as 32-bit ARGB, and alpha at
      // full size. Plain lossy VP8 decodes scaled.
      return pixels * (hints.webpAnimated ? 12.5 : hints.webpFullCanvas ? 5.5 : 2);
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

/** The AVIF structures that get a thumbnail: anything else gets none. */
const AVIF_TOP_BOXES = new Set(["ftyp", "meta", "mdat", "free", "skip"]);
const AVIF_META_BOXES = new Set(["hdlr", "pitm", "iloc", "iinf", "iref", "iprp", "idat", "dinf"]);
const AVIF_REQUIRED_META_BOXES = ["hdlr", "pitm", "iloc", "iinf", "iprp"];
const AVIF_ITEM_TYPES = new Set(["av01", "Exif", "mime"]);
const AVIF_REFERENCES = new Set(["auxl", "cdsc"]);
const AVIF_ALPHA_URNS = new Set([
  "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha",
  "urn:mpeg:hevc:2015:auxid:1",
]);
/** Extents one AVIF item may be stored in; encoders write one. */
const AVIF_MAX_EXTENTS_PER_ITEM = 4;
/**
 * Exif and XMP (`mime`) item data, which libvips copies while it reads the
 * header, before the budget is checked.
 */
const AVIF_MAX_METADATA_ITEM_BYTES = 1024 * 1024;

export type AvifCheck = { codedPixels: number; iccBytes: number } | { refused: string };

class AvifRefusal extends Error {}
const refuse = (reason: string): never => {
  throw new AvifRefusal(reason);
};

/** Child boxes by type; refuses types outside `allowed` and repeats of any. */
function uniqueChildren(
  buffer: Buffer,
  start: number,
  end: number,
  budget: { left: number },
  allowed: ReadonlySet<string>,
  repeatable: ReadonlySet<string> = new Set(),
): Map<string, Box[]> {
  const found = new Map<string, Box[]>();
  for (const box of isoBoxes(buffer, start, end, budget)) {
    if (!allowed.has(box.type)) refuse(`${box.type} box`);
    const list = found.get(box.type) ?? [];
    if (list.length && !repeatable.has(box.type)) refuse(`more than one ${box.type} box`);
    list.push(box);
    found.set(box.type, list);
  }
  return found;
}

/**
 * Reads `iloc` and refuses any item location outside the simple shape (see
 * `checkAvif`). Offsets and lengths of up to 8 bytes are read as BigInt and
 * compared with the file, so no arithmetic can overflow.
 */
function checkAvifItemLocations(
  buffer: Buffer,
  iloc: Box,
  types: ReadonlyMap<number, string>,
  mdats: readonly Box[],
  idat: Box | undefined,
  budget: { left: number },
): void {
  const version = buffer[iloc.body];
  if (version > 2) refuse(`iloc version ${version}`);
  let at = iloc.body + 4;
  const take = (bytes: number): bigint => {
    if (at + bytes > iloc.end) refuse("short iloc box");
    let value = 0n;
    for (let i = 0; i < bytes; i++) value = (value << 8n) | BigInt(buffer[at + i]);
    at += bytes;
    return value;
  };
  const sizes = Number(take(2));
  const offsetSize = sizes >> 12, lengthSize = (sizes >> 8) & 0xf;
  const baseOffsetSize = (sizes >> 4) & 0xf, indexSize = version === 0 ? 0 : sizes & 0xf;
  for (const size of [offsetSize, lengthSize, baseOffsetSize]) if (size !== 0 && size !== 4 && size !== 8) refuse("iloc field size");
  if (indexSize !== 0) refuse("iloc extent indexes");
  const itemCount = Number(take(version < 2 ? 2 : 4));
  const fileEnd = BigInt(buffer.length);
  // Data boxes as [start, end) ranges, built once; mdat boxes are in file
  // order, so an extent's box is found by binary search.
  const mdatRanges = mdats.map((box) => [BigInt(box.body), BigInt(box.end)] as const);
  const idatRange = idat ? ([BigInt(idat.body), BigInt(idat.end)] as const) : undefined;
  const insideData = (method: number, start: bigint, end: bigint) => {
    if (method === 1) return start >= idatRange![0] && end <= idatRange![1];
    let low = 0, high = mdatRanges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [from, to] = mdatRanges[middle];
      if (start < from) high = middle - 1;
      else if (start >= to) low = middle + 1;
      else return end <= to;
    }
    return false;
  };
  const extentsBySpace: Array<Array<[bigint, bigint]>> = [[], []];
  const located = new Set<number>();
  for (let item = 0; item < itemCount; item++) {
    if (--budget.left < 0) refuse("too many iloc items");
    const id = Number(take(version < 2 ? 2 : 4));
    const method = version === 0 ? 0 : Number(take(2)) & 0xf;
    const dataReference = Number(take(2));
    const baseOffset = take(baseOffsetSize);
    const extentCount = Number(take(2));
    const type = types.get(id);
    if (!type) refuse(`iloc item ${id} without an item entry`);
    if (located.has(id)) refuse(`iloc item ${id} twice`);
    located.add(id);
    if (dataReference !== 0) refuse(`item ${id} data in another file`);
    if (method > 1) refuse(`item ${id} construction method ${method}`);
    if (method === 1 && !idat) refuse(`item ${id} in idat without one`);
    if (extentCount < 1 || extentCount > AVIF_MAX_EXTENTS_PER_ITEM) refuse(`item ${id} with ${extentCount} extents`);
    // Method 0 data must lie inside an mdat box; method 1 is relative to idat's data.
    let itemBytes = 0n;
    for (let extent = 0; extent < extentCount; extent++) {
      if (--budget.left < 0) refuse("too many iloc extents");
      const offset = take(offsetSize);
      const length = take(lengthSize);
      if (length === 0n) refuse(`item ${id} extent to the end of the file`);
      const start = baseOffset + offset + (method === 1 ? idatRange![0] : 0n);
      const end = start + length;
      if (end > fileEnd || !insideData(method, start, end)) {
        refuse(`item ${id} extent outside its data box`);
      }
      extentsBySpace[method].push([start, end]);
      itemBytes += length;
    }
    if ((type === "Exif" || type === "mime") && itemBytes > BigInt(AVIF_MAX_METADATA_ITEM_BYTES)) {
      refuse(`${type} item ${id} over ${AVIF_MAX_METADATA_ITEM_BYTES} bytes`);
    }
  }
  for (const id of types.keys()) if (!located.has(id)) refuse(`item ${id} without a location`);
  // No byte may belong to two extents: repeated extents would multiply the
  // file in memory when libheif concatenates them.
  for (const extents of extentsBySpace) {
    extents.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = 1; i < extents.length; i++) {
      if (extents[i][0] < extents[i - 1][1]) refuse("overlapping item extents");
    }
  }
}

/**
 * Whether an AVIF has the one simple shape thumbnails decode, and its coded
 * size. Rather than model what libheif would decode, only this shape is
 * accepted:
 * - one `ftyp` (first) and one `meta`, with only `mdat`/`free`/`skip`
 *   beside them;
 * - in `meta`, one each of `hdlr` (`pict`), `pitm`, `iloc`, `iinf` and
 *   `iprp` (one `ipco` and one `ipma`), and at most one `iref`, `idat` and
 *   `dinf`;
 * - items of type `av01`, `Exif` or `mime` only, with unique IDs, and only
 *   `auxl` and `cdsc` references;
 * - a primary `av01` item and at most one other `av01` item, its alpha
 *   plane: an `auxl` reference to the primary with an alpha `auxC`;
 * - exactly one associated `ispe` on each `av01` item, the alpha's equal to
 *   the primary's;
 * - an `iloc` (version 0 to 2) entry for each item and no other: data in
 *   the file (construction method 0) inside an `mdat` box, or in `idat`
 *   (method 1); no external data references or extent indexes; one to four
 *   non-empty extents per item, none overlapping any other extent, so the
 *   item data together is never larger than the file; and at most 1 MiB of
 *   Exif or XMP per item.
 *
 * libheif concatenates an item's extents before decoding, and libvips copies
 * Exif and XMP while reading the header, so repeated extents would multiply
 * a 32 MiB upload in memory. libheif decodes the whole coded image (`ispe`) even when a `clap` crop
 * makes it report a smaller size, and refuses an image whose coded size
 * differs from its `ispe`, so the primary's `ispe` is what is decoded.
 */
export function checkAvif(buffer: Buffer): AvifCheck {
  try {
    const budget = { left: MAX_CONTAINER_ENTRIES };
    const top = uniqueChildren(buffer, 0, buffer.length, budget, AVIF_TOP_BOXES, new Set(["mdat", "free", "skip"]));
    if (buffer.toString("latin1", 4, 8) !== "ftyp" || !top.has("meta")) refuse("no ftyp and meta");
    const meta = top.get("meta")![0];
    const boxes = uniqueChildren(buffer, meta.body + 4, meta.end, budget, AVIF_META_BOXES);
    for (const required of AVIF_REQUIRED_META_BOXES) if (!boxes.has(required)) refuse(`no ${required} box`);
    const one = (type: string) => boxes.get(type)![0];
    const fits = (box: Box, at: number, bytes: number) => {
      if (at + bytes > box.end) refuse(`short ${box.type} box`);
      return at;
    };

    const hdlr = one("hdlr");
    if (buffer.toString("latin1", fits(hdlr, hdlr.body + 8, 4), hdlr.body + 12) !== "pict") refuse("hdlr not pict");

    const pitm = one("pitm");
    const primary = buffer[pitm.body] === 0
      ? buffer.readUInt16BE(fits(pitm, pitm.body + 4, 2))
      : buffer.readUInt32BE(fits(pitm, pitm.body + 4, 4));

    // Items and their types.
    const iinf = one("iinf");
    const countBytes = buffer[iinf.body] === 0 ? 2 : 4;
    const declared = countBytes === 2
      ? buffer.readUInt16BE(fits(iinf, iinf.body + 4, 2))
      : buffer.readUInt32BE(fits(iinf, iinf.body + 4, 4));
    const types = new Map<number, string>();
    for (const infe of isoBoxes(buffer, iinf.body + 4 + countBytes, iinf.end, budget)) {
      const version = buffer[fits(infe, infe.body, 1)];
      if (infe.type !== "infe" || version < 2) refuse("item entry");
      const idBytes = version === 2 ? 2 : 4;
      const typeAt = fits(infe, infe.body + 4 + idBytes + 2, 4);
      const id = idBytes === 2 ? buffer.readUInt16BE(infe.body + 4) : buffer.readUInt32BE(infe.body + 4);
      const type = buffer.toString("latin1", typeAt, typeAt + 4);
      if (types.has(id)) refuse(`item ${id} twice`);
      if (!AVIF_ITEM_TYPES.has(type)) refuse(`${type} item`);
      types.set(id, type);
    }
    if (types.size !== declared) refuse("item count");
    checkAvifItemLocations(buffer, one("iloc"), types, top.get("mdat") ?? [], boxes.get("idat")?.[0], budget);
    if (types.get(primary) !== "av01") refuse(`primary ${types.get(primary) ?? "missing"}`);

    // Properties and their associations.
    const iprp = uniqueChildren(buffer, one("iprp").body, one("iprp").end, budget, new Set(["ipco", "ipma"]));
    if (!iprp.has("ipco") || !iprp.has("ipma")) refuse("no ipco and ipma");
    const ipco = iprp.get("ipco")![0];
    const properties = [...isoBoxes(buffer, ipco.body, ipco.end, budget)];
    const ipma = iprp.get("ipma")![0];
    const wideIds = buffer[fits(ipma, ipma.body, 4)] !== 0;
    const wideIndexes = (buffer.readUInt32BE(ipma.body) & 1) === 1;
    const associated = new Map<number, Box[]>();
    let at = ipma.body + 4;
    const entries = buffer.readUInt32BE(fits(ipma, at, 4));
    at += 4;
    for (let entry = 0; entry < entries; entry++) {
      if (--budget.left < 0) refuse("too many associations");
      const id = wideIds ? buffer.readUInt32BE(fits(ipma, at, 4)) : buffer.readUInt16BE(fits(ipma, at, 2));
      at += wideIds ? 4 : 2;
      if (associated.has(id)) refuse(`item ${id} associated twice`);
      const count = buffer[fits(ipma, at, 1)];
      at += 1;
      const list: Box[] = [];
      for (let k = 0; k < count; k++) {
        const raw = wideIndexes ? buffer.readUInt16BE(fits(ipma, at, 2)) : buffer[fits(ipma, at, 1)];
        at += wideIndexes ? 2 : 1;
        const index = raw & (wideIndexes ? 0x7fff : 0x7f);
        if (index === 0) continue;
        if (index > properties.length) refuse("property index");
        list.push(properties[index - 1]);
      }
      associated.set(id, list);
    }
    const codedSize = (id: number) => {
      const ispes = (associated.get(id) ?? []).filter((box) => box.type === "ispe");
      if (ispes.length !== 1) refuse(`item ${id} with ${ispes.length} ispe`);
      const ispe = fits(ispes[0], ispes[0].body + 4, 8);
      return [buffer.readUInt32BE(ispe), buffer.readUInt32BE(ispe + 4)];
    };

    // References: auxl (alpha) and cdsc (metadata) only.
    const auxiliaryOf = new Map<number, number[]>();
    if (boxes.has("iref")) {
      const iref = one("iref");
      const wide = buffer[fits(iref, iref.body, 1)] !== 0;
      const idBytes = wide ? 4 : 2;
      const readId = (offset: number) => (wide ? buffer.readUInt32BE(offset) : buffer.readUInt16BE(offset));
      for (const reference of isoBoxes(buffer, iref.body + 4, iref.end, budget)) {
        if (!AVIF_REFERENCES.has(reference.type)) refuse(`${reference.type} reference`);
        const from = readId(fits(reference, reference.body, idBytes));
        const count = buffer.readUInt16BE(fits(reference, reference.body + idBytes, 2));
        const targets: number[] = [];
        for (let k = 0; k < count; k++) {
          targets.push(readId(fits(reference, reference.body + idBytes + 2 + k * idBytes, idBytes)));
        }
        if (reference.type === "auxl") {
          if (auxiliaryOf.has(from)) refuse(`item ${from} auxiliary twice`);
          auxiliaryOf.set(from, targets);
        }
      }
    }

    // The primary, and at most one alpha plane of the same coded size.
    const [width, height] = codedSize(primary);
    let alphaPlanes = 0;
    for (const [id, type] of types) {
      if (auxiliaryOf.has(id) && type !== "av01") refuse(`${type} item ${id} is auxiliary`);
      if (type !== "av01" || id === primary) continue;
      const targets = auxiliaryOf.get(id);
      if (!targets || targets.length !== 1 || targets[0] !== primary) refuse(`av01 item ${id} is not the primary's alpha`);
      const auxC = (associated.get(id) ?? []).filter((box) => box.type === "auxC");
      if (auxC.length !== 1) refuse(`item ${id} without one auxC`);
      const urnStart = fits(auxC[0], auxC[0].body + 4, 1);
      const urnEnd = buffer.indexOf(0, urnStart);
      if (urnEnd === -1 || urnEnd >= auxC[0].end || !AVIF_ALPHA_URNS.has(buffer.toString("latin1", urnStart, urnEnd))) {
        refuse(`item ${id} is not an alpha plane`);
      }
      const [alphaWidth, alphaHeight] = codedSize(id);
      if (alphaWidth !== width || alphaHeight !== height) refuse("alpha size differs");
      if (++alphaPlanes > 1) refuse("more than one alpha plane");
    }
    if (auxiliaryOf.get(primary)) refuse("primary is auxiliary");
    // ICC profiles in colr properties ('prof' or 'rICC').
    let iccBytes = 0;
    for (const property of properties) {
      if (property.type !== "colr" || property.end - property.body < 4) continue;
      const colourType = buffer.toString("latin1", property.body, property.body + 4);
      if (colourType === "prof" || colourType === "rICC") iccBytes += property.end - property.body - 4;
    }
    return { codedPixels: width * height, iccBytes };
  } catch (err) {
    if (err instanceof AvifRefusal) return { refused: err.message };
    return { refused: "unreadable structure" };
  }
}

/** Chunks one WebP or PNG walk reads before refusing; real files have far fewer. */
const MAX_FILE_CHUNKS = 65536;

const fourCC = (text: string) => Buffer.from(text, "latin1").readUInt32BE(0);
const WEBP_VP8X = fourCC("VP8X"), WEBP_VP8L = fourCC("VP8L"), WEBP_ALPH = fourCC("ALPH");
const WEBP_ANIM = fourCC("ANIM"), WEBP_ANMF = fourCC("ANMF"), WEBP_ICCP = fourCC("ICCP");

/**
 * Whether a WebP decodes at full size (lossless or alpha), whether it is
 * animated, its VP8X canvas size and its ICC profile bytes, from every
 * RIFF chunk. Null when the container or a chunk overruns the file or
 * there are more than MAX_FILE_CHUNKS chunks.
 */
export function webpFeatures(
  buffer: Buffer,
): { fullCanvas: boolean; animated: boolean; canvasPixels: number; iccBytes: number } | null {
  // Only the RIFF container's declared length is image data; libwebp
  // ignores anything after it.
  const end = 8 + buffer.readUInt32LE(4);
  if (end > buffer.length) return null;
  let fullCanvas = false;
  let animated = false;
  let canvasPixels = 0;
  let iccBytes = 0;
  let chunks = 0;
  for (let pos = 12; pos + 8 <= end; ) {
    if (++chunks > MAX_FILE_CHUNKS) return null;
    const type = buffer.readUInt32BE(pos);
    const size = buffer.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (body + size > end) return null;
    if (type === WEBP_VP8X) {
      if (size < 10) return null;
      // Flags: alpha 0x10, animation 0x02.
      if (buffer[body] & 0x10) fullCanvas = true;
      if (buffer[body] & 0x02) animated = true;
      canvasPixels = (buffer.readUIntLE(body + 4, 3) + 1) * (buffer.readUIntLE(body + 7, 3) + 1);
    } else if (type === WEBP_VP8L || type === WEBP_ALPH) {
      fullCanvas = true;
    } else if (type === WEBP_ANIM || type === WEBP_ANMF) {
      animated = true;
    } else if (type === WEBP_ICCP) {
      iccBytes += size;
    }
    pos = body + size + (size & 1);
  }
  return { fullCanvas: fullCanvas || animated, animated, canvasPixels, iccBytes };
}

const PNG_IEND = fourCC("IEND"), PNG_TEXT = fourCC("tEXt"), PNG_ZTXT = fourCC("zTXt");
const PNG_ITXT = fourCC("iTXt"), PNG_ICCP = fourCC("iCCP"), PNG_EXIF = fourCC("eXIf");

/**
 * Walks every PNG chunk to IEND before any native call. libpng inflates
 * zTXt, compressed iTXt and iCCP while libvips reads the header, up to
 * 50 MB per chunk and before the budget is checked: a 477 KB file with ten
 * 49 MB zTXt chunks needed 2.3 GiB. Here they are inflated against one
 * shared limit (maxPngMetadataBytes), raw tEXt, iTXt and eXIf against
 * another, and a malformed stream, a chunk overrunning the file, a missing
 * IEND or more than MAX_FILE_CHUNKS chunks refuse the file.
 */
export function pngMetadata(buffer: Buffer): { iccBytes: number } | { refused: string } {
  const limit = THUMBNAIL_LIMITS.maxPngMetadataBytes;
  let inflated = 0;
  let raw = 0;
  let iccBytes = 0;
  let chunks = 0;
  const nul = (from: number, to: number) => {
    const at = buffer.indexOf(0, from);
    return at === -1 || at >= to ? -1 : at;
  };
  const inflate = (from: number, to: number) => {
    try {
      const out = zlib.inflateSync(buffer.subarray(from, to), { maxOutputLength: Math.max(1, limit - inflated) });
      inflated += out.length;
      return inflated > limit ? -1 : out.length;
    } catch {
      return -1; // over the limit or not a zlib stream
    }
  };
  for (let pos = 8; ; ) {
    if (pos + 12 > buffer.length) return { refused: "chunks end before IEND" };
    if (++chunks > MAX_FILE_CHUNKS) return { refused: "too many chunks" };
    const length = buffer.readUInt32BE(pos);
    const type = buffer.readUInt32BE(pos + 4);
    const data = pos + 8;
    const end = data + length;
    if (end + 4 > buffer.length) return { refused: "chunk overruns the file" };
    if (type === PNG_IEND) return { iccBytes };
    if (type === PNG_ZTXT || type === PNG_ICCP) {
      // keyword or profile name, NUL, compression method 0, zlib stream
      const at = nul(data, end);
      if (at === -1 || at + 2 > end || buffer[at + 1] !== 0) return { refused: "compressed chunk header" };
      const size = inflate(at + 2, end);
      if (size === -1) return { refused: "compressed metadata over the limit or malformed" };
      if (type === PNG_ICCP) iccBytes += size;
    } else if (type === PNG_ITXT) {
      // keyword, NUL, compression flag, method, language, NUL, translated keyword, NUL, text
      const keyword = nul(data, end);
      if (keyword === -1 || keyword + 3 > end) return { refused: "iTXt header" };
      const language = nul(keyword + 3, end);
      const translated = language === -1 ? -1 : nul(language + 1, end);
      if (translated === -1) return { refused: "iTXt header" };
      if (buffer[keyword + 1] === 1) {
        if (buffer[keyword + 2] !== 0 || inflate(translated + 1, end) === -1) {
          return { refused: "compressed metadata over the limit or malformed" };
        }
      } else {
        raw += end - translated - 1;
      }
    } else if (type === PNG_TEXT || type === PNG_EXIF) {
      raw += length;
    }
    if (raw > limit) return { refused: "text metadata over the limit" };
    pos = end + 4;
  }
}

/**
 * Start-of-scan markers in a JPEG, counting no further than `stopAfter + 1`.
 * Infinity unless the marker walk reaches EOI cleanly: libjpeg skips a
 * stray byte, a TEM or restart marker between segments with only a warning
 * and decodes every scan after it, so a count that stopped there would not
 * be what is decoded. Infinity too for a short segment, a file that ends
 * first, or more markers or escaped bytes than are read.
 */
export function jpegScanCount(buffer: Buffer, stopAfter: number): number {
  return jpegMarkers(buffer, stopAfter).scans;
}

const ICC_PROFILE_TAG = Buffer.from("ICC_PROFILE\0", "latin1");

/** The scan count (see `jpegScanCount`) and the bytes of APP2 ICC profile segments. */
export function jpegMarkers(buffer: Buffer, stopAfter: number): { scans: number; iccBytes: number } {
  const refused = { scans: Infinity, iccBytes: 0 };
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return refused;
  let scans = 0;
  let iccBytes = 0;
  let pos = 2;
  let markers = 0;
  let escapes = 0;
  for (;;) {
    if (pos + 2 > buffer.length || buffer[pos] !== 0xff) return refused;
    if (++markers > MAX_CONTAINER_ENTRIES) return refused;
    const marker = buffer[pos + 1];
    if (marker === 0xff) {
      pos++; // fill byte
      continue;
    }
    if (marker === 0xd9) return { scans, iccBytes };
    // Stuffing, TEM, restart markers and SOI belong nowhere between segments.
    if (marker <= 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return refused;
    if (pos + 4 > buffer.length) return refused;
    const length = buffer.readUInt16BE(pos + 2);
    if (length < 2) return refused;
    // APP2 "ICC_PROFILE\0", sequence number, count, then part of the profile.
    if (marker === 0xe2 && length >= 2 + 14 && pos + 4 + 14 <= buffer.length &&
      buffer.subarray(pos + 4, pos + 16).equals(ICC_PROFILE_TAG)) {
      iccBytes += length - 2 - 14;
    }
    pos += 2 + length;
    if (marker !== 0xda) continue;
    if (++scans > stopAfter) return { scans, iccBytes };
    // Skip entropy-coded data: stuffed 0xFF00 bytes and restart markers
    // belong to the scan; any other marker ends it.
    for (;;) {
      const at = buffer.indexOf(0xff, pos);
      if (at === -1 || at + 1 >= buffer.length) return refused;
      if (++escapes > MAX_JPEG_ESCAPES) return refused;
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
  const hints = formatHints(source, format);
  if ((hints.iccBytes ?? 0) > THUMBNAIL_LIMITS.maxIccBytes) {
    throw new Skip("over-budget", { format, reason: `ICC profile of ${hints.iccBytes} bytes` });
  }
  return hints;
}

function formatHints(source: Buffer, format: ThumbnailFormat): DecodeHints {
  if (format === "jpeg") {
    const { scans, iccBytes } = jpegMarkers(source, THUMBNAIL_LIMITS.maxJpegScans);
    if (scans === Infinity) {
      throw new Skip("unsupported", { format, reason: "marker structure not walked to EOI" });
    }
    if (scans > THUMBNAIL_LIMITS.maxJpegScans) {
      throw new Skip("over-budget", { format, reason: `more than ${THUMBNAIL_LIMITS.maxJpegScans} scans` });
    }
    return { iccBytes };
  } else if (format === "png") {
    const png = pngMetadata(source);
    if ("refused" in png) throw new Skip("unsupported", { format, reason: png.refused });
    return { iccBytes: png.iccBytes };
  } else if (format === "avif") {
    const avif = checkAvif(source);
    if ("refused" in avif) throw new Skip("unsupported", { format, reason: avif.refused });
    if (avif.codedPixels > THUMBNAIL_LIMITS.maxInputPixels) {
      throw new Skip("over-budget", { format, reason: `coded ${avif.codedPixels} pixels` });
    }
    return { codedPixels: avif.codedPixels, iccBytes: avif.iccBytes };
  } else if (format === "webp") {
    const features = webpFeatures(source);
    if (!features) throw new Skip("unsupported", { format, reason: "chunks overrun the file" });
    return {
      codedPixels: features.canvasPixels,
      webpFullCanvas: features.fullCanvas,
      webpAnimated: features.animated,
      iccBytes: features.iccBytes,
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
