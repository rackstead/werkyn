import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { png } from "../fixtures/passive-media.mjs";
import {
  MiB,
  ZIP_DOCUMENTS,
  ZIP_WRITERS,
  contentTypesXml,
  countInflatedBytes,
  ooxmlEntries,
  understateUncompressedSize,
  zipWithDataDescriptors,
  zipWithLocalSizes,
} from "../fixtures/zip-documents.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "upload-zip-integration-jwt-secret";
process.env.COOKIE_SECRET = "upload-zip-integration-cookie-secret";
process.env.LOG_LEVEL = "error";
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-upload-zip-integration-"),
);
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
let app;
let user;
let token;
let workspace;
let space;

function upload(fields, content, filename, contentType) {
  const boundary = `zip-${crypto.randomUUID()}`;
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${token}`,
    },
    payload: Buffer.concat([
      Buffer.from(parts.join("")),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

async function storageFiles(directory = storageDir) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await storageFiles(full)));
    else files.push(path.relative(storageDir, full));
  }
  return files.sort();
}

function avatar(content, filename = "avatar.png") {
  return upload(
    { workspaceId: workspace.id, purpose: "avatar" },
    content,
    filename,
    "image/png",
  );
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(8).toString("hex");
  user = await app.prisma.user.create({
    data: {
      email: `upload-zip-${suffix}@example.test`,
      displayName: "Upload ZIP member",
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Upload ZIP detection",
      slug: `upload-zip-${suffix}`,
      members: { create: { userId: user.id, role: "MEMBER" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "ZIP wiki", slug: "zip-wiki" },
  });
});

after(async () => {
  if (app) {
    if (workspace)
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
    await app.close();
  }
  await rm(storageDir, { recursive: true, force: true });
});

test("avatar uploads still accept a detected image despite a document filename", async () => {
  const response = await avatar(png, "avatar.docx");
  assert.equal(response.statusCode, 201, response.body);
  const relative = response.json().data.url.slice("/storage/".length);
  assert.ok(relative.startsWith(`${workspace.id}/uploads/avatars/${user.id}/`));
  assert.ok(relative.endsWith(".png"));
  assert.deepEqual(await readFile(path.join(storageDir, relative)), png);
});

test("avatar uploads reject ordinary ZIP-based documents without storing them", async () => {
  const initial = await storageFiles();
  for (const [writer, write] of ZIP_WRITERS) {
    for (const { ext, entries } of ZIP_DOCUMENTS) {
      const response = await avatar(await write(entries()));
      assert.equal(response.statusCode, 400, `${writer} ${ext}: ${response.body}`);
      assert.match(response.json().message, /JPEG, PNG, GIF, or WebP/);
    }
  }
  assert.deepEqual(await storageFiles(), initial);
});

test("wiki uploads keep ordinary ZIP-based documents byte for byte", async () => {
  for (const [writer, write] of ZIP_WRITERS) {
    for (const { ext, entries } of ZIP_DOCUMENTS) {
      const bytes = await write(entries());
      const response = await upload(
        { workspaceId: workspace.id, purpose: "wiki", spaceId: space.id },
        bytes,
        `document.${ext}`,
        "application/octet-stream",
      );
      assert.equal(response.statusCode, 201, `${writer} ${ext}: ${response.body}`);
      const relative = response.json().data.url.slice("/storage/".length);
      assert.ok(relative.startsWith(`${workspace.id}/uploads/wiki/${space.id}/`));
      assert.ok(relative.endsWith(`.${ext}`), relative);
      assert.deepEqual(await readFile(path.join(storageDir, relative)), bytes);
    }
  }
});

test("avatar detection of a small ZIP that inflates to 8 MiB is bounded and rejected", { timeout: 20_000 }, async () => {
  const entries = ooxmlEntries("docx", contentTypesXml("docx", 8 * MiB));
  const withSizes = zipWithLocalSizes(entries);
  const initial = await storageFiles();
  for (const [variant, bytes] of [
    ["declared size", withSizes],
    [
      "understated size",
      understateUncompressedSize(withSizes, "[Content_Types].xml"),
    ],
    ["data descriptor", await zipWithDataDescriptors(entries)],
  ]) {
    assert.ok(bytes.length < 16 * 1024, `${variant}: ${bytes.length}`);
    const { result: response, inflatedBytes } = await countInflatedBytes(() =>
      avatar(bytes),
    );
    assert.equal(response.statusCode, 400, `${variant}: ${response.body}`);
    assert.ok(inflatedBytes <= MiB + 256 * 1024, `${variant}: ${inflatedBytes}`);
  }
  assert.deepEqual(await storageFiles(), initial);
});
