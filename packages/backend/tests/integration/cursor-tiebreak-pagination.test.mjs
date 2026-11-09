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
import { recordQueries } from "./support/query-events.mjs";

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
/** Every statement `run` sent through the observer, including late query events. */
async function sqlOf(run) {
  return (await recordQueries(observer, run)).events;
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
  // Link rows are addressed as `link-<id>`. Neighbours stay in that form so
  // the response id, not only the stored id, sorts next to the cursor.
  const prefix = cursor.startsWith("link-") ? "link-" : "";
  const body = prefix ? cursor.slice(prefix.length) : cursor;
  assert.match(body, /^[a-z0-9]+$/);
  const tail = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let i = body.length - 1;
  while (i > 0 && body[i] === "0") i -= 1;
  const lower = body.slice(0, i) + alphabet[alphabet.indexOf(body[i]) - 1] + "z" + tail;
  return [prefix + lower, `${prefix}${body}0${tail}`];
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

describe("files shared by me", () => {
  const share = async (createdAt, sharedById = owner.id, id = undefined, sharedWithId = peer.id) => {
    const file = await app.prisma.file.create({ data: {
      workspaceId: workspace.id, name: "sent", uploadedById: sharedById, ownerId: sharedById, size: 1n,
    } });
    return app.prisma.fileShare.create({ data: {
      id, workspaceId: workspace.id, fileId: file.id, sharedById, sharedWithId, createdAt,
    } });
  };
  const linkFile = async (createdAt, extra = {}, id = undefined) => {
    const file = await app.prisma.file.create({ data: {
      workspaceId: workspace.id, name: "linked", uploadedById: owner.id, ownerId: owner.id, size: 2n,
    } });
    const link = await app.prisma.fileShareLink.create({ data: {
      workspaceId: workspace.id, createdById: owner.id, createdAt,
      token: extra.token ?? crypto.randomBytes(32).toString("base64url"),
      enabled: extra.enabled,
      passwordHash: extra.passwordHash,
      expiresAt: extra.expiresAt,
      files: { create: { id, fileId: file.id } },
    } });
    return app.prisma.fileShareLinkFile.findFirstOrThrow({ where: { shareLinkId: link.id } });
  };

  let hiddenId, trashedId;
  before(async () => {
    for (const seconds of [0, 0, 0, 0, -3, 4]) await share(at(seconds));
    for (const seconds of [0, 0, 6]) await linkFile(at(seconds));
    // One link, several files: the tie-break is the link-file id, not a second timestamp.
    const sharedLink = await app.prisma.fileShareLink.create({ data: {
      workspaceId: workspace.id, createdById: owner.id, createdAt: at(0),
      token: crypto.randomBytes(32).toString("base64url"),
      files: { create: [0, 1, 2].map(() => ({ file: { create: {
        workspaceId: workspace.id, name: "multi", uploadedById: owner.id, ownerId: owner.id, size: 3n,
      } } })) },
    } });
    assert.equal(await app.prisma.fileShareLinkFile.count({ where: { shareLinkId: sharedLink.id } }), 3);
    // These stay listed. Paging must not start hiding them.
    await linkFile(at(0), { enabled: false });
    await linkFile(at(0), { passwordHash: "not-checked-here" });
    await linkFile(at(1), { token: crypto.randomBytes(6).toString("base64url"), expiresAt: new Date("2020-01-01T00:00:00Z") });
    const hiddenFile = await app.prisma.file.create({ data: {
      workspaceId: workspace.id, name: "not-readable", uploadedById: uploader.id, ownerId: uploader.id, size: 1n,
    } });
    hiddenId = (await app.prisma.fileShare.create({ data: {
      workspaceId: workspace.id, fileId: hiddenFile.id, sharedById: owner.id, sharedWithId: peer.id, createdAt: at(0),
    } })).id;
    const trashed = await share(at(0));
    trashedId = trashed.id;
    await app.prisma.file.update({ where: { id: trashed.fileId }, data: { trashedAt: new Date() } });
  });

  /** Today's rows for this user: member shares and link files, including disabled, password and legacy links. */
  async function fullOrder() {
    return (await app.prisma.$queryRaw`
      SELECT id FROM (
        SELECT s.id, s."createdAt" AS at
        FROM "FileShare" s JOIN "File" f ON f.id = s."fileId"
        WHERE s."workspaceId" = ${workspace.id} AND s."sharedById" = ${owner.id}
          AND f."ownerId" = ${owner.id} AND f."teamFolderId" IS NULL AND f."trashedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "TeamFolder" t WHERE t."folderId" = f.id)
        UNION ALL
        SELECT 'link-' || lf.id, l."createdAt" AS at
        FROM "FileShareLinkFile" lf
        JOIN "FileShareLink" l ON l.id = lf."shareLinkId"
        JOIN "File" f ON f.id = lf."fileId"
        WHERE l."workspaceId" = ${workspace.id} AND l."createdById" = ${owner.id}
          AND f."ownerId" = ${owner.id} AND f."teamFolderId" IS NULL AND f."trashedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "TeamFolder" t WHERE t."folderId" = f.id)
      ) rows ORDER BY at DESC, id COLLATE "C" DESC`).map((r) => r.id);
  }

  test("pages traverse equal timestamps exactly once, with inserts, old cursors and scope", async () => {
    await checkList({
      name: "shared by me",
      url: (limit) => `/api/workspaces/${workspace.id}/files/shared-by-me?limit=${limit}`,
      expected: fullOrder,
      insertAt: async (cursor, ids) => {
        if (cursor.startsWith("link-")) {
          const row = await app.prisma.fileShareLinkFile.findUniqueOrThrow({ where: { id: cursor.slice("link-".length) } });
          const created = [];
          for (const responseId of ids) {
            const file = await app.prisma.file.create({ data: {
              workspaceId: workspace.id, name: "linked-insert", uploadedById: owner.id, ownerId: owner.id, size: 2n,
            } });
            await app.prisma.fileShareLinkFile.create({ data: {
              id: responseId.slice("link-".length), shareLinkId: row.shareLinkId, fileId: file.id,
            } });
            created.push(responseId);
          }
          return created;
        }
        const row = await app.prisma.fileShare.findUniqueOrThrow({ where: { id: cursor } });
        return Promise.all(ids.map(async (id) => (await share(row.createdAt, owner.id, id)).id));
      },
      foreignCursor: async () => (await share(at(0), peer.id)).id,
    });
    const seen = await walk(`/api/workspaces/${workspace.id}/files/shared-by-me?limit=5`);
    assert.ok(!seen.includes(hiddenId), "an unreadable source stays out of the list");
    assert.ok(!seen.includes(trashedId), "a trashed source stays out of the list");
    assert.ok(seen.some((id) => id.startsWith("link-")), "link rows stay in the walked list");
  });

  test("a later id at the cursor time is not repeated and an earlier one is not skipped", async () => {
    const first = await get(`/api/workspaces/${workspace.id}/files/shared-by-me?limit=2`);
    assert.equal(first.statusCode, 200, first.body);
    const cursor = first.json().nextCursor;
    assert.equal(typeof cursor, "string");
    const row = cursor.startsWith("link-")
      ? await app.prisma.fileShareLinkFile.findUniqueOrThrow({
          where: { id: cursor.slice("link-".length) }, include: { shareLink: true },
        })
      : await app.prisma.fileShare.findUniqueOrThrow({ where: { id: cursor } });
    const createdAt = cursor.startsWith("link-") ? row.shareLink.createdAt : row.createdAt;
    const [afterCursor, beforeCursor] = idsAround(cursor);
    if (cursor.startsWith("link-")) {
      for (const responseId of [afterCursor, beforeCursor]) {
        const file = await app.prisma.file.create({ data: {
          workspaceId: workspace.id, name: "cursor-insert", uploadedById: owner.id, ownerId: owner.id, size: 2n,
        } });
        await app.prisma.fileShareLinkFile.create({ data: {
          id: responseId.slice("link-".length), shareLinkId: row.shareLinkId, fileId: file.id,
        } });
      }
    } else {
      await share(createdAt, owner.id, afterCursor);
      await share(createdAt, owner.id, beforeCursor);
    }
    const next = await get(`/api/workspaces/${workspace.id}/files/shared-by-me?limit=100&cursor=${encodeURIComponent(cursor)}`);
    const ids = next.json().data.map((r) => r.id);
    assert.ok(ids.includes(afterCursor), "the id that sorts after the cursor was skipped");
    assert.ok(!ids.includes(beforeCursor), "the id that sorts before the cursor was repeated");
  });

  test("the page query applies LIMIT", async () => {
    const ctx = { userId: owner.id, workspaceId: workspace.id, workspaceRole: "MEMBER" };
    const [first] = (await shares.listSharedByMe(app.prisma, workspace.id, ctx, undefined, 2)).data;
    const events = await sqlOf((db) => shares.listSharedByMe(db, workspace.id, ctx, first.id, 2));
    assertLimited(events, "FileShare", 2);
    assertLimited(events, "FileShareLinkFile", 2);
    for (const table of ["FileShare", "FileShareLinkFile"]) {
      const pages = events.filter((e) => e.query.includes(`"${table}"`) && e.query.includes("ORDER BY"));
      assert.ok(pages.some((e) => e.query.includes('COLLATE "C"')), `${table} tie-break is byte order`);
    }
  });

  test("an omitted cursor returns the first page and every page size walks the full id set", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const bulk = await app.prisma.user.create({ data: {
      email: `tiebreak-bulk-${suffix}@example.test`, displayName: "bulk", emailVerified: true,
    } });
    const session = await startRefreshSession(app.prisma, bulk.id);
    familyIds.push(session.familyId);
    try {
      await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: bulk.id, role: "MEMBER" } });
      const signedIn = await app.inject({
        method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: session.refreshToken },
      });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const bulkToken = signedIn.json().data.accessToken;
      const memberCount = 140;
      const linkCount = 80;
      const owned = Array.from({ length: memberCount + linkCount }, (_, i) => ({
        id: `f${suffix}${i.toString(36).padStart(4, "0")}`,
        workspaceId: workspace.id, name: `bulk-${i}`, uploadedById: bulk.id, ownerId: bulk.id, size: 1n,
      }));
      await app.prisma.file.createMany({ data: owned });
      await app.prisma.fileShare.createMany({ data: owned.slice(0, memberCount).map((f, i) => ({
        id: `s${suffix}${i.toString(36).padStart(4, "0")}`,
        workspaceId: workspace.id, fileId: f.id, sharedById: bulk.id,
        sharedWithId: i % 2 === 0 ? owner.id : peer.id,
        createdAt: at(i % 7),
      })) });
      const links = Array.from({ length: 20 }, (_, i) => ({
        id: `l${suffix}${i.toString(36).padStart(4, "0")}`,
        workspaceId: workspace.id, createdById: bulk.id, createdAt: at(i % 7),
        token: i === 3 ? crypto.randomBytes(6).toString("base64url") : crypto.randomBytes(32).toString("base64url"),
        enabled: i !== 0,
        passwordHash: i === 1 ? "hash" : null,
        expiresAt: i === 2 ? new Date("2020-01-01T00:00:00Z") : null,
      }));
      await app.prisma.fileShareLink.createMany({ data: links });
      const keptLinkIds = [];
      await app.prisma.fileShareLinkFile.createMany({ data: owned.slice(memberCount).map((f, i) => {
        const id = `lf${suffix}${i.toString(36).padStart(4, "0")}`;
        if (i < 4) keptLinkIds.push(`link-${id}`);
        return { id, shareLinkId: links[i % links.length].id, fileId: f.id };
      }) });
      const hiddenFile = await app.prisma.file.create({ data: {
        workspaceId: workspace.id, name: "bulk-hidden", uploadedById: uploader.id, ownerId: uploader.id, size: 1n,
      } });
      const hidden = await app.prisma.fileShare.create({ data: {
        workspaceId: workspace.id, fileId: hiddenFile.id, sharedById: bulk.id, sharedWithId: owner.id,
      } });
      const trashedFile = await app.prisma.file.create({ data: {
        workspaceId: workspace.id, name: "bulk-trashed", uploadedById: bulk.id, ownerId: bulk.id, size: 1n, trashedAt: new Date(),
      } });
      const trashed = await app.prisma.fileShare.create({ data: {
        workspaceId: workspace.id, fileId: trashedFile.id, sharedById: bulk.id, sharedWithId: owner.id,
      } });

      const full = (await app.prisma.$queryRaw`
        SELECT id FROM (
          SELECT s.id, s."createdAt" AS at
          FROM "FileShare" s JOIN "File" f ON f.id = s."fileId"
          WHERE s."workspaceId" = ${workspace.id} AND s."sharedById" = ${bulk.id}
            AND f."ownerId" = ${bulk.id} AND f."trashedAt" IS NULL
          UNION ALL
          SELECT 'link-' || lf.id, l."createdAt" AS at
          FROM "FileShareLinkFile" lf
          JOIN "FileShareLink" l ON l.id = lf."shareLinkId"
          JOIN "File" f ON f.id = lf."fileId"
          WHERE l."workspaceId" = ${workspace.id} AND l."createdById" = ${bulk.id}
            AND f."ownerId" = ${bulk.id} AND f."trashedAt" IS NULL
        ) rows ORDER BY at DESC, id COLLATE "C" DESC`).map((r) => r.id);
      assert.ok(full.length >= 200, `fixture has ${full.length} shares`);
      assert.ok(keptLinkIds.every((id) => full.includes(id)), "disabled, password, expired and legacy links stay listed");
      assert.ok(!full.includes(hidden.id) && !full.includes(trashed.id));

      const call = (url) => app.inject({
        method: "GET", url,
        headers: { authorization: `Bearer ${bulkToken}` },
        remoteAddress: `10.84.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
      });
      const first = await call(`/api/workspaces/${workspace.id}/files/shared-by-me`);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().data.length, 50, `first page of unpaged ${full.length}`);
      assert.equal(typeof first.json().nextCursor, "string");
      console.log(`shared-by-me paging: unpaged=${full.length} first=${first.json().data.length}`);

      async function walkLimit(limit) {
        const seen = [];
        let cursor, pages = 0;
        do {
          const url = `/api/workspaces/${workspace.id}/files/shared-by-me${limit ? `?limit=${limit}` : ""}`;
          const res = await call(withCursor(url, cursor));
          assert.equal(res.statusCode, 200, res.body);
          const body = res.json();
          seen.push(...body.data.map((row) => row.id));
          cursor = body.nextCursor ?? undefined;
          pages += 1;
          assert.ok(pages < 500, "pagination must terminate");
        } while (cursor);
        return seen;
      }
      for (const limit of [undefined, 17, 50, 100]) {
        const seen = await walkLimit(limit);
        assert.equal(new Set(seen).size, seen.length, `limit ${limit ?? "default"} repeated a row`);
        assert.deepEqual(seen, full, `limit ${limit ?? "default"} does not match the full list`);
      }
      assert.equal((await call(`/api/workspaces/${workspace.id}/files/shared-by-me?limit=101`)).statusCode, 400);
    } finally {
      await app.prisma.user.delete({ where: { id: bulk.id } });
    }
  });
});
