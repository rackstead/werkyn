import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";

// Peak resident memory of a server process while it receives large uploads
// (docs/remediation/p03a.md). Uploads are streamed to storage: neither a
// large Drive file, a large file declared as an image, nor several wiki
// uploads at once should be held in memory.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const baseEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "upload-memory-integration-jwt-secret",
  COOKIE_SECRET: "upload-memory-integration-cookie-secret",
};
Object.assign(process.env, baseEnv);
const MiB = 1 << 20;
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-upload-memory-"));
process.env.STORAGE_DIR = path.join(root, "parent-storage");

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomUUID().slice(0, 8);
let app, user, token, workspace, space;

before(async () => {
  app = await buildApp();
  user = await app.prisma.user.create({
    data: { email: `upload-memory-${suffix}@example.test`, displayName: "Memory", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: { name: "Upload memory", slug: `upload-memory-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Memory wiki", slug: `memory-${suffix}` },
  });
});

after(async () => {
  try {
    if (workspace) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.blobCleanup.deleteMany({ where: { storagePath: { startsWith: `${workspace.id}/` } } });
    }
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Upload `size` random bytes, generated as they are sent, and return the response and digest. */
function upload(port, url, fields, { size, filename, contentType }) {
  const boundary = `upload-memory-${crypto.randomUUID()}`;
  const head = Buffer.from(
    Object.entries(fields)
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const request = http.request(`http://127.0.0.1:${port}${url}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": head.length + size + tail.length,
    },
  });
  const response = new Promise((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
  const hash = crypto.createHash("sha256");
  const sent = (async () => {
    request.write(head);
    for (let offset = 0; offset < size; offset += MiB) {
      const block = crypto.randomBytes(Math.min(MiB, size - offset));
      hash.update(block);
      if (!request.write(block)) await once(request, "drain");
    }
    request.end(tail);
  })();
  return Promise.all([response, sent]).then(([result]) => ({ ...result, digest: hash.digest("hex") }));
}

async function digestOf(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Start a fresh server process with the default upload limit (10 GiB) and a
 * 256 MiB heap, run `scenario` against it and return how much its peak
 * resident memory grew. Each scenario gets its own process, so one peak
 * cannot hide the next.
 */
async function peakGrowth(childStorage, scenario) {
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=256", "--import", "tsx", "tests/integration/support/backup-server-child.mjs"],
    {
      cwd: new URL("../..", import.meta.url),
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...baseEnv, STORAGE_DIR: childStorage },
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
  const peakRss = async () => {
    child.stdin.write("rss\n");
    return (await nextJson()).maxRssMiB;
  };
  try {
    const { port } = await nextJson();
    const idle = await peakRss();
    await scenario(port);
    const peak = await peakRss();
    return { idle, peak, grew: peak - idle };
  } finally {
    child.stdin.end("quit\n");
    await new Promise((resolve) => child.once("close", resolve));
  }
}

test("large and concurrent uploads are streamed to storage, not held in memory", { timeout: 300_000 }, async (t) => {
  const childStorage = path.join(root, "child-storage");
  const driveUrl = `/api/workspaces/${workspace.id}/files/upload`;
  const size = 256 * MiB;
  const scenarios = {
    "drive 256 MiB application/octet-stream": async (port) => {
      const result = await upload(port, driveUrl, {}, { size, filename: "large.bin", contentType: "application/octet-stream" });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.size, size);
      assert.equal(await digestOf(path.join(childStorage, result.body.data.storagePath)), result.digest);
    },
    // Random bytes: sharp cannot decode them, so no thumbnail either way.
    "drive 256 MiB declared image/png": async (port) => {
      const result = await upload(port, driveUrl, {}, { size, filename: "large.png", contentType: "image/png" });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.data.size, size);
      assert.equal(result.body.data.thumbnailPath, null);
    },
    "4 concurrent wiki uploads of 24 MiB": async (port) => {
      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          upload(
            port,
            "/api/uploads",
            { workspaceId: workspace.id, purpose: "wiki", spaceId: space.id },
            { size: 24 * MiB, filename: `media-${n}.bin`, contentType: "application/octet-stream" },
          ),
        ),
      );
      for (const result of results) {
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const stored = path.join(childStorage, result.body.data.url.slice("/storage/".length));
        assert.equal(await digestOf(stored), result.digest);
      }
    },
  };
  const measured = [];
  for (const [label, scenario] of Object.entries(scenarios)) {
    const { idle, peak, grew } = await peakGrowth(childStorage, scenario);
    t.diagnostic(`${label}: peak RSS ${idle} -> ${peak} MiB (+${grew} MiB)`);
    measured.push([label, grew]);
  }
  for (const [label, grew] of measured) assert.ok(grew < 64, `${label}: peak RSS grew ${grew} MiB`);
  // Nothing but the stored uploads is left in the child's storage.
  const workspaceDir = path.join(childStorage, workspace.id);
  assert.equal((await readdir(path.join(workspaceDir, "files", user.id))).length, 2);
  assert.equal((await readdir(path.join(workspaceDir, "uploads", "wiki", space.id))).length, 4);
});
