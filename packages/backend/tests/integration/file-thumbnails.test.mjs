import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { FileTypeParser, fileTypeFromBuffer } from "file-type/core";
import { png as smallPng, webp as smallWebp, makePdf } from "../fixtures/passive-media.mjs";

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

async function uploadResponse(filename, contentType, bytes, auth = token) {
  const boundary = `werkyn-thumbnail-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request("POST", `/api/workspaces/${workspace.id}/files/upload`, payload, {
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
    ["scan.tiff", "image/tiff", await solid(1600, 1200, "#abcdef").tiff().toBuffer(), [400, 300]],
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
  await withDispatchSpies(async (state) => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>');
    for (const [name, mime, bytes] of [
      ["benign-svg.png", "image/png", svg],
      ["ordinary-text.jpg", "image/jpeg", Buffer.from("A harmless text fixture.")],
      ["passive-document.png", "image/png", makePdf()],
      ["declared.svg", "image/svg+xml", svg],
      ["ordinary.bin", "application/octet-stream", smallPng],
    ]) {
      const file = await upload(name, mime, bytes);
      assert.equal(file.thumbnailPath, null, name);
      assert.equal(state.detectorCalls, 0, name);
      assert.equal(state.nativeCalls, 0, name);
    }
  });
});

// Match production's ESM Sharp and core detector class, not the distinct CJS
// Sharp constructor or the Node detector subclass. Arm both with PNG before
// interpreting any zero count. Unsupported fixtures never reach native code.
async function withDispatchSpies(run) {
  const detector = FileTypeParser.prototype.fromBuffer;
  const render = sharp.prototype.toBuffer;
  const state = { detectorCalls: 0, nativeCalls: 0, detectorMode: "real", nativeMode: "stub" };
  FileTypeParser.prototype.fromBuffer = async function (...args) {
    state.detectorCalls++;
    if (state.detectorMode === "throw") throw new Error("Owned detector failure");
    if (state.detectorMode === "unknown") return undefined;
    if (state.detectorMode === "disallowed") return { ext: "svg", mime: "image/svg+xml" };
    return detector.apply(this, args);
  };
  sharp.prototype.toBuffer = function () {
    state.nativeCalls++;
    if (state.nativeMode === "throw") return Promise.reject(new Error("Owned transform failure"));
    return Promise.resolve(smallWebp);
  };
  try {
    const control = await upload("dispatch-control.png", "image/jpeg", smallPng);
    assert.ok(control.thumbnailPath);
    assert.equal(state.detectorCalls, 1, "Exact ESM detector spy must be armed");
    assert.equal(state.nativeCalls, 1, "Exact ESM transform spy must be armed");
    state.detectorCalls = state.nativeCalls = 0;
    return await run(state);
  } finally {
    FileTypeParser.prototype.fromBuffer = detector;
    sharp.prototype.toBuffer = render;
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

test("HEIF brands and both TIFF byte orders retain detector and transform dispatch", async () => {
  await withDispatchSpies(async (state) => {
    const cases = [];
    for (const brand of ["avif", "avis", "mif1", "msf1", "heic", "heix", "hevc", "hevx"]) {
      const bytes = Buffer.alloc(24);
      bytes.writeUInt32BE(24);
      bytes.write("ftyp" + brand, 4);
      cases.push([brand, bytes]);
    }
    for (const little of [true, false]) for (const version of [42, 43]) {
      const bytes = Buffer.alloc(16);
      bytes.write(little ? "II" : "MM");
      if (little) { bytes.writeUInt16LE(version, 2); bytes.writeUInt32LE(8, 4); }
      else { bytes.writeUInt16BE(version, 2); bytes.writeUInt32BE(8, 4); }
      cases.push([`${little ? "little" : "big"}-${version}`, bytes]);
    }
    // Container headers exercise dispatch only. The armed transform returns
    // a known small WebP; these are never presented to a native decoder.
    for (const [name, bytes] of cases) {
      state.detectorCalls = state.nativeCalls = 0;
      const file = await upload(`${name}.bin`, "image/heic", bytes);
      assert.ok(file.thumbnailPath, name);
      assert.equal(state.detectorCalls, 1, name);
      assert.equal(state.nativeCalls, 1, name);
    }
  });
});

test("detector refusal/failure and transform failure omit only the thumbnail", async () => {
  await withDispatchSpies(async (state) => {
    for (const mode of ["unknown", "disallowed", "throw"]) {
      state.detectorMode = mode;
      state.detectorCalls = state.nativeCalls = 0;
      assert.equal((await upload(`${mode}.png`, "image/png", smallPng)).thumbnailPath, null);
      assert.equal(state.detectorCalls, 1);
      assert.equal(state.nativeCalls, 0);
    }
    state.detectorMode = "real";
    state.nativeMode = "throw";
    state.detectorCalls = state.nativeCalls = 0;
    assert.equal((await upload("transform-failure.png", "image/png", smallPng)).thumbnailPath, null);
    assert.equal(state.detectorCalls, 1);
    assert.equal(state.nativeCalls, 1);
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
      assert.equal(state.detectorCalls, 0); assert.equal(state.nativeCalls, 0);
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
