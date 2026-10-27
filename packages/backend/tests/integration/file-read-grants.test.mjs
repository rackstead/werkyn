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
  deletes = 0,
  events = 0;
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
  for (const actor of [
    "ADMIN",
    "MEMBER",
    "PEER",
    "VIEWER",
    "PAGED",
    "FOREIGN",
  ]) {
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
        create: ["ADMIN", "MEMBER", "PEER", "VIEWER", "PAGED"].map((a) => ({
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
  for (const [name, kind] of [
    ["read", "read"],
    ["readStream", "read"],
    ["save", "write"],
    ["saveStream", "write"],
    ["delete", "delete"],
  ]) {
    const original = app.storage[name].bind(app.storage);
    app.storage[name] = (...args) => {
      if (kind === "read") reads++;
      else if (kind === "write") writes++;
      else deletes++;
      return original(...args);
    };
  }
  app.broadcastToUser = () => {
    events++;
  };
  app.broadcastToWorkspace = () => {
    events++;
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

async function team(viaGroup = false, member = "MEMBER") {
  const root = await makeFile("ADMIN", { isFolder: true, ownerId: null });
  const folder = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: "Scoped team",
      ...(viaGroup
        ? {}
        : { members: { create: { userId: users[member].id } } }),
    },
  });
  let group;
  if (viaGroup)
    group = await app.prisma.group.create({
      data: {
        workspaceId: workspace.id,
        name: crypto.randomUUID(),
        members: { create: { userId: users[member].id } },
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

const sideEffects = () => ({ reads, writes, deletes, events });
async function state() {
  const ids = [workspace.id, foreign.id];
  return {
    files: await app.prisma.file.findMany({
      where: { workspaceId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    shares: await app.prisma.fileShare.findMany({
      where: { workspaceId: { in: ids } },
      orderBy: { id: "asc" },
    }),
    links: await app.prisma.fileShareLink.findMany({
      where: { workspaceId: { in: ids } },
      orderBy: { id: "asc" },
      include: { files: { orderBy: { id: "asc" } } },
    }),
    stars: await app.prisma.starredFile.findMany({
      where: { userId: { in: Object.values(users).map((u) => u.id) } },
      orderBy: { id: "asc" },
    }),
    notifications: await app.prisma.notification.count(),
    effects: sideEffects(),
  };
}
async function share(file, recipient = "MEMBER", actor = "PEER") {
  const r = await req(actor, "POST", `${base()}/files/shares`, {
    fileIds: [file.id],
    userIds: [users[recipient].id],
  });
  assert.equal(r.statusCode, 201, r.body);
  for (let n = 0; n < 40; n++) {
    if (
      await app.prisma.notification.count({
        where: {
          userId: users[recipient].id,
          data: { path: ["fileId"], equals: file.id },
        },
      })
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected share notification to settle");
}
async function list(actor, suffix) {
  const r = await req(actor, "GET", base() + suffix);
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function content(actor, file, expected = "bytes-PEER") {
  const r = await req(actor, "GET", `${base()}/files/${file.id}/download`);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.body, expected);
}
async function deniedUnchanged(actor, operations) {
  const before = await state();
  for (const [method, suffix, payload] of operations) {
    denied(await req(actor, method, base() + suffix, payload));
    assert.deepEqual(await state(), before);
  }
}
async function notListed(actor, file) {
  for (const suffix of [
    `/files?search=${encodeURIComponent(file.name)}`,
    "/files/starred",
  ])
    assert(!(await list(actor, suffix)).some((f) => f.id === file.id));
}
test("personal share grants reads and copies, but cannot mutate or reshare the source", async () => {
  const file = await makeFile("PEER", {
    name: `direct-${crypto.randomUUID()}`,
  });
  await share(file);
  assert.equal(
    (await req("MEMBER", "GET", `${base()}/files/${file.id}/download`)).body,
    "bytes-PEER",
  );
  assert(
    (await req("MEMBER", "GET", `${base()}/files/shared-with-me`))
      .json()
      .data.some((s) => s.file.id === file.id),
  );
  const initial = await app.prisma.file.findUnique({ where: { id: file.id } });
  for (const [method, path, body] of [
    ["PATCH", `/files/${file.id}`, { name: "Denied" }],
    ["DELETE", `/files/${file.id}`],
    [
      "POST",
      "/files/shares",
      { fileIds: [file.id], userIds: [users.VIEWER.id] },
    ],
    ["POST", "/files/share-links", { fileIds: [file.id] }],
    ["DELETE", `/files/${file.id}/shares/${users.MEMBER.id}`],
  ])
    denied(await req("MEMBER", method, base() + path, body));
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: file.id } }),
    initial,
  );
  const copy = await req("MEMBER", "POST", `${base()}/files/${file.id}/copy`, {
    parentId: null,
  });
  assert.equal(copy.statusCode, 201, copy.body);
  assert.equal(copy.json().data.ownerId, users.MEMBER.id);
});

test("shared folder grants descendant reads without exposing private ancestors or granting writes", async () => {
  const parent = await makeFile("PEER", {
    isFolder: true,
    name: "Private parent name",
  });
  const folder = await makeFile("PEER", {
    isFolder: true,
    parentId: parent.id,
  });
  const child = await makeFile("PEER", {
    parentId: folder.id,
    name: `child-${crypto.randomUUID()}`,
  });
  await share(folder);
  assert.equal(
    (await req("MEMBER", "GET", `${base()}/files/${child.id}/download`))
      .statusCode,
    200,
  );
  const list = await req(
    "MEMBER",
    "GET",
    `${base()}/files?parentId=${folder.id}`,
  );
  assert.equal(list.statusCode, 200, list.body);
  assert(list.json().data.some((f) => f.id === child.id));
  const crumbs = await req(
    "MEMBER",
    "GET",
    `${base()}/files/${child.id}/breadcrumbs`,
  );
  assert.equal(crumbs.statusCode, 200, crumbs.body);
  assert(!crumbs.body.includes(parent.name));
  denied(
    await req("MEMBER", "POST", `${base()}/files/folder`, {
      parentId: folder.id,
      name: "Denied",
    }),
  );
  const zip = await req("MEMBER", "POST", `${base()}/files/archive`, {
    fileIds: [folder.id],
  });
  assert.equal(zip.statusCode, 200, zip.body);
  await app.prisma.fileShare.deleteMany({ where: { fileId: folder.id } });
  denied(await req("MEMBER", "GET", `${base()}/files/${child.id}/download`));
});

for (const viaGroup of [false, true])
  test(`${viaGroup ? "group" : "direct"} team access supports search/write and rechecks revoked membership`, async () => {
    const { root, folder, file, group } = await team(viaGroup);
    assert.equal(
      (await req("MEMBER", "GET", `${base()}/files/${file.id}/download`))
        .statusCode,
      200,
    );
    assert(
      (await req("MEMBER", "GET", `${base()}/files?search=${file.name}`))
        .json()
        .data.some((f) => f.id === file.id),
    );
    const list = await req(
      "MEMBER",
      "GET",
      `${base()}/files?teamFolderId=${folder.id}`,
    );
    assert.equal(list.statusCode, 200, list.body);
    assert(list.json().data.some((f) => f.id === file.id));
    const created = await req("MEMBER", "POST", `${base()}/files/folder`, {
      teamFolderId: folder.id,
      name: "Child",
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().data.parentId, root.id);
    assert.equal(created.json().data.ownerId, null);
    const star = await req("MEMBER", "POST", `${base()}/files/${file.id}/star`);
    assert.equal(star.statusCode, 204, star.body);
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
    for (const url of [`/files?search=${file.name}`, "/files/starred"])
      assert(
        !(await req("MEMBER", "GET", base() + url))
          .json()
          .data.some((f) => f.id === file.id),
      );
    assert.equal(reads, initialReads);
    assert.equal(writes, initialWrites);
  });

test("VIEWER grants are readable but writes cannot be escalated through supplied service roles", async () => {
  const file = await makeFile("PEER");
  await share(file, "VIEWER");
  assert.equal(
    (await req("VIEWER", "GET", `${base()}/files/${file.id}/download`))
      .statusCode,
    200,
  );
  const { assertFileAccess } =
    await import("../../src/modules/files/file-access.ts");
  await assert.rejects(
    assertFileAccess(
      app.prisma,
      file.id,
      {
        workspaceId: workspace.id,
        userId: users.VIEWER.id,
        workspaceRole: "ADMIN",
      },
      true,
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
});

test("current membership wins over stale service admin context and explicit grants", async () => {
  const file = await makeFile("PEER");
  await share(file, "VIEWER");
  const { assertFileAccess } =
    await import("../../src/modules/files/file-access.ts");
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.VIEWER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    denied(await req("VIEWER", "GET", `${base()}/files/${file.id}/download`));
    await assert.rejects(
      assertFileAccess(app.prisma, file.id, {
        workspaceId: workspace.id,
        userId: users.VIEWER.id,
        workspaceRole: "ADMIN",
      }),
      /member/,
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

test("explicit team-folder share grants read-only descendants independently of team membership", async () => {
  const { root, folder, file } = await team();
  const create = await req("MEMBER", "POST", `${base()}/files/shares`, {
    fileIds: [root.id],
    userIds: [users.PEER.id],
  });
  assert.equal(create.statusCode, 201, create.body);
  assert.equal(
    (await req("PEER", "GET", `${base()}/files/${file.id}/download`))
      .statusCode,
    200,
  );
  assert(
    (await req("PEER", "GET", `${base()}/files?search=${file.name}`))
      .json()
      .data.some((f) => f.id === file.id),
  );
  denied(
    await req("PEER", "PATCH", `${base()}/files/${file.id}`, {
      name: "Denied",
    }),
  );
  denied(
    await req("PEER", "POST", `${base()}/files/folder`, {
      parentId: root.id,
      name: "Denied",
    }),
  );
  // A separate explicit read survives removal of an unrelated team membership.
  await app.prisma.teamFolderMember.create({
    data: { teamFolderId: folder.id, userId: users.PEER.id },
  });
  await app.prisma.teamFolderMember.delete({
    where: {
      teamFolderId_userId: { teamFolderId: folder.id, userId: users.PEER.id },
    },
  });
  assert.equal(
    (await req("PEER", "GET", `${base()}/files/${file.id}/download`))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await req(
        "MEMBER",
        "DELETE",
        `${base()}/files/${root.id}/shares/${users.PEER.id}`,
      )
    ).statusCode,
    204,
  );
  const initialReads = reads;
  denied(await req("PEER", "GET", `${base()}/files/${file.id}/download`));
  assert.equal(reads, initialReads);
});

test("explicit readers cannot list credentials, alter sources, or copy into read-only destinations", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  const file = await makeFile("PEER", { parentId: folder.id });
  await share(folder);
  const link = await req("PEER", "POST", `${base()}/files/share-links`, {
    fileIds: [file.id],
  });
  assert.equal(link.statusCode, 201, link.body);
  await deniedUnchanged("MEMBER", [
    ["GET", `/files/${file.id}/shares`],
    ["GET", `/files/${file.id}/share-links`],
    ["PATCH", `/files/${file.id}`, { trashedAt: new Date().toISOString() }],
    ["PATCH", `/files/${file.id}`, { parentId: null }],
    ["POST", `/files/${own.id}/copy`, { parentId: folder.id }],
    ["PATCH", `/file-share-links/${link.json().data.id}`, { enabled: false }],
    ["DELETE", `/file-share-links/${link.json().data.id}`],
  ]);
});

test("explicit grant revocation removes search and starred metadata before content or copy effects", async () => {
  const file = await makeFile("PEER", {
    name: `revoked-${crypto.randomUUID()}`,
  });
  await share(file);
  assert.equal(
    (await req("MEMBER", "POST", `${base()}/files/${file.id}/star`)).statusCode,
    204,
  );
  assert.equal(
    (
      await req(
        "PEER",
        "DELETE",
        `${base()}/files/${file.id}/shares/${users.MEMBER.id}`,
      )
    ).statusCode,
    204,
  );
  await deniedUnchanged("MEMBER", [
    ["GET", `/files/${file.id}`],
    ["GET", `/files/${file.id}/download`],
    ["POST", "/files/archive", { fileIds: [own.id, file.id] }],
    ["POST", `/files/${file.id}/copy`, { parentId: null }],
  ]);
  await notListed("MEMBER", file);
  assert(
    !(await list("MEMBER", "/files/shared-with-me")).some(
      (s) => s.file.id === file.id,
    ),
  );
  assert.equal(
    await app.prisma.starredFile.count({
      where: { fileId: file.id, userId: users.MEMBER.id },
    }),
    1,
  );
  assert.equal(
    (await req("MEMBER", "DELETE", `${base()}/files/${file.id}/star`))
      .statusCode,
    204,
  );
});

test("shared descendant inheritance stops at changed ownership or workspace before any archive stream", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  const child = await makeFile("PEER", { parentId: folder.id });
  const privateChild = await makeFile("ADMIN", { parentId: folder.id });
  const foreignChild = await makeFile("FOREIGN", {
    workspaceId: foreign.id,
    parentId: folder.id,
  });
  await share(folder);
  assert.deepEqual(
    (await list("MEMBER", `/files?parentId=${folder.id}`)).map((f) => f.id),
    [child.id],
  );
  await deniedUnchanged("MEMBER", [
    ["GET", `/files/${privateChild.id}/download`],
    ["GET", `/files/${foreignChild.id}/download`],
    ["POST", "/files/archive", { fileIds: [child.id, folder.id] }],
  ]);
});

test("scope-consistent new children inherit grants; moved-out descendants lose only their inherited path", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  await share(folder);
  const nested = await makeFile("PEER", {
    isFolder: true,
    parentId: folder.id,
  });
  const child = await makeFile("PEER", { parentId: nested.id });
  await content("MEMBER", child);
  const moved = await req("PEER", "PATCH", `${base()}/files/${nested.id}`, {
    parentId: null,
  });
  assert.equal(moved.statusCode, 200, moved.body);
  await deniedUnchanged("MEMBER", [["GET", `/files/${child.id}/download`]]);
  await share(child);
  await content("MEMBER", child);
});

for (const viaGroup of [false, true])
  test(`${viaGroup ? "group" : "direct"} team members retain roster and trash rights; explicit recipients get file routes only`, async () => {
    const { root, folder, file, group } = await team(viaGroup, "PEER");
    const trash = await makeFile("ADMIN", {
      parentId: root.id,
      teamFolderId: folder.id,
      ownerId: null,
      trashedAt: new Date(),
    });
    assert(
      (await list("PEER", "/team-folders")).some((t) => t.id === folder.id),
    );
    assert.equal(
      (await req("PEER", "GET", `${base()}/team-folders/${folder.id}`))
        .statusCode,
      200,
    );
    assert(
      (await list("PEER", "/files?trashed=true")).some(
        (f) => f.id === trash.id,
      ),
    );
    await share(root, "MEMBER", "ADMIN");
    await content("MEMBER", file, "bytes-ADMIN");
    assert(
      !(await list("MEMBER", "/team-folders")).some((t) => t.id === folder.id),
    );
    await deniedUnchanged("MEMBER", [["GET", `/team-folders/${folder.id}`]]);
    const removed = viaGroup
      ? await req(
          "ADMIN",
          "DELETE",
          `${base()}/groups/${group.id}/members/${users.PEER.id}`,
        )
      : await req(
          "ADMIN",
          "DELETE",
          `${base()}/team-folders/${folder.id}/members/${users.PEER.id}`,
        );
    assert.equal(removed.statusCode, 204, removed.body);
    assert(
      !(await list("PEER", "/files?trashed=true")).some(
        (f) => f.id === trash.id,
      ),
    );
    await deniedUnchanged("PEER", [["GET", `/team-folders/${folder.id}`]]);
  });

test("public bundle credentials stay manager-only even when other local writers can access one source", async () => {
  const file = await makeFile("MEMBER");
  const hidden = await makeFile("PEER", {
    name: `private-bundle-${crypto.randomUUID()}`,
  });
  const created = await req("ADMIN", "POST", `${base()}/files/share-links`, {
    fileIds: [file.id, hidden.id],
  });
  assert.equal(created.statusCode, 201, created.body);
  const link = created.json().data;
  const before = await state();
  const response = await req(
    "MEMBER",
    "GET",
    `${base()}/files/${file.id}/share-links`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert(!response.json().data.some((row) => row.id === link.id));
  assert(!response.body.includes(link.token));
  assert(!response.body.includes(hidden.id));
  const status = await req(
    "MEMBER",
    "GET",
    `${base()}/files/share-status?fileIds=${file.id},${hidden.id}`,
  );
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json().data, [file.id]);
  assert(!status.body.includes(link.token));
  const byMe = await req("MEMBER", "GET", `${base()}/files/shared-by-me`);
  assert.equal(byMe.statusCode, 200, byMe.body);
  assert(!byMe.body.includes(link.token));
  assert.deepEqual(await state(), before);
  const ownLink = await req("MEMBER", "POST", `${base()}/files/share-links`, {
    fileIds: [file.id],
  });
  assert.equal(ownLink.statusCode, 201, ownLink.body);
  assert(
    (await list("MEMBER", `/files/${file.id}/share-links`)).some(
      (row) => row.id === ownLink.json().data.id,
    ),
  );
  assert(
    (await list("ADMIN", `/files/${file.id}/share-links`)).some(
      (row) => row.id === link.id,
    ),
  );
});

test("stale-source managers retain revocation authority without receiving unreadable source metadata", async () => {
  const file = await makeFile("PEER");
  const link = await app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: users.MEMBER.id,
      token: crypto.randomUUID(),
      files: { create: { fileId: file.id } },
    },
  });
  const before = sideEffects();
  const response = await req(
    "MEMBER",
    "PATCH",
    `${base()}/file-share-links/${link.id}`,
    { enabled: false },
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.enabled, false);
  assert.deepEqual(response.json().data.files, []);
  assert(!response.body.includes(file.id));
  assert.equal(
    (await req("MEMBER", "DELETE", `${base()}/file-share-links/${link.id}`))
      .statusCode,
    204,
  );
  assert.deepEqual(sideEffects(), before);
});

test("shared-by-me and share status recheck current read rights after group authority is removed", async () => {
  const { folder, file, group } = await team(true);
  await share(file, "PEER", "MEMBER");
  const link = await req("MEMBER", "POST", `${base()}/files/share-links`, {
    fileIds: [file.id],
  });
  assert.equal(link.statusCode, 201, link.body);
  const token = link.json().data.token;
  const before = await req("MEMBER", "GET", `${base()}/files/shared-by-me`);
  assert(before.json().data.some((row) => row.file.id === file.id));
  assert(!before.body.includes(token));
  assert.equal(
    (
      await req(
        "ADMIN",
        "DELETE",
        `${base()}/team-folders/${folder.id}/groups/${group.id}`,
      )
    ).statusCode,
    204,
  );
  const effectsBefore = sideEffects();
  const byMe = await req("MEMBER", "GET", `${base()}/files/shared-by-me`);
  assert.equal(byMe.statusCode, 200, byMe.body);
  assert(!byMe.json().data.some((row) => row.file.id === file.id));
  assert(!byMe.body.includes(token));
  const status = await req(
    "MEMBER",
    "GET",
    `${base()}/files/share-status?fileIds=${file.id}`,
  );
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json().data, []);
  assert(!status.body.includes(token));
  assert.deepEqual(sideEffects(), effectsBefore);
});

test("own sent-share history survives write loss only while current membership and source reads remain", async () => {
  const { folder, file } = await team();
  await share(file, "PEER", "MEMBER");
  await share(file, "VIEWER", "ADMIN");
  await share(file, "MEMBER", "ADMIN");
  const removed = await req(
    "ADMIN",
    "DELETE",
    `${base()}/team-folders/${folder.id}/members/${users.MEMBER.id}`,
  );
  assert.equal(removed.statusCode, 204, removed.body);
  await content("MEMBER", file, "bytes-ADMIN");
  await deniedUnchanged("MEMBER", [
    ["PATCH", `/files/${file.id}`, { name: "Denied" }],
    ["GET", `/files/${file.id}/shares`],
  ]);

  const before = await state();
  const history = (await list("MEMBER", "/files/shared-by-me")).filter(
    (row) => row.file.id === file.id,
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].shareType, "member");
  assert.equal(history[0].sharedWith.id, users.PEER.id);
  assert.equal(history[0].sharedWith.email, users.PEER.email);
  assert(!JSON.stringify(history).includes(users.VIEWER.email));
  // A grant recipient gets no other issuer's sent-share history or source roster.
  assert(
    !(await list("PEER", "/files/shared-by-me")).some(
      (row) => row.file.id === file.id,
    ),
  );
  assert.deepEqual(await state(), before);
  await deniedUnchanged("PEER", [["GET", `/files/${file.id}/shares`]]);

  const revoked = await req(
    "ADMIN",
    "DELETE",
    `${base()}/files/${file.id}/shares/${users.MEMBER.id}`,
  );
  assert.equal(revoked.statusCode, 204, revoked.body);
  const afterRevocation = await state();
  assert(
    !(await list("MEMBER", "/files/shared-by-me")).some(
      (row) => row.file.id === file.id,
    ),
  );
  assert.deepEqual(await state(), afterRevocation);

  await app.prisma.fileShare.create({
    data: {
      workspaceId: workspace.id,
      fileId: file.id,
      sharedById: users.ADMIN.id,
      sharedWithId: users.MEMBER.id,
    },
  });
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.MEMBER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    await deniedUnchanged("MEMBER", [["GET", "/files/shared-by-me"]]);
    const { listSharedByMe } =
      await import("../../src/modules/files/file-shares.service.ts");
    const beforeDirectRead = await state();
    await assert.rejects(
      listSharedByMe(app.prisma, workspace.id, {
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        workspaceRole: "ADMIN",
      }),
      /member/,
    );
    assert.deepEqual(await state(), beforeDirectRead);
  } finally {
    await app.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        role: "MEMBER",
      },
    });
  }
});

test("removed workspace membership overrides retained explicit, group and stale ADMIN contexts on all read entry points", async () => {
  const file = await makeFile("PEER");
  await share(file);
  const { folder } = await team(true);
  const ctx = {
    workspaceId: workspace.id,
    userId: users.MEMBER.id,
    workspaceRole: "ADMIN",
  };
  const access = await import("../../src/modules/files/file-access.ts");
  const files = await import("../../src/modules/files/files.service.ts");
  const shares = await import("../../src/modules/files/file-shares.service.ts");
  const teams =
    await import("../../src/modules/team-folders/team-folders.service.ts");
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.MEMBER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    await deniedUnchanged("MEMBER", [
      ["GET", `/files/${file.id}/download`],
      ["GET", "/files"],
      ["GET", "/team-folders"],
    ]);
    const before = await state();
    for (const action of [
      () => access.assertFileAccess(app.prisma, file.id, ctx),
      () => access.fileReadWhere(app.prisma, ctx),
      () => files.listFiles(app.prisma, workspace.id, { limit: 10 }, ctx),
      () => files.listStarredFiles(app.prisma, workspace.id, ctx),
      () => shares.listSharedWithMe(app.prisma, workspace.id, ctx),
      () => shares.listSharedByMe(app.prisma, workspace.id, ctx),
      () => shares.getFileShareStatus(app.prisma, workspace.id, [file.id], ctx),
      () =>
        teams.listTeamFolders(
          app.prisma,
          workspace.id,
          users.MEMBER.id,
          "ADMIN",
        ),
      () =>
        teams.getTeamFolder(
          app.prisma,
          workspace.id,
          folder.id,
          users.MEMBER.id,
          "ADMIN",
        ),
    ])
      await assert.rejects(action(), /member/);
    assert.deepEqual(await state(), before);
  } finally {
    await app.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        role: "MEMBER",
      },
    });
  }
});

test("grant metadata, thumbnails, starring and ZIP bytes use the same current read capability", async () => {
  const thumbnailPath = await app.storage.save(
    `${workspace.id}/files`,
    users.PEER.id,
    crypto.randomUUID(),
    ".webp",
    Buffer.from("thumbnail-fixture"),
  );
  const file = await makeFile("PEER", {
    thumbnailPath,
    name: `grant-media-${crypto.randomUUID()}`,
  });
  await share(file);
  assert.equal(
    (await req("MEMBER", "GET", `${base()}/files/${file.id}`)).statusCode,
    200,
  );
  const thumb = await req(
    "MEMBER",
    "GET",
    `${base()}/files/${file.id}/thumbnail`,
  );
  assert.equal(thumb.statusCode, 200, thumb.body);
  assert.equal(thumb.body, "thumbnail-fixture");
  assert.equal(thumb.headers["cache-control"], "private, no-store");
  assert.equal(
    (await req("MEMBER", "POST", `${base()}/files/${file.id}/star`)).statusCode,
    204,
  );
  assert(
    (await list("MEMBER", "/files/starred")).some((f) => f.id === file.id),
  );
  const zip = await req("MEMBER", "POST", `${base()}/files/archive`, {
    fileIds: [file.id],
  });
  assert.equal(zip.statusCode, 200, zip.body);
  assert.equal(new AdmZip(zip.rawPayload).readAsText(file.name), "bytes-PEER");
  assert.equal(
    (
      await req(
        "PEER",
        "DELETE",
        `${base()}/files/${file.id}/shares/${users.MEMBER.id}`,
      )
    ).statusCode,
    204,
  );
  await deniedUnchanged("MEMBER", [["GET", `/files/${file.id}/thumbnail`]]);
});

test("VIEWER grants allow bytes but cannot escalate destination writes with a forged service role", async () => {
  const file = await makeFile("PEER");
  await share(file, "VIEWER");
  await content("VIEWER", file);
  const before = await state();
  denied(
    await req("VIEWER", "POST", `${base()}/files/${file.id}/copy`, {
      parentId: null,
    }),
  );
  const files = await import("../../src/modules/files/files.service.ts");
  await assert.rejects(
    files.copyFile(
      app.prisma,
      app.storage,
      workspace.id,
      file.id,
      { parentId: null },
      {
        workspaceId: workspace.id,
        userId: users.VIEWER.id,
        workspaceRole: "ADMIN",
      },
    ),
    /Read-only/,
  );
  assert.deepEqual(await state(), before);
});

test("trashed sources and ancestor anchors stop explicit reads while ordinary owner restore remains available", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  const file = await makeFile("PEER", {
    parentId: folder.id,
    name: `inherited-trash-${crypto.randomUUID()}`,
  });
  await share(folder);
  assert.equal(
    (
      await req("PEER", "PATCH", `${base()}/files/${folder.id}`, {
        trashedAt: new Date().toISOString(),
      })
    ).statusCode,
    200,
  );
  await deniedUnchanged("MEMBER", [["GET", `/files/${file.id}/download`]]);
  await notListed("MEMBER", file);
  assert(
    !(await list("MEMBER", "/files?trashed=true")).some(
      (f) => f.id === folder.id,
    ),
  );
  assert.equal(
    (
      await req("PEER", "PATCH", `${base()}/files/${folder.id}`, {
        trashedAt: null,
      })
    ).statusCode,
    200,
  );
  await content("MEMBER", file);
  await share(file);
  assert.equal(
    (
      await req("PEER", "PATCH", `${base()}/files/${file.id}`, {
        trashedAt: new Date().toISOString(),
      })
    ).statusCode,
    200,
  );
  await deniedUnchanged("MEMBER", [["GET", `/files/${file.id}/download`]]);
  assert(
    !(await list("MEMBER", "/files/shared-with-me")).some(
      (s) => s.file.id === file.id,
    ),
  );
});

test("read predicates filter before pagination for both file search and shared-with-me", async () => {
  const prefix = `page-${crypto.randomUUID()}`;
  for (let n = 0; n < 4; n++)
    await makeFile("PEER", { name: `${prefix}-0-private-${n}` });
  const allowed = [];
  for (let n = 0; n < 3; n++) {
    const file = await makeFile("PEER", { name: `${prefix}-1-shared-${n}` });
    await share(file, "PAGED");
    allowed.push(file.id);
  }
  await app.prisma.fileShare.create({
    data: {
      workspaceId: workspace.id,
      fileId: foreignFile.id,
      sharedById: users.PEER.id,
      sharedWithId: users.PAGED.id,
      createdAt: new Date("2031-01-01"),
    },
  });
  for (const suffix of [
    `/files?search=${prefix}&sortBy=name&limit=2`,
    "/files/shared-with-me?limit=2",
  ]) {
    let cursor,
      seen = [];
    do {
      const r = await req(
        "PAGED",
        "GET",
        base() + suffix + (cursor ? `&cursor=${cursor}` : ""),
      );
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json();
      assert(body.data.length > 0 && body.data.length <= 2);
      seen.push(...body.data.map((entry) => entry.file?.id ?? entry.id));
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen.sort(), [...allowed].sort());
  }
});

test("legacy foreign and invalid-team grants never confer direct or list authority, including for workspace admins", async () => {
  const badRoot = await makeFile("ADMIN", { ownerId: null });
  const badTeam = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: badRoot.id,
      name: `invalid-team-${crypto.randomUUID()}`,
    },
  });
  const badFile = await makeFile("ADMIN", {
    ownerId: null,
    parentId: badRoot.id,
    teamFolderId: badTeam.id,
    name: `bad-scope-${crypto.randomUUID()}`,
  });
  await app.prisma.fileShare.createMany({
    data: [
      {
        workspaceId: workspace.id,
        fileId: badFile.id,
        sharedById: users.ADMIN.id,
        sharedWithId: users.MEMBER.id,
      },
      {
        workspaceId: workspace.id,
        fileId: foreignFile.id,
        sharedById: users.ADMIN.id,
        sharedWithId: users.MEMBER.id,
      },
      {
        workspaceId: foreign.id,
        fileId: peer.id,
        sharedById: users.FOREIGN.id,
        sharedWithId: users.MEMBER.id,
      },
    ],
  });
  for (const actor of ["MEMBER", "ADMIN"]) {
    await deniedUnchanged(actor, [
      ["GET", `/files/${badFile.id}/download`],
      ["GET", `/team-folders/${badTeam.id}`],
    ]);
    assert(
      !(await list(actor, `/files?search=${badFile.name}`)).some(
        (f) => f.id === badFile.id,
      ),
    );
    assert(
      !(await list(actor, "/team-folders")).some((t) => t.id === badTeam.id),
    );
  }
  await deniedUnchanged("MEMBER", [
    ["GET", `/files/${foreignFile.id}/download`],
    ["GET", `/files/${peer.id}/download`],
  ]);
  const rows = await list("MEMBER", "/files/shared-with-me");
  assert(
    !rows.some((s) =>
      [badFile.id, foreignFile.id, peer.id].includes(s.file.id),
    ),
  );
});

test("foreign or inactive team roots fail every active grant/list path and preserve current root validation", async () => {
  const shapes = [];
  const foreignRoot = await makeFile("FOREIGN", {
    workspaceId: foreign.id,
    isFolder: true,
    ownerId: null,
  });
  const foreignTeam = await app.prisma.teamFolder.create({
    data: {
      workspaceId: foreign.id,
      folderId: foreignRoot.id,
      name: crypto.randomUUID(),
    },
  });
  shapes.push({ team: foreignTeam, root: foreignRoot });
  const foreignRootLocalTeam = await makeFile("FOREIGN", {
    workspaceId: foreign.id,
    isFolder: true,
    ownerId: null,
  });
  const localTeam = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: foreignRootLocalTeam.id,
      name: crypto.randomUUID(),
    },
  });
  shapes.push({ team: localTeam, root: foreignRootLocalTeam });
  const localRoot = await makeFile("ADMIN", { isFolder: true, ownerId: null });
  const mismatched = await app.prisma.teamFolder.create({
    data: {
      workspaceId: foreign.id,
      folderId: localRoot.id,
      name: crypto.randomUUID(),
    },
  });
  shapes.push({ team: mismatched, root: localRoot });
  const inactive = await team(false);
  await app.prisma.file.update({
    where: { id: inactive.root.id },
    data: { trashedAt: new Date() },
  });
  shapes.push({ team: inactive.folder, root: inactive.root });
  for (const { team: tf, root } of shapes) {
    const file = await makeFile("ADMIN", {
      ownerId: null,
      teamFolderId: tf.id,
      parentId: root.id,
      name: `invalid-root-${crypto.randomUUID()}`,
    });
    await app.prisma.fileShare.create({
      data: {
        workspaceId: workspace.id,
        fileId: file.id,
        sharedById: users.ADMIN.id,
        sharedWithId: users.MEMBER.id,
      },
    });
    for (const actor of ["MEMBER", "ADMIN"]) {
      await app.prisma.starredFile.create({
        data: { userId: users[actor].id, fileId: file.id },
      });
      await deniedUnchanged(actor, [
        ["GET", `/files/${file.id}`],
        ["GET", `/files/${file.id}/download`],
      ]);
      await notListed(actor, file);
      assert(!(await list(actor, "/team-folders")).some((t) => t.id === tf.id));
    }
    assert(
      !(await list("MEMBER", "/files/shared-with-me")).some(
        (s) => s.file.id === file.id,
      ),
    );
  }
});

test("a legacy root's own team relation takes precedence over another membership relation", async () => {
  const { folder: writableTeam } = await team(false);
  const root = await makeFile("ADMIN", {
    isFolder: true,
    ownerId: null,
    teamFolderId: writableTeam.id,
    name: `dual-scope-${crypto.randomUUID()}`,
  });
  await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: crypto.randomUUID(),
    },
  });
  await deniedUnchanged("MEMBER", [["GET", `/files/${root.id}`]]);
  assert(
    !(await list("MEMBER", `/files?search=${root.name}`)).some(
      (f) => f.id === root.id,
    ),
  );
  assert.equal(
    (await req("ADMIN", "GET", `${base()}/files/${root.id}`)).statusCode,
    200,
  );
  assert(
    (await list("ADMIN", `/files?search=${root.name}`)).some(
      (f) => f.id === root.id,
    ),
  );
});

test("foreign group relations grant no file/roster authority and are absent from legitimate team detail", async () => {
  const { root, folder, file } = await team(false, "PEER");
  const group = await app.prisma.group.create({
    data: {
      workspaceId: foreign.id,
      name: `foreign-group-${crypto.randomUUID()}`,
      members: { create: { userId: users.MEMBER.id } },
      teamFolderGroups: { create: { teamFolderId: folder.id } },
    },
  });
  await deniedUnchanged("MEMBER", [
    ["GET", `/files/${file.id}/download`],
    ["GET", `/team-folders/${folder.id}`],
  ]);
  assert(
    !(await list("MEMBER", "/team-folders")).some((t) => t.id === folder.id),
  );
  const detail = await req(
    "PEER",
    "GET",
    `${base()}/team-folders/${folder.id}`,
  );
  assert.equal(detail.statusCode, 200, detail.body);
  assert(!detail.body.includes(group.id));
  assert(!detail.body.includes(group.name));
  await share(root, "MEMBER", "ADMIN");
  await content("MEMBER", file, "bytes-ADMIN");
  await deniedUnchanged("MEMBER", [["GET", `/team-folders/${folder.id}`]]);
});

test("ordinary owner/team trash metadata remains visible without granting trashed content or shared-reader restore", async () => {
  const { root, folder } = await team(true);
  const file = await makeFile("ADMIN", {
    ownerId: null,
    teamFolderId: folder.id,
    parentId: root.id,
    trashedAt: new Date(),
  });
  assert(
    (await list("MEMBER", "/files?trashed=true")).some((f) => f.id === file.id),
  );
  await deniedUnchanged("MEMBER", [["GET", `/files/${file.id}/download`]]);
  const restored = await req("MEMBER", "PATCH", `${base()}/files/${file.id}`, {
    trashedAt: null,
  });
  assert.equal(restored.statusCode, 200, restored.body);
  await content("MEMBER", file, "bytes-ADMIN");
  await share(root, "VIEWER", "ADMIN");
  assert.equal(
    (
      await req("MEMBER", "PATCH", `${base()}/files/${file.id}`, {
        trashedAt: new Date().toISOString(),
      })
    ).statusCode,
    200,
  );
  assert(
    !(await list("VIEWER", "/files?trashed=true")).some(
      (f) => f.id === file.id,
    ),
  );
  await deniedUnchanged("VIEWER", [
    ["PATCH", `/files/${file.id}`, { trashedAt: null }],
  ]);
});

test("an explicit source grant composes with an independently writable group destination for copy", async () => {
  const source = await makeFile("PEER");
  await share(source);
  const { root, folder } = await team(true);
  const before = await app.prisma.file.findUnique({ where: { id: source.id } });
  const copied = await req(
    "MEMBER",
    "POST",
    `${base()}/files/${source.id}/copy`,
    { parentId: null, teamFolderId: folder.id },
  );
  assert.equal(copied.statusCode, 201, copied.body);
  assert.equal(copied.json().data.parentId, root.id);
  assert.equal(copied.json().data.teamFolderId, folder.id);
  assert.equal(copied.json().data.ownerId, null);
  await content("MEMBER", copied.json().data);
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: source.id } }),
    before,
  );
});

test("a folder read grant cannot authorize multipart storage writes", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  await share(folder);
  const boundary = `file-grants-${crypto.randomUUID()}`;
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="parentId"\r\n\r\n${folder.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\nfixture bytes\r\n--${boundary}--\r\n`,
  );
  const before = await state();
  const response = await app.inject({
    method: "POST",
    url: `${base()}/files/upload`,
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${tokens.MEMBER}`,
    },
  });
  denied(response);
  assert.deepEqual(await state(), before);
});
