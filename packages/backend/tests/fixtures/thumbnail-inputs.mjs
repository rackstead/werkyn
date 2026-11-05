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

// ---------------------------------------------------------------------------
// AVIF item structures. libheif decodes an item's whole coded image (its
// `ispe`); a `clap` crop, a grid or an overlay can report a far smaller
// output size.

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
};
const fullBox = (type, version, flags, ...parts) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, head, ...parts);
};
const u16 = (...values) => { const b = Buffer.alloc(2 * values.length); values.forEach((v, i) => b.writeUInt16BE(v, 2 * i)); return b; };
const u32 = (...values) => { const b = Buffer.alloc(4 * values.length); values.forEach((v, i) => b.writeUInt32BE(v, 4 * i)); return b; };

/** The av1C and pixi property boxes and the coded AV1 data of a single-image AVIF made by sharp. */
function avifParts(avif) {
  const children = (start, end) => {
    const out = {};
    for (let pos = start; pos + 8 <= end; pos += avif.readUInt32BE(pos)) {
      out[avif.toString("latin1", pos + 4, pos + 8)] = [pos, pos + avif.readUInt32BE(pos)];
    }
    return out;
  };
  const top = children(0, avif.length);
  const meta = children(top.meta[0] + 12, top.meta[1]);
  const ipco = children(children(meta.iprp[0] + 8, meta.iprp[1]).ipco[0] + 8, children(meta.iprp[0] + 8, meta.iprp[1]).ipco[1]);
  const iloc = meta.iloc[0] + 8;
  // sharp writes iloc version 0: offset, length and base offset of 4 bytes, one item, one extent.
  if (avif[iloc] !== 0 || avif[iloc + 4] !== 0x44 || avif[iloc + 5] !== 0x40) throw new Error("unexpected iloc layout");
  const base = avif.readUInt32BE(iloc + 12), offset = avif.readUInt32BE(iloc + 18), length = avif.readUInt32BE(iloc + 22);
  const ispe = ipco.ispe[0];
  return {
    av1C: avif.subarray(...ipco.av1C),
    pixi: avif.subarray(...ipco.pixi),
    width: avif.readUInt32BE(ispe + 12),
    height: avif.readUInt32BE(ispe + 16),
    coded: avif.subarray(base + offset, base + offset + length),
  };
}

/**
 * An AVIF rebuilt from `avif`'s coded image. `layout` is "plain" (the image
 * itself), "clap" (cropped to `width` x `height` by a clean aperture),
 * "grid" (a 1 x 1 grid whose output is `width` x `height`) or "overlay" (an
 * `iovl` canvas of `width` x `height` holding the image).
 */
export function restructuredAvif(avif, layout, width, height) {
  const parts = avifParts(avif);
  const ispe = (w, h) => fullBox("ispe", 0, 0, u32(w, h));
  const derived = layout === "grid" || layout === "overlay";
  // Properties: 1 av1C, 2 coded ispe, 3 pixi, 4 output ispe or clap.
  const properties = [parts.av1C, ispe(parts.width, parts.height), parts.pixi];
  if (layout === "clap") properties.push(box("clap", u32(width, 1, height, 1, 0, 1, 0, 1)));
  if (derived) properties.push(ispe(width, height));
  const data = layout === "grid"
    ? Buffer.concat([Buffer.from([0, 0, 0, 0]), u16(width, height)])
    : layout === "overlay"
      ? Buffer.concat([Buffer.from([0, 0]), u16(0, 0, 0, 0xffff, width, height), u16(0, 0)])
      : Buffer.alloc(0);
  const itemType = layout === "grid" ? "grid" : "iovl";
  const infe = (id, type) => fullBox("infe", 2, 0, u16(id, 0), Buffer.from(type, "latin1"), Buffer.from([0]));
  const entry = (id, ...assoc) => Buffer.concat([u16(id), Buffer.from([assoc.length, ...assoc])]);
  const build = (mdatOffset) => {
    const items = [Buffer.concat([u16(1, 0, 0, 1), u32(mdatOffset, parts.coded.length)])];
    if (derived) items.push(Buffer.concat([u16(2, 1, 0, 1), u32(0, data.length)])); // construction method 1: idat
    const meta = fullBox("meta", 0, 0,
      fullBox("hdlr", 0, 0, u32(0), Buffer.from("pict"), u32(0, 0, 0), Buffer.from([0])),
      fullBox("pitm", 0, 0, u16(derived ? 2 : 1)),
      fullBox("iloc", 1, 0, Buffer.from([0x44, 0x00]), u16(items.length), ...items),
      fullBox("iinf", 0, 0, u16(derived ? 2 : 1), infe(1, "av01"), ...(derived ? [infe(2, itemType)] : [])),
      ...(derived ? [fullBox("iref", 0, 0, box("dimg", u16(2, 1, 1)))] : []),
      box("iprp",
        box("ipco", ...properties),
        fullBox("ipma", 0, 0, u32(derived ? 2 : 1),
          derived ? entry(1, 0x81, 0x02, 0x03) : entry(1, 0x81, 0x02, 0x03, ...(layout === "clap" ? [0x84] : [])),
          ...(derived ? [entry(2, 0x04, 0x03)] : []))),
      ...(derived ? [box("idat", data)] : []));
    return meta;
  };
  const ftyp = box("ftyp", Buffer.from("avif"), u32(0), Buffer.from("avifmif1miaf"));
  const placeholder = build(0);
  const mdatOffset = ftyp.length + placeholder.length + 8;
  return Buffer.concat([ftyp, build(mdatOffset), box("mdat", parts.coded)]);
}

// ---------------------------------------------------------------------------
// WebP and JPEG structures.

const riffChunk = (type, data) =>
  Buffer.concat([Buffer.from(type, "latin1"), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length); return b; })(), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const u24le = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]);

/**
 * An animated WebP whose canvas is `width` x `height` but whose two frames
 * are 1 x 1: libvips composites frames onto an RGBA canvas of the whole
 * image, so a few hundred bytes can need a gigabyte.
 */
export async function largeCanvasWebp(width, height) {
  const one = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#204060" } }).webp({ lossless: true }).toBuffer();
  const frame = one.subarray(12); // the VP8L chunk
  const anmf = riffChunk("ANMF", Buffer.concat([u24le(0), u24le(0), u24le(0), u24le(0), u24le(100), Buffer.from([0x02]), frame]));
  const body = Buffer.concat([
    Buffer.from("WEBP"),
    riffChunk("VP8X", Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24le(width - 1), u24le(height - 1)])),
    riffChunk("ANIM", Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0])),
    anmf, anmf,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
}

/** A lossless WebP of vertical stripes in `colors` colours (more than 16 disables pixel packing). */
export function stripesWebp(width, height, colors) {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) {
    const c = Math.floor((x * colors) / width);
    row[x * 3] = (c * 37) & 255; row[x * 3 + 1] = (c * 91) & 255; row[x * 3 + 2] = (c * 13 + 7) & 255;
  }
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) row.copy(raw, y * width * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).webp({ lossless: true, effort: 0 }).toBuffer();
}

/**
 * A flat progressive JPEG (4:4:4, all coefficients zero) with a valid but
 * long scan script: one DC scan, then for each component and each of
 * `bands` AC coefficients a first scan and `steps` refinement scans, so
 * 1 + 3 x bands x (steps + 1) scans. Every scan visits every block.
 */
export function manyScanJpeg(width, height, bands = 63, steps = 13) {
  const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);
  const bits = () => {
    const out = []; let acc = 0, n = 0;
    const put = (value, length) => {
      for (let i = length - 1; i >= 0; i--) {
        acc = (acc << 1) | ((value >> i) & 1);
        if (++n === 8) { out.push(acc); if (acc === 0xff) out.push(0); acc = 0; n = 0; }
      }
    };
    const flush = () => { while (n) put(1, 1); return Buffer.from(out); };
    return { put, flush };
  };
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const parts = [Buffer.from([0xff, 0xd8]), seg(0xdb, Buffer.from([0, ...Array(64).fill(1)]))];
  parts.push(seg(0xc2, Buffer.concat([Buffer.from([8]), u16(height, width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])])));
  parts.push(seg(0xc4, Buffer.from([0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 12 }, (_, i) => i)])));
  parts.push(seg(0xc4, Buffer.from([0x10, 0, 0, 0, 15, ...Array(12).fill(0), ...Array.from({ length: 15 }, (_, r) => r << 4)])));
  const dc = bits();
  for (let i = 0; i < Math.floor((blocks * 3) / 4); i++) dc.put(0, 8);
  for (let i = 0; i < (blocks * 3) % 4; i++) dc.put(0, 2);
  parts.push(seg(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 0, 0x00])), dc.flush());
  const eob = bits();
  for (let left = blocks; left; ) {
    const run = Math.min(left, 32767), r = 31 - Math.clz32(run);
    eob.put(r, 4);
    if (r) eob.put(run - (1 << r), r);
    left -= run;
  }
  const eobData = eob.flush();
  for (const component of [1, 2, 3]) {
    for (let k = 1; k <= bands; k++) {
      parts.push(seg(0xda, Buffer.from([1, component, 0x00, k, k, steps])), eobData);
      for (let ah = steps; ah > 0; ah--) parts.push(seg(0xda, Buffer.from([1, component, 0x00, k, k, (ah << 4) | (ah - 1)])), eobData);
    }
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/**
 * An AVIF assembled from `metas`, each { pitms, items: [{ id, type, data,
 * hidden }], properties: [box], associations: [[id, [byte]]], references },
 * with every item's data in one mdat after them. Used to build files whose
 * structure a parser and libheif could read differently.
 */
export function assembleAvif(metas) {
  const datas = [...new Set(metas.flatMap((m) => m.items.map((item) => item.data)))];
  const build = (offsets) => metas.map((m) => {
    const iloc = Buffer.concat([Buffer.from([0x44, 0x00]), u16(m.items.length),
      ...m.items.map((item) => Buffer.concat([u16(item.id, 0, 0, 1), u32(offsets.get(item.data) ?? 0, item.data.length)]))]);
    const ipma = fullBox("ipma", 0, 0, u32(m.associations.length),
      ...m.associations.map(([id, assoc]) => Buffer.concat([u16(id), Buffer.from([assoc.length, ...assoc])])));
    return fullBox("meta", 0, 0,
      fullBox("hdlr", 0, 0, u32(0), Buffer.from("pict"), u32(0, 0, 0), Buffer.from([0])),
      ...(m.pitms ?? [1]).map((id) => fullBox("pitm", 0, 0, u16(id))),
      fullBox("iloc", 1, 0, iloc),
      fullBox("iinf", 0, 0, u16(m.items.length),
        ...m.items.map((item) => fullBox("infe", 2, item.hidden ? 1 : 0, u16(item.id, 0), Buffer.from(item.type, "latin1"), Buffer.from([0])))),
      ...(m.references ? [m.references] : []),
      box("iprp", box("ipco", ...m.properties), ipma));
  });
  const ftyp = box("ftyp", Buffer.from("avif"), u32(0), Buffer.from("avifmif1miaf"));
  let at = ftyp.length + Buffer.concat(build(new Map())).length + 8;
  const offsets = new Map();
  for (const data of datas) { offsets.set(data, at); at += data.length; }
  return Buffer.concat([ftyp, ...build(offsets), box("mdat", ...datas)]);
}

const ispeBox = (w, h) => fullBox("ispe", 0, 0, u32(w, h));
const alphaAuxC = () => fullBox("auxC", 0, 0, Buffer.from("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0", "latin1"));
const auxl = (from, to) => fullBox("iref", 0, 0, box("auxl", u16(from, 1, to)));

/**
 * AVIF structures that a lenient parser and libheif read differently,
 * built from `big` (the 10000 x 10000 fixture) and `small` (a small AVIF
 * made by sharp). `big` is never what the parser should take as harmless.
 */
export function avifStructureCases(big, small) {
  const b = avifParts(big), s = avifParts(small);
  const plain = (parts, extra = [], assoc = []) => ({
    items: [{ id: 1, type: "av01", data: parts.coded }],
    properties: [parts.av1C, ispeBox(parts.width, parts.height), parts.pixi, ...extra],
    associations: [[1, [0x81, 0x02, 0x03, ...assoc]]],
  });
  const withAlpha = (alphaProperties, alphaAssoc) => ({
    items: [{ id: 1, type: "av01", data: s.coded }, { id: 2, type: "av01", data: b.coded, hidden: true }],
    properties: [s.av1C, ispeBox(s.width, s.height), s.pixi, b.av1C, alphaAuxC(), ...alphaProperties],
    associations: [[1, [0x81, 0x02, 0x03]], [2, alphaAssoc]],
    references: auxl(2, 1),
  });
  const cropped = plain(b, [box("clap", u32(s.width, 1, s.height, 1, 0, 1, 0, 1))], [0x84]);
  return {
    // libheif decodes the last meta box; a parser reading the first sees the small image.
    twoMetaSmallFirst: assembleAvif([plain(s), cropped]),
    twoMetaBigFirst: assembleAvif([cropped, plain(s)]),
    // An alpha plane whose coded size has no ispe, or an understated one.
    alphaWithoutIspe: assembleAvif([withAlpha([], [0x84, 0x85])]),
    alphaIspeUnderstated: assembleAvif([withAlpha([ispeBox(s.width, s.height)], [0x84, 0x85, 0x86])]),
    alphaIspeTrue: assembleAvif([withAlpha([ispeBox(b.width, b.height)], [0x84, 0x85, 0x86])]),
    // The primary with no ispe, or two.
    primaryWithoutIspe: assembleAvif([{ ...plain(b), associations: [[1, [0x81, 0x03]]] }]),
    primaryTwoIspe: assembleAvif([{ ...plain(b, [ispeBox(s.width, s.height)], [0x84]) }]),
    // Two pitm boxes, and an item ID used twice.
    twoPitm: assembleAvif([{ ...plain(s), pitms: [1, 1] }]),
    duplicateItem: assembleAvif([{ ...plain(s), items: [{ id: 1, type: "av01", data: s.coded }, { id: 1, type: "av01", data: b.coded }] }]),
    // A second, unrelated av01 item (for example a thumbnail or a depth map).
    extraImage: assembleAvif([{
      items: [{ id: 1, type: "av01", data: s.coded }, { id: 2, type: "av01", data: b.coded }],
      properties: [s.av1C, ispeBox(s.width, s.height), s.pixi, b.av1C, ispeBox(b.width, b.height)],
      associations: [[1, [0x81, 0x02, 0x03]], [2, [0x84, 0x85]]],
    }]),
    // Controls rebuilt the same way: a plain image and a crop.
    plainSmall: assembleAvif([plain(s)]),
    croppedBig: assembleAvif([cropped]),
  };
}

/**
 * `jpeg` (with more than 100 scans) with bytes inserted before its 100th
 * scan that libjpeg skips with a warning: one stray byte, or a TEM marker
 * followed by one.
 */
export function jpegWithJunkBeforeScan(jpeg, scan, junk) {
  let seen = 0;
  for (let at = jpeg.indexOf(Buffer.from([0xff, 0xda])); at !== -1; at = jpeg.indexOf(Buffer.from([0xff, 0xda]), at + 2)) {
    if (++seen === scan) return Buffer.concat([jpeg.subarray(0, at), junk, jpeg.subarray(at)]);
  }
  throw new Error("scan not found");
}

/**
 * An animated WebP of two `width` x `height` frames with a 64-level alpha
 * gradient, lossy with lossless alpha: each frame is decoded and blended at
 * full size.
 */
export function alphaAnimationWebp(width, height) {
  const frame = (shift) => {
    const row = Buffer.alloc(width * 4);
    for (let x = 0; x < width; x++) {
      const c = (Math.floor((x * 32) / width) + shift) % 32;
      row[x * 4] = (c * 37) & 255; row[x * 4 + 1] = (c * 91) & 255; row[x * 4 + 2] = (c * 13 + 7) & 255;
      row[x * 4 + 3] = (Math.floor((x * 64) / width) * 4 + 3) & 255;
    }
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) row.copy(raw, y * width * 4);
    return raw;
  };
  return sharp(Buffer.concat([frame(0), frame(9)]), { raw: { width, height: height * 2, channels: 4, pageHeight: height } })
    .webp({ quality: 50, alphaQuality: 100, effort: 0 })
    .toBuffer();
}

/**
 * A small AVIF whose item locations (`iloc`) are chosen by the caller, built
 * from `small` (an AVIF made by sharp). `primary` and `extra.extents` map
 * the layout L to [offset, length] extents:
 * - L.frame / L.frameLength: the coded frame (in mdat, or in idat when
 *   `method` is 1, relative to idat);
 * - L.extra / L.extraLength: the extra item's data in mdat;
 * - L.mdat: [start, end] of mdat's data; L.size: the file size.
 * `extra` adds an Exif or XMP (`mime`) item described by `cdsc`. `padTo`
 * pads the file with a `free` box, as an upload near the source cap would.
 */
export function locatedAvif(small, {
  primary = (L) => [[L.frame, L.frameLength]],
  extra = null,
  method = 0,
  dataReference = 0,
  ilocVersion = 1,
  baseOffsetSize = 0,
  baseOffset = 0n,
  padTo = 0,
} = {}) {
  const s = avifParts(small);
  const extraData = extra?.data ?? Buffer.alloc(0);
  const id = (v) => (ilocVersion < 2 ? u16(v) : u32(v));
  const base = () => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(baseOffset) & ((1n << 64n) - 1n));
    return b.subarray(8 - baseOffsetSize);
  };
  const entry = (itemId, construction, extents) => Buffer.concat([
    id(itemId), ...(ilocVersion >= 1 ? [u16(construction)] : []), u16(dataReference), base(), u16(extents.length),
    ...extents.map(([offset, length]) => u32(offset, length)),
  ]);
  const build = (L) => {
    const items = [entry(1, method, primary(L)), ...(extra ? [entry(2, 0, extra.extents(L))] : [])];
    const sizes = Buffer.from([0x44, baseOffsetSize === 8 ? 0x80 : baseOffsetSize === 4 ? 0x40 : 0x00]);
    const infeExtra = extra
      ? [extra.type === "Exif"
        ? fullBox("infe", 2, 0, u16(2, 0), Buffer.from("Exif"), Buffer.from([0]))
        : fullBox("infe", 2, 0, u16(2, 0), Buffer.from("mime"), Buffer.from([0]), Buffer.from("application/rdf+xml\0"))]
      : [];
    return fullBox("meta", 0, 0,
      fullBox("hdlr", 0, 0, u32(0), Buffer.from("pict"), u32(0, 0, 0), Buffer.from([0])),
      fullBox("pitm", 0, 0, u16(1)),
      fullBox("iloc", ilocVersion, 0, sizes, ilocVersion < 2 ? u16(items.length) : u32(items.length), ...items),
      fullBox("iinf", 0, 0, u16(1 + infeExtra.length), fullBox("infe", 2, 0, u16(1, 0), Buffer.from("av01"), Buffer.from([0])), ...infeExtra),
      ...(extra ? [fullBox("iref", 0, 0, box("cdsc", u16(2, 1, 1)))] : []),
      box("iprp", box("ipco", s.av1C, fullBox("ispe", 0, 0, u32(s.width, s.height)), s.pixi),
        fullBox("ipma", 0, 0, u32(1), u16(1), Buffer.from([3, 0x81, 0x02, 0x03]))),
      ...(method === 1 ? [box("idat", s.coded)] : []));
  };
  const ftyp = box("ftyp", Buffer.from("avif"), u32(0), Buffer.from("avifmif1miaf"));
  const assemble = (L) => {
    const meta = build(L);
    const mdatData = Buffer.concat([method === 1 ? Buffer.alloc(0) : s.coded, extraData]);
    const head = Buffer.concat([ftyp, meta, box("mdat", mdatData)]);
    const pad = padTo > head.length + 8 ? [box("free", Buffer.alloc(padTo - head.length - 8))] : [];
    return { file: Buffer.concat([head, ...pad]), meta };
  };
  const layout = (metaLength, total) => {
    const mdatStart = ftyp.length + metaLength + 8;
    const frameLength = s.coded.length;
    return {
      frame: method === 1 ? 0 : mdatStart, frameLength,
      extra: mdatStart + (method === 1 ? 0 : frameLength), extraLength: extraData.length,
      mdat: [mdatStart, mdatStart + (method === 1 ? 0 : frameLength) + extraData.length], size: total,
    };
  };
  const first = assemble(layout(0, 0));
  return assemble(layout(first.meta.length, first.file.length)).file;
}
