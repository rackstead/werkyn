import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { png, webp } from "../fixtures/passive-media.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "blob-cleanup-integration-secret",
  COOKIE_SECRET: "blob-cleanup-cookie-secret",
});

let app, directory, address, workspace, project, admin, token;
const workspaces = [];
const api = (suffix, wid = workspace.id) => `/api/workspaces/${wid}${suffix}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function request(method, url, body, auth = true) {
  const response = await fetch(address + url, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    text: bytes.toString(),
    json: () => JSON.parse(bytes.toString()),
  };
}

const sweep = async (options) => {
  const { processBlobCleanup } = await import(
    "../../src/services/blob-cleanup.ts"
  );
  return processBlobCleanup(app.prisma, app.storage, options);
};
const exists = (storagePath) => app.storage.exists(storagePath);
async function present(paths) {
  const result = {};
  for (const storagePath of paths) result[storagePath] = await exists(storagePath);
  return result;
}
const all = (paths, value) =>
  Object.fromEntries(paths.map((storagePath) => [storagePath, value]));
async function queued(paths) {
  return app.prisma.$queryRaw`
    SELECT "storagePath", "attempts", "lastError" FROM "BlobCleanup"
    WHERE "storagePath" = ANY(${paths}) ORDER BY "storagePath"`;
}
async function makeDue(paths) {
  await app.prisma.$executeRaw`
    UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP - interval '1 second'
    WHERE "storagePath" = ANY(${paths})`;
}

async function blob(wid, extension = ".png", bytes = png) {
  return app.storage.save(
    `${wid}/files`,
    admin.id,
    crypto.randomUUID(),
    extension,
    bytes,
  );
}
async function makeFile(options = {}) {
  const wid = options.workspaceId ?? workspace.id;
  const storagePath = await blob(wid);
  const thumbnailPath = options.thumbnail
    ? await blob(wid, ".webp", webp)
    : null;
  return app.prisma.file.create({
    data: {
      workspaceId: wid,
      parentId: options.parentId ?? null,
      teamFolderId: options.teamFolderId ?? null,
      name: `${crypto.randomUUID()}.png`,
      mimeType: "image/png",
      size: png.length,
      storagePath,
      thumbnailPath,
      uploadedById: admin.id,
      ownerId: options.teamFolderId ? null : admin.id,
      trashedAt: options.trashedAt ?? null,
    },
  });
}
async function makeFolder(options = {}) {
  return app.prisma.file.create({
    data: {
      workspaceId: options.workspaceId ?? workspace.id,
      parentId: options.parentId ?? null,
      teamFolderId: options.teamFolderId ?? null,
      name: `folder-${crypto.randomUUID()}`,
      isFolder: true,
      uploadedById: admin.id,
      ownerId: options.teamFolderId ? null : admin.id,
      trashedAt: options.trashedAt ?? null,
    },
  });
}
const blobsOf = (...files) =>
  files.flatMap((file) =>
    [file.storagePath, file.thumbnailPath].filter(Boolean),
  );

async function makeWorkspace(name) {
  const created = await app.prisma.workspace.create({
    data: {
      name,
      slug: `blob-${crypto.randomUUID()}`,
      members: { create: { userId: admin.id, role: "ADMIN" } },
    },
  });
  workspaces.push(created.id);
  return created;
}
async function makeProject(wid) {
  return app.prisma.project.create({
    data: {
      workspaceId: wid,
      name: "Cleanup project",
      members: { create: { userId: admin.id } },
      statuses: { create: { name: "Open" } },
    },
    include: { statuses: true },
  });
}
async function makeTask(projectRow, title = "Attachment owner") {
  return app.prisma.task.create({
    data: {
      projectId: projectRow.id,
      statusId: projectRow.statuses[0].id,
      title,
    },
  });
}
async function legacyAttachment(wid, entityType, entityId) {
  const storagePath = await app.storage.save(
    "attachments",
    wid,
    crypto.randomUUID(),
    ".bin",
    Buffer.from(`legacy ${entityType} upload`),
  );
  return app.prisma.attachment.create({
    data: {
      workspaceId: wid,
      entityType,
      entityId,
      name: "legacy.bin",
      mimeType: "application/octet-stream",
      size: 20,
      storagePath,
      uploadedById: admin.id,
    },
  });
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "werkyn-blob-cleanup-"));
  process.env.STORAGE_DIR = directory;
  const { buildApp } = await import("../../src/app.ts");
  const { signAccessToken } = await import("../../src/utils/tokens.ts");
  app = await buildApp();
  await app.ready();
  admin = await app.prisma.user.create({
    data: {
      email: `blob-admin-${crypto.randomUUID()}@example.test`,
      displayName: "Cleanup admin",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: admin.id, email: admin.email });
  workspace = await makeWorkspace("Blob cleanup audit");
  project = await makeProject(workspace.id);
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: workspaces } },
      });
      if (admin) await app.prisma.user.delete({ where: { id: admin.id } });
    }
  } finally {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

test("deleting a nested folder removes every descendant original and thumbnail", async () => {
  const root = await makeFolder();
  const nested = await makeFolder({ parentId: root.id });
  const files = [
    await makeFile({ parentId: root.id, thumbnail: true }),
    await makeFile({ parentId: nested.id, thumbnail: true }),
    await makeFile({ parentId: nested.id }),
  ];
  const paths = blobsOf(...files);
  assert.equal(paths.length, 5);
  assert.deepEqual(await present(paths), all(paths, true));

  const response = await request("DELETE", api(`/files/${root.id}`));
  assert.equal(response.status, 204, response.text);

  assert.deepEqual(await present(paths), all(paths, false));
  assert.deepEqual(await queued(paths), []);
  assert.equal(
    await app.prisma.file.count({
      where: { id: { in: [root.id, nested.id, ...files.map((f) => f.id)] } },
    }),
    0,
  );
});

test("deleting a team folder removes its descendant originals and thumbnails", async () => {
  const root = await makeFolder();
  const teamFolder = await app.prisma.teamFolder.create({
    data: { workspaceId: workspace.id, folderId: root.id, name: "Team" },
  });
  await app.prisma.file.update({
    where: { id: root.id },
    data: { ownerId: null },
  });
  const nested = await makeFolder({
    parentId: root.id,
    teamFolderId: teamFolder.id,
  });
  const files = [
    await makeFile({
      parentId: root.id,
      teamFolderId: teamFolder.id,
      thumbnail: true,
    }),
    await makeFile({
      parentId: nested.id,
      teamFolderId: teamFolder.id,
      thumbnail: true,
    }),
  ];
  const paths = blobsOf(...files);

  const response = await request(
    "DELETE",
    api(`/team-folders/${teamFolder.id}`),
  );
  assert.equal(response.status, 204, response.text);

  assert.deepEqual(await present(paths), all(paths, false));
  assert.deepEqual(await queued(paths), []);
  assert.equal(
    await app.prisma.file.count({
      where: { id: { in: [root.id, nested.id, ...files.map((f) => f.id)] } },
    }),
    0,
  );
});

test("trash purge of a parent and its trashed child in one batch converges after a storage failure", async () => {
  const { processTrashPurge } = await import(
    "../../src/schedulers/trash-purge.ts"
  );
  const old = daysAgo(40);
  const parent = await makeFolder({ trashedAt: old });
  const child = await makeFile({
    parentId: parent.id,
    thumbnail: true,
    trashedAt: old,
  });
  const nestedFolder = await makeFolder({ parentId: parent.id, trashedAt: old });
  const grandchild = await makeFile({
    parentId: nestedFolder.id,
    thumbnail: true,
  });
  const loose = await makeFile({ thumbnail: true, trashedAt: old });
  const recent = await makeFile({ thumbnail: true, trashedAt: daysAgo(5) });

  // The child original fails with a non-ENOENT storage error on every try
  // until the fault is cleared.
  const failing = child.storagePath;
  const original = app.storage.delete;
  let injected = 0;
  app.storage.delete = async (storagePath) => {
    if (storagePath === failing) {
      injected++;
      throw Object.assign(new Error("Injected storage outage"), {
        code: "EIO",
      });
    }
    return original.call(app.storage, storagePath);
  };
  try {
    // The scheduled purge is global; another suite's leftover candidate may be
    // skipped, which is reported as an AggregateError after the whole run.
    await processTrashPurge(app.prisma, app.storage).catch((error) => {
      if (!(error instanceof AggregateError)) throw error;
    });
  } finally {
    app.storage.delete = original;
  }
  assert.ok(injected >= 1);

  const purgedIds = [parent.id, child.id, nestedFolder.id, grandchild.id, loose.id];
  assert.equal(
    await app.prisma.file.count({ where: { id: { in: purgedIds } } }),
    0,
  );
  const removed = blobsOf(grandchild, loose).concat(child.thumbnailPath);
  assert.deepEqual(await present(removed), all(removed, false));
  assert.equal(await exists(failing), true);
  const [pending] = await queued([failing]);
  assert.equal(pending.storagePath, failing);
  assert.ok(pending.attempts >= 1);
  assert.match(pending.lastError, /Injected storage outage/);
  assert.deepEqual(await queued(removed), []);
  // Recently trashed files and their blobs are untouched.
  assert.deepEqual(await present(blobsOf(recent)), all(blobsOf(recent), true));

  // Backoff keeps the failed path until it is due; then a retry converges.
  assert.equal((await sweep({ paths: [failing] })).claimed, 0);
  assert.equal(await exists(failing), true);
  await makeDue([failing]);
  const retried = await sweep({ paths: [failing] });
  assert.equal(retried.deleted, 1);
  assert.equal(await exists(failing), false);
  assert.deepEqual(await queued([failing]), []);
  // Repeating purge and sweep is a no-op.
  await processTrashPurge(app.prisma, app.storage).catch((error) => {
    if (!(error instanceof AggregateError)) throw error;
  });
  assert.equal((await sweep({ paths: [failing, ...removed] })).claimed, 0);
  assert.deepEqual(await present(blobsOf(recent)), all(blobsOf(recent), true));
});

test("a crash after the database commit leaves durable cleanup records that concurrent sweeps process once", async () => {
  // Rows removed outside any service (as if the process died right after the
  // commit) still record every original and thumbnail in the same transaction.
  const folder = await makeFolder();
  const files = [
    await makeFile({ thumbnail: true }),
    await makeFile({ parentId: folder.id, thumbnail: true }),
    await makeFile({ parentId: folder.id }),
  ];
  const paths = blobsOf(...files);
  await app.prisma.file.deleteMany({
    where: { id: { in: [folder.id, files[0].id] } },
  });
  assert.deepEqual(
    (await queued(paths)).map((row) => row.storagePath),
    [...paths].sort(),
  );
  assert.deepEqual(await present(paths), all(paths, true));

  // A blob that is already gone counts as cleaned up.
  await unlink(path.join(directory, paths[0]));
  // A worker that claimed one path and crashed holds it only until its lease
  // expires.
  const leased = paths[1];
  await app.prisma.$executeRaw`
    UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP + interval '15 minutes',
      "attempts" = "attempts" + 1
    WHERE "storagePath" = ${leased}`;

  const results = await Promise.all([
    sweep({ paths }),
    sweep({ paths }),
    sweep({ paths }),
  ]);
  assert.equal(
    results.reduce((sum, result) => sum + result.claimed, 0),
    paths.length - 1,
  );
  assert.equal(await exists(leased), true);
  assert.deepEqual(
    (await queued(paths)).map((row) => row.storagePath),
    [leased],
  );
  await makeDue([leased]);
  assert.equal((await sweep({ paths })).deleted, 1);
  assert.deepEqual(await present(paths), all(paths, false));
  assert.deepEqual(await queued(paths), []);
  assert.equal((await sweep({ paths })).claimed, 0);
});

test("a cleanup record never removes a blob that a live file still references", async () => {
  const live = await makeFile({ thumbnail: true });
  const paths = blobsOf(live);
  await app.prisma.$executeRaw`
    INSERT INTO "BlobCleanup" ("storagePath")
    SELECT unnest(${paths}::text[])`;
  const result = await sweep({ paths });
  assert.equal(result.claimed, 2);
  assert.equal(result.retained, 2);
  assert.deepEqual(await present(paths), all(paths, true));
  // The rows are kept (with backoff), not dropped.
  const kept = await queued(paths);
  assert.equal(kept.length, 2);
  for (const row of kept) assert.match(row.lastError, /live File/);
  assert.equal((await sweep({ paths })).claimed, 0);
  // Deleting the file makes the kept rows due again and removes both blobs.
  const removed = await request("DELETE", api(`/files/${live.id}`));
  assert.equal(removed.status, 204, removed.text);
  assert.deepEqual(await present(paths), all(paths, false));
  assert.deepEqual(await queued(paths), []);
});

test("a file deleted while a sweep holds its stale live check is still cleaned up", async () => {
  const live = await makeFile({ thumbnail: true });
  const paths = blobsOf(live);
  await app.prisma.$executeRaw`
    INSERT INTO "BlobCleanup" ("storagePath")
    SELECT unnest(${paths}::text[])`;
  // The File is deleted right after the sweep's live-file query returns, so
  // the sweep acts on a stale "still live" result while the delete trigger
  // finds the rows already queued.
  const racing = new Proxy(app.prisma, {
    get(target, key) {
      if (key === "file")
        return {
          findMany: async (args) => {
            const rows = await target.file.findMany(args);
            await target.file.delete({ where: { id: live.id } });
            return rows;
          },
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { processBlobCleanup } = await import(
    "../../src/services/blob-cleanup.ts"
  );
  const result = await processBlobCleanup(racing, app.storage, { paths });
  assert.equal(result.retained, 2);
  assert.equal(await app.prisma.file.count({ where: { id: live.id } }), 0);
  assert.deepEqual(await present(paths), all(paths, true));
  // No record is lost: the rows survive and a later sweep removes the blobs.
  assert.deepEqual(
    (await queued(paths)).map((row) => row.storagePath),
    [...paths].sort(),
  );
  await makeDue(paths);
  assert.equal((await sweep({ paths })).deleted, 2);
  assert.deepEqual(await present(paths), all(paths, false));
  assert.deepEqual(await queued(paths), []);
});

test("task, comment and workspace deletion cascade attachments and remove every owned blob", async () => {
  const other = await makeWorkspace("Cascade workspace");
  const otherProject = await makeProject(other.id);
  const task = await makeTask(otherProject);
  const survivor = await makeTask(otherProject, "Survivor");
  const comment = await app.prisma.comment.create({
    data: { taskId: task.id, authorId: admin.id, body: "with attachment" },
  });
  const drive = await makeFile({ workspaceId: other.id, thumbnail: true });
  const nestedFolder = await makeFolder({ workspaceId: other.id });
  const nested = await makeFile({
    workspaceId: other.id,
    parentId: nestedFolder.id,
    thumbnail: true,
  });
  const linked = await app.prisma.attachment.create({
    data: {
      workspaceId: other.id,
      entityType: "task",
      entityId: task.id,
      name: drive.name,
      mimeType: "image/png",
      size: png.length,
      storagePath: drive.storagePath,
      uploadedById: admin.id,
      fileId: drive.id,
    },
  });
  const taskLegacy = await legacyAttachment(other.id, "task", task.id);
  const commentLegacy = await legacyAttachment(other.id, "comment", comment.id);
  const survivorLegacy = await legacyAttachment(other.id, "task", survivor.id);

  const response = await request("DELETE", `/api/tasks/${task.id}`);
  assert.equal(response.status, 204, response.text);
  assert.equal(
    await app.prisma.attachment.count({
      where: { id: { in: [linked.id, taskLegacy.id, commentLegacy.id] } },
    }),
    0,
  );
  const legacy = [taskLegacy.storagePath, commentLegacy.storagePath];
  assert.deepEqual(
    (await queued([...legacy, ...blobsOf(drive)])).map(
      (row) => row.storagePath,
    ),
    [...legacy].sort(),
  );
  await sweep({ paths: legacy });
  assert.deepEqual(await present(legacy), all(legacy, false));
  // A linked Drive file belongs to Drive, not to the deleted task.
  assert.deepEqual(await present(blobsOf(drive)), all(blobsOf(drive), true));
  assert.ok(await app.prisma.file.findUnique({ where: { id: drive.id } }));

  const deleted = await request("DELETE", `/api/workspaces/${other.id}`);
  assert.equal(deleted.status, 204, deleted.text);
  const remaining = [
    ...blobsOf(drive, nested),
    survivorLegacy.storagePath,
  ];
  assert.deepEqual(
    (await queued(remaining)).map((row) => row.storagePath),
    [...remaining].sort(),
  );
  await sweep({ paths: remaining });
  assert.deepEqual(await present(remaining), all(remaining, false));
  assert.deepEqual(await queued(remaining), []);
});

test("missing content and legacy or SetNull attachments return intentional JSON errors", async () => {
  const task = await makeTask(project, "Missing content");
  const source = await makeFile({ thumbnail: true });
  const linked = await request("POST", api("/attachments/link"), {
    entityType: "task",
    entityId: task.id,
    fileId: source.id,
  });
  assert.equal(linked.status, 201, linked.text);
  const attachment = linked.json().data;
  const legacy = await legacyAttachment(workspace.id, "task", task.id);
  const shared = await request("POST", api("/files/share-links"), {
    fileIds: [source.id],
  });
  assert.equal(shared.status, 201, shared.text);
  const link = shared.json().data;

  await unlink(path.join(directory, source.storagePath));
  await unlink(path.join(directory, source.thumbnailPath));
  const filesBefore = await app.prisma.file.count({
    where: { workspaceId: workspace.id },
  });
  for (const [method, url, auth] of [
    ["GET", api(`/files/${source.id}/download?inline=true`), true],
    ["GET", api(`/files/${source.id}/thumbnail`), true],
    ["GET", api(`/attachments/${attachment.id}/download`), true],
    ["GET", `/api/public/files/${link.token}/${source.id}/download`, false],
    ["POST", api(`/files/${source.id}/copy`), true],
  ]) {
    const response = await request(
      method,
      url,
      method === "POST" ? { parentId: null } : undefined,
      auth,
    );
    assert.equal(response.status, 410, `${url}: ${response.text}`);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.json().message, "File content is no longer available");
    assert.doesNotMatch(response.text, /ENOENT|werkyn-blob-cleanup/);
  }
  assert.equal(
    await app.prisma.file.count({ where: { workspaceId: workspace.id } }),
    filesBefore,
  );

  const legacyDownload = await request(
    "GET",
    api(`/attachments/${legacy.id}/download`),
  );
  assert.equal(legacyDownload.status, 404, legacyDownload.text);
  assert.match(legacyDownload.headers.get("content-type"), /^application\/json/);

  // Deleting the Drive file leaves a SetNull placeholder, never a crash.
  const removed = await request("DELETE", api(`/files/${source.id}`));
  assert.equal(removed.status, 204, removed.text);
  const orphaned = await request(
    "GET",
    api(`/attachments/${attachment.id}/download`),
  );
  assert.equal(orphaned.status, 404, orphaned.text);
  assert.match(orphaned.headers.get("content-type"), /^application\/json/);
  const listed = await request(
    "GET",
    api(`/attachments?entityType=task&entityId=${task.id}`),
  );
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    listed
      .json()
      .data.map((row) => [row.name, row.fileId])
      .sort(),
    [
      ["Unavailable file", null],
      ["Unavailable file", null],
    ],
  );

  // Removing a legacy attachment removes the blob it owned.
  assert.equal(await exists(legacy.storagePath), true);
  const detached = await request("DELETE", api(`/attachments/${legacy.id}`));
  assert.equal(detached.status, 204, detached.text);
  assert.equal(await exists(legacy.storagePath), false);
  assert.deepEqual(await queued([legacy.storagePath]), []);
  assert.equal((await request("GET", "/api/health")).status, 200);
});

test("the background worker drains queued cleanup and stops gracefully", async () => {
  const { startBlobCleanupWorker } = await import(
    "../../src/services/blob-cleanup.ts"
  );
  const first = await makeFile({ thumbnail: true });
  await app.prisma.file.delete({ where: { id: first.id } });
  const worker = startBlobCleanupWorker(app, {
    initialDelayMs: 0,
    intervalMs: 50,
  });
  const deadline = Date.now() + 5_000;
  while ((await queued(blobsOf(first))).length > 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  await worker.stop();
  assert.deepEqual(await present(blobsOf(first)), all(blobsOf(first), false));

  const second = await makeFile({ thumbnail: true });
  await app.prisma.file.delete({ where: { id: second.id } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A stopped worker no longer touches storage; the record stays durable.
  assert.deepEqual(await present(blobsOf(second)), all(blobsOf(second), true));
  assert.equal((await queued(blobsOf(second))).length, 2);
  await sweep({ paths: blobsOf(second) });
  assert.deepEqual(await present(blobsOf(second)), all(blobsOf(second), false));
});
