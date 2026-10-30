import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { after, test } from "node:test";

const {
  BACKUP_TRANSFER_LIMITS,
  BackupTransferStalledError,
  BackupUploadTooLargeError,
  UPLOAD_INTERRUPTED_MESSAGE,
  backupStagingDir,
  stageStream,
  sweepBackupStaging,
} = await import("../src/modules/backup/backup-staging.ts");
const { BACKUP_ARCHIVE_LIMITS } = await import("../src/modules/backup/backup-archive.ts");

const MiB = 1 << 20;
const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-staging-"));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const freshDir = () => path.join(scratch, `staging-${++dirs}`);
const log = { warn() {}, error() {} };

/** A stream of `total` pseudo-random bytes in 1 MiB chunks, and its digest. */
function generated(total) {
  const hash = crypto.createHash("sha256");
  const block = crypto.randomBytes(MiB);
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= total) return this.push(null);
      const chunk = block.subarray(0, Math.min(MiB, total - sent));
      sent += chunk.length;
      hash.update(chunk);
      this.push(chunk);
    },
  });
  return { stream, digest: () => hash.digest("hex") };
}

test("the documented transfer limits", () => {
  assert.deepEqual({ ...BACKUP_TRANSFER_LIMITS }, {
    maxUploadBytes: BACKUP_ARCHIVE_LIMITS.maxTotalBytes + 64 * MiB,
    idleTimeoutMs: 60_000,
  });
  assert.ok(Object.isFrozen(BACKUP_TRANSFER_LIMITS));
  assert.equal(backupStagingDir("/srv/storage/"), path.join("/srv/storage", ".tmp", "backup"));
});

test("a staged upload is written to a private file without being held in memory", async () => {
  const dir = freshDir();
  const total = 256 * MiB;
  const { stream, digest } = generated(total);
  globalThis.gc?.();
  const before = process.memoryUsage();
  let peakExternal = 0;
  const sampler = setInterval(() => {
    const { external, arrayBuffers } = process.memoryUsage();
    peakExternal = Math.max(peakExternal, external + arrayBuffers);
  }, 5);
  const staged = await stageStream(stream, { dir, maxBytes: total, idleTimeoutMs: 5_000 });
  clearInterval(sampler);
  assert.equal(staged.size, total);
  assert.equal(path.dirname(staged.path), dir);
  assert.match(path.basename(staged.path), /^upload-[0-9a-f-]{36}\.part$/);
  const info = await stat(staged.path);
  assert.equal(info.size, total);
  assert.equal(info.mode & 0o777, 0o600);
  const hash = crypto.createHash("sha256");
  for await (const chunk of (await import("node:fs")).createReadStream(staged.path)) hash.update(chunk);
  assert.equal(hash.digest("hex"), digest());
  // Buffered bytes stay within a few stream buffers, far below the upload.
  const growth = peakExternal - (before.external + before.arrayBuffers);
  assert.ok(growth < 64 * MiB, `${Math.round(growth / MiB)} MiB buffered`);

  await staged.dispose();
  await staged.dispose();
  assert.deepEqual(await readdir(dir), []);
});

test("an upload over the limit is refused with a 413 and leaves no file", async () => {
  const dir = freshDir();
  const { stream } = generated(3 * MiB + 1);
  await assert.rejects(
    stageStream(stream, { dir, maxBytes: 3 * MiB, idleTimeoutMs: 5_000 }),
    (error) => {
      assert.ok(error instanceof BackupUploadTooLargeError);
      assert.equal(error.statusCode, 413);
      return true;
    },
  );
  assert.deepEqual(await readdir(dir), []);
  // Exactly at the limit is accepted.
  const exact = await stageStream(generated(3 * MiB).stream, { dir, maxBytes: 3 * MiB, idleTimeoutMs: 5_000 });
  assert.equal(exact.size, 3 * MiB);
  await exact.dispose();
});

test("a stalled upload is abandoned with a 408 and leaves no file", async () => {
  const dir = freshDir();
  const source = new PassThrough();
  source.write(Buffer.alloc(1024));
  const started = Date.now();
  await assert.rejects(
    stageStream(source, { dir, maxBytes: MiB, idleTimeoutMs: 200 }),
    (error) => {
      assert.ok(error instanceof BackupTransferStalledError);
      assert.equal(error.statusCode, 408);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 150);
  assert.ok(source.destroyed, "the source is released");
  assert.deepEqual(await readdir(dir), []);

  // Steady progress never trips the idle timer, however long it takes.
  const slow = new PassThrough();
  const pending = stageStream(slow, { dir, maxBytes: MiB, idleTimeoutMs: 200 });
  for (let i = 0; i < 6; i++) {
    slow.write(Buffer.alloc(10));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  slow.end();
  const staged = await pending;
  assert.equal(staged.size, 60);
  await staged.dispose();
});

test("an interrupted upload is a 400 and leaves no file", async () => {
  const dir = freshDir();
  const source = new PassThrough();
  const pending = stageStream(source, { dir, maxBytes: MiB, idleTimeoutMs: 5_000 });
  source.write(Buffer.alloc(4096));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // A client that disconnects ends the multipart stream without an error.
  source.destroy();
  await assert.rejects(pending, { statusCode: 400, message: UPLOAD_INTERRUPTED_MESSAGE });
  assert.deepEqual(await readdir(dir), []);

  // A malformed body fails the stream, possibly before staging has started.
  // @fastify/multipart listens for these errors itself, as here.
  const failing = new PassThrough();
  failing.on("error", () => {});
  const failed = stageStream(failing, { dir, maxBytes: MiB, idleTimeoutMs: 5_000 });
  failing.destroy(new Error("Part terminated early"));
  await assert.rejects(failed, { statusCode: 400, message: UPLOAD_INTERRUPTED_MESSAGE });
  assert.deepEqual(await readdir(dir), []);
});

test("startup sweeps staged files only", async () => {
  const dir = freshDir();
  assert.equal(await sweepBackupStaging(log, dir), 0, "a missing directory is fine");
  await mkdir(dir, { recursive: true });
  const staged = [
    `upload-${crypto.randomUUID()}.part`,
    `export-${crypto.randomUUID()}.part`,
  ];
  const other = ["notes.txt", `upload-${crypto.randomUUID()}.zip`, "upload-x.part"];
  for (const name of [...staged, ...other]) await writeFile(path.join(dir, name), "x");
  const warned = [];
  assert.equal(await sweepBackupStaging({ warn: (...args) => warned.push(args) }, dir), 2);
  assert.deepEqual((await readdir(dir)).sort(), [...other].sort());
  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0][0], { removed: 2 });
  assert.equal(await readFile(path.join(dir, "notes.txt"), "utf8"), "x");
});
