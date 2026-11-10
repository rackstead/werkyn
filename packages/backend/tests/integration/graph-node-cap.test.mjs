// Folder and wiki walks must ask the database for only the descendants still
// allowed by maxNodes, plus one sentinel. A 409 after loading every child is
// the old bug, so these tests record the child findMany take, the rows Prisma
// returned, and the LIMIT in the SQL.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import { recordQueries } from "./support/query-events.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );

const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-node-cap-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "graph-node-cap-jwt-secret",
  COOKIE_SECRET: "graph-node-cap-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { graphLimits } = await import("../../src/utils/graph-limits.ts");
const { collectDescendantFiles, archiveFiles } = await import(
  "../../src/modules/files/files.service.ts"
);
const { deletePage } = await import(
  "../../src/modules/wiki/wiki-pages.service.ts"
);
const { MissingBlobError } = await import("../../src/services/storage.ts");

const FOLDER_TOO_LARGE = "Folder tree exceeds the supported depth or size";
const PAGE_TOO_LARGE = "Page tree exceeds the supported depth or size";

const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const base = new PrismaClient({
  datasourceUrl: observerUrl.toString(),
  log: [{ level: "query", emit: "event" }],
});
const childReads = [];
const observed = base.$extends({
  query: {
    file: {
      async findMany({ args, query }) {
        const rows = await query(args);
        note("File", args, rows);
        return rows;
      },
    },
    wikiPage: {
      async findMany({ args, query }) {
        const rows = await query(args);
        note("WikiPage", args, rows);
        return rows;
      },
    },
  },
});

function note(model, args, rows) {
  const where = args?.where;
  if (
    !where ||
    typeof where !== "object" ||
    !Object.prototype.hasOwnProperty.call(where, "parentId")
  )
    return;
  childReads.push({
    model,
    take: Object.prototype.hasOwnProperty.call(args, "take") ? args.take : null,
    returned: rows.length,
    ids: rows.map((row) => row.id),
  });
}

let app;
let token;
let user;
let ws;
let requests = 0;
let names = 0;

function label(prefix) {
  names += 1;
  return `${prefix}-${names}`;
}

before(async () => {
  assert.equal(graphLimits.maxDepth, 256);
  assert.equal(graphLimits.maxNodes, 50_000);
  await base.$connect();
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(4).toString("hex");
  user = await app.prisma.user.create({
    data: {
      email: `node-cap-${suffix}@example.test`,
      displayName: "Node cap",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  ws = await app.prisma.workspace.create({
    data: {
      name: "Node cap",
      slug: `node-cap-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  graphLimits.maxDepth = 256;
  graphLimits.maxNodes = 50_000;
  try {
    if (app && ws) {
      await app.prisma.file.updateMany({
        where: { workspaceId: ws.id },
        data: { parentId: null },
      });
      await app.prisma.wikiPage.updateMany({
        where: { space: { workspaceId: ws.id } },
        data: { parentId: null },
      });
      await app.prisma.workspace.delete({ where: { id: ws.id } });
      await app.prisma.blobCleanup.deleteMany({
        where: { storagePath: { contains: ws.id } },
      });
    }
    if (app && user)
      await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  } finally {
    await Promise.allSettled([base.$disconnect(), app?.close()]);
    await rm(storageDir, { recursive: true, force: true });
  }
});

function access() {
  return {
    workspaceId: ws.id,
    userId: user.id,
    workspaceRole: "ADMIN",
  };
}

function capped(nodes) {
  const saved = {
    maxDepth: graphLimits.maxDepth,
    maxNodes: graphLimits.maxNodes,
  };
  graphLimits.maxDepth = 256;
  graphLimits.maxNodes = nodes;
  return () => {
    graphLimits.maxDepth = saved.maxDepth;
    graphLimits.maxNodes = saved.maxNodes;
  };
}

async function watched(run) {
  childReads.length = 0;
  let error;
  let value;
  const recorded = await recordQueries(base, async () => {
    try {
      value = await run();
    } catch (err) {
      error = err;
    }
  });
  return {
    events: recorded.events,
    reads: childReads.splice(0, childReads.length),
    error,
    value,
  };
}

async function withoutBlobReads(run) {
  const readStream = app.storage.readStream;
  const openReadStream = app.storage.openReadStream;
  let reads = 0;
  app.storage.readStream = function (...args) {
    reads += 1;
    return readStream.apply(this, args);
  };
  app.storage.openReadStream = function (...args) {
    reads += 1;
    return openReadStream.apply(this, args);
  };
  try {
    return { value: await run(), reads };
  } finally {
    app.storage.readStream = readStream;
    app.storage.openReadStream = openReadStream;
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parentLevelSql(events, table) {
  return events.filter((event) => {
    const query = event.query;
    return (
      query.includes(`"${table}"`) && /"parentId"\s*(IN|=)/.test(query)
    );
  });
}

function limitValue(event) {
  const params = JSON.parse(event.params);
  const bound = /LIMIT\s+\$(\d+)/i.exec(event.query);
  if (bound) return Number(params[Number(bound[1]) - 1]);
  const literal = /LIMIT\s+(\d+)/i.exec(event.query);
  return literal ? Number(literal[1]) : null;
}

function assertLevel(events, reads, model, table, expected) {
  const got = reads
    .filter((read) => read.model === model)
    .map((read) => ({ take: read.take, returned: read.returned }));
  assert.deepEqual(got, expected, JSON.stringify(reads));
  const sql = parentLevelSql(events, table);
  const described = sql
    .map((event) => `limit=${limitValue(event)} ${event.query}`)
    .join("\n");
  assert.equal(
    sql.length,
    expected.length,
    described || events.map((event) => event.query).join("\n---\n"),
  );
  expected.forEach((item, index) => {
    assert.equal(limitValue(sql[index]), item.take, sql[index].query);
    assert.ok(
      item.returned <= item.take,
      `${item.returned} rows for take ${item.take}`,
    );
    assert.notEqual(item.returned, 4);
    assert.notEqual(item.take, null);
  });
}

async function call(method, url, payload) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.97.${Math.floor(++requests / 200)}.${(requests % 200) + 1}`,
  });
  let body = null;
  if (response.body) {
    try {
      body = response.json();
    } catch {
      body = response.rawPayload;
    }
  }
  return {
    status: response.statusCode,
    body,
    raw: response.rawPayload,
    headers: response.headers,
  };
}

function assertJsonRefusal(response, status, message) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.match(String(response.headers["content-type"]), /application\/json/);
  assert.equal(response.body.error, status === 410 ? "Gone" : "Conflict");
  assert.equal(response.body.message, message);
  assert.equal(response.raw.subarray(0, 2).equals(Buffer.from("PK")), false);
}

async function folder(name, parentId = null) {
  return app.prisma.file.create({
    data: {
      workspaceId: ws.id,
      parentId,
      name,
      isFolder: true,
      uploadedById: user.id,
      ownerId: user.id,
    },
  });
}

async function file(parentId, name, blob = "none") {
  let storagePath;
  let body;
  if (blob === "present") {
    body = `body:${name}`;
    storagePath = await app.storage.save(
      "files",
      ws.id,
      crypto.randomBytes(8).toString("hex"),
      ".txt",
      Buffer.from(body),
    );
  } else if (blob === "missing") {
    storagePath = `files/${ws.id}/missing-${crypto.randomBytes(6).toString("hex")}.txt`;
  }
  const row = await app.prisma.file.create({
    data: {
      workspaceId: ws.id,
      parentId,
      name,
      isFolder: false,
      uploadedById: user.id,
      ownerId: user.id,
      mimeType: "text/plain",
      ...(storagePath ? { storagePath } : {}),
    },
  });
  return { ...row, body };
}

async function wideFolder(name, count = 4, blob = "none") {
  const root = await folder(label(name));
  const children = [];
  for (let i = 0; i < count; i++)
    children.push(await file(root.id, `${root.name}-${i}.txt`, blob));
  return { root, children };
}

async function nestedFolder(name, leafCount = 4, blob = "none") {
  const root = await folder(label(name));
  const mid = await folder(`${root.name}-mid`, root.id);
  const leaves = [];
  for (let i = 0; i < leafCount; i++)
    leaves.push(await file(mid.id, `${mid.name}-${i}.txt`, blob));
  return { root, mid, leaves };
}

async function space() {
  const slug = `ncap-${crypto.randomBytes(4).toString("hex")}`;
  return app.prisma.wikiSpace.create({
    data: { workspaceId: ws.id, name: slug, slug },
  });
}

async function page(spaceId, title, parentId = null, position = 0) {
  return app.prisma.wikiPage.create({
    data: {
      spaceId,
      parentId,
      title,
      position,
      createdById: user.id,
    },
  });
}

async function widePage(count) {
  const wiki = await space();
  const root = await page(wiki.id, label("page"));
  const children = [];
  for (let i = 0; i < count; i++)
    children.push(await page(wiki.id, `${root.title}-${i}`, root.id, i));
  return { wiki, root, children };
}

async function nestedPage(leafCount) {
  const wiki = await space();
  const root = await page(wiki.id, label("nested-page"));
  const mid = await page(wiki.id, `${root.title}-mid`, root.id, 0);
  const leaves = [];
  for (let i = 0; i < leafCount; i++)
    leaves.push(await page(wiki.id, `${mid.title}-${i}`, mid.id, i));
  return { wiki, root, mid, leaves };
}

test("four direct children are not loaded when maxNodes is 2, and the walks still return 409", async () => {
  assert.equal(graphLimits.maxNodes, 50_000);
  assert.equal(graphLimits.maxDepth, 256);
  const restore = capped(2);
  try {
    const drive = await wideFolder("wide");
    const nestedDrive = await nestedFolder("nested");
    const wiki = await widePage(4);
    const nestedWiki = await nestedPage(4);
    const packed = await wideFolder("pack");
    const nestedPacked = await nestedFolder("nested-pack");

    const guarded = await withoutBlobReads(async () => {
      const collected = await watched(() =>
        collectDescendantFiles(observed, drive.root.id, access()),
      );
      const nestedCollected = await watched(() =>
        collectDescendantFiles(observed, nestedDrive.root.id, access()),
      );
      const deleted = await watched(() =>
        deletePage(observed, ws.id, user.id, wiki.root.id),
      );
      const nestedDeleted = await watched(() =>
        deletePage(observed, ws.id, user.id, nestedWiki.root.id),
      );
      const archived = await watched(() =>
        archiveFiles(observed, app.storage, ws.id, [packed.root.id], access()),
      );
      const nestedArchived = await watched(() =>
        archiveFiles(
          observed,
          app.storage,
          ws.id,
          [nestedPacked.root.id],
          access(),
        ),
      );
      return {
        collected,
        nestedCollected,
        deleted,
        nestedDeleted,
        archived,
        nestedArchived,
      };
    });
    assert.equal(guarded.reads, 0);

    const { collected, nestedCollected, deleted, nestedDeleted, archived, nestedArchived } =
      guarded.value;
    assert.equal(collected.error?.statusCode, 409);
    assert.equal(collected.error?.message, FOLDER_TOO_LARGE);
    assertLevel(collected.events, collected.reads, "File", "File", [
      { take: 3, returned: 3 },
    ]);
    assert.equal(collected.reads[0].ids.length, 3);
    assert.equal(drive.children.length, 4);
    for (const id of collected.reads[0].ids)
      assert.ok(drive.children.some((child) => child.id === id));

    assert.equal(nestedCollected.error?.message, FOLDER_TOO_LARGE);
    assertLevel(nestedCollected.events, nestedCollected.reads, "File", "File", [
      { take: 3, returned: 1 },
      { take: 2, returned: 2 },
    ]);
    assert.equal(nestedDrive.leaves.length, 4);

    assert.equal(deleted.error?.statusCode, 409);
    assert.equal(deleted.error?.message, PAGE_TOO_LARGE);
    assertLevel(deleted.events, deleted.reads, "WikiPage", "WikiPage", [
      { take: 3, returned: 3 },
    ]);
    assert.equal(nestedDeleted.error?.message, PAGE_TOO_LARGE);
    assertLevel(nestedDeleted.events, nestedDeleted.reads, "WikiPage", "WikiPage", [
      { take: 3, returned: 1 },
      { take: 2, returned: 2 },
    ]);

    assert.equal(archived.error?.statusCode, 409);
    assert.equal(archived.error?.message, FOLDER_TOO_LARGE);
    assert.equal(archived.value, undefined);
    assertLevel(archived.events, archived.reads, "File", "File", [
      { take: 3, returned: 3 },
    ]);
    assert.equal(nestedArchived.error?.message, FOLDER_TOO_LARGE);
    assertLevel(nestedArchived.events, nestedArchived.reads, "File", "File", [
      { take: 3, returned: 1 },
      { take: 2, returned: 2 },
    ]);

    const http = await withoutBlobReads(async () => {
      const driveDelete = await call(
        "DELETE",
        `/api/workspaces/${ws.id}/files/${drive.root.id}`,
      );
      const wikiDelete = await call("DELETE", `/api/wiki/pages/${wiki.root.id}`);
      const archive = await call(
        "POST",
        `/api/workspaces/${ws.id}/files/archive`,
        { fileIds: [packed.root.id] },
      );
      return { driveDelete, wikiDelete, archive };
    });
    assert.equal(http.reads, 0);
    assertJsonRefusal(http.value.driveDelete, 409, FOLDER_TOO_LARGE);
    assertJsonRefusal(http.value.wikiDelete, 409, PAGE_TOO_LARGE);
    assertJsonRefusal(http.value.archive, 409, FOLDER_TOO_LARGE);

    assert.equal(
      await app.prisma.file.count({ where: { parentId: drive.root.id } }),
      4,
    );
    assert.equal(
      await app.prisma.wikiPage.count({ where: { parentId: wiki.root.id } }),
      4,
    );
    assert.ok(await app.prisma.wikiPage.findUnique({ where: { id: wiki.root.id } }));
    assert.equal(
      await app.prisma.file.count({ where: { parentId: packed.root.id } }),
      4,
    );
  } finally {
    restore();
  }
});

test("a tree at exactly maxNodes still succeeds", async () => {
  const restore = capped(2);
  try {
    const drive = await wideFolder("exact", 2);
    const wiki = await widePage(2);
    const wikiHttp = await widePage(2);
    const packed = await wideFolder("exact-pack", 2, "present");

    const collected = await watched(() =>
      collectDescendantFiles(observed, drive.root.id, access()),
    );
    assert.equal(collected.error, undefined);
    assert.equal(collected.value.length, 2);
    assert.deepEqual(
      collected.value.map((row) => row.id).sort(),
      drive.children.map((row) => row.id).sort(),
    );
    assertLevel(collected.events, collected.reads, "File", "File", [
      { take: 3, returned: 2 },
      { take: 1, returned: 0 },
    ]);

    const removed = await call(
      "DELETE",
      `/api/workspaces/${ws.id}/files/${drive.root.id}`,
    );
    assert.equal(removed.status, 204, JSON.stringify(removed.body));
    assert.equal(
      await app.prisma.file.count({
        where: { id: { in: [drive.root.id, ...drive.children.map((row) => row.id)] } },
      }),
      0,
    );

    const deleted = await watched(() =>
      deletePage(observed, ws.id, user.id, wiki.root.id),
    );
    assert.equal(deleted.error, undefined);
    assert.equal(deleted.value.id, wiki.root.id);
    assertLevel(deleted.events, deleted.reads, "WikiPage", "WikiPage", [
      { take: 3, returned: 2 },
      { take: 1, returned: 0 },
    ]);
    assert.equal(
      await app.prisma.wikiPage.count({ where: { spaceId: wiki.wiki.id } }),
      0,
    );
    const wikiRoute = await call(
      "DELETE",
      `/api/wiki/pages/${wikiHttp.root.id}`,
    );
    assert.equal(wikiRoute.status, 204, JSON.stringify(wikiRoute.body));
    assert.equal(
      await app.prisma.wikiPage.count({ where: { id: wikiHttp.root.id } }),
      0,
    );

    const archived = await withoutBlobReads(async () => {
      const result = await watched(() =>
        archiveFiles(observed, app.storage, ws.id, [packed.root.id], access()),
      );
      assert.equal(result.error, undefined);
      result.bytes = await readAll(result.value.stream);
      return result;
    });
    assert.ok(archived.reads > 0);
    assertLevel(archived.value.events, archived.value.reads, "File", "File", [
      { take: 3, returned: 2 },
    ]);
    const zip = new AdmZip(archived.value.bytes);
    for (const child of packed.children)
      assert.equal(zip.readAsText(`${packed.root.name}/${child.name}`), child.body);

    const httpArchive = await call(
      "POST",
      `/api/workspaces/${ws.id}/files/archive`,
      { fileIds: [packed.root.id] },
    );
    assert.equal(httpArchive.status, 200, httpArchive.raw?.toString());
    assert.equal(httpArchive.headers["content-type"], "application/zip");
    const httpZip = new AdmZip(httpArchive.raw);
    for (const child of packed.children)
      assert.equal(
        httpZip.readAsText(`${packed.root.name}/${child.name}`),
        child.body,
      );
  } finally {
    restore();
  }
});

test("an under-cap folder with a missing blob is still 410 before any zip byte", async () => {
  const restore = capped(2);
  try {
    const packed = await wideFolder("missing", 1, "missing");
    const guarded = await withoutBlobReads(async () => {
      const archived = await watched(() =>
        archiveFiles(observed, app.storage, ws.id, [packed.root.id], access()),
      );
      const http = await call(
        "POST",
        `/api/workspaces/${ws.id}/files/archive`,
        { fileIds: [packed.root.id] },
      );
      return { archived, http };
    });
    assert.equal(guarded.reads, 0);
    assert.equal(guarded.value.archived.error instanceof MissingBlobError, true);
    assert.equal(guarded.value.archived.error.statusCode, 410);
    assert.equal(
      guarded.value.archived.error.message,
      "File content is no longer available",
    );
    assert.equal(guarded.value.archived.value, undefined);
    assertLevel(
      guarded.value.archived.events,
      guarded.value.archived.reads,
      "File",
      "File",
      [{ take: 3, returned: 1 }],
    );
    assertJsonRefusal(
      guarded.value.http,
      410,
      "File content is no longer available",
    );
    assert.equal(
      await app.prisma.file.count({ where: { parentId: packed.root.id } }),
      1,
    );
  } finally {
    restore();
  }
});
