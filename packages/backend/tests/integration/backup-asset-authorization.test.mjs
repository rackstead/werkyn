import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-assets-integration-jwt-secret",
  COOKIE_SECRET: "backup-assets-integration-cookie-secret",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-backup-assets-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { exportBackup } =
  await import("../../src/modules/backup/backup.service.ts");
let app, own, foreign, space, otherSpace, foreignSpace, page;
const users = {},
  tokens = {},
  reads = [];
let requests = 0;
const bytes = (label) => Buffer.from(`Benign backup fixture: ${label}`);
const url = (storagePath) => `/storage/${storagePath}`;
const options = (includeFiles = true) => ({
  projects: [],
  channels: [],
  wikiSpaces: [{ spaceId: space.id, includeComments: true }],
  includeFiles,
});
const request = (actor = "ADMIN", includeFiles = true) =>
  app.inject({
    method: "POST",
    url: `/api/workspaces/${own.id}/backup/export`,
    headers: actor ? { authorization: `Bearer ${tokens[actor]}` } : {},
    payload: options(includeFiles),
    remoteAddress: `127.0.2.${1 + (++requests % 200)}`,
  });
async function put(storagePath, label = storagePath) {
  await app.storage.save(
    path.posix.dirname(storagePath),
    "",
    path.posix.basename(storagePath),
    "",
    bytes(label),
  );
  return storagePath;
}
async function file(storagePath, workspaceId = own.id, extra = {}) {
  return app.prisma.file.create({
    data: {
      workspaceId,
      name: "Benign Drive asset",
      uploadedById: users.ADMIN.id,
      ownerId: users.ADMIN.id,
      storagePath,
      ...extra,
    },
  });
}
async function content(value) {
  await app.prisma.wikiPage.update({
    where: { id: page.id },
    data: { content: value },
  });
  reads.length = 0;
}
function unpack(response) {
  assert.equal(response.statusCode, 200, response.body);
  const zip = new AdmZip(response.rawPayload);
  return {
    zip,
    json: JSON.parse(zip.getEntry("backup.json").getData().toString()),
  };
}
async function snapshot() {
  return {
    pages: await app.prisma.wikiPage.findMany({
      where: { spaceId: { in: [space.id, otherSpace.id, foreignSpace.id] } },
      orderBy: { id: "asc" },
    }),
    files: await app.prisma.file.findMany({
      where: { workspaceId: { in: [own.id, foreign.id] } },
      orderBy: { id: "asc" },
    }),
    users: await app.prisma.user.findMany({
      where: { id: { in: Object.values(users).map((u) => u.id) } },
      orderBy: { id: "asc" },
    }),
  };
}

before(async () => {
  app = await buildApp();
  await app.ready();
  for (const actor of ["ADMIN", "MEMBER", "VIEWER", "FOREIGN", "FORMER"]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `backup-${actor}-${crypto.randomUUID()}@example.test`,
        displayName: actor,
        emailVerified: true,
      },
    });
    tokens[actor] = signAccessToken({
      sub: users[actor].id,
      email: users[actor].email,
    });
  }
  own = await app.prisma.workspace.create({
    data: {
      name: "Authorized backup fixture",
      slug: crypto.randomUUID(),
      members: {
        create: ["ADMIN", "MEMBER", "VIEWER", "FORMER"].map((actor) => ({
          userId: users[actor].id,
          role: actor === "ADMIN" || actor === "FORMER" ? "ADMIN" : actor,
        })),
      },
    },
  });
  foreign = await app.prisma.workspace.create({
    data: {
      name: "Other backup fixture",
      slug: crypto.randomUUID(),
      members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: own.id, name: "Selected", slug: "selected" },
  });
  otherSpace = await app.prisma.wikiSpace.create({
    data: { workspaceId: own.id, name: "Not selected", slug: "other" },
  });
  foreignSpace = await app.prisma.wikiSpace.create({
    data: { workspaceId: foreign.id, name: "Other workspace", slug: "other" },
  });
  page = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Exported page",
      createdById: users.ADMIN.id,
      content: [],
    },
  });
  const read = app.storage.read.bind(app.storage);
  app.storage.read = async (storagePath) => {
    reads.push(storagePath);
    return read(storagePath);
  };
});
after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [own?.id, foreign?.id].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("authorized wiki JSON references keep bytes, metadata and nested/text/link rewriting without database writes", async () => {
  const paths = [
    await put(`${own.id}/uploads/wiki/${space.id}/image.png`),
    await put(`${own.id}/uploads/wiki/${otherSpace.id}/2026/10/audio.wav`),
    await put(`${own.id}/uploads/wiki/imports/restored.png`),
  ];
  const doc = [
    {
      type: "image",
      props: { url: url(paths[0]) },
      children: [
        {
          type: "paragraph",
          content: [
            {
              type: "link",
              href: url(paths[1]),
              content: [{ type: "text", text: `See ${url(paths[2])}` }],
            },
          ],
        },
      ],
    },
  ];
  await content(doc);
  const initial = await snapshot();
  const { zip, json } = unpack(await request());
  assert.deepEqual(new Set(reads), new Set(paths));
  for (const p of paths)
    assert.deepEqual(
      zip.getEntry(`assets/${path.basename(p)}`).getData(),
      bytes(p),
    );
  const exported = json.wikiSpaces[0].pages[0];
  assert.equal(exported.title, page.title);
  assert.equal(exported.content[0].props.url, "assets/image.png");
  assert.equal(
    exported.content[0].children[0].content[0].href,
    "assets/audio.wav",
  );
  assert.equal(
    exported.content[0].children[0].content[0].content[0].text,
    "See assets/restored.png",
  );
  assert.equal(json.metadata.sourceWorkspace.name, own.name);
  assert.equal(json.metadata.version, "1.1");
  assert.deepEqual(await snapshot(), initial);
});

test("actual Drive records authorize originals and thumbnails including immutable legacy paths", async () => {
  const original = await put(
    `files/${users.MEMBER.id}/2026/10/legacy-drive.png`,
  );
  const thumbnail = await put(`${foreign.id}/files/old-owner/thumbnail.webp`);
  await file(original, own.id, {
    ownerId: users.MEMBER.id,
    thumbnailPath: thumbnail,
  });
  await content([
    { type: "image", props: { url: url(original) } },
    { type: "image", props: { url: url(thumbnail) } },
  ]);
  const { zip } = unpack(await request());
  assert.deepEqual(reads, [original, thumbnail]);
  assert.deepEqual(
    zip.getEntry("assets/legacy-drive.png").getData(),
    bytes(original),
  );
  assert.deepEqual(
    zip.getEntry("assets/thumbnail.webp").getData(),
    bytes(thumbnail),
  );
});

test("foreign or trashed records override plausible local upload namespaces and never open bytes", async () => {
  const denied = [
    await put(`${own.id}/uploads/wiki/${space.id}/moved-away.png`),
    await put(`${own.id}/uploads/wiki/imports/moved-thumbnail.png`),
    await put(`${own.id}/files/user/trashed.png`),
  ];
  await file(denied[0], foreign.id);
  await file(`files/foreign/other.png`, foreign.id, {
    thumbnailPath: denied[1],
  });
  await file(denied[2], own.id, { trashedAt: new Date() });
  const doc = denied.map((p) => ({ type: "image", props: { url: url(p) } }));
  await content(doc);
  const initial = await snapshot();
  const { zip, json } = unpack(await request());
  assert.deepEqual(reads, []);
  assert.deepEqual(
    zip.getEntries().map((e) => e.entryName),
    ["backup.json"],
  );
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, doc);
  assert.deepEqual(await snapshot(), initial);
});

test("foreign wiki spaces, orphan namespaces and unowned legacy/private paths stay unchanged without reads", async () => {
  const denied = [
    await put(`${foreign.id}/uploads/wiki/${foreignSpace.id}/other.png`),
    await put(`${own.id}/uploads/wiki/${foreignSpace.id}/crafted.png`),
    await put(`${own.id}/uploads/wiki/no-such-space/orphan.png`),
    await put(`${own.id}/files/no-record.png`),
    await put(`uploads/${users.ADMIN.id}/2026/10/unowned.png`),
    await put(`avatars/${users.FOREIGN.id}/old.webp`),
  ];
  const doc = { nested: denied.map((p) => url(p)) };
  await content(doc);
  const { zip, json } = unpack(await request());
  assert.deepEqual(reads, []);
  assert.equal(zip.getEntries().length, 1);
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, doc);
});

test("public avatar exception requires the namespace owner, current membership and matching profile URL", async () => {
  const avatar = await put(
    `avatars/${users.MEMBER.id}/2026/10/current-avatar.webp`,
  );
  await app.prisma.user.update({
    where: { id: users.MEMBER.id },
    data: { avatarUrl: url(avatar) },
  });
  await content([{ props: { url: url(avatar) } }]);
  const { zip } = unpack(await request());
  assert.deepEqual(reads, [avatar]);
  assert.deepEqual(
    zip.getEntry("assets/current-avatar.webp").getData(),
    bytes(avatar),
  );
  const unowned = await put(`uploads/${users.MEMBER.id}/forged-avatar.webp`);
  await app.prisma.user.update({
    where: { id: users.MEMBER.id },
    data: { avatarUrl: url(unowned) },
  });
  await content([url(unowned), url(avatar)]);
  unpack(await request());
  assert.deepEqual(reads, []);
});

test("denied and missing full references are not rewritten through an authorized prefix", async () => {
  const good = await put(`${own.id}/uploads/wiki/${space.id}/prefix.png`);
  const missing = `${good}-missing`;
  const denied = await put(`${good}-denied`);
  await file(denied, foreign.id);
  const doc = {
    allowed: url(good),
    denied: url(denied),
    missing: url(missing),
    text: `Literal ${url(missing)}`,
  };
  await content(doc);
  const { zip, json } = unpack(await request());
  assert.deepEqual(new Set(reads), new Set([good, missing]));
  assert.equal(zip.getEntries().length, 2);
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, {
    allowed: "assets/prefix.png",
    denied: url(denied),
    missing: url(missing),
    text: `Literal ${url(missing)}`,
  });
});

test("canonical URL spelling permits encoded filename and query suffix without path escapes", async () => {
  const asset = await put(`${own.id}/uploads/wiki/${space.id}/space name.png`);
  const allowed =
    url(asset).replace("space name", "space%20name") +
    "?token=benign-fixture#preview";
  const invalid = [
    `/storage/${own.id}/uploads/wiki/${space.id}/../name.png`,
    `/storage/${own.id}/uploads/wiki/${space.id}/%2e%2e/name.png`,
    `/storage/${own.id}/uploads/wiki/${space.id}/%252e%252e/name.png`,
    `/storage/${own.id}/uploads/wiki/${space.id}/folder%2Fname.png`,
    `/storage/${own.id}/uploads/wiki/${space.id}/folder\\name.png`,
  ];
  await content([allowed, ...invalid]);
  const { json } = unpack(await request());
  assert.deepEqual(reads, [asset]);
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, [
    "assets/space name.png",
    ...invalid,
  ]);
});

test("includeFiles false performs no asset reads and preserves content", async () => {
  const doc = [
    url(`${own.id}/uploads/wiki/${space.id}/image.png`),
    url(`${foreign.id}/uploads/wiki/${foreignSpace.id}/other.png`),
  ];
  await content(doc);
  const { zip, json } = unpack(await request("ADMIN", false));
  assert.deepEqual(reads, []);
  assert.equal(zip.getEntries().length, 1);
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, doc);
});

test("HTTP and service export require current workspace ADMIN before reads", async () => {
  await content([url(`${own.id}/uploads/wiki/${space.id}/image.png`)]);
  for (const actor of [null, "MEMBER", "VIEWER", "FOREIGN"])
    assert.ok([401, 403].includes((await request(actor)).statusCode));
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: { userId: users.FORMER.id, workspaceId: own.id },
    },
  });
  const initial = await snapshot();
  for (const actor of ["MEMBER", "VIEWER", "FOREIGN", "FORMER"]) {
    await assert.rejects(
      exportBackup(app.prisma, own.id, options(), app.storage, users[actor].id),
      (error) => error.statusCode === 403,
    );
  }
  await assert.rejects(
    exportBackup(app.prisma, own.id, options(), app.storage, undefined),
    (error) => error.statusCode === 403,
  );
  assert.deepEqual(reads, []);
  assert.deepEqual(await snapshot(), initial);
  const key = {
    userId_workspaceId: { userId: users.ADMIN.id, workspaceId: own.id },
  };
  await app.prisma.workspaceMember.update({
    where: key,
    data: { role: "MEMBER" },
  });
  try {
    await assert.rejects(
      exportBackup(app.prisma, own.id, options(), app.storage, users.ADMIN.id),
      (error) => error.statusCode === 403,
    );
  } finally {
    await app.prisma.workspaceMember.update({
      where: key,
      data: { role: "ADMIN" },
    });
  }
  assert.deepEqual(reads, []);
});

test("duplicate foreign identities and invalid team relations cannot fall back to local upload paths", async () => {
  const ambiguous = await put(
    `${own.id}/uploads/wiki/${space.id}/ambiguous.png`,
  );
  await file(ambiguous);
  await file(ambiguous, foreign.id);
  const folder = await file(null, foreign.id, { isFolder: true });
  const team = await app.prisma.teamFolder.create({
    data: {
      workspaceId: foreign.id,
      folderId: folder.id,
      name: "Foreign team fixture",
    },
  });
  const mixed = await put(
    `${own.id}/uploads/wiki/${space.id}/invalid-team.png`,
  );
  await file(mixed, own.id, { teamFolderId: team.id });
  const doc = [url(ambiguous), url(mixed)];
  await content(doc);
  const initial = await snapshot();
  const { zip, json } = unpack(await request());
  assert.deepEqual(reads, []);
  assert.equal(zip.getEntries().length, 1);
  assert.deepEqual(json.wikiSpaces[0].pages[0].content, doc);
  assert.deepEqual(await snapshot(), initial);
});

test("wiki space and avatar membership changes are checked against their current identities", async () => {
  const wiki = await put(
    `${own.id}/uploads/wiki/${otherSpace.id}/moved-space.png`,
  );
  const avatar = await put(
    `${own.id}/uploads/avatars/${users.MEMBER.id}/scoped-avatar.webp`,
  );
  const foreignAvatar = await put(
    `avatars/${users.FOREIGN.id}/foreign-avatar.webp`,
  );
  await app.prisma.user.update({
    where: { id: users.MEMBER.id },
    data: { avatarUrl: url(avatar) },
  });
  await app.prisma.user.update({
    where: { id: users.FOREIGN.id },
    data: { avatarUrl: url(foreignAvatar) },
  });
  await content([url(wiki), url(avatar), url(foreignAvatar)]);
  unpack(await request());
  assert.deepEqual(reads, [wiki, avatar]);
  await app.prisma.wikiSpace.update({
    where: { id: otherSpace.id },
    data: { workspaceId: foreign.id, slug: "moved" },
  });
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: { userId: users.MEMBER.id, workspaceId: own.id },
    },
  });
  reads.length = 0;
  try {
    const { zip } = unpack(await request());
    assert.deepEqual(reads, []);
    assert.equal(zip.getEntries().length, 1);
  } finally {
    await app.prisma.wikiSpace.update({
      where: { id: otherSpace.id },
      data: { workspaceId: own.id, slug: "other" },
    });
    await app.prisma.workspaceMember.create({
      data: { userId: users.MEMBER.id, workspaceId: own.id, role: "MEMBER" },
    });
  }
});
