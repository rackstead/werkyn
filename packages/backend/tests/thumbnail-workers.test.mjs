import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { THUMBNAIL_LIMITS } from "../src/modules/files/thumbnail-checks.ts";
import { cappedThumbnailWorkerCount } from "../src/config/thumbnail-worker-count.ts";
import { ThumbnailWorkerPool } from "../src/modules/files/thumbnail-workers.ts";
import {
  avif100Megapixels,
  manyScanJpeg,
  pngWithChunks,
  restructuredAvif,
  zTxtChunk,
} from "./fixtures/thumbnail-inputs.mjs";
import { png as smallPng } from "./fixtures/passive-media.mjs";

// The decoder worker processes (thumbnail-workers.ts): their limit, and what
// happens when one crashes, hangs, is killed, or the server goes away.

const linux = process.platform === "linux";
const MiB = 1024 * 1024;
const scratch = mkdtempSync(path.join(os.tmpdir(), "werkyn-thumbnail-workers-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const stored = (bytes, name = `${++files}.bin`) => {
  const file = path.join(scratch, name);
  writeFileSync(file, bytes);
  return file;
};
const small = stored(smallPng, "small.png");
const pools = [];
const pool = (options) => {
  const created = new ThumbnailWorkerPool({ size: 1, dataLimitBytes: THUMBNAIL_LIMITS.workerDataBytes, ...options });
  pools.push(created);
  return created;
};
after(() => Promise.all(pools.map((p) => p.close())));

/** Whether `pid` is gone: no process and no unreaped zombie under it. */
function gone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === "ESRCH") return true;
    throw err;
  }
  return false;
}
const waitFor = async (condition, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/** A file with about 0.5 s of real decoding that passes every check. */
const slowJpeg = () => stored(manyScanJpeg(7000, 7000, 11, 2), "slow.jpg");

test("workers run under the data limit, as the OOM killer's first choice, without the server's secrets", { skip: !linux }, async () => {
  process.env.JWT_SECRET ??= "thumbnail-worker-test-secret";
  const workers = pool({ size: 2 });
  workers.start();
  await waitFor(() => workers.stats.workers.every((worker) => worker.state === "ready"));
  assert.equal((await workers.run(small)).ok, true);
  assert.equal(workers.stats.mechanism, "ulimit");
  assert.equal(workers.stats.dataLimitBytes, THUMBNAIL_LIMITS.workerDataBytes);
  assert.equal(workers.stats.workers.length, 2);
  for (const { pid } of workers.stats.workers) {
    const limits = readFileSync(`/proc/${pid}/limits`, "utf8").split("\n").find((line) => line.startsWith("Max data size"));
    assert.deepEqual(limits.split(/\s+/).slice(3, 5), [String(512 * MiB), String(512 * MiB)], "soft and hard");
    assert.equal(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim(), "1000");
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    assert.ok(environ.includes("UV_THREADPOOL_SIZE=1"));
    assert.ok(!environ.some((entry) => /^(JWT_SECRET|COOKIE_SECRET|DATABASE_URL)=/.test(entry)), "no server secrets");
  }
});

test("a decode bomb that gets past the checks fails or ends only its worker", async () => {
  // With the container checks and estimate off, the hard limit is all that
  // stands between these files and the memory they ask for.
  const workers = pool({ memoryChecks: false });
  assert.equal((await workers.run(small)).ok, true);
  const first = workers.stats.workers[0].pid;
  const rss = process.memoryUsage().rss;
  // 2 KiB, decoded at 10000 x 10000 (about 1.7 GiB): libheif's allocation fails.
  const cropped = await workers.run(stored(restructuredAvif(avif100Megapixels, "clap", 64, 64)));
  assert.equal(cropped.ok, false);
  assert.ok(["failed", "crashed"].includes(cropped.outcome), JSON.stringify(cropped));
  // 477 KB inflating to 490 MB of text in libpng: glib aborts the process.
  const notes = await workers.run(stored(pngWithChunks(Array(10).fill(zTxtChunk("Comment", { size: 49_000_000 })))));
  assert.equal(notes.ok, false);
  assert.ok(["failed", "crashed"].includes(notes.outcome), JSON.stringify(notes));
  if (linux) {
    assert.equal(notes.outcome, "crashed", JSON.stringify(notes));
    assert.equal(notes.details.signal, "SIGABRT");
    assert.ok(gone(first), "the crashed worker is reaped");
  }
  // This process never held the memory, and a new worker serves the next file.
  assert.ok(process.memoryUsage().rss - rss < 64 * MiB);
  assert.equal((await workers.run(small)).ok, true);
  assert.notEqual(workers.stats.workers[0].pid, first);
  assert.equal(workers.stats.workers[0].failures, 0, "a completed decode clears the failure count");
});

test("a worker killed while decoding is replaced, and the decode reports a crash", async () => {
  const workers = pool();
  assert.equal((await workers.run(small)).ok, true);
  const pid = workers.stats.workers[0].pid;
  const decoding = workers.run(slowJpeg());
  await waitFor(() => workers.stats.workers[0].state === "busy");
  process.kill(pid, "SIGKILL");
  const result = await decoding;
  assert.deepEqual([result.ok, result.outcome, result.details.signal], [false, "crashed", "SIGKILL"]);
  assert.match(result.details.reason, /killed by SIGKILL/);
  assert.equal(workers.stats.crashed, 1);
  assert.ok(gone(pid));
  assert.equal((await workers.run(small)).ok, true);
  assert.notEqual(workers.stats.workers[0].pid, pid);
});

test("a decode stopped at the deadline kills the worker and settles once it has exited", async () => {
  const workers = pool();
  assert.equal((await workers.run(small)).ok, true);
  const pid = workers.stats.workers[0].pid;
  const stop = new AbortController();
  const started = performance.now();
  const decoding = workers.run(slowJpeg(), stop.signal);
  setTimeout(() => stop.abort(), 50);
  const result = await decoding;
  assert.deepEqual([result.ok, result.outcome], [false, "timed-out"]);
  assert.ok(performance.now() - started < 400, "not left to finish its 0.5 s decode");
  assert.ok(gone(pid), "settled only after the worker exited");
  assert.equal(workers.stats.timedOut, 1);
  assert.equal(workers.stats.crashed, 0);
  assert.equal((await workers.run(small)).ok, true);
  // A signal that has already fired never reaches a worker.
  const aborted = AbortSignal.abort();
  assert.equal((await workers.run(small, aborted)).outcome, "timed-out");
  assert.equal(workers.stats.timedOut, 1);
});

test("decodes beyond the workers wait for a free one", async () => {
  const workers = pool({ size: 2 });
  const results = await Promise.all(Array.from({ length: 7 }, () => workers.run(small)));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results.map((r) => r.outcome)));
  assert.ok(workers.stats.spawned <= 2);
});

test("repeated start failures back off instead of restarting in a loop", async () => {
  const exits = stored("process.exit(3);\n", "exits.mjs");
  const workers = pool({ script: exits, execArgv: [], restartDelayMs: { initial: 100, max: 400 } });
  const first = await workers.run(small);
  assert.deepEqual([first.ok, first.outcome], [false, "failed"]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Immediately, then after 100, 200, 400, 400 ms...: about 6, not hundreds.
  const { spawned } = workers.stats;
  assert.ok(spawned >= 3 && spawned <= 9, `spawned ${spawned}`);
  assert.ok(workers.stats.workers[0].failures >= 3);
  // While it waits to restart, a decode is answered at once.
  const started = performance.now();
  const waiting = await workers.run(small);
  assert.equal(waiting.outcome, "failed");
  assert.ok(performance.now() - started < 1000);
});

test("a worker that never reports ready is killed after the start timeout", async () => {
  const hangs = stored("setInterval(() => {}, 1000);\n", "hangs.mjs");
  const workers = pool({ script: hangs, execArgv: [], startTimeoutMs: 300, restartDelayMs: { initial: 10_000, max: 10_000 } });
  workers.start();
  const pid = workers.stats.workers[0].pid;
  await waitFor(() => gone(pid), 3000);
  assert.ok(workers.stats.workers[0].failures >= 1);
});

test("close stops every worker, settles decodes in flight, and leaves no zombie", async () => {
  const workers = pool({ size: 2 });
  await Promise.all([workers.run(small), workers.run(small)]);
  const pids = workers.stats.workers.map((worker) => worker.pid);
  const decoding = workers.run(slowJpeg());
  await waitFor(() => workers.stats.workers.some((worker) => worker.state === "busy"));
  const started = performance.now();
  await workers.close();
  assert.ok(performance.now() - started < 2000);
  const result = await decoding;
  assert.deepEqual([result.ok, result.outcome], [false, "failed"]);
  assert.match(result.details.reason, /shut down/);
  for (const pid of pids) assert.ok(gone(pid), `worker ${pid} exited and was reaped`);
  assert.ok(workers.stats.workers.every((worker) => worker.pid === null && worker.state === "stopped"));
  assert.equal((await workers.run(small)).outcome, "failed");
  await workers.close(); // again: nothing left to stop
});

test("workers exit when the server process dies", { skip: !linux }, async () => {
  const pool = fileURLToPath(new URL("../src/modules/files/thumbnail-workers.ts", import.meta.url));
  const server = stored(`
    const { ThumbnailWorkerPool } = await import(${JSON.stringify(pool)});
    const workers = new ThumbnailWorkerPool({ size: 2, dataLimitBytes: ${THUMBNAIL_LIMITS.workerDataBytes} });
    await Promise.all([workers.run(${JSON.stringify(small)}), workers.run(${JSON.stringify(small)})]);
    console.log(JSON.stringify(workers.stats.workers.map((worker) => worker.pid)));
    setInterval(() => {}, 1000);
  `, "server.mjs");
  const child = spawn(process.execPath, ["--import", "tsx", server], { stdio: ["ignore", "pipe", "inherit"] });
  const pids = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n").find((l) => l.startsWith("["));
      if (line) resolve(JSON.parse(line));
    });
    child.on("exit", () => reject(new Error(`server exited early: ${out}`)));
  });
  assert.equal(pids.length, 2);
  child.kill("SIGKILL");
  // Orphaned workers see their channel close and exit; init reaps them.
  const exited = (pid) => !existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] === "Z";
  await waitFor(() => pids.every(exited), 5000);
});

/** A stand-in worker speaking the frame protocol at fd 3; `answer(id, path, send)` replies. */
const fakeWorker = (name, answer) => stored(`
  import net from "node:net";
  const channel = new net.Socket({ fd: 3, readable: true, writable: true });
  channel.on("end", () => process.exit(0));
  const frame = (header, body = Buffer.alloc(0)) => {
    const json = Buffer.from(JSON.stringify(header));
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(json.length, 0);
    lengths.writeUInt32BE(body.length, 4);
    return Buffer.concat([lengths, json, body]);
  };
  const send = (bytes) => channel.write(bytes);
  let pending = "";
  channel.on("data", (chunk) => {
    pending += chunk;
    for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (message.type === "ping") {
        send(frame({ type: "pong", id: message.id }));
        continue;
      }
      const { id, path } = message;
      (${answer})(id, path.split("/").pop(), send, frame);
    }
  });
  send(frame({ type: "ready", pid: process.pid, dataLimitBytes: null, oomScoreAdj: null }));
`, name);

test("a worker's answer is checked before the server uses it", async () => {
  // Stands in for a worker taken over through a decoder bug.
  const liar = fakeWorker("liar.mjs", `(id, name, send, frame) => {
    const memory = { dataBytes: 0, rssBytes: 0 };
    const answers = {
      html: [{ ok: true, details: {} }, Buffer.from("<html><script>alert(1)</script></html>")],
      odd: [{ ok: false, outcome: "owned", details: { reason: "x".repeat(10_000), stage: "elsewhere", format: "svg", width: "wide", extra: 1 } }],
      webp: [{ ok: true, details: { stage: "transform", format: "png", width: 1 } }, Buffer.from("RIFF\\x04\\0\\0\\0WEBPVP8 ")],
    };
    const [header, body] = answers[name];
    send(frame({ type: "result", id, memory, ...header }, body));
  }`);
  const workers = pool({ script: liar, execArgv: [] });
  const html = await workers.run(path.join(scratch, "html"));
  assert.deepEqual([html.ok, html.outcome], [false, "failed"]);
  assert.match(html.details.reason, /other than a WebP/);
  const odd = await workers.run(path.join(scratch, "odd"));
  assert.deepEqual(odd, { ok: false, outcome: "failed", details: { reason: "x".repeat(200) } });
  const webp = await workers.run(path.join(scratch, "webp"));
  assert.equal(webp.ok, true);
  assert.deepEqual(webp.details, { stage: "transform", format: "png", width: 1 });
  assert.equal(workers.stats.crashed, 0);
});

test("a worker that sends more than one bounded frame is killed before the server holds it", async () => {
  // Node's own IPC channel would parse a message of any size first; the
  // frame reader refuses one by its declared length.
  const flood = fakeWorker("flood.mjs", `(id, name, send, frame) => {
    if (name === "huge") {
      const lengths = Buffer.alloc(8);
      lengths.writeUInt32BE(64, 0);
      lengths.writeUInt32BE(1024 * 1024 * 1024, 4); // a 1 GiB "thumbnail"
      send(lengths);
      for (let i = 0; i < 64; i++) send(Buffer.alloc(1024 * 1024)); // and 64 MiB of it
    } else if (name === "header") {
      const lengths = Buffer.alloc(8);
      lengths.writeUInt32BE(32 * 1024 * 1024, 0);
      send(lengths);
    } else if (name === "garbage") {
      send(Buffer.concat([Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]), Buffer.from("nope")]));
    } else if (name === "twice") {
      const reply = frame({ type: "result", id, ok: false, outcome: "failed", details: {}, memory: {} });
      send(reply);
      setTimeout(() => send(reply), 20);
    }
  }`);
  const workers = pool({ script: flood, execArgv: [] });
  const rss = process.memoryUsage().rss;
  for (const [name, reason] of [["huge", /reply frame of 64 \+ 1073741824 bytes/], ["header", /reply frame of 33554432/], ["garbage", /not JSON/]]) {
    const result = await workers.run(path.join(scratch, name));
    assert.deepEqual([result.ok, result.outcome], [false, "crashed"], name);
    assert.match(result.details.reason, reason, name);
  }
  assert.ok(process.memoryUsage().rss - rss < 48 * MiB, "the server never buffered the flood");
  // An answer nobody asked for ends the worker too, and counts as a failure.
  assert.equal((await workers.run(path.join(scratch, "twice"))).outcome, "failed");
  const pid = workers.stats.workers[0].pid;
  await waitFor(() => gone(pid));
  assert.equal(workers.stats.workers[0].failures, 1);
});

test("crashes while decoding restart the worker at once, without a delay", async () => {
  // Backing them off would let one workspace's crashing uploads hold back
  // every workspace; thumbnails.ts backs off that workspace instead.
  const workers = pool({ memoryChecks: false, restartDelayMs: { initial: 10_000, max: 10_000 } });
  const notes = stored(pngWithChunks(Array(10).fill(zTxtChunk("Comment", { size: 49_000_000 }))), "notes.png");
  for (let i = 0; i < 3; i++) {
    const result = await workers.run(notes);
    assert.ok(["crashed", "failed"].includes(result.outcome), JSON.stringify(result));
    assert.equal(workers.stats.workers[0].failures, 0);
  }
  const started = performance.now();
  assert.equal((await workers.run(small)).ok, true);
  assert.ok(performance.now() - started < 5000);
});

test("without a way to set the limit, workers start without it and say so", { skip: !linux }, async () => {
  // A hard data limit below the requested one cannot be raised, so the
  // wrapper refuses to start; the pool then starts workers directly, and
  // they inherit the server's own limit.
  const pool = fileURLToPath(new URL("../src/modules/files/thumbnail-workers.ts", import.meta.url));
  const server = stored(`
    const { ThumbnailWorkerPool } = await import(${JSON.stringify(pool)});
    const workers = new ThumbnailWorkerPool({ size: 1, dataLimitBytes: ${THUMBNAIL_LIMITS.workerDataBytes} });
    const result = await workers.run(${JSON.stringify(small)});
    console.log(JSON.stringify({ ok: result.ok, ...workers.stats }));
    await workers.close();
  `, "limited-server.mjs");
  const output = await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", 'ulimit -d 409600 && exec "$@"', "sh", process.execPath, "--import", "tsx", server], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
  const lines = output.trim().split("\n");
  const stats = JSON.parse(lines.at(-1));
  assert.equal(stats.ok, true);
  assert.equal(stats.mechanism, null);
  assert.equal(stats.dataLimitBytes, 409600 * 1024, "the inherited limit");
  assert.ok(lines.some((line) => line.includes("Could not set the thumbnail worker memory limit")));
});

test("a worker that keeps memory after a decode is replaced", async () => {
  const workers = pool({ recycleAboveBytes: 1 });
  assert.equal((await workers.run(small)).ok, true);
  const pid = workers.stats.workers[0].pid;
  await waitFor(() => gone(pid));
  assert.equal(workers.stats.recycled, 1);
  assert.equal(workers.stats.workers[0].failures, 0, "retiring is not a failure");
  assert.equal((await workers.run(small)).ok, true);
  assert.notEqual(workers.stats.workers[0].pid, pid);
});

test("the switch that skips the memory checks works only under NODE_ENV=test", async () => {
  const thumbnails = fileURLToPath(new URL("../src/modules/files/thumbnails.ts", import.meta.url));
  const script = `const { thumbnailWorkers } = await import(${JSON.stringify(thumbnails)}); console.log(thumbnailWorkers.options.memoryChecks);`;
  const checks = (nodeEnv) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, NODE_ENV: nodeEnv, WERKYN_TEST_THUMBNAIL_MEMORY_CHECKS: "off", LOG_LEVEL: "error" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => (code === 0 ? resolve(out.trim().split("\n").at(-1)) : reject(new Error(`exit ${code}`))));
  });
  assert.equal(await checks("production"), "true");
  assert.equal(await checks("development"), "true");
  assert.equal(await checks("test"), "false");
});

test("a worker opens the stored file below its root and refuses a link anywhere below it (R33)", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const root = path.join(scratch, "storage-root");
  const outside = path.join(scratch, "outside");
  mkdirSync(path.join(root, "ws/files/u1"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, "ws/files/u1/own.png"), smallPng);
  writeFileSync(path.join(outside, "own.png"), smallPng);
  // A link as the file itself, and a link as the folder holding it.
  symlinkSync(path.join(outside, "own.png"), path.join(root, "ws/files/u1/link.png"));
  symlinkSync(outside, path.join(root, "ws/files/linked"));
  const workers = pool();
  const own = await workers.run({ root, path: "ws/files/u1/own.png" });
  assert.equal(own.ok, true, JSON.stringify(own));
  for (const file of ["ws/files/u1/link.png", "ws/files/linked/own.png"]) {
    const result = await workers.run({ root, path: file });
    assert.equal(result.ok, false, file);
    assert.equal(result.outcome, "failed", file);
    assert.equal(result.details.reason, "refused: symbolic link below the storage root", file);
  }
  // A path that leaves the root fails before anything is opened.
  const escaped = await workers.run({ root, path: "../outside/own.png" });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.outcome, "failed");
  assert.equal((await workers.run(small)).ok, true, "the worker still serves");
});

/** A fake worker that answers pings unless its pid is listed in `control`. */
function answeringWorker(name, control) {
  return stored(`
    import net from "node:net";
    import fs from "node:fs";
    const channel = new net.Socket({ fd: 3, readable: true, writable: true });
    channel.on("end", () => process.exit(0));
    const frame = (header, body = Buffer.alloc(0)) => {
      const json = Buffer.from(JSON.stringify(header));
      const lengths = Buffer.alloc(8);
      lengths.writeUInt32BE(json.length, 0);
      lengths.writeUInt32BE(body.length, 4);
      return Buffer.concat([lengths, json, body]);
    };
    const hung = () => {
      try { return fs.readFileSync(${JSON.stringify(control)}, "utf8").split("\\n").includes(String(process.pid)); }
      catch { return false; }
    };
    let pending = "";
    channel.on("data", (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (message.type === "ping") {
          if (!hung()) channel.write(frame({ type: "pong", id: message.id }));
          continue;
        }
        if (hung()) continue;
        channel.write(frame(
          { type: "result", id: message.id, ok: true, details: {}, memory: { dataBytes: 0, rssBytes: 0 } },
          Buffer.from("RIFF\\x04\\0\\0\\0WEBPVP8 "),
        ));
      }
    });
    channel.write(frame({ type: "ready", pid: process.pid, dataLimitBytes: null, oomScoreAdj: null }));
  `, name);
}

test("an idle worker that stops answering is replaced, and a healthy worker still thumbnails", async () => {
  const control = path.join(scratch, "hung-idle.txt");
  writeFileSync(control, "");
  const workers = pool({
    size: 2,
    script: answeringWorker("answering.mjs", control),
    execArgv: [],
    // Short enough that the hang is noticed with no job in flight, and a
    // later job does not wait out the 12s decode deadline. A long restart
    // delay would stick if a missed ping were counted as a start failure.
    pingIntervalMs: 80,
    pingTimeoutMs: 500,
    restartDelayMs: { initial: 30_000, max: 30_000 },
  });
  workers.start();
  await waitFor(() => workers.stats.workers.every((worker) => worker.state === "ready" && worker.pid));
  const [hungPid, healthyPid] = workers.stats.workers.map((worker) => worker.pid);
  writeFileSync(control, `${hungPid}\n`);
  await waitFor(() => gone(hungPid) && workers.stats.workers.some((worker) => worker.state === "ready" && worker.pid !== hungPid && worker.pid !== healthyPid), 5000);
  assert.ok(workers.stats.workers.some((worker) => worker.pid === healthyPid), "the healthy worker was not replaced");
  assert.equal(gone(healthyPid), false);
  const started = performance.now();
  const result = await workers.run(small);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(performance.now() - started < 3_000, "not the 12s decode deadline");
  assert.ok(workers.stats.workers.some((worker) => worker.pid === healthyPid));
  assert.equal(workers.stats.timedOut, 0);
  assert.equal(workers.stats.crashed, 0);
  assert.ok(workers.stats.hung >= 1);
});

test("a job sent while an idle worker is hung uses a healthy one inside the ping timeout", async () => {
  const control = path.join(scratch, "hung-job.txt");
  writeFileSync(control, "");
  const workers = pool({
    size: 2,
    script: answeringWorker("answering-job.mjs", control),
    execArgv: [],
    // No background probe during this test: only the job's own ping can notice.
    pingIntervalMs: 60_000,
    pingTimeoutMs: 400,
    restartDelayMs: { initial: 30_000, max: 30_000 },
  });
  workers.start();
  await waitFor(() => workers.stats.workers.every((worker) => worker.state === "ready" && worker.pid));
  const hungPid = workers.stats.workers[0].pid;
  const healthyPid = workers.stats.workers[1].pid;
  writeFileSync(control, `${hungPid}\n`);
  const started = performance.now();
  const result = await workers.run(small);
  const elapsed = performance.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(elapsed < 3_000, `waited ${Math.round(elapsed)}ms`);
  // The job moves on at the ping timeout; the hung process is reaped just after.
  await waitFor(() => gone(hungPid), 2000);
  assert.ok(workers.stats.hung >= 1, "the hung worker was replaced");
  assert.equal(gone(healthyPid), false);
  assert.ok(workers.stats.workers.some((worker) => worker.pid === healthyPid));
  const again = await workers.run(small);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.ok(workers.stats.workers.some((worker) => worker.pid === healthyPid), "the healthy worker's next job was not lost");
  assert.equal(workers.stats.timedOut, 0);
  assert.equal(workers.stats.crashed, 0);
});

test("a worker busy inside its deadline is not killed for missing a ping", async () => {
  const script = stored(`
    import net from "node:net";
    const channel = new net.Socket({ fd: 3, readable: true, writable: true });
    channel.on("end", () => process.exit(0));
    const frame = (header, body = Buffer.alloc(0)) => {
      const json = Buffer.from(JSON.stringify(header));
      const lengths = Buffer.alloc(8);
      lengths.writeUInt32BE(json.length, 0);
      lengths.writeUInt32BE(body.length, 4);
      return Buffer.concat([lengths, json, body]);
    };
    let busy = false;
    let pending = "";
    channel.on("data", (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (message.type === "ping") {
          if (!busy) channel.write(frame({ type: "pong", id: message.id }));
          continue;
        }
        busy = true;
        setTimeout(() => {
          channel.write(frame(
            { type: "result", id: message.id, ok: true, details: {}, memory: { dataBytes: 0, rssBytes: 0 } },
            Buffer.from("RIFF\\x04\\0\\0\\0WEBPVP8 "),
          ));
          busy = false;
        }, 900);
      }
    });
    channel.write(frame({ type: "ready", pid: process.pid, dataLimitBytes: null, oomScoreAdj: null }));
  `, "busy-worker.mjs");
  const workers = pool({
    size: 1,
    script,
    execArgv: [],
    pingIntervalMs: 40,
    pingTimeoutMs: 300,
  });
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), 3_000);
  const decoding = workers.run(small, stop.signal);
  await waitFor(() => workers.stats.workers[0].state === "busy");
  const pid = workers.stats.workers[0].pid;
  // Longer than the ping timeout, so a liveness check that ran during the
  // decode would already have killed this worker.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(workers.stats.workers[0].pid, pid);
  assert.equal(workers.stats.workers[0].state, "busy");
  const result = await decoding;
  clearTimeout(deadline);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(workers.stats.workers[0].pid, pid);
  assert.equal(workers.stats.hung, 0);
  assert.equal(workers.stats.timedOut, 0);
  assert.equal(workers.stats.crashed, 0);
  assert.equal((await workers.run(small)).ok, true);
});

test("unset THUMBNAIL_WORKERS keeps the CPU pool size and 1 starts one worker", async () => {
  const thumbnails = fileURLToPath(new URL("../src/modules/files/thumbnails.ts", import.meta.url));
  const script = `
    const { thumbnailWorkers, thumbnailAdmission, defaultAdmissionLimits } = await import(${JSON.stringify(thumbnails)});
    console.log(JSON.stringify({
      size: thumbnailWorkers.options.size,
      maxActive: thumbnailAdmission.limits.maxActive,
      expected: defaultAdmissionLimits().maxActive,
    }));
    await thumbnailWorkers.close();
  `;
  const run = (workers) => new Promise((resolve, reject) => {
    const env = { ...process.env, LOG_LEVEL: "error" };
    if (workers === undefined) delete env.THUMBNAIL_WORKERS;
    else env.THUMBNAIL_WORKERS = workers;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${err}\n${out}`));
      else resolve(JSON.parse(out.trim().split("\n").at(-1)));
    });
  });
  const unset = await run(undefined);
  assert.equal(unset.size, unset.expected);
  assert.equal(unset.maxActive, unset.expected);
  const blank = await run("");
  assert.equal(blank.size, blank.expected);
  const one = await run("1");
  assert.equal(one.size, 1);
  assert.equal(one.maxActive, one.expected, "admission is unchanged");
  const two = await run("2");
  assert.equal(two.size, cappedThumbnailWorkerCount(2, two.expected), "no worker admission will not use");
  assert.equal(two.maxActive, two.expected);
  assert.equal(cappedThumbnailWorkerCount(2, 1), 1);
  assert.equal(cappedThumbnailWorkerCount(1, 2), 1);
  assert.equal(cappedThumbnailWorkerCount(2, 2), 2);
});

test("a pong already buffered during a stall is not counted as a hung worker", async () => {
  const control = path.join(scratch, "stall-none.txt");
  writeFileSync(control, "");
  const workers = pool({
    size: 1,
    script: answeringWorker("stall-pong.mjs", control),
    execArgv: [],
    pingIntervalMs: 60_000,
    pingTimeoutMs: 30,
    // Hold the server across the ping timeout, after the ping is written,
    // so the worker's pong can sit unread until the loop resumes.
    afterPing() {
      const until = Date.now() + 80;
      while (Date.now() < until) {}
    },
  });
  workers.start();
  await waitFor(() => workers.stats.workers[0]?.state === "ready" && workers.stats.workers[0].pid);
  const pid = workers.stats.workers[0].pid;
  const result = await workers.run(small);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(workers.stats.workers[0].pid, pid, "the worker that answered was kept");
  assert.equal(workers.stats.hung, 0);
  assert.equal(workers.stats.crashed, 0);
});

test("a bad THUMBNAIL_WORKERS is rejected before a worker starts", async () => {
  const thumbnails = fileURLToPath(new URL("../src/modules/files/thumbnails.ts", import.meta.url));
  const script = `await import(${JSON.stringify(thumbnails)}); console.log("STARTED");`;
  for (const value of ["0", "-1", "1.5", "2.0", "3", "nope"]) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, LOG_LEVEL: "error", THUMBNAIL_WORKERS: value },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("exit", (code) => resolve({ code, out, err }));
    });
    assert.notEqual(result.code, 0, value);
    assert.match(`${result.out}\n${result.err}`, /THUMBNAIL_WORKERS must be a whole number from 1 to 2/, value);
    assert.equal(`${result.out}\n${result.err}`.includes("STARTED"), false, value);
    // Short values collide with stack frames; the distinctive ones must not be echoed.
    if (value.length > 2) assert.equal(`${result.out}\n${result.err}`.includes(value), false, value);
  }
});

test("operator docs state the thumbnail worker memory limit and the worker-count setting", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  for (const text of [readme, compose]) {
    assert.match(text, /about 1 GiB/);
    assert.match(text, /1 GiB container can still fill/);
    assert.match(text, /Docker kills the worker rather than the server/);
    assert.match(text, /memory\.oom\.group/);
    assert.match(text, /more than about 1\.25 GiB/);
    assert.match(text, /OOMKilled=true/);
    assert.match(text, /container keeps running/);
    assert.match(text, /THUMBNAIL_WORKERS/);
  }
});
