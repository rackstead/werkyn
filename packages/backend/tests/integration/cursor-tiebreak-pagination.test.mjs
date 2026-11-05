// Cursor lists whose sort column is not unique (P02b): bookmarks, wiki
// versions, shared-with-me, task comments, the drive listing and channel
// members. Pages must traverse rows with equal sort values without repeats or
// gaps, keep doing so when rows are inserted between requests, accept any
// listed row ID as a cursor (the cursor format is unchanged), keep the earlier
// answers for unknown and out-of-scope cursors, and let PostgreSQL apply LIMIT.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "cursor-tiebreak-disposable-jwt",
  COOKIE_SECRET: "cursor-tiebreak-disposable-cookie",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-cursor-tiebreak-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { startRefreshSession } = await import("../../src/modules/auth/refresh-sessions.js");
const chat = await import("../../src/modules/chat/chat.service.js");
const versions = await import("../../src/modules/wiki/wiki-versions.service.js");
const shares = await import("../../src/modules/files/file-shares.service.js");
const files = await import("../../src/modules/files/files.service.js");
const comments = await import("../../src/modules/comments/comments.service.js");
const { PrismaClient } = await import("@prisma/client");

// A separate client whose generated SQL is recorded for the LIMIT checks.
const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({ datasourceUrl: observerUrl.toString(), log: [{ level: "query", emit: "event" }] });
let recorded = null;
observer.$on("query", (event) => recorded?.push(event));
async function sqlOf(run) {
  recorded = [];
  try {
    await run(observer);
    return recorded;
  } finally {
    recorded = null;
  }
}
/** The page SELECT of `table` must end in LIMIT with `limit + 1` rows. */
function assertLimited(events, table, limit) {
  const pages = events.filter((e) => e.query.startsWith("SELECT ") && e.query.includes(`FROM "public"."${table}"`) && e.query.includes("ORDER BY"));
  assert.ok(pages.length > 0, `no ${table} page query`);
  for (const page of pages) {
    const match = /LIMIT \$(\d+)/.exec(page.query);
    assert.ok(match, `${table} page query has no LIMIT: ${page.query.slice(0, 300)}`);
    assert.equal(JSON.parse(page.params)[Number(match[1]) - 1], limit + 1, "LIMIT is the page size plus the sentinel row");
  }
}

let app, owner, peer, uploader, token, workspace, foreignWorkspace, requests = 0;
const familyIds = [];
const T = new Date(Date.UTC(2026, 2, 1, 12, 0, 0));
const at = (seconds) => new Date(T.getTime() + seconds * 1000);

function get(url) {
  return app.inject({
    method: "GET", url,
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: `10.83.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}
const withCursor = (url, cursor) => cursor ? `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : url;

/**
 * Follows nextCursor to the end. `between(cursor, page)` runs after each page
 * that has a successor, before the next request.
 */
async function walk(url, between) {
  const seen = [];
  let cursor, pages = 0;
  do {
    const res = await get(withCursor(url, cursor));
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    seen.push(...body.data.map((row) => row.id));
    cursor = body.nextCursor ?? undefined;
    pages += 1;
    if (cursor && between) await between(cursor, pages);
    assert.ok(pages < 500, "pagination must terminate");
  } while (cursor);
  return seen;
}

/**
 * Two new IDs (lower-case letters and digits), one sorting just before
 * `cursor` and one just after it.
 */
function idsAround(cursor) {
  assert.match(cursor, /^[a-z0-9]+$/);
  const tail = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let i = cursor.length - 1;
  while (i > 0 && cursor[i] === "0") i -= 1;
  const lower = cursor.slice(0, i) + alphabet[alphabet.indexOf(cursor[i]) - 1] + "z" + tail;
  return [lower, `${cursor}0${tail}`];
}

function assertExactlyOnce(seen, expected, label) {
  assert.equal(new Set(seen).size, seen.length, `${label}: a row was returned twice`);
  const missing = expected.filter((id) => !seen.includes(id));
  assert.deepEqual(missing, [], `${label}: rows were skipped`);
}

/**
 * The checks every list shares: complete traversal at several page sizes,
 * traversal with rows inserted at the cursor's sort position between pages,
 * any listed ID as a cursor, and the earlier answer for unknown and foreign
 * cursors.
 */
async function checkList({ name, url, expected, insertAt, foreignCursor, unknownCursor = "empty" }) {
  const order = await expected();
  assert.ok(order.length >= 6, `${name}: fixture too small`);
  for (const limit of [1, 2, 3, order.length]) {
    assert.deepEqual(await walk(url(limit)), order, `${name}: limit ${limit}`);
  }

  // Concurrent inserts: after each of the first pages, two rows with the
  // cursor row's sort values arrive, one with an ID that sorts before the
  // cursor's and one after it.
  const inserted = [];
  const seen = await walk(url(2), async (cursor, page) => {
    if (page <= 3) inserted.push(...(await insertAt(cursor, idsAround(cursor))));
  });
  assertExactlyOnce(seen, order, `${name}: inserts between pages`);
  for (const id of seen) assert.ok(order.includes(id) || inserted.includes(id), `${name}: unexpected row`);
  const after = await expected();
  assert.deepEqual(await walk(url(3)), after, `${name}: after inserts`);

  // Any listed ID is a valid cursor (the format is the existing raw ID): the
  // next page is the rows after it in list order.
  for (const index of [0, 2, after.length - 2]) {
    const res = await get(withCursor(url(2), after[index]));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.map((row) => row.id), after.slice(index + 1, index + 3), `${name}: cursor at ${index}`);
  }
  const last = await get(withCursor(url(2), after.at(-1)));
  assert.deepEqual(last.json().data, [], `${name}: cursor at the last row`);
  assert.equal(last.json().nextCursor ?? null, null);

  const unknown = await get(withCursor(url(2), "cmissingcursor000000000000"));
  assert.equal(unknown.statusCode, 200, unknown.body);
  if (unknownCursor === "empty") assert.deepEqual(unknown.json().data, [], `${name}: unknown cursor`);
  else assert.deepEqual(unknown.json().data.map((row) => row.id), after.slice(0, 2), `${name}: unknown cursor restarts`);
  const foreign = await get(withCursor(url(2), await foreignCursor()));
  assert.equal(foreign.statusCode, 200, foreign.body);
  assert.deepEqual(foreign.json().data, [], `${name}: out-of-scope cursor`);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 12);
  const user = (name) => app.prisma.user.create({ data: { email: `tiebreak-${name}-${suffix}@example.test`, displayName: name, emailVerified: true } });
  owner = await user("owner");
  peer = await user("peer");
  uploader = await user("uploader");
  const session = await startRefreshSession(app.prisma, owner.id);
  familyIds.push(session.familyId);
  const signedIn = await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: session.refreshToken } });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  token = signedIn.json().data.accessToken;
  workspace = await app.prisma.workspace.create({ data: {
    name: "Tie-break", slug: `tiebreak-${suffix}`,
    members: { create: [{ userId: owner.id, role: "MEMBER" }, { userId: peer.id, role: "ADMIN" }, { userId: uploader.id, role: "MEMBER" }] },
  } });
  foreignWorkspace = await app.prisma.workspace.create({ data: {
    name: "Tie-break other", slug: `tiebreak-other-${suffix}`,
    members: { create: [{ userId: owner.id, role: "MEMBER" }, { userId: peer.id, role: "ADMIN" }] },
  } });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: [workspace?.id, foreignWorkspace?.id].filter(Boolean) } } });
      await app.prisma.rotatedRefreshToken.deleteMany({ where: { familyId: { in: familyIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: [owner, peer, uploader].filter(Boolean).map((u) => u.id) } } });
    }
  } finally {
    await observer.$disconnect();
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe("chat bookmarks", () => {
  let channel, other;
  const message = (channelId) => app.prisma.chatMessage.create({ data: { channelId, userId: peer.id, content: "bookmarked" } });
  const bookmark = async (createdAt, userId = owner.id, channelId = channel.id, id = undefined) =>
    app.prisma.chatBookmark.create({ data: { id, userId, messageId: (await message(channelId)).id, createdAt } });

  before(async () => {
    channel = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: "tiebreak", createdById: peer.id } });
    other = await app.prisma.chatChannel.create({ data: { workspaceId: foreignWorkspace.id, type: "PUBLIC", name: "other", createdById: peer.id } });
    // Seven bookmarks share one timestamp; three more are older or newer.
    for (const seconds of [0, 0, 0, 0, 0, 0, 0, -5, 5, 10]) await bookmark(at(seconds));
  });

  test("pages traverse equal timestamps exactly once, with inserts, old cursors and scope", async () => {
    await checkList({
      name: "bookmarks",
      url: (limit) => `/api/chat/${workspace.id}/bookmarks?limit=${limit}`,
      expected: async () => (await app.prisma.$queryRaw`
        SELECT b.id FROM "ChatBookmark" b JOIN "ChatMessage" m ON m.id = b."messageId"
        WHERE b."userId" = ${owner.id} AND m."channelId" = ${channel.id} AND m."deletedAt" IS NULL
        ORDER BY b."createdAt" DESC, b.id DESC`).map((r) => r.id),
      insertAt: async (cursor, ids) => {
        const row = await app.prisma.chatBookmark.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => (await bookmark(row.createdAt, owner.id, channel.id, id)).id));
      },
      foreignCursor: async () => (await bookmark(at(0), peer.id)).id,
    });
    // A bookmark in another workspace is not a cursor here either.
    const elsewhere = await bookmark(at(0), owner.id, other.id);
    const res = await get(`/api/chat/${workspace.id}/bookmarks?limit=2&cursor=${elsewhere.id}`);
    assert.deepEqual(res.json().data, []);
  });

  test("the page query applies LIMIT", async () => {
    const [first] = (await chat.listBookmarks(app.prisma, owner.id, workspace.id, undefined, 3)).data;
    assertLimited(await sqlOf((db) => chat.listBookmarks(db, owner.id, workspace.id, first.id, 3)), "ChatBookmark", 3);
  });
});

describe("wiki page versions", () => {
  let page, otherPage, number = 0;
  const version = (createdAt, pageId = page.id, id = undefined) => app.prisma.wikiPageVersion.create({
    data: { id, pageId, title: "v", versionNumber: ++number, createdById: owner.id, createdAt },
  });

  before(async () => {
    const space = await app.prisma.wikiSpace.create({ data: { workspaceId: workspace.id, name: "Tie-break", slug: "tie-break" } });
    page = await app.prisma.wikiPage.create({ data: { spaceId: space.id, title: "Versioned", createdById: peer.id } });
    otherPage = await app.prisma.wikiPage.create({ data: { spaceId: space.id, title: "Other", createdById: peer.id } });
    for (const seconds of [0, 0, 0, 0, 0, 0, -1, 3, 3]) await version(at(seconds));
  });

  test("pages traverse equal timestamps exactly once, with inserts, old cursors and scope", async () => {
    await checkList({
      name: "versions",
      url: (limit) => `/api/wiki/pages/${page.id}/versions?limit=${limit}`,
      expected: async () => (await app.prisma.$queryRaw`
        SELECT id FROM "WikiPageVersion" WHERE "pageId" = ${page.id} ORDER BY "createdAt" DESC, id DESC`).map((r) => r.id),
      insertAt: async (cursor, ids) => {
        const row = await app.prisma.wikiPageVersion.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => (await version(row.createdAt, page.id, id)).id));
      },
      foreignCursor: async () => (await version(at(0), otherPage.id)).id,
    });
  });

  test("the page query applies LIMIT", async () => {
    const [first] = (await versions.listVersions(app.prisma, page.id, undefined, 2)).data;
    assertLimited(await sqlOf((db) => versions.listVersions(db, page.id, first.id, 2)), "WikiPageVersion", 2);
  });
});

describe("files shared with me", () => {
  const share = async (createdAt, sharedWithId = owner.id, id = undefined) => {
    const file = await app.prisma.file.create({ data: { workspaceId: workspace.id, name: "shared", uploadedById: peer.id, ownerId: peer.id, size: 1n } });
    return app.prisma.fileShare.create({ data: { id, workspaceId: workspace.id, fileId: file.id, sharedById: peer.id, sharedWithId, createdAt } });
  };

  before(async () => {
    for (const seconds of [0, 0, 0, 0, 0, 0, 0, -2, 7]) await share(at(seconds));
  });

  test("pages traverse equal timestamps exactly once, with inserts, old cursors and scope", async () => {
    await checkList({
      name: "shared with me",
      url: (limit) => `/api/workspaces/${workspace.id}/files/shared-with-me?limit=${limit}`,
      expected: async () => (await app.prisma.$queryRaw`
        SELECT id FROM "FileShare" WHERE "sharedWithId" = ${owner.id} AND "workspaceId" = ${workspace.id}
        ORDER BY "createdAt" DESC, id DESC`).map((r) => r.id),
      insertAt: async (cursor, ids) => {
        const row = await app.prisma.fileShare.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => (await share(row.createdAt, owner.id, id)).id));
      },
      foreignCursor: async () => (await share(at(0), uploader.id)).id,
    });
  });

  test("the page query applies LIMIT", async () => {
    const ctx = { userId: owner.id, workspaceId: workspace.id, role: "MEMBER" };
    const [first] = (await shares.listSharedWithMe(app.prisma, workspace.id, ctx, undefined, 2)).data;
    assertLimited(await sqlOf((db) => shares.listSharedWithMe(db, workspace.id, ctx, first.id, 2)), "FileShare", 2);
  });
});

describe("task comments", () => {
  let task, otherTask;
  const comment = (createdAt, taskId = task.id, id = undefined) => app.prisma.comment.create({ data: { id, taskId, authorId: peer.id, body: "c", createdAt } });

  before(async () => {
    const project = await app.prisma.project.create({ data: {
      workspaceId: workspace.id, name: "Commented",
      members: { create: [{ userId: owner.id }] },
    } });
    const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
    task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "t" } });
    otherTask = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "u" } });
    for (const seconds of [0, 0, 0, 0, 0, 0, 0, -9, 9]) await comment(at(seconds));
  });

  test("pages traverse equal timestamps exactly once, with inserts, old cursors and scope", async () => {
    await checkList({
      name: "comments",
      url: (limit) => `/api/tasks/${task.id}/comments?limit=${limit}`,
      expected: async () => (await app.prisma.$queryRaw`
        SELECT id FROM "Comment" WHERE "taskId" = ${task.id} ORDER BY "createdAt" DESC, id DESC`).map((r) => r.id),
      insertAt: async (cursor, ids) => {
        const row = await app.prisma.comment.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => (await comment(row.createdAt, task.id, id)).id));
      },
      foreignCursor: async () => (await comment(at(0), otherTask.id)).id,
      // An unknown comment ID has always restarted at the first page.
      unknownCursor: "first-page",
    });
  });

  test("the page query applies LIMIT", async () => {
    const [first] = (await comments.listComments(app.prisma, task.id, { limit: 2 })).data;
    assertLimited(await sqlOf((db) => comments.listComments(db, task.id, { limit: 2, cursor: first.id })), "Comment", 2);
  });
});

describe("drive listing", () => {
  let folder, otherFolder;
  const ctx = () => ({ userId: owner.id, workspaceId: workspace.id, role: "MEMBER" });
  // Lower-case ASCII names and display names sort the same in every collation.
  const file = (data, parentId = folder.id) => app.prisma.file.create({ data: {
    workspaceId: workspace.id, parentId, ownerId: owner.id, uploadedById: owner.id, ...data,
  } });

  before(async () => {
    folder = await file({ name: "root", isFolder: true }, null);
    otherFolder = await file({ name: "elsewhere", isFolder: true }, null);
    const shared = { updatedAt: at(0) };
    for (const [name, isFolder, size, uploadedById] of [
      ["alpha", true, null, owner.id], ["alpha", true, null, uploader.id], ["beta", true, null, owner.id],
      ["beta", true, 0n, owner.id], ["alpha", false, 10n, owner.id], ["alpha", false, 10n, uploader.id],
      ["alpha", false, 10n, owner.id], ["beta", false, null, uploader.id], ["beta", false, null, owner.id],
      ["gamma", false, 5n, uploader.id], ["gamma", false, 20n, owner.id], ["delta", false, 10n, uploader.id],
    ]) {
      await file({ name, isFolder, size, uploadedById, ...shared });
    }
    await file({ name: "older", size: 1n, updatedAt: at(-60) });
  });

  /** The listing order as one SQL ORDER BY: folders first, the column, then the ID. */
  async function expectedOrder(sortBy, sortOrder) {
    const column = { name: 'f."name"', size: 'f."size"', updatedAt: 'f."updatedAt"', uploadedBy: 'u."displayName"' }[sortBy];
    const dir = sortOrder === "asc" ? "ASC" : "DESC";
    return (await app.prisma.$queryRawUnsafe(
      `SELECT f.id FROM "File" f JOIN "User" u ON u.id = f."uploadedById"
       WHERE f."parentId" = $1 AND f."trashedAt" IS NULL
       ORDER BY f."isFolder" DESC, ${column} ${dir}, f.id ${dir}`, folder.id)).map((r) => r.id);
  }

  for (const sortBy of ["name", "size", "updatedAt", "uploadedBy"]) {
    for (const sortOrder of ["asc", "desc"]) {
      test(`sorted by ${sortBy} ${sortOrder}: pages traverse equal values and null sizes exactly once`, async () => {
        await checkList({
          name: `files ${sortBy} ${sortOrder}`,
          url: (limit) => `/api/workspaces/${workspace.id}/files?parentId=${folder.id}&sortBy=${sortBy}&sortOrder=${sortOrder}&limit=${limit}`,
          expected: () => expectedOrder(sortBy, sortOrder),
          insertAt: async (cursor, ids) => {
            const row = await app.prisma.file.findUniqueOrThrow({ where: { id: cursor } });
            const copy = { name: row.name, isFolder: row.isFolder, size: row.size, uploadedById: row.uploadedById, updatedAt: row.updatedAt };
            return Promise.all(ids.map(async (id) => (await file({ id, ...copy })).id));
          },
          foreignCursor: async () => (await file({ name: "alpha", size: 10n }, otherFolder.id)).id,
        });
      });
    }
  }

  test("null sizes sort last ascending and first descending, within folders and files", async () => {
    for (const [order, nullsFirst] of [["asc", false], ["desc", true]]) {
      const ids = await walk(`/api/workspaces/${workspace.id}/files?parentId=${folder.id}&sortBy=size&sortOrder=${order}&limit=4`);
      const byId = new Map((await app.prisma.file.findMany({ where: { id: { in: ids } } })).map((f) => [f.id, f]));
      const rows = ids.map((id) => byId.get(id));
      const folders = rows.findLastIndex((f) => f.isFolder);
      assert.ok(rows.slice(0, folders + 1).every((f) => f.isFolder), `${order}: folders first`);
      for (const group of [rows.slice(0, folders + 1), rows.slice(folders + 1)]) {
        const nulls = group.map((f) => f.size === null);
        assert.ok(nulls.includes(true) && nulls.includes(false), "fixture has both");
        const boundary = nulls.indexOf(!nullsFirst);
        assert.ok(nulls.slice(boundary).every((isNull) => isNull === !nullsFirst), `${order}: null sizes ${nullsFirst ? "first" : "last"}`);
      }
    }
  });

  test("search pages use the same cursor rules", async () => {
    // Every file named like this is the owner's own.
    const searchOrder = (await app.prisma.$queryRaw`
      SELECT f.id FROM "File" f WHERE f."workspaceId" = ${workspace.id} AND f."trashedAt" IS NULL
      AND f."name" ILIKE '%lph%'
      ORDER BY f."isFolder" DESC, f."name" ASC, f.id ASC`).map((r) => r.id);
    assert.ok(searchOrder.length > 4);
    assert.deepEqual(await walk(`/api/workspaces/${workspace.id}/files?search=lph&limit=2`), searchOrder);
  });

  test("the page query applies LIMIT for every sort, including nullable size", async () => {
    for (const sortBy of ["name", "size", "updatedAt", "uploadedBy"]) {
      for (const sortOrder of ["asc", "desc"]) {
        const query = { parentId: folder.id, limit: 3, trashed: false, sortBy, sortOrder };
        const page = await files.listFiles(app.prisma, workspace.id, query, ctx());
        assertLimited(await sqlOf((db) => files.listFiles(db, workspace.id, { ...query, cursor: page.nextCursor }, ctx())), "File", 3);
      }
    }
  });
});

describe("channel members", () => {
  let channel, otherChannel;
  const members = [];

  before(async () => {
    channel = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: "crowded", createdById: owner.id } });
    otherChannel = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: "quiet", createdById: owner.id } });
    const suffix = crypto.randomUUID().slice(0, 8);
    // 104 members: more than the default page of 100; most joined at one instant.
    await app.prisma.user.createMany({ data: Array.from({ length: 104 }, (_, i) => ({
      email: `tiebreak-member-${i}-${suffix}@example.test`, displayName: `member${i}`,
    })) });
    members.push(...await app.prisma.user.findMany({ where: { email: { endsWith: `-${suffix}@example.test` } } }));
    await app.prisma.workspaceMember.createMany({ data: members.map((u) => ({ workspaceId: workspace.id, userId: u.id, role: "MEMBER" })) });
    await app.prisma.chatChannelMember.createMany({ data: members.map((u, i) => ({
      channelId: channel.id, userId: u.id, joinedAt: i < 4 ? at(i - 10) : at(0),
    })) });
    await app.prisma.chatChannelMember.create({ data: { channelId: otherChannel.id, userId: members[0].id } });
  });
  after(async () => {
    await app.prisma.user.deleteMany({ where: { id: { in: members.map((u) => u.id) } } });
  });

  test("without paging parameters the list stops at 100 members with a cursor", async () => {
    const res = await get(`/api/chat/${workspace.id}/channels/${channel.id}/members`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.length, 100);
    assert.equal(typeof res.json().nextCursor, "string");
    const rest = await get(`/api/chat/${workspace.id}/channels/${channel.id}/members?cursor=${res.json().nextCursor}`);
    assert.equal(rest.json().data.length, 4);
    assert.equal(rest.json().nextCursor, null);
    assert.equal((await get(`/api/chat/${workspace.id}/channels/${channel.id}/members?limit=201`)).statusCode, 400);
  });

  test("pages traverse equal join times exactly once, with inserts, cursors and scope", async () => {
    const joiners = [];
    await checkList({
      name: "channel members",
      url: (limit) => `/api/chat/${workspace.id}/channels/${channel.id}/members?limit=${limit}`,
      expected: async () => (await app.prisma.$queryRaw`
        SELECT id FROM "ChatChannelMember" WHERE "channelId" = ${channel.id} ORDER BY "joinedAt" ASC, id ASC`).map((r) => r.id),
      insertAt: async (cursor, ids) => {
        const row = await app.prisma.chatChannelMember.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => {
          const user = await app.prisma.user.create({ data: { email: `tiebreak-joiner-${crypto.randomUUID()}@example.test`, displayName: "joiner" } });
          joiners.push(user.id);
          return (await app.prisma.chatChannelMember.create({ data: { id, channelId: channel.id, userId: user.id, joinedAt: row.joinedAt } })).id;
        }));
      },
      foreignCursor: async () => (await app.prisma.chatChannelMember.findFirstOrThrow({ where: { channelId: otherChannel.id } })).id,
    });
    await app.prisma.user.deleteMany({ where: { id: { in: joiners } } });
  });

  test("the page query applies LIMIT", async () => {
    const first = await chat.listMembers(app.prisma, channel.id, undefined, 5);
    assertLimited(await sqlOf((db) => chat.listMembers(db, channel.id, first.nextCursor, 5)), "ChatChannelMember", 5);
  });
});
