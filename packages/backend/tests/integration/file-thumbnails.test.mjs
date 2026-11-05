import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type/core";
import { png as smallPng, webp as smallWebp, makePdf } from "../fixtures/passive-media.mjs";
import {
  avif100Megapixels, avifStructureCases, blankGif, blankPng, cmykJpeg, gifSvgPolyglot, isoHeader,
  jpegWithJunkBeforeScan, largeCanvasWebp, locatedAvif, manyScanJpeg, restructuredAvif, rgb16Png,
  iccpChunk, jpegWithIcc, paddedIcc, pngWithChunks, zTxtChunk,
} from "../fixtures/thumbnail-inputs.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "file-thumbnail-integration-jwt-secret",
  COOKIE_SECRET: "file-thumbnail-integration-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-file-thumbnails-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

let app, user, workspace, token;
const extraUsers = [];
let requests = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({
    data: { email: `thumbs-${suffix}@example.test`, displayName: "Thumbnail fixture", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: { name: "Thumbnails", slug: `thumbs-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
});

after(async () => {
  try {
    if (workspace) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      // Deleting the files queued their blobs for cleanup; this suite starts no
      // cleanup worker and removes the storage itself, so drop only its rows.
      await app.prisma.blobCleanup.deleteMany({ where: { storagePath: { startsWith: `${workspace.id}/` } } });
    }
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
    await app?.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

function request(method, url, payload, headers = {}, auth = token) {
  return app.inject({
    method,
    url,
    payload,
    headers: { ...headers, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    remoteAddress: `10.82.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

async function uploadResponse(filename, contentType, bytes, auth = token, workspaceId = workspace.id) {
  const boundary = `werkyn-thumbnail-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request("POST", `/api/workspaces/${workspaceId}/files/upload`, payload, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  }, auth);
}

async function upload(filename, contentType, bytes) {
  const response = await uploadResponse(filename, contentType, bytes);
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json().data;
  assert.equal(file.mimeType, contentType);
  assert.equal(file.size, bytes.length);
  // The original is always stored and served unchanged, thumbnail or not.
  const download = await request("GET", `/api/workspaces/${workspace.id}/files/${file.id}/download`);
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  return file;
}

async function thumbnail(file) {
  const response = await request("GET", `/api/workspaces/${workspace.id}/files/${file.id}/thumbnail`);
  if (response.statusCode === 404) return null;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/webp");
  const meta = await sharp(response.rawPayload).metadata();
  return { format: meta.format, width: meta.width, height: meta.height, pages: meta.pages ?? 1, bytes: response.rawPayload };
}

const solid = (width, height, background, channels = 3) => sharp({ create: { width, height, channels, background } });

test("raster uploads get a 400-pixel-wide WebP thumbnail without enlargement", async () => {
  const cases = [
    ["wide.png", "image/png", await solid(1200, 800, "#3366cc").png().toBuffer(), [400, 267]],
    ["small.png", "image/png", await solid(120, 80, "#cc6633").png().toBuffer(), [120, 80]],
    ["alpha.png", "image/png", await solid(800, 400, { r: 0, g: 128, b: 0, alpha: 0.5 }, 4).png().toBuffer(), [400, 200]],
    ["photo.jpg", "image/jpeg", await solid(1000, 500, "#999999").jpeg().toBuffer(), [400, 200]],
    ["tall.webp", "image/webp", await solid(300, 900, "#112233").webp().toBuffer(), [300, 900]],
    ["flat.gif", "image/gif", await solid(640, 320, "#ff0000").gif().toBuffer(), [400, 200]],
  ];
  for (const [name, type, bytes, [width, height]] of cases) {
    const file = await upload(name, type, bytes);
    assert.ok(file.thumbnailPath, `${name} should get a thumbnail`);
    const thumb = await thumbnail(file);
    assert.deepEqual([thumb.format, thumb.width, thumb.height], ["webp", width, height], name);
  }
});

test("EXIF orientation remains unapplied, as before", async () => {
  const bytes = await solid(1000, 500, "#445566").jpeg().withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(bytes).metadata()).orientation, 6);
  const thumb = await thumbnail(await upload("rotated.jpg", "image/jpeg", bytes));
  assert.deepEqual([thumb.width, thumb.height], [400, 200]);
});

test("AVIF (HEIF) uploads are thumbnailed, under either declared HEIF type", async () => {
  const avif = await solid(800, 600, "#208040").avif({ quality: 50 }).toBuffer();
  for (const [name, type] of [["photo.avif", "image/avif"], ["photo.heic", "image/heic"]]) {
    const thumb = await thumbnail(await upload(name, type, avif));
    assert.deepEqual([thumb.format, thumb.width, thumb.height], ["webp", 400, 300], name);
  }
});

test("SVG declared as SVG is never rasterized", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="#000"/></svg>');
  const file = await upload("drawing.svg", "image/svg+xml", svg);
  assert.equal(file.thumbnailPath, null);
  assert.equal(await thumbnail(file), null);
});

test("raster entry boundaries preserve originals and exclude unrelated detector/native dispatch", async () => {
  const tiffBytes = await solid(64, 32, "#abcdef").tiff().toBuffer();
  await withDispatchSpies(async (state) => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>');
    for (const [name, mime, bytes] of [
      ["benign-svg.png", "image/png", svg],
      ["ordinary-text.jpg", "image/jpeg", Buffer.from("A harmless text fixture.")],
      ["passive-document.png", "image/png", makePdf()],
      ["declared.svg", "image/svg+xml", svg],
      ["ordinary.bin", "application/octet-stream", smallPng],
      ["scan-tiff.png", "image/png", tiffBytes],
      ["declared.tiff", "image/tiff", tiffBytes],
      ["photo-heic.png", "image/png", isoHeader("heic")],
    ]) {
      const file = await upload(name, mime, bytes);
      assert.equal(file.thumbnailPath, null, name);
      assert.equal(state.dispatches, 0, `${name} never reaches a worker`);
      assert.equal(state.detectorCalls, 0, name);
      assert.equal(state.headerCalls, 0, name);
      assert.equal(state.nativeCalls, 0, name);
    }
  });
});

// Detection and decoding run in the decoder workers, which report how far
// each file got: the detector, then libvips' header read, then the
// transform. Count what the upload route dispatched to them, arming the
// count with an ordinary PNG before interpreting any zero.
const STAGES = ["read", "signature", "detector", "container", "header", "transform"];
async function withDispatchSpies(run) {
  const { thumbnailWorkers } = await import("../../src/modules/files/thumbnails.ts");
  const dispatch = thumbnailWorkers.run;
  const state = { dispatches: 0, detectorCalls: 0, headerCalls: 0, nativeCalls: 0, results: [] };
  thumbnailWorkers.run = async function (...args) {
    state.dispatches++;
    const result = await dispatch.apply(this, args);
    state.results.push(result);
    const reached = STAGES.indexOf(result.details?.stage);
    if (reached >= STAGES.indexOf("detector")) state.detectorCalls++;
    if (reached >= STAGES.indexOf("header")) state.headerCalls++;
    if (reached >= STAGES.indexOf("transform")) state.nativeCalls++;
    return result;
  };
  const reset = () => {
    state.dispatches = state.detectorCalls = state.headerCalls = state.nativeCalls = 0;
    state.results = [];
  };
  try {
    const control = await upload("dispatch-control.png", "image/jpeg", smallPng);
    assert.ok(control.thumbnailPath);
    assert.equal(state.dispatches, 1, "The worker dispatch spy must be armed");
    assert.equal(state.detectorCalls, 1, "The worker must report the detector");
    assert.equal(state.headerCalls, 1, "The worker must report the header read");
    assert.equal(state.nativeCalls, 1, "The worker must report the transform");
    reset();
    return await run(state, reset);
  } finally {
    thumbnailWorkers.run = dispatch;
  }
}

function hugePng(width, height) {
  // A valid 1-bit greyscale PNG; the pixel data deflates to a few kilobytes.
  const crc = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 4 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("images over sharp's input pixel limit are stored without a thumbnail", async () => {
  const bytes = hugePng(20_000, 20_000); // 400 megapixels, over the 268,402,689 default
  await assert.rejects(sharp(bytes).resize(400).webp().toBuffer(), /pixel limit/);
  const file = await upload("huge.png", "image/png", bytes);
  assert.equal(file.thumbnailPath, null);
  assert.equal(await thumbnail(file), null);
  // Just under the limit is still decoded.
  const edge = await thumbnail(await upload("edge.png", "image/png", hugePng(16_000, 16_000)));
  assert.deepEqual([edge.width, edge.height], [400, 400]);
});

test("undecodable image bytes are stored without a thumbnail", async () => {
  for (const [name, type, bytes] of [
    ["broken.png", "image/png", Buffer.from("not really a png")],
    ["truncated.jpg", "image/jpeg", (await solid(64, 64, "#000").jpeg().toBuffer()).subarray(0, 40)],
    ["photo.heic", "image/heic", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)])],
  ]) {
    const file = await upload(name, type, bytes);
    assert.equal(file.thumbnailPath, null, name);
    assert.equal(await thumbnail(file), null, name);
  }
});

test("images larger than the thumbnail source limit are stored without being read back into memory", { timeout: 60_000 }, async () => {
  const { THUMBNAIL_SOURCE_MAX_BYTES } = await import("../../src/modules/files/files.service.ts");
  assert.equal(THUMBNAIL_SOURCE_MAX_BYTES, 32 * 1024 * 1024);
  // Uncompressed noise: a decodable PNG just over the limit, and one under it.
  const noise = (width, height) =>
    sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
  const over = await noise(3400, 3400);
  assert.ok(over.length > THUMBNAIL_SOURCE_MAX_BYTES, `${over.length}`);
  const large = await upload("large.png", "image/png", over);
  assert.equal(large.thumbnailPath, null);
  assert.equal(await thumbnail(large), null);

  const under = await noise(3000, 3000);
  assert.ok(under.length < THUMBNAIL_SOURCE_MAX_BYTES, `${under.length}`);
  const thumbed = await thumbnail(await upload("under.png", "image/png", under));
  assert.deepEqual([thumbed.width, thumbed.height], [400, 400]);
});

test("small APNG content retains the PNG family's real thumbnail behavior", async () => {
  const base = await solid(32, 16, "#228855").png().toBuffer();
  const control = Buffer.alloc(8);
  control.writeUInt32BE(1, 0);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(32, 4);
  frame.writeUInt32BE(16, 8);
  frame.writeUInt16BE(1, 20);
  frame.writeUInt16BE(10, 22);
  const bytes = Buffer.concat([base.subarray(0, 33), pngChunk("acTL", control), pngChunk("fcTL", frame), base.subarray(33)]);
  assert.equal((await fileTypeFromBuffer(bytes)).mime, "image/apng");
  const thumb = await thumbnail(await upload("animation.png", "image/png", bytes));
  assert.deepEqual([thumb.format, thumb.width, thumb.height], ["webp", 32, 16]);
});

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = ~0;
  for (const byte of body) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((~crc) >>> 0, body.length + 4);
  return chunk;
}

test("only the AVIF brand reaches detection and decoding; other HEIF brands and TIFF are stored without", async () => {
  // A real AVIF, and the same bytes with each other major brand.
  const avif = await solid(64, 32, "#208040").avif({ effort: 0 }).toBuffer();
  await withDispatchSpies(async (state, reset) => {
    const cases = [];
    for (const brand of ["avif", "avis", "mif1", "msf1", "heic", "heix", "hevc", "hevx"]) {
      const bytes = Buffer.from(avif);
      bytes.write(brand, 8, "latin1");
      cases.push([brand, bytes, brand === "avif"]);
    }
    for (const little of [true, false]) for (const version of [42, 43]) {
      const bytes = Buffer.alloc(16);
      bytes.write(little ? "II" : "MM");
      if (little) { bytes.writeUInt16LE(version, 2); bytes.writeUInt32LE(8, 4); }
      else { bytes.writeUInt16BE(version, 2); bytes.writeUInt32BE(8, 4); }
      cases.push([`${little ? "little" : "big"}-${version}`, bytes, false]);
    }
    for (const [name, bytes, dispatched] of cases) {
      reset();
      const file = await upload(`${name}.bin`, "image/heic", bytes);
      assert.equal(!!file.thumbnailPath, dispatched, name);
      for (const calls of [state.dispatches, state.detectorCalls, state.headerCalls, state.nativeCalls]) {
        assert.equal(calls, dispatched ? 1 : 0, name);
      }
    }
  });
});

test("ordinary ISO envelopes bound detector entry and preserve original uploads", async () => {
  await withDispatchSpies(async (state, reset) => {
    const header = (size, length = 24) => {
      const bytes = Buffer.alloc(length);
      bytes.writeUInt32BE(size);
      bytes.write("ftypavif", 4);
      return bytes;
    };
    // Plain headers reach the detector, then stop at the item-structure
    // check: they have no meta box, so nothing native reads them.
    for (const size of [16, 20, 24]) {
      reset();
      assert.equal((await upload(`ordinary-${size}.avif`, "image/avif", header(size))).thumbnailPath, null);
      assert.equal(state.detectorCalls, 1);
      assert.equal(state.headerCalls, 0);
      assert.equal(state.nativeCalls, 0);
      assert.equal(state.results[0].details.stage, "container");
    }
    const { THUMBNAIL_SOURCE_MAX_BYTES } = await import("../../src/modules/files/files.service.ts");
    for (const [size, length] of [
      [0, 24], [1, 24], [8, 24], [12, 24], [15, 24],
      [28, 24], [16, 12], [THUMBNAIL_SOURCE_MAX_BYTES + 4, 24],
    ]) {
      reset();
      const file = await upload(`omitted-${size}-${length}.avif`, "image/avif", header(size, length));
      assert.equal(file.thumbnailPath, null);
      assert.equal(state.dispatches, 0);
      assert.equal(state.detectorCalls, 0);
      assert.equal(state.headerCalls, 0);
      assert.equal(state.nativeCalls, 0);
    }
  });
});

test("detector refusal and transform failure omit only the thumbnail", async () => {
  await withDispatchSpies(async (state, reset) => {
    // JPEG-LS starts like JPEG; the detector names it image/jls.
    const jpegLs = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xf7]), Buffer.alloc(40)]);
    assert.equal((await upload("disallowed.jpg", "image/jpeg", jpegLs)).thumbnailPath, null);
    assert.equal(state.detectorCalls, 1);
    assert.equal(state.headerCalls, 0);
    assert.deepEqual([state.results[0].outcome, state.results[0].details.stage], ["unsupported", "detector"]);
    // Damaged pixel data (an IDAT checksum) fails only once decoding starts.
    reset();
    const damaged = Buffer.from(smallPng);
    const idat = damaged.indexOf("IDAT");
    damaged[idat + 4] ^= 0xff;
    assert.equal((await upload("transform-failure.png", "image/png", damaged)).thumbnailPath, null);
    assert.equal(state.detectorCalls, 1);
    assert.equal(state.nativeCalls, 1);
    assert.deepEqual([state.results[0].outcome, state.results[0].details.stage], ["failed", "transform"]);
  });
});

async function actor(role) {
  const person = await app.prisma.user.create({
    data: { email: `thumbnail-${crypto.randomUUID()}@example.test`, displayName: "Owned thumbnail actor", emailVerified: true },
  });
  extraUsers.push(person.id);
  if (role) await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: person.id, role } });
  const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");
  const session = await startRefreshSession(app.prisma, person.id);
  return { id: person.id, token: signAccessToken({ sub: person.id, email: person.email, sid: session.familyId }) };
}

test("refused upload actors stop before storage, detector and native dispatch", async () => {
  const viewer = await actor("VIEWER"), outsider = await actor();
  await withDispatchSpies(async (state) => {
    const save = app.storage.saveStream, read = app.storage.read;
    let writes = 0, reads = 0;
    const count = await app.prisma.file.count({ where: { workspaceId: workspace.id } });
    app.storage.saveStream = function (...args) { writes++; return save.apply(this, args); };
    app.storage.read = function (...args) { reads++; return read.apply(this, args); };
    try {
      for (const [auth, status] of [[null, 401], [viewer.token, 403], [outsider.token, 403]]) {
        const response = await uploadResponse("refused.png", "image/png", smallPng, auth);
        assert.equal(response.statusCode, status, response.body);
      }
      assert.equal(writes, 0); assert.equal(reads, 0);
      assert.equal(state.dispatches, 0);
      assert.equal(state.detectorCalls, 0); assert.equal(state.headerCalls, 0); assert.equal(state.nativeCalls, 0);
      assert.equal(await app.prisma.file.count({ where: { workspaceId: workspace.id } }), count);
    } finally { app.storage.saveStream = save; app.storage.read = read; }
  });
});

for (const recognized of [true, false]) test(`membership loss after staging rechecks ${recognized ? "raster" : "omitted-thumbnail"} uploads`, async () => {
  const member = await actor("MEMBER");
  const bytes = recognized ? smallPng : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
  const filename = `revoked-${crypto.randomUUID()}.png`, staged = [];
  const saveStream = app.storage.saveStream, save = app.storage.save;
  let enter, release, timer;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  app.storage.saveStream = async function (...args) {
    const stored = await saveStream.apply(this, args); staged.push(stored.storagePath); enter(); await released; return stored;
  };
  app.storage.save = async function (...args) { const stored = await save.apply(this, args); staged.push(stored); return stored; };
  let pending;
  try {
    pending = uploadResponse(filename, "image/png", bytes, member.token);
    await Promise.race([entered, pending.then(response => { throw new Error(`Upload ended before staging barrier: ${response.statusCode}`); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned staging barrier not reached")), 3000); })]);
    clearTimeout(timer);
    await app.prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId: member.id, workspaceId: workspace.id } } });
    release(); const response = await pending;
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(staged.length, recognized ? 2 : 1);
    assert.equal(await app.prisma.file.count({ where: { workspaceId: workspace.id, name: filename } }), 0);
    for (const p of staged) assert.equal(await app.storage.exists(p), false);
    assert.equal(await app.prisma.blobCleanup.count({ where: { storagePath: { in: staged } } }), 0);
  } finally {
    clearTimeout(timer); release();
    try { await pending; }
    finally { app.storage.saveStream = saveStream; app.storage.save = save; }
  }
});

for (const recognized of [true, false]) test(`failed File insert retains durable cleanup for ${recognized ? "original and thumbnail" : "omitted-thumbnail original"}`, async () => {
  const suffix = crypto.randomBytes(5).toString("hex"), fault = `thumbnail_fault_${suffix}`;
  const filename = `${fault}.png`, staged = [];
  const guard = await upload(`guard-${suffix}.png`, "image/png", smallPng);
  await app.prisma.blobCleanup.create({ data: { storagePath: guard.storagePath, availableAt: new Date(Date.now() + 3600000) } });
  const guardQueue = await app.prisma.blobCleanup.findUniqueOrThrow({ where: { storagePath: guard.storagePath } });
  const saveStream = app.storage.saveStream, save = app.storage.save, remove = app.storage.delete;
  let installed = false;
  try {
    await app.prisma.$executeRawUnsafe(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='${filename}' THEN RAISE EXCEPTION 'Owned thumbnail insert fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`);
    await app.prisma.$executeRawUnsafe(`CREATE TRIGGER ${fault} BEFORE INSERT ON "File" FOR EACH ROW EXECUTE FUNCTION ${fault}()`); installed = true;
    app.storage.saveStream = async function (...args) { const r = await saveStream.apply(this, args); staged.push(r.storagePath); return r; };
    app.storage.save = async function (...args) { const r = await save.apply(this, args); staged.push(r); return r; };
    app.storage.delete = function (p) {
      if (staged.includes(p)) return Promise.reject(Object.assign(new Error("Owned thumbnail cleanup outage"), { code: "EIO" }));
      return remove.call(this, p);
    };
    const bytes = recognized ? smallPng : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
    const response = await uploadResponse(filename, "image/png", bytes);
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(staged.length, recognized ? 2 : 1);
    assert.equal(await app.prisma.file.count({ where: { workspaceId: workspace.id, name: filename } }), 0);
    const queued = await app.prisma.blobCleanup.findMany({ where: { storagePath: { in: staged } }, orderBy: { storagePath: "asc" } });
    assert.deepEqual(queued.map(r => r.storagePath), [...staged].sort());
    for (const r of queued) { assert.ok(r.attempts >= 1); assert.match(r.lastError, /Owned thumbnail cleanup outage/); assert.equal(await app.storage.exists(r.storagePath), true); }
  } finally {
    app.storage.saveStream = saveStream; app.storage.save = save; app.storage.delete = remove;
    if (installed) await app.prisma.$executeRawUnsafe(`DROP TRIGGER ${fault} ON "File"`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fault}()`);
  }
  await app.prisma.blobCleanup.updateMany({ where: { storagePath: { in: staged } }, data: { availableAt: new Date(0) } });
  const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");
  const cleaned = await processBlobCleanup(app.prisma, app.storage, { paths: staged });
  assert.equal(cleaned.deleted, staged.length);
  assert.equal(await app.prisma.blobCleanup.count({ where: { storagePath: { in: staged } } }), 0);
  for (const p of staged) assert.equal(await app.storage.exists(p), false);
  assert.deepEqual(await app.prisma.blobCleanup.findUniqueOrThrow({ where: { storagePath: guard.storagePath } }), guardQueue);
  assert.deepEqual(await app.storage.read(guard.storagePath), smallPng);
  assert.ok(await app.prisma.file.findUnique({ where: { id: guard.id } }));
  await app.prisma.blobCleanup.delete({ where: { storagePath: guard.storagePath } });
});

async function outcomeDelta(run) {
  const { thumbnailOutcomes } = await import("../../src/modules/files/thumbnails.ts");
  const before = { ...thumbnailOutcomes };
  const result = await run();
  const delta = {};
  for (const [key, value] of Object.entries(thumbnailOutcomes)) if (value !== before[key]) delta[key] = value - before[key];
  return { result, delta };
}

test("disguised formats, polyglots and decompression bombs are stored unchanged without a thumbnail", async () => {
  const tiffBytes = await solid(800, 400, "#abcdef").tiff().toBuffer();
  const smallAvif = await solid(64, 32, "#208040").avif({ effort: 0 }).toBuffer();
  const icc = (await sharp(await solid(8, 8, "#208040").withIccProfile("p3").png().toBuffer()).metadata()).icc;
  const bigText = zTxtChunk("Comment", { size: 49_000_000 });
  const avifCases = avifStructureCases(avif100Megapixels, smallAvif);
  const scanBomb = manyScanJpeg(64, 64);
  for (const [name, type, bytes, outcome] of [
    ["scan.png", "image/png", tiffBytes, "unsupported"],
    ["scan.tiff", "image/tiff", tiffBytes, "unsupported"],
    ["drawing.gif", "image/gif", gifSvgPolyglot(), "failed"],
    ["photo.avif", "image/avif", avif100Megapixels, "over-budget"],
    ["photo.heic", "image/heic", avif100Megapixels, "over-budget"],
    ["banner.gif", "image/gif", blankGif(10000, 10000), "over-budget"],
    ["poster.png", "image/png", await blankPng(10000, 10000, { depth: 8, color: 6, interlace: true }), "over-budget"],
    // Reported as 64 x 64 by a crop, a grid or an overlay; coded 10000 x 10000.
    ["cropped.avif", "image/avif", restructuredAvif(avif100Megapixels, "clap", 64, 64), "over-budget"],
    ["grid.avif", "image/avif", restructuredAvif(avif100Megapixels, "grid", 64, 64), "unsupported"],
    ["overlay.avif", "image/avif", restructuredAvif(avif100Megapixels, "overlay", 64, 64), "unsupported"],
    ["canvas.webp", "image/webp", await largeCanvasWebp(16383, 16383), "over-budget"],
    ["scans.jpg", "image/jpeg", scanBomb, "over-budget"],
    // Read differently by a lenient parser and libheif or libjpeg.
    ["two-meta.avif", "image/avif", avifCases.twoMetaSmallFirst, "unsupported"],
    ["hidden-alpha.avif", "image/avif", avifCases.alphaWithoutIspe, "unsupported"],
    ["stray-byte.jpg", "image/jpeg", jpegWithJunkBeforeScan(scanBomb, 100, Buffer.from([0xff, 0xfe, 0x00, 0x02, 0x00])), "unsupported"],
    ["tem.jpg", "image/jpeg", jpegWithJunkBeforeScan(scanBomb, 100, Buffer.from([0xff, 0x01, 0x00])), "unsupported"],
    // Item extents that repeat the whole upload, which libheif concatenates.
    ["extents.avif", "image/avif", locatedAvif(smallAvif, { padTo: 4 * 1024 * 1024, primary: (L) => [[L.frame, L.frameLength], ...Array(30).fill([0, L.size])] }), "unsupported"],
    ["exif.avif", "image/avif", locatedAvif(smallAvif, { padTo: 4 * 1024 * 1024, extra: { type: "Exif", data: Buffer.from("Exif"), extents: (L) => Array(15).fill([0, L.size]) } }), "unsupported"],
    ["xmp.avif", "image/avif", locatedAvif(smallAvif, { padTo: 4 * 1024 * 1024, extra: { type: "mime", data: Buffer.from("<x/>"), extents: (L) => Array(15).fill([0, L.size]) } }), "unsupported"],
    // Metadata libvips inflates or copies while reading the header.
    ["notes.png", "image/png", pngWithChunks(Array(10).fill(bigText)), "unsupported"],
    ["profile.png", "image/png", pngWithChunks([iccpChunk(paddedIcc(icc, 49_000_000))]), "unsupported"],
    ["profile.jpg", "image/jpeg", jpegWithIcc(await solid(64, 32, "#208040").jpeg().toBuffer(), paddedIcc(icc, 5 * 1024 * 1024)), "over-budget"],
  ]) {
    const rss = process.memoryUsage().rss;
    const { result: file, delta } = await outcomeDelta(() => upload(name, type, bytes));
    assert.equal(file.thumbnailPath, null, name);
    assert.deepEqual(delta, { [outcome]: 1 }, name);
    assert.ok(process.memoryUsage().rss - rss < 128 * 1024 * 1024, name);
  }
});

test("CMYK, 16-bit, idat-stored AVIF and many-frame uploads get first-frame sRGB thumbnails", async () => {
  const idatAvif = locatedAvif(await solid(800, 400, "#208040").avif({ effort: 0 }).toBuffer(), { method: 1 });
  const iccP3 = (await sharp(await solid(8, 8, "#208040").withIccProfile("p3").png().toBuffer()).metadata()).icc;
  for (const [name, type, bytes, size] of [
    ["idat.avif", "image/avif", idatAvif, [400, 200]],
    ["profiled.png", "image/png", pngWithChunks([iccpChunk(iccP3), pngChunk("tEXt", Buffer.from("Title\0hello")), zTxtChunk("Comment", { size: 2000 })]), [64, 32]],
    ["cmyk-profiled.jpg", "image/jpeg", await solid(800, 400, "#3366cc").toColourspace("cmyk").withIccProfile("cmyk").jpeg().toBuffer(), [400, 200]],
    ["print.jpg", "image/jpeg", await cmykJpeg(800, 400), [400, 200]],
    ["deep.png", "image/png", await rgb16Png(800, 400), [400, 200]],
    ["loop.gif", "image/gif", blankGif(800, 400, 3000), [400, 200]],
  ]) {
    const { result: file, delta } = await outcomeDelta(() => upload(name, type, bytes));
    assert.deepEqual(delta, { created: 1 }, name);
    const thumb = await thumbnail(file);
    assert.deepEqual([thumb.format, thumb.width, thumb.height, thumb.pages], ["webp", ...size, 1], name);
    const meta = await sharp(thumb.bytes).metadata();
    assert.deepEqual([meta.space, meta.depth], ["srgb", "uchar"], name);
  }
});

test("uploads beyond the transform limit all succeed; the excess are stored at once without a thumbnail, and other workspaces keep a share", async (t) => {
  const { thumbnailAdmission, thumbnailWorkers } = await import("../../src/modules/files/thumbnails.ts");
  const { maxActive, maxQueued } = thumbnailAdmission.limits;
  const extra = 3, total = maxActive + maxQueued + extra;
  const tiffBytes = await solid(64, 32, "#abcdef").tiff().toBuffer();
  const dispatch = thumbnailWorkers.run;
  let inFlight = 0, peak = 0, open;
  const gate = new Promise((resolve) => { open = resolve; });
  // Each admitted upload's decode is held in its worker until the gate opens.
  thumbnailWorkers.run = async function () {
    inFlight++; peak = Math.max(peak, inFlight);
    try { await gate; return { ok: true, thumbnail: smallWebp, details: {} }; } finally { inFlight--; }
  };
  t.after(() => { open(); thumbnailWorkers.run = dispatch; });
  let responded = 0;
  const pending = Array.from({ length: total }, (_, i) =>
    uploadResponse(`burst-${i}.png`, "image/png", smallPng).then((response) => { responded++; return response; }));
  // While every admitted transform is held, the uploads that found the queue
  // full are already answered.
  const deadline = Date.now() + 10_000;
  while (responded < extra || thumbnailAdmission.usage.queued < maxQueued) {
    assert.ok(Date.now() < deadline, JSON.stringify({ responded, ...thumbnailAdmission.usage }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(responded, extra);
  assert.deepEqual(thumbnailAdmission.usage, { active: maxActive, queued: maxQueued });
  // Content outside the allowlist neither waits nor displaces a waiter.
  const { result: junk, delta: junkDelta } = await outcomeDelta(() => Promise.all([
    uploadResponse("junk.png", "image/png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    uploadResponse("scan.png", "image/png", tiffBytes),
  ]));
  for (const response of junk) {
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().data.thumbnailPath, null);
  }
  assert.deepEqual(junkDelta, { unsupported: 2 });
  assert.deepEqual(thumbnailAdmission.usage, { active: maxActive, queued: maxQueued });
  // Another workspace still gets a place: this workspace's newest waiter
  // goes without instead.
  const other = await app.prisma.workspace.create({
    data: { name: "Thumbnails 2", slug: `thumbs-${crypto.randomUUID().slice(0, 20)}`, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
  t.after(async () => {
    await app.prisma.workspace.deleteMany({ where: { id: other.id } });
    await app.prisma.blobCleanup.deleteMany({ where: { storagePath: { startsWith: `${other.id}/` } } });
  });
  const otherUpload = uploadResponse("other.png", "image/png", smallPng, token, other.id);
  while (responded < extra + 1) {
    assert.ok(Date.now() < deadline, JSON.stringify({ responded, ...thumbnailAdmission.usage }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(thumbnailAdmission.usage, { active: maxActive, queued: maxQueued });
  open();
  const files = (await Promise.all(pending)).map((response) => {
    assert.equal(response.statusCode, 201, response.body);
    return response.json().data;
  });
  assert.equal(files.filter((file) => file.thumbnailPath).length, maxActive + maxQueued - 1);
  assert.equal(files.filter((file) => !file.thumbnailPath).length, extra + 1);
  const otherResponse = await otherUpload;
  assert.equal(otherResponse.statusCode, 201, otherResponse.body);
  assert.ok(otherResponse.json().data.thumbnailPath);
  assert.equal(peak, maxActive);
  assert.deepEqual(thumbnailAdmission.usage, { active: 0, queued: 0 });
});
