import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { craftZip, DEFLATED } from "../fixtures/crafted-zip.mjs";

// The per-user cooldown on backup preview and restore uploads (the R42
// follow-up, docs/remediation/r42-backup-limits.md), driven over TCP against
// the real app and PostgreSQL, with short limits so each case takes seconds.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const MIN_RATE = 4096;
const GRACE_MS = 2_000;
const COOLDOWN_SECONDS = 4;
// A user is refused only while more than a fifth of the cooldown is owed, and
// each second of shortfall below the rate owes cooldown / grace seconds.
const ALLOWANCE_MS = (COOLDOWN_SECONDS * 1000) / 5;
const WAIT_PER_SHORTFALL = (COOLDOWN_SECONDS * 1000) / GRACE_MS;
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-upload-cooldown-integration-jwt-secret",
  COOKIE_SECRET: "backup-upload-cooldown-integration-cookie-secret",
  MAX_FILE_SIZE: String(8 << 20),
  BACKUP_UPLOAD_MIN_BYTES_PER_SECOND: String(MIN_RATE),
  BACKUP_UPLOAD_RATE_WINDOW_SECONDS: "2",
  BACKUP_UPLOAD_RATE_GRACE_SECONDS: String(GRACE_MS / 1000),
  BACKUP_UPLOAD_RATE_COOLDOWN_SECONDS: String(COOLDOWN_SECONDS),
});
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

const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-upload-cooldown-"));
process.env.STORAGE_DIR = path.join(root, "storage");

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { backupConcurrency } = await import("../../src/modules/backup/backup-concurrency.ts");
const { BACKUP_UPLOAD_COOLDOWN_CODE, createBackupUploadCooldown } = await import(
  "../../src/modules/backup/backup-cooldown.ts"
);
const { UNREAD_BODY_GRACE_MS } = await import("../../src/plugins/request-limits.ts");

const suffix = crypto.randomUUID().slice(0, 8);
const TOO_SLOW = `The backup upload was too slow and was abandoned. Uploads must average at least ${MIN_RATE} bytes per second.`;
const PAUSED = /^Backup uploads from your account are paused because a recent one was too slow\. Try again in \d+ seconds?\.$/;
let app, port;
const users = {};
const tokens = {};
const workspaces = {};
const sockets = new Set();
let wikiSpace;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

// Every call to admit() in this process, so a test can show that a refused
// request never took a slot.
let admissions = 0;
const admit = backupConcurrency.admit.bind(backupConcurrency);
backupConcurrency.admit = (workspaceId) => {
  admissions++;
  return admit(workspaceId);
};

/** A small, valid backup archive with one wiki space named `label`. */
function archiveFor(label) {
  const json = {
    metadata: {
      version: "1.1",
      exportedAt: new Date().toISOString(),
      sourceWorkspace: { name: "Cooldown", slug: "cooldown" },
      userRefs: [],
    },
    projects: [],
    channels: [],
    wikiSpaces: [{ space: { name: label }, pages: [{ _originalId: "page", title: label, position: 0, content: [] }] }],
  };
  return craftZip([{ name: "backup.json", content: Buffer.from(JSON.stringify(json)), method: DEFLATED }]);
}

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
 * Open a backup upload of `file` to the server on `serverPort` over TCP and
 * send its request head; the multipart body (`body`, whose file part starts
 * after `head`) is sent by the caller.
 */
async function openUpload(serverPort, workspaceId, action, file, bearer, filename = "backup.zip") {
  const boundary = `cooldown-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const body = Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const socket = net.connect(serverPort, "127.0.0.1");
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
    `POST /api/workspaces/${workspaceId}/backup/${action} HTTP/1.1\r\nHost: 127.0.0.1:${serverPort}\r\nAuthorization: Bearer ${bearer}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  return { socket, body, head, response, closed, answered: () => answered !== undefined };
}

/** Upload `file` at once and return the response. */
async function uploadNow(workspaceId, action, bearer, { serverPort = port, file = archiveFor("now"), filename } = {}) {
  const upload = await openUpload(serverPort, workspaceId, action, file, bearer, filename);
  upload.socket.write(upload.body);
  const response = await upload.response;
  upload.socket.destroy();
  return response;
}

/**
 * Send the head and the first 64 bytes of the file at once, then one byte a
 * second until answered: refused for its rate just after the grace period.
 */
async function slowDrip(serverPort, workspaceId, bearer) {
  const upload = await openUpload(serverPort, workspaceId, "restore", archiveFor("drip"), bearer);
  let sent = upload.head.length + 64;
  upload.socket.write(upload.body.subarray(0, sent));
  const started = performance.now();
  while (!upload.answered() && !upload.socket.destroyed) {
    await sleep(50);
    const due = upload.head.length + 64 + Math.floor((performance.now() - started) / 1000);
    if (due > sent) upload.socket.write(upload.body.subarray(sent, (sent = due)));
  }
  const response = await upload.response;
  upload.socket.destroy();
  return response;
}

/** The wait `user` owes, in ms from now (0 when none). */
async function owed(user) {
  const [row] = await app.prisma.$queryRaw`
    SELECT EXTRACT(EPOCH FROM ("clearsAt" - (statement_timestamp() AT TIME ZONE 'UTC'))) * 1000 AS "ms"
    FROM "BackupUploadCooldown" WHERE "userId" = ${user.id}
  `;
  return row ? Math.max(0, Number(row.ms)) : 0;
}

function assertPaused(response, maxSeconds = COOLDOWN_SECONDS) {
  assert.equal(response.status, 429, response.text);
  assert.equal(response.json.code, BACKUP_UPLOAD_COOLDOWN_CODE);
  assert.match(response.json.message, PAUSED);
  const retryAfter = Number(response.headers["retry-after"]);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= maxSeconds, `Retry-After: ${response.headers["retry-after"]}`);
  assert.ok(response.json.message.includes(`in ${retryAfter} second`), response.json.message);
  return retryAfter;
}

before(async () => {
  app = await buildApp({ requestLimits: LIMITS });
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  for (const name of ["dripper", "other", "fast", "quitter", "late", "roamer", "returner", "locked"]) {
    users[name] = await app.prisma.user.create({
      data: { email: `backup-cooldown-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    tokens[name] = signAccessToken({ sub: users[name].id, email: users[name].email });
  }
  for (const key of ["a", "b", "c", "d"]) {
    workspaces[key] = await app.prisma.workspace.create({
      data: {
        name: `Cooldown ${key}`,
        slug: `cooldown-${key}-${suffix}`,
        members: { create: Object.values(users).map((user) => ({ userId: user.id, role: "ADMIN" })) },
      },
    });
  }
  wikiSpace = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspaces.d.id, name: `Exported ${suffix}`, slug: `exported-${suffix}` },
  });
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  try {
    if (app) {
      const ids = Object.values(workspaces).map((workspace) => workspace.id);
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("after a slow-rate 408 the same user gets 429 with Retry-After until the cooldown ends, without taking a slot", { timeout: 60_000 }, async (t) => {
  const { a, b, c, d } = workspaces;
  const refused = await slowDrip(port, a.id, tokens.dripper);
  assert.equal(refused.status, 408, refused.text);
  assert.equal(refused.json.message, TOO_SLOW);
  const refusedAt = performance.now();

  // The same user's next upload, at once and in another workspace, is
  // refused before admission with the whole cooldown to wait.
  const before = admissions;
  const first = await uploadNow(b.id, "preview", tokens.dripper);
  const firstWait = assertPaused(first);
  t.diagnostic(`Retry-After ${firstWait} s, ${Math.round(performance.now() - refusedAt)} ms after the 408`);
  assert.ok(firstWait >= COOLDOWN_SECONDS - 1, `Retry-After ${firstWait}`);
  assert.equal(admissions, before, "a refused upload was admitted");
  assert.deepEqual(backupConcurrency.usage, { admitted: 0, workspaces: 0, exclusiveRunning: 0 });

  // A client that goes on sending after the refusal is disconnected shortly
  // after it, as its body is never read.
  const sending = await openUpload(port, c.id, "restore", Buffer.alloc(64 * 1024), tokens.dripper);
  sending.socket.write(sending.body.subarray(0, 1024));
  const drip = setInterval(() => sending.socket.writable && sending.socket.write("x"), 100);
  const response = await sending.response;
  assertPaused(response);
  const closedAt = await Promise.race([sending.closed, sleep(UNREAD_BODY_GRACE_MS + SLACK_MS + 2_000)]);
  clearInterval(drip);
  assert.ok(closedAt !== undefined && closedAt - response.at < UNREAD_BODY_GRACE_MS + SLACK_MS, `closed ${closedAt} ms, answered ${response.at} ms`);
  assert.equal(admissions, before);

  // Other admins are not affected, in the same workspaces.
  assert.equal((await uploadNow(a.id, "restore", tokens.other, { file: archiveFor(`Other ${suffix}`) })).status, 200);
  assert.equal((await uploadNow(b.id, "preview", tokens.other)).status, 200);
  // Nor are the user's exports, which upload nothing.
  const exported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${d.id}/backup/export`,
    headers: { authorization: `Bearer ${tokens.dripper}` },
    payload: { projects: [], channels: [], wikiSpaces: [{ spaceId: wikiSpace.id }] },
  });
  assert.equal(exported.statusCode, 200, exported.body);

  // The wait counts down...
  await sleep(1_000);
  const later = assertPaused(await uploadNow(b.id, "preview", tokens.dripper));
  assert.ok(later < firstWait, `Retry-After ${later} after ${firstWait}`);
  // ...and once it has passed, the user is admitted again.
  await sleep(Math.max(0, refusedAt + COOLDOWN_SECONDS * 1000 - performance.now()) + 50);
  const admitted = await uploadNow(b.id, "preview", tokens.dripper);
  assert.equal(admitted.status, 200, admitted.text);
  assert.ok(performance.now() - refusedAt < (COOLDOWN_SECONDS + 1) * 1000 + SLACK_MS);
});

test("fast uploads, and fast refusals such as a 400 for the file type, never start a cooldown", { timeout: 60_000 }, async () => {
  const { a, b } = workspaces;
  for (const action of ["preview", "restore", "preview"]) {
    const response = await uploadNow(a.id, action, tokens.fast, { file: archiveFor(`Fast ${action} ${suffix}`) });
    assert.equal(response.status, 200, response.text);
  }
  const wrongType = await uploadNow(b.id, "preview", tokens.fast, { filename: "backup.txt" });
  assert.equal(wrongType.status, 400, wrongType.text);
  assert.equal(wrongType.json.message, "Only .json and .zip files are accepted");
  const noFile = await uploadNow(b.id, "restore", tokens.fast, { file: Buffer.alloc(0), filename: "" });
  assert.equal(noFile.status, 400, noFile.text);
  const damaged = await uploadNow(b.id, "restore", tokens.fast, { file: Buffer.from("PK\x03\x04 not a zip") });
  assert.equal(damaged.status, 400, damaged.text);
  // Admitted at once after each, and nothing is owed.
  assert.equal((await uploadNow(b.id, "preview", tokens.fast)).status, 200);
  const [{ rows }] = await app.prisma.$queryRaw`
    SELECT count(*)::integer AS "rows" FROM "BackupUploadCooldown" WHERE "userId" = ${users.fast.id}
  `;
  assert.equal(rows, 0);
});

test("ending a slow upload before its 408, or completing a small one late, does not avoid the wait", { timeout: 60_000 }, async (t) => {
  const { a, b, c } = workspaces;
  // A client that sends its part header, then nothing, and hangs up just
  // before the grace period ends: it is never refused for its rate.
  const quitter = await openUpload(port, a.id, "restore", archiveFor("quit"), tokens.quitter);
  quitter.socket.write(quitter.head);
  await waitFor(() => backupConcurrency.usage.admitted === 1, "the upload to be admitted");
  await sleep(GRACE_MS - 400);
  quitter.socket.destroy();
  await waitFor(() => backupConcurrency.usage.admitted === 0, "its slot to be released");
  const owedByQuitter = await owed(users.quitter);
  t.diagnostic(`hung up after ${GRACE_MS - 400} ms: owes ${Math.round(owedByQuitter)} ms`);
  // About (grace - 400 ms) of shortfall, at cooldown / grace seconds each.
  assert.ok(owedByQuitter > (GRACE_MS - 400 - 200) * WAIT_PER_SHORTFALL - SLACK_MS, `${owedByQuitter}`);
  const quitterWait = assertPaused(await uploadNow(b.id, "preview", tokens.quitter));
  assert.ok(quitterWait < COOLDOWN_SECONDS, `a partial shortfall owes less than the full cooldown: ${quitterWait}`);

  // A client that sends its part header, waits, then sends the rest of a
  // small file at once: its preview succeeds, and it owes the wait too.
  const late = await openUpload(port, c.id, "preview", archiveFor(`Late ${suffix}`), tokens.late);
  late.socket.write(late.head);
  await sleep(GRACE_MS - 400);
  late.socket.write(late.body.subarray(late.head.length));
  const previewed = await late.response;
  assert.equal(previewed.status, 200, previewed.text);
  late.socket.destroy();
  assertPaused(await uploadNow(b.id, "restore", tokens.late));

  // A short shortfall is forgiven: hanging up after 200 ms owes less than
  // the allowance, and the next upload is admitted.
  const brief = await openUpload(port, a.id, "preview", archiveFor("brief"), tokens.other);
  brief.socket.write(brief.head);
  await waitFor(() => backupConcurrency.usage.admitted === 1, "the brief upload to be admitted");
  await sleep(200);
  brief.socket.destroy();
  await waitFor(() => backupConcurrency.usage.admitted === 0, "its slot to be released");
  const owedByOther = await owed(users.other);
  t.diagnostic(`hung up after 200 ms: owes ${Math.round(owedByOther)} ms (allowance ${ALLOWANCE_MS} ms)`);
  assert.ok(owedByOther < ALLOWANCE_MS, `${owedByOther}`);
  assert.equal((await uploadNow(a.id, "preview", tokens.other)).status, 200);
});

test("a second server process on the same database refuses the user too", { timeout: 60_000 }, async () => {
  const { a, b } = workspaces;
  const child = spawn(process.execPath, ["--import", "tsx", "tests/integration/support/backup-server-child.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, STORAGE_DIR: path.join(root, "child-storage") },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const nextJson = async () => {
    for (;;) {
      const { value, done } = await lines.next();
      if (done) throw new Error("server child exited");
      if (value.startsWith("{")) return JSON.parse(value);
    }
  };
  const childUsage = async () => {
    child.stdin.write("usage\n");
    return nextJson();
  };
  try {
    const { port: childPort } = await nextJson();

    // Refused for its rate here, then refused there at once, before
    // admission; another admin is admitted there.
    const refused = await slowDrip(port, a.id, tokens.roamer);
    assert.equal(refused.status, 408, refused.text);
    const elsewhere = await uploadNow(b.id, "preview", tokens.roamer, { serverPort: childPort });
    assert.ok(assertPaused(elsewhere) >= COOLDOWN_SECONDS - 1);
    assert.deepEqual(await childUsage(), { admitted: 0, workspaces: 0, exclusiveRunning: 0 });
    assert.equal((await uploadNow(b.id, "preview", tokens.other, { serverPort: childPort })).status, 200);

    // An upload abandoned there below the rate is charged there and refused
    // here.
    const quitter = await openUpload(childPort, a.id, "restore", archiveFor("quit"), tokens.returner);
    quitter.socket.write(quitter.head);
    await waitFor(async () => (await childUsage()).admitted === 1, "the child to admit the upload");
    await sleep(GRACE_MS - 400);
    quitter.socket.destroy();
    await waitFor(async () => (await childUsage()).admitted === 0, "the child to release its slot");
    const before = admissions;
    assertPaused(await uploadNow(b.id, "preview", tokens.returner));
    assert.equal(admissions, before);
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end("quit\n");
    await exited;
  }
});

test("a charge that waits for another charge's row lock never lowers the wait stored meanwhile", { timeout: 30_000 }, async () => {
  // A cooldown of 60 s after a 2 s grace period: a 408 owes 72 s.
  const cooldown = createBackupUploadCooldown({ cooldownSeconds: 60, graceSeconds: 2 });
  const errors = [];
  const request = {
    server: { prisma: app.prisma },
    user: { id: users.locked.id },
    log: { info() {}, error: (fields) => errors.push(fields) },
  };
  await cooldown.charge(request, 100);
  // Another charge holds the user's row, and while the next charge waits for
  // it, stores the full wait from its own, later clock reading.
  let locked;
  const isLocked = new Promise((resolve) => (locked = resolve));
  const holder = app.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "BackupUploadCooldown" WHERE "userId" = ${users.locked.id} FOR UPDATE`;
      locked();
      await sleep(1_500);
      await tx.$executeRaw`
        UPDATE "BackupUploadCooldown"
        SET "clearsAt" = (clock_timestamp() AT TIME ZONE 'UTC') + 72000 * interval '1 millisecond'
        WHERE "userId" = ${users.locked.id}
      `;
    },
    { timeout: 10_000 },
  );
  await isLocked;
  await sleep(100);
  const waiting = cooldown.charge(request, 10);
  await holder;
  await waiting;
  assert.deepEqual(errors, []);
  // Capped from the waiting charge's statement start instead, the stored
  // wait would be about 1.4 s shorter.
  const left = await owed(users.locked);
  assert.ok(left > 72_000 - 400, `owes ${Math.round(left)} ms`);
});
