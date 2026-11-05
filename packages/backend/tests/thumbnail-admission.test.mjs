import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import sharp from "sharp";
import {
  THUMBNAIL_LIMITS,
  TransformAdmission,
  checkAvif,
  bufferSource,
  createThumbnail,
  defaultAdmissionLimits,
  estimateDecodeBytes,
  jpegScanCount,
  thumbnailAdmission,
  thumbnailFormat,
  thumbnailOutcomes,
  webpFeatures,
} from "../src/modules/files/thumbnails.ts";
import {
  animatedWebp,
  avif100Megapixels,
  blankGif,
  blankPng,
  cmykJpeg,
  gifSvgPolyglot,
  isoHeader,
  alphaAnimationWebp,
  avifStructureCases,
  jpegWithJunkBeforeScan,
  largeCanvasWebp,
  locatedAvif,
  manyScanJpeg,
  restructuredAvif,
  stripesWebp,
  rgb16Png,
  svg,
  tiff,
} from "./fixtures/thumbnail-inputs.mjs";
import { makePdf, png as smallPng } from "./fixtures/passive-media.mjs";

const solid = (width, height, background = "#3366cc", channels = 3) =>
  sharp({ create: { width, height, channels, background } });
const MiB = 1024 * 1024;

/** The outcome counts `run` adds. */
async function outcomes(run) {
  const before = { ...thumbnailOutcomes };
  const result = await run();
  const delta = {};
  for (const [key, value] of Object.entries(thumbnailOutcomes)) {
    if (value !== before[key]) delta[key] = value - before[key];
  }
  return { result, delta };
}

const thumbnailOf = (bytes, options) => createThumbnail(bufferSource(bytes), options);

test("only fixed allowlisted raster signatures choose a decoder", async () => {
  const allowed = [
    ["jpeg", await solid(8, 8).jpeg().toBuffer()],
    ["png", await solid(8, 8).png().toBuffer()],
    ["webp", await solid(8, 8).webp().toBuffer()],
    ["webp", await solid(8, 8).webp({ lossless: true }).toBuffer()],
    ["webp", await solid(8, 8, { r: 1, g: 2, b: 3, alpha: 0.5 }, 4).webp().toBuffer()],
    ["gif", await solid(8, 8).gif().toBuffer()],
    ["gif", Buffer.concat([Buffer.from("GIF87a"), Buffer.alloc(7)])],
    ["avif", await solid(8, 8).avif().toBuffer()],
    ["avif", isoHeader("avif")],
  ];
  for (const [format, bytes] of allowed) assert.equal(thumbnailFormat(bytes), format, format);

  const refused = [
    ["svg", svg()],
    ["svg after BOM and whitespace", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("\n  "), svg()])],
    ["xml prolog svg", Buffer.from(`<?xml version="1.0"?>${svg()}`)],
    ["svgz", (await import("node:zlib")).gzipSync(svg())],
    ["tiff", await tiff(8, 8)],
    ["big-endian tiff", Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["bigtiff", Buffer.from([0x49, 0x49, 0x2b, 0x00, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["pdf", makePdf()],
    ["bmp", Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)])],
    ["ico", Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0])],
    ["psd", Buffer.concat([Buffer.from("8BPS"), Buffer.alloc(30)])],
    ["radiance", Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n")],
    ["ppm", Buffer.from("P6\n1 1\n255\n\0\0\0")],
    ["jpeg 2000", Buffer.from([0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a, 0, 0, 0, 0])],
    ["jpeg xl", Buffer.from([0xff, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ["zip", Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(30)])],
    ["html", Buffer.from("<!doctype html><img src=x>")],
    ["png signature without IHDR", Buffer.concat([smallPng.subarray(0, 8), Buffer.from("\0\0\0\x0dtEXt"), Buffer.alloc(20)])],
    ["riff but not webp", Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(16)])],
    ["webp with unknown chunk", Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPABCD"), Buffer.alloc(16)])],
    ["short gif", Buffer.from("GIF89a")],
    ["empty", Buffer.alloc(0)],
  ];
  for (const brand of ["avis", "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "mp41", "isom", "jxl "]) {
    refused.push([`ftyp ${brand}`, isoHeader(brand)]);
  }
  for (const [size, length] of [[0, 24], [1, 24], [15, 24], [28, 24], [16, 12]]) {
    refused.push([`avif ftyp size ${size} in ${length} bytes`, isoHeader("avif", size, length)]);
  }
  for (const [name, bytes] of refused) assert.equal(thumbnailFormat(bytes), null, name);
});

test("the AVIF sequence brand is refused: the detector accepts it but libvips cannot load it", async () => {
  const sequence = Buffer.from(await solid(64, 32).avif().toBuffer());
  sequence.write("avis", 8, "latin1");
  assert.equal((await (await import("file-type")).fileTypeFromBuffer(sequence)).mime, "image/avif");
  await assert.rejects(sharp(sequence).metadata(), /unsupported image format/);
  assert.equal(thumbnailFormat(sequence), null);
  assert.deepEqual((await outcomes(() => thumbnailOf(sequence))).delta, { unsupported: 1 });
});

test("libvips may use only the allowlisted buffer loaders in this process", async () => {
  const decodable = {
    png: await solid(20, 10).png().toBuffer(),
    jpeg: await solid(20, 10).jpeg().toBuffer(),
    webp: await solid(20, 10).webp().toBuffer(),
    gif: await solid(20, 10).gif().toBuffer(),
    heif: await solid(20, 10).avif().toBuffer(),
  };
  for (const [format, bytes] of Object.entries(decodable)) {
    assert.equal((await sharp(bytes).metadata()).format, format);
  }
  const blocked = { svg: svg(), tiff: await tiff(20, 10) };
  for (const [format, bytes] of Object.entries(blocked)) {
    await assert.rejects(sharp(bytes).metadata(), /unsupported image format/, format);
    await assert.rejects(sharp(bytes).resize(8).webp().toBuffer(), /unsupported image format/, format);
  }
  // Control: the same bytes decode in a process that never loaded thumbnails.ts.
  const control = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import sharp from "sharp";
    const input = JSON.parse(process.argv[1]);
    const formats = [];
    for (const base64 of input) formats.push((await sharp(Buffer.from(base64, "base64")).metadata()).format);
    console.log(formats.join(","));
  `, JSON.stringify(Object.values(blocked).map((bytes) => bytes.toString("base64")))], { encoding: "utf8" });
  assert.equal(control.trim(), "svg,tiff");
});

test("disguised and polyglot inputs never reach a non-allowlisted decoder", async () => {
  const png = await solid(40, 20).png().toBuffer();
  const jpeg = await solid(40, 20).jpeg().toBuffer();
  const cases = [
    // Declared types and names do not reach this layer; only bytes do.
    ["svg", svg(), "unsupported"],
    ["tiff", await tiff(40, 20), "unsupported"],
    ["pdf", makePdf(), "unsupported"],
    ["heic brand", isoHeader("heic"), "unsupported"],
    ["mif1 brand", isoHeader("mif1"), "unsupported"],
    // JPEG-LS starts like JPEG; the detector disagrees, so nothing decodes it.
    ["jpeg-ls", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xf7]), Buffer.alloc(40)]), "unsupported"],
    // A GIF signature followed by SVG markup reaches only the GIF decoder,
    // which rejects it; the SVG loader is blocked either way.
    ["gif/svg polyglot", gifSvgPolyglot(), "failed"],
    // Trailing archives or markup stay data for the raster decoder.
    ["png + zip", Buffer.concat([png, Buffer.from("PK\x03\x04"), Buffer.alloc(64)]), "created"],
    ["jpeg + html", Buffer.concat([jpeg, Buffer.from("<html><script>alert(1)</script></html>")]), "created"],
  ];
  for (const [name, bytes, expected] of cases) {
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    assert.deepEqual(delta, { [expected]: 1 }, name);
    if (expected === "created") {
      const meta = await sharp(result).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 40, 20], name);
    } else {
      assert.equal(result, null, name);
    }
  }
});

test("decoder memory is estimated from the header and bounded per transform", () => {
  const budget = THUMBNAIL_LIMITS.decodeBudgetBytes;
  const meta = (format, width, height, extra = {}) => ({ format, width, height, channels: 3, depth: "uchar", ...extra });
  const within = [
    meta("jpeg", 16000, 16000), // baseline JPEG shrinks on load
    meta("png", 16000, 16000, { channels: 1 }),
    meta("png", 8000, 8000, { channels: 4, isProgressive: true }),
    meta("jpeg", 8000, 6000, { isProgressive: true }),
    meta("gif", 7000, 7000, { channels: 4 }),
    meta("webp", 14000, 14000),
    meta("webp", 8000, 8000, { pages: 2 }),
    meta("heif", 4032, 3024),
    meta("heif", 4000, 3000, { channels: 4 }),
  ];
  for (const m of within) assert.ok(estimateDecodeBytes(m) <= budget, JSON.stringify(m));
  const over = [
    meta("heif", 10000, 10000),
    meta("heif", 6000, 6000),
    meta("heif", 4000, 4000, { channels: 4, depth: "ushort" }),
    meta("png", 10000, 10000, { channels: 4, isProgressive: true }),
    meta("png", 16000, 16000, { channels: 4, depth: "ushort" }),
    meta("jpeg", 10000, 10000, { isProgressive: true }),
    meta("jpeg", 7000, 7000, { channels: 4, isProgressive: true }),
    meta("gif", 10000, 10000, { channels: 4 }),
  ];
  for (const m of over) assert.ok(estimateDecodeBytes(m) > budget, JSON.stringify(m));
  // Container hints: the coded AVIF size and the WebP canvas and features.
  assert.ok(estimateDecodeBytes(meta("heif", 64, 64), { codedPixels: 10000 * 10000 }) > budget);
  assert.ok(estimateDecodeBytes(meta("heif", 64, 64), { codedPixels: 64 * 64 }) < 1024 * 1024);
  assert.ok(estimateDecodeBytes(meta("webp", 16383, 16383)) > budget, "lossy WebP at 2 B/px");
  assert.ok(estimateDecodeBytes(meta("webp", 8000, 8000), { webpFullCanvas: true }) <= budget);
  assert.ok(estimateDecodeBytes(meta("webp", 8700, 8700), { webpFullCanvas: true }) > budget);
  assert.ok(estimateDecodeBytes(meta("webp", 5675, 5675), { webpFullCanvas: true, webpAnimated: true }) <= budget);
  assert.ok(estimateDecodeBytes(meta("webp", 5700, 5700), { webpFullCanvas: true, webpAnimated: true }) > budget);
  assert.ok(estimateDecodeBytes(meta("webp", 1, 1), { codedPixels: 16383 * 16383, webpFullCanvas: true, webpAnimated: true }) > budget);
  for (const m of [meta("svg", 1, 1), meta("tiff", 1, 1), meta("png", 0, 1), meta("png", 1, 1, { depth: "double" }), {}]) {
    assert.equal(estimateDecodeBytes(m), Infinity, JSON.stringify(m));
  }
});

test("decompression bombs within the source cap are refused before decoding", async () => {
  const bombs = [
    // 2 KiB; main decoded it with about 1.7 GiB of memory.
    ["100-megapixel AVIF", avif100Megapixels, "over-budget"],
    ["100-megapixel interlaced RGBA PNG", await blankPng(10000, 10000, { depth: 8, color: 6, interlace: true }), "over-budget"],
    ["100-megapixel GIF", blankGif(10000, 10000), "over-budget"],
    ["400-megapixel PNG over the pixel limit", await blankPng(20000, 20000), "failed"],
  ];
  for (const [name, bytes, expected] of bombs) {
    assert.ok(bytes.length < 2 * MiB, `${name}: ${bytes.length}`);
    const rss = process.memoryUsage().rss;
    const started = performance.now();
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    const elapsed = performance.now() - started;
    assert.equal(result, null, name);
    assert.deepEqual(delta, { [expected]: 1 }, name);
    assert.ok(elapsed < 1000, `${name} took ${elapsed} ms`);
    assert.ok(process.memoryUsage().rss - rss < 64 * MiB, name);
  }
  // Large images that stream, or fit the budget, still get thumbnails.
  for (const [name, bytes, size] of [
    ["256-megapixel 1-bit PNG", await blankPng(16000, 16000), [400, 400]],
    ["36-megapixel interlaced RGB PNG", await blankPng(6000, 6000, { depth: 8, color: 2, interlace: true }), [400, 400]],
    ["16-megapixel GIF", blankGif(4000, 4000), [400, 400]],
    ["2-megapixel AVIF", await solid(2000, 1000).avif({ effort: 0 }).toBuffer(), [400, 200]],
  ]) {
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    assert.deepEqual(delta, { created: 1 }, name);
    const meta = await sharp(result).metadata();
    assert.deepEqual([meta.width, meta.height], size, name);
  }
});

test("animated GIF and WebP with many frames decode only their first frame", async () => {
  for (const [name, bytes, size] of [
    ["5000-frame GIF", blankGif(640, 320, 5000), [400, 200]],
    ["2000-frame WebP", await animatedWebp(64, 32, 2000), [64, 32]],
  ]) {
    assert.ok((await sharp(bytes).metadata()).pages >= 2000, name);
    const started = performance.now();
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    const elapsed = performance.now() - started;
    assert.deepEqual(delta, { created: 1 }, name);
    assert.ok(elapsed < 2000, `${name} took ${elapsed} ms`);
    const meta = await sharp(result).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.pages ?? 1], ["webp", ...size, 1], name);
    // The first frame is the dark one.
    const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0] < 0x80, `${name} first pixel ${data[0]}`);
  }
});

test("CMYK and 16-bit inputs make ordinary 8-bit sRGB thumbnails", async () => {
  const cmyk = await cmykJpeg(800, 400);
  assert.equal((await sharp(cmyk).metadata()).space, "cmyk");
  const deep = await rgb16Png(800, 400);
  const deepMeta = await sharp(deep).metadata();
  assert.deepEqual([deepMeta.depth, deepMeta.space], ["ushort", "rgb16"]);
  for (const [name, bytes] of [["cmyk jpeg", cmyk], ["16-bit png", deep]]) {
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    assert.deepEqual(delta, { created: 1 }, name);
    const meta = await sharp(result).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.depth, meta.space, meta.channels], ["webp", 400, 200, "uchar", "srgb", 3], name);
  }
});

test("AVIF is charged for its coded size; crops cannot hide it and grids and overlays are refused", async (t) => {
  const small = await solid(64, 32).avif({ effort: 0 }).toBuffer();
  // The rebuilt files are valid: libheif reports the crop, grid or overlay output size.
  for (const layout of ["plain", "clap", "grid", "overlay"]) {
    const bytes = restructuredAvif(small, layout, 16, 8);
    const meta = await sharp(bytes).metadata();
    assert.deepEqual([meta.width, meta.height], layout === "plain" ? [64, 32] : [16, 8], layout);
    assert.deepEqual(checkAvif(bytes), layout === "grid" ? { refused: "grid item" }
      : layout === "overlay" ? { refused: "iovl item" } : { codedPixels: 64 * 32 }, layout);
  }
  for (const layout of ["plain", "clap"]) {
    assert.deepEqual((await outcomes(() => thumbnailOf(restructuredAvif(small, layout, 16, 8)))).delta, { created: 1 }, layout);
  }
  assert.ok("refused" in checkAvif(Buffer.concat([isoHeader("avif"), Buffer.from("not a meta box")])));

  const header = sharp.prototype.metadata, render = sharp.prototype.toBuffer;
  let nativeCalls = 0;
  sharp.prototype.metadata = function (...args) { nativeCalls++; return header.apply(this, args); };
  sharp.prototype.toBuffer = function (...args) { nativeCalls++; return render.apply(this, args); };
  t.after(() => { sharp.prototype.metadata = header; sharp.prototype.toBuffer = render; });
  // The 2 KiB 10000 x 10000 AVIF reports 64 x 64 when cropped, gridded or
  // overlaid; main and the first version of this change decoded each with
  // about 1.7 GiB.
  for (const [layout, expected, native] of [["clap", "over-budget", 1], ["grid", "unsupported", 0], ["overlay", "unsupported", 0]]) {
    const bytes = restructuredAvif(avif100Megapixels, layout, 64, 64);
    nativeCalls = 0;
    const rss = process.memoryUsage().rss, started = performance.now();
    const { result, delta } = await outcomes(() => thumbnailOf(bytes));
    assert.equal(result, null, layout);
    assert.deepEqual(delta, { [expected]: 1 }, layout);
    assert.equal(nativeCalls, native, `${layout}: only the header read for clap, nothing for derived items`);
    assert.ok(performance.now() - started < 1000, layout);
    assert.ok(process.memoryUsage().rss - rss < 64 * MiB, layout);
  }
  // An ispe that understates the coded size is refused by libheif before it decodes.
  const understated = Buffer.from(avif100Megapixels);
  for (let at = understated.indexOf("ispe"); at !== -1; at = understated.indexOf("ispe", at + 1)) {
    understated.writeUInt32BE(64, at + 8);
    understated.writeUInt32BE(64, at + 12);
  }
  const rss = process.memoryUsage().rss, started = performance.now();
  assert.deepEqual((await outcomes(() => thumbnailOf(understated))).delta, { failed: 1 });
  assert.ok(performance.now() - started < 1000);
  assert.ok(process.memoryUsage().rss - rss < 64 * MiB);
});

test("AVIF outside the one simple shape gets no thumbnail, whatever libheif would decode", async (t) => {
  const small = await solid(64, 32).avif({ effort: 0 }).toBuffer();
  const cases = avifStructureCases(avif100Megapixels, small);
  // libheif decodes the last of two meta boxes, and an alpha plane without
  // an ispe at its coded size: both 10000 x 10000 here, reported as 64 x 32.
  for (const name of ["twoMetaSmallFirst", "alphaWithoutIspe"]) {
    assert.deepEqual(await sharp(cases[name]).metadata().then((m) => [m.width, m.height]), [64, 32], name);
  }
  const header = sharp.prototype.metadata, render = sharp.prototype.toBuffer;
  let nativeCalls = 0;
  sharp.prototype.metadata = function (...args) { nativeCalls++; return header.apply(this, args); };
  sharp.prototype.toBuffer = function (...args) { nativeCalls++; return render.apply(this, args); };
  t.after(() => { sharp.prototype.metadata = header; sharp.prototype.toBuffer = render; });
  for (const [name, refused] of [
    ["twoMetaSmallFirst", "more than one meta box"],
    ["twoMetaBigFirst", "more than one meta box"],
    ["alphaWithoutIspe", "item 2 with 0 ispe"],
    ["alphaIspeTrue", "alpha size differs"],
    ["primaryWithoutIspe", "item 1 with 0 ispe"],
    ["primaryTwoIspe", "item 1 with 2 ispe"],
    ["twoPitm", "more than one pitm box"],
    ["duplicateItem", "item 1 twice"],
    ["extraImage", "av01 item 2 is not the primary's alpha"],
  ]) {
    assert.deepEqual(checkAvif(cases[name]), { refused }, name);
    nativeCalls = 0;
    const rss = process.memoryUsage().rss;
    assert.deepEqual((await outcomes(() => thumbnailOf(cases[name]))).delta, { unsupported: 1 }, name);
    assert.equal(nativeCalls, 0, `${name} reaches no native call`);
    assert.ok(process.memoryUsage().rss - rss < 64 * MiB, name);
  }
  // An alpha ispe that understates the coded size passes the shape check;
  // libheif then refuses it before decoding, as it does for the primary.
  const rss = process.memoryUsage().rss, started = performance.now();
  assert.deepEqual(checkAvif(cases.alphaIspeUnderstated), { codedPixels: 64 * 32 });
  assert.deepEqual((await outcomes(() => thumbnailOf(cases.alphaIspeUnderstated))).delta, { failed: 1 });
  assert.ok(performance.now() - started < 1000);
  assert.ok(process.memoryUsage().rss - rss < 64 * MiB);
  // The simple shape, with or without alpha, is thumbnailed; a crop is charged its coded size.
  assert.deepEqual((await outcomes(() => thumbnailOf(cases.plainSmall))).delta, { created: 1 });
  assert.deepEqual((await outcomes(() => thumbnailOf(cases.croppedBig))).delta, { "over-budget": 1 });
  for (const [name, options] of [["8-bit", {}], ["10-bit", { bitdepth: 10 }]]) {
    const rgba = await solid(64, 32, { r: 10, g: 20, b: 30, alpha: 0.5 }, 4).avif({ effort: 0, ...options }).toBuffer();
    assert.deepEqual(checkAvif(rgba), { codedPixels: 64 * 32 }, name);
    assert.deepEqual((await outcomes(() => thumbnailOf(rgba))).delta, { created: 1 }, name);
  }
});

test("AVIF item locations may not repeat, overlap or leave mdat or idat, and metadata items stay small", async (t) => {
  const small = await solid(64, 32).avif({ effort: 0 }).toBuffer();
  const exif = Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from("Exif\0\0MM\0*\0\0\0\x08\0\0", "latin1")]);
  const xmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
  const exifItem = (extents, data = exif) => ({ type: "Exif", data, extents });
  const xmpItem = (extents) => ({ type: "mime", data: xmp, extents });
  const quarters = (L) => {
    const q = Math.floor(L.frameLength / 4);
    return [[L.frame, q], [L.frame + q, q], [L.frame + 2 * q, q], [L.frame + 3 * q, L.frameLength - 3 * q]];
  };
  // What encoders write: one extent per item in mdat or idat, any iloc
  // version and offset width, a few consecutive extents, small Exif/XMP.
  for (const [name, options] of [
    ["mdat", {}],
    ["idat", { method: 1 }],
    ["iloc version 0", { ilocVersion: 0 }],
    ["iloc version 2", { ilocVersion: 2 }],
    ["4-byte base offset", { baseOffsetSize: 4 }],
    ["four consecutive extents", { primary: quarters }],
    ["Exif", { extra: exifItem((L) => [[L.extra, L.extraLength]]) }],
    ["XMP", { extra: xmpItem((L) => [[L.extra, L.extraLength]]) }],
  ]) {
    const bytes = locatedAvif(small, options);
    assert.deepEqual(checkAvif(bytes), { codedPixels: 64 * 32 }, name);
    assert.deepEqual((await outcomes(() => thumbnailOf(bytes))).delta, { created: 1 }, name);
  }
  const header = sharp.prototype.metadata, render = sharp.prototype.toBuffer;
  let nativeCalls = 0;
  sharp.prototype.metadata = function (...args) { nativeCalls++; return header.apply(this, args); };
  sharp.prototype.toBuffer = function (...args) { nativeCalls++; return render.apply(this, args); };
  t.after(() => { sharp.prototype.metadata = header; sharp.prototype.toBuffer = render; });
  // libheif concatenates an item's extents and libvips copies Exif and XMP
  // while reading the header: at 32 MiB, 31 copies of the file in the
  // primary, or 15 in an Exif or XMP item, OOM-killed a 1 GiB container.
  const wholeFile = (copies) => (L) => Array(copies).fill([0, L.size]);
  for (const [name, options, refused] of [
    ["primary repeating the file", { padTo: 64 * 1024, primary: (L) => [[L.frame, L.frameLength], ...wholeFile(30)(L)] }, "item 1 with 31 extents"],
    ["Exif repeating the file", { padTo: 64 * 1024, extra: exifItem(wholeFile(15)) }, "item 2 with 15 extents"],
    ["XMP repeating the file", { padTo: 64 * 1024, extra: xmpItem(wholeFile(15)) }, "item 2 with 15 extents"],
    ["primary repeating its frame", { primary: (L) => [[L.frame, L.frameLength], [L.frame, L.frameLength]] }, "overlapping item extents"],
    ["Exif sharing the frame's bytes", { extra: exifItem((L) => [[L.frame, L.frameLength]]) }, "overlapping item extents"],
    ["Exif over 1 MiB", { extra: exifItem((L) => [[L.extra, L.extraLength]], Buffer.concat([exif, Buffer.alloc(1024 * 1024)])) }, "Exif item 2 over 1048576 bytes"],
    ["extent in the padding", { padTo: 64 * 1024, primary: (L) => [[L.mdat[1] + 64, L.frameLength]] }, "item 1 extent outside its data box"],
    ["extent past the end", { primary: (L) => [[L.frame, L.frameLength + 100000]] }, "item 1 extent outside its data box"],
    ["extent to the end of the file", { primary: (L) => [[L.frame, 0]] }, "item 1 extent to the end of the file"],
    ["data in another file", { dataReference: 1 }, "item 1 data in another file"],
    ["construction method 2", { method: 2 }, "item 1 construction method 2"],
    ["base offset near 2^63", { baseOffsetSize: 8, baseOffset: (1n << 63n) + 5n }, "item 1 extent outside its data box"],
  ]) {
    const bytes = locatedAvif(small, options);
    assert.deepEqual(checkAvif(bytes), { refused }, name);
    nativeCalls = 0;
    assert.deepEqual((await outcomes(() => thumbnailOf(bytes))).delta, { unsupported: 1 }, name);
    assert.equal(nativeCalls, 0, `${name} reaches no native call`);
  }
});

test("WebP is charged for a full canvas when lossless, with alpha or animated", async () => {
  const cases = [
    ["lossy", await solid(64, 32).webp().toBuffer(), false],
    ["lossless", await solid(64, 32).webp({ lossless: true }).toBuffer(), true],
    ["lossy with alpha", await solid(64, 32, { r: 1, g: 2, b: 3, alpha: 0.5 }, 4).webp().toBuffer(), true],
    ["animated", await animatedWebp(16, 8, 4), true],
  ];
  for (const [name, bytes, fullCanvas] of cases) {
    assert.equal(webpFeatures(bytes).fullCanvas, fullCanvas, name);
    assert.equal(webpFeatures(bytes).animated, name === "animated", name);
  }
  const canvas = await largeCanvasWebp(16383, 16383);
  assert.ok(canvas.length < 200);
  assert.deepEqual(webpFeatures(canvas), { fullCanvas: true, animated: true, canvasPixels: 16383 * 16383 });
  const lossy = cases[0][1];
  assert.equal(webpFeatures(lossy.subarray(0, lossy.length - 10)), null, "chunks overrunning the file");
  // A 144-byte animation onto a 16383 x 16383 canvas needed about 1.1 GiB.
  const rss = process.memoryUsage().rss, started = performance.now();
  assert.deepEqual((await outcomes(() => thumbnailOf(canvas))).delta, { "over-budget": 1 });
  assert.ok(performance.now() - started < 1000);
  assert.ok(process.memoryUsage().rss - rss < 64 * MiB);
  // Bytes after the RIFF container are not image data, even if they look like an oversized chunk.
  const trailing = Buffer.alloc(8);
  trailing.write("JUNK", 0, "latin1");
  trailing.writeUInt32LE(0x7fffffff, 4);
  const withTrailing = Buffer.concat([lossy, trailing]);
  assert.deepEqual(webpFeatures(withTrailing), { fullCanvas: false, animated: false, canvasPixels: 0 });
  assert.deepEqual((await outcomes(() => thumbnailOf(withTrailing))).delta, { created: 1 });
  // Animations are charged 12.5 B/px of canvas: frames with alpha are
  // decoded and blended at full size (8.4-10.2 B/px measured).
  const alphaAnimation = await alphaAnimationWebp(256, 128);
  assert.deepEqual(webpFeatures(alphaAnimation), { fullCanvas: true, animated: true, canvasPixels: 256 * 128 });
  assert.deepEqual((await outcomes(() => thumbnailOf(alphaAnimation))).delta, { created: 1 });
  const overCanvas = await largeCanvasWebp(5700, 5700), underCanvas = await largeCanvasWebp(4000, 4000);
  assert.deepEqual((await outcomes(() => thumbnailOf(overCanvas))).delta, { "over-budget": 1 });
  assert.deepEqual((await outcomes(() => thumbnailOf(underCanvas))).delta, { created: 1 });
  // Lossless with more than 16 colours is not packed; it still gets a thumbnail at ordinary sizes.
  const stripes = await stripesWebp(2048, 1024, 32);
  assert.equal(webpFeatures(stripes).fullCanvas, true);
  const { result, delta } = await outcomes(() => thumbnailOf(stripes));
  assert.deepEqual(delta, { created: 1 });
  assert.deepEqual(await sharp(result).metadata().then((m) => [m.width, m.height]), [400, 200]);
});

test("JPEGs with more scans than the limit are refused before decoding", async () => {
  const progressive = await solid(640, 320).jpeg({ progressive: true }).toBuffer();
  const baseline = await solid(640, 320).jpeg().toBuffer();
  assert.equal(jpegScanCount(baseline, 100), 1);
  const scans = jpegScanCount(progressive, 100);
  assert.ok(scans > 1 && scans <= 12, `${scans}`);
  const bomb = manyScanJpeg(64, 64);
  // 1 + 3 x 63 x 14 scans; valid and decodable.
  assert.equal(jpegScanCount(bomb, 10_000), 2647);
  assert.equal(jpegScanCount(bomb, THUMBNAIL_LIMITS.maxJpegScans), THUMBNAIL_LIMITS.maxJpegScans + 1);
  assert.equal((await sharp(bomb).raw().toBuffer()).length, 64 * 64 * 3);
  const atLimit = manyScanJpeg(64, 64, 3, 10); // 1 + 3 x 3 x 11 = 100 scans
  assert.equal(jpegScanCount(atLimit, 10_000), 100);
  assert.deepEqual((await outcomes(() => thumbnailOf(bomb))).delta, { "over-budget": 1 });
  // One stray byte, or a TEM marker and a byte, before scan 100: libjpeg
  // skips them with a warning and decodes all 2,647 scans, so a walk that
  // does not reach EOI cleanly refuses the file.
  for (const [name, junk, count, outcome] of [
    ["stray byte after a segment", [0xff, 0xfe, 0x00, 0x02, 0x00], Infinity, "unsupported"],
    ["TEM marker and a byte", [0xff, 0x01, 0x00], Infinity, "unsupported"],
    // Bytes right after entropy-coded data read as part of it, so every scan is counted.
    ["stray byte after a scan", [0x00], THUMBNAIL_LIMITS.maxJpegScans + 1, "over-budget"],
    ["stuffing after a scan", [0xff, 0x00], THUMBNAIL_LIMITS.maxJpegScans + 1, "over-budget"],
  ]) {
    const hidden = jpegWithJunkBeforeScan(bomb, 100, Buffer.from(junk));
    assert.equal((await sharp(hidden, { failOn: "none" }).raw().toBuffer()).length, 64 * 64 * 3, name);
    assert.equal(jpegScanCount(hidden, THUMBNAIL_LIMITS.maxJpegScans), count, name);
    assert.deepEqual((await outcomes(() => thumbnailOf(hidden))).delta, { [outcome]: 1 }, name);
  }
  const truncated = progressive.subarray(0, progressive.length - 2);
  assert.equal(jpegScanCount(truncated, 100), Infinity, "no EOI");
  const trailing = Buffer.concat([progressive, Buffer.from("trailing data after EOI")]);
  assert.equal(jpegScanCount(trailing, 100), scans);
  assert.deepEqual((await outcomes(() => thumbnailOf(trailing))).delta, { created: 1 });
  assert.deepEqual((await outcomes(() => thumbnailOf(atLimit))).delta, { created: 1 });
  assert.deepEqual((await outcomes(() => thumbnailOf(progressive))).delta, { created: 1 });
});

test("container checks stop after a bounded amount of work on crafted files", async () => {
  const size = 32 * MiB - 1024;
  // An AVIF of tiny boxes, a WebP of tiny chunks, and JPEGs of empty
  // segments or of stuffed 0xFF bytes, each filling the source cap.
  const avif = Buffer.alloc(size);
  isoHeader("avif", 24).copy(avif);
  for (let at = 24; at + 8 <= size; at += 8) { avif.writeUInt32BE(8, at); avif.write("free", at + 4, "latin1"); }
  const webp = Buffer.alloc(size);
  webp.write("RIFF", 0, "latin1"); webp.writeUInt32LE(size - 8, 4); webp.write("WEBP", 8, "latin1");
  for (let at = 12; at + 8 <= size; at += 8) webp.write("JUNK", at, "latin1");
  const segments = Buffer.alloc(size);
  segments[0] = 0xff; segments[1] = 0xd8;
  for (let at = 2; at + 4 <= size; at += 4) { segments[at] = 0xff; segments[at + 1] = 0xfe; segments.writeUInt16BE(2, at + 2); }
  const stuffed = Buffer.alloc(size);
  Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]).copy(stuffed);
  for (let at = 6; at + 2 <= size; at += 2) stuffed[at] = 0xff;
  for (const [name, check, refused] of [
    ["avif boxes", () => checkAvif(avif).refused, "unreadable structure"],
    ["webp chunks", () => webpFeatures(webp), null],
    ["jpeg segments", () => jpegScanCount(segments, 100), Infinity],
    ["jpeg stuffing", () => jpegScanCount(stuffed, 100), Infinity],
  ]) {
    const started = performance.now();
    assert.equal(check(), refused, name);
    assert.ok(performance.now() - started < 50, `${name} took ${performance.now() - started} ms`);
  }
  for (const [name, bytes, outcome] of [["avif", avif, "unsupported"], ["webp", webp, "unsupported"], ["jpeg", segments, "unsupported"]]) {
    assert.deepEqual((await outcomes(() => thumbnailOf(bytes))).delta, { [outcome]: 1 }, name);
  }
});

test("content outside the allowlisted signatures never takes a turn", async (t) => {
  const junk = [svg(), await tiff(8, 8), makePdf(), Buffer.alloc(0), Buffer.from("text")];
  const admission = new TransformAdmission({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 100 });
  const render = sharp.prototype.toBuffer;
  let finish;
  sharp.prototype.toBuffer = function () { return new Promise((resolve) => { finish = () => resolve(smallPng); }); };
  t.after(() => { sharp.prototype.toBuffer = render; });
  const held = thumbnailOf(smallPng, { admission });
  while (admission.usage.active === 0 || !finish) await new Promise((resolve) => setImmediate(resolve));
  for (const bytes of junk) {
    assert.deepEqual((await outcomes(() => thumbnailOf(bytes, { admission }))).delta, { unsupported: 1 });
  }
  assert.deepEqual((await outcomes(() => thumbnailOf(smallPng, { admission }))).delta, { busy: 1 });
  finish();
  assert.ok(await held);
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });
});

test("admission bounds active transforms, the queue and the wait", async () => {
  const admission = new TransformAdmission({ maxActive: 2, maxQueued: 2, queueTimeoutMs: 100 });
  const first = await admission.acquire();
  const second = await admission.acquire();
  assert.ok(first && second);
  const third = admission.acquire();
  const fourth = admission.acquire();
  assert.deepEqual(admission.usage, { active: 2, queued: 2 });
  assert.equal(await admission.acquire(), null, "a full queue refuses at once");

  first();
  first(); // releasing twice frees one turn
  const thirdRelease = await third;
  assert.ok(thirdRelease, "the oldest waiter is admitted first");
  assert.deepEqual(admission.usage, { active: 2, queued: 1 });
  const started = performance.now();
  assert.equal(await fourth, null, "a waiter gives up after queueTimeoutMs");
  assert.ok(performance.now() - started >= 80);
  assert.deepEqual(admission.usage, { active: 2, queued: 0 });
  second();
  thirdRelease();
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });
});

test("default admission is sized from the CPU count", () => {
  for (const [cpus, active] of [[1, 1], [2, 1], [3, 1], [4, 2], [8, 2], [64, 2]]) {
    assert.deepEqual(defaultAdmissionLimits(cpus), { maxActive: active, maxQueued: 8, queueTimeoutMs: 5000 });
  }
  assert.deepEqual(thumbnailAdmission.limits, defaultAdmissionLimits());
  assert.equal(sharp.concurrency(), 1, "one libvips thread per transform");
  assert.equal(sharp.cache().items.max, 0, "no libvips operation cache");
});

test("a transform the upload stops waiting for keeps its turn until libvips settles", async (t) => {
  const admission = new TransformAdmission({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 100 });
  const render = sharp.prototype.toBuffer;
  let finish;
  sharp.prototype.toBuffer = function () {
    return new Promise((resolve) => { finish = () => resolve(smallPng); });
  };
  t.after(() => { sharp.prototype.toBuffer = render; });
  const started = performance.now();
  const { result, delta } = await outcomes(() => thumbnailOf(smallPng, { admission, deadlineMs: 50 }));
  assert.equal(result, null);
  assert.deepEqual(delta, { "timed-out": 1 });
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(admission.usage, { active: 1, queued: 0 });
  assert.deepEqual((await outcomes(() => thumbnailOf(smallPng, { admission }))).delta, { busy: 1 });
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });
});

test("a stalled source read times out, keeps its turn, and a late read starts no decode", async (t) => {
  const admission = new TransformAdmission({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 100 });
  const header = sharp.prototype.metadata, render = sharp.prototype.toBuffer;
  let nativeCalls = 0;
  sharp.prototype.metadata = function (...args) { nativeCalls++; return header.apply(this, args); };
  sharp.prototype.toBuffer = function (...args) { nativeCalls++; return render.apply(this, args); };
  t.after(() => { sharp.prototype.metadata = header; sharp.prototype.toBuffer = render; });
  let finishRead;
  const stalled = new Promise((resolve) => { finishRead = () => resolve(smallPng); });
  const started = performance.now();
  const source = { size: smallPng.length, head: async () => smallPng, read: () => stalled };
  const { result, delta } = await outcomes(() => createThumbnail(source, { admission, deadlineMs: 50 }));
  assert.equal(result, null);
  assert.deepEqual(delta, { "timed-out": 1 });
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(admission.usage, { active: 1, queued: 0 });
  finishRead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });
  assert.equal(nativeCalls, 0, "the late read reached no decoder");
});

test("a stalled read of the first bytes is abandoned before admission", async () => {
  const admission = new TransformAdmission({ maxActive: 1, maxQueued: 0, queueTimeoutMs: 100 });
  let seen;
  const source = {
    size: smallPng.length,
    head: (signal) => { seen = signal; return new Promise((resolve) => signal.addEventListener("abort", () => resolve(smallPng))); },
    read: async () => smallPng,
  };
  const started = performance.now();
  const { result, delta } = await outcomes(() => createThumbnail(source, { admission, headTimeoutMs: 50 }));
  assert.equal(result, null);
  assert.deepEqual(delta, { "timed-out": 1 });
  assert.ok(performance.now() - started < 1000);
  assert.equal(seen.aborted, true, "the read is told to stop");
  assert.deepEqual(admission.usage, { active: 0, queued: 0 }, "no turn was taken");
  // A failing read omits only the thumbnail.
  const failing = { ...source, head: async () => { throw new Error("Owned head read failure"); } };
  assert.deepEqual((await outcomes(() => createThumbnail(failing, { admission }))).delta, { failed: 1 });
});

test("admission is shared fairly between workspaces", async () => {
  const admission = new TransformAdmission({ maxActive: 2, maxQueued: 2, queueTimeoutMs: 1000 });
  const a1 = await admission.acquire("a");
  const a2 = await admission.acquire("a");
  const a3 = admission.acquire("a");
  const a4 = admission.acquire("a");
  assert.deepEqual(admission.usage, { active: 2, queued: 2 });
  // Workspace a holds four turns, b none: b takes a's newest place.
  const b1 = admission.acquire("b");
  assert.equal(await a4, null);
  assert.deepEqual(admission.usage, { active: 2, queued: 2 });
  // a holds three, b one: a's newest place again goes to b.
  const b2 = admission.acquire("b");
  assert.equal(await a3, null);
  // Now a and b hold two each: neither displaces the other.
  assert.equal(await admission.acquire("b"), null);
  assert.equal(await admission.acquire("a"), null);
  // c holds none, b two: c takes b's newest place.
  const c1 = admission.acquire("c");
  assert.equal(await b2, null);
  // Freed turns go to the waiting keys, oldest first among equals.
  a1();
  const b1Release = await b1;
  assert.ok(b1Release);
  a2();
  const c1Release = await c1;
  assert.ok(c1Release);
  b1Release();
  c1Release();
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });

  // With a mixed queue, the oldest waiter of the least active key goes first.
  const x1 = await admission.acquire("x");
  const x2 = await admission.acquire("x");
  const x3 = admission.acquire("x");
  const y1 = admission.acquire("y");
  let x3Granted = false;
  x3.then(() => { x3Granted = true; });
  x1();
  const y1Release = await y1;
  assert.ok(y1Release);
  assert.equal(x3Granted, false, "x already has an active turn");
  x2();
  const x3Release = await x3;
  assert.ok(x3Release);
  y1Release();
  x3Release();
  assert.deepEqual(admission.usage, { active: 0, queued: 0 });
});

test("saturation keeps transforms bounded and the event loop responsive", async (t) => {
  const { maxActive, maxQueued } = thumbnailAdmission.limits;
  const render = sharp.prototype.toBuffer;
  let inFlight = 0, peak = 0;
  sharp.prototype.toBuffer = function (...args) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return render.apply(this, args).finally(() => inFlight--);
  };
  t.after(() => { sharp.prototype.toBuffer = render; });
  // A real decode of about 0.3 s and 170 MiB each: Adam7 PNG is decoded whole.
  const source = await blankPng(6000, 6000, { depth: 8, color: 6, interlace: true });
  const requests = maxActive + maxQueued + 4;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  const { result, delta } = await outcomes(() =>
    Promise.all(Array.from({ length: requests }, () => thumbnailOf(source))));
  const elapsed = performance.now() - started;
  delay.disable();
  const stats = { requests, maxActive, maxQueued, elapsedMs: Math.round(elapsed), peak, delta, loopMaxMs: delay.max / 1e6, loopP99Ms: delay.percentile(99) / 1e6 };
  t.diagnostic(JSON.stringify(stats));
  assert.equal(peak, maxActive, JSON.stringify(stats));
  assert.equal(result.length, requests);
  // Waiters beyond the queue go without at once; the queue drains in turn.
  assert.equal(delta.busy, requests - maxActive - maxQueued, JSON.stringify(stats));
  assert.equal((delta.created ?? 0) + (delta.busy ?? 0), requests, JSON.stringify(stats));
  assert.deepEqual(thumbnailAdmission.usage, { active: 0, queued: 0 });
  assert.ok(stats.loopMaxMs < 250, JSON.stringify(stats));
});
