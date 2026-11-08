import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "drive-share-token-integration-jwt-secret",
  COOKIE_SECRET: "drive-share-token-integration-cookie-secret",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-drive-share-tokens-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { shareGrantCookieName } =
  await import("../../src/utils/share-grants.ts");

const PASSWORD = "Share-token-password";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
let app, owner, ownerToken, workspace;
let requestNumber = 0;

function request(method, url, { payload, cookie, auth = false } = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: {
      ...(auth ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    // The public validation route allows ten attempts per client per minute.
    remoteAddress: `10.61.${Math.floor(++requestNumber / 250)}.${(requestNumber % 250) + 1}`,
  });
}
const createLink = (payload) =>
  request("POST", `/api/workspaces/${workspace.id}/files/share-links`, {
    payload,
    auth: true,
  });

async function makeFile(label) {
  const content = Buffer.from(`drive-token-bytes-${label}-${crypto.randomUUID()}`);
  const storagePath = await app.storage.save(
    "files",
    workspace.id,
    crypto.randomUUID(),
    ".txt",
    content,
  );
  const file = await app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: `Token source ${label}.txt`,
      mimeType: "text/plain",
      storagePath,
      size: content.length,
      uploadedById: owner.id,
      ownerId: owner.id,
    },
  });
  return { ...file, content };
}

// Links created before this change: same table, shorter tokens.
async function insertExistingLink(token, files, data = {}) {
  return app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      token,
      files: { create: files.map((file) => ({ fileId: file.id })) },
      ...data,
    },
  });
}

async function workspaceRows() {
  return {
    links: await app.prisma.fileShareLink.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { id: "asc" },
    }),
    joins: await app.prisma.fileShareLinkFile.findMany({
      where: { shareLink: { workspaceId: workspace.id } },
      orderBy: { id: "asc" },
    }),
  };
}

// The module that called randomBytes directly (frame 0 is this wrapper).
const directCaller = (stack) => stack.split("\n")[2] ?? "";

/**
 * Replaces crypto.randomBytes while `body` runs. `draw(size, index)` may
 * return the bytes for the index-th share-token draw; returning undefined
 * keeps the real CSPRNG. Returns the token draws and password-salt draws
 * observed, identified by the module that called randomBytes directly.
 */
async function withRandomBytes(draw, body) {
  const original = crypto.randomBytes;
  const tokenDraws = [];
  let saltDraws = 0;
  crypto.randomBytes = function patchedRandomBytes(size, callback) {
    const caller = directCaller(new Error().stack ?? "");
    if (typeof callback !== "function" && caller.includes("passwords.ts"))
      saltDraws++;
    if (
      typeof callback === "function" ||
      !caller.includes("file-shares.service.ts")
    )
      return original.call(crypto, size, callback);
    const forced = draw(size, tokenDraws.length);
    const bytes = forced ?? original.call(crypto, size);
    tokenDraws.push({ size, bytes: Buffer.from(bytes), forced: !!forced });
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    const result = await body();
    return { result, tokenDraws, saltDraws };
  } finally {
    crypto.randomBytes = original;
    syncBuiltinESMExports();
  }
}

async function publicView(token, cookie) {
  return request("GET", `/api/public/files/${token}`, { cookie });
}
async function publicDownload(token, fileId, cookie) {
  return request("GET", `/api/public/files/${token}/${fileId}/download`, {
    cookie,
  });
}
async function verify(token, password) {
  const response = await request(
    "POST",
    `/api/public/files/${token}/validate`,
    { payload: { password } },
  );
  const name = shareGrantCookieName("files", token);
  const raw = [response.headers["set-cookie"] ?? []].flat();
  const grant = raw.find((value) => value.startsWith(`${name}=`));
  return { response, cookie: grant?.split(";")[0] };
}
function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
}

/** Public metadata, grants, download bytes, disable and delete over HTTP. */
async function assertPublicLifecycle(link, file, { protectedLink }) {
  const { token } = link;
  let cookie;
  if (protectedLink) {
    const locked = await publicView(token);
    assert.equal(locked.statusCode, 200, locked.body);
    assertPrivate(locked);
    assert.deepEqual(locked.json().data, {
      files: [],
      createdBy: null,
      hasPassword: true,
      authorized: false,
      createdAt: null,
    });
    const blocked = await publicDownload(token, file.id);
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert(!blocked.body.includes(file.content.toString()));
    const wrong = await verify(token, "Wrong-password");
    assert.equal(wrong.response.statusCode, 403, wrong.response.body);
    assert.equal(wrong.cookie, undefined);
    const right = await verify(token, PASSWORD);
    assert.equal(right.response.statusCode, 200, right.response.body);
    assert(right.cookie, "verification must issue the share grant cookie");
    cookie = right.cookie;
  }
  const view = await publicView(token, cookie);
  assert.equal(view.statusCode, 200, view.body);
  assertPrivate(view);
  assert.equal(view.json().data.authorized, true);
  assert.equal(view.json().data.hasPassword, protectedLink);
  assert.deepEqual(
    view.json().data.files.map((entry) => entry.file.id),
    [file.id],
  );
  const download = await publicDownload(token, file.id, cookie);
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, file.content);

  const disabled = await request(
    "PATCH",
    `/api/workspaces/${workspace.id}/file-share-links/${link.id}`,
    { payload: { enabled: false }, auth: true },
  );
  assert.equal(disabled.statusCode, 200, disabled.body);
  for (const response of [
    await publicView(token, cookie),
    await publicDownload(token, file.id, cookie),
    (await verify(token, PASSWORD)).response,
  ])
    assert.equal(response.statusCode, 404, response.body);

  const enabled = await request(
    "PATCH",
    `/api/workspaces/${workspace.id}/file-share-links/${link.id}`,
    { payload: { enabled: true }, auth: true },
  );
  assert.equal(enabled.statusCode, 200, enabled.body);
  if (protectedLink) {
    // Re-enabling advances the credential revision: the old grant is spent.
    const stale = await publicDownload(token, file.id, cookie);
    assert.equal(stale.statusCode, 403, stale.body);
    cookie = (await verify(token, PASSWORD)).cookie;
  }
  const restored = await publicDownload(token, file.id, cookie);
  assert.equal(restored.statusCode, 200, restored.body);

  const deleted = await request(
    "DELETE",
    `/api/workspaces/${workspace.id}/file-share-links/${link.id}`,
    { auth: true },
  );
  assert.equal(deleted.statusCode, 204, deleted.body);
  for (const response of [
    await publicView(token, cookie),
    await publicDownload(token, file.id, cookie),
  ])
    assert.equal(response.statusCode, 404, response.body);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  owner = await app.prisma.user.create({
    data: {
      email: `drive-token-${crypto.randomUUID()}@example.test`,
      displayName: "Drive token owner",
      emailVerified: true,
    },
  });
  ownerToken = signAccessToken({ sub: owner.id, email: owner.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Drive share tokens",
      slug: crypto.randomUUID(),
      members: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  try {
    if (app && workspace)
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (app && owner)
      await app.prisma.user.delete({ where: { id: owner.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("new links carry a 43-character token that is exactly 32 CSPRNG bytes", async () => {
  const file = await makeFile("entropy");
  const issued = new Set();
  for (let i = 0; i < 12; i++) {
    const { result: response, tokenDraws } = await withRandomBytes(
      () => undefined,
      () => createLink({ fileIds: [file.id] }),
    );
    assert.equal(response.statusCode, 201, response.body);
    const link = response.json().data;
    assert.match(link.token, TOKEN);
    const decoded = Buffer.from(link.token, "base64url");
    assert.equal(decoded.length, 32);
    assert.equal(decoded.toString("base64url"), link.token);
    assert.equal(encodeURIComponent(link.token), link.token);
    // One draw per link, and the token is that draw, untruncated.
    assert.deepEqual(
      tokenDraws.map((entry) => entry.size),
      [32],
    );
    assert(tokenDraws[0].bytes.equals(decoded));
    assert(!("passwordHash" in link));
    assert.equal(link.hasPassword, false);
    const stored = await app.prisma.fileShareLink.findUniqueOrThrow({
      where: { id: link.id },
    });
    assert.equal(stored.token, link.token);
    issued.add(link.token);
  }
  assert.equal(issued.size, 12);
});

test("a token collision with an existing link draws again and creates the link once", async () => {
  const [first, second] = [await makeFile("retry-a"), await makeFile("retry-b")];
  // Existing rows hold the first value drawn at either width, so the first
  // insert hits the real PostgreSQL unique index on FileShareLink.token.
  const colliding = { 6: crypto.randomBytes(6), 32: crypto.randomBytes(32) };
  const existing = [
    await insertExistingLink(colliding[6].toString("base64url"), [first]),
    await insertExistingLink(colliding[32].toString("base64url"), [second]),
  ];
  const before = await workspaceRows();

  const { result: response, tokenDraws, saltDraws } = await withRandomBytes(
    (size, index) => (index === 0 ? colliding[size] : undefined),
    () => createLink({ fileIds: [first.id, second.id], password: PASSWORD }),
  );

  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(
    tokenDraws.map((entry) => entry.forced),
    [true, false],
  );
  assert.equal(saltDraws, 1, "the password is hashed once, before any retry");
  const link = response.json().data;
  assert.match(link.token, TOKEN);
  assert(tokenDraws[1].bytes.equals(Buffer.from(link.token, "base64url")));
  assert(!existing.some((row) => row.token === link.token));
  assert.equal(link.hasPassword, true);
  assert(!response.body.includes("passwordHash"));
  assert.deepEqual(
    link.files.map((entry) => entry.fileId).sort(),
    [first.id, second.id].sort(),
  );

  const afterRows = await workspaceRows();
  assert.equal(afterRows.links.length, before.links.length + 1);
  assert.equal(afterRows.joins.length, before.joins.length + 2);
  for (const row of before.links)
    assert.deepEqual(
      afterRows.links.find((candidate) => candidate.id === row.id),
      row,
    );
  for (const row of before.joins)
    assert.deepEqual(
      afterRows.joins.find((candidate) => candidate.id === row.id),
      row,
    );
  // The password stored on the retried insert is the one the caller set.
  const granted = await verify(link.token, PASSWORD);
  assert.equal(granted.response.statusCode, 200, granted.response.body);
  // The stored 8-character collider is not a credential. The 43-character
  // collider still resolves to its own file, and neither existing row changes.
  const legacyView = await publicView(existing[0].token);
  const missingView = await publicView(crypto.randomBytes(32).toString("base64url"));
  assert.equal(legacyView.statusCode, 404);
  assert.equal(legacyView.body, missingView.body);
  assert.equal(legacyView.headers["cache-control"], missingView.headers["cache-control"]);
  const currentView = await publicView(existing[1].token);
  assert.equal(currentView.statusCode, 200, currentView.body);
  assert.deepEqual(
    currentView.json().data.files.map((entry) => entry.file.id),
    [second.id],
  );
});

test("three token collisions return a controlled 409 and write nothing", async () => {
  const file = await makeFile("exhausted");
  const colliding = { 6: crypto.randomBytes(6), 32: crypto.randomBytes(32) };
  for (const bytes of Object.values(colliding))
    await insertExistingLink(bytes.toString("base64url"), [file]);
  const before = await workspaceRows();

  const { result: response, tokenDraws, saltDraws } = await withRandomBytes(
    (size) => colliding[size],
    () => createLink({ fileIds: [file.id], password: PASSWORD }),
  );

  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Could not create a unique share link; please try again",
  });
  assert.equal(tokenDraws.length, 3);
  assert(tokenDraws.every((entry) => entry.forced));
  assert.equal(saltDraws, 1, "the password is hashed once for all attempts");
  assert.deepEqual(await workspaceRows(), before);
});

test("a non-token unique conflict is not retried and rolls back the link", async () => {
  const file = await makeFile("duplicate-file");
  const before = await workspaceRows();

  const { result: response, tokenDraws } = await withRandomBytes(
    () => undefined,
    () => createLink({ fileIds: [file.id, file.id] }),
  );

  // The duplicate join row violates FileShareLinkFile(shareLinkId, fileId):
  // the existing generic conflict response, with no partial link row.
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().message, "A record with these values already exists");
  assert.equal(tokenDraws.length, 1);
  assert.deepEqual(await workspaceRows(), before);
});

function missShape(response) {
  return {
    status: response.statusCode,
    cache: response.headers["cache-control"] ?? null,
    pragma: response.headers.pragma ?? null,
    cookie: response.headers["set-cookie"] ?? null,
    body: response.body,
  };
}

/** Opening, download and password checks match an unknown token exactly. */
async function assertUnknownToken(token, fileId) {
  const unknown = crypto.randomBytes(32).toString("base64url");
  const absent = crypto.randomBytes(6).toString("base64url");
  const pairs = [
    [await publicView(token), await publicView(unknown)],
    [await publicView(token), await publicView(absent)],
    [await publicDownload(token, fileId), await publicDownload(unknown, fileId)],
    [
      (await verify(token, PASSWORD)).response,
      (await verify(unknown, PASSWORD)).response,
    ],
  ];
  for (const [left, right] of pairs) {
    assert.deepEqual(missShape(left), missShape(right));
    assert.equal(left.statusCode, 404);
    assert.equal(left.json().message, "Shared files not found");
  }
}

test("8-character share tokens no longer grant access and stay removable", async () => {
  const shortFile = await makeFile("existing-short");
  const short = await insertExistingLink(
    crypto.randomBytes(6).toString("base64url"),
    [shortFile],
  );
  assert.equal(short.token.length, 8);
  // The row is still addressable by id, and a direct token read misses.
  assert.equal(
    await app.prisma.fileShareLink.findUnique({ where: { token: short.token } }),
    null,
  );
  assert.equal(
    (await app.prisma.fileShareLink.findUnique({ where: { id: short.id } })).token,
    short.token,
  );
  assert.deepEqual(
    await app.prisma.fileShareLink.findMany({ where: { token: short.token } }),
    [],
  );
  assert.equal(
    await app.prisma.fileShareLink.count({ where: { token: short.token } }),
    0,
  );
  assert.deepEqual(
    await app.prisma.fileShareLink.groupBy({
      by: ["id"],
      where: { token: short.token },
    }),
    [],
  );
  const unknownToken = crypto.randomBytes(32).toString("base64url");
  assert.deepEqual(
    await app.prisma.fileShareLink.aggregate({
      where: { token: short.token },
      _count: true,
    }),
    await app.prisma.fileShareLink.aggregate({
      where: { token: unknownToken },
      _count: true,
    }),
  );
  assert.equal(
    await app.prisma.fileShareLinkFile.findFirst({
      where: { shareLink: { token: short.token } },
    }),
    null,
  );
  const listed = await request(
    "GET",
    `/api/workspaces/${workspace.id}/files/${shortFile.id}/share-links`,
    { auth: true },
  );
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().data.length, 1);
  assert.equal(listed.json().data[0].token, short.token);
  assert.equal(listed.json().data[0].retired, true);
  assert.equal(listed.json().data[0].enabled, true);
  assert.equal(listed.body.includes("passwordHash"), false);
  await assertUnknownToken(short.token, shortFile.id);

  // Re-enabling does not restore the public URL.
  const enabled = await request(
    "PATCH",
    `/api/workspaces/${workspace.id}/file-share-links/${short.id}`,
    { payload: { enabled: true }, auth: true },
  );
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.equal(enabled.json().data.retired, true);
  assert.equal(enabled.json().data.token, short.token);
  await assertUnknownToken(short.token, shortFile.id);

  const protectedFile = await makeFile("existing-protected");
  const created = await createLink({
    fileIds: [protectedFile.id],
    password: PASSWORD,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.retired, false);
  assert.match(created.json().data.token, TOKEN);
  // Keep the issued password hash; give the row a pre-change 8-character token.
  const protectedShort = await app.prisma.fileShareLink.update({
    where: { id: created.json().data.id },
    data: { token: crypto.randomBytes(6).toString("base64url") },
  });
  assert.equal(protectedShort.token.length, 8);
  const protectedList = await request(
    "GET",
    `/api/workspaces/${workspace.id}/files/${protectedFile.id}/share-links`,
    { auth: true },
  );
  assert.equal(protectedList.statusCode, 200, protectedList.body);
  assert.deepEqual(
    protectedList.json().data.map((entry) => ({
      token: entry.token,
      retired: entry.retired,
      hasPassword: entry.hasPassword,
    })),
    [{ token: protectedShort.token, retired: true, hasPassword: true }],
  );
  assert.equal(protectedList.body.includes("passwordHash"), false);
  // A correct password must not reveal that the link existed.
  await assertUnknownToken(protectedShort.token, protectedFile.id);

  const deleted = await request(
    "DELETE",
    `/api/workspaces/${workspace.id}/file-share-links/${short.id}`,
    { auth: true },
  );
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.equal(
    await app.prisma.fileShareLink.findUnique({ where: { id: short.id } }),
    null,
  );
  await assertUnknownToken(short.token, shortFile.id);

  const replacement = await createLink({ fileIds: [shortFile.id] });
  assert.equal(replacement.statusCode, 201, replacement.body);
  assert.match(replacement.json().data.token, TOKEN);
  assert.equal(replacement.json().data.retired, false);
  const opened = await publicView(replacement.json().data.token);
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().data.authorized, true);
});

test("new links: public access, password grants and revocation over HTTP", async () => {
  for (const protectedLink of [false, true]) {
    const file = await makeFile(`new-${protectedLink}`);
    const created = await createLink({
      fileIds: [file.id],
      ...(protectedLink ? { password: PASSWORD } : {}),
    });
    assert.equal(created.statusCode, 201, created.body);
    const link = created.json().data;
    assert.match(link.token, TOKEN);
    const listed = await request(
      "GET",
      `/api/workspaces/${workspace.id}/files/${file.id}/share-links`,
      { auth: true },
    );
    assert.deepEqual(
      listed.json().data.map((entry) => entry.token),
      [link.token],
    );
    await assertPublicLifecycle(link, file, { protectedLink });
  }
});
