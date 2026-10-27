import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
// Four actor connections admit every blocked Drive writer. Preserve the
// explicitly supplied five-connection CI pool; reject other fixture budgets.
const actorDatabaseUrl = new URL(process.env.TEST_DATABASE_URL);
const requestedActorLimit =
  actorDatabaseUrl.searchParams.get("connection_limit");
const actorConnections =
  requestedActorLimit === null ? 4 : Number(requestedActorLimit);
assert(
  [4, 5].includes(actorConnections),
  "Public-share concurrency fixture requires connection_limit=4 or 5",
);
actorDatabaseUrl.searchParams.set("connection_limit", String(actorConnections));
const controlDatabaseUrl = new URL(actorDatabaseUrl);
controlDatabaseUrl.searchParams.set("connection_limit", "2");
process.env.DATABASE_URL = actorDatabaseUrl.toString();
console.info("Public-share fixture connection budget", {
  requestedActorLimit,
  actorConnections,
  controlConnections: 2,
  totalConnections: actorConnections + 2,
});
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "public-share-test-jwt-secret";
process.env.COOKIE_SECRET = "public-share-test-cookie-secret";
process.env.COOKIE_SECURE = "true";
process.env.COOKIE_SAMESITE = "lax";
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-public-share-"),
);
process.env.STORAGE_DIR = storageDir;
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { createShareGrant, shareGrantCookieName } =
  await import("../../src/utils/share-grants.ts");
let app, control, user, workspace, space, ownerToken, passwordHash;
let requestNumber = 0,
  storageReads = 0;

function request(method, url, payload, cookie, owner = false, remoteAddress) {
  return app.inject({
    method,
    url,
    payload,
    headers: {
      ...(owner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    remoteAddress:
      remoteAddress ??
      `10.40.${Math.floor(++requestNumber / 250)}.${(requestNumber % 250) + 1}`,
  });
}

function apiPath(share) {
  return `/api/public/${share.kind}/${share.token}`;
}
function mutationPath(share) {
  return share.kind === "wiki"
    ? `/api/wiki/shares/${share.id}`
    : `/api/workspaces/${workspace.id}/file-share-links/${share.id}`;
}
function cookieFor(share, value) {
  return `${shareGrantCookieName(share.kind, share.token)}=${value}`;
}
function currentRecord(share) {
  return (
    share.kind === "wiki" ? app.prisma.wikiPageShare : app.prisma.fileShareLink
  ).findUnique({ where: { id: share.id } });
}
function assertPrivate(response) {
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
}

async function makeShare(
  kind,
  protectedShare = true,
  token = crypto.randomBytes(32).toString("base64url"),
) {
  if (kind === "wiki") {
    const page = await app.prisma.wikiPage.create({
      data: {
        spaceId: space.id,
        title: `Private page ${token}`,
        content: { confidential: token },
        createdById: user.id,
      },
    });
    const share = await app.prisma.wikiPageShare.create({
      data: {
        token,
        pageId: page.id,
        createdById: user.id,
        passwordHash: protectedShare ? passwordHash : null,
      },
    });
    return { ...share, kind, page };
  }
  const storagePath = await app.storage.save(
    "files",
    workspace.id,
    crypto.randomUUID(),
    ".txt",
    Buffer.from(`private-bytes-${token}`),
  );
  const file = await app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: `Private file ${token}`,
      mimeType: "text/plain",
      storagePath,
      size: 25,
      uploadedById: user.id,
      ownerId: user.id,
    },
  });
  const share = await app.prisma.fileShareLink.create({
    data: {
      token,
      workspaceId: workspace.id,
      createdById: user.id,
      passwordHash: protectedShare ? passwordHash : null,
      files: { create: { fileId: file.id } },
    },
  });
  return { ...share, kind, file };
}

async function validate(share, password = "Initial-password", maxAge = 1800) {
  const response = await request("POST", `${apiPath(share)}/validate`, {
    password,
  });
  assert.equal(response.statusCode, 200, response.body);
  assertPrivate(response);
  assert.equal(response.json().data.valid, true);
  const cookie = response.cookies[0];
  assert.equal(cookie.name, shareGrantCookieName(share.kind, share.token));
  assert.equal(cookie.path, undefined);
  const setCookie = String(response.headers["set-cookie"]);
  assert.doesNotMatch(setCookie, /(?:^|;)\s*Path=/i);
  assert.doesNotMatch(setCookie, /(?:^|;)\s*Domain=/i);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const grantedAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
  assert(grantedAge > 0 && grantedAge <= maxAge, setCookie);
  return cookieFor(share, cookie.value);
}

async function assertLocked(share, cookie) {
  const beforeReads = storageReads;
  const response = await request("GET", apiPath(share), undefined, cookie);
  assert.equal(response.statusCode, 200, response.body);
  assert(
    !response.body.includes(
      share.kind === "wiki" ? share.page.title : share.file.name,
    ),
    "locked metadata must not disclose owned fixture content",
  );
  assert.equal(response.json().data.authorized, false);
  assert.equal(response.json().data.hasPassword, true);
  assertPrivate(response);
  if (share.kind === "wiki") assert.equal(response.json().data.page, null);
  else {
    assert.deepEqual(response.json().data.files, []);
    assert.equal(response.json().data.createdBy, null);
    const download = await request(
      "GET",
      `${apiPath(share)}/${share.file.id}/download`,
      undefined,
      cookie,
    );
    assert.equal(download.statusCode, 403, download.body);
    assertPrivate(download);
  }
  assert.equal(
    storageReads,
    beforeReads,
    "locked requests must not open file content",
  );
}

async function assertReadable(share, cookie) {
  const response = await request("GET", apiPath(share), undefined, cookie);
  assert.equal(response.statusCode, 200, response.body);
  assertPrivate(response);
  assert.equal(response.json().data.authorized, true);
  if (share.kind === "wiki") {
    assert.equal(response.json().data.page.title, share.page.title);
    assert.deepEqual(response.json().data.page.content, share.page.content);
  } else {
    assert.equal(response.json().data.files[0].file.id, share.file.id);
    const download = await request(
      "GET",
      `${apiPath(share)}/${share.file.id}/download`,
      undefined,
      cookie,
    );
    assert.equal(download.statusCode, 200, download.body);
    assertPrivate(download);
    assert.equal(download.body, `private-bytes-${share.token}`);
    assert.match(download.headers["content-disposition"], /^attachment;/);
  }
  assert(!response.body.includes("passwordHash"));
}

before(async () => {
  // The lock holder and observer must remain independent of blocked actors.
  control = new PrismaClient({
    datasources: { db: { url: controlDatabaseUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  const originalRead = app.storage.readStream.bind(app.storage);
  app.storage.readStream = (...args) => {
    storageReads++;
    return originalRead(...args);
  };
  const suffix = crypto.randomUUID();
  user = await app.prisma.user.create({
    data: {
      email: `public-share-${suffix}@example.test`,
      displayName: "Public Share Owner",
      emailVerified: true,
    },
  });
  ownerToken = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Public share test",
      slug: `public-share-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: "Public share space",
      slug: `public-space-${suffix}`,
    },
  });
  passwordHash = await bcrypt.hash("Initial-password", 10);
});

after(async () => {
  try {
    if (workspace)
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (user) await app.prisma.user.delete({ where: { id: user.id } });
  } finally {
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
});

for (const kind of ["wiki", "files"]) {
  test(`${kind}: raw content routes are locked; wrong passwords issue no grant; valid cookie survives reload`, async () => {
    const share = await makeShare(kind);
    await assertLocked(share);
    const wrong = await request("POST", `${apiPath(share)}/validate`, {
      password: "incorrect",
    });
    assert.equal(wrong.statusCode, 403, wrong.body);
    assert.equal(wrong.headers["set-cookie"], undefined);
    assertPrivate(wrong);
    const cookie = await validate(share);
    await assertReadable(share, cookie);
    await assertReadable(share, cookie);
    await assertLocked(share);
  });

  test(`${kind}: malformed, tampered, expired and other-share grants never unlock content`, async () => {
    const share = await makeShare(kind),
      other = await makeShare(kind);
    const cookie = await validate(share),
      rawValue = cookie.slice(cookie.indexOf("=") + 1);
    await assertLocked(other, cookieFor(other, rawValue));
    for (const value of [
      "invalid",
      `${rawValue}x`,
      "x".repeat(1025),
      createShareGrant(kind, share, Date.now() - 31 * 60 * 1000),
    ]) {
      await assertLocked(share, cookieFor(share, value));
    }
    await assertLocked(
      share,
      cookieFor(
        share,
        createShareGrant(kind === "wiki" ? "files" : "wiki", share),
      ),
    );
  });

  test(`${kind}: password changes revoke old grants and expose no hash in management responses`, async () => {
    const share = await makeShare(kind),
      oldCookie = await validate(share);
    const response = await request(
      "PATCH",
      mutationPath(share),
      { password: "New-password" },
      undefined,
      true,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.hasPassword, true);
    assert(!response.body.includes("passwordHash"));
    await assertLocked(share, oldCookie);
    assert.equal(
      (
        await request("POST", `${apiPath(share)}/validate`, {
          password: "Initial-password",
        })
      ).statusCode,
      403,
    );
    await assertReadable(share, await validate(share, "New-password"));
  });

  test(`${kind}: disabling/re-enabling sharing revokes prior grants`, async () => {
    const share = await makeShare(kind),
      oldCookie = await validate(share);
    assert.equal(
      (
        await request(
          "PATCH",
          mutationPath(share),
          { enabled: false },
          undefined,
          true,
        )
      ).statusCode,
      200,
    );
    const disabled = await request("GET", apiPath(share), undefined, oldCookie);
    assert.equal(disabled.statusCode, 404, disabled.body);
    assertPrivate(disabled);
    assert.equal(
      (
        await request("POST", `${apiPath(share)}/validate`, {
          password: "Initial-password",
        })
      ).statusCode,
      404,
    );
    if (kind === "files")
      assert.equal(
        (
          await request(
            "GET",
            `${apiPath(share)}/${share.file.id}/download`,
            undefined,
            oldCookie,
          )
        ).statusCode,
        404,
      );
    assert.equal(
      (
        await request(
          "PATCH",
          mutationPath(share),
          { enabled: true },
          undefined,
          true,
        )
      ).statusCode,
      200,
    );
    await assertLocked(share, oldCookie);
    await assertReadable(share, await validate(share));
  });

  test(`${kind}: unprotected shares work without grants and adding/removing a password changes the boundary`, async () => {
    const share = await makeShare(kind, false);
    await assertReadable(share);
    assert.equal(
      (
        await request(
          "PATCH",
          mutationPath(share),
          { password: "New-password" },
          undefined,
          true,
        )
      ).statusCode,
      200,
    );
    await assertLocked(share);
    const cookie = await validate(share, "New-password");
    await assertReadable(share, cookie);
    assert.equal(
      (
        await request(
          "PATCH",
          mutationPath(share),
          { password: null },
          undefined,
          true,
        )
      ).statusCode,
      200,
    );
    await assertReadable(share);
  });

  test(`${kind}: concurrent guarded updates get distinct revisions and revoke the old grant`, async () => {
    const share = await makeShare(kind),
      oldCookie = await validate(share);
    const delegate =
      kind === "wiki" ? app.prisma.wikiPageShare : app.prisma.fileShareLink;
    const originalFind = delegate.findUnique.bind(delegate),
      originalUpdate = delegate.update.bind(delegate);
    let staleReads = 0,
      retries = 0,
      release;
    const bothRead = new Promise((resolve) => {
      release = resolve;
    });
    delegate.findUnique = async (args) => {
      const result = await originalFind(args);
      if (
        args.where.id === share.id &&
        !args.select &&
        !args.include &&
        staleReads < 2
      ) {
        staleReads++;
        if (staleReads === 2) release();
        await bothRead;
      }
      return result;
    };
    delegate.update = async (args) => {
      try {
        return await originalUpdate(args);
      } catch (error) {
        if (error.code === "P2025") retries++;
        throw error;
      }
    };
    let results;
    try {
      results = await Promise.all([
        request(
          "PATCH",
          mutationPath(share),
          { enabled: true },
          undefined,
          true,
        ),
        request(
          "PATCH",
          mutationPath(share),
          { enabled: true },
          undefined,
          true,
        ),
      ]);
    } finally {
      delegate.findUnique = originalFind;
      delegate.update = originalUpdate;
    }
    for (const result of results)
      assert.equal(result.statusCode, 200, result.body);
    assert.equal(staleReads, 2);
    assert(retries >= 1, "stale compare-and-swap must retry");
    assert.notEqual(
      results[0].json().data.updatedAt,
      results[1].json().data.updatedAt,
    );
    const current = await currentRecord(share);
    assert(current.updatedAt.getTime() >= share.updatedAt.getTime() + 2);
    await assertLocked(share, oldCookie);
    await assertReadable(share, await validate(share));
  });

  test(`${kind}: deleting/recreating a token does not revive a grant bound to the former share ID`, async () => {
    const oldShare = await makeShare(kind),
      cookie = await validate(oldShare);
    assert.equal(
      (
        await request(
          "DELETE",
          mutationPath(oldShare),
          undefined,
          undefined,
          true,
        )
      ).statusCode,
      204,
    );
    assert.equal(
      (await request("GET", apiPath(oldShare), undefined, cookie)).statusCode,
      404,
    );
    const replacement = await makeShare(kind, true, oldShare.token);
    await assertLocked(replacement, cookie);
  });

  test(`${kind}: public responses and errors are no-store and password attempts are rate limited`, async () => {
    const share = await makeShare(kind);
    const ip = kind === "wiki" ? "10.99.0.1" : "10.99.0.2";
    for (let i = 0; i < 10; i++) {
      const wrong = await request(
        "POST",
        `${apiPath(share)}/validate`,
        { password: "wrong" },
        undefined,
        false,
        ip,
      );
      assert.equal(wrong.statusCode, 403, wrong.body);
      assertPrivate(wrong);
    }
    const limited = await request(
      "POST",
      `${apiPath(share)}/validate`,
      { password: "Initial-password" },
      undefined,
      false,
      ip,
    );
    assert.equal(limited.statusCode, 429, limited.body);
    assertPrivate(limited);
    assert.equal(limited.headers["set-cookie"], undefined);
    const invalid = await request("POST", `${apiPath(share)}/validate`, {});
    assert.equal(invalid.statusCode, 400, invalid.body);
    assertPrivate(invalid);
  });
}

test("file expiry changes revoke grants; expired links reject metadata, verification and download", async () => {
  const share = await makeShare("files"),
    oldCookie = await validate(share);
  const changed = await request(
    "PATCH",
    mutationPath(share),
    { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    undefined,
    true,
  );
  assert.equal(changed.statusCode, 200, changed.body);
  await assertLocked(share, oldCookie);
  const shortCookie = await validate(share, "Initial-password", 60);
  await assertReadable(share, shortCookie);
  const expired = await request(
    "PATCH",
    mutationPath(share),
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    undefined,
    true,
  );
  assert.equal(expired.statusCode, 200, expired.body);
  for (const [method, url, body] of [
    ["GET", apiPath(share)],
    ["GET", `${apiPath(share)}/${share.file.id}/download`],
    ["POST", `${apiPath(share)}/validate`, { password: "Initial-password" }],
  ]) {
    const result = await request(method, url, body, shortCookie);
    assert.equal(result.statusCode, 404, result.body);
    assertPrivate(result);
  }
});

test("public file links never expose trashed or wrongly scoped legacy entries", async () => {
  const share = await makeShare("files", false);
  const foreignWorkspace = await app.prisma.workspace.create({
    data: {
      name: "Foreign share",
      slug: `foreign-share-${crypto.randomUUID()}`,
    },
  });
  try {
    await app.prisma.file.update({
      where: { id: share.file.id },
      data: { workspaceId: foreignWorkspace.id },
    });
    const metadata = await request("GET", apiPath(share));
    assert.deepEqual(metadata.json().data.files, []);
    assert.equal(
      (await request("GET", `${apiPath(share)}/${share.file.id}/download`))
        .statusCode,
      404,
    );
    await app.prisma.file.update({
      where: { id: share.file.id },
      data: { workspaceId: workspace.id, trashedAt: new Date() },
    });
    assert.deepEqual(
      (await request("GET", apiPath(share))).json().data.files,
      [],
    );
    assert.equal(
      (await request("GET", `${apiPath(share)}/${share.file.id}/download`))
        .statusCode,
      404,
    );
  } finally {
    await app.prisma.file.update({
      where: { id: share.file.id },
      data: { workspaceId: workspace.id },
    });
    await app.prisma.workspace.delete({ where: { id: foreignWorkspace.id } });
  }
});

test("authenticated management create/get/list returns hasPassword without password hashes", async () => {
  const wiki = await makeShare("wiki", false),
    files = await makeShare("files", false);
  await app.prisma.wikiPageShare.delete({ where: { id: wiki.id } });
  const createdWiki = await request(
    "POST",
    `/api/wiki/pages/${wiki.page.id}/share`,
    { password: "Initial-password" },
    undefined,
    true,
  );
  assert.equal(createdWiki.statusCode, 201, createdWiki.body);
  const readWiki = await request(
    "GET",
    `/api/wiki/pages/${wiki.page.id}/share`,
    undefined,
    undefined,
    true,
  );
  const createdFiles = await request(
    "POST",
    `/api/workspaces/${workspace.id}/files/share-links`,
    { fileIds: [files.file.id], password: "Initial-password" },
    undefined,
    true,
  );
  assert.equal(createdFiles.statusCode, 201, createdFiles.body);
  const listFiles = await request(
    "GET",
    `/api/workspaces/${workspace.id}/files/${files.file.id}/share-links`,
    undefined,
    undefined,
    true,
  );
  for (const result of [createdWiki, readWiki, createdFiles, listFiles]) {
    assert(!result.body.includes("passwordHash"), result.body);
    const records = Array.isArray(result.json().data)
      ? result.json().data
      : [result.json().data];
    assert(records.some((record) => record.hasPassword === true));
  }
});

async function waitForDatabaseWaiters(table, expected) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const rows = await control.$queryRaw`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE ${`%UPDATE%${table}%`}
    `;
    if (rows[0].count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    `Expected ${expected} real PostgreSQL row-lock waiters on ${table}`,
  );
}

for (const kind of ["wiki", "files"]) {
  test(`${kind}: conflicting credential writers wait on real PostgreSQL locks and retain every mutation`, async () => {
    const share = await makeShare(kind),
      oldCookie = await validate(share);
    const table = kind === "wiki" ? "WikiPageShare" : "FileShareLink";
    const delegate =
      kind === "wiki" ? app.prisma.wikiPageShare : app.prisma.fileShareLink;
    const writes = [
      { password: "Concurrent-password-A" },
      { password: "Concurrent-password-B" },
      { enabled: false },
      ...(kind === "files"
        ? [{ expiresAt: new Date(Date.now() + 120_000).toISOString() }]
        : []),
    ];
    // Exercise rejected-holder cleanup as well as the normal committed holder.
    const controlFailure =
      kind === "wiki" ? new Error("Expected control rollback") : undefined;
    let unlock, locked;
    const unlocked = new Promise((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise((resolve) => {
      locked = resolve;
    });
    const lock = control.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`,
          share.id,
        );
        locked();
        await unlocked;
        if (controlFailure) throw controlFailure;
      },
      { timeout: 10_000 },
    );
    let pending, results;
    const realNow = Date.now;
    try {
      await Promise.race([
        ready,
        lock.then(() => {
          throw new Error(
            "Control transaction ended before its row lock was ready",
          );
        }),
      ]);
      Date.now = () => share.updatedAt.getTime();
      pending = writes.map((body) =>
        request("PATCH", mutationPath(share), body, undefined, true),
      );
      // Convert injection handles into running requests before observing SQL waits.
      const running = pending.map((promise) => Promise.resolve(promise));
      pending = running;
      await waitForDatabaseWaiters(table, writes.length);
      unlock();
      if (controlFailure)
        await assert.rejects(lock, (error) => error === controlFailure);
      else await lock;
      results = await Promise.all(running);
    } finally {
      Date.now = realNow;
      unlock();
      // A rejected lock must never skip waiting for the remaining actors.
      await Promise.allSettled([lock, ...(pending ?? [])]);
    }
    for (const result of results)
      assert.equal(result.statusCode, 200, result.body);
    const revisions = results.map((result) =>
      Date.parse(result.json().data.updatedAt),
    );
    assert.equal(new Set(revisions).size, writes.length);
    const current = await delegate.findUnique({ where: { id: share.id } });
    assert.equal(
      current.updatedAt.getTime(),
      share.updatedAt.getTime() + writes.length,
    );
    assert.equal(current.enabled, false);
    const winner = revisions[0] > revisions[1] ? 0 : 1;
    assert(await bcrypt.compare(writes[winner].password, current.passwordHash));
    assert.equal(
      await bcrypt.compare(writes[1 - winner].password, current.passwordHash),
      false,
    );
    if (kind === "files")
      assert.equal(current.expiresAt.toISOString(), writes[3].expiresAt);
    assert.equal(
      (await request("GET", apiPath(share), undefined, oldCookie)).statusCode,
      404,
    );
    assert.equal(
      (
        await request(
          "PATCH",
          mutationPath(share),
          { enabled: true },
          undefined,
          true,
        )
      ).statusCode,
      200,
    );
    await assertLocked(share, oldCookie);
    await assertReadable(share, await validate(share, writes[winner].password));
  });

  test(`${kind}: same-clock disable and re-enable never restore a previous grant`, async () => {
    const share = await makeShare(kind),
      cookie = await validate(share);
    const realNow = Date.now;
    try {
      Date.now = () => share.updatedAt.getTime();
      for (const enabled of [false, true]) {
        const result = await request(
          "PATCH",
          mutationPath(share),
          { enabled },
          undefined,
          true,
        );
        assert.equal(result.statusCode, 200, result.body);
      }
      assert.equal(
        (await currentRecord(share)).updatedAt.getTime(),
        share.updatedAt.getTime() + 2,
      );
    } finally {
      Date.now = realNow;
    }
    await assertLocked(share, cookie);
    await assertReadable(share, await validate(share));
  });

  test(`${kind}: five actual stale-write conflicts fail with a controlled 409 and no requested changes`, async () => {
    const share = await makeShare(kind),
      cookie = await validate(share);
    const delegate =
      kind === "wiki" ? app.prisma.wikiPageShare : app.prisma.fileShareLink;
    const originalUpdate = delegate.update.bind(delegate);
    let conflicts = 0;
    delegate.update = async (args) => {
      if (args.where.id === share.id && args.where.updatedAt) {
        conflicts++;
        await originalUpdate({
          where: { id: share.id },
          data: { updatedAt: new Date(args.where.updatedAt.getTime() + 1) },
        });
      }
      return originalUpdate(args);
    };
    let result;
    try {
      result = await request(
        "PATCH",
        mutationPath(share),
        { enabled: false, password: "Must-not-be-stored" },
        undefined,
        true,
      );
    } finally {
      delegate.update = originalUpdate;
    }
    assert.equal(result.statusCode, 409, result.body);
    assert.match(result.json().message, /retry/i);
    assert.equal(conflicts, 5);
    const current = await currentRecord(share);
    assert.equal(current.enabled, true);
    assert.equal(current.passwordHash, share.passwordHash);
    assert(current.updatedAt > share.updatedAt);
    await assertLocked(share, cookie);
    await assertReadable(share, await validate(share));
  });

  test(`${kind}: rotation during verification issues no stale success cookie`, async () => {
    const share = await makeShare(kind);
    const delegate =
      kind === "wiki" ? app.prisma.wikiPageShare : app.prisma.fileShareLink;
    const originalFind = delegate.findUnique.bind(delegate);
    let found, resume;
    const read = new Promise((resolve) => {
      found = resolve;
    });
    const release = new Promise((resolve) => {
      resume = resolve;
    });
    let intercepted = false;
    delegate.findUnique = async (args) => {
      const result = await originalFind(args);
      if (args.where.token === share.token && !intercepted) {
        intercepted = true;
        found();
        await release;
      }
      return result;
    };
    const verification = Promise.resolve(
      request("POST", `${apiPath(share)}/validate`, {
        password: "Initial-password",
      }),
    );
    let result;
    try {
      await read;
      const rotated = await request(
        "PATCH",
        mutationPath(share),
        { password: "Rotated-during-verification" },
        undefined,
        true,
      );
      assert.equal(rotated.statusCode, 200, rotated.body);
      resume();
      result = await verification;
    } finally {
      resume();
      delegate.findUnique = originalFind;
      await verification;
    }
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.headers["set-cookie"], undefined);
    assertPrivate(result);
    await assertLocked(share);
    await assertReadable(
      share,
      await validate(share, "Rotated-during-verification"),
    );
  });

  test(`${kind}: HEAD and missing-share errors retain the public password boundary and no-store headers`, async () => {
    const share = await makeShare(kind);
    for (const suffix of [
      "",
      ...(kind === "files" ? [`/${share.file.id}/download`] : []),
    ]) {
      const head = await request("HEAD", apiPath(share) + suffix);
      assert.equal(head.statusCode, suffix ? 403 : 200, head.body);
      assert.equal(head.body, "");
      assertPrivate(head);
    }
    const missing = await request(
      "GET",
      `/api/public/${kind}/missing-${crypto.randomUUID()}`,
    );
    assert.equal(missing.statusCode, 404);
    assertPrivate(missing);
  });
}
