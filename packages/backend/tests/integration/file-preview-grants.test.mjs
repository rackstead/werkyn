import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import { openRawSocket } from "./support/raw-websocket.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const secret = "file-preview-grants-fixture-signing-secret";
const directory = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-preview-grants-"),
);
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: secret,
  COOKIE_SECRET: "file-preview-grants-fixture-cookie-secret",
  STORAGE_DIR: directory,
});
const { buildApp } = await import("../../src/app.ts");
const { startRefreshSession } =
  await import("../../src/modules/auth/refresh-sessions.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
let app,
  origin,
  requests = 0;
const userIds = [],
  workspaceIds = [],
  familyIds = [];
const pdf = Buffer.from("%PDF-1.7\n1 0 obj <</Type/Catalog>> endobj\n%%EOF\n");
const effects = { opens: 0, buffered: 0 };
before(async () => {
  app = await buildApp();
  const open = app.storage.openReadStream.bind(app.storage);
  app.storage.openReadStream = (...args) => {
    effects.opens++;
    return open(...args);
  };
  app.storage.read = async () => {
    effects.buffered++;
    throw new Error("preview must stream");
  };
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});
after(async () => {
  try {
    await app?.prisma.workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    });
    await app?.prisma.rotatedRefreshToken.deleteMany({
      where: { familyId: { in: familyIds } },
    });
    await app?.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
function request(method, pathname, { token, payload, headers = {} } = {}) {
  const n = ++requests;
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      new URL(pathname, origin),
      {
        method,
        localAddress: `127.48.${(n >> 8) & 255}.${n & 255}`,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            bytes,
            headers: response.headers,
            json: () => JSON.parse(bytes.toString()),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function actor() {
  const suffix = crypto.randomUUID();
  const user = await app.prisma.user.create({
    data: {
      email: `preview-${suffix}@example.test`,
      displayName: "Preview fixture",
      emailVerified: true,
    },
  });
  userIds.push(user.id);
  const session = await startRefreshSession(app.prisma, user.id);
  familyIds.push(session.familyId);
  const token = signAccessToken({
    sub: user.id,
    email: user.email,
    sid: session.familyId,
  });
  return { user, token, sid: session.familyId };
}
async function fixture() {
  const owner = await actor(),
    reader = await actor();
  const workspace = await app.prisma.workspace.create({
    data: {
      name: "Preview grants",
      slug: `preview-${crypto.randomUUID()}`,
      members: {
        create: [
          { userId: owner.user.id, role: "ADMIN" },
          { userId: reader.user.id, role: "MEMBER" },
        ],
      },
    },
  });
  workspaceIds.push(workspace.id);
  const file = await makeFile(workspace.id, owner.user.id);
  return { owner, reader, workspace, file };
}
async function makeFile(wid, uid, mimeType = "application/pdf") {
  const storagePath = await app.storage.save(
    "files",
    wid,
    crypto.randomUUID(),
    ".pdf",
    pdf,
  );
  return app.prisma.file.create({
    data: {
      workspaceId: wid,
      ownerId: uid,
      uploadedById: uid,
      name: "report.pdf",
      mimeType,
      size: pdf.length,
      storagePath,
    },
  });
}
const filesPath = (f) => `/api/workspaces/${f.workspace.id}/files`;
async function issue(f, token = f.owner.token, file = f.file) {
  const response = await request(
    "POST",
    `${filesPath(f)}/${file.id}/preview-grant`,
    { token },
  );
  assert.equal(response.status, 200, response.bytes.toString());
  return { response, ...response.json().data };
}
const preview = (f, grant, file = f.file) =>
  `${filesPath(f)}/${file.id}/preview?token=${encodeURIComponent(grant)}`;
function signingKey() {
  return crypto
    .createHmac("sha256", secret)
    .update("werkyn:file-preview:v1")
    .digest();
}
function crafted(claims, options = {}) {
  return jwt.sign(claims, signingKey(), {
    algorithm: "HS256",
    issuer: "werkyn:file-preview:v1",
    audience: "werkyn:file-preview",
    ...options,
  });
}
function claims(f) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: f.owner.user.id,
    sid: f.owner.sid,
    wid: f.workspace.id,
    fid: f.file.id,
    purpose: "file-preview",
    iat: now,
    exp: now + 120,
    authExp: now + 300,
  };
}

test("generic HTTP rejects query JWT reads while preserving the Authorization header", async () => {
  const { owner } = await fixture();
  assert.equal(
    (await request("GET", `/api/users/me?token=${owner.token}`)).status,
    401,
  );
  assert.equal(
    (
      await request("GET", `/api/users/me?token=irrelevant`, {
        token: owner.token,
      })
    ).status,
    200,
  );
});
test("generic HTTP rejects query JWT mutations before any profile or credential side effect", async () => {
  const { owner } = await fixture();
  const before = await app.prisma.user.findUniqueOrThrow({
    where: { id: owner.user.id },
  });
  const keys = await app.prisma.apiKey.count({
    where: { userId: owner.user.id },
  });
  const write = await request("PATCH", `/api/users/me?token=${owner.token}`, {
    payload: { displayName: "Refused" },
  });
  const key = await request("POST", `/api/api-keys?token=${owner.token}`, {
    payload: { name: "Refused" },
  });
  assert.deepEqual([write.status, key.status], [401, 401]);
  assert.deepEqual(
    await app.prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } }),
    before,
  );
  assert.equal(
    await app.prisma.apiKey.count({ where: { userId: owner.user.id } }),
    keys,
  );
});
test("native PDF grants stream GET and HEAD with private isolated responses and no eager read", async () => {
  const f = await fixture();
  const grant = await issue(f);
  assert.equal(grant.response.headers["cache-control"], "private, no-store");
  assert.equal(grant.response.headers["referrer-policy"], "no-referrer");
  const decoded = jwt.decode(grant.token),
    source = jwt.decode(f.owner.token);
  assert.equal(decoded.sub, f.owner.user.id);
  assert.equal(decoded.sid, f.owner.sid);
  assert.equal(decoded.fid, f.file.id);
  assert.equal(decoded.wid, f.workspace.id);
  assert.ok(decoded.exp - decoded.iat <= 300);
  assert.ok(decoded.exp <= source.exp);
  assert.equal(grant.expiresAt, decoded.exp * 1000);
  assert.equal(grant.sourceExpiresAt, source.exp * 1000);
  assert.notEqual(grant.token, f.owner.token);
  const response = await request("GET", preview(f, grant.token));
  assert.equal(response.status, 200, response.bytes.toString());
  assert.deepEqual(response.bytes, pdf);
  assert.equal(response.headers["content-type"], "application/pdf");
  assert.match(response.headers["content-disposition"], /^inline;/);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["content-security-policy"], /sandbox/);
  const head = await request("HEAD", preview(f, grant.token));
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  const range = await request("GET", preview(f, grant.token), {
    headers: { range: "bytes=0-10" },
  });
  assert.equal(range.status, 200, "inherited streaming200; no new206 promise");
  assert.deepEqual(range.bytes, pdf);
  assert.equal(effects.buffered, 0);
});
test("header credentials and API keys keep ordinary downloads; API keys cannot mint browser grants", async () => {
  const f = await fixture();
  const result = await request("POST", "/api/api-keys", {
    token: f.owner.token,
    payload: { name: "Preview fixture", expiresInDays: null },
  });
  assert.equal(result.status, 201, result.bytes.toString());
  const key = result.json().data.key;
  for (const token of [f.owner.token, key]) {
    assert.equal(
      (await request("GET", `${filesPath(f)}/${f.file.id}/download`, { token }))
        .status,
      200,
    );
  }
  assert.equal(
    (await request("GET", `${filesPath(f)}/${f.file.id}/download?token=${key}`))
      .status,
    401,
  );
  assert.equal(
    (
      await request("POST", `${filesPath(f)}/${f.file.id}/preview-grant`, {
        token: key,
      })
    ).status,
    403,
  );
});
test("preview grants cannot authenticate generic HTTP reads, mutations or WebSocket", async () => {
  const f = await fixture(),
    grant = await issue(f);
  for (const token of [grant.token]) {
    assert.equal(
      (await request("GET", "/api/users/me", { token })).status,
      401,
    );
    assert.equal(
      (await request("GET", `/api/users/me?token=${encodeURIComponent(token)}`))
        .status,
      401,
    );
    assert.equal(
      (
        await request("PATCH", "/api/users/me", {
          token,
          payload: { displayName: "Refused" },
        })
      ).status,
      401,
    );
    const client = await openRawSocket(app.server.address().port);
    try {
      client.sendJSON({ type: "auth", token });
      assert.equal((await client.closed()).code, 4002);
    } finally {
      client.socket.destroy();
    }
  }
});
test("ordinary access JWTs and missing, malformed or repeated preview credentials are refused", async () => {
  const f = await fixture();
  const opens = effects.opens;
  for (const query of [
    "",
    `?token=${f.owner.token}`,
    "?token=invalid",
    "?token=a&token=b",
    "?token=",
  ]) {
    const result = await request(
      "GET",
      `${filesPath(f)}/${f.file.id}/preview${query}`,
      { token: f.owner.token },
    );
    assert.equal(result.status, 401);
    assert.equal(result.headers["cache-control"], "private, no-store");
    assert.equal(result.headers["referrer-policy"], "no-referrer");
  }
  assert.equal(effects.opens, opens);
});
test("grants bind resource, workspace and GET/HEAD without widening file access", async () => {
  const f = await fixture(),
    grant = await issue(f);
  const other = await makeFile(f.workspace.id, f.owner.user.id);
  const opens = effects.opens;
  assert.equal(
    (await request("GET", preview(f, grant.token, other))).status,
    401,
  );
  assert.equal(
    (
      await request(
        "GET",
        preview({ ...f, workspace: { id: crypto.randomUUID() } }, grant.token),
      )
    ).status,
    401,
  );
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal(
      (await request(method, preview(f, grant.token), { payload: {} })).status,
      404,
    );
  }
  assert.equal(effects.opens, opens);
  assert.equal(
    (
      await request("POST", `${filesPath(f)}/${f.file.id}/preview-grant`, {
        token: f.reader.token,
      })
    ).status,
    403,
  );
});
test("preview validation rejects expired, wrong-purpose, algorithm and malformed claims", async () => {
  const f = await fixture(),
    good = claims(f),
    now = Math.floor(Date.now() / 1000);
  const missingIat = { ...good };
  delete missingIat.iat;
  const invalid = [
    crafted({ ...good, exp: now - 1 }),
    crafted({ ...good, purpose: "access" }),
    crafted({ ...good, sub: "" }),
    crafted({ ...good, sid: null }),
    crafted({ ...good, sid: [] }),
    crafted({ ...good, wid: [] }),
    crafted({ ...good, fid: "" }),
    crafted({ ...good, exp: now + 301, authExp: now + 600 }),
    crafted({ ...good, authExp: now + 60 }),
    crafted({ ...good, iat: now + 60 }),
    crafted(missingIat, { noTimestamp: true }),
    crafted({ ...good, exp: now + 1.5 }),
    crafted({ ...good, authExp: "future" }),
    crafted(good, { audience: "another" }),
    crafted(good, { issuer: "another" }),
    crafted(good, { algorithm: "HS384" }),
    jwt.sign(good, secret, { algorithm: "HS256" }),
  ];
  const opens = effects.opens;
  for (const token of invalid) {
    const result = await request("GET", preview(f, token));
    assert.equal(result.status, 401, result.bytes.toString());
    assert.equal(result.bytes.includes(Buffer.from(token)), false);
  }
  assert.equal(effects.opens, opens);
});
test("legacy no-sid grants preserve only the actual source expiry", async () => {
  const f = await fixture(),
    now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { sub: f.owner.user.id, email: f.owner.user.email, exp: now + 120 },
    secret,
  );
  const grant = await issue(f, token);
  assert.equal(jwt.decode(grant.token).sid, undefined);
  assert.equal(grant.expiresAt, (now + 120) * 1000);
  assert.equal((await request("GET", preview(f, grant.token))).status, 200);
  await app.prisma.refreshTokenFamily.update({
    where: { id: f.owner.sid },
    data: { revokedAt: new Date() },
  });
  assert.equal(
    (await request("GET", preview(f, grant.token))).status,
    200,
    "legacy bounded grace is unchanged",
  );
  const expired = crafted({ ...claims(f), sid: undefined, exp: now - 1 });
  assert.equal((await request("GET", preview(f, expired))).status, 401);
});
test("session revocation, token expiry and missing account deny later reads before storage", async () => {
  for (const condition of ["revoked", "expired", "deleted"]) {
    const f = await fixture(),
      grant = await issue(f),
      opens = effects.opens;
    if (condition === "revoked")
      await app.prisma.refreshTokenFamily.update({
        where: { id: f.owner.sid },
        data: { revokedAt: new Date() },
      });
    if (condition === "expired")
      await app.prisma.refreshToken.updateMany({
        where: { familyId: f.owner.sid },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    if (condition === "deleted")
      await app.prisma.user.delete({ where: { id: f.owner.user.id } });
    assert.equal(
      (await request("GET", preview(f, grant.token))).status,
      401,
      condition,
    );
    assert.equal(effects.opens, opens);
  }
});
test("current file share and workspace membership are rechecked for every preview read", async () => {
  const f = await fixture();
  await app.prisma.fileShare.create({
    data: {
      workspaceId: f.workspace.id,
      fileId: f.file.id,
      sharedById: f.owner.user.id,
      sharedWithId: f.reader.user.id,
    },
  });
  const grant = await issue(f, f.reader.token);
  assert.equal((await request("GET", preview(f, grant.token))).status, 200);
  await app.prisma.fileShare.deleteMany({
    where: { fileId: f.file.id, sharedWithId: f.reader.user.id },
  });
  const opens = effects.opens;
  assert.equal((await request("GET", preview(f, grant.token))).status, 403);
  assert.equal(effects.opens, opens);
  const own = await issue(f);
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: f.owner.user.id,
        workspaceId: f.workspace.id,
      },
    },
  });
  assert.equal((await request("GET", preview(f, own.token))).status, 403);
  assert.equal(effects.opens, opens);
});
test("changed/trash/folder content and missing blobs retain safe denial semantics", async () => {
  const f = await fixture(),
    grant = await issue(f);
  for (const change of [
    { mimeType: "text/html" },
    { mimeType: "application/pdf", isFolder: true },
    { isFolder: false, trashedAt: new Date() },
  ]) {
    await app.prisma.file.update({ where: { id: f.file.id }, data: change });
    const opens = effects.opens;
    assert.ok(
      [400, 404].includes(
        (await request("GET", preview(f, grant.token))).status,
      ),
    );
    assert.equal(effects.opens, opens);
    assert.ok(
      [400, 404].includes(
        (
          await request("POST", `${filesPath(f)}/${f.file.id}/preview-grant`, {
            token: f.owner.token,
          })
        ).status,
      ),
    );
  }
  await app.prisma.file.update({
    where: { id: f.file.id },
    data: { trashedAt: null },
  });
  await app.storage.delete(f.file.storagePath);
  const missing = await request("GET", preview(f, grant.token));
  assert.equal(missing.status, 410);
  assert.match(missing.headers["content-type"], /application\/json/);
  assert.equal(missing.headers["content-disposition"], undefined);
  assert.equal(missing.headers["cache-control"], "private, no-store");
});

test("admin demotion removes inherited preview authority over another owner's file", async () => {
  const f = await fixture();
  await app.prisma.file.update({
    where: { id: f.file.id },
    data: { ownerId: f.reader.user.id },
  });
  const grant = await issue(f);
  assert.equal((await request("GET", preview(f, grant.token))).status, 200);
  await app.prisma.workspaceMember.update({
    where: {
      userId_workspaceId: {
        userId: f.owner.user.id,
        workspaceId: f.workspace.id,
      },
    },
    data: { role: "MEMBER" },
  });
  const opens = effects.opens;
  assert.equal((await request("GET", preview(f, grant.token))).status, 403);
  assert.equal(effects.opens, opens);
});
test("team-folder group revocation removes later preview access", async () => {
  const f = await fixture();
  const folder = await app.prisma.file.create({
    data: {
      workspaceId: f.workspace.id,
      name: "Team root",
      isFolder: true,
      uploadedById: f.owner.user.id,
    },
  });
  const team = await app.prisma.teamFolder.create({
    data: {
      workspaceId: f.workspace.id,
      folderId: folder.id,
      name: "Preview team",
    },
  });
  const group = await app.prisma.group.create({
    data: {
      workspaceId: f.workspace.id,
      name: `Preview group ${crypto.randomUUID()}`,
      members: { create: { userId: f.reader.user.id } },
      teamFolderGroups: { create: { teamFolderId: team.id } },
    },
  });
  await app.prisma.file.update({
    where: { id: f.file.id },
    data: { parentId: folder.id, teamFolderId: team.id, ownerId: null },
  });
  const grant = await issue(f, f.reader.token);
  assert.equal((await request("GET", preview(f, grant.token))).status, 200);
  await app.prisma.groupMember.deleteMany({
    where: { groupId: group.id, userId: f.reader.user.id },
  });
  const opens = effects.opens;
  assert.equal((await request("GET", preview(f, grant.token))).status, 403);
  assert.equal(effects.opens, opens);
});
