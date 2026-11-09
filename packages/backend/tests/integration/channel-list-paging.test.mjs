// Channel and DM lists used to return every row. A walk at page size 1 and at
// the default must return the same ids as the full visible list, in name then
// id order, and must leave out a channel or DM the caller cannot see.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { CHAT_LIST_PAGE_DEFAULT } from "@pm/shared";
import { recordQueries } from "./support/query-events.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "channel-list-paging-disposable-jwt",
  COOKIE_SECRET: "channel-list-paging-disposable-cookie",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-channel-list-"));
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { PrismaClient } = await import("@prisma/client");
const chat = await import("../../src/modules/chat/chat.service.js");

const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({
  datasourceUrl: observerUrl.toString(),
  log: [{ level: "query", emit: "event" }],
});

const T = new Date("2026-04-01T00:00:00.000Z");
const later = (seconds) => new Date(T.getTime() + seconds * 1000);
const pad = (n) => String(n).padStart(2, "0");

let app;
let requests = 0;
const users = {};
let home;
let other;
let suffix;
let hiddenPrivate;
let hiddenDm;
let zzz;

function get(url) {
  requests += 1;
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${users.me.token}` },
    remoteAddress: `10.91.${Math.floor(requests / 200) % 200}.${(requests % 200) + 1}`,
  });
}

async function ok(url) {
  const res = await get(url);
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.json();
}

function withPaging(url, limit, cursor) {
  const params = new URLSearchParams();
  if (limit != null) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}

async function walk(url, limit) {
  const seen = [];
  let cursor;
  const pageSize = limit ?? CHAT_LIST_PAGE_DEFAULT;
  for (let pages = 0; pages < 500; pages += 1) {
    const body = await ok(withPaging(url, limit, cursor));
    assert.ok(Array.isArray(body.data));
    if (body.nextCursor === null) assert.ok(body.data.length <= pageSize);
    else {
      assert.equal(body.data.length, pageSize);
      assert.equal(body.nextCursor, body.data.at(-1).id);
    }
    for (const row of body.data) assert.equal(seen.includes(row.id), false, row.id);
    seen.push(...body.data.map((row) => row.id));
    if (!body.nextCursor) return seen;
    cursor = body.nextCursor;
  }
  assert.fail("pagination did not end");
}

function assertLimited(events, limit) {
  const pages = events.filter((event) => /ORDER BY[\s\S]*"name"[\s\S]*NULLS LAST/i.test(event.query));
  assert.ok(pages.length > 0, events.map((event) => event.query).join("\n---\n"));
  for (const page of pages) {
    const match = /LIMIT \$(\d+)/.exec(page.query);
    assert.ok(match, page.query);
    assert.equal(JSON.parse(page.params)[Number(match[1]) - 1], limit + 1);
  }
}

async function orderedIds(dmsOnly) {
  const rows = await app.prisma.$queryRaw`
    SELECT c.id, c."type"::text AS type,
           EXISTS (
             SELECT 1 FROM "ChatChannelMember" m
             WHERE m."channelId" = c.id AND m."userId" = ${users.me.id}
           ) AS member
    FROM "ChatChannel" c
    WHERE c."workspaceId" = ${home.id}
    ORDER BY c."name" ASC NULLS LAST, c."id" ASC`;
  return rows
    .filter((row) => (dmsOnly
      ? row.type === "DM" && row.member
      : row.type === "PUBLIC" || row.member))
    .map((row) => row.id);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  suffix = crypto.randomUUID().slice(0, 8);
  for (const name of ["me", "peer", "outsider", "stranger"]) {
    const user = await app.prisma.user.create({
      data: { email: `channels-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    user.token = signAccessToken({ sub: user.id, email: user.email });
    users[name] = user;
  }
  home = await app.prisma.workspace.create({
    data: {
      name: "Channel paging",
      slug: `channel-paging-${suffix}`,
      members: {
        create: ["me", "peer", "outsider"].map((name) => ({ userId: users[name].id, role: "MEMBER" })),
      },
    },
  });
  other = await app.prisma.workspace.create({
    data: {
      name: "Channel other",
      slug: `channel-other-${suffix}`,
      members: { create: { userId: users.stranger.id, role: "ADMIN" } },
    },
  });

  const channels = [];
  const memberships = [];
  const add = (id, type, name, workspaceId = home.id, creator = users.me.id) => {
    channels.push({
      id, workspaceId, name, type, createdById: creator, createdAt: T, updatedAt: T,
    });
  };
  const join = (channelId, userId, lastReadAt = T) => {
    memberships.push({ channelId, userId, joinedAt: T, lastReadAt });
  };

  for (let i = 0; i < 15; i += 1) add(`aaa-${suffix}-${pad(i)}`, "PUBLIC", "aaa");
  join(`aaa-${suffix}-00`, users.me.id);
  for (let i = 0; i < 40; i += 1) add(`mmm-${suffix}-${pad(i)}`, "PUBLIC", "mmm");
  for (let i = 0; i < 5; i += 1) {
    const id = `priv-${suffix}-${i}`;
    add(id, "PRIVATE", "priv");
    join(id, users.me.id);
  }
  hiddenPrivate = `hidden-private-${suffix}`;
  add(hiddenPrivate, "PRIVATE", "hidden", home.id, users.peer.id);
  join(hiddenPrivate, users.peer.id);
  zzz = `zzz-${suffix}`;
  add(zzz, "PUBLIC", "zzz");
  join(zzz, users.me.id);
  add(`foreign-public-${suffix}`, "PUBLIC", "foreign", other.id, users.stranger.id);

  for (let i = 0; i < 45; i += 1) {
    const id = `dm-n-${suffix}-${pad(i)}`;
    add(id, "DM", null);
    join(id, users.me.id);
    join(id, users.peer.id);
  }
  for (let i = 0; i < 10; i += 1) {
    const id = `dm-p-${suffix}-${i}`;
    add(id, "DM", "pair");
    join(id, users.me.id);
    join(id, users.peer.id);
  }
  hiddenDm = `hidden-dm-${suffix}`;
  add(hiddenDm, "DM", null, home.id, users.peer.id);
  join(hiddenDm, users.peer.id);
  join(hiddenDm, users.outsider.id);
  add(`foreign-dm-${suffix}`, "DM", null, other.id, users.stranger.id);
  join(`foreign-dm-${suffix}`, users.stranger.id);

  await app.prisma.chatChannel.createMany({ data: channels });
  await app.prisma.chatChannelMember.createMany({ data: memberships });
  await app.prisma.chatMessage.createMany({
    data: [
      { channelId: zzz, userId: users.peer.id, content: "unread", createdAt: later(60) },
      { channelId: zzz, userId: users.me.id, content: "mine", createdAt: later(120) },
      { channelId: zzz, userId: users.peer.id, content: "gone", createdAt: later(180), deletedAt: later(190) },
    ],
  });
});

after(async () => {
  if (home) await app.prisma.workspace.delete({ where: { id: home.id } }).catch(() => {});
  if (other) await app.prisma.workspace.delete({ where: { id: other.id } }).catch(() => {});
  const ids = Object.values(users).map((user) => user.id);
  if (ids.length) await app.prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  await observer.$disconnect();
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

test("walking either list at page size 1 and at the default returns today's visible ids", async () => {
  const channels = await orderedIds(false);
  const dms = await orderedIds(true);
  assert.ok(channels.filter((id) => !id.startsWith("dm-")).length >= 50, channels.length);
  assert.ok(dms.length >= 20, dms.length);
  assert.ok(channels.length > CHAT_LIST_PAGE_DEFAULT);
  assert.ok(dms.length > CHAT_LIST_PAGE_DEFAULT);

  const channelUrl = `/api/chat/${home.id}/channels`;
  const dmUrl = `/api/chat/${home.id}/dms`;
  assert.deepEqual(await walk(channelUrl, 1), channels);
  assert.deepEqual(await walk(channelUrl), channels);
  assert.deepEqual(await walk(dmUrl, 1), dms);
  assert.deepEqual(await walk(dmUrl), dms);

  const first = await ok(channelUrl);
  assert.equal(first.data.length, CHAT_LIST_PAGE_DEFAULT);
  assert.deepEqual(first.data.map((row) => row.id), channels.slice(0, CHAT_LIST_PAGE_DEFAULT));
  assert.notEqual(first.nextCursor, null);
  const firstDm = await ok(dmUrl);
  assert.equal(firstDm.data.length, CHAT_LIST_PAGE_DEFAULT);
  assert.notEqual(firstDm.data.length, dms.length);

  assert.equal(channels.includes(hiddenPrivate), false);
  assert.equal(channels.includes(hiddenDm), false);
  assert.equal(channels.includes(`foreign-public-${suffix}`), false);
  assert.equal(channels.includes(`mmm-${suffix}-00`), true);
  assert.equal(dms.includes(hiddenDm), false);
  assert.equal(dms.includes(`aaa-${suffix}-00`), false);
  assert.equal(dms.every((id) => id.startsWith("dm-")), true);

  const sample = first.data.find((row) => row.id === `aaa-${suffix}-00`);
  assert.equal(sample.name, "aaa");
  assert.equal(sample._count.members, 1);
  assert.equal(sample.members.length, 1);
  assert.equal(sample.members[0].userId, users.me.id);
  const direct = firstDm.data.find((row) => row.name === "pair");
  assert.equal(direct._count.members, 2);
  assert.equal(direct.members.length, 2);
  assert.deepEqual(Object.keys(direct.members[0].user).sort(), ["avatarUrl", "displayName", "id"]);

  for (const [url, cursor] of [[channelUrl, hiddenPrivate], [channelUrl, hiddenDm], [dmUrl, `aaa-${suffix}-00`], [dmUrl, "missing"]]) {
    const body = await ok(withPaging(url, 1, cursor));
    assert.deepEqual(body.data, []);
    assert.equal(body.nextCursor, null);
  }
  for (const cursor of ["a\uD800", "a\u0000b", "x".repeat(201)]) {
    const rejected = await chat.listChannels(app.prisma, home.id, users.me.id, cursor, 1);
    assert.deepEqual(rejected.data, [], cursor);
    assert.equal(rejected.nextCursor, null);
    const rejectedDm = await chat.listDms(app.prisma, home.id, users.me.id, cursor, 1);
    assert.deepEqual(rejectedDm.data, [], cursor);
  }
  assert.equal((await get(`${channelUrl}?limit=0`)).statusCode, 400);
  assert.equal((await get(`${channelUrl}?limit=101`)).statusCode, 400);
  assert.equal((await get(`${dmUrl}?limit=101`)).statusCode, 400);

  const listed = await recordQueries(observer, (db) => chat.listChannels(db, home.id, users.me.id, undefined, 1));
  const listedDms = await recordQueries(observer, (db) => chat.listDms(db, home.id, users.me.id, undefined, 1));
  assertLimited(listed.events, 1);
  assertLimited(listedDms.events, 1);
  assert.equal(listed.events.some((event) => event.query.includes('msg."userId"')), false);

  const unread = await recordQueries(observer, (db) => chat.getUnreadCounts(db, home.id, users.me.id));
  assert.deepEqual(unread.result.map((row) => ({ channelId: row.channelId, count: Number(row.count) })), [
    { channelId: zzz, count: 1 },
  ]);
  const unreadSql = unread.events.map((event) => event.query).join("\n");
  assert.match(unreadSql, /LATERAL/);
  assert.match(unreadSql, /msg\."userId" <>/);
  assert.match(unreadSql, /deletedAt/);
  const httpUnread = await ok(`/api/chat/${home.id}/unread`);
  assert.equal(Number(httpUnread.data.find((row) => row.channelId === zzz).count), 1);
});

function planNodes(plan) {
  const nodes = [];
  const walk = (node) => {
    if (!node) return;
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan["QUERY PLAN"][0].Plan);
  return nodes;
}

test("channel and DM pages use the name order indexes", async () => {
  const bulk = [];
  const memberships = [];
  for (let i = 0; i < 4000; i += 1) {
    const id = `bulk-${suffix}-${String(i).padStart(5, "0")}`;
    bulk.push({
      id,
      workspaceId: other.id,
      name: `n-${String(i).padStart(5, "0")}`,
      type: i % 2 === 0 ? "PUBLIC" : "PRIVATE",
      createdById: users.stranger.id,
      createdAt: T,
      updatedAt: T,
    });
    if (i % 2 === 1 && i < 200) memberships.push({
      channelId: id, userId: users.stranger.id, joinedAt: T, lastReadAt: T,
    });
  }
  for (let i = 0; i < 2000; i += 1) {
    const id = `bulk-dm-${suffix}-${String(i).padStart(5, "0")}`;
    bulk.push({
      id,
      workspaceId: other.id,
      name: i < 1000 ? null : "same-dm",
      type: "DM",
      createdById: users.stranger.id,
      createdAt: T,
      updatedAt: T,
    });
    if (i % 3 === 0) memberships.push({
      channelId: id, userId: users.stranger.id, joinedAt: T, lastReadAt: T,
    });
  }
  for (let offset = 0; offset < bulk.length; offset += 1000) {
    await app.prisma.chatChannel.createMany({ data: bulk.slice(offset, offset + 1000) });
  }
  await app.prisma.chatChannelMember.createMany({ data: memberships });
  await app.prisma.$executeRawUnsafe('ANALYZE "ChatChannel", "ChatChannelMember"');

  const first = await recordQueries(observer, (db) => chat.listChannels(db, other.id, users.stranger.id, undefined, 50));
  const cursor = first.result.nextCursor;
  const later = await recordQueries(observer, (db) => chat.listChannels(db, other.id, users.stranger.id, cursor, 50));
  const dms = await recordQueries(observer, (db) => chat.listDms(db, other.id, users.stranger.id, undefined, 20));
  const plans = [];
  for (const recorded of [first, later, dms]) {
    const page = recorded.events.find((event) => /ORDER BY[\s\S]*"name"[\s\S]*NULLS LAST/i.test(event.query));
    assert.ok(page, recorded.events.map((event) => event.query).join("\n---\n"));
    const explained = await app.prisma.$queryRawUnsafe(
      `EXPLAIN (FORMAT JSON) ${page.query}`,
      ...JSON.parse(page.params),
    );
    plans.push(explained[0]);
  }
  const described = plans.map((plan) => planNodes(plan).map((node) => `${node["Node Type"]}:${node["Index Name"] ?? ""}`).join(" > "));
  for (const description of described) {
    assert.equal(description.includes("Sort"), false, description);
    assert.match(description, /^Limit:/, description);
  }
  assert.match(described[0], /ChatChannel_workspaceId_name_id_idx/);
  assert.match(described[1], /ChatChannel_workspaceId_name_id_idx/);
  assert.match(described[2], /ChatChannel_workspaceId_type_name_id_idx/);
});

test("a row inserted beside an equal name is not skipped or repeated", async () => {
  const url = `/api/chat/${home.id}/channels`;
  const first = await ok(withPaging(url, 1));
  assert.equal(first.data[0].id, `aaa-${suffix}-00`);
  const before = `aaa-${suffix}-0`;
  const between = `aaa-${suffix}-00a`;
  await app.prisma.chatChannel.createMany({
    data: [before, between].map((id) => ({
      id, workspaceId: home.id, name: "aaa", type: "PUBLIC", createdById: users.me.id, createdAt: T, updatedAt: T,
    })),
  });
  const next = await ok(withPaging(url, 1, first.nextCursor));
  assert.equal(next.data[0].id, between);
  const again = await walk(url, 1);
  assert.deepEqual(again, await orderedIds(false));
  assert.equal(again.filter((id) => id === first.data[0].id).length, 1);
  assert.ok(again.includes(before));
  assert.ok(again.includes(between));
});
