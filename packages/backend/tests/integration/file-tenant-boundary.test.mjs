import assert from "node:assert/strict";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "file-access-integration-jwt-secret",
  COOKIE_SECRET: "file-access-integration-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-file-access-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
let app, workspace, foreign, own, peer, foreignFile;
const users = {},
  tokens = {};
let requests = 0,
  reads = 0,
  writes = 0,
  events = 0,
  deletes = 0;
const base = () => `/api/workspaces/${workspace.id}`;
const req = (actor, method, url, payload) =>
  app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.80.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
const denied = (r) => {
  assert([403, 404].includes(r.statusCode), `${r.statusCode}: ${r.body}`);
  assert(!r.body.includes("Route "), r.body);
};
async function makeFile(actor, data = {}) {
  const wid = data.workspaceId ?? workspace.id;
  const storagePath = data.isFolder
    ? null
    : await app.storage.save(
        `${wid}/files`,
        users[actor].id,
        crypto.randomUUID(),
        ".txt",
        Buffer.from(`bytes-${actor}`),
      );
  return app.prisma.file.create({
    data: {
      workspaceId: wid,
      name: `Access ${actor}`,
      mimeType: "text/plain",
      size: 10,
      storagePath,
      ownerId: users[actor].id,
      uploadedById: users[actor].id,
      ...data,
    },
  });
}
before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  for (const actor of ["ADMIN", "MEMBER", "PEER", "VIEWER", "FOREIGN"]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `file-${actor}-${suffix}@example.test`,
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
      name: "File access",
      slug: `file-${suffix}`,
      members: {
        create: ["ADMIN", "MEMBER", "PEER", "VIEWER"].map((a) => ({
          userId: users[a].id,
          role: a === "ADMIN" ? "ADMIN" : a === "VIEWER" ? "VIEWER" : "MEMBER",
        })),
      },
    },
  });
  foreign = await app.prisma.workspace.create({
    data: {
      name: "Foreign",
      slug: `foreign-file-${suffix}`,
      members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } },
    },
  });
  own = await makeFile("MEMBER");
  peer = await makeFile("PEER");
  foreignFile = await makeFile("FOREIGN", { workspaceId: foreign.id });
  app.broadcastToUser = () => {
    events++;
  };
  app.broadcastToWorkspace = () => {
    events++;
  };
  const readStream = app.storage.readStream.bind(app.storage),
    saveStream = app.storage.saveStream.bind(app.storage),
    deleteStored = app.storage.delete.bind(app.storage);
  app.storage.delete = (...args) => {
    deletes++;
    return deleteStored(...args);
  };
  app.storage.readStream = (...args) => {
    reads++;
    return readStream(...args);
  };
  app.storage.saveStream = (...args) => {
    writes++;
    return saveStream(...args);
  };
});
after(async () => {
  try {
    if (app) {
      const ids = [workspace?.id, foreign?.id].filter(Boolean);
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function team(viaGroup = false) {
  const root = await makeFile("ADMIN", { isFolder: true, ownerId: null });
  const folder = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: "Scoped team",
      ...(viaGroup ? {} : { members: { create: { userId: users.MEMBER.id } } }),
    },
  });
  let group;
  if (viaGroup)
    group = await app.prisma.group.create({
      data: {
        workspaceId: workspace.id,
        name: crypto.randomUUID(),
        members: { create: { userId: users.MEMBER.id } },
        teamFolderGroups: { create: { teamFolderId: folder.id } },
      },
    });
  const file = await makeFile("ADMIN", {
    ownerId: null,
    teamFolderId: folder.id,
    parentId: root.id,
    name: `team-${crypto.randomUUID()}`,
  });
  return { root, folder, file, group };
}

test("create/copy/move reject foreign, inaccessible, nonfolder, trashed and inconsistent destinations without side effects", async () => {
  const folder = await makeFile("MEMBER", { isFolder: true }),
    foreignFolder = await makeFile("FOREIGN", {
      workspaceId: foreign.id,
      isFolder: true,
    }),
    privateFolder = await makeFile("PEER", { isFolder: true }),
    trash = await makeFile("MEMBER", { isFolder: true, trashedAt: new Date() });
  const { folder: target } = await team();
  await app.prisma.teamFolderMember.deleteMany({
    where: { teamFolderId: target.id },
  });
  const initial = await app.prisma.file.findUnique({ where: { id: own.id } }),
    count = await app.prisma.file.count({
      where: { workspaceId: workspace.id },
    }),
    initialReads = reads,
    initialWrites = writes;
  for (const dest of [
    { parentId: foreignFolder.id },
    { parentId: privateFolder.id },
    { parentId: own.id },
    { parentId: trash.id },
    { parentId: null, teamFolderId: target.id },
    { parentId: folder.id, teamFolderId: target.id },
    { parentId: "missing" },
  ])
    for (const [method, url, body] of [
      [
        "POST",
        "/files/folder",
        { name: "Denied", ...dest, parentId: dest.parentId ?? undefined },
      ],
      ["POST", `/files/${own.id}/copy`, dest],
      ["PATCH", `/files/${own.id}`, dest],
    ]) {
      const r = await req("MEMBER", method, base() + url, body);
      assert([400, 403, 404].includes(r.statusCode), r.body);
    }
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: own.id } }),
    initial,
  );
  assert.equal(
    await app.prisma.file.count({ where: { workspaceId: workspace.id } }),
    count,
  );
  assert.equal(reads, initialReads);
  assert.equal(writes, initialWrites);
});

test("archive rejects mixed private/foreign IDs and corrupt foreign descendants before reading bytes", async () => {
  const folder = await makeFile("MEMBER", { isFolder: true });
  await makeFile("FOREIGN", { workspaceId: foreign.id, parentId: folder.id });
  const initialReads = reads;
  try {
    for (const fileIds of [
      [own.id, foreignFile.id],
      [own.id, peer.id],
      [folder.id],
    ])
      denied(
        await req("MEMBER", "POST", `${base()}/files/archive`, { fileIds }),
      );
    assert.equal(reads, initialReads);
  } finally {
    await app.prisma.file.updateMany({
      where: { parentId: folder.id },
      data: { parentId: null },
    });
  }
});

function multipart(parentId, content = "uploaded bytes") {
  const boundary = "werkyn-file-access-boundary";
  return {
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    ),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
async function upload(actor, parentId) {
  const { headers, payload } = multipart(parentId);
  return app.inject({
    method: "POST",
    url: `${base()}/files/upload`,
    payload,
    headers: { ...headers, authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.81.0.${(++requests % 250) + 1}`,
  });
}

test("multipart upload validates destination before storage and preserves personal folder ownership for admins", async () => {
  const foreignFolder = await makeFile("FOREIGN", {
    workspaceId: foreign.id,
    isFolder: true,
  });
  const privateFolder = await makeFile("PEER", { isFolder: true });
  const ownFolder = await makeFile("MEMBER", { isFolder: true });
  const trash = await makeFile("MEMBER", {
    isFolder: true,
    trashedAt: new Date(),
  });
  const count = await app.prisma.file.count({
      where: { workspaceId: workspace.id },
    }),
    initialWrites = writes;
  for (const [actor, parent] of [
    ["ADMIN", foreignFolder],
    ["MEMBER", privateFolder],
    ["MEMBER", trash],
    ["MEMBER", own],
  ]) {
    const r = await upload(actor, parent.id);
    assert([400, 403, 404].includes(r.statusCode), r.body);
    assert(!r.body.includes("Route "), r.body);
  }
  assert.equal(writes, initialWrites);
  assert.equal(
    await app.prisma.file.count({ where: { workspaceId: workspace.id } }),
    count,
  );
  for (const actor of ["MEMBER", "ADMIN"]) {
    const r = await upload(actor, ownFolder.id);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().data.parentId, ownFolder.id);
    assert.equal(r.json().data.ownerId, users.MEMBER.id);
  }
});

test("valid subtree move is atomic across scope; self and descendant destinations are rejected", async () => {
  const folder = await makeFile("MEMBER", { isFolder: true });
  const child = await makeFile("MEMBER", {
    parentId: folder.id,
    isFolder: true,
  });
  const leaf = await makeFile("MEMBER", { parentId: child.id });
  const { root, folder: target } = await team();
  for (const parentId of [folder.id, child.id])
    denied(
      await req("MEMBER", "PATCH", `${base()}/files/${folder.id}`, {
        parentId,
      }),
    );
  const moved = await req("MEMBER", "PATCH", `${base()}/files/${folder.id}`, {
    parentId: root.id,
    teamFolderId: target.id,
  });
  assert.equal(moved.statusCode, 200, moved.body);
  for (const id of [folder.id, child.id, leaf.id]) {
    const file = await app.prisma.file.findUnique({ where: { id } });
    assert.equal(file.teamFolderId, target.id);
    assert.equal(file.ownerId, null);
  }
  assert.equal(
    (await req("MEMBER", "GET", `${base()}/files/${leaf.id}/download`))
      .statusCode,
    200,
  );
  const back = await req("MEMBER", "PATCH", `${base()}/files/${folder.id}`, {
    parentId: null,
    teamFolderId: null,
  });
  assert.equal(back.statusCode, 200, back.body);
  for (const id of [folder.id, child.id, leaf.id]) {
    const file = await app.prisma.file.findUnique({ where: { id } });
    assert.equal(file.teamFolderId, null);
    assert.equal(file.ownerId, users.MEMBER.id);
  }
});

test("missing or foreign share recipients cannot cause partial grants", async () => {
  const file = await makeFile("MEMBER");
  for (const invalid of [users.FOREIGN.id, "missing"]) {
    denied(
      await req("MEMBER", "POST", `${base()}/files/shares`, {
        fileIds: [file.id],
        userIds: [users.PEER.id, invalid],
      }),
    );
    assert.equal(
      await app.prisma.fileShare.count({ where: { fileId: file.id } }),
      0,
    );
  }
});

test("source operations require the resource workspace before admin or owner access", async () => {
  const snapshot = await app.prisma.file.findUnique({
    where: { id: foreignFile.id },
  });
  const initialReads = reads,
    initialWrites = writes,
    initialEvents = events,
    initialDeletes = deletes;
  for (const actor of ["ADMIN", "MEMBER"]) {
    for (const suffix of [
      "",
      "/download",
      "/thumbnail",
      "/breadcrumbs",
      "/attachments-count",
      "/shares",
      "/share-links",
    ])
      denied(
        await req(actor, "GET", `${base()}/files/${foreignFile.id}${suffix}`),
      );
    for (const [method, suffix, payload] of [
      ["POST", "/copy", { parentId: null }],
      ["POST", "/star", undefined],
      ["PATCH", "", { name: "Denied" }],
      ["DELETE", "", undefined],
    ])
      denied(
        await req(
          actor,
          method,
          `${base()}/files/${foreignFile.id}${suffix}`,
          payload,
        ),
      );
  }
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: foreignFile.id } }),
    snapshot,
  );
  assert.equal(reads, initialReads);
  assert.equal(writes, initialWrites);
  assert.equal(events, initialEvents);
  assert.equal(deletes, initialDeletes);
});

test("all share sources are authorized before rows, notifications or events are created", async () => {
  const trash = await makeFile("MEMBER", { trashedAt: new Date() });
  const snapshot = await Promise.all([
    app.prisma.fileShare.count(),
    app.prisma.fileShareLink.count(),
    app.prisma.fileShareLinkFile.count(),
    app.prisma.notification.count(),
  ]);
  const initialReads = reads,
    initialWrites = writes,
    initialEvents = events;
  for (const [actor, invalid] of [
    ["ADMIN", foreignFile.id],
    ["MEMBER", peer.id],
    ["MEMBER", trash.id],
    ["ADMIN", "missing"],
  ]) {
    for (const type of ["shares", "share-links"])
      denied(
        await req(actor, "POST", `${base()}/files/${type}`, {
          fileIds: [own.id, invalid],
          userIds: [users.PEER.id],
        }),
      );
  }
  assert.deepEqual(
    await Promise.all([
      app.prisma.fileShare.count(),
      app.prisma.fileShareLink.count(),
      app.prisma.fileShareLinkFile.count(),
      app.prisma.notification.count(),
    ]),
    snapshot,
  );
  assert.equal(reads, initialReads);
  assert.equal(writes, initialWrites);
  assert.equal(events, initialEvents);
  const created = await req("ADMIN", "POST", `${base()}/files/share-links`, {
    fileIds: [own.id, peer.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  const token = created.json().data.token;
  const publicFile = await app.inject({
    method: "GET",
    url: `/api/public/files/${token}/${own.id}/download`,
  });
  assert.equal(publicFile.statusCode, 200, publicFile.body);
  assert.equal(publicFile.body, "bytes-MEMBER");
});

test("legacy public entries omit foreign and trashed sources and cannot stream their content", async () => {
  const trash = await makeFile("MEMBER", {
    name: "Trashed source",
    trashedAt: new Date(),
  });
  const link = await app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: users.ADMIN.id,
      token: crypto.randomUUID(),
      files: {
        create: [own.id, foreignFile.id, trash.id].map((fileId) => ({
          fileId,
        })),
      },
    },
  });
  const result = await app.inject({
    method: "GET",
    url: `/api/public/files/${link.token}`,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    result.json().data.files.map((entry) => entry.file.id),
    [own.id],
  );
  assert(!result.body.includes(foreignFile.name));
  assert(!result.body.includes(trash.name));
  const initialReads = reads;
  for (const file of [foreignFile, trash]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/public/files/${link.token}/${file.id}/download`,
    });
    assert.equal(response.statusCode, 404, response.body);
    assert(
      !response.body.includes(`bytes-${file === trash ? "MEMBER" : "FOREIGN"}`),
    );
  }
  assert.equal(reads, initialReads);
  const active = await app.inject({
    method: "GET",
    url: `/api/public/files/${link.token}/${own.id}/download`,
  });
  assert.equal(active.statusCode, 200, active.body);
});

test("current membership and role override supplied service roles for reads, writes and root destinations", async () => {
  const { assertFileAccess } =
    await import("../../src/modules/files/file-access.ts");
  const files = await import("../../src/modules/files/files.service.ts");
  const viewerFile = await makeFile("VIEWER");
  const viewerCtx = {
    workspaceId: workspace.id,
    userId: users.VIEWER.id,
    workspaceRole: "ADMIN",
  };
  await assertFileAccess(app.prisma, viewerFile.id, viewerCtx);
  await assert.rejects(
    assertFileAccess(app.prisma, viewerFile.id, viewerCtx, true),
    /Read-only/,
  );
  await assert.rejects(
    files.createFolder(
      app.prisma,
      workspace.id,
      users.VIEWER.id,
      { name: "Denied" },
      viewerCtx,
    ),
    /Read-only/,
  );
  await assert.rejects(
    assertFileAccess(app.prisma, peer.id, {
      workspaceId: workspace.id,
      userId: users.MEMBER.id,
      workspaceRole: "ADMIN",
    }),
    /access/,
  );
  await assert.rejects(
    assertFileAccess(app.prisma, foreignFile.id, {
      workspaceId: workspace.id,
      userId: users.FOREIGN.id,
      workspaceRole: "ADMIN",
    }),
    /not found/,
  );
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.VIEWER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    await assert.rejects(
      assertFileAccess(app.prisma, viewerFile.id, viewerCtx),
      /member/,
    );
    await assert.rejects(
      files.createFolder(
        app.prisma,
        workspace.id,
        users.VIEWER.id,
        { name: "Denied" },
        viewerCtx,
      ),
      /member/,
    );
    denied(
      await req("VIEWER", "GET", `${base()}/files/${viewerFile.id}/download`),
    );
  } finally {
    await app.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: users.VIEWER.id,
        role: "VIEWER",
      },
    });
  }
});

for (const viaGroup of [false, true])
  test(`${viaGroup ? "group" : "direct"} team membership retains reads and destination writes and rechecks revocation`, async () => {
    const { root, folder, file, group } = await team(viaGroup);
    assert.equal(
      (await req("MEMBER", "GET", `${base()}/files/${file.id}/download`))
        .statusCode,
      200,
    );
    const listing = await req(
      "MEMBER",
      "GET",
      `${base()}/files?teamFolderId=${folder.id}`,
    );
    assert.equal(listing.statusCode, 200, listing.body);
    assert(listing.json().data.some((f) => f.id === file.id));
    const created = await req("MEMBER", "POST", `${base()}/files/folder`, {
      teamFolderId: folder.id,
      name: "Allowed",
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.parentId, root.id);
    assert.equal(created.json().data.ownerId, null);
    const copied = await req(
      "MEMBER",
      "POST",
      `${base()}/files/${own.id}/copy`,
      { parentId: null, teamFolderId: folder.id },
    );
    assert.equal(copied.statusCode, 201, copied.body);
    assert.equal(copied.json().data.parentId, root.id);
    const archive = await req("MEMBER", "POST", `${base()}/files/archive`, {
      fileIds: [root.id],
    });
    assert.equal(archive.statusCode, 200, archive.body);
    const zip = new AdmZip(archive.rawPayload);
    assert.equal(zip.readAsText(`${root.name}/${file.name}`), "bytes-ADMIN");
    if (viaGroup)
      await app.prisma.groupMember.deleteMany({
        where: { groupId: group.id, userId: users.MEMBER.id },
      });
    else
      await app.prisma.teamFolderMember.deleteMany({
        where: { teamFolderId: folder.id, userId: users.MEMBER.id },
      });
    const initialReads = reads,
      initialWrites = writes;
    denied(await req("MEMBER", "GET", `${base()}/files/${file.id}/download`));
    denied(
      await req("MEMBER", "POST", `${base()}/files/folder`, {
        parentId: root.id,
        name: "Denied",
      }),
    );
    assert.equal(reads, initialReads);
    assert.equal(writes, initialWrites);
  });

test("foreign team roots and inconsistent team relations cannot authorize destinations", async () => {
  const foreignRoot = await makeFile("FOREIGN", {
    workspaceId: foreign.id,
    isFolder: true,
    ownerId: null,
  });
  const team = await app.prisma.teamFolder.create({
    data: {
      workspaceId: foreign.id,
      folderId: foreignRoot.id,
      name: "Other workspace",
    },
  });
  const legacy = await makeFile("ADMIN", {
    isFolder: true,
    ownerId: null,
    teamFolderId: team.id,
  });
  const initialReads = reads,
    initialWrites = writes;
  const before = await app.prisma.file.findUnique({ where: { id: own.id } });
  const count = await app.prisma.file.count();
  for (const destination of [
    { parentId: null, teamFolderId: team.id },
    { parentId: legacy.id },
  ]) {
    for (const [method, suffix, body] of [
      [
        "POST",
        "/folder",
        {
          name: "Denied",
          ...destination,
          parentId: destination.parentId ?? undefined,
        },
      ],
      ["POST", `/${own.id}/copy`, destination],
      ["PATCH", `/${own.id}`, destination],
    ])
      denied(await req("ADMIN", method, `${base()}/files${suffix}`, body));
  }
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: own.id } }),
    before,
  );
  assert.equal(await app.prisma.file.count(), count);
  assert.equal(reads, initialReads);
  assert.equal(writes, initialWrites);
});

test("same-workspace admin destinations preserve another owner's personal scope", async () => {
  const parent = await makeFile("PEER", { isFolder: true });
  const source = await makeFile("MEMBER");
  const folder = await req("ADMIN", "POST", `${base()}/files/folder`, {
    parentId: parent.id,
    name: "Admin-created",
  });
  const copy = await req("ADMIN", "POST", `${base()}/files/${source.id}/copy`, {
    parentId: parent.id,
  });
  const moved = await req("ADMIN", "PATCH", `${base()}/files/${source.id}`, {
    parentId: parent.id,
  });
  for (const result of [folder, copy, moved]) {
    assert([200, 201].includes(result.statusCode), result.body);
    assert.equal(result.json().data.ownerId, users.PEER.id);
    assert.equal(result.json().data.teamFolderId, null);
  }
  assert.equal(
    (await req("PEER", "GET", `${base()}/files/${source.id}/download`))
      .statusCode,
    200,
  );
});

test("subtree destination changes roll back together after a database transaction failure", async () => {
  const parent = await makeFile("MEMBER", { isFolder: true });
  const child = await makeFile("MEMBER", { parentId: parent.id });
  const { root } = await team();
  const before = await app.prisma.file.findMany({
    where: { id: { in: [parent.id, child.id] } },
    orderBy: { id: "asc" },
  });
  const transaction = app.prisma.$transaction.bind(app.prisma);
  app.prisma.$transaction = (operations) =>
    transaction([
      ...operations,
      app.prisma.file.update({
        where: { id: crypto.randomUUID() },
        data: { name: "Unavailable fixture" },
      }),
    ]);
  try {
    const response = await req(
      "MEMBER",
      "PATCH",
      `${base()}/files/${parent.id}`,
      { parentId: root.id },
    );
    assert.equal(response.statusCode, 500);
  } finally {
    app.prisma.$transaction = transaction;
  }
  assert.deepEqual(
    await app.prisma.file.findMany({
      where: { id: { in: [parent.id, child.id] } },
      orderBy: { id: "asc" },
    }),
    before,
  );
});

test("trashed sources reject content reads and sharing while an owner can restore them", async () => {
  const file = await makeFile("MEMBER", { trashedAt: new Date() });
  const initialReads = reads;
  denied(await req("MEMBER", "GET", `${base()}/files/${file.id}/download`));
  denied(
    await req("MEMBER", "POST", `${base()}/files/share-links`, {
      fileIds: [file.id],
    }),
  );
  assert.equal(reads, initialReads);
  const restored = await req("MEMBER", "PATCH", `${base()}/files/${file.id}`, {
    trashedAt: null,
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(
    (await req("MEMBER", "GET", `${base()}/files/${file.id}/download`))
      .statusCode,
    200,
  );
});

test("legacy foreign groups and nonfolder team roots confer no file authority", async () => {
  const root = await makeFile("ADMIN", { isFolder: true, ownerId: null });
  const localTeam = await app.prisma.teamFolder.create({
    data: { workspaceId: workspace.id, folderId: root.id, name: "Local team" },
  });
  await app.prisma.group.create({
    data: {
      workspaceId: foreign.id,
      name: crypto.randomUUID(),
      members: { create: { userId: users.MEMBER.id } },
      teamFolderGroups: { create: { teamFolderId: localTeam.id } },
    },
  });
  const file = await makeFile("ADMIN", {
    ownerId: null,
    teamFolderId: localTeam.id,
    parentId: root.id,
  });
  const nonfolder = await makeFile("ADMIN", { ownerId: null });
  const malformed = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: nonfolder.id,
      name: "Invalid root",
    },
  });
  const legacyChild = await makeFile("ADMIN", {
    ownerId: null,
    teamFolderId: malformed.id,
    isFolder: true,
    parentId: nonfolder.id,
  });
  const initialReads = reads,
    initialWrites = writes;
  denied(await req("MEMBER", "GET", `${base()}/files/${file.id}/download`));
  denied(
    await req("MEMBER", "POST", `${base()}/files/folder`, {
      parentId: root.id,
      name: "Denied",
    }),
  );
  denied(
    await req("ADMIN", "POST", `${base()}/files/folder`, {
      parentId: legacyChild.id,
      name: "Denied",
    }),
  );
  assert.equal(reads, initialReads);
  assert.equal(writes, initialWrites);
});

test("legacy share lists and indicators exclude foreign and trashed source rows", async () => {
  const trash = await makeFile("MEMBER", { trashedAt: new Date() });
  for (const file of [own, foreignFile, trash])
    await app.prisma.fileShare.create({
      data: {
        workspaceId: workspace.id,
        fileId: file.id,
        sharedById: users.MEMBER.id,
        sharedWithId: users.PEER.id,
      },
    });
  const link = await app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: users.MEMBER.id,
      token: crypto.randomUUID(),
      files: {
        create: [own, foreignFile, trash].map((file) => ({ fileId: file.id })),
      },
    },
  });
  for (const [actor, path] of [
    ["PEER", "shared-with-me"],
    ["MEMBER", "shared-by-me"],
  ]) {
    const result = await req(actor, "GET", `${base()}/files/${path}`);
    assert.equal(result.statusCode, 200, result.body);
    assert(result.json().data.some((entry) => entry.file.id === own.id));
    assert(
      !result
        .json()
        .data.some((entry) =>
          [foreignFile.id, trash.id].includes(entry.file.id),
        ),
    );
  }
  const status = await req(
    "MEMBER",
    "GET",
    `${base()}/files/share-status?fileIds=${[own.id, foreignFile.id, trash.id].join(",")}`,
  );
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json().data, [own.id]);
  assert(link.id);
});

test("all context-bearing list services reject removed membership", async () => {
  const ctx = {
    workspaceId: workspace.id,
    userId: users.VIEWER.id,
    workspaceRole: "ADMIN",
  };
  const files = await import("../../src/modules/files/files.service.ts");
  const shares = await import("../../src/modules/files/file-shares.service.ts");
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.VIEWER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    for (const operation of [
      () => files.listFiles(app.prisma, workspace.id, { limit: 10 }, ctx),
      () => files.listStarredFiles(app.prisma, workspace.id, ctx),
      () => files.unstarFile(app.prisma, workspace.id, own.id, ctx),
      () => shares.listSharedWithMe(app.prisma, workspace.id, ctx),
      () => shares.listSharedByMe(app.prisma, workspace.id, ctx),
      () => shares.getFileShareStatus(app.prisma, workspace.id, [own.id], ctx),
    ])
      await assert.rejects(operation(), /member/);
  } finally {
    await app.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: users.VIEWER.id,
        role: "VIEWER",
      },
    });
  }
});

test("member share issuance retains legitimate same-workspace behavior", async () => {
  const file = await makeFile("MEMBER");
  const created = await req("MEMBER", "POST", `${base()}/files/shares`, {
    fileIds: [file.id],
    userIds: [users.PEER.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.count, 1);
  assert.equal(
    await app.prisma.fileShare.count({
      where: {
        fileId: file.id,
        workspaceId: workspace.id,
        sharedWithId: users.PEER.id,
      },
    }),
    1,
  );
  // Notification delivery is asynchronous; settle it before fixture cleanup.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (
      await app.prisma.notification.count({
        where: {
          userId: users.PEER.id,
          data: { path: ["fileId"], equals: file.id },
        },
      })
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected the legitimate share notification");
});
