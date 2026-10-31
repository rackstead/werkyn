import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { after, before, test } from "node:test";
import archiver from "archiver";
import { craftZip, crc32, DEFLATED } from "../fixtures/crafted-zip.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const baseEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-transport-integration-jwt-secret",
  COOKIE_SECRET: "backup-transport-integration-cookie-secret",
};
Object.assign(process.env, baseEnv);

const MiB = 1 << 20;
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-transport-"));
const storageDir = path.join(root, "storage");
const stagingDir = path.join(storageDir, ".tmp", "backup");
// The in-process server caps uploads at 8 MiB so the size limit is cheap to hit.
const MAX_FILE_SIZE = 8 * MiB;
process.env.STORAGE_DIR = storageDir;
process.env.MAX_FILE_SIZE = String(MAX_FILE_SIZE);

// Files a stopped process left in the staging area, and one that is not staged.
await mkdir(stagingDir, { recursive: true });
const leftovers = [`upload-${crypto.randomUUID()}.part`, `export-${crypto.randomUUID()}.part`];
for (const name of [...leftovers, "keep.txt"]) await writeFile(path.join(stagingDir, name), "left behind");

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { backupConcurrency, SERVER_BUSY_MESSAGE, WORKSPACE_BUSY_MESSAGE } = await import(
  "../../src/modules/backup/backup-concurrency.ts"
);

const suffix = crypto.randomUUID().slice(0, 8);
const ARCHIVE_INVALID = "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features";
let app, base, admin, token;
const workspaces = {};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const staged = async () => (await readdir(stagingDir)).filter((name) => name.endsWith(".part"));

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function backupJson(label, assetNames = []) {
  return Buffer.from(
    JSON.stringify({
      metadata: {
        version: "1.1",
        exportedAt: new Date().toISOString(),
        sourceWorkspace: { name: "Transport", slug: "transport" },
        userRefs: [],
      },
      projects: [],
      channels: [],
      wikiSpaces: [
        {
          space: { name: label },
          pages: [
            {
              _originalId: "page",
              title: label,
              position: 0,
              content: assetNames.map((url) => ({ type: "image", props: { url } })),
            },
          ],
        },
      ],
    }),
  );
}

const asset = Buffer.from("transport asset bytes");
const archiveFor = (label) =>
  craftZip([
    { name: "backup.json", content: backupJson(label, ["assets/a.png"]), method: DEFLATED },
    { name: "assets/a.png", content: asset },
  ]);

/** The multipart envelope around one uploaded file. */
function envelope(filename) {
  const boundary = `transport-${crypto.randomUUID()}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    head: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    tail: Buffer.from(`\r\n--${boundary}--\r\n`),
  };
}

/** Collect a response, resolving with its status, headers and parsed body. */
function collect(request) {
  return new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let body = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
  });
}

/** Requests a failed test may leave open; `after` drops them before closing. */
const openRequests = new Set();
function track(request) {
  openRequests.add(request);
  request.once("close", () => openRequests.delete(request));
  return request;
}

/**
 * Start an upload over TCP that sends the envelope and the first `sent` bytes
 * of `file`, then waits. `finish()` sends the rest; `abort()` drops the socket.
 */
function startUpload(workspaceId, action, file, { sent = file.length >> 1, filename = "backup.zip" } = {}) {
  const { contentType, head, tail } = envelope(filename);
  const request = track(http.request(`${base}/api/workspaces/${workspaceId}/backup/${action}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
      "content-length": head.length + file.length + tail.length,
    },
  }));
  const response = collect(request);
  response.catch(() => {});
  request.write(Buffer.concat([head, file.subarray(0, sent)]));
  return {
    response,
    finish() {
      request.end(Buffer.concat([file.subarray(sent), tail]));
      return response;
    },
    abort() {
      request.destroy();
    },
  };
}

function post(workspaceId, action, body) {
  const request = http.request(`${base}/api/workspaces/${workspaceId}/backup/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const response = collect(request);
  request.end(JSON.stringify(body));
  return response;
}

const spaceNamed = (workspaceId, name) =>
  app.prisma.wikiSpace.count({ where: { workspaceId, name } });

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  admin = await app.prisma.user.create({
    data: {
      email: `backup-transport-${suffix}@example.test`,
      displayName: "Transport admin",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: admin.id, email: admin.email });
  for (const key of ["a", "b", "c", "d"]) {
    workspaces[key] = await app.prisma.workspace.create({
      data: {
        name: `Transport ${key}`,
        slug: `transport-${key}-${suffix}`,
        members: { create: { userId: admin.id, role: "ADMIN" } },
      },
    });
  }
  workspaces.dProject = await app.prisma.project.create({
    data: { workspaceId: workspaces.d.id, name: "Exported" },
  });
});

after(async () => {
  for (const request of openRequests) request.destroy();
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: ["a", "b", "c", "d"].map((k) => workspaces[k]?.id).filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({ where: { id: admin?.id } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup removes staged files a stopped process left behind", async () => {
  const names = await readdir(stagingDir);
  for (const name of leftovers) assert.ok(!names.includes(name), name);
  assert.ok(names.includes("keep.txt"));
  assert.deepEqual(await staged(), []);
});

test("requests over the limits get 429 or 503 with Retry-After, and every path frees its admission", { timeout: 60_000 }, async () => {
  const { a, b, c, d, dProject } = workspaces;
  const exportD = () => post(d.id, "export", { projects: [{ projectId: dProject.id }] });

  // Workspace A's preview is admitted and stalls halfway through its upload.
  const stalledA = startUpload(a.id, "preview", archiveFor(`Transport A ${suffix}`));
  await waitFor(async () => (await staged()).length === 1, "A to stage");
  assert.equal(backupConcurrency.usage.admitted, 1);

  // A second request for the same workspace is refused at once, whatever it is.
  for (const busy of [
    await post(a.id, "export", { projects: [{ projectId: dProject.id }] }),
    await startUpload(a.id, "restore", archiveFor("never")).finish(),
  ]) {
    assert.equal(busy.status, 429, JSON.stringify(busy.body));
    assert.equal(busy.headers["retry-after"], "30");
    assert.equal(busy.body.message, WORKSPACE_BUSY_MESSAGE);
  }

  // B and C fill the process: B with a valid archive, C with a broken one.
  const broken = craftZip([
    { name: "backup.json", content: backupJson(`Transport C ${suffix}`, ["assets/a.png"]) },
    { name: "assets/a.png", content: asset, crc: crc32(asset) ^ 1 },
  ]);
  const stalledB = startUpload(b.id, "restore", archiveFor(`Transport B ${suffix}`));
  const stalledC = startUpload(c.id, "restore", broken);
  await waitFor(async () => (await staged()).length === 3, "B and C to stage");
  assert.equal(backupConcurrency.usage.admitted, 3);

  const full = await exportD();
  assert.equal(full.status, 503, JSON.stringify(full.body));
  assert.equal(full.headers["retry-after"], "30");
  assert.equal(full.body.message, SERVER_BUSY_MESSAGE);

  // Client abort: A's staged file is removed and its admission freed.
  stalledA.abort();
  await waitFor(() => backupConcurrency.usage.admitted === 2, "A to be released");
  await waitFor(async () => (await staged()).length === 2, "A's staged file to go");
  await assert.rejects(stalledA.response);

  // Success: D can now export.
  const exported = await exportD();
  assert.equal(exported.status, 200);
  assert.equal(exported.headers["content-type"], "application/zip");
  assert.equal(backupConcurrency.usage.admitted, 2);

  // Success: B restores; error: C's checksum fails before any write.
  const restoredB = await stalledB.finish();
  assert.equal(restoredB.status, 200, JSON.stringify(restoredB.body));
  assert.equal(restoredB.body.data.images, 1);
  const failedC = await stalledC.finish();
  assert.equal(failedC.status, 400);
  assert.equal(failedC.body.message, ARCHIVE_INVALID);

  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
  assert.deepEqual(await staged(), []);
  assert.equal(await spaceNamed(a.id, `Transport A ${suffix}`), 0);
  assert.equal(await spaceNamed(b.id, `Transport B ${suffix}`), 1);
  assert.equal(await spaceNamed(c.id, `Transport C ${suffix}`), 0);
  const [space] = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: b.id, name: `Transport B ${suffix}` },
    include: { pages: true },
  });
  const url = space.pages[0].content[0].props.url;
  const bytes = await readFile(path.join(storageDir, url.slice("/storage/".length)));
  assert.equal(sha256(bytes), sha256(asset));
});

test("processing takes turns, and a request whose client left never starts", { timeout: 60_000 }, async () => {
  const { a, b } = workspaces;
  let open;
  const held = backupConcurrency.exclusive(() => new Promise((resolve) => (open = resolve)));

  // A's restore is staged but must wait for the exclusive section.
  const labelA = `Turns A ${suffix}`;
  const uploadA = startUpload(a.id, "restore", archiveFor(labelA));
  uploadA.finish();
  // B's restore is staged too, then its client goes away while it waits.
  const labelB = `Turns B ${suffix}`;
  const uploadB = startUpload(b.id, "restore", archiveFor(labelB));
  uploadB.finish().catch(() => {});
  await waitFor(async () => (await staged()).length === 2, "both uploads to stage");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await spaceNamed(a.id, labelA), 0, "A waits for its turn");
  uploadB.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(backupConcurrency.usage.admitted, 2, "B holds its admission while it waits");

  open();
  await held;
  const restoredA = await uploadA.response;
  assert.equal(restoredA.status, 200, JSON.stringify(restoredA.body));
  await waitFor(() => backupConcurrency.usage.admitted === 0, "both admissions to be released");
  assert.equal(await spaceNamed(a.id, labelA), 1);
  assert.equal(await spaceNamed(b.id, labelB), 0, "B never ran");
  assert.deepEqual(await staged(), []);
});

test("an export downloads outside the exclusive section but keeps its admission", { timeout: 60_000 }, async () => {
  const { a, d } = workspaces;
  // An incompressible image larger than the loopback socket buffers, so the
  // response cannot finish while the client is not reading.
  const image = crypto.randomBytes(32 * MiB);
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: d.id, name: `Export ${suffix}`, slug: `export-${suffix}` },
  });
  const stored = await app.storage.save(`${d.id}/uploads/wiki`, space.id, crypto.randomUUID(), ".bin", image);
  await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Export page",
      createdById: admin.id,
      content: [{ type: "image", props: { url: `/storage/${stored}` } }],
    },
  });

  const request = track(
    http.request(`${base}/api/workspaces/${d.id}/backup/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
  );
  const received = [];
  let downloadResponse;
  const download = new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (response) => {
      downloadResponse = response;
      // Read nothing until told to.
      response.pause();
      response.on("data", (chunk) => received.push(chunk));
      response.on("end", () => resolve(response));
    });
  });
  request.end(JSON.stringify({ projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }] }));
  await waitFor(() => downloadResponse !== undefined, "the export to start its response", 20_000);

  // The archive was opened and its name removed before the download began.
  assert.deepEqual(await staged(), []);
  assert.equal(backupConcurrency.usage.exclusiveRunning, 0);

  // While the export's client reads nothing, a preview in another workspace
  // is processed, and the export still holds its own workspace's admission.
  const label = `After export ${suffix}`;
  const previewed = await startUpload(a.id, "preview", archiveFor(label)).finish();
  assert.equal(previewed.status, 200, JSON.stringify(previewed.body));
  assert.deepEqual(backupConcurrency.usage, { admitted: 1, workspaces: 1, exclusiveRunning: 0 });
  const busy = await post(d.id, "export", { wikiSpaces: [{ spaceId: space.id }] });
  assert.equal(busy.status, 429);

  // Once the client reads, the download completes byte for byte.
  downloadResponse.resume();
  const finished = await download;
  assert.equal(finished.statusCode, 200);
  const zip = Buffer.concat(received);
  assert.equal(zip.length, Number(finished.headers["content-length"]));
  const { readBackupArchive } = await import("../../src/modules/backup/backup-archive.ts");
  const contents = await readBackupArchive(zip);
  const [exported] = [...contents.assets.values()];
  assert.equal(sha256(await exported.read()), sha256(image));
  await waitFor(() => backupConcurrency.usage.admitted === 0, "the export's admission to be released");
  assert.deepEqual(await staged(), []);
});

test("an export whose client leaves mid-download frees its admission and leaves nothing", { timeout: 60_000 }, async () => {
  const { d } = workspaces;
  const [space] = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: d.id, name: `Export ${suffix}` },
  });
  const request = track(
    http.request(`${base}/api/workspaces/${d.id}/backup/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
  );
  const response = new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", resolve);
  });
  request.end(JSON.stringify({ wikiSpaces: [{ spaceId: space.id }] }));
  const download = await response;
  download.pause();
  assert.equal(backupConcurrency.usage.admitted, 1);
  request.destroy();
  await waitFor(() => backupConcurrency.usage.admitted === 0, "the admission to be released");
  assert.deepEqual(await staged(), []);
});

test("an export's admission is released before its last byte reaches the client", { timeout: 60_000 }, async () => {
  const { d, dProject } = workspaces;
  // Hold back every read that finds the end of a file, as a busy disk or
  // thread pool can. The archive's last byte then reaches the client well
  // before its read stream ends or closes.
  const probe = await open(path.join(root, "probe"), "w");
  const fileHandle = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandle.read;
  fileHandle.read = async function (...args) {
    const result = await read.apply(this, args);
    if (result.bytesRead === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    return result;
  };
  try {
    const request = track(
      http.request(`${base}/api/workspaces/${d.id}/backup/export`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
    );
    let admittedAtLastByte;
    const finished = new Promise((resolve, reject) => {
      request.on("error", reject);
      request.on("response", (response) => {
        const expected = Number(response.headers["content-length"]);
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          // Read at once, in the same callback that delivers the last byte.
          if (received === expected) admittedAtLastByte = backupConcurrency.usage.admitted;
        });
        response.on("error", reject);
        response.on("end", () => resolve(response.statusCode));
      });
    });
    request.end(JSON.stringify({ projects: [{ projectId: dProject.id }] }));
    assert.equal(await finished, 200);
    assert.equal(admittedAtLastByte, 0, "the admission was still held when the client had the whole file");
  } finally {
    fileHandle.read = read;
  }
  await waitFor(() => backupConcurrency.usage.admitted === 0, "the export's admission to be released");
});

test("an upload over the size limit gets a 413 and leaves nothing staged", { timeout: 60_000 }, async () => {
  const { a } = workspaces;
  const big = Buffer.alloc(MAX_FILE_SIZE + 1, 1);
  const response = await startUpload(a.id, "preview", big, { sent: 0 }).finish();
  assert.equal(response.status, 413, JSON.stringify(response.body));
  assert.equal(response.body.message, `Backup files are limited to ${MAX_FILE_SIZE} bytes`);
  assert.deepEqual(await staged(), []);
  assert.equal(backupConcurrency.usage.admitted, 0);

  // A legacy JSON file and an unsupported name still behave as before.
  const legacy = await startUpload(a.id, "preview", backupJson(`Legacy ${suffix}`), {
    filename: "backup.json",
  }).finish();
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.data.wikiSpaces, 1);
  const named = await startUpload(a.id, "preview", archiveFor("x"), { filename: "backup.tar" }).finish();
  assert.equal(named.status, 400);
  assert.equal(named.body.message, "Only .json and .zip files are accepted");
  assert.deepEqual(await staged(), []);
});

/** A stream of `size` random (incompressible) bytes, and its digest. */
function noise(size) {
  const hash = crypto.createHash("sha256");
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= size) return this.push(null);
      const block = crypto.randomBytes(Math.min(MiB, size - sent));
      sent += block.length;
      hash.update(block);
      this.push(block);
    },
  });
  return { stream, digest: () => hash.digest("hex") };
}

test("a large upload is staged and restored without holding it in memory", { timeout: 300_000 }, async (t) => {
  const workspace = workspaces.c;
  const assetSize = 64 * MiB;
  const names = ["one.bin", "two.bin", "three.bin"].map((name) => `assets/${name}`);
  const label = `Large ${suffix}`;
  const zipFile = path.join(root, "large.zip");
  const archive = archiver("zip", { zlib: { level: 1 } });
  const written = pipeline(archive, createWriteStream(zipFile));
  archive.append(backupJson(label, names), { name: "backup.json" });
  // archiver reads one entry's stream at a time, so the streams wait their turn.
  const sources = names.map((name) => [name, noise(assetSize)]);
  for (const [name, { stream }] of sources) archive.append(stream, { name });
  await archive.finalize();
  await written;
  const digests = Object.fromEntries(sources.map(([name, { digest }]) => [name, digest()]));
  const zipBytes = (await stat(zipFile)).size;
  assert.ok(zipBytes > 3 * assetSize, `${zipBytes}`);

  // A fresh server process with the default upload limit and a 256 MiB heap.
  const childStaging = path.join(root, "child-storage");
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=256", "--import", "tsx", "tests/integration/support/backup-server-child.mjs"],
    {
      cwd: new URL("../..", import.meta.url),
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...baseEnv, STORAGE_DIR: childStaging },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const nextJson = async () => {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error("server child exited");
      if (value.startsWith("{")) return JSON.parse(value);
    }
  };
  const ask = async () => {
    child.stdin.write("rss\n");
    return (await nextJson()).maxRssMiB;
  };
  try {
    const { port } = await nextJson();
    const upload = async (action) => {
      const { contentType, head, tail } = envelope("large.zip");
      const request = http.request(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/backup/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": contentType,
          "content-length": head.length + zipBytes + tail.length,
        },
      });
      const response = collect(request);
      let answered = false;
      response.then(() => (answered = true), () => (answered = true));
      request.write(head);
      // Stop sending if the server answers early, which it does on a refusal.
      for await (const chunk of createReadStream(zipFile)) {
        if (answered) break;
        if (!request.write(chunk)) await Promise.race([once(request, "drain"), response]);
      }
      request.end(tail);
      return response;
    };
    const idle = await ask();
    const preview = await upload("preview");
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.images, 3);
    const afterPreview = await ask();
    // Sent the moment the preview's response arrives: the preview's admission
    // and staged file are gone by then.
    const restored = await upload("restore");
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.data.images, 3);
    const afterRestore = await ask();
    t.diagnostic(`archive ${(zipBytes / MiB).toFixed(1)} MiB; server peak RSS ${idle} MiB idle, ${afterPreview} after preview, ${afterRestore} after restore`);
    // Before staging, each upload was held whole, then copied, then inflated
    // in memory: several hundred MiB for this archive.
    assert.ok(afterRestore - idle < 128, `peak RSS grew ${afterRestore - idle} MiB`);

    // Every restored asset matches its source bytes.
    const [space] = await app.prisma.wikiSpace.findMany({
      where: { workspaceId: workspace.id, name: label },
      include: { pages: true },
    });
    const urls = space.pages[0].content.map((block) => block.props.url);
    assert.equal(urls.length, 3);
    for (const [index, name] of names.entries()) {
      const hash = crypto.createHash("sha256");
      for await (const chunk of createReadStream(path.join(childStaging, urls[index].slice("/storage/".length))))
        hash.update(chunk);
      assert.equal(hash.digest("hex"), digests[name], name);
    }
    assert.deepEqual(
      (await readdir(path.join(childStaging, ".tmp", "backup"))).filter((n) => n.endsWith(".part")),
      [],
    );

    // Export the restored space, images included, from the same process: the
    // archive is built on disk and streamed, never held in memory.
    const exported = await new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/backup/export`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      request.on("error", reject);
      request.on("response", (response) => {
        const out = path.join(root, "exported.zip");
        pipeline(response, createWriteStream(out)).then(
          () => resolve({ status: response.statusCode, headers: response.headers, file: out }),
          reject,
        );
      });
      request.end(JSON.stringify({ wikiSpaces: [{ spaceId: space.id }] }));
    });
    assert.equal(exported.status, 200);
    const exportedBytes = (await stat(exported.file)).size;
    assert.equal(Number(exported.headers["content-length"]), exportedBytes);
    assert.ok(exportedBytes > 3 * assetSize, `${exportedBytes}`);
    const afterExport = await ask();
    t.diagnostic(`export ${(exportedBytes / MiB).toFixed(1)} MiB; server peak RSS ${afterExport} MiB after export`);
    assert.ok(afterExport - afterRestore < 64, `export grew peak RSS by ${afterExport - afterRestore} MiB`);
    const { readBackupArchive } = await import("../../src/modules/backup/backup-archive.ts");
    const contents = await readBackupArchive(exported.file);
    const exportedDigests = [];
    for (const asset of contents.assets.values()) {
      const hash = crypto.createHash("sha256");
      for await (const chunk of asset.open()) hash.update(chunk);
      exportedDigests.push(hash.digest("hex"));
    }
    assert.deepEqual(exportedDigests.sort(), Object.values(digests).sort());
  } finally {
    child.stdin.end("quit\n");
    await new Promise((resolve) => child.once("close", resolve));
  }
});
