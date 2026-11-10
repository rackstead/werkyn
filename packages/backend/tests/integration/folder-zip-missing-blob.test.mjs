import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "folder-zip-missing-blob-jwt-secret",
  COOKIE_SECRET: "folder-zip-missing-blob-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-folder-zip-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const PRESENT = "R26-PRESENT-MARKER";
const MISSING = "R26-MISSING-MARKER";
let app;
let address;
let token;
let user;
let workspace;

function httpRequest(method, urlPath, { body } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const target = new URL(urlPath, address);
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = (error, status, headers) => {
      if (settled) return;
      settled = true;
      const bytes = Buffer.concat(chunks);
      resolve({
        status,
        headers: headers ?? {},
        bytes,
        error: error
          ? { name: error.name, code: error.code, message: error.message }
          : null,
        json() {
          return JSON.parse(bytes.toString());
        },
      });
    };
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {}),
        },
      },
      (res) => {
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", (error) => finish(error, res.statusCode, res.headers));
        res.on("aborted", () =>
          finish(
            Object.assign(new Error("response aborted"), { code: "ABORTED" }),
            res.statusCode,
            res.headers,
          ),
        );
        res.on("end", () => finish(null, res.statusCode, res.headers));
      },
    );
    req.setTimeout(8000, () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (error) => finish(error, null, {}));
    if (payload) req.end(payload);
    else req.end();
  });
}

function multipart(parentId, name, content) {
  const boundary = `zip-${crypto.randomUUID()}`;
  return {
    boundary,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      Buffer.from(content),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function upload(parentId, name, content) {
  const { boundary, payload } = multipart(parentId, name, content);
  const target = new URL(`/api/workspaces/${workspace.id}/files/upload`, address);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (res.statusCode !== 201) {
            reject(new Error(`upload ${name} ${res.statusCode} ${bytes.toString()}`));
            return;
          }
          resolve(JSON.parse(bytes.toString()).data);
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function assertGone(response) {
  assert.equal(response.error, null, JSON.stringify(response.error));
  assert.equal(response.status, 410, response.bytes.toString());
  assert.match(String(response.headers["content-type"]), /^application\/json/);
  assert.equal(response.headers["content-disposition"], undefined);
  assert.equal(response.json().statusCode, 410);
  assert.equal(response.json().error, "Gone");
  assert.equal(response.json().message, "File content is no longer available");
  assert.equal(response.bytes.subarray(0, 4).equals(Buffer.from("PK\x03\x04")), false);
  assert.equal(response.bytes.includes(Buffer.from(PRESENT)), false);
  assert.equal(response.bytes.includes(Buffer.from(MISSING)), false);
  if (response.headers["content-length"] !== undefined) {
    assert.equal(Number(response.headers["content-length"]), response.bytes.length);
  }
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 18);
  user = await app.prisma.user.create({
    data: {
      email: `zip-missing-${suffix}@example.test`,
      displayName: "Zip missing",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Zip missing",
      slug: `zip-missing-${suffix}`,
      members: { create: { userId: user.id, role: "MEMBER" } },
    },
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

after(async () => {
  try {
    if (app && workspace && user) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.blobCleanup.deleteMany({
        where: { storagePath: { startsWith: `${workspace.id}/` } },
      });
      await app.prisma.user.deleteMany({ where: { id: user.id } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a folder zip is 410 with no zip body when one blob is missing, and 200 when every blob is present", async () => {
  const folder = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/folder`, {
    body: { name: "pack" },
  });
  assert.equal(folder.status, 201, folder.bytes.toString());
  const folderId = folder.json().data.id;
  const empty = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/folder`, {
    body: { name: "empty" },
  });
  assert.equal(empty.status, 201, empty.bytes.toString());
  const present = await upload(folderId, "present.txt", PRESENT);
  const missing = await upload(folderId, "missing.txt", MISSING);

  const ready = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/archive`, {
    body: { fileIds: [folderId] },
  });
  assert.equal(ready.error, null, JSON.stringify(ready.error));
  assert.equal(ready.status, 200, ready.bytes.toString());
  assert.equal(ready.headers["content-type"], "application/zip");
  const readyZip = new AdmZip(ready.bytes);
  assert.equal(readyZip.readAsText("pack/present.txt"), PRESENT);
  assert.equal(readyZip.readAsText("pack/missing.txt"), MISSING);

  const emptyZip = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/archive`, {
    body: { fileIds: [empty.json().data.id] },
  });
  assert.equal(emptyZip.error, null, JSON.stringify(emptyZip.error));
  assert.equal(emptyZip.status, 200, emptyZip.bytes.toString());
  assert.equal(new AdmZip(emptyZip.bytes).getEntries().length, 0);

  const queuedBefore = await app.prisma.blobCleanup.count({
    where: { storagePath: { in: [present.storagePath, missing.storagePath] } },
  });
  await app.storage.delete(missing.storagePath);
  assert.equal(await app.storage.exists(present.storagePath), true);
  assert.equal(await app.storage.exists(missing.storagePath), false);

  const archived = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/archive`, {
    body: { fileIds: [folderId] },
  });
  assertGone(archived);
  const download = await httpRequest(
    "GET",
    `/api/workspaces/${workspace.id}/files/${missing.id}/download`,
  );
  assertGone(download);
  assert.equal(archived.json().message, download.json().message);

  const flat = await httpRequest("POST", `/api/workspaces/${workspace.id}/files/archive`, {
    body: { fileIds: [present.id, missing.id] },
  });
  assertGone(flat);

  const presentDownload = await httpRequest(
    "GET",
    `/api/workspaces/${workspace.id}/files/${present.id}/download`,
  );
  assert.equal(presentDownload.error, null);
  assert.equal(presentDownload.status, 200);
  assert.equal(presentDownload.bytes.toString(), PRESENT);

  assert.equal(
    await app.prisma.file.count({ where: { id: { in: [present.id, missing.id, folderId] } } }),
    3,
  );
  assert.equal(await app.storage.exists(present.storagePath), true);
  assert.equal(await app.storage.exists(missing.storagePath), false);
  assert.equal(
    await app.prisma.blobCleanup.count({
      where: { storagePath: { in: [present.storagePath, missing.storagePath] } },
    }),
    queuedBefore,
  );
  const live = await httpRequest("GET", "/api/live");
  assert.equal(live.error, null);
  assert.equal(live.status, 200);
});
