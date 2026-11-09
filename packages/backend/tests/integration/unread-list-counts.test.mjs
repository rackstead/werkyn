// Unread counts were one COUNT per channel. Project and team-folder lists
// included Prisma `_count`, which joins a count of every related row. The
// numbers must stay the same, including zeros, and each list must count with
// one grouped query.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { recordQueries } from "./support/query-events.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "unread-list-counts-disposable-jwt",
  COOKIE_SECRET: "unread-list-counts-disposable-cookie",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-unread-counts-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { PrismaClient } = await import("@prisma/client");
const chat = await import("../../src/modules/chat/chat.service.js");
const projects = await import("../../src/modules/projects/projects.service.js");
const teams = await import("../../src/modules/team-folders/team-folders.service.js");
const { fileAccessRole, teamFolderAccessWhere } = await import("../../src/modules/files/file-access.js");

const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({
  datasourceUrl: observerUrl.toString(),
  log: [{ level: "query", emit: "event" }],
});

const CHANNELS = 60;
const T0 = new Date(Date.UTC(2026, 3, 1, 0, 0, 0));
const plus = (ms) => new Date(T0.getTime() + ms);
const pad = (n) => String(n).padStart(2, "0");
const channelId = (i) => `ch-${pad(i)}`;
const projectId = (i) => `proj-${pad(i)}`;
const folderId = (i) => `tf-${pad(i)}`;

let app;
let requests = 0;
const users = {};
const tokens = {};
let home, other;
const statementLog = {};

function get(actor, url) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.86.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

async function ok(actor, url) {
  const res = await get(actor, url);
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.json();
}

/** Today's per-channel counts, including zeros. */
async function legacyUnread(client, workspaceId, userId) {
  const memberships = await client.chatChannelMember.findMany({
    where: { userId, channel: { workspaceId } },
    select: { channelId: true, lastReadAt: true },
  });
  return Promise.all(memberships.map(async (membership) => {
    const count = await client.chatMessage.count({
      where: {
        channelId: membership.channelId,
        createdAt: { gt: membership.lastReadAt },
        deletedAt: null,
        userId: { not: userId },
      },
    });
    return { channelId: membership.channelId, count };
  }));
}

async function legacyProjects(client, workspaceId, userId, userRole, query) {
  const where = { workspaceId, archived: query.archived };
  if (query.search) where.name = { contains: query.search, mode: "insensitive" };
  if (userRole !== "ADMIN") where.members = { some: { userId } };
  const [data, total] = await Promise.all([
    client.project.findMany({
      where,
      include: { _count: { select: { members: true, tasks: true } } },
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    client.project.count({ where }),
  ]);
  return {
    data,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

async function legacyTeamFolders(client, workspaceId, userId, workspaceRole) {
  const ctx = { workspaceId, userId, workspaceRole };
  const role = await fileAccessRole(client, ctx);
  return client.teamFolder.findMany({
    where: {
      workspaceId,
      folder: { workspaceId, isFolder: true, trashedAt: null },
      ...(role === "ADMIN" ? {} : teamFolderAccessWhere(ctx)),
    },
    include: {
      folder: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
    orderBy: { name: "asc" },
  });
}

const json = (value) => JSON.parse(JSON.stringify(value));
const countsOf = (rows) => Object.fromEntries(rows.map((row) => [row.id, row._count]));
const unreadOf = (rows, ids) => {
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const row of rows) counts[row.channelId] = row.count;
  return counts;
};
const chatCountStatements = (events) => events.filter((event) =>
  /ChatMessage/i.test(event.query) && /count\s*\(/i.test(event.query));

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 8);
  for (const name of ["admin", "member", "other", "outsider"]) {
    users[name] = await app.prisma.user.create({
      data: { email: `unread-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    tokens[name] = signAccessToken({ sub: users[name].id, email: users[name].email });
  }
  users.extras = [];
  for (let i = 0; i < 4; i++) {
    users.extras.push(await app.prisma.user.create({
      data: { email: `unread-extra-${i}-${suffix}@example.test`, displayName: `extra ${i}`, emailVerified: true },
    }));
  }

  home = await app.prisma.workspace.create({
    data: {
      name: "Unread home",
      slug: `unread-home-${suffix}`,
      members: {
        create: [
          { userId: users.admin.id, role: "ADMIN" },
          { userId: users.member.id, role: "MEMBER" },
          { userId: users.other.id, role: "MEMBER" },
          { userId: users.outsider.id, role: "MEMBER" },
          ...users.extras.map((user) => ({ userId: user.id, role: "MEMBER" })),
        ],
      },
    },
  });
  other = await app.prisma.workspace.create({
    data: {
      name: "Unread other",
      slug: `unread-other-${suffix}`,
      members: { create: [{ userId: users.admin.id, role: "ADMIN" }, { userId: users.other.id, role: "MEMBER" }] },
    },
  });

  const channels = [];
  const memberships = [];
  for (let i = 0; i < CHANNELS; i++) {
    channels.push({
      id: channelId(i),
      workspaceId: home.id,
      name: `channel-${pad(i)}`,
      type: "PUBLIC",
      createdById: users.admin.id,
    });
    memberships.push({
      channelId: channelId(i),
      userId: users.admin.id,
      // Pattern 2 was read after its messages. Everyone else is read up to T0.
      lastReadAt: i % 5 === 2 ? plus(10_000) : T0,
      joinedAt: T0,
    });
    if (i < 8) {
      memberships.push({
        channelId: channelId(i),
        userId: users.member.id,
        lastReadAt: T0,
        joinedAt: T0,
      });
    }
  }
  channels.push({
    id: "ch-secret",
    workspaceId: home.id,
    name: "secret",
    type: "PUBLIC",
    createdById: users.other.id,
  });
  channels.push({
    id: "ch-foreign",
    workspaceId: other.id,
    name: "foreign",
    type: "PUBLIC",
    createdById: users.admin.id,
  });
  memberships.push({
    channelId: "ch-foreign",
    userId: users.admin.id,
    lastReadAt: T0,
    joinedAt: T0,
  });
  await app.prisma.chatChannel.createMany({ data: channels });
  await app.prisma.chatChannelMember.createMany({ data: memberships });

  const messages = [];
  const replies = [];
  const message = (id, at, from, extra = {}) => ({
    channelId: id,
    userId: from,
    content: "m",
    createdAt: plus(at),
    ...extra,
  });
  for (let i = 0; i < CHANNELS; i++) {
    const id = channelId(i);
    const pattern = i % 5;
    if (pattern === 1) {
      messages.push(
        message(id, -1000, users.other.id),
        message(id, 0, users.other.id),
        message(id, 1000, users.admin.id),
        message(id, 2000, users.other.id, { deletedAt: plus(2500) }),
        message(id, 3000, users.other.id),
        message(id, 4000, users.other.id),
      );
    } else if (pattern === 2) {
      messages.push(message(id, 1000, users.other.id), message(id, 2000, users.other.id));
    } else if (pattern === 3) {
      messages.push(message(id, 1000, users.admin.id), message(id, 2000, users.admin.id));
    } else if (pattern === 4) {
      const parent = `reply-parent-${pad(i)}`;
      messages.push(message(id, 1000, users.other.id, { id: parent }));
      replies.push(message(id, 2000, users.other.id, { parentId: parent }));
    }
  }
  for (let i = 0; i < 5; i++) messages.push(message("ch-secret", 1000 + i, users.other.id));
  for (let i = 0; i < 4; i++) messages.push(message("ch-foreign", 1000 + i, users.other.id));
  // Messages in a channel the caller has not joined. A sequential scan of the
  // table would read these; the per-channel index range should not.
  for (let i = 0; i < 1000; i++) {
    messages.push(message("ch-secret", 20_000 + i, users.other.id, { content: `noise-${i}` }));
  }
  await app.prisma.chatMessage.createMany({ data: messages });
  await app.prisma.chatMessage.createMany({ data: replies });
  await app.prisma.$executeRawUnsafe('ANALYZE "ChatChannel", "ChatChannelMember", "ChatMessage"');

  const projectRows = [];
  const statusRows = [];
  const memberRows = [];
  const taskRows = [];
  for (let i = 0; i < 50; i++) {
    projectRows.push({
      id: projectId(i),
      workspaceId: home.id,
      name: i === 7 ? "search-target" : `Project ${pad(i)}`,
      archived: i === 49,
      createdAt: plus(i * 1000),
    });
    statusRows.push({ id: `status-${pad(i)}`, projectId: projectId(i), name: "Open", position: 0 });
    memberRows.push({ projectId: projectId(i), userId: users.admin.id });
    if (i % 2 === 0) memberRows.push({ projectId: projectId(i), userId: users.member.id });
    if (i % 3 === 0) memberRows.push({ projectId: projectId(i), userId: users.extras[0].id });
    for (let t = 0; t < i % 7; t++) {
      taskRows.push({
        projectId: projectId(i),
        statusId: `status-${pad(i)}`,
        title: `task-${t}`,
        position: t,
        archived: t === 0,
      });
    }
  }
  projectRows.push({
    id: "proj-foreign",
    workspaceId: other.id,
    name: "Foreign",
    createdAt: plus(1),
  });
  statusRows.push({ id: "status-foreign", projectId: "proj-foreign", name: "Open", position: 0 });
  memberRows.push({ projectId: "proj-foreign", userId: users.admin.id });
  for (let t = 0; t < 20; t++) {
    taskRows.push({ projectId: "proj-foreign", statusId: "status-foreign", title: `foreign-${t}`, position: t });
  }
  await app.prisma.project.createMany({ data: projectRows });
  await app.prisma.statusColumn.createMany({ data: statusRows });
  await app.prisma.projectMember.createMany({ data: memberRows });
  await app.prisma.task.createMany({ data: taskRows });

  const fileRows = [];
  const teamRows = [];
  const teamMembers = [];
  for (let i = 0; i < 30; i++) {
    const trashed = i === 28;
    const workspaceId = i === 29 ? other.id : home.id;
    fileRows.push({
      id: `file-${pad(i)}`,
      workspaceId,
      name: `Folder ${pad(i)}`,
      isFolder: true,
      uploadedById: users.admin.id,
      ownerId: null,
      trashedAt: trashed ? T0 : null,
    });
    teamRows.push({
      id: folderId(i),
      workspaceId,
      folderId: `file-${pad(i)}`,
      name: `Folder ${pad(i)}`,
    });
    if (i >= 28) continue;
    for (let m = 0; m < i % 5; m++) teamMembers.push({ teamFolderId: folderId(i), userId: users.extras[m].id });
    if (i % 2 === 0) teamMembers.push({ teamFolderId: folderId(i), userId: users.member.id });
  }
  await app.prisma.file.createMany({ data: fileRows });
  await app.prisma.teamFolder.createMany({ data: teamRows });
  await app.prisma.teamFolderMember.createMany({ data: teamMembers });
  await app.prisma.group.create({
    data: {
      workspaceId: home.id,
      name: `readers-${suffix}`,
      members: { create: { userId: users.member.id } },
      teamFolderGroups: { create: { teamFolderId: folderId(1) } },
    },
  });
});

after(async () => {
  if (Object.keys(statementLog).length) console.info("unread-list-counts statements", JSON.stringify(statementLog));
  if (home) await app.prisma.workspace.delete({ where: { id: home.id } }).catch(() => {});
  if (other) await app.prisma.workspace.delete({ where: { id: other.id } }).catch(() => {});
  const ids = [users.admin, users.member, users.other, users.outsider, ...(users.extras ?? [])]
    .filter(Boolean)
    .map((user) => user.id);
  if (ids.length) await app.prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await observer.$disconnect();
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("each channel's unread count matches the per-channel count, in one statement", async () => {
  const homeIds = Array.from({ length: CHANNELS }, (_, i) => channelId(i));
  const legacy = await recordQueries(observer, (client) => legacyUnread(client, home.id, users.admin.id));
  const counted = await recordQueries(observer, (client) => chat.getUnreadCounts(client, home.id, users.admin.id));
  const quiet = await recordQueries(observer, (client) => chat.getUnreadCounts(client, home.id, users.member.id));
  const legacyQuiet = await legacyUnread(observer, home.id, users.member.id);

  const expected = unreadOf(legacy.result, homeIds);
  const actual = unreadOf(counted.result, homeIds);
  assert.deepEqual(actual, expected);
  assert.equal(expected[channelId(0)], 0);
  assert.equal(expected[channelId(1)], 2);
  assert.equal(expected[channelId(2)], 0);
  assert.equal(expected[channelId(3)], 0);
  assert.equal(expected[channelId(4)], 2);
  // The member's read marker differs, so the same channel is unread for them.
  assert.equal(unreadOf(legacyQuiet, [channelId(2)])[channelId(2)], 2);
  assert.deepEqual(unreadOf(quiet.result, homeIds.slice(0, 8)), unreadOf(legacyQuiet, homeIds.slice(0, 8)));

  for (const row of counted.result) assert.equal(typeof row.count, "number");
  assert.deepEqual(counted.result.map((row) => row.channelId), [...counted.result.map((row) => row.channelId)].sort());
  assert.ok(counted.result.every((row) => row.count > 0));
  assert.equal(counted.result.some((row) => row.channelId === channelId(0)), false);
  assert.equal(counted.result.some((row) => row.channelId === "ch-secret"), false);
  assert.equal(counted.result.some((row) => row.channelId === "ch-foreign"), false);

  const foreign = await chat.getUnreadCounts(observer, other.id, users.admin.id);
  assert.deepEqual(foreign, [{ channelId: "ch-foreign", count: 4 }]);

  const http = await ok("admin", `/api/chat/${home.id}/unread`);
  assert.deepEqual(unreadOf(http.data, homeIds), expected);
  assert.equal(typeof http.data.find((row) => row.channelId === channelId(1)).count, "number");

  assert.equal(chatCountStatements(legacy.events).length, CHANNELS);
  assert.equal(chatCountStatements(counted.events).length, 1);
  assert.equal(chatCountStatements(quiet.events).length, 1);
  assert.equal(counted.events.length, quiet.events.length);
  assert.ok(counted.events.length < legacy.events.length);
  statementLog.unread = {
    channels: CHANNELS,
    before: legacy.events.length,
    beforeCountStatements: chatCountStatements(legacy.events).length,
    after: counted.events.length,
    afterCountStatements: 1,
    quietChannels: 8,
    quietAfter: quiet.events.length,
  };

  const unreadSql = counted.events.find((event) => /ChatMessage/i.test(event.query));
  const plan = await app.prisma.$queryRawUnsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${unreadSql.query}`,
    ...JSON.parse(unreadSql.params),
  );
  let messageRows = 0;
  const walk = (node) => {
    if (node["Relation Name"] === "ChatMessage") {
      messageRows += (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"];
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan[0]["QUERY PLAN"][0].Plan);
  const [{ n: tableMessages }] = await app.prisma.$queryRaw`SELECT count(*)::int AS n FROM "ChatMessage"`;
  statementLog.unread.messageRows = messageRows;
  statementLog.unread.tableMessages = tableMessages;
  assert.ok(messageRows < tableMessages, `read ${messageRows} message rows; the table has ${tableMessages}`);
});

test("project and team-folder list counts match today's counts, from one grouped query", async () => {
  const full = { archived: false, page: 1, limit: 100 };
  const legacy = await recordQueries(observer, (client) =>
    legacyProjects(client, home.id, users.admin.id, "ADMIN", full));
  const listed = await recordQueries(observer, (client) =>
    projects.listProjects(client, home.id, users.admin.id, "ADMIN", full));
  assert.deepEqual(json(listed.result), json(legacy.result));
  assert.equal(listed.result.pagination.total, 49);
  assert.deepEqual(countsOf(listed.result.data)[projectId(0)], { members: 3, tasks: 0 });
  assert.deepEqual(countsOf(listed.result.data)[projectId(3)], { members: 2, tasks: 3 });
  assert.equal(listed.result.data.some((project) => project.id === "proj-foreign"), false);
  assert.equal(listed.result.data.some((project) => project.id === projectId(49)), false);

  const memberListed = await recordQueries(observer, (client) =>
    projects.listProjects(client, home.id, users.member.id, "MEMBER", full));
  const memberLegacy = await legacyProjects(observer, home.id, users.member.id, "MEMBER", full);
  assert.deepEqual(json(memberListed.result), json(memberLegacy));
  assert.equal(memberListed.result.data.some((project) => project.id === projectId(3)), false);
  assert.deepEqual(countsOf(memberListed.result.data)[projectId(0)], { members: 3, tasks: 0 });

  const page = { archived: false, page: 2, limit: 10 };
  const paged = await projects.listProjects(observer, home.id, users.admin.id, "ADMIN", page);
  const pagedLegacy = await legacyProjects(observer, home.id, users.admin.id, "ADMIN", page);
  assert.deepEqual(json(paged), json(pagedLegacy));
  assert.equal(paged.data.length, 10);

  const searched = await recordQueries(observer, (client) =>
    projects.listProjects(client, home.id, users.admin.id, "ADMIN", {
      archived: false, page: 1, limit: 20, search: "SEARCH-target",
    }));
  const searchedLegacy = await legacyProjects(observer, home.id, users.admin.id, "ADMIN", {
    archived: false, page: 1, limit: 20, search: "SEARCH-target",
  });
  assert.deepEqual(json(searched.result), json(searchedLegacy));
  assert.deepEqual(searched.result.data.map((project) => project.id), [projectId(7)]);

  const archived = await projects.listProjects(observer, home.id, users.admin.id, "ADMIN", {
    archived: true, page: 1, limit: 20,
  });
  const archivedLegacy = await legacyProjects(observer, home.id, users.admin.id, "ADMIN", {
    archived: true, page: 1, limit: 20,
  });
  assert.deepEqual(json(archived), json(archivedLegacy));

  const http = await ok("admin", `/api/workspaces/${home.id}/projects?limit=100`);
  assert.deepEqual(countsOf(http.data), countsOf(json(legacy.result.data)));
  assert.equal(http.pagination.total, 49);

  for (const recorded of [listed, memberListed, searched]) {
    assert.equal(recorded.events.filter((event) => event.query.includes("_aggr_count")).length, 0);
    assert.equal(recorded.events.filter((event) => /GROUP BY "projectId"/.test(event.query)).length, 1);
  }
  assert.ok(legacy.events.some((event) => event.query.includes("_aggr_count")), legacy.events.map((event) => event.query).join("\n"));
  assert.equal(listed.events.length, memberListed.events.length);
  assert.equal(listed.events.length, searched.events.length);

  const legacyTeams = await recordQueries(observer, (client) =>
    legacyTeamFolders(client, home.id, users.admin.id, "ADMIN"));
  const adminTeams = await recordQueries(observer, (client) =>
    teams.listTeamFolders(client, home.id, users.admin.id, "ADMIN"));
  assert.deepEqual(json(adminTeams.result), json(legacyTeams.result));
  assert.deepEqual(countsOf(adminTeams.result)[folderId(0)], { members: 1 });
  assert.deepEqual(countsOf(adminTeams.result)[folderId(1)], { members: 1 });
  assert.deepEqual(countsOf(adminTeams.result)[folderId(5)], { members: 0 });
  assert.equal(adminTeams.result.some((folder) => folder.id === folderId(28)), false);
  assert.equal(adminTeams.result.some((folder) => folder.id === folderId(29)), false);
  assert.deepEqual(
    adminTeams.result.map((folder) => folder.name),
    [...adminTeams.result.map((folder) => folder.name)].sort((a, b) => a.localeCompare(b)),
  );

  const memberTeams = await recordQueries(observer, (client) =>
    teams.listTeamFolders(client, home.id, users.member.id, "MEMBER"));
  const memberTeamsLegacy = await legacyTeamFolders(observer, home.id, users.member.id, "MEMBER");
  assert.deepEqual(json(memberTeams.result), json(memberTeamsLegacy));
  assert.equal(memberTeams.result.some((folder) => folder.id === folderId(0)), true);
  assert.equal(memberTeams.result.some((folder) => folder.id === folderId(1)), true);
  assert.equal(memberTeams.result.some((folder) => folder.id === folderId(5)), false);

  const outsiderTeams = await recordQueries(observer, (client) =>
    teams.listTeamFolders(client, home.id, users.outsider.id, "MEMBER"));
  assert.deepEqual(outsiderTeams.result, []);

  const httpTeams = await ok("member", `/api/workspaces/${home.id}/team-folders`);
  assert.deepEqual(countsOf(httpTeams.data), countsOf(json(memberTeams.result)));

  for (const recorded of [adminTeams, memberTeams]) {
    assert.equal(recorded.events.filter((event) => event.query.includes("_aggr_count")).length, 0);
    assert.equal(recorded.events.filter((event) => /GROUP BY "teamFolderId"/.test(event.query)).length, 1);
  }
  assert.equal(outsiderTeams.events.filter((event) => /GROUP BY "teamFolderId"/.test(event.query)).length, 0);
  assert.ok(legacyTeams.events.some((event) => event.query.includes("_aggr_count")), legacyTeams.events.map((event) => event.query).join("\n"));
  assert.equal(adminTeams.events.length, memberTeams.events.length);
  const grouped = adminTeams.events.find((event) => /GROUP BY "teamFolderId"/.test(event.query));
  assert.equal(grouped.params.includes(folderId(5)), true);
  assert.equal(grouped.params.includes(folderId(28)), false);
  assert.equal(grouped.params.includes(folderId(29)), false);

  statementLog.projects = {
    listed: 49,
    before: legacy.events.length,
    after: listed.events.length,
    memberAfter: memberListed.events.length,
    searchAfter: searched.events.length,
  };
  statementLog.teamFolders = {
    before: legacyTeams.events.length,
    after: adminTeams.events.length,
    memberAfter: memberTeams.events.length,
    emptyAfter: outsiderTeams.events.length,
  };
});
