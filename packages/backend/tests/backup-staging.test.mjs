import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough, Readable, Writable } from "node:stream";
import { after, test } from "node:test";

const {
  BACKUP_TRANSFER_LIMITS,
  BackupTransferStalledError,
  BackupUploadTooLargeError,
  BackupUploadTooSlowError,
  UPLOAD_INTERRUPTED_MESSAGE,
  backupStagingDir,
  onLastByte,
  prepareBackupStaging,
  receiveBackupUpload,
  stageStream,
  stagingPath,
  sweepBackupStaging,
  watchIdle,
  watchRate,
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
  // Named inside the opened staging folder (/proc/self/fd/<fd>/<name> on
  // Linux, R33): the file is in `dir`.
  assert.match(path.basename(staged.path), /^upload-[0-9a-f-]{36}\.part$/);
  assert.deepEqual(await readdir(dir), [path.basename(staged.path)]);
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
  // Named inside the opened staging folder (/proc/self/fd/<fd>/<name> on
  // Linux, R33), so it is a file in `dir` either way.
  assert.match(path.basename(fresh), /^upload-[0-9a-f-]{36}\.part$/);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Feed `watch` at `bytesPerSecond` from now until `ms` have passed, sending
 * whatever is due every 20 ms, so a late timer catches up instead of
 * lowering the rate. `pause` is an optional [from, to] in ms with nothing sent.
 */
async function feed(watch, bytesPerSecond, ms, pause) {
  const started = performance.now();
  let sent = 0;
  for (;;) {
    const elapsed = performance.now() - started;
    if (elapsed >= ms) return;
    const paused = pause ? Math.max(0, Math.min(elapsed, pause[1]) - pause[0]) : 0;
    const due = Math.floor((bytesPerSecond * (elapsed - paused)) / 1000);
    if (due > sent) {
      watch.add(due - sent);
      sent = due;
    }
    await sleep(20);
  }
}

test("an upload below the minimum rate is reported once, after the grace period", async () => {
  const rate = { bytesPerSecond: 1000, windowMs: 400, graceMs: 300 };
  // A trickle at a fifth of the rate.
  let reports = [];
  const started = Date.now();
  const slow = watchRate(rate, () => reports.push(Date.now() - started));
  await feed(slow, 200, 900);
  slow.stop();
  assert.equal(reports.length, 1, `${reports}`);
  assert.ok(reports[0] >= 300 && reports[0] < 600, `reported after ${reports[0]} ms`);

  // Nothing at all is reported at the end of the grace period too.
  reports = [];
  const silent = watchRate(rate, () => reports.push(Date.now() - started));
  const silentStart = Date.now() - started;
  await sleep(700);
  silent.stop();
  assert.equal(reports.length, 1);
  assert.ok(reports[0] - silentStart >= 300 && reports[0] - silentStart < 600, `${reports[0] - silentStart} ms`);

  // Stopped before the grace period ends: never reported.
  let late = false;
  const stopped = watchRate(rate, () => (late = true));
  await sleep(100);
  stopped.stop();
  stopped.stop();
  await sleep(500);
  assert.equal(late, false);
});

test("an upload at or above the minimum rate is never reported, pauses within the window included", async () => {
  const rate = { bytesPerSecond: 1000, windowMs: 1000, graceMs: 500 };
  // Just above the rate, for three windows.
  let reported = false;
  const steady = watchRate(rate, () => (reported = true));
  await feed(steady, 1300, 3000);
  steady.stop();
  assert.equal(reported, false, "a steady upload just above the rate was reported");

  // Three times the rate with a pause of half the window: no window falls
  // below the average.
  const jittery = watchRate(rate, () => (reported = true));
  await feed(jittery, 3000, 3000, [1000, 1500]);
  jittery.stop();
  assert.equal(reported, false, "a pause shorter than the window was reported");

  // Everything at once, then nothing: the window still holds the bytes
  // until it slides past them, about one window later.
  let reportedAt;
  const started = Date.now();
  const burst = watchRate(rate, () => (reportedAt = Date.now() - started));
  burst.add(100_000);
  await sleep(1_600);
  burst.stop();
  assert.ok(reportedAt >= 1_000 && reportedAt < 1_400, `reported after ${reportedAt} ms`);
});

test("time the server spends not reading is not held against the upload", async () => {
  const rate = { bytesPerSecond: 1000, windowMs: 400, graceMs: 200 };
  let reported = false;
  const watch = watchRate(rate, () => (reported = true));
  watch.add(100);
  // The server stops reading for longer than the grace period and the window.
  watch.pause();
  watch.pause();
  await sleep(1_000);
  assert.equal(reported, false, "a pause by the server was held against the client");
  watch.resume();
  watch.resume();
  // Reading again, above the rate.
  await feed(watch, 2000, 600);
  assert.equal(reported, false);
  // Silence while the server reads is still reported.
  await sleep(800);
  watch.stop();
  assert.equal(reported, true, "silence after the pause was not reported");
});

test("the shortfall is the reading time the bytes received do not cover at the minimum rate", async () => {
  const rate = { bytesPerSecond: 1000, windowMs: 400, graceMs: 60_000 };
  // Silence counts in full, inside the grace period too.
  const silent = watchRate(rate, () => {});
  await sleep(300);
  const before = silent.shortfallMs();
  assert.ok(before >= 290 && before < 600, `${before}`);
  // 100 bytes at 1,000 bytes a second cover 100 ms of it.
  silent.add(100);
  const after = silent.shortfallMs();
  assert.ok(after <= before - 90 && after >= before - 100, `${before} then ${after}`);
  // Measured up to stop(), not after it.
  silent.stop();
  const stopped = silent.shortfallMs();
  await sleep(100);
  assert.equal(silent.shortfallMs(), stopped);
  silent.stop();
  assert.equal(silent.shortfallMs(), stopped);

  // At or above the rate there is none (never less than none).
  const steady = watchRate(rate, () => {});
  await feed(steady, 1300, 500);
  steady.add(10_000);
  steady.stop();
  assert.equal(steady.shortfallMs(), 0);

  // Time the server is not reading is left out.
  const paused = watchRate(rate, () => {});
  paused.pause();
  await sleep(300);
  paused.resume();
  paused.stop();
  assert.ok(paused.shortfallMs() < 50, `${paused.shortfallMs()}`);
});

test("an aborted staging copy stops with the abort reason and leaves no file", async () => {
  const dir = freshDir();
  const source = new PassThrough();
  const controller = new AbortController();
  const pending = stageStream(source, { dir, maxBytes: MiB, idleTimeoutMs: 5_000, signal: controller.signal });
  source.write(Buffer.alloc(4096));
  await sleep(50);
  assert.equal((await readdir(dir)).length, 1, "the partial file exists while staging");
  const reason = new BackupUploadTooSlowError(1234);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.ok(source.destroyed, "the source is released");
  assert.deepEqual(await readdir(dir), []);

  // Aborted before the copy starts: no file is opened.
  const early = new AbortController();
  early.abort(new BackupUploadTooSlowError(1));
  await assert.rejects(
    stageStream(new PassThrough(), { dir, maxBytes: MiB, idleTimeoutMs: 5_000, signal: early.signal }),
    { statusCode: 408 },
  );
  assert.deepEqual(await readdir(dir), []);
});

test("a stop while the staged file is still being opened is thrown, never left unhandled", async (t) => {
  const fsp = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { CREATE_NO_FOLLOW } = await import("../src/services/storage-paths.ts");
  // Hold the open of the staged file (R33's no-follow create) while a test
  // step runs, after the file has been created.
  let duringOpen;
  const original = fsp.open;
  fsp.open = async function (file, flags, ...rest) {
    const handle = await original.call(this, file, flags, ...rest);
    if (flags === CREATE_NO_FOLLOW && /upload-[0-9a-f-]{36}\.part$/.test(String(file))) await duringOpen?.();
    return handle;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsp.open = original;
    syncBuiltinESMExports();
  });
  const dir = freshDir();

  // Aborted (too slow) during the open.
  const controller = new AbortController();
  const reason = new BackupUploadTooSlowError(1);
  duringOpen = async () => {
    controller.abort(reason);
    await sleep(20);
  };
  const aborted = new PassThrough();
  await assert.rejects(
    stageStream(aborted, { dir, maxBytes: MiB, idleTimeoutMs: 5_000, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.ok(aborted.destroyed, "the source is released");
  assert.deepEqual(await readdir(dir), []);

  // Idle for longer than the idle timeout during the open.
  duringOpen = () => sleep(100);
  const idle = new PassThrough();
  await assert.rejects(stageStream(idle, { dir, maxBytes: MiB, idleTimeoutMs: 20 }), (error) => {
    assert.ok(error instanceof BackupTransferStalledError);
    return true;
  });
  assert.ok(idle.destroyed, "the source is released");
  assert.deepEqual(await readdir(dir), []);
  // An error emitted with no listener would fail this test as uncaught.
  await sleep(50);
});

test("a request whose body arrives below the minimum rate gets a 408, before or during its file", async (t) => {
  const Fastify = (await import("fastify")).default;
  const multipart = (await import("@fastify/multipart")).default;
  const dir = freshDir();
  const outcomes = [];
  const app = Fastify();
  await app.register(multipart);
  const minRate = { bytesPerSecond: 2000, windowMs: 400, graceMs: 300 };
  app.post("/upload", async (request) => {
    try {
      const staged = await receiveBackupUpload(request, { dir, maxBytes: MiB, idleTimeoutMs: 5_000, minRate });
      await staged.dispose();
      outcomes.push(["staged", staged.size]);
      return { ok: true };
    } catch (error) {
      outcomes.push([error.constructor.name]);
      throw error;
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();
  const boundary = "rate-boundary";
  const part = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  /**
   * Send `prefix`, then `fileBytes` bytes of the file at `bytesPerSecond`
   * (whatever is due every 20 ms), then the closing boundary. Resolves with
   * the response's status line and when it arrived.
   */
  async function upload(prefix, fileBytes, bytesPerSecond) {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    const length = prefix.length + fileBytes + tail.length;
    socket.write(
      `POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${length}\r\n\r\n${prefix}`,
    );
    const started = Date.now();
    let response = "";
    let answeredAt;
    socket.on("data", (chunk) => {
      response += chunk;
      answeredAt ??= Date.now() - started;
    });
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.once("close", resolve));
    let sent = 0;
    while (sent < fileBytes && answeredAt === undefined && !socket.destroyed) {
      const due = Math.min(fileBytes, Math.floor(((Date.now() - started) * bytesPerSecond) / 1000));
      if (due > sent) {
        socket.write(Buffer.alloc(due - sent, 120));
        sent = due;
      }
      await sleep(20);
    }
    if (answeredAt === undefined && !socket.destroyed) socket.write(tail);
    await Promise.race([closed, sleep(5_000)]);
    socket.destroy();
    return { status: response.split("\r\n")[0], body: response, answeredAt };
  }

  // A file trickling at a tenth of the rate is refused; the client reads the 408.
  outcomes.length = 0;
  const trickle = await upload(part, 4000, 200);
  assert.match(trickle.status, /^HTTP\/1\.1 408/);
  assert.match(trickle.body, /at least 2000 bytes per second/);
  assert.ok(trickle.answeredAt >= 250 && trickle.answeredAt < 2_000, `${trickle.answeredAt} ms`);
  assert.deepEqual(outcomes, [["BackupUploadTooSlowError"]]);

  // So is a multipart preamble that trickles before the file starts.
  outcomes.length = 0;
  const preamble = await (async () => {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000\r\n\r\n`,
    );
    let response = "";
    socket.on("data", (chunk) => (response += chunk));
    socket.on("error", () => {});
    for (const char of part.slice(0, 20)) {
      if (response) break;
      socket.write(char);
      await sleep(50);
    }
    await Promise.race([new Promise((resolve) => socket.once("close", resolve)), sleep(2_000)]);
    socket.destroy();
    return response;
  })();
  assert.match(preamble, /^HTTP\/1\.1 408/);
  assert.deepEqual(outcomes, [["BackupUploadTooSlowError"]]);

  // A file arriving at 1.5 times the rate for several windows is staged.
  outcomes.length = 0;
  const steady = await upload(part, 4500, 3000);
  assert.match(steady.status, /^HTTP\/1\.1 200/);
  assert.deepEqual(outcomes, [["staged", 4500]]);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});

test("an upload is not refused as too slow while slow staging writes hold up its reading", async (t) => {
  const fs = await import("node:fs");
  const Fastify = (await import("fastify")).default;
  const multipart = (await import("@fastify/multipart")).default;
  const dir = freshDir();
  const outcomes = [];
  const app = Fastify();
  await app.register(multipart);
  // Staging takes the file at about 250 KiB/s, half the minimum rate below.
  const diskBytesPerMs = 256;
  const { _write, _writev } = fs.WriteStream.prototype;
  fs.WriteStream.prototype._write = function (data, encoding, callback) {
    setTimeout(() => _write.call(this, data, encoding, callback), data.length / diskBytesPerMs);
  };
  fs.WriteStream.prototype._writev = function (chunks, callback) {
    const size = chunks.reduce((sum, { chunk }) => sum + chunk.length, 0);
    setTimeout(() => _writev.call(this, chunks, callback), size / diskBytesPerMs);
  };
  t.after(() => {
    fs.WriteStream.prototype._write = _write;
    fs.WriteStream.prototype._writev = _writev;
  });
  app.post("/upload", async (request) => {
    try {
      const staged = await receiveBackupUpload(request, {
        dir,
        maxBytes: 2 * MiB,
        idleTimeoutMs: 5_000,
        minRate: { bytesPerSecond: 512 * 1024, windowMs: 500, graceMs: 300 },
      });
      await staged.dispose();
      outcomes.push(["staged", staged.size]);
      return { ok: true };
    } catch (error) {
      outcomes.push([error.constructor.name]);
      throw error;
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();

  // The client sends the whole file at once, far faster than the minimum,
  // and much more than the stream buffers between the request and the disk
  // hold, so the request stays incomplete while staging catches up.
  const boundary = "disk-boundary";
  const size = MiB;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.zip"\r\n\r\n`),
    Buffer.alloc(size, 120),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  let response = "";
  socket.on("data", (chunk) => (response += chunk));
  const started = Date.now();
  socket.write(
    `POST /upload HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
  await new Promise((resolve) => socket.once("close", resolve));
  const elapsed = Date.now() - started;
  t.diagnostic(`staged in ${elapsed} ms`);
  // Staging was slower than the minimum for several windows.
  assert.ok(elapsed > 2_000, `${elapsed} ms`);
  assert.match(response, /^HTTP\/1\.1 200/, JSON.stringify(outcomes));
  assert.deepEqual(outcomes, [["staged", size]]);
});

test("bytes sent while the server was busy are counted before a check refuses the upload", async (t) => {
  const { spawn } = await import("node:child_process");
  const Fastify = (await import("fastify")).default;
  const multipart = (await import("@fastify/multipart")).default;
  const dir = freshDir();
  const outcomes = [];
  const app = Fastify();
  await app.register(multipart);
  let blockedFor;
  app.post("/upload", async (request) => {
    const pending = receiveBackupUpload(request, {
      dir,
      maxBytes: MiB,
      idleTimeoutMs: 5_000,
      minRate: { bytesPerSecond: 2000, windowMs: 1000, graceMs: 500 },
    });
    // Synchronous work holds this process for longer than the window, while
    // the client's bytes wait in the socket. It runs in a socket read
    // callback (parsing another backup runs in an I/O callback too), so the
    // next turn of the event loop runs the overdue rate check before it
    // reads the waiting bytes.
    const started = Date.now();
    request.raw.on("data", () => {
      if (blockedFor !== undefined || Date.now() - started < 1_000) return;
      const from = Date.now();
      while (Date.now() - from < 1_500);
      blockedFor = Date.now() - from;
    });
    try {
      const staged = await pending;
      await staged.dispose();
      outcomes.push(["staged", staged.size]);
      return { ok: true };
    } catch (error) {
      outcomes.push([error.constructor.name]);
      throw error;
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const { port } = app.server.address();

  // The client runs in its own process, so it keeps sending, at twice the
  // minimum rate, while this process is blocked.
  const client = `
    const net = require("node:net");
    const boundary = "busy-boundary";
    const head = Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="b.zip"\\r\\n\\r\\n');
    const tail = Buffer.from('\\r\\n--' + boundary + '--\\r\\n');
    const file = Buffer.alloc(14000, 120);
    const socket = net.connect(${port}, "127.0.0.1", () => {
      socket.write("POST /upload HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\nContent-Type: multipart/form-data; boundary=" + boundary + "\\r\\nContent-Length: " + (head.length + file.length + tail.length) + "\\r\\n\\r\\n");
      socket.write(head);
      const start = Date.now();
      let sent = 0;
      const timer = setInterval(() => {
        const due = Math.min(file.length, Math.floor((Date.now() - start) * 4));
        if (due > sent) { socket.write(file.subarray(sent, due)); sent = due; }
        if (sent === file.length) { clearInterval(timer); socket.write(tail); }
      }, 20);
      let response = "";
      socket.on("data", (chunk) => (response += chunk));
      socket.on("close", () => { clearInterval(timer); process.stdout.write(response.split("\\r\\n")[0]); });
    });
  `;
  const child = spawn(process.execPath, ["-e", client], { stdio: ["ignore", "pipe", "inherit"] });
  let status = "";
  child.stdout.on("data", (chunk) => (status += chunk));
  await new Promise((resolve) => child.once("close", resolve));
  assert.ok(blockedFor >= 1_500, `blocked for ${blockedFor} ms`);
  assert.match(status, /^HTTP\/1\.1 200/, JSON.stringify(outcomes));
  assert.deepEqual(outcomes, [["staged", 14000]]);
});

test("a download that stops moving is dropped after exactly the idle timeout", async () => {
  const chunk = Buffer.alloc(64 * 1024);
  const source = () =>
    new Readable({
      read() {
        this.push(chunk);
      },
    });

  // A client that never reads: the response stops taking bytes at once.
  let idleAt;
  const started = Date.now();
  const stalled = watchIdle(source(), 200, () => (idleAt = Date.now() - started));
  stalled.pipe(new Writable({ highWaterMark: 1024, write() {} }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(idleAt >= 190 && idleAt < 400, `dropped after ${idleAt} ms`);
  stalled.destroy();

  // A slow client that keeps reading is never dropped, however long it takes.
  let dropped = false;
  const slow = watchIdle(source(), 200, () => (dropped = true));
  let received = 0;
  slow.pipe(
    new Writable({
      highWaterMark: 1024,
      write(data, _encoding, callback) {
        received += data.length;
        setTimeout(callback, 100);
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  slow.destroy();
  assert.equal(dropped, false);
  assert.ok(received >= 5 * chunk.length, `${received}`);

  // Closing the stream clears the timer.
  let late = false;
  const done = watchIdle(Readable.from([chunk], { objectMode: false }), 100, () => (late = true));
  done.resume();
  await new Promise((resolve) => done.once("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(late, false);
});

test("a download reports its last byte as it is handed on, not when the file read ends", async () => {
  const size = 3 * 64 * 1024 + 5;
  const bytes = crypto.randomBytes(size);
  // Like a file read stream whose read that finds the end of the file is slow.
  let offset = 0;
  const source = new Readable({
    read() {
      if (offset >= size) {
        setTimeout(() => this.push(null), 200);
        return;
      }
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      offset += chunk.length;
      this.push(chunk);
    },
  });
  let sentAt;
  let calls = 0;
  const counted = onLastByte(source, size, () => {
    calls++;
    sentAt = received;
  });
  let received = 0;
  let sentBeforeLastByte;
  const chunks = [];
  counted.on("data", (chunk) => {
    received += chunk.length;
    chunks.push(chunk);
    if (received === size) sentBeforeLastByte = sentAt !== undefined;
  });
  await new Promise((resolve) => counted.once("close", resolve));
  assert.equal(sentBeforeLastByte, true, "reported only after the consumer had every byte");
  assert.equal(calls, 1);
  assert.deepEqual(Buffer.concat(chunks), bytes);

  // A download abandoned before its last byte never reports it.
  let abandoned = false;
  const partial = onLastByte(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 30, () => (abandoned = true));
  partial.resume();
  await new Promise((resolve) => partial.once("close", resolve));
  assert.equal(abandoned, false);
});

test("staging refuses linked staging folders and keeps using the folder it checked (R33)", async () => {
  const { existsSync } = await import("node:fs");
  const { symlink, unlink, rename } = await import("node:fs/promises");
  const root = freshDir();
  const dir = path.join(root, ".tmp", "backup");
  const outside = path.join(scratch, `outside-${dirs}`);
  await mkdir(root, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, `upload-${crypto.randomUUID()}.part`), "outside");
  const before = (await readdir(outside)).sort();
  const stage = () => stageStream(Readable.from([Buffer.from("staged bytes")]), { dir, maxBytes: MiB, idleTimeoutMs: 5_000 });

  // A link as the staging folder's parent, or as the folder itself, is
  // refused: nothing is staged or swept through it.
  await symlink(outside, path.join(root, ".tmp"));
  await assert.rejects(prepareBackupStaging(dir, log), { code: "ESTORAGEREFUSED", statusCode: 403 });
  await assert.rejects(stage(), { code: "ESTORAGEREFUSED" });
  await unlink(path.join(root, ".tmp"));
  await mkdir(path.join(root, ".tmp"));
  await symlink(outside, dir);
  await assert.rejects(stage(), { code: "ESTORAGEREFUSED" });
  assert.deepEqual((await readdir(outside)).sort(), before, "nothing was written or swept outside");
  await unlink(dir);

  const first = await stage();
  assert.equal(await readFile(first.path, "utf8"), "staged bytes");
  if (existsSync("/proc/self/fd")) {
    // The checked folder is replaced by a link to the outside: staged files
    // are still created, read and removed inside the folder that was checked.
    const parked = path.join(root, "parked");
    await rename(dir, parked);
    await symlink(outside, dir);
    const second = await stage();
    assert.equal(await readFile(second.path, "utf8"), "staged bytes");
    assert.equal((await readdir(parked)).length, 2);
    await first.dispose();
    await second.dispose();
    assert.deepEqual(await readdir(parked), []);
    assert.deepEqual((await readdir(outside)).sort(), before, "the link was never followed");
  } else {
    await first.dispose();
  }
});
