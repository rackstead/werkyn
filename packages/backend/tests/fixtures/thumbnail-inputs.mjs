// Passive image inputs for thumbnail admission tests. Every fixture is made
// here from constants; none embeds an exploit or reaches the network.
import zlib from "node:zlib";
import sharp from "sharp";

const crc32 = (buf) => {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};

export function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Deflates `length` zero bytes without holding them in memory. */
function deflateZeros(length) {
  const deflate = zlib.createDeflate({ level: 9 });
  const parts = [];
  deflate.on("data", (part) => parts.push(part));
  const zeros = Buffer.alloc(1 << 20);
  let left = length;
  return new Promise((resolve, reject) => {
    deflate.on("error", reject);
    deflate.on("end", () => resolve(Buffer.concat(parts)));
    (function pump() {
      while (left > 0) {
        const n = Math.min(left, zeros.length);
        left -= n;
        if (!deflate.write(n === zeros.length ? zeros : zeros.subarray(0, n))) return void deflate.once("drain", pump);
      }
      deflate.end();
    })();
  });
}

/**
 * A valid all-black PNG of any size whose pixel data deflates to about a
 * thousandth of its decoded size. `color` is the PNG colour type (0 grey,
 * 2 RGB, 6 RGBA); `interlace` uses Adam7, which libvips must decode whole.
 */
export async function blankPng(width, height, { depth = 1, color = 0, interlace = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = color;
  ihdr[12] = interlace ? 1 : 0;
  const bits = { 0: 1, 2: 3, 6: 4 }[color] * depth;
  let length = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const passWidth = Math.ceil((width - x0) / dx), passHeight = Math.ceil((height - y0) / dy);
    if (passWidth > 0 && passHeight > 0) length += passHeight * (1 + Math.ceil((passWidth * bits) / 8));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await deflateZeros(length)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * GIF sub-blocks of LZW codes for `count` pixels of palette `index`, run by
 * run (the codes a standard encoder emits for constant input), so 100
 * megapixels take about 66 KB and a few milliseconds to write.
 */
function constantLzw(index, count) {
  const minCodeSize = 2, clear = 4, eoi = 5;
  const bytes = [];
  let acc = 0, accBits = 0, size = minCodeSize + 1;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) { bytes.push(acc & 0xff); acc >>>= 8; accBits -= 8; }
  };
  emit(clear);
  let next = eoi + 1, longest = 1, left = count;
  while (left > 0) {
    const run = Math.min(longest, left);
    emit(run === 1 ? index : eoi + run - 1);
    left -= run;
    if (left === 0) break;
    if (next === 4096) {
      emit(clear);
      next = eoi + 1; size = minCodeSize + 1; longest = 1;
    } else {
      if (next >= 1 << size) size++;
      next++;
      longest = run + 1;
    }
  }
  emit(eoi);
  if (accBits > 0) bytes.push(acc & 0xff);
  const blocks = [Buffer.from([minCodeSize])];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    blocks.push(Buffer.from([block.length, ...block]));
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

/**
 * A valid GIF of `frames` full-size frames alternating between two colours.
 * The decoder draws frames onto an RGBA canvas of the whole image.
 */
export function blankGif(width, height, frames = 1) {
  const screen = Buffer.alloc(13);
  screen.write("GIF89a", 0, "latin1");
  screen.writeUInt16LE(width, 6);
  screen.writeUInt16LE(height, 8);
  screen[10] = 0x80; // global colour table of two entries
  const parts = [screen, Buffer.from([0x20, 0x40, 0x60, 0xff, 0xff, 0xff])];
  if (frames > 1) {
    // NETSCAPE2.0 looping extension
    parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00]));
  }
  const pixels = [constantLzw(0, width * height), constantLzw(1, width * height)];
  for (let frame = 0; frame < frames; frame++) {
    if (frames > 1) parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x02, 0x00, 0x00, 0x00])); // 20 ms
    const image = Buffer.alloc(10);
    image[0] = 0x2c;
    image.writeUInt16LE(width, 5);
    image.writeUInt16LE(height, 7);
    parts.push(image, pixels[frame % 2]);
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** An animated WebP of `frames` frames alternating between two colours. */
export function animatedWebp(width, height, frames) {
  const frame = width * height * 3;
  const raw = Buffer.alloc(frame * frames, 0x20);
  for (let i = 1; i < frames; i += 2) raw.fill(0xe0, i * frame, (i + 1) * frame);
  return sharp(raw, { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
    .webp({ effort: 0, lossless: true })
    .toBuffer();
}

/**
 * A real 10000 x 10000 AVIF of 2,153 bytes (`sharp({ create: { width: 10000,
 * height: 10000, channels: 3, background: "#808080" } }).avif({ quality: 30,
 * effort: 0 })` with sharp 0.35.5). Decoding it needs about 1.7 GiB.
 */
export const avif100Megapixels = Buffer.from([
  "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",
].join(""), "base64");

const solid = (width, height, background, channels = 3) =>
  sharp({ create: { width, height, channels, background } });

export const cmykJpeg = (width, height) =>
  solid(width, height, "#3366cc").toColourspace("cmyk").jpeg().toBuffer();

export const rgb16Png = (width, height) =>
  solid(width, height, "#3366cc").toColourspace("rgb16").png().toBuffer();

export const tiff = (width, height) => solid(width, height, "#abcdef").tiff().toBuffer();

export const svg = (width = 20, height = 10) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#c00"/></svg>`);

/** A GIF header followed by SVG markup: GIF to its signature, SVG to a text scan. */
export const gifSvgPolyglot = () =>
  Buffer.concat([Buffer.from("GIF89a"), Buffer.from(`  ${svg().toString()}`)]);

/** An ftyp box with `brand` as major brand, as HEIC/HEIF/AVIF files start. */
export function isoHeader(brand, size = 24, length = 24) {
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32BE(size);
  bytes.write(`ftyp${brand}`, 4, "latin1");
  return bytes;
}
