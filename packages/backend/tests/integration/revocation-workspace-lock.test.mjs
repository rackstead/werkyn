import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
// The move and the revocation each hold one pooled connection, and the grant
// snapshot needs a third. The lock holder and pg_stat_activity observer use a
// separate two-connection pool so a blocked actor cannot starve the release.
const actorUrl = new URL(process.env.TEST_DATABASE_URL);
if (!actorUrl.searchParams.has("connection_limit"))
  actorUrl.searchParams.set("connection_limit", "5");
assert(
  Number(actorUrl.searchParams.get("connection_limit")) >= 5,
  "Revocation fixtures require connection_limit>=5",
);
const controlUrl = new URL(actorUrl);
controlUrl.searchParams.set("connection_limit", "2");
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-revocation-lock-"),
);
Object.assign(process.env, {
  DATABASE_URL: actorUrl.toString(),
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "revocation-workspace-lock-jwt-secret",
  COOKIE_SECRET: "revocation-workspace-lock-cookie-secret",
  STORAGE_DIR: storageDir,
});

const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const suffix = crypto.randomBytes(4).toString("hex");
let app;
let control;
let admin;
let member;
let workspace;
let requests = 0;

before(async () => {
  control = new PrismaClient({
    datasources: { db: { url: controlUrl.toString() } },
  });
  await control.$connect();
  app = await buildApp();
  await app.ready();
  admin = await app.prisma.user.create({
    data: {
      email: `revoke-admin-${suffix}@example.test`,
      displayName: "Revoke admin",
      emailVerified: true,
    },
  });
  member = await app.prisma.user.create({
    data: {
      email: `revoke-member-${suffix}@example.test`,
      displayName: "Revoke member",
      emailVerified: true,
    },
  });
  workspace = await app.prisma.workspace.create({
    data: {
      name: `Revocation ${suffix}`,
      slug: `revocation-${suffix}`,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: member.id, role: "MEMBER" },
        ],
      },
    },
  });
  admin.token = signAccessToken({ sub: admin.id, email: admin.email });
  member.token = signAccessToken({ sub: member.id, email: member.email });
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.file.updateMany({
        where: { workspaceId: workspace.id },
        data: { parentId: null },
      });
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({
        where: { id: { in: [admin?.id, member?.id].filter(Boolean) } },
      });
    }
  } finally {
    const closed = await Promise.allSettled([
      app?.close(),
      control?.$disconnect(),
    ]);
    await rm(storageDir, { recursive: true, force: true });
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
});

function call(actor, method, url, body) {
  const n = ++requests;
  return app.inject({
    method,
    url,
    payload: body,
    headers: { authorization: `Bearer ${actor.token}` },
    remoteAddress: `10.93.${Math.floor(n / 250)}.${(n % 250) + 1}`,
  });
}

function fileUrl(fileId) {
  return `/api/workspaces/${workspace.id}/files/${fileId}`;
}

function idList(value) {
  if (Array.isArray(value)) return value.map(Number);
  return [];
}

function blockedBy(waiter, pid) {
  return idList(waiter.blockers).includes(Number(pid));
}

async function until(predicate, ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await predicate()) return true;
    await sleep(15);
  }
  return false;
}

async function lockWaiters(holderPid) {
  return control.$queryRaw`
    SELECT pid::int AS pid, wait_event AS "waitEvent", query,
           pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
      AND pid <> ${Number(holderPid)}::int
  `;
}

/**
 * Holds `fileId` FOR UPDATE, starts the member's file update, and only then
 * starts the revocation. The update is already inside the workspace lock and
 * blocked on the file row, which is the ordering the revocation must wait for.
 */
async function raceOpenUpdate(fileId, startUpdate, startRevoke, countGrants) {
  let release;
  let ready;
  const released = new Promise((resolve) => (release = resolve));
  const isReady = new Promise((resolve) => (ready = resolve));
  let holderPid = null;
  const holder = control.$transaction(
    async (tx) => {
      [{ pid: holderPid }] =
        await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`;
      await tx.$queryRaw`SELECT id FROM "File" WHERE id = ${fileId} FOR UPDATE`;
      ready();
      await released;
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
  const running = [];
  const observed = {
    updateBlockedOnFile: false,
    revokeFinishedWhileUpdateOpen: false,
    revokeWaitedOnUpdate: false,
    grantsWhileUpdateOpen: null,
    waitEvent: null,
  };
  try {
    await Promise.race([
      isReady,
      holder.then(() => {
        throw new Error(
          "Control transaction ended before it held the file row",
        );
      }),
    ]);
    let updateDone = false;
    running.push(startUpdate().finally(() => (updateDone = true)));
    let updatePid = null;
    observed.updateBlockedOnFile = await until(async () => {
      const waiters = await lockWaiters(holderPid);
      const onFile = waiters.find(
        (waiter) =>
          blockedBy(waiter, holderPid) &&
          typeof waiter.query === "string" &&
          /UPDATE/i.test(waiter.query) &&
          waiter.query.includes('"File"'),
      );
      if (!onFile) return false;
      updatePid = Number(onFile.pid);
      return true;
    }, 4_000);
    assert(
      observed.updateBlockedOnFile,
      "file update never blocked on the held file row",
    );
    assert.equal(
      updateDone,
      false,
      "file update committed before the revocation started",
    );
    let revokeDone = false;
    running.push(startRevoke().finally(() => (revokeDone = true)));
    await until(async () => {
      if (revokeDone) return true;
      const waiters = await lockWaiters(holderPid);
      const behindUpdate = waiters.find(
        (waiter) =>
          Number(waiter.pid) !== updatePid && blockedBy(waiter, updatePid),
      );
      if (!behindUpdate) return false;
      observed.revokeWaitedOnUpdate = true;
      observed.waitEvent = behindUpdate.waitEvent;
      return true;
    }, 3_000);
    observed.revokeFinishedWhileUpdateOpen = revokeDone;
    observed.grantsWhileUpdateOpen = await countGrants();
    assert.equal(
      updateDone,
      false,
      "file update committed while the file row was still held",
    );
  } finally {
    release();
    await Promise.allSettled([holder, ...running]);
  }
  await holder;
  const [update, revoke] = await Promise.all(running);
  return { update, revoke, observed };
}

function assertRevocationWaited(label, observed) {
  assert.equal(
    observed.revokeFinishedWhileUpdateOpen,
    false,
    `${label}: revocation committed while the file update was still open ${JSON.stringify(observed)}`,
  );
  assert.equal(
    observed.revokeWaitedOnUpdate,
    true,
    `${label}: revocation did not wait on the file update's workspace lock ${JSON.stringify(observed)}`,
  );
  assert.equal(
    observed.grantsWhileUpdateOpen,
    1,
    `${label}: grant was already gone while the file update was open, so the update would commit as the revoked user`,
  );
}

async function place(fileId) {
  return app.prisma.file.findUniqueOrThrow({
    where: { id: fileId },
    select: { parentId: true, ownerId: true, teamFolderId: true, name: true },
  });
}

async function teamTree(label) {
  const stamp = crypto.randomBytes(3).toString("hex");
  const root = await app.prisma.file.create({
    data: {
      workspaceId: workspace.id,
      name: `Root ${label} ${stamp}`,
      isFolder: true,
      uploadedById: admin.id,
      ownerId: null,
      teamFolderId: null,
    },
  });
  const team = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: `Team ${label} ${stamp}`,
    },
  });
  const child = (name) =>
    app.prisma.file.create({
      data: {
        workspaceId: workspace.id,
        parentId: root.id,
        name,
        isFolder: true,
        uploadedById: admin.id,
        ownerId: null,
        teamFolderId: team.id,
      },
    });
  const moving = await child("Moving");
  const spare = await child("Spare");
  return { root, team, moving, spare, stamp };
}

async function groupGrant(team, stamp, label) {
  const group = await app.prisma.group.create({
    data: {
      workspaceId: workspace.id,
      name: `Group ${label} ${stamp}`,
    },
  });
  await app.prisma.groupMember.create({
    data: { groupId: group.id, userId: member.id },
  });
  await app.prisma.teamFolderGroup.create({
    data: { teamFolderId: team.id, groupId: group.id },
  });
  return group;
}

async function runTeamCase(label, prepare) {
  const tree = await teamTree(label);
  const { revoke, count } = await prepare(tree);
  const raced = await raceOpenUpdate(
    tree.moving.id,
    () => call(member, "PATCH", fileUrl(tree.moving.id), { parentId: null }),
    revoke,
    count,
  );
  assertRevocationWaited(label, raced.observed);
  assert.equal(
    raced.update.statusCode,
    200,
    `${label} in-flight move: ${raced.update.body}`,
  );
  assert.equal(
    raced.revoke.statusCode,
    204,
    `${label} revocation: ${raced.revoke.body}`,
  );
  // The update already held the workspace lock, so it commits while the grant
  // is still present and the revocation is waiting. It does not commit after
  // the user was revoked. The revocation then removes the grant.
  assert.deepEqual(await place(tree.moving.id), {
    parentId: null,
    ownerId: member.id,
    teamFolderId: null,
    name: "Moving",
  });
  assert.equal(
    await count(),
    0,
    `${label}: revocation did not remove the grant`,
  );
  const later = await call(member, "PATCH", fileUrl(tree.spare.id), {
    parentId: null,
  });
  assert.equal(later.statusCode, 403, `${label} later move: ${later.body}`);
  assert.match(later.body, /do not have access/);
  assert.deepEqual(await place(tree.spare.id), {
    parentId: tree.root.id,
    ownerId: null,
    teamFolderId: tree.team.id,
    name: "Spare",
  });
  console.info(
    `${label}: revocation waited on ${raced.observed.waitEvent}; in-flight move 200 with grant still present; later move 403`,
  );
}

test("team-member delete waits for an open file move, which does not commit on the revoked grant", async () => {
  await runTeamCase("team-member delete", async (tree) => {
    await app.prisma.teamFolderMember.create({
      data: { teamFolderId: tree.team.id, userId: member.id },
    });
    return {
      revoke: () =>
        call(
          admin,
          "DELETE",
          `/api/workspaces/${workspace.id}/team-folders/${tree.team.id}/members/${member.id}`,
        ),
      count: () =>
        app.prisma.teamFolderMember.count({
          where: { teamFolderId: tree.team.id, userId: member.id },
        }),
    };
  });
});

test("group-member delete waits for an open file move, which does not commit on the revoked grant", async () => {
  await runTeamCase("group-member delete", async (tree) => {
    const group = await groupGrant(tree.team, tree.stamp, "member");
    return {
      revoke: () =>
        call(
          admin,
          "DELETE",
          `/api/workspaces/${workspace.id}/groups/${group.id}/members/${member.id}`,
        ),
      count: () =>
        app.prisma.groupMember.count({
          where: { groupId: group.id, userId: member.id },
        }),
    };
  });
});

test("team-folder group unlink waits for an open file move, which does not commit on the revoked grant", async () => {
  await runTeamCase("team-folder group unlink", async (tree) => {
    const group = await groupGrant(tree.team, tree.stamp, "unlink");
    return {
      revoke: () =>
        call(
          admin,
          "DELETE",
          `/api/workspaces/${workspace.id}/team-folders/${tree.team.id}/groups/${group.id}`,
        ),
      count: () =>
        app.prisma.teamFolderGroup.count({
          where: { teamFolderId: tree.team.id, groupId: group.id },
        }),
    };
  });
});

test("group delete waits for an open file move, which does not commit on the revoked grant", async () => {
  await runTeamCase("group delete", async (tree) => {
    const group = await groupGrant(tree.team, tree.stamp, "delete");
    return {
      revoke: () =>
        call(
          admin,
          "DELETE",
          `/api/workspaces/${workspace.id}/groups/${group.id}`,
        ),
      count: () => app.prisma.group.count({ where: { id: group.id } }),
    };
  });
});

test("file-share delete waits for an open file update and does not commit underneath it", async () => {
  for (const target of ["same file", "different file"]) {
    const stamp = crypto.randomBytes(3).toString("hex");
    const renamed = await app.prisma.file.create({
      data: {
        workspaceId: workspace.id,
        name: `Owned ${stamp}`,
        isFolder: true,
        uploadedById: admin.id,
        ownerId: admin.id,
      },
    });
    const shared =
      target === "same file"
        ? renamed
        : await app.prisma.file.create({
            data: {
              workspaceId: workspace.id,
              name: `Shared ${stamp}`,
              isFolder: true,
              uploadedById: admin.id,
              ownerId: admin.id,
            },
          });
    const share = await app.prisma.fileShare.create({
      data: {
        workspaceId: workspace.id,
        fileId: shared.id,
        sharedById: admin.id,
        sharedWithId: member.id,
      },
    });
    const count = () => app.prisma.fileShare.count({ where: { id: share.id } });
    const nextName = `Renamed ${target} ${stamp}`;
    const raced = await raceOpenUpdate(
      renamed.id,
      () => call(admin, "PATCH", fileUrl(renamed.id), { name: nextName }),
      () =>
        call(
          admin,
          "DELETE",
          `/api/workspaces/${workspace.id}/files/${shared.id}/shares/${member.id}`,
        ),
      count,
    );
    const label = `file-share delete (${target})`;
    assertRevocationWaited(label, raced.observed);
    assert.equal(
      raced.update.statusCode,
      200,
      `${label} rename: ${raced.update.body}`,
    );
    assert.equal(
      raced.revoke.statusCode,
      204,
      `${label} revocation: ${raced.revoke.body}`,
    );
    assert.equal((await place(renamed.id)).name, nextName);
    assert.equal(await count(), 0, `${label}: share was not removed`);
    console.info(
      `${label}: revocation waited on ${raced.observed.waitEvent}; rename 200 with share still present; share then removed`,
    );
  }
});
