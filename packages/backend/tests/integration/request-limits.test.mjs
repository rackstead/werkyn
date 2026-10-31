import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { craftZip, DEFLATED } from "../fixtures/crafted-zip.mjs";
import { openRawSocket } from "./support/raw-websocket.mjs";

// Header, request, idle and upload timeouts (docs/remediation/p03a.md), with
// short limits so each one can be crossed in a few seconds, and the oversize,
// stall and disconnect behaviour of the streamed upload routes.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "request-limits-integration-jwt-secret",
  COOKIE_SECRET: "request-limits-integration-cookie-secret",
});
const MiB = 1 << 20;
const MAX_FILE_SIZE = MiB;
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-request-limits-"));
process.env.STORAGE_DIR = storageDir;
process.env.MAX_FILE_SIZE = String(MAX_FILE_SIZE);

const LIMITS = {
  headersTimeoutMs: 800,
  requestTimeoutMs: 1500,
  socketIdleTimeoutMs: 1200,
  keepAliveTimeoutMs: 1000,
  connectionsCheckingIntervalMs: 100,
  uploadIdleTimeoutMs: 800,
};
// Scheduling slack on a busy host; every bound below is still far under the
// time an unprotected connection survives (forever).
const SLACK_MS = 1500;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { backupConcurrency } = await import("../../src/modules/backup/backup-concurrency.ts");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");

const suffix = crypto.randomUUID().slice(0, 8);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let app, port, base, user, token, workspace, space, bigFile, mediumFile;
const serverSockets = new Map();

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every stored file under `dir`, relative to the storage root. */
async function storedFiles(dir = storageDir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await storedFiles(full)));
    else found.push(path.relative(storageDir, full));
  }
  return found.sort();
}

/** What an upload must leave behind when it is refused: nothing new. */
async function snapshot() {
  return {
    files: await storedFiles(),
    rows: await app.prisma.file.count({ where: { workspaceId: workspace.id } }),
    queued: await app.prisma.blobCleanup.count({ where: { storagePath: { startsWith: `${workspace.id}/` } } }),
  };
}

/** A raw TCP client that records what it receives and when the server closes. */
function connect() {
  const socket = net.connect({ port, host: "127.0.0.1" });
  const chunks = [];
  const opened = Date.now();
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("error", () => {});
  const closed = new Promise((resolve) => socket.once("close", () => resolve(Date.now() - opened)));
  return { socket, received: () => Buffer.concat(chunks).toString("latin1"), closed };
}

async function closedWithin(client, ms, label) {
  const elapsed = await Promise.race([
    client.closed,
    new Promise((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
  client.socket.destroy();
  assert.ok(elapsed !== undefined, `${label}: the server kept the connection open for ${ms} ms`);
  return elapsed;
}

/** Parse the status line and JSON body of a raw HTTP response. */
function parseResponse(text) {
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
  const body = text.slice(text.indexOf("\r\n\r\n") + 4);
  let json;
  try {
    json = JSON.parse(body);
  } catch {}
  return { status, json };
}

function multipart(fields, filename, contentType = "application/octet-stream") {
  const boundary = `request-limits-${crypto.randomUUID()}`;
  const head = Buffer.from(
    Object.entries(fields)
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  return { contentType: `multipart/form-data; boundary=${boundary}`, head, tail: Buffer.from(`\r\n--${boundary}--\r\n`) };
}

const drive = { url: () => `/api/workspaces/${workspace.id}/files/upload`, fields: () => ({}) };
const wiki = {
  url: () => "/api/uploads",
  fields: () => ({ workspaceId: workspace.id, purpose: "wiki", spaceId: space.id }),
};

/**
 * Start an upload over TCP. `send(bytes)` writes part of the body; `finish()`
 * writes the rest and the closing boundary; `response` resolves with the
 * status and JSON body, or undefined if the connection closed without one.
 */
function startUpload(route, length, filename = "upload.bin") {
  const { contentType, head, tail } = multipart(route.fields(), filename);
  const client = connect();
  client.socket.write(
    [
      `POST ${route.url()} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${token}`,
      `Content-Type: ${contentType}`,
      `Content-Length: ${head.length + length + tail.length}`,
      "",
      "",
    ].join("\r\n"),
  );
  client.socket.write(head);
  const response = new Promise((resolve) => {
    const check = () => {
      const text = client.received();
      const parsed = parseResponse(text);
      if (parsed.json !== undefined) resolve(parsed);
    };
    client.socket.on("data", check);
    client.closed.then(() => resolve(parseResponse(client.received()).status ? parseResponse(client.received()) : undefined));
  });
  return {
    client,
    response,
    send: (bytes) => client.socket.write(bytes),
    finish: (bytes = Buffer.alloc(0)) => {
      client.socket.write(Buffer.concat([bytes, tail]));
      return response;
    },
  };
}

/** Send `bytes` in `pieces` writes `everyMs` apart. */
async function trickle(upload, bytes, pieces, everyMs) {
  const size = Math.ceil(bytes.length / pieces);
  for (let offset = 0; offset < bytes.length; offset += size) {
    upload.send(bytes.subarray(offset, offset + size));
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

before(async () => {
  app = await buildApp({ requestLimits: LIMITS });
  app.server.on("connection", (socket) => serverSockets.set(socket.remotePort, socket));
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  base = `http://127.0.0.1:${port}`;
  user = await app.prisma.user.create({
    data: { email: `request-limits-${suffix}@example.test`, displayName: "Limits", emailVerified: true },
  });
  // Sockets require an access token bound to a live sign-in session.
  const { familyId } = await startRefreshSession(app.prisma, user.id);
  token = signAccessToken({ sub: user.id, email: user.email, sid: familyId });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Request limits",
      slug: `request-limits-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Limits wiki", slug: `limits-${suffix}` },
  });
  // Stored directly: larger than the upload limit and the socket buffers.
  const stored = async (name, size) => {
    const bytes = crypto.randomBytes(size);
    const storagePath = await app.storage.save(`${workspace.id}/fixtures`, "downloads", crypto.randomUUID(), ".bin", bytes);
    const file = await app.prisma.file.create({
      data: {
        workspaceId: workspace.id,
        name,
        mimeType: "application/octet-stream",
        size: bytes.length,
        storagePath,
        uploadedById: user.id,
        ownerId: user.id,
      },
    });
    return { ...file, digest: sha256(bytes) };
  };
  bigFile = await stored("big.bin", 32 * MiB);
  mediumFile = await stored("medium.bin", 4 * MiB);
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
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("the production timeouts are applied to the HTTP server", async () => {
  const { REQUEST_LIMITS } = await import("../../src/plugins/request-limits.ts");
  assert.deepEqual(
    { ...REQUEST_LIMITS },
    {
      headersTimeoutMs: 30_000,
      requestTimeoutMs: 120_000,
      socketIdleTimeoutMs: 120_000,
      keepAliveTimeoutMs: 72_000,
      connectionsCheckingIntervalMs: 5_000,
      uploadIdleTimeoutMs: 60_000,
    },
  );
  const production = await buildApp();
  try {
    assert.equal(production.server.headersTimeout, 30_000);
    assert.equal(production.server.requestTimeout, 120_000);
    assert.equal(production.server.timeout, 120_000);
    assert.equal(production.server.keepAliveTimeout, 72_000);
  } finally {
    await production.close();
  }
});

test("a client that sends nothing, or sends its headers slowly, is cut off with a 408", { timeout: 30_000 }, async () => {
  const silent = connect();
  const slow = connect();
  slow.socket.write(`GET /api/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Slow: `);
  const drip = setInterval(() => slow.socket.write("a"), 100);
  try {
    const bound = LIMITS.headersTimeoutMs + LIMITS.connectionsCheckingIntervalMs + SLACK_MS;
    const [silentAfter, slowAfter] = await Promise.all([
      closedWithin(silent, bound, "silent connection"),
      closedWithin(slow, bound, "slow headers"),
    ]);
    assert.ok(silentAfter >= LIMITS.headersTimeoutMs - 50, `${silentAfter}`);
    assert.ok(slowAfter >= LIMITS.headersTimeoutMs - 50, `${slowAfter}`);
    assert.equal(parseResponse(slow.received()).status, 408, slow.received());
  } finally {
    clearInterval(drip);
  }
  // The server still answers.
  const live = await fetch(`${base}/api/live`);
  assert.equal(live.status, 200);
});

test("a request body that arrives too slowly is cut off with a 408", { timeout: 30_000 }, async () => {
  const client = connect();
  client.socket.write(
    `POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n{"email":"`,
  );
  const drip = setInterval(() => client.socket.write("a"), 100);
  try {
    const elapsed = await closedWithin(
      client,
      LIMITS.requestTimeoutMs + LIMITS.connectionsCheckingIntervalMs + SLACK_MS,
      "slow body",
    );
    assert.ok(elapsed >= LIMITS.requestTimeoutMs - 50, `${elapsed}`);
    assert.equal(parseResponse(client.received()).status, 408, client.received());
  } finally {
    clearInterval(drip);
  }
});

test("an upload route lifts the request deadline only once an authorized file starts", { timeout: 60_000 }, async () => {
  // Refused before its body is read, or never starting a file, while the
  // body is dripped: the deadline still applies, so the client cannot keep
  // the connection.
  for (const [label, url, authorization] of [
    ["anonymous drive", `/api/workspaces/${workspace.id}/files/upload`, ""],
    ["anonymous wiki", "/api/uploads", ""],
    ["anonymous backup", `/api/workspaces/${workspace.id}/backup/preview`, ""],
    ["foreign drive", `/api/workspaces/not-a-member/files/upload`, `Authorization: Bearer ${token}\r\n`],
    // Authorized, but no file part ever starts.
    ["drive without a file", `/api/workspaces/${workspace.id}/files/upload`, `Authorization: Bearer ${token}\r\n`],
    ["wiki without a file", "/api/uploads", `Authorization: Bearer ${token}\r\n`],
    ["backup without a file", `/api/workspaces/${workspace.id}/backup/preview`, `Authorization: Bearer ${token}\r\n`],
  ]) {
    const client = connect();
    client.socket.write(
      `POST ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authorization}Content-Type: multipart/form-data; boundary=x\r\nContent-Length: 1000000\r\n\r\n`,
    );
    const drip = setInterval(() => client.socket.write("a"), 100);
    try {
      await closedWithin(client, LIMITS.requestTimeoutMs + LIMITS.connectionsCheckingIntervalMs + SLACK_MS, label);
      assert.match(String(parseResponse(client.received()).status), /^4/, `${label}: ${client.received()}`);
    } finally {
      clearInterval(drip);
    }
  }
  await waitFor(() => backupConcurrency.usage.admitted === 0, "the backup admission to be released");
});

test("an authorized upload cannot keep its connection by trickling after its response", { timeout: 30_000 }, async () => {
  const { UNREAD_BODY_GRACE_MS } = await import("../../src/plugins/request-limits.ts");
  // The file is stored once its part ends, before the closing boundary, and
  // after the request deadline has passed. The client then sends a field
  // that never ends, one byte at a time.
  const bytes = crypto.randomBytes(256 * 1024);
  const boundary = `request-limits-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="early.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const next = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n`);
  const client = connect();
  client.socket.write(
    `POST ${drive.url()} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000000\r\n\r\n`,
  );
  client.socket.write(head);
  await trickle({ send: (chunk) => client.socket.write(chunk) }, bytes, 24, 100);
  client.socket.write(next);
  await waitFor(() => parseResponse(client.received()).json !== undefined, "the upload's response");
  const answeredAt = Date.now();
  assert.equal(parseResponse(client.received()).status, 201, client.received());
  const drip = setInterval(() => client.socket.write("a"), 100);
  try {
    await closedWithin(client, UNREAD_BODY_GRACE_MS + SLACK_MS, "trickling after the response");
    assert.ok(Date.now() - answeredAt >= UNREAD_BODY_GRACE_MS - 100);
  } finally {
    clearInterval(drip);
  }
});

test("a client that stops reading a download is dropped", { timeout: 30_000 }, async () => {
  const client = connect();
  await new Promise((resolve) => client.socket.once("connect", resolve));
  const serverSocket = () => serverSockets.get(client.socket.localPort);
  client.socket.write(
    `GET /api/workspaces/${workspace.id}/files/${bigFile.id}/download HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  await waitFor(() => client.received().startsWith("HTTP/1.1 200"), "the download to start");
  client.socket.pause();
  const started = Date.now();
  // Node skips one idle expiry while a write is pending.
  await waitFor(() => serverSocket()?.destroyed, "the server to drop the stalled download", 2 * LIMITS.socketIdleTimeoutMs + SLACK_MS);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= LIMITS.socketIdleTimeoutMs - 100, `${elapsed}`);
  client.socket.destroy();
});

test("a slow but steady download completes after every timeout has passed", { timeout: 60_000 }, async () => {
  const started = Date.now();
  const { status, digest, length } = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/workspaces/${workspace.id}/files/${mediumFile.id}/download`, {
      headers: { authorization: `Bearer ${token}` },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const hash = crypto.createHash("sha256");
      let length = 0;
      // About 1 MiB/s: the 4 MiB file takes about 4 s, while bytes never stop
      // moving for longer than a few tens of milliseconds.
      response.on("data", (chunk) => {
        hash.update(chunk);
        length += chunk.length;
        response.pause();
        setTimeout(() => response.resume(), Math.ceil(chunk.length / 1024));
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, digest: hash.digest("hex"), length }));
    });
  });
  const elapsed = Date.now() - started;
  assert.equal(status, 200);
  assert.equal(length, Number(mediumFile.size));
  assert.equal(digest, mediumFile.digest);
  assert.ok(elapsed > 2 * Math.max(LIMITS.requestTimeoutMs, LIMITS.socketIdleTimeoutMs), `${elapsed}`);
});

test("slow but steady Drive and wiki uploads complete past the request timeout", { timeout: 60_000 }, async () => {
  for (const [label, route] of [["drive", drive], ["wiki", wiki]]) {
    const bytes = crypto.randomBytes(768 * 1024);
    const upload = startUpload(route, bytes.length, `${label}.bin`);
    const started = Date.now();
    // 48 pieces 80 ms apart: about 3.8 s in all.
    await trickle(upload, bytes, 48, 80);
    const response = await upload.finish();
    const elapsed = Date.now() - started;
    assert.equal(response?.status, 201, `${label}: ${JSON.stringify(response)}`);
    assert.ok(elapsed > 2 * LIMITS.requestTimeoutMs, `${label}: ${elapsed}`);
    const storagePath = label === "drive" ? response.json.data.storagePath : response.json.data.url.slice("/storage/".length);
    assert.equal(sha256(await readFile(path.join(storageDir, storagePath))), sha256(bytes), label);
    if (label === "drive") assert.equal(response.json.data.size, bytes.length);
    upload.client.socket.destroy();
  }
});

test("a backup upload or export may take longer than the request and idle timeouts", { timeout: 60_000 }, async () => {
  // A slow but steady backup preview upload.
  const archive = craftZip([
    {
      name: "backup.json",
      content: Buffer.from(
        JSON.stringify({
          metadata: { version: "1.1", exportedAt: new Date().toISOString(), sourceWorkspace: { name: "L", slug: "l" }, userRefs: [] },
          projects: [],
          channels: [],
          wikiSpaces: [
            {
              space: { name: `Slow ${suffix}` },
              pages: [
                {
                  _originalId: "page",
                  title: "Slow",
                  position: 0,
                  content: [{ type: "image", props: { url: "assets/pad.png" } }],
                },
              ],
            },
          ],
        }),
      ),
      method: DEFLATED,
    },
    { name: "assets/pad.png", content: crypto.randomBytes(256 * 1024) },
  ]);
  const backup = { url: () => `/api/workspaces/${workspace.id}/backup/preview`, fields: () => ({}) };
  const upload = startUpload(backup, archive.length, "backup.zip");
  await trickle(upload, archive, 40, 90);
  const previewed = await upload.finish();
  assert.equal(previewed?.status, 200, JSON.stringify(previewed));
  assert.equal(previewed.json.data.wikiSpaces, 1);
  upload.client.socket.destroy();

  // An export that waits its turn, silently, for longer than the idle timeout.
  let open;
  const held = backupConcurrency.exclusive(() => new Promise((resolve) => (open = resolve)));
  const exported = fetch(`${base}/api/workspaces/${workspace.id}/backup/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ wikiSpaces: [{ spaceId: space.id }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 2 * LIMITS.socketIdleTimeoutMs + SLACK_MS));
  open();
  await held;
  const response = await exported;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.ok((await response.arrayBuffer()).byteLength > 0);
  await waitFor(() => backupConcurrency.usage.admitted === 0, "the export's admission to be released");
});

test("a WebSocket connection stays open after every timeout has passed", { timeout: 30_000 }, async () => {
  const client = await openRawSocket(port);
  try {
    client.sendJSON({ type: "auth", token });
    assert.deepEqual(await client.next((m) => m.event === "authenticated"), { event: "authenticated" });
    await new Promise((resolve) =>
      setTimeout(resolve, 2 * Math.max(LIMITS.requestTimeoutMs, LIMITS.socketIdleTimeoutMs, LIMITS.headersTimeoutMs) + 500),
    );
    client.sendJSON({ type: "ping" });
    assert.deepEqual(await client.next((m) => m.event === "pong"), { event: "pong" });
  } finally {
    client.socket.destroy();
  }
});

test("uploads over their size limit get a 413 and leave nothing behind", { timeout: 30_000 }, async () => {
  const initial = await snapshot();
  for (const [label, route, limit] of [
    ["drive", drive, MAX_FILE_SIZE],
    ["wiki", wiki, MAX_FILE_SIZE],
  ]) {
    const response = await startUpload(route, limit + 1).finish(crypto.randomBytes(limit + 1));
    assert.equal(response?.status, 413, `${label}: ${JSON.stringify(response)}`);
    assert.equal(response.json.message, `Upload exceeds ${limit} bytes`, label);
    assert.deepEqual(await snapshot(), initial, label);
  }

  // Exactly the limit is stored whole.
  const bytes = crypto.randomBytes(MAX_FILE_SIZE);
  const stored = await startUpload(drive, bytes.length, "limit.bin").finish(bytes);
  assert.equal(stored?.status, 201, JSON.stringify(stored));
  assert.equal(stored.json.data.size, MAX_FILE_SIZE);
  assert.equal(sha256(await readFile(path.join(storageDir, stored.json.data.storagePath))), sha256(bytes));
});

test("an upload that stalls gets a 408 and leaves nothing behind", { timeout: 30_000 }, async () => {
  const initial = await snapshot();
  for (const [label, route] of [["drive", drive], ["wiki", wiki]]) {
    // Stalled halfway through the file, after its first bytes were stored.
    const upload = startUpload(route, 512 * 1024);
    upload.send(crypto.randomBytes(256 * 1024));
    const started = Date.now();
    const response = await upload.response;
    const elapsed = Date.now() - started;
    assert.equal(response?.status, 408, `${label}: ${JSON.stringify(response)}`);
    assert.ok(elapsed < LIMITS.uploadIdleTimeoutMs + SLACK_MS, `${label}: ${elapsed}`);
    // A stalled client is not sending, so the server closes the connection.
    await closedWithin(upload.client, SLACK_MS, `${label} after its 408`);
    assert.deepEqual(await snapshot(), initial, label);
  }

  // Stalled before the file part starts.
  const { contentType, head } = multipart({}, "never.bin");
  const client = connect();
  client.socket.write(
    `POST ${drive.url()} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: ${contentType}\r\nContent-Length: 4096\r\n\r\n`,
  );
  client.socket.write(head.subarray(0, 20));
  await closedWithin(client, LIMITS.uploadIdleTimeoutMs + SLACK_MS, "stalled before the file");
  assert.equal(parseResponse(client.received()).status, 408, client.received());
  assert.deepEqual(await snapshot(), initial);
});

test("an upload whose client disconnects leaves nothing behind", { timeout: 30_000 }, async () => {
  const initial = await snapshot();
  for (const [label, route] of [["drive", drive], ["wiki", wiki]]) {
    const upload = startUpload(route, 768 * 1024);
    upload.send(crypto.randomBytes(512 * 1024));
    // The partial file is being written when the client goes away.
    await waitFor(async () => (await storedFiles()).length > initial.files.length, `${label} to start storing`);
    upload.client.socket.destroy();
    await waitFor(
      async () => JSON.stringify(await snapshot()) === JSON.stringify(initial),
      `${label}'s partial file to be removed`,
    );
  }
});
