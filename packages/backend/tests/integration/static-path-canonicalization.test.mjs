import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "static-canonical-test-signing-key";
process.env.COOKIE_SECRET = "static-canonical-test-cookie-key";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-static-canonical-"));
process.env.STORAGE_DIR = storageDir;
const legacyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../uploads");
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

const MARKERS = {
  avatar: "static-canonical avatar marker",
  public: "static-canonical public upload marker",
  inner: "static-canonical nested public marker",
  guarded: "static-canonical workspace upload marker",
  root: "static-canonical storage root marker",
  legacy: "static-canonical legacy marker",
};
let app, port, user, workspace, token, legacyDirectory, legacyName;

async function put(relativePath, text) {
  const file = path.join(storageDir, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/**
 * Send the request target byte for byte. app.inject() and fetch() resolve dot
 * segments before Fastify sees them, which would hide what the router and the
 * static file server do with them.
 */
function rawGet(target, authenticated = false) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.setTimeout(10_000, () => socket.destroy(new Error(`timed out: ${target}`)));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      resolve({ statusCode: Number(text.split(" ", 2)[1]), text });
    });
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n` +
        (authenticated ? `Authorization: Bearer ${token}\r\n` : "") +
        "\r\n",
    );
  });
}

function leaked(response) {
  return Object.entries(MARKERS)
    .filter(([, marker]) => response.text.includes(marker))
    .map(([name]) => name);
}

before(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({
    data: { email: `static-canonical-${suffix}@example.test`, displayName: "Static canonical fixture", emailVerified: true },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({
    data: { name: "Static canonical", slug: `static-canonical-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
  await put("avatars/avatar.txt", MARKERS.avatar);
  await put("uploads/public.txt", MARKERS.public);
  await put("uploads/sub/inner.txt", MARKERS.inner);
  await put(`${workspace.id}/uploads/guarded.txt`, MARKERS.guarded);
  await put("root.txt", MARKERS.root);
  await mkdir(legacyRoot, { recursive: true });
  legacyDirectory = await mkdtemp(path.join(legacyRoot, "static-canonical-"));
  legacyName = path.basename(legacyDirectory);
  await writeFile(path.join(legacyDirectory, "legacy.txt"), MARKERS.legacy);
});

after(async () => {
  try {
    if (workspace) await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
    if (legacyDirectory) await rm(legacyDirectory, { recursive: true, force: true });
  }
});

test("canonical static paths still serve their own root", async () => {
  for (const [target, marker, authenticated] of [
    ["/storage/avatars/avatar.txt", MARKERS.avatar, false],
    ["/storage/uploads/public.txt", MARKERS.public, false],
    ["/storage/uploads/sub/inner.txt", MARKERS.inner, false],
    [`/uploads/${legacyName}/legacy.txt`, MARKERS.legacy, false],
    [`/storage/${workspace.id}/uploads/guarded.txt`, MARKERS.guarded, true],
  ]) {
    const response = await rawGet(target, authenticated);
    assert.equal(response.statusCode, 200, target);
    assert.deepEqual(leaked(response), [Object.keys(MARKERS).find((k) => MARKERS[k] === marker)], target);
  }
  assert.equal((await rawGet(`/storage/${workspace.id}/uploads/guarded.txt`)).statusCode, 401);
});

test("dot segments and encoded separators never leave the public roots or reach workspace uploads", async () => {
  const W = workspace.id;
  const targets = [
    `/storage/uploads/../${W}/uploads/guarded.txt`,
    `/storage/uploads/%2e%2e/${W}/uploads/guarded.txt`,
    `/storage/uploads/%2E%2E/${W}/uploads/guarded.txt`,
    `/storage/uploads/..%2f${W}%2fuploads%2fguarded.txt`,
    `/storage/uploads/sub/../../${W}/uploads/guarded.txt`,
    `/storage/uploads/sub/%2e%2e/%2e%2e/${W}/uploads/guarded.txt`,
    `/storage/uploads/../${W}/uploads/guarded.txt?download=1`,
    `/storage/avatars/../${W}/uploads/guarded.txt`,
    `/storage/avatars/..%2f${W}%2fuploads%2fguarded.txt`,
    "/storage/avatars/../uploads/public.txt",
    "/storage/avatars/%2e%2e/uploads/public.txt",
    "/storage/avatars/../root.txt",
    "/storage/avatars/..%2froot.txt",
    "/storage/avatars/%2e%2e%2froot.txt",
    "/storage/uploads/%2e%2e/root.txt",
    `/uploads/${legacyName}/../../package.json`,
    `/uploads/${legacyName}/%2e%2e/%2e%2e/package.json`,
    `/uploads/${legacyName}%2f..%2f..%2fpackage.json`,
    `/storage/elsewhere/../${W}/uploads/guarded.txt`,
  ];
  for (const target of targets) {
    const response = await rawGet(target);
    assert.ok([403, 404].includes(response.statusCode), `${target} answered ${response.statusCode}`);
    assert.deepEqual(leaked(response), [], target);
    assert.ok(!response.text.includes('"name": "@pm/backend"'), target);
  }
});

test("the workspace route resolves only beneath its own upload root", async () => {
  const W = workspace.id;
  for (const target of [
    `/storage/${W}/uploads/..%2f..%2froot.txt`,
    `/storage/${W}/uploads/%2e%2e/%2e%2e/root.txt`,
    `/storage/${W}/uploads/../../uploads/public.txt`,
    `/storage/${W}/uploads/%2e%2e/%2e%2e/avatars/avatar.txt`,
  ]) {
    assert.equal((await rawGet(target)).statusCode, 401, target);
    const response = await rawGet(target, true);
    assert.ok([403, 404].includes(response.statusCode), `${target} answered ${response.statusCode}`);
    assert.deepEqual(leaked(response), [], target);
  }
});

test("non-canonical forms of a public file are refused instead of normalized", async () => {
  // @fastify/static 10 refuses empty and dot segments, and no longer decodes
  // %2F into a path separator (GHSA-x428-ghpx-8j92, GHSA-83w8-p2f5-377r,
  // GHSA-423g-23ch-w7c6, GHSA-8pvw-jcv7-9cmj). Earlier releases served every
  // one of these from the public uploads root.
  const W = workspace.id;
  for (const [target, authenticated] of [
    ["/storage/uploads//public.txt", false],
    ["/storage/uploads/./public.txt", false],
    ["/storage/uploads/sub/../public.txt", false],
    ["/storage/uploads/sub/%2e%2e/public.txt", false],
    ["/storage/uploads/sub%2finner.txt", false],
    ["/storage/uploads/sub%2Finner.txt", false],
    [`/storage/${W}/uploads/./guarded.txt`, true],
    [`/storage/${W}/uploads//guarded.txt`, true],
    [`/storage/${W}/uploads/x/../guarded.txt`, true],
    [`/storage/${W}/uploads/x/%2e%2e/guarded.txt`, true],
  ]) {
    const response = await rawGet(target, authenticated);
    assert.ok([403, 404].includes(response.statusCode), `${target} answered ${response.statusCode}`);
    assert.deepEqual(leaked(response), [], target);
  }
});
