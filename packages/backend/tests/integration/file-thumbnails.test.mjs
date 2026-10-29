import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import sharp from "sharp";

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
    if (workspace) await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

function request(method, url, payload, headers = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: { ...headers, authorization: `Bearer ${token}` },
    remoteAddress: `10.82.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

async function upload(filename, contentType, bytes) {
  const boundary = `werkyn-thumbnail-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request("POST", `/api/workspaces/${workspace.id}/files/upload`, payload, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json().data;
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

test("EXIF orientation is kept as metadata, not applied, as before", async () => {
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

test("SVG bytes under a raster type are rendered by librsvg without fetching external references", async () => {
  // The upload route trusts the client's declared type, so SVG content can
  // reach sharp/librsvg. External references must not be loaded.
  const marker = path.join(storageDir, "external-marker.png");
  await solid(10, 10, "#ffffff").png().toFile(marker);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="400">` +
      `<rect width="800" height="400" fill="#000000"/>` +
      `<image x="0" y="0" width="800" height="400" xlink:href="file://${marker}"/>` +
      `<image x="0" y="0" width="800" height="400" href="http://127.0.0.1:9/never.png"/>` +
      `</svg>`,
  );
  const thumb = await thumbnail(await upload("disguised.png", "image/png", svg));
  assert.deepEqual([thumb.format, thumb.width, thumb.height], ["webp", 400, 200]);
  const { channels } = await sharp(thumb.bytes).stats();
  // Still black: neither the local file nor the URL was drawn.
  assert.ok(channels.slice(0, 3).every((c) => c.max <= 8), JSON.stringify(channels.map((c) => c.max)));
});

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
