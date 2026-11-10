import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");

const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-membership-rev-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "membership-revision-jwt-secret",
  COOKIE_SECRET: "membership-revision-cookie-secret",
  STORAGE_DIR: storageDir,
  SMTP_HOST: "",
  SMTP_PORT: "587",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_SECURE: "false",
});

const { buildApp } = await import("../../src/app.ts");
const { getUserWorkspaces } = await import("../../src/modules/auth/auth.service.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.ts");

const suffix = crypto.randomBytes(4).toString("hex");
let app;
let address = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  try {
    await app?.prisma.workspace.deleteMany({ where: { slug: { contains: suffix } } });
    await app?.prisma.user.deleteMany({ where: { email: { contains: suffix } } });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

function inject(method, url, { token, cookies, payload } = {}) {
  address += 1;
  return app.inject({
    method,
    url,
    payload,
    cookies,
    remoteAddress: `10.31.${(address >> 8) & 255}.${address & 255}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function makeUser(name) {
  const user = await app.prisma.user.create({
    data: {
      email: `${name}-${suffix}@example.test`,
      displayName: name,
      emailVerified: true,
    },
  });
  return {
    ...user,
    token: signAccessToken({ sub: user.id, email: user.email }),
  };
}

async function joinedAt(userId, workspaceId) {
  const member = await app.prisma.workspaceMember.findUniqueOrThrow({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { joinedAt: true },
  });
  return member.joinedAt.getTime();
}

test("a membership revision is captured with its list and orders a role change and a removal", async () => {
  const owner = await makeUser("owner");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Revision ${suffix}`,
      slug: `rev-${suffix}`,
      members: { create: { userId: owner.id, role: "MEMBER" } },
    },
  });
  const before = await getUserWorkspaces(app.prisma, owner.id);
  assert.equal(before.workspaces.length, 1);
  assert.equal(before.workspaces[0].role, "MEMBER");
  assert.equal(before.workspaces[0].workspace.name, workspace.name);
  const joined = await joinedAt(owner.id, workspace.id);

  let release;
  let inside;
  let failed;
  let markInside;
  const insideReady = new Promise((resolve) => {
    markInside = resolve;
  });
  const held = app.prisma.$transaction(async (tx) => {
    await tx.workspaceMember.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { role: "ADMIN" },
    });
    const first = await getUserWorkspaces(tx, owner.id);
    const second = await getUserWorkspaces(tx, owner.id);
    // Two snapshots inside this membership transaction share one revision.
    assert.equal(second.membershipRevision, first.membershipRevision);
    assert.deepEqual(second.workspaces, first.workspaces);
    assert.equal(first.workspaces[0].role, "ADMIN");
    assert.ok(first.membershipRevision > before.membershipRevision);
    inside = first;
    markInside();
    await new Promise((resolve) => {
      release = resolve;
    });
  }).catch((error) => {
    failed = error;
    markInside();
  });
  await insideReady;
  if (failed) throw failed;
  const outside = await getUserWorkspaces(app.prisma, owner.id);
  assert.equal(outside.membershipRevision, before.membershipRevision);
  assert.equal(outside.workspaces[0].role, "MEMBER");
  release();
  await held;
  assert.equal((await joinedAt(owner.id, workspace.id)), joined);

  const committed = await getUserWorkspaces(app.prisma, owner.id);
  assert.equal(committed.membershipRevision, inside.membershipRevision);
  assert.equal(committed.workspaces[0].role, "ADMIN");
  assert.equal(committed.workspaces[0].workspace.slug, workspace.slug);

  const renamed = await app.prisma.workspace.update({
    where: { id: workspace.id },
    data: { name: `Renamed ${suffix}` },
  });
  const named = await getUserWorkspaces(app.prisma, owner.id);
  assert.ok(named.membershipRevision > committed.membershipRevision);
  assert.equal(named.workspaces[0].workspace.name, renamed.name);
  const unchanged = await app.prisma.workspace.update({
    where: { id: workspace.id },
    data: { name: renamed.name },
  });
  assert.equal(unchanged.name, renamed.name);
  const stillNamed = await getUserWorkspaces(app.prisma, owner.id);
  assert.equal(stillNamed.membershipRevision, named.membershipRevision);

  await app.prisma.workspaceMember.delete({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
  });
  const removed = await getUserWorkspaces(app.prisma, owner.id);
  assert.ok(removed.membershipRevision > named.membershipRevision);
  assert.deepEqual(removed.workspaces, []);
});

test("refresh, invite accept and admission check return the revision of the list they describe", async () => {
  const owner = await makeUser("host");
  const joiner = await makeUser("joiner");
  const workspace = await app.prisma.workspace.create({
    data: {
      name: `Join ${suffix}`,
      slug: `join-${suffix}`,
      members: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });
  const invite = await app.prisma.workspaceInvite.create({
    data: {
      workspaceId: workspace.id,
      token: crypto.randomBytes(32).toString("hex"),
      role: "VIEWER",
    },
  });

  const accepted = await inject("POST", `/api/invites/${invite.token}/accept`, {
    token: joiner.token,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const acceptedBody = accepted.json().data;
  const joined = await getUserWorkspaces(app.prisma, joiner.id);
  assert.equal(acceptedBody.membershipRevision, joined.membershipRevision);
  assert.deepEqual(
    acceptedBody.workspaces.map((membership) => [membership.workspaceId, membership.role]),
    joined.workspaces.map((membership) => [membership.workspaceId, membership.role]),
  );
  assert.deepEqual(acceptedBody.workspaces.map((membership) => membership.workspace.slug), [
    workspace.slug,
  ]);

  const checked = await inject("GET", `/api/invites/${invite.token}/admission`, {
    token: joiner.token,
  });
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().data.membershipRevision, joined.membershipRevision);
  assert.equal(checked.json().data.alreadyMember, true);

  const session = await startRefreshSession(app.prisma, joiner.id);
  const refreshed = await inject("POST", "/api/auth/refresh", {
    cookies: { refresh_token: session.refreshToken },
  });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const refreshedBody = refreshed.json().data;
  const afterRefresh = await getUserWorkspaces(app.prisma, joiner.id);
  assert.equal(refreshedBody.membershipRevision, afterRefresh.membershipRevision);
  assert.deepEqual(
    refreshedBody.workspaces.map((membership) => membership.id),
    afterRefresh.workspaces.map((membership) => membership.id),
  );
  assert.equal(typeof refreshedBody.membershipRevision, "number");
});
