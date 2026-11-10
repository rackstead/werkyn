import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );

const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-create-depth-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "create-depth-cap-jwt-secret",
  COOKIE_SECRET: "create-depth-cap-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { graphLimits } = await import("../../src/utils/graph-limits.ts");

const FOLDER_TOO_DEEP = "Folder tree exceeds the supported depth or size";
const PAGE_TOO_DEEP = "Page tree exceeds the supported depth or size";

let app;
let token;
let user;
let ws;
let requests = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomBytes(4).toString("hex");
  user = await app.prisma.user.create({
    data: {
      email: `depth-cap-${suffix}@example.test`,
      displayName: "Depth",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  ws = await app.prisma.workspace.create({
    data: {
      name: "Depth cap",
      slug: `depth-cap-${suffix}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
});

after(async () => {
  try {
    if (graphLimits) {
      graphLimits.maxDepth = 256;
      graphLimits.maxNodes = 50_000;
    }
    if (app && ws) {
      await app.prisma.file.updateMany({
        where: { workspaceId: ws.id },
        data: { parentId: null },
      });
      await app.prisma.wikiPage.updateMany({
        where: { space: { workspaceId: ws.id } },
        data: { parentId: null },
      });
      await app.prisma.workspace.delete({ where: { id: ws.id } });
    }
    if (app && user)
      await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

function filesUrl(suffix = "") {
  return `/api/workspaces/${ws.id}/files${suffix}`;
}

async function call(method, url, payload) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.96.0.${(++requests % 200) + 1}`,
  });
  let body = null;
  if (response.body) {
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
  }
  return { status: response.statusCode, body };
}

function expectStatus(response, status, message) {
  assert.equal(
    response.status,
    status,
    JSON.stringify(response.body),
  );
  if (message !== undefined) {
    assert.equal(response.body.error, "Conflict");
    assert.equal(response.body.message, message);
  }
  return response.body?.data;
}

async function upload(name, parentId) {
  const boundary = `depth-${crypto.randomBytes(6).toString("hex")}`;
  const parent = parentId
    ? `Content-Disposition: form-data; name="parentId"\r\n\r\n${parentId}\r\n--${boundary}\r\n`
    : "";
  const response = await app.inject({
    method: "POST",
    url: filesUrl("/upload"),
    payload: Buffer.from(
      `--${boundary}\r\n${parent}Content-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${name}\r\n--${boundary}--\r\n`,
    ),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    remoteAddress: `10.96.1.${(++requests % 200) + 1}`,
  });
  let body = null;
  if (response.body) body = response.json();
  return { status: response.statusCode, body };
}

async function storedFiles() {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) found.push(child);
    }
  }
  await walk(storageDir);
  return found.sort();
}

async function ancestorCount(model, id) {
  let count = 0;
  let current = id;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = await app.prisma[model].findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    if (!row?.parentId) break;
    current = row.parentId;
    count++;
  }
  return count;
}

async function nestedFolders(prefix) {
  const statuses = [];
  const ids = [];
  let parentId;
  for (let i = 0; i < 4; i++) {
    const response = await call("POST", filesUrl("/folder"), {
      name: `${prefix}-${i}`,
      ...(parentId ? { parentId } : {}),
    });
    statuses.push(response.status);
    if (response.status === 201) {
      parentId = response.body.data.id;
      ids.push(parentId);
    }
  }
  return { statuses, ids };
}

test("creates at maxDepth succeed and one level deeper returns the delete 409", async () => {
  assert.equal(graphLimits.maxDepth, 256);
  assert.equal(graphLimits.maxNodes, 50_000);
  const saved = {
    maxDepth: graphLimits.maxDepth,
    maxNodes: graphLimits.maxNodes,
  };
  graphLimits.maxDepth = 2;
  try {
    const nested = await nestedFolders("personal");
    assert.deepEqual(nested.statuses, [201, 201, 201, 409]);
    assert.equal(nested.ids.length, 3);
    assert.equal(await ancestorCount("file", nested.ids[2]), 2);
    assert.equal(
      await app.prisma.file.count({
        where: { workspaceId: ws.id, name: "personal-3" },
      }),
      0,
    );
    const refused = await call("POST", filesUrl("/folder"), {
      name: "personal-3",
      parentId: nested.ids[2],
    });
    expectStatus(refused, 409, FOLDER_TOO_DEEP);

    const sibling = expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "personal-exact-sibling",
        parentId: nested.ids[1],
      }),
      201,
    );
    assert.equal(await ancestorCount("file", sibling.id), 2);

    const rootFile = expectStatus(await upload("root.txt"), 201);
    assert.equal(rootFile.parentId, null);
    assert.equal(await ancestorCount("file", rootFile.id), 0);

    const beforeBlobs = await storedFiles();
    const beforeQueue = await app.prisma.blobCleanup.count();
    const deepUpload = await upload("too-deep.txt", nested.ids[2]);
    expectStatus(deepUpload, 409, FOLDER_TOO_DEEP);
    assert.equal(
      await app.prisma.file.count({
        where: { workspaceId: ws.id, name: "too-deep.txt" },
      }),
      0,
    );
    assert.deepEqual(await storedFiles(), beforeBlobs);
    assert.equal(await app.prisma.blobCleanup.count(), beforeQueue);

    const deepCopy = await call("POST", filesUrl(`/${rootFile.id}/copy`), {
      parentId: nested.ids[2],
    });
    expectStatus(deepCopy, 409, FOLDER_TOO_DEEP);
    assert.deepEqual(await storedFiles(), beforeBlobs);
    assert.equal(await app.prisma.blobCleanup.count(), beforeQueue);
    assert.equal(
      await app.prisma.file.count({ where: { id: rootFile.id } }),
      1,
    );

    const exactUpload = expectStatus(
      await upload("exact.txt", nested.ids[1]),
      201,
    );
    assert.equal(exactUpload.parentId, nested.ids[1]);
    assert.equal(await ancestorCount("file", exactUpload.id), 2);
    const exactCopy = expectStatus(
      await call("POST", filesUrl(`/${rootFile.id}/copy`), {
        parentId: nested.ids[1],
      }),
      201,
    );
    assert.equal(await ancestorCount("file", exactCopy.id), 2);

    const loose = expectStatus(
      await call("POST", filesUrl("/folder"), { name: "loose" }),
      201,
    );
    assert.equal(loose.parentId, null);
    expectStatus(
      await call("PATCH", filesUrl(`/${loose.id}`), {
        parentId: nested.ids[2],
      }),
      409,
      FOLDER_TOO_DEEP,
    );
    assert.equal(
      (
        await app.prisma.file.findUnique({
          where: { id: loose.id },
          select: { parentId: true },
        })
      ).parentId,
      null,
    );
    expectStatus(
      await call("PATCH", filesUrl(`/${loose.id}`), {
        parentId: nested.ids[1],
      }),
      200,
    );
    assert.equal(await ancestorCount("file", loose.id), 2);

    const team = expectStatus(
      await call("POST", `/api/workspaces/${ws.id}/team-folders`, {
        name: "Team depth",
      }),
      201,
    );
    const teamChild = expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "team-1",
        teamFolderId: team.id,
      }),
      201,
    );
    assert.equal(await ancestorCount("file", teamChild.id), 1);
    const teamGrand = expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "team-2",
        parentId: teamChild.id,
      }),
      201,
    );
    assert.equal(await ancestorCount("file", teamGrand.id), 2);
    expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "team-3",
        parentId: teamGrand.id,
      }),
      409,
      FOLDER_TOO_DEEP,
    );
    assert.equal(
      await app.prisma.file.count({
        where: { workspaceId: ws.id, name: "team-3" },
      }),
      0,
    );

    const cycleA = expectStatus(
      await call("POST", filesUrl("/folder"), { name: "cycle-a" }),
      201,
    );
    const cycleB = expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "cycle-b",
        parentId: cycleA.id,
      }),
      201,
    );
    await app.prisma.file.update({
      where: { id: cycleA.id },
      data: { parentId: cycleB.id },
    });
    const cycleChild = expectStatus(
      await call("POST", filesUrl("/folder"), {
        name: "cycle-child",
        parentId: cycleA.id,
      }),
      201,
    );
    await app.prisma.file.updateMany({
      where: { id: { in: [cycleA.id, cycleB.id, cycleChild.id] } },
      data: { parentId: null },
    });

    const seeded = await app.prisma.file.create({
      data: {
        workspaceId: ws.id,
        parentId: nested.ids[2],
        name: "seeded-too-deep",
        isFolder: true,
        uploadedById: user.id,
        ownerId: user.id,
      },
    });
    expectStatus(
      await call("DELETE", filesUrl(`/${nested.ids[0]}`)),
      409,
      FOLDER_TOO_DEEP,
    );
    assert.equal(
      await app.prisma.file.count({
        where: { id: { in: [nested.ids[0], seeded.id] } },
      }),
      2,
    );
    await app.prisma.file.update({
      where: { id: seeded.id },
      data: { parentId: null },
    });
    expectStatus(await call("DELETE", filesUrl(`/${nested.ids[0]}`)), 204);
    assert.equal(
      await app.prisma.file.findUnique({ where: { id: nested.ids[0] } }),
      null,
    );
    await app.prisma.file.delete({ where: { id: seeded.id } });

    graphLimits.maxDepth = saved.maxDepth;
    const open = await nestedFolders("open");
    assert.deepEqual(open.statuses, [201, 201, 201, 201]);
    assert.equal(await ancestorCount("file", open.ids[3]), 3);
    expectStatus(await call("DELETE", filesUrl(`/${open.ids[0]}`)), 204);

    const space = await app.prisma.wikiSpace.create({
      data: {
        workspaceId: ws.id,
        name: "Depth",
        slug: `depth-${crypto.randomBytes(3).toString("hex")}`,
      },
    });
    graphLimits.maxDepth = 2;
    const pageStatuses = [];
    const pageIds = [];
    let parentId;
    for (let i = 0; i < 4; i++) {
      const response = await call(
        "POST",
        `/api/wiki/spaces/${space.id}/pages`,
        {
          title: `page-${i}`,
          ...(parentId ? { parentId } : {}),
        },
      );
      pageStatuses.push(response.status);
      if (response.status === 201) {
        parentId = response.body.data.id;
        pageIds.push(parentId);
      }
    }
    assert.deepEqual(pageStatuses, [201, 201, 201, 409]);
    assert.equal(await ancestorCount("wikiPage", pageIds[2]), 2);
    assert.equal(
      await app.prisma.wikiPage.count({
        where: { spaceId: space.id, title: "page-3" },
      }),
      0,
    );
    expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "page-3",
        parentId: pageIds[2],
      }),
      409,
      PAGE_TOO_DEEP,
    );
    const pageSibling = expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "page-exact-sibling",
        parentId: pageIds[1],
      }),
      201,
    );
    assert.equal(await ancestorCount("wikiPage", pageSibling.id), 2);

    const loosePage = expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "loose-page",
      }),
      201,
    );
    expectStatus(
      await call("PATCH", `/api/wiki/pages/${loosePage.id}/move`, {
        parentId: pageIds[2],
        position: 0,
      }),
      409,
      PAGE_TOO_DEEP,
    );
    assert.equal(
      (
        await app.prisma.wikiPage.findUnique({
          where: { id: loosePage.id },
          select: { parentId: true },
        })
      ).parentId,
      null,
    );
    expectStatus(
      await call("PATCH", `/api/wiki/pages/${loosePage.id}/move`, {
        parentId: pageIds[1],
        position: 0,
      }),
      200,
    );
    assert.equal(await ancestorCount("wikiPage", loosePage.id), 2);

    const pageA = expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "cycle-page-a",
      }),
      201,
    );
    const pageB = expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "cycle-page-b",
        parentId: pageA.id,
      }),
      201,
    );
    await app.prisma.wikiPage.update({
      where: { id: pageA.id },
      data: { parentId: pageB.id },
    });
    expectStatus(
      await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
        title: "cycle-page-child",
        parentId: pageA.id,
      }),
      201,
    );
    await app.prisma.wikiPage.updateMany({
      where: { spaceId: space.id, title: { startsWith: "cycle-page" } },
      data: { parentId: null },
    });

    const seededPage = await app.prisma.wikiPage.create({
      data: {
        spaceId: space.id,
        parentId: pageIds[2],
        title: "seeded-page",
        position: 0,
        createdById: user.id,
      },
    });
    expectStatus(
      await call("DELETE", `/api/wiki/pages/${pageIds[0]}`),
      409,
      PAGE_TOO_DEEP,
    );
    assert.equal(
      await app.prisma.wikiPage.count({
        where: { id: { in: [pageIds[0], seededPage.id] } },
      }),
      2,
    );
    await app.prisma.wikiPage.update({
      where: { id: seededPage.id },
      data: { parentId: null },
    });
    expectStatus(await call("DELETE", `/api/wiki/pages/${pageIds[0]}`), 204);
    await app.prisma.wikiPage.delete({ where: { id: seededPage.id } });

    graphLimits.maxDepth = saved.maxDepth;
    const openPages = [];
    parentId = undefined;
    for (let i = 0; i < 4; i++) {
      const created = expectStatus(
        await call("POST", `/api/wiki/spaces/${space.id}/pages`, {
          title: `open-page-${i}`,
          ...(parentId ? { parentId } : {}),
        }),
        201,
      );
      openPages.push(created.id);
      parentId = created.id;
    }
    assert.equal(await ancestorCount("wikiPage", openPages[3]), 3);
    expectStatus(await call("DELETE", `/api/wiki/pages/${openPages[0]}`), 204);
  } finally {
    graphLimits.maxDepth = saved.maxDepth;
    graphLimits.maxNodes = saved.maxNodes;
  }
  assert.equal(graphLimits.maxDepth, 256);
  assert.equal(graphLimits.maxNodes, 50_000);
});
