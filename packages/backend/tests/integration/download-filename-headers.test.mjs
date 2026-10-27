import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import { png } from "../fixtures/passive-media.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "download-filename-integration-secret",
  COOKIE_SECRET: "download-filename-cookie-secret",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-download-headers-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
let app, workspace, project, task, file, publicLink, address;
const users = {},
  tokens = {};
const bytes = Buffer.from("Permitted filename fixture bytes");
const api = (suffix) => `/api/workspaces/${workspace.id}${suffix}`;
async function request(method, url, body, actor = "OWNER") {
  const json = body !== undefined && !(body instanceof FormData);
  const response = await fetch(address + url, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${tokens[actor]}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    },
    body: json ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(5000),
  });
  const content = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes: content,
    json: () => JSON.parse(content.toString()),
  };
}
async function upload(
  name = "ordinary.txt",
  mimeType = "text/plain",
  content = bytes,
  parentId,
) {
  const form = new FormData();
  if (parentId) form.append("parentId", parentId);
  form.append("file", new Blob([content], { type: mimeType }), name);
  const response = await request("POST", api("/files/upload"), form);
  assert.equal(response.status, 201, response.bytes.toString());
  return response.json().data;
}
function filename(response, expectedName, type = "attachment") {
  assert.equal(response.status, 200, response.bytes.toString());
  const header = response.headers.get("content-disposition");
  assert.match(header, /^[\x20-\x7e]+$/);
  const match = header.match(
    /^(attachment|inline); filename="([^"\\]*)"; filename\*=UTF-8''(.*)$/,
  );
  assert(match, header);
  assert.equal(match[1], type);
  assert.equal(decodeURIComponent(match[3]), expectedName);
  return match[2];
}
before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  for (const actor of ["OWNER", "ADMIN", "PEER"]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `header-${actor}-${suffix}@example.test`,
        displayName: actor,
        emailVerified: true,
      },
    });
    tokens[actor] = signAccessToken({
      sub: users[actor].id,
      email: users[actor].email,
    });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Download filename audit",
      slug: `header-${suffix}`,
      members: {
        create: Object.keys(users).map((actor) => ({
          userId: users[actor].id,
          role: actor === "ADMIN" ? "ADMIN" : "MEMBER",
        })),
      },
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Filename discussion",
      members: { create: { userId: users.OWNER.id } },
      statuses: { create: { name: "Open" } },
    },
    include: { statuses: true },
  });
  task = await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: project.statuses[0].id,
      title: "Permitted filename task",
    },
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
  file = await upload();
  const response = await request("POST", api("/files/share-links"), {
    fileIds: [file.id],
  });
  assert.equal(response.status, 201, response.bytes.toString());
  publicLink = response.json().data;
});
after(async () => {
  try {
    if (workspace) {
      await app.prisma.task.deleteMany({
        where: { project: { workspaceId: workspace.id } },
      });
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    }
    await app?.prisma.user.deleteMany({
      where: { id: { in: Object.values(users).map((user) => user.id) } },
    });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

for (const name of [
  "ordinary.txt",
  "report with spaces.txt",
  'quoted "report".txt',
  "literal%20name.txt",
  "café.txt",
  "資料.txt",
  "emoji-📄.txt",
  "O'Brien (draft)*.txt",
])
  test(`permitted rename and actual HTTP Drive/attachment/public downloads preserve ${JSON.stringify(name)}`, async () => {
    const renamed = await request("PATCH", api(`/files/${file.id}`), { name });
    assert.equal(renamed.status, 200, renamed.bytes.toString());
    assert.equal(renamed.json().data.name, name);
    const metadata = await request("GET", api(`/files/${file.id}`));
    assert.equal(metadata.status, 200, metadata.bytes.toString());
    assert.equal(metadata.json().data.name, name);
    const linked = await request("POST", api("/attachments/link"), {
      entityType: "task",
      entityId: task.id,
      fileId: file.id,
    });
    assert.equal(linked.status, 201, linked.bytes.toString());
    for (const [url, actor] of [
      [api(`/files/${file.id}/download?inline=true`), "OWNER"],
      [
        api(`/attachments/${linked.json().data.id}/download?inline=true`),
        "OWNER",
      ],
      [
        `/api/public/files/${publicLink.token}/${file.id}/download?inline=true`,
        null,
      ],
    ]) {
      const response = await request("GET", url, undefined, actor);
      const fallback = filename(response, name);
      if (["ordinary.txt", "report with spaces.txt"].includes(name))
        assert.equal(fallback, name);
      assert.equal(
        response.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(response.bytes, bytes);
    }
    // Formatting does not normalize or rename persisted source/attachment data.
    assert.equal(
      (await app.prisma.file.findUnique({ where: { id: file.id } })).name,
      name,
    );
    assert.equal(
      (
        await app.prisma.attachment.findUnique({
          where: { id: linked.json().data.id },
        })
      ).name,
      name,
    );
  });

test("permitted Unicode image download retains current inline MIME, sandbox and cache policy", async () => {
  const image = await upload("image.png", "image/png", png);
  const name = "画像 📄.png";
  assert.equal(
    (await request("PATCH", api(`/files/${image.id}`), { name })).status,
    200,
  );
  const response = await request(
    "GET",
    api(`/files/${image.id}/download?inline=true`),
  );
  filename(response, name, "inline");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(
    response.headers.get("content-security-policy"),
    /(?:^|;)\s*sandbox(?:;|$)/,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(response.bytes, png);
});

test("Unicode folder archive names and ZIP content survive actual HTTP headers", async () => {
  const name = '資料 "folder" %20';
  const created = await request("POST", api("/files/folder"), { name });
  assert.equal(created.status, 201, created.bytes.toString());
  const folder = created.json().data;
  await upload("child.txt", "text/plain", bytes, folder.id);
  const response = await request("POST", api("/files/archive"), {
    fileIds: [folder.id],
  });
  filename(response, `${name}.zip`);
  assert.equal(response.headers.get("content-type"), "application/zip");
  const entry = new AdmZip(response.bytes)
    .getEntries()
    .find((value) => value.entryName.endsWith("child.txt"));
  assert(entry);
  assert.deepEqual(entry.getData(), bytes);
});

test("backup export uses the common filename contract while retaining its ZIP data and MIME", async () => {
  const response = await request(
    "POST",
    api("/backup/export"),
    { projects: [{ projectId: project.id }], includeFiles: false },
    "ADMIN",
  );
  const name = `backup-${workspace.slug}-${new Date().toISOString().slice(0, 10)}.zip`;
  assert.equal(filename(response, name), name);
  assert.equal(response.headers.get("content-type"), "application/zip");
  const backup = new AdmZip(response.bytes).getEntry("backup.json");
  assert(backup);
  assert.equal(
    JSON.parse(backup.getData().toString()).metadata.sourceWorkspace.slug,
    workspace.slug,
  );
});

test("denied and missing file reads retain their JSON errors without download headers", async () => {
  const snapshot = await app.prisma.file.findUnique({ where: { id: file.id } });
  const denied = await request(
    "GET",
    api(`/files/${file.id}/download`),
    undefined,
    "PEER",
  );
  assert([403, 404].includes(denied.status));
  const missing = await request(
    "GET",
    api(`/files/${crypto.randomUUID()}/download`),
  );
  assert.equal(missing.status, 404);
  for (const response of [denied, missing]) {
    assert.equal(response.headers.get("content-disposition"), null);
    assert.match(response.headers.get("content-type"), /^application\/json/);
  }
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: file.id } }),
    snapshot,
  );
});
