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
  JWT_SECRET: "search-pagination-disposable-jwt",
  COOKIE_SECRET: "search-pagination-disposable-cookie",
});
const storage = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-search-pagination-"),
);
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { searchMessages } =
  await import("../../src/modules/chat/chat.service.js");
const { startRefreshSession } =
  await import("../../src/modules/auth/refresh-sessions.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { PrismaClient } = await import("@prisma/client");
const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
// Completion ownership does not filter the SQL counted by the page assertions.
const messageSelect = (event) =>
  event.query.startsWith("SELECT ") &&
  event.query.includes('FROM "public"."ChatMessage"');
function deferredQuery() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
class QueryObservationTimeout extends Error {}
async function observeSearch(context, producer, options = {}) {
  const observer = new PrismaClient({
    datasourceUrl: observerUrl.toString(),
    log: [{ level: "query", emit: "event" }],
  });
  const queries = [], delivered = [];
  const completion = deferredQuery(), held = deferredQuery();
  let heldEvent, released = false, closed = false, operation, primaryError;
  function matches(event) {
    const params = JSON.parse(event.params);
    return messageSelect(event) && event.query.includes("ORDER BY") &&
      params.includes(context.cursor) && params.includes("%needle%") &&
      params.includes(context.mode === "channel" ? channels.public.id : workspaces[0].id);
  }
  function deliver(event) {
    delivered.push(event);
    if (matches(event)) completion.resolve(event);
  }
  observer.$on("query", (event) => {
    assert.equal(closed, false, "Native query event arrived after observer disconnect");
    queries.push(event); // Count every native ChatMessage SELECT, including cursor reads.
    if (options.hold && matches(event) && !heldEvent) {
      heldEvent = event;
      held.resolve(event);
    } else deliver(event);
  });
  const timer = setTimeout(() => {
    const error = new QueryObservationTimeout("Search page query not observed within 1000ms");
    completion.reject(error);
    held.reject(error);
  }, 1000);
  if (!options.hold) held.resolve(undefined);
  const release = () => {
    if (heldEvent && !released) { released = true; deliver(heldEvent); }
  };
  // Both event handlers exist before the real producer starts. Preserve its error first.
  operation = Promise.resolve().then(() => producer(observer));
  void operation.catch(() => {});
  try {
    if (options.consume)
      return await options.consume({ operation, completion: completion.promise,
        held: held.promise, release, queries, delivered });
    const data = await operation;
    await completion.promise;
    return { data, queries };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    clearTimeout(timer);
    const disposed = new Error("Owned search observation disposed");
    completion.reject(disposed);
    held.reject(disposed);
    await Promise.allSettled([operation, completion.promise, held.promise]);
    try { await observer.$disconnect(); }
    catch (error) { if (!primaryError) throw error; }
    finally { closed = true; }
  }
}
function searchProducer(mode, cursor = ordinary[30].id, channelId) {
  return (observer) => searchMessages(observer, workspaces[0].id, users[0].id,
    "needle", channelId ?? (mode === "channel" ? channels.public.id : undefined), cursor, 20);
}
const users = [],
  workspaces = [],
  families = [],
  ordinary = [],
  ties = [],
  privateRows = [];
let app,
  channels,
  other,
  hidden,
  foreign,
  nonmatching,
  requests = 0;
function request(method, url, actor = 0, payload) {
  requests++;
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${users[actor].token}` },
    ...(payload === undefined ? {} : { payload }),
    remoteAddress: `10.64.${Math.floor(requests / 250)}.${(requests % 250) + 1}`,
  });
}
function url(
  mode,
  cursor,
  limit = 20,
  q = "needle",
  channelId = channels.public.id,
) {
  return `/api/chat/${workspaces[0].id}/${mode === "channel" ? `channels/${channelId}/` : ""}messages/search?q=${encodeURIComponent(q)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
}
const compare = (a, b) =>
  b.createdAt.getTime() - a.createdAt.getTime() ||
  (a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
async function walk(mode, limit) {
  const expected = [
      ...ordinary,
      ...ties,
      ...(mode === "global" ? privateRows : []),
    ]
      .filter((row) => !row.deletedAt)
      .sort(compare)
      .map((row) => row.id),
    seen = [];
  let cursor,
    pages = 0;
  do {
    assert.ok(pages++ <= expected.length, "Traversal terminates");
    const response = await request("GET", url(mode, cursor, limit));
    assert.equal(response.statusCode, 200, response.body);
    const page = response.json();
    assert.deepEqual(
      page.data.map((row) => row.id),
      expected.slice(seen.length, seen.length + limit),
    );
    seen.push(...page.data.map((row) => row.id));
    const next = seen.length < expected.length ? seen.at(-1) : undefined;
    assert.equal(page.nextCursor, next);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, expected.length);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 12);
  for (let i = 0; i < 2; i++) {
    const user = await app.prisma.user.create({
      data: {
        email: `search-page-${i}-${suffix}@example.test`,
        displayName: `Reader ${i}`,
        emailVerified: true,
      },
    });
    const session = await startRefreshSession(app.prisma, user.id);
    families.push(session.familyId);
    users.push({
      ...user,
      token: signAccessToken({
        sub: user.id,
        email: user.email,
        sid: session.familyId,
      }),
    });
  }
  workspaces.push(
    await app.prisma.workspace.create({
      data: {
        name: "Search pages",
        slug: `search-pages-${suffix}`,
        members: {
          create: [
            { userId: users[0].id, role: "MEMBER" },
            { userId: users[1].id, role: "ADMIN" },
          ],
        },
      },
    }),
  );
  workspaces.push(
    await app.prisma.workspace.create({
      data: {
        name: "Foreign search",
        slug: `search-other-${suffix}`,
        members: { create: { userId: users[1].id, role: "ADMIN" } },
      },
    }),
  );
  channels = {};
  for (const [key, type, wid, members] of [
    ["public", "PUBLIC", 0, [0, 1]],
    ["private", "PRIVATE", 0, [0, 1]],
    ["other", "PUBLIC", 0, [1]],
    ["hidden", "PRIVATE", 0, [1]],
    ["foreign", "PUBLIC", 1, [1]],
  ]) {
    channels[key] = await app.prisma.chatChannel.create({
      data: {
        workspaceId: workspaces[wid].id,
        name: key,
        type,
        createdById: users[1].id,
        members: { create: members.map((i) => ({ userId: users[i].id })) },
      },
    });
  }
  for (let i = 0; i < 64; i++)
    ordinary.push({
      id: `search_h_${String(i).padStart(2, "0")}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      content: i === 1 ? "NeEdLe reply" : `needle main ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      ...(i === 1 ? { parentId: `search_h_00_${suffix}` } : {}),
      ...(i === 42 ? { deletedAt: new Date() } : {}),
      ...(i === 0
        ? {
            clientMessageId: `search-key-${suffix}`,
            clientMessageHash: "a".repeat(64),
          }
        : {}),
    });
  await app.prisma.chatMessage.create({ data: ordinary[0] });
  await app.prisma.chatMessage.createMany({ data: ordinary.slice(1) });
  for (const rank of [4, 1, 6, 0, 5, 2, 3])
    ties.push({
      id: `search_tie_${rank}_${suffix}`,
      channelId: channels.public.id,
      userId: users[0].id,
      content: `needle tied ${rank}`,
      createdAt: new Date("2026-06-01"),
    });
  for (let i = 0; i < 8; i++)
    privateRows.push({
      id: `search_private_${i}_${suffix}`,
      channelId: channels.private.id,
      userId: users[0].id,
      content: `needle private ${i}`,
      createdAt: new Date(Date.UTC(2026, 1, 1) + i * 1000),
    });
  await app.prisma.chatMessage.createMany({ data: [...ties, ...privateRows] });
  for (const key of ["other", "hidden", "foreign"]) {
    const row = await app.prisma.chatMessage.create({
      data: {
        channelId: channels[key].id,
        userId: users[1].id,
        content: `needle ${key} marker`,
        createdAt: new Date("2026-07-01"),
      },
    });
    if (key === "other") other = row;
    else if (key === "hidden") hidden = row;
    else foreign = row;
  }
  nonmatching = await app.prisma.chatMessage.create({
    data: {
      channelId: channels.public.id,
      userId: users[0].id,
      content: "different content",
      createdAt: new Date("2026-08-01"),
    },
  });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: workspaces.map((w) => w.id) } },
      });
      await app.prisma.rotatedRefreshToken.deleteMany({
        where: { familyId: { in: families } },
      });
      await app.prisma.user.deleteMany({
        where: { id: { in: users.map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

for (const mode of ["global", "channel"])
  for (const limit of [1, 2, 20, 50])
    test(`${mode} search traverses every ordinary and tied match at limit ${limit}`, () =>
      walk(mode, limit));

for (const mode of ["global", "channel"])
  test(`${mode} service emits a bounded page in one message SELECT with HTTP parity`, async () => {
    const { data, queries } = await observeSearch(
      { mode, cursor: ordinary[30].id }, searchProducer(mode),
    );
    const selects = queries.filter(
      (event) =>
        event.query.startsWith("SELECT ") &&
        event.query.includes('FROM "public"."ChatMessage"'),
    );
    assert.equal(selects.length, 1, "No separate mutable cursor read");
    assert.match(selects[0].query, /LIMIT \$\d+/);
    assert.ok(JSON.parse(selects[0].params).includes(21));
    const response = await request("GET", url(mode, ordinary[30].id));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), JSON.parse(JSON.stringify(data)));
  });

test("nonmatching, deleted, hidden, foreign and missing cursors remain empty without GET writes", async () => {
  const where = { channelId: { in: Object.values(channels).map((c) => c.id) } },
    beforeRows = await app.prisma.chatMessage.findMany({
      where,
      orderBy: { id: "asc" },
    });
  for (const mode of ["global", "channel"])
    for (const cursor of [
      nonmatching.id,
      ordinary[42].id,
      hidden.id,
      foreign.id,
      "missing-search-cursor",
      ...(mode === "global" ? [other.id] : [privateRows[4].id]),
    ]) {
      const response = await request("GET", url(mode, cursor));
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { data: [] });
    }
  assert.deepEqual(
    await app.prisma.chatMessage.findMany({ where, orderBy: { id: "asc" } }),
    beforeRows,
  );
  const global = await request(
    "GET",
    url("global", undefined, 20, "needle other marker"),
  );
  assert.deepEqual(global.json(), { data: [] });
  const scoped = await request(
    "GET",
    url("channel", undefined, 20, "needle", channels.other.id),
  );
  assert.equal(scoped.statusCode, 200, scoped.body);
  assert.deepEqual(
    scoped.json().data.map((row) => row.id),
    [other.id],
  );
  assert.equal(
    (
      await request(
        "GET",
        url("channel", undefined, 20, "needle", channels.hidden.id),
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request(
        "GET",
        url("channel", undefined, 20, "needle", channels.foreign.id),
      )
    ).statusCode,
    404,
  );
});

test("default and maximum pages, reply/case/DTO/end and validation contracts stay intact", async () => {
  for (const mode of ["global", "channel"]) {
    const defaultPage = await request(
      "GET",
      url(mode).replace("&limit=20", ""),
    );
    assert.equal(defaultPage.statusCode, 200, defaultPage.body);
    assert.equal(defaultPage.json().data.length, 20);
    const max = await request("GET", url(mode, undefined, 50));
    assert.equal(max.statusCode, 200, max.body);
    assert.equal(max.json().data.length, 50);
    for (const [q, id] of [
      ["NeEdLe reply", ordinary[1].id],
      ["needle main 0", ordinary[0].id],
    ]) {
      const one = await request("GET", url(mode, undefined, 20, q));
      assert.equal(one.statusCode, 200, one.body);
      assert.deepEqual(
        one.json().data.map((row) => row.id),
        [id],
      );
      const row = one.json().data[0];
      assert.ok(row.user && row.channel);
      assert.ok(!("clientMessageId" in row) && !("clientMessageHash" in row));
    }
    const end = await request("GET", url(mode, ordinary[0].id));
    assert.deepEqual(end.json(), { data: [] });
    const none = await request(
      "GET",
      url(mode, undefined, 20, "no matching phrase"),
    );
    assert.deepEqual(none.json(), { data: [] });
    for (const limit of [0, 51, "1.5", "bad", "1&limit=2"])
      assert.equal(
        (await request("GET", url(mode, undefined, limit))).statusCode,
        400,
      );
    assert.equal(
      (await request("GET", url(mode, undefined, 20, "n"))).statusCode,
      200,
    );
    for (const q of ["", "x".repeat(201)])
      assert.equal(
        (await request("GET", url(mode, undefined, 20, q))).statusCode,
        400,
      );
  }
});

test("ordinary edits, soft deletion and membership changes keep cursor eligibility in the search", async () => {
  for (const [kind, row] of [
    ["edit", ordinary[10]],
    ["delete", ordinary[11]],
  ]) {
    const beforePage = await request("GET", url("channel", row.id, 2));
    assert.equal(beforePage.statusCode, 200, beforePage.body);
    assert.equal(beforePage.json().data.length, 2);
    const writer = await request(
      kind === "edit" ? "PATCH" : "DELETE",
      `/api/chat/${workspaces[0].id}/messages/${row.id}`,
      0,
      kind === "edit" ? { content: "changed owned content" } : undefined,
    );
    assert.equal(writer.statusCode, kind === "edit" ? 200 : 204, writer.body);
    for (const mode of ["global", "channel"]) {
      const page = await request("GET", url(mode, row.id));
      assert.equal(page.statusCode, 200, page.body);
      assert.deepEqual(page.json(), { data: [] });
    }
    if (kind === "edit")
      assert.equal(
        (
          await request(
            "PATCH",
            `/api/chat/${workspaces[0].id}/messages/${row.id}`,
            0,
            { content: row.content },
          )
        ).statusCode,
        200,
      );
    else
      await app.prisma.chatMessage.update({
        where: { id: row.id },
        data: { deletedAt: null },
      });
  }
  const memberPath = `/api/chat/${workspaces[0].id}/channels/${channels.private.id}/members`;
  const before = await request(
    "GET",
    url("channel", privateRows[4].id, 2, "needle", channels.private.id),
  );
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(
    (await request("DELETE", `${memberPath}/${users[0].id}`, 1)).statusCode,
    204,
  );
  assert.equal(
    (
      await request(
        "GET",
        url("channel", privateRows[4].id, 2, "needle", channels.private.id),
      )
    ).statusCode,
    403,
  );
  const global = await request(
    "GET",
    url("global", privateRows[4].id, 2, "needle private"),
  );
  assert.equal(global.statusCode, 200, global.body);
  assert.deepEqual(global.json(), { data: [] });
  assert.equal(
    (await request("POST", memberPath, 1, { userIds: [users[0].id] }))
      .statusCode,
    204,
  );
  const restored = await request(
    "GET",
    url("channel", privateRows[4].id, 2, "needle", channels.private.id),
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json(), before.json());
});


test("fresh search observer settles the exact held event without a prior mode or cursor", async () => {
  const prior = await observeSearch({ mode: "global", cursor: ordinary[31].id },
    searchProducer("global", ordinary[31].id));
  const stale = prior.queries.find(messageSelect);
  assert.ok(stale, "Own prior native event prerequisite");
  const { queries } = await observeSearch({ mode: "channel", cursor: ordinary[30].id },
    searchProducer("channel"), { hold: true, consume: async (capture) => {
      const data = await capture.operation;
      const event = await capture.held;
      assert.equal(capture.delivered.filter(messageSelect).length, 0,
        "Old immediate consumer can miss the genuinely held native event");
      assert.equal(capture.queries.includes(stale), false, "Prior client cannot contaminate this capture");
      assert.equal(capture.queries.includes(event), true, "The held event is genuinely native");
      capture.release();
      assert.equal(await capture.completion, event, "Release the identical owned event");
      return { data, queries: capture.queries };
    } });
  assert.equal(queries.filter(messageSelect).length, 1);
  assert.ok(JSON.parse(queries.find(messageSelect).params).includes(21));
});

test("search observation retains extra actual cursor SELECTs before and after the page", async () => {
  for (const order of ["before", "after"]) {
    const { queries } = await observeSearch({ mode: "channel", cursor: ordinary[30].id },
      async (observer) => {
        if (order === "before") await observer.chatMessage.findUnique({ where: { id: ordinary[30].id } });
        const data = await searchProducer("channel")(observer);
        if (order === "after") await observer.chatMessage.findUnique({ where: { id: ordinary[30].id } });
        return data;
      });
    assert.equal(queries.filter(messageSelect).length, 2, `${order}: every message SELECT remains visible`);
    assert.throws(() => assert.equal(queries.filter(messageSelect).length, 1,
      "No separate mutable cursor read"), assert.AssertionError);
  }
});

test("search observation preserves the real producer error before missing completion", async () => {
  await assert.rejects(observeSearch({ mode: "channel", cursor: ordinary[30].id },
    searchProducer("channel", ordinary[30].id, "owned-nonexistent-search-channel")),
    (error) => error.name === "NotFoundError" && error.message === "Channel not found");
});

test("search observation rejects absent consumer delivery without stale fallback", async () => {
  await observeSearch({ mode: "channel", cursor: ordinary[30].id }, searchProducer("channel"),
    { hold: true, consume: async (capture) => {
      const data = await capture.operation;
      const event = await capture.held;
      assert.ok(data.data.length > 0, "Real successful producer prerequisite");
      assert.equal(capture.queries.includes(event), true);
      await assert.rejects(capture.completion, QueryObservationTimeout);
      assert.equal(capture.delivered.filter(messageSelect).length, 0);
    } });
});
