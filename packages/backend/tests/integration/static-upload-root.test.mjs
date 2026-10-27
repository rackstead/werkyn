import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "static-root-test-signing-key";
process.env.COOKIE_SECRET = "static-root-test-cookie-key";
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-static-root-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, user, own, foreign, token;
const ownBytes = Buffer.from("authorized nested upload");
const privateBytes = "foreign private upload marker";

function get(workspaceId, subpath, authenticated = true) {
  return app.inject({ method: "GET", url: `/storage/${workspaceId}/uploads/${subpath}`, headers: authenticated ? { authorization: `Bearer ${token}` } : {} });
}

before(async () => {
  app = await buildApp(); await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({ data: { email: `static-root-${suffix}@example.test`, displayName: "Static root fixture", emailVerified: true } });
  token = signAccessToken({ sub: user.id, email: user.email });
  own = await app.prisma.workspace.create({ data: { name: "Own uploads", slug: `static-own-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } } } });
  foreign = await app.prisma.workspace.create({ data: { name: "Foreign uploads", slug: `static-foreign-${suffix}` } });
  await app.storage.save(`${own.id}/uploads/wiki/space`, "", "nested", ".txt", ownBytes);
  await app.storage.save(`${foreign.id}/uploads/wiki/space`, "", "private", ".txt", Buffer.from(privateBytes));
  await app.storage.save(`${own.id}/uploads-sibling`, "", "private", ".txt", Buffer.from(privateBytes));
  await app.storage.save("avatars", "", "private", ".txt", Buffer.from(privateBytes));
});

after(async () => {
  try {
    const ids = [own?.id, foreign?.id].filter(Boolean);
    if (app) await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test("encoded traversal under an authorized workspace cannot select another storage root", async () => {
  for (const destination of [
    `../../${foreign.id}/uploads/wiki/space/private.txt`,
    "../../avatars/private.txt",
    "../uploads-sibling/private.txt",
  ]) {
    for (const encoded of [encodeURIComponent(destination), encodeURIComponent(destination).replaceAll("%2F", "%2f")]) {
      const response = await get(own.id, encoded);
      assert.equal(response.statusCode, 403, "escape must be denied before streaming");
      assert.ok(!response.body.includes(privateBytes));
    }
  }
});

test("authorized nested bytes remain readable; authentication and tenant membership remain required", async () => {
  const response = await get(own.id, "wiki/space/nested.txt");
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, ownBytes);
  assert.equal((await get(own.id, "wiki/space/nested.txt", false)).statusCode, 401);
  const denied = await get(foreign.id, "wiki/space/private.txt");
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.body.includes(privateBytes));
});

test("current membership is checked on each static read", async () => {
  await app.prisma.workspaceMember.delete({ where: { userId_workspaceId: { userId: user.id, workspaceId: own.id } } });
  const denied = await get(own.id, "wiki/space/nested.txt");
  assert.equal(denied.statusCode, 403);
  assert.ok(!denied.body.includes(ownBytes.toString()));
});
