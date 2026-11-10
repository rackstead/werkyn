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
process.env.JWT_SECRET = "avatar-cleanup-integration-jwt-secret";
process.env.COOKIE_SECRET = "avatar-cleanup-integration-cookie-secret";
process.env.LOG_LEVEL = "error";

const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-avatar-cleanup-"),
);
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

let app;
let workspace;
let space;
const users = [];

function multipart(fields, content = png, filename = "image.png") {
  const boundary = `audit-${crypto.randomUUID()}`;
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
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
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

async function createUser(name) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const user = await app.prisma.user.create({
    data: { email: `${name}-${suffix}@example.test`, displayName: name },
  });
  users.push(user);
  await app.prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "MEMBER" },
  });
  return {
    user,
    token: signAccessToken({ sub: user.id, email: user.email }),
  };
}

function upload(token, fields) {
  const body = multipart(fields);
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      "content-type": body.contentType,
      authorization: `Bearer ${token}`,
    },
    payload: body.payload,
  });
}

function patchProfile(token, payload) {
  return app.inject({
    method: "PATCH",
    url: "/api/users/me",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    payload,
  });
}

async function uploadAvatar(token) {
  const response = await upload(token, {
    workspaceId: workspace.id,
    purpose: "avatar",
  });
  assert.equal(response.statusCode, 201, response.body);
  const url = response.json().data.url;
  return { url, path: storagePathFromUrl(url) };
}

async function cleanupRows(paths) {
  return app.prisma.blobCleanup.findMany({
    where: { storagePath: { in: paths } },
    orderBy: { storagePath: "asc" },
    select: { storagePath: true, attempts: true, lastError: true },
  });
}

async function fileRows(paths) {
  return app.prisma.file.count({
    where: {
      OR: [{ storagePath: { in: paths } }, { thumbnailPath: { in: paths } }],
    },
  });
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
  throw new Error("profile update did not wait on the avatar cleanup lock");
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(4).toString("hex");
  workspace = await app.prisma.workspace.create({
    data: { name: "Avatar cleanup", slug: `avatar-cleanup-${suffix}` },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Notes", slug: "notes" },
  });
});

after(async () => {
  if (app) {
    const ids = users.map((user) => user.id);
    if (workspace) {
      await app.prisma.blobCleanup.deleteMany({
        where: { storagePath: { startsWith: `${workspace.id}/` } },
      });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    }
    if (ids.length > 0) {
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app.close();
  }
  await rm(storageDir, { recursive: true, force: true });
});

test("replacing a saved avatar queues the previous upload and leaves its bytes", async () => {
  const { user, token } = await createUser("ada");
  const unsaved = await uploadAvatar(token);
  const first = await uploadAvatar(token);
  assert.deepEqual(await cleanupRows([unsaved.path, first.path]), []);
  assert.equal(await fileRows([unsaved.path, first.path]), 0);
  assert.equal(await app.storage.exists(unsaved.path), true);
  assert.equal(await app.storage.exists(first.path), true);

  const saved = await patchProfile(token, { avatarUrl: first.url });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().data.avatarUrl, first.url);
  assert.deepEqual(
    await cleanupRows([unsaved.path, first.path]),
    [],
    "a first avatar replaces nothing",
  );

  const same = await patchProfile(token, {
    avatarUrl: first.url,
    displayName: "Ada same",
  });
  assert.equal(same.statusCode, 200, same.body);
  assert.deepEqual(await cleanupRows([unsaved.path, first.path]), []);

  const named = await patchProfile(token, { displayName: "Ada named" });
  assert.equal(named.statusCode, 200, named.body);
  assert.equal(named.json().data.avatarUrl, first.url);
  assert.deepEqual(await cleanupRows([unsaved.path, first.path]), []);

  const second = await uploadAvatar(token);
  const replaced = await patchProfile(token, { avatarUrl: second.url });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().data.avatarUrl, second.url);
  const stored = await app.prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { avatarUrl: true },
  });
  assert.equal(stored.avatarUrl, second.url);

  const rows = await cleanupRows([unsaved.path, first.path, second.path]);
  assert.deepEqual(
    rows.map((row) => row.storagePath),
    [first.path],
    `cleanup=${JSON.stringify(rows)} fileRows=${await fileRows([unsaved.path, first.path, second.path])}`,
  );
  assert.equal(rows[0].attempts, 0);
  assert.equal(await app.storage.exists(first.path), true);
  assert.equal(await app.storage.exists(second.path), true);
  assert.equal(await app.storage.exists(unsaved.path), true);
  assert.equal(await fileRows([unsaved.path, first.path, second.path]), 0);

  const untouched = await patchProfile(token, {
    displayName: "Ada after",
    jobTitle: "Builder",
  });
  assert.equal(untouched.statusCode, 200, untouched.body);
  assert.equal(untouched.json().data.avatarUrl, second.url);
  assert.deepEqual(
    (await cleanupRows([unsaved.path, first.path, second.path])).map(
      (row) => row.storagePath,
    ),
    [first.path],
  );

  const repeated = await patchProfile(token, { avatarUrl: second.url });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.deepEqual(
    (await cleanupRows([unsaved.path, first.path, second.path])).map(
      (row) => row.storagePath,
    ),
    [first.path],
  );
});

test("null, unchanged, external, and wiki avatar values are not queued", async () => {
  const { user, token } = await createUser("bea");
  const ownAvatarPaths = {
    storagePath: { startsWith: `${workspace.id}/uploads/avatars/${user.id}/` },
  };
  const external = await patchProfile(token, {
    avatarUrl: "https://cdn.example.test/face.png",
  });
  assert.equal(external.statusCode, 200, external.body);
  assert.equal(await app.prisma.blobCleanup.count({ where: ownAvatarPaths }), 0);

  const stillExternal = await patchProfile(token, {
    avatarUrl: "https://cdn.example.test/other.png",
  });
  assert.equal(stillExternal.statusCode, 200, stillExternal.body);

  const avatar = await uploadAvatar(token);
  const saved = await patchProfile(token, { avatarUrl: avatar.url });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(await cleanupRows([avatar.path]), []);

  const wiki = await upload(token, {
    workspaceId: workspace.id,
    purpose: "wiki",
    spaceId: space.id,
  });
  assert.equal(wiki.statusCode, 201, wiki.body);
  const wikiUrl = wiki.json().data.url;
  const wikiPath = storagePathFromUrl(wikiUrl);
  const asAvatar = await patchProfile(token, { avatarUrl: wikiUrl });
  assert.equal(asAvatar.statusCode, 200, asAvatar.body);
  assert.deepEqual(
    (await cleanupRows([avatar.path, wikiPath])).map((row) => row.storagePath),
    [avatar.path],
  );

  const cleared = await patchProfile(token, { avatarUrl: null });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().data.avatarUrl, null);
  assert.deepEqual(
    (await cleanupRows([avatar.path, wikiPath])).map((row) => row.storagePath),
    [avatar.path],
  );
  assert.equal(await app.storage.exists(wikiPath), true);
  assert.equal(await app.storage.exists(avatar.path), true);
  assert.equal(await fileRows([avatar.path, wikiPath]), 0);
});

test("the sweeper deletes a replaced avatar and keeps one a profile still names", async () => {
  const owner = await createUser("cyra");
  const sharer = await createUser("dina");
  const first = await uploadAvatar(owner.token);
  const second = await uploadAvatar(owner.token);
  assert.equal(
    (await patchProfile(owner.token, { avatarUrl: first.url })).statusCode,
    200,
  );
  assert.equal(
    (await patchProfile(owner.token, { avatarUrl: second.url })).statusCode,
    200,
  );
  assert.equal(
    (await patchProfile(sharer.token, { avatarUrl: first.url })).statusCode,
    200,
  );

  const shared = await processBlobCleanup(app.prisma, app.storage, {
    paths: [first.path, second.path],
  });
  assert.deepEqual(
    { claimed: shared.claimed, deleted: shared.deleted, retained: shared.retained },
    { claimed: 1, deleted: 0, retained: 1 },
  );
  assert.equal(await app.storage.exists(first.path), true);
  const kept = await app.prisma.blobCleanup.findUniqueOrThrow({
    where: { storagePath: first.path },
  });
  assert.match(kept.lastError ?? "", /live avatar/);

  const replacement = await uploadAvatar(sharer.token);
  assert.equal(
    (await patchProfile(sharer.token, { avatarUrl: replacement.url })).statusCode,
    200,
  );
  const cleaned = await processBlobCleanup(app.prisma, app.storage, {
    paths: [first.path, second.path, replacement.path],
  });
  assert.equal(cleaned.deleted, 1);
  assert.equal(await app.storage.exists(first.path), false);
  assert.equal(
    await app.prisma.blobCleanup.count({ where: { storagePath: first.path } }),
    0,
  );
  assert.equal(await app.storage.exists(second.path), true);
  assert.equal(await app.storage.exists(replacement.path), true);
  assert.deepEqual(await cleanupRows([second.path, replacement.path]), []);
});

test("switching back to the previous avatar keeps those bytes", async () => {
  const { token } = await createUser("elle");
  const first = await uploadAvatar(token);
  const second = await uploadAvatar(token);
  assert.equal((await patchProfile(token, { avatarUrl: first.url })).statusCode, 200);
  assert.equal((await patchProfile(token, { avatarUrl: second.url })).statusCode, 200);
  assert.equal((await patchProfile(token, { avatarUrl: first.url })).statusCode, 200);

  const beforeSweep = await cleanupRows([first.path, second.path]);
  assert.deepEqual(
    beforeSweep.map((row) => row.storagePath).sort(),
    [first.path, second.path].sort(),
  );
  assert.equal(await app.storage.exists(first.path), true);
  assert.equal(await app.storage.exists(second.path), true);

  const swept = await processBlobCleanup(app.prisma, app.storage, {
    paths: [first.path, second.path],
  });
  assert.equal(swept.retained >= 1, true, JSON.stringify(swept));
  assert.equal(await app.storage.exists(first.path), true);
  assert.equal(await app.storage.exists(second.path), false);
  const kept = await app.prisma.blobCleanup.findUniqueOrThrow({
    where: { storagePath: first.path },
  });
  assert.match(kept.lastError ?? "", /live avatar/);
  assert.equal(
    await app.prisma.blobCleanup.count({ where: { storagePath: second.path } }),
    0,
  );
});

test("a profile that adopts a queued avatar before the sweep locks it keeps the bytes", async () => {
  const { user, token } = await createUser("gia");
  const first = await uploadAvatar(token);
  const second = await uploadAvatar(token);
  assert.equal((await patchProfile(token, { avatarUrl: first.url })).statusCode, 200);
  assert.equal((await patchProfile(token, { avatarUrl: second.url })).statusCode, 200);

  const entered = deferred();
  let release = () => {};
  const sweeping = processBlobCleanup(app.prisma, app.storage, {
    paths: [first.path],
    beforeAvatarDecision: async (storagePath) => {
      assert.equal(storagePath, first.path);
      entered.resolve();
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    await entered.promise;
    const adopted = await patchProfile(token, { avatarUrl: first.url });
    assert.equal(adopted.statusCode, 200, adopted.body);
  } finally {
    release();
  }
  const swept = await sweeping;
  assert.equal(swept.deleted, 0);
  assert.equal(swept.retained, 1);
  assert.equal(await app.storage.exists(first.path), true);
  assert.equal(
    (await app.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true },
    })).avatarUrl,
    first.url,
  );
  const kept = await app.prisma.blobCleanup.findUniqueOrThrow({
    where: { storagePath: first.path },
  });
  assert.match(kept.lastError ?? "", /live avatar/);
});

test("a sweep already deleting an avatar rejects a switch back and keeps the saved profile", { timeout: 15_000 }, async () => {
  const { user, token } = await createUser("fay");
  const first = await uploadAvatar(token);
  const second = await uploadAvatar(token);
  assert.equal((await patchProfile(token, { avatarUrl: first.url })).statusCode, 200);
  assert.equal((await patchProfile(token, { avatarUrl: second.url })).statusCode, 200);

  const entered = deferred();
  let release = () => {};
  const sweeping = processBlobCleanup(app.prisma, {
    delete: async (storagePath) => {
      assert.equal(storagePath, first.path);
      entered.resolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      await app.storage.delete(storagePath);
    },
  }, { paths: [first.path] });
  let patching;
  try {
    await entered.promise;
    patching = patchProfile(token, { avatarUrl: first.url });
    await waitForCleanupLock();
  } finally {
    release();
  }
  const [swept, patch] = await Promise.all([sweeping, patching]);
  assert.equal(swept.deleted, 1, JSON.stringify(swept));
  assert.equal(patch.statusCode, 409, patch.body);
  assert.equal(await app.storage.exists(first.path), false);
  assert.equal(await app.storage.exists(second.path), true);
  assert.equal(
    (await app.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true },
    })).avatarUrl,
    second.url,
  );
  assert.equal(
    await app.prisma.blobCleanup.count({ where: { storagePath: first.path } }),
    0,
  );
});
