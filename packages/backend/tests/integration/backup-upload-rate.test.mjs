import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { craftZip, DEFLATED } from "../fixtures/crafted-zip.mjs";

// The minimum rate of backup preview and restore uploads (R42,
// docs/remediation/r42-backup-limits.md), driven over TCP with throttled
// clients against the real app, with short limits so each case takes seconds.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const MIN_RATE = 4096;
const WINDOW_MS = 2_000;
const GRACE_MS = 2_000;
// The rate is checked every tenth of the window.
const CHECK_MS = WINDOW_MS / 10;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-upload-rate-integration-jwt-secret",
  COOKIE_SECRET: "backup-upload-rate-integration-cookie-secret",
  MAX_FILE_SIZE: String(8 << 20),
  BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: String(MIN_RATE),
  BACKUP_UPLOAD_RATE_WINDOW_SECONDS: String(WINDOW_MS / 1000),
  BACKUP_UPLOAD_RATE_GRACE_SECONDS: String(GRACE_MS / 1000),
});
// Short HTTP limits (docs/remediation/p03a.md). The request deadline is
// longer than the grace period, so a request refused before its file starts
// shows which limit cut it off, and shorter than the steady uploads below, so
// they show it is still lifted once their file starts.
const LIMITS = {
  headersTimeoutMs: 800,
  requestTimeoutMs: 6_000,
  socketIdleTimeoutMs: 1_200,
  keepAliveTimeoutMs: 1_000,
  connectionsCheckingIntervalMs: 100,
  uploadIdleTimeoutMs: 800,
};
// Scheduling slack on a busy host.
const SLACK_MS = 1_500;

const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-upload-rate-"));
const storageDir = path.join(root, "storage");
const stagingDir = path.join(storageDir, ".tmp", "backup");
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { backupConcurrency, SERVER_BUSY_MESSAGE, WORKSPACE_BUSY_MESSAGE } = await import(
  "../../src/modules/backup/backup-concurrency.ts"
);
const { UNREAD_BODY_GRACE_MS } = await import("../../src/plugins/request-limits.ts");

const suffix = crypto.randomUUID().slice(0, 8);
const TOO_SLOW = `The backup upload was too slow and was abandoned. Uploads must average at least ${MIN_RATE} bytes per second.`;
let app, port;
const admins = {};
const tokens = {};
const workspaces = {};
const sockets = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const staged = async () => (await readdir(stagingDir).catch(() => [])).filter((name) => name.endsWith(".part"));
const spaceNamed = (workspaceId, name) => app.prisma.wikiSpace.count({ where: { workspaceId, name } });

/** Every stored file of `workspaceId`, and its cleanup queue entries. */
async function stored(workspaceId) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(path.relative(storageDir, full));
    }
  };
  await walk(path.join(storageDir, workspaceId));
  const queued = await app.prisma.blobCleanup.count({ where: { storagePath: { startsWith: `${workspaceId}/` } } });
  return { files, queued };
}

/** A backup archive with one wiki page showing `padBytes` of random image data. */
function archiveFor(label, padBytes = 256) {
  const pad = crypto.randomBytes(padBytes);
  const json = {
    metadata: {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      sourceWorkspace: { name: "Rate", slug: "rate" },
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
            content: [{ type: "image", props: { url: "assets/pad.png" } }],
          },
        ],
      },
    ],
  };
  const zip = craftZip([
    { name: "backup.json", content: Buffer.from(JSON.stringify(json)), method: DEFLATED },
    { name: "assets/pad.png", content: pad },
  ]);
  return { zip, pad };
}

/** Parse one HTTP response from the bytes received so far, once complete. */
function parseResponse(bytes) {
  const end = bytes.indexOf("\r\n\r\n");
  if (end < 0) return undefined;
  const [statusLine, ...lines] = bytes.subarray(0, end).toString().split("\r\n");
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const length = Number(headers["content-length"] ?? 0);
  if (bytes.length < end + 4 + length) return undefined;
  const text = bytes.subarray(end + 4, end + 4 + length).toString();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: Number(statusLine.split(" ")[1]), headers, json, text };
}

/**
 * Open a backup upload of `file` over TCP and send its request head. The
 * multipart body (`body`) is then sent by pace(). `response` resolves with the
 * parsed response and when it arrived (ms since the connection opened), or
 * with no status if the connection closed first; `closed` with when the
 * connection closed.
 */
async function openUpload(workspaceId, action, file, bearer) {
  const boundary = `rate-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const body = Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const socket = net.connect(port, "127.0.0.1");
  sockets.add(socket);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  const started = performance.now();
  let received = Buffer.alloc(0);
  let answered;
  const response = new Promise((resolve) => {
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const parsed = parseResponse(received);
      if (parsed && !answered) {
        answered = { ...parsed, at: performance.now() - started };
        resolve(answered);
      }
    });
    socket.once("close", () => resolve(answered ?? { status: undefined }));
  });
  const closed = new Promise((resolve) => socket.once("close", () => resolve(performance.now() - started)));
  socket.write(
    `POST /api/workspaces/${workspaceId}/backup/${action} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${bearer}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  return { socket, body, head, response, closed, answered: () => answered !== undefined };
}

/**
 * Send `upload.body`: `initial` bytes at once, then whatever is due at
 * `bytesPerSecond` every 20 ms, so a late timer catches up instead of
 * lowering the rate. Nothing is sent during `pause` ([from, to] ms). Stops
 * once the server answers (with `afterAnswer`, once the connection closes)
 * or the body has been sent.
 */
async function pace(upload, { initial = 0, bytesPerSecond, pause, afterAnswer = false }) {
  const stopAt = upload.body.length;
  const started = performance.now();
  let sent = 0;
  const sendUpTo = (target) => {
    const end = Math.min(target, stopAt);
    if (end > sent && !upload.socket.destroyed) {
      upload.socket.write(upload.body.subarray(sent, end));
      sent = end;
    }
  };
  sendUpTo(initial);
  while (sent < stopAt && (afterAnswer || !upload.answered()) && !upload.socket.destroyed) {
    await sleep(20);
    const elapsed = performance.now() - started;
    const paused = pause ? Math.max(0, Math.min(elapsed, pause[1]) - pause[0]) : 0;
    sendUpTo(initial + Math.floor((bytesPerSecond * (elapsed - paused)) / 1000));
  }
  return sent;
}

/** Upload `file` at once and return the response. */
async function uploadNow(workspaceId, action, file, bearer) {
  const upload = await openUpload(workspaceId, action, file, bearer);
  upload.socket.write(upload.body);
  const response = await upload.response;
  upload.socket.destroy();
  return response;
}

before(async () => {
  app = await buildApp({ requestLimits: LIMITS });
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  for (const name of ["dripper", "other"]) {
    admins[name] = await app.prisma.user.create({
      data: { email: `backup-rate-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    tokens[name] = signAccessToken({ sub: admins[name].id, email: admins[name].email });
  }
  for (const key of ["a", "b", "c", "d"]) {
    workspaces[key] = await app.prisma.workspace.create({
      data: {
        name: `Rate ${key}`,
        slug: `rate-${key}-${suffix}`,
        members: {
          create: [
            { userId: admins.dripper.id, role: "ADMIN" },
            { userId: admins.other.id, role: "ADMIN" },
          ],
        },
      },
    });
  }
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  try {
    if (app) {
      const ids = Object.values(workspaces).map((workspace) => workspace.id);
      await app.prisma.blobCleanup.deleteMany({
        where: { OR: ids.map((id) => ({ storagePath: { startsWith: `${id}/` } })) },
      });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(admins).map((user) => user.id) } } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("slow-drip uploads get a 408 and free their slots, so other admins' backups are admitted at once", { timeout: 60_000 }, async (t) => {
  const { a, b, c, d } = workspaces;
  // Three restores and previews, one per workspace, fill the server's
  // backup slots. Each sends its first 64 file bytes, then 1 byte a second,
  // and keeps dripping after it is answered.
  const drips = [];
  for (const [workspace, action] of [[a, "restore"], [b, "preview"], [c, "restore"]]) {
    const label = `Drip ${workspace.name} ${suffix}`;
    const upload = await openUpload(workspace.id, action, archiveFor(label).zip, tokens.dripper);
    const sending = pace(upload, { initial: upload.head.length + 64, bytesPerSecond: 1, afterAnswer: true });
    drips.push({ workspace, action, label, upload, sending });
  }
  await waitFor(async () => (await staged()).length === 3, "every drip's file to start");
  assert.equal(backupConcurrency.usage.admitted, 3);

  // Meanwhile another admin is refused: the same workspace has its one slot
  // taken, and the server has all three taken.
  const sameWorkspace = await uploadNow(a.id, "restore", archiveFor("refused").zip, tokens.other);
  assert.equal(sameWorkspace.status, 429, sameWorkspace.text);
  assert.equal(sameWorkspace.json.message, WORKSPACE_BUSY_MESSAGE);
  const fourthWorkspace = await uploadNow(d.id, "preview", archiveFor("refused").zip, tokens.other);
  assert.equal(fourthWorkspace.status, 503, fourthWorkspace.text);
  assert.equal(fourthWorkspace.json.message, SERVER_BUSY_MESSAGE);

  for (const drip of drips) {
    const response = await drip.upload.response;
    t.diagnostic(`${drip.action} in ${drip.workspace.name}: ${response.status} after ${Math.round(response.at)} ms`);
    assert.equal(response.status, 408, response.text);
    assert.equal(response.json.message, TOO_SLOW);
    // Refused at the first check after the grace period, measured from
    // admission, which follows the connection opening.
    assert.ok(response.at >= GRACE_MS && response.at < GRACE_MS + CHECK_MS + SLACK_MS, `${response.at} ms`);
  }
  // By the time the clients have their answers, the slots are free and the
  // partial files are gone.
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
  assert.deepEqual(await staged(), []);

  // The other admin's backups are admitted right away.
  const otherLabel = `Other admin ${suffix}`;
  const { zip, pad } = archiveFor(otherLabel);
  const restored = await uploadNow(a.id, "restore", zip, tokens.other);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.data.wikiSpaces, 1);
  assert.equal(restored.json.data.images, 1);
  const previewed = await uploadNow(d.id, "preview", archiveFor(`Fourth ${suffix}`).zip, tokens.other);
  assert.equal(previewed.status, 200, previewed.text);

  // Each dripping client, still sending, is disconnected shortly after its
  // answer, and its restore or preview wrote nothing.
  for (const drip of drips) {
    const closedAt = await Promise.race([drip.upload.closed, sleep(UNREAD_BODY_GRACE_MS + SLACK_MS + 2_000)]);
    const { at } = await drip.upload.response;
    const sent = await drip.sending;
    t.diagnostic(`${drip.action} in ${drip.workspace.name}: closed ${Math.round(closedAt - at)} ms after its answer, ${sent} bytes sent`);
    assert.ok(closedAt !== undefined && closedAt - at < UNREAD_BODY_GRACE_MS + SLACK_MS, `closed ${closedAt} ms, answered ${at} ms`);
    assert.equal(await spaceNamed(drip.workspace.id, drip.label), 0);
  }
  for (const workspace of [b, c]) assert.deepEqual(await stored(workspace.id), { files: [], queued: 0 });
  // Only the other admin's restore stored its image.
  const [space] = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: a.id, name: otherLabel },
    include: { pages: true },
  });
  const url = space.pages[0].content[0].props.url;
  assert.deepEqual(await stored(a.id), { files: [url.slice("/storage/".length)], queued: 0 });
  assert.equal(sha256(await readFile(path.join(storageDir, url.slice("/storage/".length)))), sha256(pad));
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
});

test("uploads just above the minimum rate, or pausing for half the window, succeed however long they take", { timeout: 60_000 }, async (t) => {
  const { a, b } = workspaces;
  // About 8 s at 1.25 times the rate: longer than the request deadline and
  // three windows.
  const steadyLabel = `Steady ${suffix}`;
  const steadyArchive = archiveFor(steadyLabel, Math.round(1.25 * MIN_RATE * 8));
  const steady = await openUpload(a.id, "restore", steadyArchive.zip, tokens.dripper);
  // Three times the rate with a pause of half the window, after the grace
  // period.
  const pausedLabel = `Paused ${suffix}`;
  const paused = await openUpload(b.id, "preview", archiveFor(pausedLabel, 3 * MIN_RATE * 5).zip, tokens.dripper);
  const sending = [
    pace(steady, { bytesPerSecond: 1.25 * MIN_RATE }),
    pace(paused, { bytesPerSecond: 3 * MIN_RATE, pause: [GRACE_MS + 500, GRACE_MS + 500 + WINDOW_MS / 2] }),
  ];
  const [restored, previewed] = await Promise.all([steady.response, paused.response]);
  await Promise.all(sending);
  t.diagnostic(`steady restore ${restored.status} after ${Math.round(restored.at)} ms; paused preview ${previewed.status} after ${Math.round(previewed.at)} ms`);
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.data.images, 1);
  assert.ok(restored.at > LIMITS.requestTimeoutMs + SLACK_MS, `the restore upload took ${restored.at} ms`);
  assert.equal(previewed.status, 200, previewed.text);
  assert.equal(previewed.json.data.wikiSpaces, 1);
  assert.ok(previewed.at > GRACE_MS + WINDOW_MS, `the preview upload took ${previewed.at} ms`);
  for (const upload of [steady, paused]) upload.socket.destroy();

  const [space] = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: a.id, name: steadyLabel },
    include: { pages: true },
  });
  const url = space.pages[0].content[0].props.url;
  assert.equal(sha256(await readFile(path.join(storageDir, url.slice("/storage/".length)))), sha256(steadyArchive.pad));
  assert.equal(await spaceNamed(b.id, pausedLabel), 0, "a preview writes nothing");
  assert.deepEqual(await staged(), []);
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
});

test("a client that stops sending, or drips the part header, is cut off before or during its file", { timeout: 60_000 }, async (t) => {
  const { a, b, c } = workspaces;
  // During the file: 16 KiB at once, four times what the first window needs,
  // then nothing. Refused once the window has slid past those bytes.
  const label = `Stopped ${suffix}`;
  const during = await openUpload(c.id, "restore", archiveFor(label, 64 * 1024).zip, tokens.dripper);
  during.socket.write(during.body.subarray(0, during.head.length + 16 * 1024));
  // Before the file: the request head and half of the file part's header,
  // then nothing.
  const before = await openUpload(a.id, "preview", archiveFor("never").zip, tokens.dripper);
  before.socket.write(before.body.subarray(0, before.head.length >> 1));
  // Before the file: the part header one byte a second, which goes on after
  // the answer. Only the server closing the connection stops it.
  const header = await openUpload(b.id, "restore", archiveFor("never").zip, tokens.dripper);
  const dripping = pace(header, { bytesPerSecond: 1, afterAnswer: true });
  await waitFor(() => backupConcurrency.usage.admitted === 3, "the uploads to be admitted");
  await waitFor(async () => (await staged()).length === 1, "the first upload's file to start");

  for (const [name, upload] of [
    ["stopped during the file", during],
    ["stopped before the file", before],
    ["dripping the part header", header],
  ]) {
    const response = await upload.response;
    const closedAt = await Promise.race([upload.closed, sleep(LIMITS.requestTimeoutMs + SLACK_MS)]);
    t.diagnostic(`${name}: ${response.status} after ${Math.round(response.at)} ms, closed after ${Math.round(closedAt)} ms`);
    assert.equal(response.status, 408, `${name}: ${response.text}`);
    assert.equal(response.json.message, TOO_SLOW);
    assert.ok(
      response.at >= GRACE_MS && response.at < WINDOW_MS + 2 * CHECK_MS + SLACK_MS,
      `${name}: answered after ${response.at} ms`,
    );
    // Cut off by the minimum rate, ahead of the 6 s request deadline (which
    // applies before the file starts, and again once the response is sent)
    // and the 60 s transfer idle limit, and closed shortly after the answer.
    assert.ok(closedAt !== undefined && closedAt - response.at < UNREAD_BODY_GRACE_MS + SLACK_MS, `${name}: closed ${closedAt} ms`);
    assert.ok(closedAt < LIMITS.requestTimeoutMs, `${name}: closed ${closedAt} ms, at the request deadline`);
  }
  await dripping;
  assert.deepEqual(await staged(), []);
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
  assert.equal(await spaceNamed(c.id, label), 0);
  assert.deepEqual(await stored(c.id), { files: [], queued: 0 });
});
