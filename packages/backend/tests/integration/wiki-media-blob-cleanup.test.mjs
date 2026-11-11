import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "wiki-media-cleanup-integration-jwt-secret";
process.env.COOKIE_SECRET = "wiki-media-cleanup-integration-cookie-secret";
process.env.LOG_LEVEL = "error";

const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-wiki-media-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");
const { wikiStoragePath } = await import(
  "../../src/modules/uploads/wiki-storage-path.ts"
);

const bytes = Buffer.from("wiki-media-bytes");

let app;
let workspace;
let space;
let token;
let user;

function multipart(fields, content = bytes, filename = "shot.png") {
  const boundary = `wiki-media-${crypto.randomUUID()}`;
  const fieldsBuffer = Buffer.from(
    Object.entries(fields)
      .map(
        ([name, value]) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      )
      .join(""),
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      fieldsBuffer,
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function storagePathFromUrl(url) {
  assert.equal(url.startsWith("/storage/"), true, url);
  return url.slice("/storage/".length);
}

function imageDoc(url) {
  return [
    {
      type: "columnList",
      props: {},
      children: [
        {
          type: "image",
          props: { url, name: "shot.png" },
          children: [],
        },
      ],
    },
  ];
}

function textDoc(text) {
  return [{ type: "paragraph", content: text }];
}

async function uploadWiki() {
  const body = multipart({
    workspaceId: workspace.id,
    purpose: "wiki",
    spaceId: space.id,
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": body.contentType,
    },
    payload: body.payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  const url = response.json().data.url;
  const storagePath = storagePathFromUrl(url);
  assert.equal(wikiStoragePath(url), storagePath);
  return { url, storagePath };
}

function api(method, url, payload) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

async function createPage(title, content) {
  const response = await api(
    "POST",
    `/api/wiki/spaces/${space.id}/pages`,
    { title, content },
  );
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data;
}

async function updatePage(pageId, content, expectedRevision) {
  const response = await api("PATCH", `/api/wiki/pages/${pageId}`, {
    content,
    expectedRevision,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}

async function cleanupRow(storagePath) {
  return app.prisma.blobCleanup.findUnique({ where: { storagePath } });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForCleanupLock() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await app.prisma.$queryRaw`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'`;
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("page save did not wait on the wiki cleanup lock");
}

/** Upload, save it onto a page, then remove it with no version left naming it. */
async function uploadThenDrop() {
  const page = await createPage("Race", textDoc("empty"));
  const uploaded = await uploadWiki();
  const withImage = await updatePage(
    page.id,
    imageDoc(uploaded.url),
    page.revision,
  );
  const dropped = await updatePage(
    withImage.id,
    textDoc("gone"),
    withImage.revision,
  );
  const queued = await cleanupRow(uploaded.storagePath);
  assert.ok(queued, "dropping the last reference queues the blob");
  assert.equal(queued.attempts, 0);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    0,
  );
  assert.equal(
    await app.prisma.wikiVersionMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    0,
  );
  return { page: dropped, uploaded };
}

function assertGrace(row) {
  assert.ok(row, "expected a grace row");
  assert.equal(row.attempts, 0);
  const delay = row.availableAt.getTime() - Date.now();
  assert.ok(delay > 45 * 60 * 1000 && delay < 75 * 60 * 1000, String(delay));
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(4).toString("hex");
  user = await app.prisma.user.create({
    data: { email: `wiki-media-${suffix}@example.test`, displayName: "Wiki" },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: { name: "Wiki media", slug: `wiki-media-${suffix}` },
  });
  await app.prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Notes", slug: "notes" },
  });
});

after(async () => {
  if (app) {
    if (workspace) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.blobCleanup.deleteMany({
        where: { storagePath: { startsWith: `${workspace.id}/` } },
      });
    }
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
    await app.close();
  }
  await rm(storageDir, { recursive: true, force: true });
});

test("a wiki upload is grace-queued and a page save that names it consumes the row", async () => {
  const before = await app.prisma.blobCleanup.count({
    where: { storagePath: { startsWith: `${workspace.id}/uploads/wiki/` } },
  });
  const missingSpace = multipart({
    workspaceId: workspace.id,
    purpose: "wiki",
  });
  const refused = await app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": missingSpace.contentType,
    },
    payload: missingSpace.payload,
  });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(
    await app.prisma.blobCleanup.count({
      where: { storagePath: { startsWith: `${workspace.id}/uploads/wiki/` } },
    }),
    before,
  );

  const uploaded = await uploadWiki();
  assertGrace(await cleanupRow(uploaded.storagePath));
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  const early = await processBlobCleanup(app.prisma, app.storage, {
    paths: [uploaded.storagePath],
  });
  assert.equal(early.claimed, 0);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);

  const mixed = `/Storage/${uploaded.url.slice("/storage/".length)}`;
  assert.equal(wikiStoragePath(mixed), uploaded.storagePath);
  const wrongCase = mixed.replace("/uploads/wiki/", "/uploads/Wiki/");
  assert.equal(wikiStoragePath(wrongCase), null);
  const nested = imageDoc(mixed);
  const [extracted] = await app.prisma.$queryRaw`
    SELECT wiki_media_storage_paths(${JSON.stringify(nested)}::jsonb) AS paths
  `;
  assert.deepEqual(extracted.paths, [uploaded.storagePath]);
  const [missed] = await app.prisma.$queryRaw`
    SELECT wiki_media_storage_paths(${JSON.stringify(imageDoc(wrongCase))}::jsonb) AS paths
  `;
  assert.deepEqual(missed.paths, []);

  const page = await createPage("Shot", nested);
  assert.equal(await cleanupRow(uploaded.storagePath), null);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath, pageId: page.id },
    }),
    1,
  );

  await app.prisma.blobCleanup.create({
    data: {
      storagePath: uploaded.storagePath,
      availableAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  const named = await api("POST", `/api/wiki/pages/${page.id}/versions`, {
    name: "Kept",
  });
  assert.equal(named.statusCode, 201, named.body);
  assert.equal(await cleanupRow(uploaded.storagePath), null);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    await app.prisma.wikiVersionMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    1,
  );
});

test("removing an image a version still names does not queue or delete it", async () => {
  const uploaded = await uploadWiki();
  const mixed = `/Storage/${uploaded.url.slice("/storage/".length)}`;
  const page = await createPage("Versioned", imageDoc(mixed));
  assert.equal(await cleanupRow(uploaded.storagePath), null);

  const saved = await updatePage(page.id, textDoc("no image"), page.revision);
  assert.equal(JSON.stringify(saved.content).includes(uploaded.storagePath), false);
  const versions = await app.prisma.wikiPageVersion.findMany({
    where: { pageId: page.id },
  });
  assert.equal(versions.length, 1);
  assert.equal(
    JSON.stringify(versions[0].content).includes(`/Storage/${uploaded.storagePath}`),
    true,
  );
  assert.equal(await cleanupRow(uploaded.storagePath), null);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    await app.prisma.wikiVersionMedia.count({
      where: { storagePath: uploaded.storagePath, versionId: versions[0].id },
    }),
    1,
  );
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath, pageId: page.id },
    }),
    0,
  );

  await app.prisma.blobCleanup.create({
    data: { storagePath: uploaded.storagePath },
  });
  const [plan] = await app.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('enable_seqscan', 'off', true)`;
    return tx.$queryRaw`
      EXPLAIN (FORMAT JSON)
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM "WikiPageMedia" WHERE "storagePath" = ${uploaded.storagePath}
      ) OR EXISTS (
        SELECT 1 FROM "WikiVersionMedia" WHERE "storagePath" = ${uploaded.storagePath}
      )
    `;
  });
  const explained = JSON.stringify(plan["QUERY PLAN"]);
  assert.match(explained, /WikiVersionMedia_pkey|WikiPageMedia_pkey/);
  assert.doesNotMatch(explained, /Seq Scan on "WikiPage"/);
  assert.doesNotMatch(explained, /Seq Scan on "WikiPageVersion"/);

  const swept = await processBlobCleanup(app.prisma, app.storage, {
    paths: [uploaded.storagePath],
  });
  assert.equal(swept.deleted, 0, JSON.stringify(swept));
  assert.equal(swept.retained, 1, JSON.stringify(swept));
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  const kept = await cleanupRow(uploaded.storagePath);
  assert.match(kept?.lastError ?? "", /wiki content/);
});

test("an edit that drops the last reference queues one row and leaves the bytes", async () => {
  const page = await createPage("Draft", textDoc("empty"));
  const uploaded = await uploadWiki();
  assertGrace(await cleanupRow(uploaded.storagePath));
  const withImage = await updatePage(
    page.id,
    imageDoc(uploaded.url),
    page.revision,
  );
  assert.equal(await cleanupRow(uploaded.storagePath), null);
  const versions = await app.prisma.wikiPageVersion.findMany({
    where: { pageId: page.id },
  });
  assert.equal(versions.length, 1);
  assert.equal(
    JSON.stringify(versions[0].content).includes(uploaded.storagePath),
    false,
  );

  await updatePage(withImage.id, textDoc("gone"), withImage.revision);
  const queued = await cleanupRow(uploaded.storagePath);
  assert.ok(queued, "the last reference queues a cleanup row");
  assert.equal(queued.attempts, 0);
  assert.ok(queued.availableAt.getTime() <= Date.now() + 5_000);
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    0,
  );
  assert.equal(
    await app.prisma.wikiVersionMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    0,
  );

  const swept = await processBlobCleanup(app.prisma, app.storage, {
    paths: [uploaded.storagePath],
  });
  assert.equal(swept.deleted, 1, JSON.stringify(swept));
  assert.equal(await app.storage.exists(uploaded.storagePath), false);
  assert.equal(await cleanupRow(uploaded.storagePath), null);
});

test("deleting the last page queues the blob and keeps one another page still names", async () => {
  const shared = await uploadWiki();
  const only = await uploadWiki();
  const keeper = await createPage("Keeper", imageDoc(shared.url));
  const doomed = await createPage(
    "Doomed",
    imageDoc(shared.url).concat(imageDoc(only.url)),
  );
  assert.equal(await cleanupRow(shared.storagePath), null);
  assert.equal(await cleanupRow(only.storagePath), null);

  const removed = await api("DELETE", `/api/wiki/pages/${doomed.id}`);
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(await cleanupRow(shared.storagePath), null);
  assert.equal(await app.storage.exists(shared.storagePath), true);
  assert.equal(await app.storage.exists(only.storagePath), true);
  const queued = await cleanupRow(only.storagePath);
  assert.ok(queued);
  assert.equal(queued.attempts, 0);

  const removedKeeper = await api("DELETE", `/api/wiki/pages/${keeper.id}`);
  assert.equal(removedKeeper.statusCode, 204, removedKeeper.body);
  assert.ok(await cleanupRow(shared.storagePath));
  assert.equal(await app.storage.exists(shared.storagePath), true);
  assert.equal(await app.storage.exists(only.storagePath), true);

  const swept = await processBlobCleanup(app.prisma, app.storage, {
    paths: [shared.storagePath, only.storagePath],
  });
  assert.equal(swept.deleted, 2, JSON.stringify(swept));
  assert.equal(await app.storage.exists(shared.storagePath), false);
  assert.equal(await app.storage.exists(only.storagePath), false);
  assert.equal(await cleanupRow(shared.storagePath), null);
  assert.equal(await cleanupRow(only.storagePath), null);
});

test("a page that puts a queued wiki image back before the sweep locks it keeps the bytes", async () => {
  const { page, uploaded } = await uploadThenDrop();
  const entered = deferred();
  let release = () => {};
  const sweeping = processBlobCleanup(app.prisma, app.storage, {
    paths: [uploaded.storagePath],
    beforeWikiDecision: async (storagePath) => {
      assert.equal(storagePath, uploaded.storagePath);
      entered.resolve();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await entered.promise;
  let saved;
  try {
    saved = await api("PATCH", `/api/wiki/pages/${page.id}`, {
      content: imageDoc(uploaded.url),
      expectedRevision: page.revision,
    });
  } finally {
    release();
  }
  assert.equal(saved.statusCode, 200, saved.body);
  const swept = await sweeping;
  assert.equal(swept.deleted, 0, JSON.stringify(swept));
  assert.equal(await app.storage.exists(uploaded.storagePath), true);
  assert.equal(
    JSON.stringify(saved.json().data.content).includes(uploaded.storagePath),
    true,
  );
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath, pageId: page.id },
    }),
    1,
  );
  assert.equal(await cleanupRow(uploaded.storagePath), null);
});

test("a sweep already deleting a wiki image rejects putting it back", { timeout: 15_000 }, async () => {
  const { page, uploaded } = await uploadThenDrop();
  const entered = deferred();
  let release = () => {};
  const sweeping = processBlobCleanup(
    app.prisma,
    {
      delete: async (storagePath) => {
        assert.equal(storagePath, uploaded.storagePath);
        entered.resolve();
        await new Promise((resolve) => {
          release = resolve;
        });
        await app.storage.delete(storagePath);
      },
    },
    { paths: [uploaded.storagePath] },
  );
  let saving;
  try {
    await entered.promise;
    saving = api("PATCH", `/api/wiki/pages/${page.id}`, {
      content: imageDoc(uploaded.url),
      expectedRevision: page.revision,
    });
    await waitForCleanupLock();
  } finally {
    release();
  }
  const [swept, saved] = await Promise.all([sweeping, saving]);
  assert.equal(swept.deleted, 1, JSON.stringify(swept));
  assert.equal(saved.statusCode, 409, saved.body);
  assert.equal(await app.storage.exists(uploaded.storagePath), false);
  const stored = await app.prisma.wikiPage.findUniqueOrThrow({
    where: { id: page.id },
    select: { content: true, revision: true },
  });
  assert.equal(stored.revision, page.revision);
  assert.equal(JSON.stringify(stored.content).includes(uploaded.storagePath), false);
  assert.equal(
    await app.prisma.wikiPageMedia.count({
      where: { storagePath: uploaded.storagePath },
    }),
    0,
  );
  assert.equal(await cleanupRow(uploaded.storagePath), null);
});
