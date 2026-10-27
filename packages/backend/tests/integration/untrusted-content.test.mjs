import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import {
  png,
  webp,
  webm,
  makePdf,
  makeWave,
} from "../fixtures/passive-media.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "untrusted-content-integration-secret";
process.env.COOKIE_SECRET = "untrusted-content-cookie-secret";
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-untrusted-content-"),
);
process.env.STORAGE_DIR = storageDir;
const legacyRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../uploads",
);
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, user, workspace, token, legacyDirectory;
const marker = Buffer.from(
  "<html><body>SEC017 benign document marker</body></html>",
);
const activeFiles = [
  "page.HTML",
  "script.js",
  "data.xml",
  "vector.svg",
  "unknown.bin",
];
const passiveFiles = [
  ["image.png", "image/png", png],
  ["document.pdf", "application/pdf", makePdf()],
  ["sound.wav", "audio/wav", makeWave()],
  ["clip.webm", "video/webm", webm],
];

function get(url, options = {}) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
    ...options,
  });
}

function assertPolicy(response, downloaded = false) {
  assert.match(
    response.headers["content-security-policy"],
    /(?:^|;)\s*sandbox(?:;|$)/,
  );
  assert.match(
    response.headers["content-security-policy"],
    /default-src 'none'/,
  );
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "private, no-store");
  if (downloaded) {
    assert.match(
      response.headers["content-type"],
      /^application\/octet-stream/,
    );
    assert.match(response.headers["content-disposition"], /^attachment(?:;|$)/);
  }
}

async function driveFile(mimeType, bytes = marker, extra = {}) {
  const storagePath = await app.storage.save(
    "files",
    workspace.id,
    crypto.randomUUID(),
    ".data",
    bytes,
  );
  return app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: "Fixture file",
      mimeType,
      storagePath,
      size: BigInt(bytes.length),
      uploadedById: user.id,
      ownerId: user.id,
      ...extra,
    },
  });
}

before(async () => {
  await mkdir(legacyRoot, { recursive: true });
  legacyDirectory = await mkdtemp(path.join(legacyRoot, "sec017-"));
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  user = await app.prisma.user.create({
    data: {
      email: `untrusted-${suffix}@example.test`,
      displayName: "Content fixture",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Content fixture",
      slug: `untrusted-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  for (const name of activeFiles) {
    for (const category of [
      "avatars",
      "uploads",
      `${workspace.id}/uploads/wiki/space`,
    ]) {
      await app.storage.save(
        category,
        "",
        path.parse(name).name,
        path.extname(name),
        marker,
      );
    }
    await writeFile(path.join(legacyDirectory, name), marker);
  }
  for (const category of [
    "uploads/index-fixture",
    `${workspace.id}/uploads/wiki/index-fixture`,
  ]) {
    await app.storage.save(category, "", "index", ".html", marker);
  }
  for (const [name, , bytes] of passiveFiles) {
    await app.storage.save(
      `${workspace.id}/uploads/wiki/space`,
      "",
      path.parse(name).name,
      path.extname(name),
      bytes,
    );
  }
});

after(async () => {
  try {
    if (workspace) {
      await app.prisma.task.deleteMany({
        where: { project: { workspaceId: workspace.id } },
      });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    }
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
    if (legacyDirectory)
      await rm(legacyDirectory, { recursive: true, force: true });
  }
});

for (const kind of ["avatar", "upload", "workspace", "legacy"]) {
  test(`${kind}: active and unknown static types retain bytes as isolated attachments`, async () => {
    const prefix = {
      avatar: "/storage/avatars",
      upload: "/storage/uploads",
      workspace: `/storage/${workspace.id}/uploads/wiki/space`,
      legacy: `/uploads/${path.basename(legacyDirectory)}`,
    }[kind];
    for (const name of activeFiles) {
      const response = await get(`${prefix}/${name}?inline=true`);
      assert.equal(response.statusCode, 200, response.body);
      assertPolicy(response, true);
      assert.deepEqual(response.rawPayload, marker);
    }
  });
}

test("directory index documents receive the same static isolation policy", async () => {
  for (const url of [
    "/storage/uploads/index-fixture/",
    `/storage/${workspace.id}/uploads/wiki/index-fixture/`,
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, response.body);
    assertPolicy(response, true);
    assert.deepEqual(response.rawPayload, marker);
  }
});

test("static HEAD and range responses retain isolation after MIME metadata", async () => {
  const url = `/storage/${workspace.id}/uploads/wiki/space/page.HTML`;
  const head = await get(url, { method: "HEAD" });
  assert.equal(head.statusCode, 200);
  assertPolicy(head, true);
  assert.equal(head.rawPayload.length, 0);
  const range = await get(url, {
    headers: { authorization: `Bearer ${token}`, range: "bytes=0-9" },
  });
  assert.equal(range.statusCode, 206, range.body);
  assertPolicy(range, true);
  assert.deepEqual(range.rawPayload, marker.subarray(0, 10));
});

test("static passive media preserve their MIME and all bytes", async () => {
  for (const [name, mimeType, bytes] of passiveFiles) {
    const response = await get(
      `/storage/${workspace.id}/uploads/wiki/space/${name}`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assertPolicy(response);
    assert.equal(response.headers["content-type"].split(";")[0], mimeType);
    assert.equal(response.headers["content-disposition"], undefined);
    assert.deepEqual(response.rawPayload, bytes);
  }
});

test("Drive inline request cannot promote active, unknown or missing MIME types", async () => {
  for (const mimeType of [
    "text/html",
    "TEXT/JAVASCRIPT; charset=utf-8",
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "application/x-custom",
    null,
  ]) {
    const file = await driveFile(mimeType);
    const response = await get(
      `/api/workspaces/${workspace.id}/files/${file.id}/download?inline=true`,
    );
    assert.equal(response.statusCode, 200, response.body);
    assertPolicy(response, true);
    assert.deepEqual(response.rawPayload, marker);
  }
});

test("Drive passive previews remain inline and ordinary downloads remain attachments", async () => {
  for (const [, mimeType, bytes] of passiveFiles) {
    const file = await driveFile(
      mimeType === "application/pdf"
        ? "APPLICATION/PDF; charset=binary"
        : mimeType,
      bytes,
    );
    const url = `/api/workspaces/${workspace.id}/files/${file.id}/download`;
    const inline = await get(`${url}?inline=true`);
    assert.equal(inline.statusCode, 200, inline.body);
    assertPolicy(inline);
    assert.match(inline.headers["content-disposition"], /^inline;/);
    assert.equal(
      inline.headers["content-type"].split(";")[0].toLowerCase(),
      mimeType,
    );
    assert.deepEqual(inline.rawPayload, bytes);
    const download = await get(url);
    assert.equal(download.statusCode, 200, download.body);
    assertPolicy(download, true);
    assert.deepEqual(download.rawPayload, bytes);
  }
});

test("private thumbnails retain valid raster bytes without public caching", async () => {
  const thumbnailPath = await app.storage.save(
    "thumbnails",
    workspace.id,
    crypto.randomUUID(),
    ".webp",
    webp,
    webm,
  );
  const file = await driveFile("image/png", png, { thumbnailPath });
  const response = await get(
    `/api/workspaces/${workspace.id}/files/${file.id}/thumbnail`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "image/webp");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(response.rawPayload, webp);
});

test("attachment and public-share siblings keep their forced-download behavior", async () => {
  // Attachment reads require a real target in the actor's current project scope.
  const project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Response policy target",
      statuses: { create: { name: "Open" } },
    },
    include: { statuses: true },
  });
  const task = await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: project.statuses[0].id,
      title: "Response policy target",
    },
  });
  const file = await driveFile("text/html");
  const attachment = await app.prisma.attachment.create({
    data: {
      workspaceId: workspace.id,
      entityType: "task",
      entityId: task.id,
      name: "Fixture.html",
      mimeType: "text/html",
      storagePath: file.storagePath,
      uploadedById: user.id,
      fileId: file.id,
      size: BigInt(marker.length),
    },
  });
  const link = await app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: user.id,
      token: crypto.randomUUID(),
      files: { create: { fileId: file.id } },
    },
  });
  for (const url of [
    `/api/workspaces/${workspace.id}/attachments/${attachment.id}/download?inline=true`,
    `/api/public/files/${link.token}/${file.id}/download?inline=true`,
  ]) {
    const response = await get(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["content-disposition"], /^attachment;/);
    assert.equal(response.headers["content-type"], "application/octet-stream");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(response.rawPayload, marker);
  }
});

test("missing uploads remain errors rather than opaque attachment responses", async () => {
  const response = await get(
    `/storage/${workspace.id}/uploads/wiki/space/missing.txt`,
  );
  assert.equal(response.statusCode, 404);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.notEqual(response.headers["content-disposition"], "attachment");
});
