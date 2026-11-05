import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { png as smallPng } from "../fixtures/passive-media.mjs";
import { avif100Megapixels, pngWithChunks, restructuredAvif, zTxtChunk } from "../fixtures/thumbnail-inputs.mjs";

// Thumbnails decode in memory-limited worker processes. Here the container
// checks and memory estimate are switched off (honoured only under
// NODE_ENV=test), so decompression bombs reach libvips through the real
// upload route: each may end its worker, never the server, and uploads keep
// succeeding.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "thumbnail-worker-isolation-jwt-secret",
  COOKIE_SECRET: "thumbnail-worker-isolation-cookie-secret",
  WERKYN_TEST_THUMBNAIL_MEMORY_CHECKS: "off",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-thumbnail-workers-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { thumbnailOutcomes, thumbnailWorkers } = await import("../../src/modules/files/thumbnails.ts");

const MiB = 1024 * 1024;
let app, user, token;
const workspaces = [];
let requests = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({
    data: { email: `thumb-workers-${suffix}@example.test`, displayName: "Thumbnail worker fixture", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  for (const name of ["A", "B"]) {
    workspaces.push(await app.prisma.workspace.create({
      data: { name, slug: `thumb-workers-${name.toLowerCase()}-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } },
    }));
  }
});

after(async () => {
  try {
    for (const workspace of workspaces) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.blobCleanup.deleteMany({ where: { storagePath: { startsWith: `${workspace.id}/` } } });
    }
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await thumbnailWorkers.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function upload(workspace, filename, contentType, bytes) {
  const boundary = `werkyn-thumbnail-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/upload`,
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` },
    remoteAddress: `10.83.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
  assert.equal(response.statusCode, 201, response.body);
  const file = response.json().data;
  assert.equal(file.size, bytes.length);
  return file;
}

async function outcomeDelta(run) {
  const before = { ...thumbnailOutcomes };
  const result = await run();
  const delta = {};
  for (const [key, value] of Object.entries(thumbnailOutcomes)) if (value !== before[key]) delta[key] = value - before[key];
  return { result, delta };
}

const pids = () => thumbnailWorkers.stats.workers.map((worker) => worker.pid);

test("the switch reaches the workers only in tests", () => {
  assert.equal(thumbnailWorkers.options.memoryChecks, false);
});

test("decompression bombs past the checks end only a worker; the server and other uploads carry on", async () => {
  const [a, b] = workspaces;
  assert.ok((await upload(b, "warm.png", "image/png", smallPng)).thumbnailPath);
  const before = { pids: pids(), rss: process.memoryUsage().rss, crashed: thumbnailWorkers.stats.crashed };
  // 477 KB: ten zTXt chunks inflating to 490 MB in libpng; glib aborts the worker.
  const notes = pngWithChunks(Array(10).fill(zTxtChunk("Comment", { size: 49_000_000 })));
  const { result: notesFile, delta: notesDelta } = await outcomeDelta(() => upload(a, "notes.png", "image/png", notes));
  assert.equal(notesFile.thumbnailPath, null);
  assert.ok(notesDelta.crashed === 1 || notesDelta.failed === 1, JSON.stringify(notesDelta));
  // 2 KiB, decoded at 10000 x 10000 (about 1.7 GiB): refused by the limit.
  const cropped = restructuredAvif(avif100Megapixels, "clap", 64, 64);
  const { result: croppedFile, delta: croppedDelta } = await outcomeDelta(() => upload(a, "cropped.avif", "image/avif", cropped));
  assert.equal(croppedFile.thumbnailPath, null);
  assert.ok(croppedDelta.crashed === 1 || croppedDelta.failed === 1, JSON.stringify(croppedDelta));
  if (process.platform === "linux") {
    assert.equal(thumbnailWorkers.stats.mechanism, "ulimit");
    assert.ok(thumbnailWorkers.stats.crashed > before.crashed, "the zTXt bomb ended a worker");
    assert.notDeepEqual(pids(), before.pids, "a crashed worker was replaced");
  }
  // The server never held that memory, and another workspace's upload is thumbnailed.
  assert.ok(process.memoryUsage().rss - before.rss < 128 * MiB);
  const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
  const { result: photo, delta } = await outcomeDelta(() => upload(b, "photo.jpg", "image/jpeg", jpeg));
  assert.ok(photo.thumbnailPath);
  assert.deepEqual(delta, { created: 1 });
});

test("bombs from one workspace at once leave the other workspace's thumbnail to be made", async () => {
  const [a, b] = workspaces;
  const notes = pngWithChunks(Array(10).fill(zTxtChunk("Comment", { size: 49_000_000 })));
  const files = await Promise.all([
    upload(a, "notes-1.png", "image/png", notes),
    upload(a, "notes-2.png", "image/png", notes),
    upload(b, "ordinary.png", "image/png", smallPng),
  ]);
  assert.deepEqual(files.map((file) => !!file.thumbnailPath), [false, false, true]);
  assert.ok((await upload(a, "after.png", "image/png", smallPng)).thumbnailPath);
});

test("a worker killed while idle is replaced before the next upload needs it", async () => {
  const [a] = workspaces;
  assert.ok((await upload(a, "before.png", "image/png", smallPng)).thumbnailPath);
  for (const pid of pids()) if (pid) process.kill(pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await upload(a, "after-kill.png", "image/png", smallPng)).thumbnailPath);
});
