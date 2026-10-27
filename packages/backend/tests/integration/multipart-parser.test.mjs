import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database",
  );
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "multipart-compatibility-test-jwt",
  COOKIE_SECRET: "multipart-compatibility-test-cookie",
  MAX_FILE_SIZE: "1024",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-multipart-parser-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
let app, user, workspace, space, token;

function upload(purpose, content = png, authenticated = true) {
  const boundary = `compat-${crypto.randomUUID()}`;
  const fields = {
    workspaceId: workspace.id,
    purpose,
    ...(purpose === "wiki" ? { spaceId: space.id } : {}),
  };
  const payload = Buffer.concat([
    Buffer.from(
      Object.entries(fields)
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join(""),
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}
async function storedBytes(directory = storageDir, prefix = "") {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      entries.push(
        [relative, "directory"],
        ...(await storedBytes(path.join(directory, entry.name), relative)),
      );
    else
      entries.push([
        relative,
        crypto
          .createHash("sha256")
          .update(await readFile(path.join(directory, entry.name)))
          .digest("hex"),
      ]);
  }
  return entries;
}
before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  user = await app.prisma.user.create({
    data: {
      email: `multipart-${suffix}@example.test`,
      displayName: "Multipart compatibility",
      emailVerified: true,
    },
  });
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Multipart compatibility",
      slug: `mp-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: workspace.id,
      name: "Compatibility",
      slug: "compatibility",
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
});
after(async () => {
  try {
    if (workspace)
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("patched parser preserves authorized avatar/wiki bytes and exact configured limit", async () => {
  for (const [purpose, content] of [
    ["avatar", png],
    ["wiki", Buffer.alloc(1024, 0x61)],
  ]) {
    const response = await upload(purpose, content);
    assert.equal(response.statusCode, 201, response.body);
    const relative = response.json().data.url.slice("/storage/".length);
    assert.ok(relative.startsWith(`${workspace.id}/uploads/`));
    assert.deepEqual(await readFile(path.join(storageDir, relative)), content);
  }
});

test("oversized and unauthenticated multipart requests preserve stored data and server responsiveness", async () => {
  const initial = await storedBytes();
  for (const purpose of ["avatar", "wiki"]) {
    const oversized = await upload(purpose, Buffer.alloc(1025));
    assert.equal(oversized.statusCode, 413, oversized.body);
    assert.deepEqual(await storedBytes(), initial);
  }
  const anonymous = await upload("avatar", png, false);
  assert.equal(anonymous.statusCode, 401, anonymous.body);
  assert.deepEqual(await storedBytes(), initial);
  const valid = await upload("avatar");
  assert.equal(valid.statusCode, 201, valid.body);
});
