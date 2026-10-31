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
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "upload-integration-jwt-secret";
process.env.COOKIE_SECRET = "upload-integration-cookie-secret";
process.env.LOG_LEVEL = "error";
// Exercise the configured size ceiling without allocating production-size buffers.
process.env.MAX_FILE_SIZE = "1024";
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-upload-integration-"),
);
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
let app;
let workspace;
let foreignWorkspace;
let space;
let foreignSpace;
const users = [];
const sessions = {};

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


async function storageSnapshot(directory = storageDir, prefix = "") {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      result.push([relative, "directory"], ...await storageSnapshot(path.join(directory, entry.name), relative));
    } else {
      result.push([relative, crypto.createHash("sha256").update(await readFile(path.join(directory, entry.name))).digest("hex")]);
    }
  }
  return result;
}

function upload(role, fields, content, filename) {
  const body = multipart(fields, content, filename);
  return app.inject({
    method: "POST",
    url: "/api/uploads",
    headers: {
      "content-type": body.contentType,
      ...(role ? { authorization: `Bearer ${sessions[role]}` } : {}),
    },
    payload: body.payload,
  });
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(8).toString("hex");
  for (const role of ["ADMIN", "MEMBER", "VIEWER", "OUTSIDER"]) {
    const user = await app.prisma.user.create({
      data: {
        email: `upload-${role}-${suffix}@example.test`,
        displayName: role,
      },
    });
    users.push(user);
    sessions[role] = signAccessToken({ sub: user.id, email: user.email });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Upload authorization",
      slug: `upload-${suffix}`,
      members: {
        create: users
          .slice(0, 3)
          .map((user) => ({ userId: user.id, role: user.displayName })),
      },
    },
  });
  foreignWorkspace = await app.prisma.workspace.create({
    data: {
      name: "Foreign upload workspace",
      slug: `foreign-upload-${suffix}`,
      members: { create: { userId: users[3].id, role: "ADMIN" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Own wiki", slug: "own-wiki" },
  });
  foreignSpace = await app.prisma.wikiSpace.create({
    data: {
      workspaceId: foreignWorkspace.id,
      name: "Foreign wiki",
      slug: "foreign-wiki",
    },
  });
});

after(async () => {
  if (app) {
    for (const record of [workspace, foreignWorkspace]) {
      if (record)
        await app.prisma.workspace.deleteMany({ where: { id: record.id } });
    }
    await app.prisma.user.deleteMany({
      where: { id: { in: users.map((user) => user.id) } },
    });
    await app.close();
  }
  await rm(storageDir, { recursive: true, force: true });
});

test("authentication and current workspace membership are required before writing", async () => {
  const fields = {
    workspaceId: workspace.id,
    purpose: "wiki",
    spaceId: space.id,
  };
  assert.equal((await upload(null, fields)).statusCode, 401);
  for (const purpose of ["wiki", "avatar"]) {
    assert.equal(
      (await upload("OUTSIDER", { ...fields, purpose })).statusCode,
      403,
    );
  }
  assert.equal(
    (
      await upload("MEMBER", {
        ...fields,
        workspaceId: foreignWorkspace.id,
        spaceId: foreignSpace.id,
      })
    ).statusCode,
    403,
  );
  assert.deepEqual(await readdir(storageDir), []);
});

test("unsafe identifiers, unsupported purposes and missing wiki spaces are rejected", async () => {
  for (const fields of [
    { workspaceId: "../escaped", purpose: "wiki", spaceId: space.id },
    { workspaceId: workspace.id, purpose: "wiki", spaceId: "../../escaped" },
    { workspaceId: workspace.id, purpose: "unsupported" },
    { workspaceId: workspace.id, purpose: "wiki" },
  ]) {
    const response = await upload("MEMBER", fields);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(await readdir(storageDir), []);
});

test("wiki uploads require write role and a space in the authorized workspace", async () => {
  const fields = {
    workspaceId: workspace.id,
    purpose: "wiki",
    spaceId: space.id,
  };
  assert.equal((await upload("VIEWER", fields)).statusCode, 403);
  for (const role of ["MEMBER", "ADMIN"]) {
    const response = await upload(role, {
      ...fields,
      spaceId: foreignSpace.id,
    });
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.deepEqual(await readdir(storageDir), []);
});

test("authorized wiki uploads retain their workspace/space path and content", async () => {
  for (const role of ["MEMBER", "ADMIN"]) {
    const response = await upload(role, {
      workspaceId: workspace.id,
      purpose: "wiki",
      spaceId: space.id,
    });
    assert.equal(response.statusCode, 201, response.body);
    const relative = response.json().data.url.slice("/storage/".length);
    assert.ok(relative.startsWith(`${workspace.id}/uploads/wiki/${space.id}/`));
    assert.deepEqual(await readFile(path.join(storageDir, relative)), png);
  }
});

test("viewers may upload their own avatar with a detected image extension", async () => {
  const response = await upload(
    "VIEWER",
    { workspaceId: workspace.id, purpose: "avatar", userId: users[0].id },
    png,
    "untrusted.html",
  );
  assert.equal(response.statusCode, 201, response.body);
  const relative = response.json().data.url.slice("/storage/".length);
  assert.ok(
    relative.startsWith(`${workspace.id}/uploads/avatars/${users[2].id}/`),
  );
  assert.ok(relative.endsWith(".png"));
  assert.deepEqual(await readFile(path.join(storageDir, relative)), png);
  const initial = await storageSnapshot();
  const invalid = await upload(
    "MEMBER",
    { workspaceId: workspace.id, purpose: "avatar" },
    Buffer.from("not an image"),
  );
  assert.equal(invalid.statusCode, 400, invalid.body);
  assert.deepEqual(await storageSnapshot(), initial);
});

test("configured size limit rejects oversized wiki/avatar data and accepts its boundary", async () => {
  const wiki = {
    workspaceId: workspace.id,
    purpose: "wiki",
    spaceId: space.id,
  };
  const oversized = Buffer.concat([png, Buffer.alloc(1025 - png.length)]);
  const initial = await storageSnapshot();
  for (const fields of [
    wiki,
    { workspaceId: workspace.id, purpose: "avatar" },
  ]) {
    const response = await upload("MEMBER", fields, oversized);
    assert.equal(response.statusCode, 413, response.body);
    assert.deepEqual(await storageSnapshot(), initial);
  }
  const boundary = await upload("MEMBER", wiki, Buffer.alloc(1024));
  assert.equal(boundary.statusCode, 201, boundary.body);
});

test("workspace access is checked before buffering a file larger than the limit", async () => {
  const initial = await storageSnapshot();
  const response = await upload(
    "OUTSIDER",
    { workspaceId: workspace.id, purpose: "wiki", spaceId: space.id },
    Buffer.alloc(2048),
  );
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(await storageSnapshot(), initial);
});

test("removing workspace membership revokes upload access with an existing token", async () => {
  const initial = await storageSnapshot();
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: { userId: users[1].id, workspaceId: workspace.id },
    },
  });
  const response = await upload("MEMBER", {
    workspaceId: workspace.id,
    purpose: "avatar",
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(await storageSnapshot(), initial);
});


test("malformed truncated multipart rejects without storing partial content", async () => {
  // This user retains membership even after the MEMBER revocation test.
  const initial = await storageSnapshot();
  const body = multipart({ workspaceId: workspace.id, purpose: "wiki", spaceId: space.id });
  const response = await app.inject({
    method: "POST", url: "/api/uploads",
    headers: { "content-type": body.contentType, authorization: `Bearer ${sessions.ADMIN}` },
    payload: body.payload.subarray(0, body.payload.length - 12),
  });
  // The client's malformed body, not a server error.
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().message, "The upload did not complete");
  assert.deepEqual(await storageSnapshot(), initial);
});
