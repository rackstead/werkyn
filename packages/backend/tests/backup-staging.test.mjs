import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough, Readable } from "node:stream";
import { after, test } from "node:test";

const {
  BACKUP_TRANSFER_LIMITS,
  BackupTransferStalledError,
  BackupUploadTooLargeError,
  UPLOAD_INTERRUPTED_MESSAGE,
  backupStagingDir,
  prepareBackupStaging,
  receiveBackupUpload,
  stageStream,
  stagingPath,
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

test("nothing is staged until leftovers have been swept, and a failed sweep is retried", async () => {
  const dir = freshDir();
  // A file where the folder should be: the startup sweep cannot list it.
  await writeFile(dir, "not a folder");
  await assert.rejects(prepareBackupStaging(dir, log), { code: "ENOTDIR" });
  await assert.rejects(stagingPath("upload", dir), { code: "ENOTDIR" });

  // Once the folder is readable, the next attempt sweeps it and then stages.
  await rm(dir);
  await mkdir(dir);
  const leftover = `upload-${crypto.randomUUID()}.part`;
  await writeFile(path.join(dir, leftover), "left behind");
  const fresh = await stagingPath("upload", dir);
  assert.equal(path.dirname(fresh), dir);
  assert.deepEqual(await readdir(dir), [], "the leftover was swept first");

  // After a successful sweep, files staged since are never swept again.
  await writeFile(fresh, "in use");
  await prepareBackupStaging(dir, log);
  await stagingPath("export", dir);
  assert.deepEqual(await readdir(dir), [path.basename(fresh)]);
});

test("a request that stalls before or during its file is dropped", async (t) => {
  const Fastify = (await import("fastify")).default;
  const multipart = (await import("@fastify/multipart")).default;
  const dir = freshDir();
  const outcomes = [];
  const app = Fastify();
  await app.register(multipart);
  app.post("/upload", async (request) => {
    try {
      const staged = await receiveBackupUpload(request, { dir, maxBytes: MiB, idleTimeoutMs: 200 });
      await staged.dispose();
      outcomes.push("staged");
      return { ok: true };
    } catch (error) {
      outcomes.push(error.constructor.name);
      throw error;
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  const boundary = "stall-boundary";
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`;

  /** Send the request head and `body`, keep the socket open, report when it closes. */
  async function stall(body) {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000\r\n\r\n${body}`,
    );
    const started = Date.now();
    await new Promise((resolve) => socket.once("close", resolve));
    return Date.now() - started;
  }

  for (const body of ["", `--${boundary}\r\nContent-Disp`, `${part}some bytes`]) {
    outcomes.length = 0;
    const elapsed = await stall(body);
    assert.ok(elapsed >= 150 && elapsed < 5_000, `${JSON.stringify(body)}: ${elapsed} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(outcomes, ["BackupTransferStalledError"], JSON.stringify(body));
  }
  assert.deepEqual(await readdir(dir).catch(() => []), []);

  // A slow request that keeps sending is not dropped.
  outcomes.length = 0;
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  const tail = `\r\n--${boundary}--\r\n`;
  const pieces = [`--${boundary}\r\n`, part.slice(boundary.length + 4), "abc", "def", tail];
  const length = pieces.join("").length;
  socket.write(
    `POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${length}\r\n\r\n`,
  );
  let response = "";
  socket.on("data", (chunk) => (response += chunk));
  for (const piece of pieces) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.write(piece);
  }
  await new Promise((resolve) => socket.once("close", resolve));
  assert.match(response, /^HTTP\/1\.1 200/);
  assert.deepEqual(outcomes, ["staged"]);
});
