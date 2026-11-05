// Lists that returned every row (P02b): my tasks, time report entries, the
// workspace activity total and the channel list's members. Requests without
// paging parameters get a bounded default with a "more" indicator, paging
// returns every row exactly once in the documented order (also with rows
// inserted between requests), and totals stay exact.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseCsv, values } from "../fixtures/rfc4180.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "bounded-lists-disposable-jwt",
  COOKIE_SECRET: "bounded-lists-disposable-cookie",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-bounded-lists-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const chat = await import("../../src/modules/chat/chat.service.js");
const { PrismaClient } = await import("@prisma/client");

// A separate client whose generated SQL is recorded for plan checks.
const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({ datasourceUrl: observerUrl.toString(), log: [{ level: "query", emit: "event" }] });
let recorded = null;
observer.$on("query", (event) => recorded?.push(event));

let app, workspace, requests = 0;
const users = {}, tokens = {};
const createdUsers = [];
const T = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
const at = (seconds) => new Date(T.getTime() + seconds * 1000);

function get(actor, url) {
  return app.inject({
    method: "GET", url,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.84.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}
async function ok(actor, url) {
  const res = await get(actor, url);
  assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
  return res.json();
}
const withParam = (url, name, value) => value == null ? url : `${url}${url.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;

/** Two new IDs sorting just before and just after `id` (lower-case letters and digits). */
function idsAround(id) {
  const tail = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let i = id.length - 1;
  while (i > 0 && id[i] === "0") i -= 1;
  return [id.slice(0, i) + alphabet[alphabet.indexOf(id[i]) - 1] + "z" + tail, `${id}0${tail}`];
}

function assertExactlyOnce(seen, expected, label) {
  assert.equal(new Set(seen).size, seen.length, `${label}: a row was returned twice`);
  assert.deepEqual(expected.filter((id) => !seen.includes(id)), [], `${label}: rows were skipped`);
}

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 12);
  for (const name of ["boss", "me", "other"]) {
    users[name] = await app.prisma.user.create({ data: { email: `bounded-${name}-${suffix}@example.test`, displayName: name, emailVerified: true } });
    createdUsers.push(users[name].id);
    tokens[name] = signAccessToken({ sub: users[name].id, email: users[name].email });
  }
  workspace = await app.prisma.workspace.create({ data: {
    name: "Bounded lists", slug: `bounded-${suffix}`,
    members: { create: [
      { userId: users.boss.id, role: "ADMIN" },
      { userId: users.me.id, role: "MEMBER" },
      { userId: users.other.id, role: "MEMBER" },
    ] },
  } });
});

after(async () => {
  try {
    if (app && workspace) await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (app) await app.prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  } finally {
    await observer.$disconnect();
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

describe("my tasks", () => {
  const base = () => `/api/workspaces/${workspace.id}/my-tasks`;
  const projects = {}, statuses = {};

  async function project(key, name, { member = true, archived = false } = {}) {
    projects[key] = await app.prisma.project.create({ data: {
      workspaceId: workspace.id, name, archived,
      members: { create: member ? [{ userId: users.me.id }, { userId: users.boss.id }] : [{ userId: users.boss.id }] },
    } });
    statuses[key] = {
      open: await app.prisma.statusColumn.create({ data: { projectId: projects[key].id, name: "Open", position: 0 } }),
      done: await app.prisma.statusColumn.create({ data: { projectId: projects[key].id, name: "Done", position: 1, isCompletion: true } }),
    };
  }
  async function assigned(key, rows) {
    const data = rows.map(({ id, position = 0, dueDate = null, done = false, archived = false }) => ({
      id: id ?? `${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      projectId: projects[key].id, statusId: statuses[key][done ? "done" : "open"].id,
      title: `task ${position}`, position, dueDate, archived,
    }));
    await app.prisma.task.createMany({ data });
    await app.prisma.taskAssignee.createMany({ data: data.map((task) => ({ taskId: task.id, userId: users.me.id })) });
    return data.map((task) => task.id);
  }

  /** The documented order, with the same visibility as the endpoint for a member. */
  async function expected(extra = "", order = `p.name, t."projectId", t.position, t.id`) {
    return (await app.prisma.$queryRawUnsafe(`
      SELECT t.id FROM "Task" t
      JOIN "Project" p ON p.id = t."projectId"
      JOIN "StatusColumn" s ON s.id = t."statusId"
      WHERE p."workspaceId" = $1 AND NOT p.archived AND NOT t.archived
        AND EXISTS (SELECT 1 FROM "TaskAssignee" a WHERE a."taskId" = t.id AND a."userId" = $2)
        AND EXISTS (SELECT 1 FROM "ProjectMember" m WHERE m."projectId" = p.id AND m."userId" = $2)
        ${extra}
      ORDER BY ${order}`, workspace.id, users.me.id)).map((r) => r.id);
  }

  async function walk(url, between) {
    const seen = [];
    let cursor, pages = 0;
    do {
      const body = await ok("me", withParam(url, "cursor", cursor));
      seen.push(...body.data.map((task) => task.id));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      if (cursor && between) await between(body.data.at(-1), pages);
      assert.ok(pages < 500);
    } while (cursor);
    return seen;
  }

  before(async () => {
    // Two projects share a name; positions repeat inside each project.
    await project("apple1", "apple");
    await project("apple2", "apple");
    await project("banana", "banana");
    await project("archived", "aardvark", { archived: true });
    await project("hidden", "hidden", { member: false });
    await assigned("apple1", Array.from({ length: 60 }, (_, i) => ({ position: i % 4, dueDate: `2026-04-${String((i % 28) + 1).padStart(2, "0")}`, done: i % 5 === 0 })));
    await assigned("apple2", Array.from({ length: 30 }, (_, i) => ({ position: i % 3 })));
    await assigned("banana", Array.from({ length: 20 }, (_, i) => ({ position: 7, dueDate: i % 2 ? "2026-04-10" : null, done: i % 3 === 0 })));
    await assigned("banana", [{ position: 1, archived: true }]);
    await assigned("archived", [{ position: 0 }]);
    await assigned("hidden", [{ position: 0 }]);
  });

  test("without paging parameters the list stops at 100 tasks with a cursor", async () => {
    const order = await expected();
    assert.equal(order.length, 110);
    const first = await ok("me", base());
    assert.equal(first.data.length, 100);
    assert.equal(typeof first.nextCursor, "string");
    assert.deepEqual(first.data.map((task) => task.id), order.slice(0, 100));
    // The task shape is unchanged.
    for (const key of ["project", "status", "labels", "assignees"]) assert.ok(key in first.data[0], key);
    assert.deepEqual(Object.keys(first.data[0].project).sort(), ["color", "id", "name"]);
    const rest = await ok("me", withParam(base(), "cursor", first.nextCursor));
    assert.deepEqual(rest.data.map((task) => task.id), order.slice(100));
    assert.equal(rest.nextCursor, null);
  });

  test("pages traverse equal project names and positions exactly once", async () => {
    const order = await expected();
    for (const limit of [1, 2, 7, 200]) {
      assert.deepEqual(await walk(`${base()}?limit=${limit}`), order, `limit ${limit}`);
    }
  });

  test("tasks assigned between pages do not repeat or skip earlier tasks", async () => {
    const order = await expected();
    const inserted = [];
    const seen = await walk(`${base()}?limit=9`, async (last, page) => {
      if (page > 4) return;
      const key = Object.keys(projects).find((k) => projects[k].id === last.projectId);
      inserted.push(...await assigned(key, idsAround(last.id).map((id) => ({ id, position: last.position }))));
    });
    assertExactlyOnce(seen, order, "inserts");
    for (const id of seen) assert.ok(order.includes(id) || inserted.includes(id));
    assert.deepEqual(await walk(`${base()}?limit=13`), await expected());
  });

  test("due-date and completion filters page like the full list", async () => {
    const cases = [
      ["?completed=false", `AND NOT s."isCompletion"`],
      ["?completed=true", `AND s."isCompletion"`],
      ["?dueAfter=2026-04-05&dueBefore=2026-04-10", `AND t."dueDate" >= '2026-04-05' AND t."dueDate" <= '2026-04-10'`],
      ["?dueBefore=2026-04-03&completed=false", `AND t."dueDate" <= '2026-04-03' AND NOT s."isCompletion"`],
    ];
    for (const [query, sql] of cases) {
      const order = await expected(sql);
      assert.ok(order.length > 0, query);
      assert.deepEqual(await walk(`${base()}${query}&limit=4`), order, query);
    }
  });

  test("sort=dueDate pages soonest first, tasks without a due date last", async () => {
    const byDue = `t."dueDate" ASC NULLS LAST, t.id`;
    const order = await expected("", byDue);
    for (const limit of [1, 6, 200]) {
      assert.deepEqual(await walk(`${base()}?sort=dueDate&limit=${limit}`), order, `limit ${limit}`);
    }
    const window = await expected(`AND t."dueDate" >= '2026-04-08' AND t."dueDate" <= '2026-04-14' AND NOT s."isCompletion"`, byDue);
    assert.ok(window.length > 4);
    assert.deepEqual(await walk(`${base()}?sort=dueDate&dueAfter=2026-04-08&dueBefore=2026-04-14&completed=false&limit=3`), window);
    // A cursor of one sort is not accepted for the other.
    const projectPage = await ok("me", `${base()}?limit=1`);
    assert.equal((await get("me", `${base()}?sort=dueDate&cursor=${projectPage.nextCursor}`)).statusCode, 400);
    const duePage = await ok("me", `${base()}?sort=dueDate&limit=1`);
    assert.equal((await get("me", `${base()}?cursor=${duePage.nextCursor}`)).statusCode, 400);
    assert.equal((await get("me", `${base()}?sort=title`)).statusCode, 400);
  });

  test("a caller without assigned tasks gets an empty last page", async () => {
    const admin = await ok("boss", base());
    assert.deepEqual(admin.data, []);
    assert.equal(admin.nextCursor, null);
  });

  test("a cursor after a project with the longest multi-byte name is accepted", async () => {
    // 255 characters (the column limit) that JSON escapes or UTF-8 widens.
    await project("long", "\u0001\"\u{1D49C}".repeat(85));
    await assigned("long", [{ position: 0 }, { position: 0 }]);
    const order = await expected();
    assert.deepEqual(await walk(`${base()}?limit=1`), order);
    await app.prisma.project.delete({ where: { id: projects.long.id } });
    delete projects.long;
  });

  test("malformed cursors and limits are rejected", async () => {
    for (const query of ["?cursor=not-a-cursor", `?cursor=${Buffer.from("[1,2,3]").toString("base64url")}`, "?limit=0", "?limit=201", "?dueBefore=2026-13-01", "?completed=maybe"]) {
      const res = await get("me", `${base()}${query}`);
      assert.equal(res.statusCode, 400, `${query}: ${res.body}`);
    }
  });
});

describe("time report entries", () => {
  let project, fewUser, manyUser;
  const report = (query) => `/api/workspaces/${workspace.id}/time/reports?startDate=2026-01-01&endDate=2026-01-31&${query}`;
  const entries = (query) => `/api/workspaces/${workspace.id}/time/reports/entries?startDate=2026-01-01&endDate=2026-01-31&${query}`;
  const userQuery = () => `userIds=${[manyUser, fewUser].map((u) => u.id).join(",")}`;

  async function addEntries(user, count, { date = (i) => `2026-01-${String((i % 5) + 1).padStart(2, "0")}`, createdAt = () => at(0), id } = {}) {
    const data = Array.from({ length: count }, (_, i) => ({
      ...(id ? { id: id(i) } : {}),
      workspaceId: workspace.id, userId: user.id, projectId: project.id,
      date: date(i), hours: [0.1, 0.25, 1, 2.5][i % 4], billable: i % 3 !== 0,
      description: `entry ${i}`, createdAt: createdAt(i),
    }));
    await app.prisma.timeEntry.createMany({ data });
  }

  async function walkGroup(groupKey, groupBy, start, limit, between) {
    const seen = [];
    let cursor = start ?? undefined, pages = 0;
    do {
      const body = await ok("boss", withParam(entries(`groupBy=${groupBy}&groupKey=${groupKey}&limit=${limit}&${userQuery()}`), "cursor", cursor));
      seen.push(...body.data);
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      if (cursor && between) await between(cursor, pages);
      assert.ok(pages < 500);
    } while (cursor);
    return seen;
  }

  before(async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    for (const name of ["few", "many"]) {
      const user = await app.prisma.user.create({ data: { email: `bounded-time-${name}-${suffix}@example.test`, displayName: `time ${name}` } });
      createdUsers.push(user.id);
      await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "MEMBER" } });
      if (name === "few") fewUser = user;
      if (name === "many") manyUser = user;
    }
    project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Timed", members: { create: [{ userId: users.boss.id }] } } });
    await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: manyUser.id, rate: 33.33, currency: "USD", effectiveFrom: "2026-01-03" } });
    // 45 entries with repeated dates and one creation time, 3 with distinct ones.
    await addEntries(manyUser, 45);
    await addEntries(fewUser, 3, { createdAt: (i) => at(i) });
  });

  test("groups carry 20 entries by default with exact totals and a cursor for the rest", async () => {
    const bounded = (await ok("boss", report(userQuery()))).data;
    const full = (await ok("boss", report(`${userQuery()}&entryLimit=500`))).data;
    assert.deepEqual(bounded.summary, full.summary);
    const many = bounded.groups.find((g) => g.key === manyUser.id);
    const fullMany = full.groups.find((g) => g.key === manyUser.id);
    assert.equal(many.entries.length, 20);
    assert.equal(many.entryCount, 45);
    assert.equal(many.hasMoreEntries, true);
    assert.equal(many.nextEntryCursor, many.entries[19].id);
    assert.deepEqual(many.entries, fullMany.entries.slice(0, 20));
    for (const field of ["totalHours", "billableHours", "nonBillableHours", "totalCost", "currency", "costByCurrency", "unratedBillableHours", "label"]) {
      assert.deepEqual(many[field], fullMany[field], field);
    }
    assert.equal(fullMany.entries.length, 45);
    assert.equal(fullMany.hasMoreEntries, false);
    assert.equal(fullMany.nextEntryCursor, null);
    const few = bounded.groups.find((g) => g.key === fewUser.id);
    assert.deepEqual([few.entries.length, few.entryCount, few.hasMoreEntries, few.nextEntryCursor], [3, 3, false, null]);
    // The documented order: date, creation time, then ID.
    const order = (await app.prisma.$queryRaw`
      SELECT id FROM "TimeEntry" WHERE "userId" = ${manyUser.id} ORDER BY date, "createdAt", id`).map((r) => r.id);
    assert.deepEqual(fullMany.entries.map((e) => e.id), order);
    // Summary hours are the sum over every entry, not only the listed ones.
    const hours = await app.prisma.timeEntry.aggregate({ where: { userId: { in: [manyUser.id, fewUser.id] } }, _sum: { hours: true } });
    assert.ok(Math.abs(bounded.summary.totalHours - hours._sum.hours) < 1e-9);
  });

  test("the entries endpoint continues each group exactly where the report stopped", async () => {
    const bounded = (await ok("boss", report(userQuery()))).data;
    const full = (await ok("boss", report(`${userQuery()}&entryLimit=500`))).data;
    for (const limit of [1, 7, 100]) {
      const many = bounded.groups.find((g) => g.key === manyUser.id);
      const rest = await walkGroup(manyUser.id, "user", many.nextEntryCursor, limit);
      assert.deepEqual([...many.entries, ...rest], full.groups.find((g) => g.key === manyUser.id).entries, `limit ${limit}`);
    }
    // entryLimit=0: totals only; the entries start from the first.
    const totalsOnly = (await ok("boss", report(`${userQuery()}&entryLimit=0&groupBy=date`))).data;
    const fullByDate = (await ok("boss", report(`${userQuery()}&entryLimit=500&groupBy=date`))).data;
    assert.equal(totalsOnly.groups.length, fullByDate.groups.length);
    for (const group of totalsOnly.groups) {
      assert.deepEqual([group.entries, group.hasMoreEntries, group.nextEntryCursor], [[], true, null]);
      const all = await walkGroup(group.key, "date", null, 6);
      assert.deepEqual(all, fullByDate.groups.find((g) => g.key === group.key).entries, group.key);
      assert.equal(all.length, group.entryCount);
    }
  });

  test("entries added between pages do not repeat or skip earlier entries", async () => {
    const order = (await app.prisma.$queryRaw`
      SELECT id FROM "TimeEntry" WHERE "userId" = ${manyUser.id} ORDER BY date, "createdAt", id`).map((r) => r.id);
    const seen = (await walkGroup(manyUser.id, "user", null, 4, async (cursor, page) => {
      if (page > 4) return;
      const row = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: cursor } });
      const [low, high] = idsAround(cursor);
      await addEntries(manyUser, 2, { date: () => row.date, createdAt: () => row.createdAt, id: (i) => [low, high][i] });
    })).map((e) => e.id);
    assertExactlyOnce(seen, order, "report entries");
    await app.prisma.timeEntry.deleteMany({ where: { userId: manyUser.id, id: { notIn: order } } });
  });

  test("cursors outside the group or filters give an empty page; bad parameters are rejected", async () => {
    const few = await app.prisma.timeEntry.findFirstOrThrow({ where: { userId: fewUser.id }, orderBy: [{ date: "asc" }, { id: "asc" }] });
    for (const cursor of [few.id, "cunknowncursor0000000000"]) {
      const body = await ok("boss", entries(`groupBy=user&groupKey=${manyUser.id}&${userQuery()}&cursor=${cursor}`));
      assert.deepEqual(body, { data: [], nextCursor: null });
    }
    const outside = await ok("boss", `/api/workspaces/${workspace.id}/time/reports/entries?startDate=2026-01-02&endDate=2026-01-31&groupBy=user&groupKey=${fewUser.id}&cursor=${few.id}`);
    assert.equal(few.date, "2026-01-01");
    assert.deepEqual(outside.data, []);
    for (const url of [report("entryLimit=501"), report("entryLimit=-1"), entries("groupBy=user"), entries(`groupKey=${manyUser.id}&limit=501`)]) {
      assert.equal((await get("boss", url)).statusCode, 400, url);
    }
    assert.equal((await get("me", entries(`groupBy=user&groupKey=${manyUser.id}`))).statusCode, 403);
  });

  test("one response carries at most 5,000 entries, spent in group order; the CSV stays complete", async () => {
    // Twelve members with 430 entries each, interleaved by date and creation
    // time: every member has entries on every one of twelve dates.
    const suffix = crypto.randomUUID().slice(0, 8);
    const bulk = [];
    for (let u = 0; u < 12; u++) {
      const user = await app.prisma.user.create({ data: { email: `bounded-bulk-${u}-${suffix}@example.test`, displayName: `bulk ${String(u).padStart(2, "0")}` } });
      createdUsers.push(user.id);
      bulk.push(user);
      await addEntries(user, 430, { date: (i) => `2026-01-${String((i % 12) + 10).padStart(2, "0")}`, createdAt: (i) => at(i * 12 + u) });
    }
    const query = `userIds=${bulk.map((u) => u.id).join(",")}&groupBy=user&entryLimit=500`;
    const bounded = (await ok("boss", report(query))).data;
    // Groups keep the order of their first entry: bulk 00 to bulk 11.
    assert.deepEqual(bounded.groups.map((g) => g.key), bulk.map((u) => u.id));
    assert.equal(bounded.groups.reduce((n, g) => n + g.entries.length, 0), 5000);
    for (const group of bounded.groups.slice(0, 11)) {
      assert.deepEqual([group.entries.length, group.entryCount, group.hasMoreEntries, group.nextEntryCursor], [430, 430, false, null], group.label);
    }
    const last = bounded.groups.at(-1);
    assert.equal(last.entryCount, 430);
    assert.equal(last.entries.length, 5000 - 11 * 430);
    assert.equal(last.hasMoreEntries, true);
    assert.equal(last.nextEntryCursor, last.entries.at(-1).id);
    const rest = await walkGroupFor(bulk.map((u) => u.id).join(","), last.key, last.nextEntryCursor);
    const full = (await ok("boss", report(`userIds=${last.key}&groupBy=user&entryLimit=500`))).data.groups[0].entries;
    assert.deepEqual([...last.entries, ...rest], full);
    const csv = await get("boss", `/api/workspaces/${workspace.id}/time/reports/export?startDate=2026-01-01&endDate=2026-01-31&${query}`);
    assert.equal(csv.statusCode, 200);
    assert.equal(values(parseCsv(csv.body.replace(/^\uFEFF/, ""))).length - 1, 12 * 430);
  });

  async function walkGroupFor(userIds, groupKey, start) {
    const seen = [];
    let cursor = start ?? undefined;
    do {
      const body = await ok("boss", withParam(entries(`groupBy=user&groupKey=${groupKey}&userIds=${userIds}&limit=500`), "cursor", cursor));
      seen.push(...body.data);
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
    return seen;
  }
});

describe("workspace activity", () => {
  let visible, hidden;
  const url = (actor, query) => `/api/workspaces/${workspace.id}/activity${query}`;

  before(async () => {
    const make = async (name, members) => {
      const project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name, members: { create: members.map((userId) => ({ userId })) } } });
      const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
      return app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: name } });
    };
    visible = await make("activity visible", [users.other.id]);
    hidden = await make("activity hidden", []);
    // 30 visible rows, 25 of them at one instant; 1,005 rows the member cannot see.
    await app.prisma.activityLog.createMany({ data: Array.from({ length: 30 }, (_, i) => ({
      taskId: visible.id, action: "created", actorId: users.boss.id, createdAt: i < 25 ? at(0) : at(i),
    })) });
    await app.prisma.activityLog.createMany({ data: Array.from({ length: 1005 }, () => ({
      taskId: hidden.id, action: "created", actorId: users.boss.id, createdAt: at(0),
    })) });
  });

  test("the total is exact below 1,000 rows and capped above it", async () => {
    const member = await ok("other", url("other", "?limit=20"));
    assert.deepEqual(member.pagination, { page: 1, limit: 20, total: 30, totalPages: 2, totalCapped: false, hasMore: true });
    const count = await app.prisma.activityLog.count({ where: { task: { project: { workspaceId: workspace.id, members: { some: { userId: users.other.id } } } } } });
    assert.equal(count, 30);
    const last = await ok("other", url("other", "?limit=20&page=2"));
    assert.equal(last.data.length, 10);
    assert.equal(last.pagination.hasMore, false);

    const admin = await ok("boss", url("boss", "?limit=20"));
    assert.equal(admin.pagination.total, 1000);
    assert.equal(admin.pagination.totalCapped, true);
    assert.equal(admin.pagination.totalPages, 50);
    assert.equal(admin.pagination.hasMore, true);
    const deep = await ok("boss", url("boss", "?limit=20&page=52"));
    assert.equal(deep.data.length, 15);
    assert.equal(deep.pagination.hasMore, false);
  });

  test("offset pages traverse equal timestamps exactly once", async () => {
    const order = (await app.prisma.$queryRaw`
      SELECT a.id FROM "ActivityLog" a WHERE a."taskId" = ${visible.id} ORDER BY a."createdAt" DESC, a.id DESC`).map((r) => r.id);
    for (const limit of [1, 4, 7]) {
      const seen = [];
      for (let page = 1; ; page++) {
        const body = await ok("other", url("other", `?limit=${limit}&page=${page}`));
        seen.push(...body.data.map((row) => row.id));
        if (!body.pagination.hasMore) break;
      }
      assert.deepEqual(seen, order, `limit ${limit}`);
    }
  });
});

describe("channel list members", () => {
  let crowded, dm;
  const crowd = [];

  before(async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await app.prisma.user.createMany({ data: Array.from({ length: 15 }, (_, i) => ({ email: `bounded-crowd-${i}-${suffix}@example.test`, displayName: `crowd ${i}` })) });
    crowd.push(...await app.prisma.user.findMany({ where: { email: { endsWith: `-${suffix}@example.test` } } }));
    createdUsers.push(...crowd.map((u) => u.id));
    await app.prisma.workspaceMember.createMany({ data: crowd.map((u) => ({ workspaceId: workspace.id, userId: u.id, role: "MEMBER" })) });
    crowded = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: "crowded", createdById: users.boss.id } });
    await app.prisma.chatChannelMember.createMany({ data: [users.me, ...crowd].map((u, i) => ({ channelId: crowded.id, userId: u.id, joinedAt: i < 6 ? at(0) : at(i) })) });
    dm = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "DM", createdById: users.me.id } });
    await app.prisma.chatChannelMember.createMany({ data: [users.me, ...crowd.slice(0, 7)].map((u) => ({ channelId: dm.id, userId: u.id })) });
  });

  test("each channel carries its first ten members and the full count; DMs are complete", async () => {
    const { data } = await ok("me", `/api/chat/${workspace.id}/channels`);
    const listed = data.find((c) => c.id === crowded.id);
    assert.equal(listed._count.members, 16);
    assert.equal(listed.members.length, 10);
    const order = (await app.prisma.$queryRaw`
      SELECT id FROM "ChatChannelMember" WHERE "channelId" = ${crowded.id} ORDER BY "joinedAt", id LIMIT 10`).map((r) => r.id);
    assert.deepEqual(listed.members.map((m) => m.id), order);
    assert.deepEqual(Object.keys(listed.members[0]).sort(), ["channelId", "id", "joinedAt", "lastReadAt", "user", "userId"]);
    assert.deepEqual(Object.keys(listed.members[0].user).sort(), ["avatarUrl", "displayName", "id"]);
    assert.equal(listed.members[0].user.id, listed.members[0].userId);
    assert.ok(!Number.isNaN(Date.parse(listed.members[0].joinedAt)));
    const direct = data.find((c) => c.id === dm.id);
    assert.equal(direct._count.members, 8);
    assert.equal(direct.members.length, 8);
    // A channel the caller cannot see is still left out.
    const secret = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PRIVATE", name: "secret", createdById: users.boss.id, members: { create: { userId: users.boss.id } } } });
    const again = await ok("me", `/api/chat/${workspace.id}/channels`);
    assert.ok(!again.data.some((c) => c.id === secret.id));
  });

  test("each preview reads at most ten members, also next to one large channel", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    await app.prisma.user.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ email: `bounded-large-${i}-${suffix}@example.test`, displayName: `large ${i}` })) });
    const large = await app.prisma.user.findMany({ where: { email: { endsWith: `-${suffix}@example.test` } }, select: { id: true } });
    createdUsers.push(...large.map((u) => u.id));
    const big = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: "everyone", createdById: users.boss.id } });
    await app.prisma.chatChannelMember.createMany({ data: large.map((u, i) => ({ channelId: big.id, userId: u.id, joinedAt: at(600 - i) })) });
    for (let i = 0; i < 40; i++) {
      const small = await app.prisma.chatChannel.create({ data: { workspaceId: workspace.id, type: "PUBLIC", name: `small ${i}`, createdById: users.boss.id } });
      await app.prisma.chatChannelMember.createMany({ data: large.slice(i * 2, i * 2 + 2).map((u) => ({ channelId: small.id, userId: u.id })) });
    }
    await app.prisma.$executeRawUnsafe('ANALYZE "ChatChannelMember"');

    const events = (recorded = []);
    const channels = await chat.listChannels(observer, workspace.id, users.me.id).finally(() => { recorded = null; });
    const listed = channels.find((c) => c.id === big.id);
    assert.equal(listed._count.members, 600);
    const order = (await app.prisma.$queryRaw`
      SELECT id FROM "ChatChannelMember" WHERE "channelId" = ${big.id} ORDER BY "joinedAt", id LIMIT 10`).map((r) => r.id);
    assert.deepEqual(listed.members.map((m) => m.id), order);

    // The preview statement, run again under EXPLAIN ANALYZE.
    const preview = events.find((e) => e.query.includes("WITH RECURSIVE preview"));
    assert.ok(preview, "preview statement");
    const plan = await app.prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${preview.query}`, ...JSON.parse(preview.params));
    let memberRows = 0;
    const walkPlan = (node) => {
      if (node["Relation Name"] === "ChatChannelMember") {
        memberRows += (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"];
      }
      for (const child of node.Plans ?? []) walkPlan(child);
    };
    walkPlan(plan[0]["QUERY PLAN"][0].Plan);
    assert.ok(memberRows <= 10 * channels.length, `read ${memberRows} member rows for ${channels.length} channels`);
  });
});
