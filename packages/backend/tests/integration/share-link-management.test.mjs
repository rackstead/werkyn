import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "share-manager-integration-jwt-secret",
  COOKIE_SECRET: "share-manager-integration-cookie-secret",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-share-manager-"),
);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const shares = await import("../../src/modules/files/file-shares.service.ts");
let app,
  workspace,
  foreign,
  requests = 0;
const users = {},
  tokens = {};
const effects = { reads: 0, writes: 0, deletes: 0, events: 0 };
const context = (actor) => ({
  workspaceId: workspace.id,
  userId: users[actor].id,
  workspaceRole: "ADMIN",
});
const request = (actor, method, linkId, body, wid = workspace.id) =>
  app.inject({
    method,
    url: `/api/workspaces/${wid}/file-share-links/${linkId}`,
    payload: body,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.90.0.${(++requests % 250) + 1}`,
  });
const denied = (response) => {
  assert(
    [403, 404].includes(response.statusCode),
    `${response.statusCode}: ${response.body}`,
  );
  assert(!response.body.includes("Route "), response.body);
};
const rejected = (promise) =>
  assert.rejects(promise, (error) => [403, 404].includes(error.statusCode));
async function makeFile(actor = "OWNER", data = {}) {
  return app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      uploadedById: users[actor].id,
      ownerId: users[actor].id,
      name: `Manager source ${crypto.randomUUID()}`,
      storagePath: "audit-fixture-content-never-opened.txt",
      ...data,
    },
  });
}
async function makeLink(actor = "OWNER", files, data = {}) {
  files ??= [await makeFile(actor)];
  return app.prisma.fileShareLink.create({
    data: {
      workspaceId: workspace.id,
      createdById: users[actor].id,
      token: crypto.randomUUID(),
      files: { create: files.map((file) => ({ fileId: file.id })) },
      ...data,
    },
  });
}
async function state() {
  return {
    links: await app.prisma.fileShareLink.findMany({
      where: { workspaceId: { in: [workspace.id, foreign.id] } },
      orderBy: { id: "asc" },
      include: { files: { orderBy: { id: "asc" } } },
    }),
    files: await app.prisma.file.findMany({
      where: { workspaceId: { in: [workspace.id, foreign.id] } },
      orderBy: { id: "asc" },
    }),
    notifications: await app.prisma.notification.count(),
    effects: { ...effects },
  };
}
async function deniedHttpAndUnchanged(actor, link, wid = workspace.id) {
  const before = await state();
  for (const method of ["PATCH", "DELETE"]) {
    denied(
      await request(
        actor,
        method,
        link.id,
        method === "PATCH"
          ? { enabled: false, expiresAt: "2031-01-01T00:00:00.000Z" }
          : undefined,
        wid,
      ),
    );
    assert.deepEqual(await state(), before);
  }
}
async function deniedServicesAndUnchanged(actor, link, ctx = context(actor)) {
  const before = await state();
  await rejected(
    shares.updateFileShareLink(app.prisma, link.id, { enabled: false }, ctx),
  );
  assert.deepEqual(await state(), before);
  await rejected(shares.deleteFileShareLink(app.prisma, link.id, ctx));
  assert.deepEqual(await state(), before);
}
before(async () => {
  app = await buildApp();
  await app.ready();
  for (const actor of [
    "ADMIN",
    "OWNER",
    "PEER",
    "VIEWER",
    "FORMER",
    "FOREIGN",
  ]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `manager-${actor}-${crypto.randomUUID()}@example.test`,
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
      name: "Share manager audit",
      slug: crypto.randomUUID(),
      members: {
        create: ["ADMIN", "OWNER", "PEER", "VIEWER", "FORMER"].map((actor) => ({
          userId: users[actor].id,
          role:
            actor === "ADMIN"
              ? "ADMIN"
              : actor === "VIEWER"
                ? "VIEWER"
                : "MEMBER",
        })),
      },
    },
  });
  foreign = await app.prisma.workspace.create({
    data: {
      name: "Share manager foreign",
      slug: crypto.randomUUID(),
      members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } },
    },
  });
  for (const [method, counter] of [
    ["read", "reads"],
    ["readStream", "reads"],
    ["save", "writes"],
    ["saveStream", "writes"],
    ["delete", "deletes"],
  ]) {
    app.storage[method] = () => {
      effects[counter]++;
      throw new Error(`Unexpected manager storage operation: ${method}`);
    };
  }
  app.broadcastToUser = () => {
    effects.events++;
  };
  app.broadcastToWorkspace = () => {
    effects.events++;
  };
});
after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [workspace?.id, foreign?.id].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((user) => user.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("same-workspace noncreator cannot update or delete a link", async () => {
  const link = await makeLink();
  await deniedHttpAndUnchanged("PEER", link);
  await deniedServicesAndUnchanged("PEER", link);
});

test("local admin and creator contexts cannot manage a link in another workspace", async () => {
  const file = await makeFile("FOREIGN", { workspaceId: foreign.id });
  for (const creator of ["FOREIGN", "OWNER"]) {
    const link = await makeLink(creator, [file], { workspaceId: foreign.id });
    for (const actor of ["ADMIN", "OWNER"]) {
      await deniedHttpAndUnchanged(actor, link);
      await deniedServicesAndUnchanged(actor, link);
    }
  }
});

test("VIEWER creators cannot write through HTTP or supplied ADMIN service roles", async () => {
  const link = await makeLink("VIEWER");
  await deniedHttpAndUnchanged("VIEWER", link);
  await deniedServicesAndUnchanged("VIEWER", link);
});

test("removed creator membership denies writes even while link ownership remains", async () => {
  const link = await makeLink("FORMER");
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.FORMER.id,
        workspaceId: workspace.id,
      },
    },
  });
  await deniedHttpAndUnchanged("FORMER", link);
  await deniedServicesAndUnchanged("FORMER", link);
});

test("demoted admins cannot retain manager authority through stale contexts", async () => {
  const link = await makeLink();
  const key = {
    userId_workspaceId: { userId: users.ADMIN.id, workspaceId: workspace.id },
  };
  await app.prisma.workspaceMember.update({
    where: key,
    data: { role: "MEMBER" },
  });
  try {
    await deniedHttpAndUnchanged("ADMIN", link);
    await deniedServicesAndUnchanged("ADMIN", link);
  } finally {
    await app.prisma.workspaceMember.update({
      where: key,
      data: { role: "ADMIN" },
    });
  }
});

test("file ownership alone does not confer authority over another creator's link", async () => {
  const link = await makeLink("PEER", [await makeFile("OWNER")]);
  await deniedHttpAndUnchanged("OWNER", link);
  await deniedServicesAndUnchanged("OWNER", link);
});

for (const actor of ["OWNER", "ADMIN"])
  test(`${actor}: legitimate disable and delete work with stale mixed sources`, async () => {
    const local = await makeFile("PEER");
    const trash = await makeFile("PEER", { trashedAt: new Date() });
    const other = await makeFile("FOREIGN", { workspaceId: foreign.id });
    const link = await makeLink("OWNER", [local, trash, other], {
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const sourceRows = await app.prisma.fileShareLinkFile.findMany({
      where: { shareLinkId: link.id },
      orderBy: { id: "asc" },
    });
    const beforeEffects = { ...effects };
    const updated = await request(actor, "PATCH", link.id, { enabled: false });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.enabled, false);
    assert.deepEqual(
      updated.json().data.files.map((entry) => entry.file.id),
      // Revocation authority is independent of source-file read authority.
      actor === "ADMIN" ? [local.id] : [],
    );
    assert(!updated.body.includes(trash.id));
    assert(!updated.body.includes(other.id));
    assert.deepEqual(
      await app.prisma.fileShareLinkFile.findMany({
        where: { shareLinkId: link.id },
        orderBy: { id: "asc" },
      }),
      sourceRows,
    );
    const deleted = await request(actor, "DELETE", link.id);
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(
      await app.prisma.fileShareLink.findUnique({ where: { id: link.id } }),
      null,
    );
    assert.equal(
      await app.prisma.file.count({
        where: { id: { in: [local.id, trash.id, other.id] } },
      }),
      3,
    );
    assert.deepEqual(effects, beforeEffects);
  });

for (const actor of ["OWNER", "ADMIN"])
  test(`${actor}: empty links remain manageable after source deletion`, async () => {
    const file = await makeFile();
    const link = await makeLink("OWNER", [file], { enabled: false });
    await app.prisma.file.delete({ where: { id: file.id } });
    assert.equal(
      await app.prisma.fileShareLinkFile.count({
        where: { shareLinkId: link.id },
      }),
      0,
    );
    const updated = await request(actor, "PATCH", link.id, { enabled: false });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().data.files, []);
    assert.equal((await request(actor, "DELETE", link.id)).statusCode, 204);
    assert.deepEqual(effects, { reads: 0, writes: 0, deletes: 0, events: 0 });
  });

test("missing links deny cleanly without changing any managed state", async () => {
  const missing = { id: crypto.randomUUID() };
  await deniedHttpAndUnchanged("OWNER", missing);
  await deniedServicesAndUnchanged("ADMIN", missing);
});

test("current creator and admin roles retain authority despite stale lower service-role strings", async () => {
  const initial = { ...effects };
  for (const actor of ["OWNER", "ADMIN"]) {
    const link = await makeLink();
    const ctx = { ...context(actor), workspaceRole: "VIEWER" };
    const result = await shares.updateFileShareLink(
      app.prisma,
      link.id,
      { enabled: false },
      ctx,
    );
    assert.equal(result.enabled, false);
    await shares.deleteFileShareLink(app.prisma, link.id, ctx);
    assert.equal(
      await app.prisma.fileShareLink.findUnique({ where: { id: link.id } }),
      null,
    );
  }
  assert.deepEqual(effects, initial);
});
