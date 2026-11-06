import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "attachment-policy-owned-test-signing-secret",
  COOKIE_SECRET: "attachment-policy-owned-test-cookie-secret",
});

const isolation = {
  "content-security-policy": "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const bytes = Buffer.from("Ordinary attachment policy fixture.\n");
const filename = "Résumé – notes.txt";
const actors = ["OWNER", "VIEWER", "TARGET_DENIED", "SOURCE_DENIED", "OUTSIDER"];
const ids = Object.fromEntries([
  ...actors.map(actor => [actor, crypto.randomUUID()]),
  ...["workspace", "otherWorkspace", "project", "status", "task", "comment", "healthyFile", "missingFile", "unknownAttachment"].map(key => [key, crypto.randomUUID()]),
]);
const healthyPath = `${ids.workspace}/files/${ids.OWNER}/${ids.healthyFile}.txt`;
const missingPath = `${ids.workspace}/files/${ids.OWNER}/${ids.missingFile}.txt`;
const ownedPaths = [healthyPath, missingPath];
const suffix = crypto.randomUUID();
const users = {}, tokens = {}, links = {}, familyIds = new Set();
const secrets = new Set([process.env.JWT_SECRET, process.env.COOKIE_SECRET]);
const observations = [];
const effects = Object.fromEntries(["openReadStream", "readStream", "read", "save", "saveStream", "delete", "exists"].map(key => [key, 0]));
const requests = new Set(), streamReaders = new Set();
const streamErrors = [];
let app, address, directory, ownershipFile, writesPlanned = false;
let cleanupBlobsNow;

function safeJSON(value) {
  const text = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
  for (const secret of secrets) assert.equal(text.includes(secret), false, "Fixture evidence excludes credentials");
  return text;
}
async function checkpoint(label, actual) {
  const record = { label, actual, at: new Date().toISOString() };
  observations.push(record);
  if (process.env.ATTACHMENT_POLICY_OBSERVATIONS_FILE)
    await writeFile(process.env.ATTACHMENT_POLICY_OBSERVATIONS_FILE, safeJSON({ observations }) + "\n", { mode: 0o600 });
  return record;
}
async function ownership(label, extra = {}) {
  if (!ownershipFile) return;
  await writeFile(ownershipFile, safeJSON({ version: 1, label, ids, familyIds: [...familyIds], links,
    storageDirectory: directory, ownedPaths, writesPlanned, ...extra }) + "\n", { mode: 0o600 });
}
function policy(response) {
  return Object.fromEntries(Object.keys(isolation).map(name => [name, response.headers.get(name)]));
}
function bodyShape(response) {
  if (!/^application\/json\b/.test(response.headers.get("content-type") ?? ""))
    return { json: false, exactFixtureBytes: response.bytes.equals(bytes), empty: response.bytes.length === 0 };
  let body;
  try { body = JSON.parse(response.bytes.toString()); }
  catch { return { json: true, parseSucceeded: false }; }
  return { json: true, parseSucceeded: true,
    keys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : [],
    statusCode: typeof body?.statusCode === "number" ? body.statusCode : null,
    messagePresent: typeof body?.message === "string",
    missingContentMessage: body?.message === "File content is no longer available" };
}
function api(suffix, workspaceId = ids.workspace) {
  return `/api/workspaces/${workspaceId}${suffix}`;
}
function download(id, query = "", workspaceId = ids.workspace) {
  return api(`/attachments/${id}/download${query}`, workspaceId);
}
async function request(method, url, actor = "OWNER", payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const operation = (async () => {
    const response = await fetch(address + url, {
      method, signal: controller.signal,
      headers: { ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
  })();
  requests.add(operation);
  try { return await operation; }
  finally { clearTimeout(timer); controller.abort(); requests.delete(operation); }
}
async function settleStreams() {
  const pending = [...streamReaders];
  const result = await Promise.all(pending);
  assert.deepEqual(streamErrors, [], "Owned ordinary read streams settle normally");
  return result;
}
async function state() {
  return {
    files: await app.prisma.file.findMany({ where: { id: { in: [ids.healthyFile, ids.missingFile] } }, orderBy: { id: "asc" } }),
    attachments: await app.prisma.attachment.findMany({ where: { workspaceId: ids.workspace }, orderBy: { id: "asc" } }),
    shares: await app.prisma.fileShare.findMany({ where: { workspaceId: ids.workspace }, orderBy: { id: "asc" } }),
    notifications: await app.prisma.notification.count({ where: { userId: { in: actors.map(actor => ids[actor]) } } }),
    activity: await app.prisma.activityLog.count({ where: { taskId: ids.task } }),
  };
}
const counters = () => ({ ...effects });
function delta(before) {
  return Object.fromEntries(Object.keys(effects).map(key => [key, effects[key] - before[key]]));
}
async function observe(t, label, response, before, expectedReads) {
  await settleStreams();
  const rows = await state(), effectDelta = delta(before.effects);
  const actual = { status: response.status, policy: policy(response), contentType: response.headers.get("content-type"),
    disposition: response.headers.get("content-disposition"), byteLength: response.bytes.length, bodyShape: bodyShape(response), effectDelta,
    rowsUnchanged: safeJSON(rows) === safeJSON(before.rows), rows };
  await checkpoint(label, actual); t.diagnostic(safeJSON({ label, ...actual }));
  assert.deepEqual(rows, before.rows);
  // openReadStream opens the blob itself (it no longer goes through readStream).
  assert.deepEqual(effectDelta, { openReadStream: expectedReads, readStream: 0, read: 0, save: 0, saveStream: 0, delete: 0, exists: 0 });
  return actual;
}
async function snapshot() { return { rows: await state(), effects: counters() }; }
async function requirePolicy(label, actual) {
  await checkpoint(`${label}-ordinary-controls-before-policy`, { ordinaryControlsPassed: true });
  assert.deepEqual(actual.policy, isolation);
}
function assertFileResponse(response, expectedName, head = false) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  const disposition = response.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]), expectedName);
  assert.deepEqual(response.bytes, head ? Buffer.alloc(0) : bytes);
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "werkyn-attachment-policy-"));
  ownershipFile = process.env.ATTACHMENT_POLICY_OWNERSHIP_FILE ?? path.join(directory, "fixture-ownership.json");
  process.env.STORAGE_DIR = directory;
  const { buildApp } = await import("../../src/app.ts");
  const { signAccessToken } = await import("../../src/utils/tokens.ts");
  const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");
  ({ cleanupBlobsNow } = await import("../../src/services/blob-cleanup.ts"));
  app = await buildApp(); await app.ready();
  const actualIdentity = await app.prisma.$queryRawUnsafe(`SELECT current_database()::text AS database, current_user::text AS role, pg_get_userbyid(datdba)::text AS owner FROM pg_database WHERE datname=current_database()`);
  const selectedURL = new URL(process.env.TEST_DATABASE_URL);
  await checkpoint("database-identity-before-assert", actualIdentity);
  assert.equal(actualIdentity.length, 1);
  assert.equal(actualIdentity[0].database, decodeURIComponent(selectedURL.pathname.slice(1)));
  assert.equal(actualIdentity[0].role, decodeURIComponent(selectedURL.username));
  assert.equal(actualIdentity[0].owner, actualIdentity[0].role);
  const conflicts = await app.prisma.user.count({ where: { id: { in: actors.map(actor => ids[actor]) } } });
  await checkpoint("preallocated-identity-collision-check", { conflicts }); assert.equal(conflicts, 0);
  writesPlanned = true; await ownership("owned-identities-and-paths-before-first-write", { actualIdentity });
  for (const actor of actors) {
    users[actor] = await app.prisma.user.create({ data: { id: ids[actor], email: `policy-${actor.toLowerCase()}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    const session = await startRefreshSession(app.prisma, ids[actor]);
    familyIds.add(session.familyId); secrets.add(session.refreshToken);
    tokens[actor] = signAccessToken({ sub: ids[actor], email: users[actor].email, sid: session.familyId });
    secrets.add(tokens[actor]); await ownership(`normal-session-${actor}`);
  }
  await app.prisma.workspace.create({ data: { id: ids.workspace, name: "Attachment policy fixture", slug: `policy-${suffix}`,
    members: { create: actors.filter(actor => actor !== "OUTSIDER").map(actor => ({ userId: ids[actor], role: actor === "VIEWER" ? "VIEWER" : "MEMBER" })) } } });
  await app.prisma.workspace.create({ data: { id: ids.otherWorkspace, name: "Other owned workspace", slug: `policy-other-${suffix}`,
    members: { create: { userId: ids.OUTSIDER, role: "ADMIN" } } } });
  await app.prisma.project.create({ data: { id: ids.project, workspaceId: ids.workspace, name: "Current target project",
    members: { create: ["OWNER", "VIEWER", "SOURCE_DENIED"].map(actor => ({ userId: ids[actor] })) } } });
  await app.prisma.statusColumn.create({ data: { id: ids.status, projectId: ids.project, name: "Open" } });
  await app.prisma.task.create({ data: { id: ids.task, projectId: ids.project, statusId: ids.status, title: "Unassigned discussion task" } });
  await app.prisma.comment.create({ data: { id: ids.comment, taskId: ids.task, authorId: ids.OWNER, body: "Ordinary text fixture" } });
  const saved = await app.storage.save(`${ids.workspace}/files`, ids.OWNER, ids.healthyFile, ".txt", bytes);
  await checkpoint("owned-healthy-path-before-assert", { saved, planned: healthyPath }); assert.equal(saved, healthyPath);
  for (const [id, storagePath, name] of [[ids.healthyFile, healthyPath, filename], [ids.missingFile, missingPath, "Missing owned notes.txt"]])
    await app.prisma.file.create({ data: { id, workspaceId: ids.workspace, ownerId: ids.OWNER, uploadedById: ids.OWNER, name, mimeType: "text/plain", size: bytes.length, storagePath } });
  for (const actor of ["VIEWER", "TARGET_DENIED"])
    await app.prisma.fileShare.create({ data: { workspaceId: ids.workspace, fileId: ids.healthyFile, sharedById: ids.OWNER, sharedWithId: ids[actor] } });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  for (const [label, entityType, entityId, fileId] of [["task", "task", ids.task, ids.healthyFile], ["comment", "comment", ids.comment, ids.healthyFile], ["missing", "task", ids.task, ids.missingFile]]) {
    const response = await request("POST", api("/attachments/link"), "OWNER", { entityType, entityId, fileId });
    await checkpoint(`link-${label}-status-before-assert`, { status: response.status }); assert.equal(response.status, 201);
    links[label] = JSON.parse(response.bytes.toString()).data.id; await ownership(`linked-${label}`);
  }
  for (const name of Object.keys(effects)) {
    const original = app.storage[name].bind(app.storage);
    app.storage[name] = (...args) => {
      effects[name]++;
      if (name !== "openReadStream") return original(...args);
      return original(...args).then(stream => {
        const timer = setTimeout(() => stream.destroy(new Error("Owned text stream exceeded its fixture bound")), 5000);
        const read = finished(stream, { cleanup: true }).then(() => ({ settled: true }), error => {
          streamErrors.push({ name: error.name }); stream.destroy(); return { settled: false };
        }).finally(() => clearTimeout(timer));
        streamReaders.add(read); void read.finally(() => streamReaders.delete(read));
        return stream;
      });
    };
  }
  await ownership("fixture-ready");
});

after(async () => {
  const failures = [];
  try { await Promise.allSettled([...requests]); await settleStreams(); }
  catch (error) { failures.push({ phase: "request-stream-collection", name: error.name }); }
  try {
    if (app && writesPlanned) {
      const actualFamilies = await app.prisma.refreshTokenFamily.findMany({ where: { userId: { in: actors.map(actor => ids[actor]) } }, select: { id: true } });
      for (const family of actualFamilies) familyIds.add(family.id);
      await ownership("before-known-fixture-cleanup");
      await app.prisma.attachment.deleteMany({ where: { workspaceId: ids.workspace, fileId: { in: [ids.healthyFile, ids.missingFile] } } });
      await app.prisma.task.deleteMany({ where: { id: ids.task, projectId: ids.project } });
      await app.prisma.workspace.deleteMany({ where: { id: { in: [ids.workspace, ids.otherWorkspace] } } });
      await app.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: [...familyIds] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: actors.map(actor => ids[actor]) } } });
      await cleanupBlobsNow(app.prisma, app.storage, ownedPaths);
      const remaining = { users: await app.prisma.user.count({ where: { id: { in: actors.map(actor => ids[actor]) } } }),
        workspaces: await app.prisma.workspace.count({ where: { id: { in: [ids.workspace, ids.otherWorkspace] } } }),
        files: await app.prisma.file.count({ where: { id: { in: [ids.healthyFile, ids.missingFile] } } }),
        attachments: await app.prisma.attachment.count({ where: { workspaceId: ids.workspace } }),
        cleanup: await app.prisma.blobCleanup.count({ where: { storagePath: { in: ownedPaths } } }) };
      await checkpoint("known-fixture-final-counts-before-assert", remaining);
      assert.equal(Object.values(remaining).every(count => count === 0), true);
    }
  } catch (error) { failures.push({ phase: "known-fixture-cleanup", name: error.name }); }
  finally {
    try { await app?.close(); } catch (error) { failures.push({ phase: "app-close", name: error.name }); }
    if (directory) await rm(directory, { recursive: true, force: true });
    await checkpoint("fixture-cleanup-final", { failures });
  }
  assert.deepEqual(failures, []);
});

test("task attachment GET preserves text bytes and Unicode forced download with the isolation policy", { timeout: 15000 }, async t => {
  const before = await snapshot(), response = await request("GET", download(links.task));
  const actual = await observe(t, "task-get", response, before, 1);
  assertFileResponse(response, filename); await requirePolicy("task-get", actual);
});
test("granted VIEWER comment attachment inline alias remains a forced text download with the isolation policy", { timeout: 15000 }, async t => {
  const before = await snapshot(), response = await request("GET", download(links.comment, "?inline=true"), "VIEWER");
  const actual = await observe(t, "viewer-comment-alias", response, before, 1);
  assertFileResponse(response, filename); await requirePolicy("viewer-comment-alias", actual);
});
test("automatic attachment HEAD preserves forced download headers with the isolation policy", { timeout: 15000 }, async t => {
  const before = await snapshot(), response = await request("HEAD", download(links.task));
  const actual = await observe(t, "automatic-head", response, before, 1);
  assertFileResponse(response, filename, true); await requirePolicy("automatic-head", actual);
});

for (const item of [
  { label: "missing attachment", actor: "OWNER", status: 404, id: () => ids.unknownAttachment, reads: 0 },
  { label: "missing owned content", actor: "OWNER", status: 410, id: () => links.missing, reads: 1 },
  { label: "source denied", actor: "SOURCE_DENIED", status: 403, id: () => links.task, reads: 0 },
  { label: "target denied with source grant", actor: "TARGET_DENIED", status: 403, id: () => links.task, reads: 0 },
  { label: "unauthenticated pre-handler", actor: null, status: 401, id: () => links.task, reads: 0 },
  { label: "workspace denied pre-handler", actor: "OUTSIDER", status: 403, id: () => links.task, reads: 0 },
  { label: "nonmatching permitted workspace", actor: "OUTSIDER", status: 404, id: () => links.task, workspace: ids.otherWorkspace, reads: 0 },
]) test(`attachment ${item.label} retains ordinary JSON and the isolation policy`, { timeout: 15000 }, async t => {
  const before = await snapshot(), response = await request("GET", download(item.id(), "", item.workspace), item.actor);
  const actual = await observe(t, item.label, response, before, item.reads);
  assert.equal(response.status, item.status); assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(response.headers.get("content-disposition"), null);
  const body = JSON.parse(response.bytes.toString()); assert.equal(body.statusCode, item.status);
  for (const ownedPath of ownedPaths) assert.equal(response.bytes.includes(Buffer.from(ownedPath)), false);
  if (item.status === 410) assert.equal(body.message, "File content is no longer available");
  const healthy = await request("GET", "/api/live", null); assert.equal(healthy.status, 200);
  assert.deepEqual(await state(), before.rows);
  await requirePolicy(item.label, actual);
});

test("legitimate Drive text download is an unchanged positive policy control", { timeout: 15000 }, async t => {
  const before = await snapshot(), response = await request("GET", api(`/files/${ids.healthyFile}/download`));
  const actual = await observe(t, "drive-control", response, before, 1);
  assertFileResponse(response, filename); await requirePolicy("drive-control", actual);
});
test("attachment metadata and liveness retain their separate application response policy", { timeout: 15000 }, async t => {
  const before = await snapshot();
  const response = await request("GET", api(`/attachments?entityType=task&entityId=${ids.task}`));
  const actual = await observe(t, "metadata-control", response, before, 0);
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.equal(JSON.parse(response.bytes.toString()).data.some(row => row.id === links.task), true);
  assert.match(actual.policy["content-security-policy"], /default-src 'self'/);
  assert.notEqual(actual.policy["content-security-policy"], isolation["content-security-policy"]);
  const healthy = await request("GET", "/api/live", null); assert.equal(healthy.status, 200);
  assert.notEqual(healthy.headers.get("content-security-policy"), isolation["content-security-policy"]);
});
