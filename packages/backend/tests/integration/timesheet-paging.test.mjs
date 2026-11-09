// Timesheet entries used to return every row in the date range, ordered only
// by date and createdAt. Pages must stay inside `limit` (100 when omitted),
// walk back to that same id set, and keep rows that share a timestamp.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { recordQueries } from "./support/query-events.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database",
  );
}
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "timesheet-paging-disposable-jwt",
  COOKIE_SECRET: "timesheet-paging-disposable-cookie",
});
const storageDir = await mkdtemp(
  path.join(os.tmpdir(), "werkyn-timesheet-paging-"),
);
process.env.STORAGE_DIR = storageDir;

const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { TIME_ENTRY_PAGE_DEFAULT } = await import("@pm/shared");
const timeEntries =
  await import("../../src/modules/time/time-entries.service.js");
const { timeEntryProjectWhere } = timeEntries;
const { PrismaClient } = await import("@prisma/client");

const observerUrl = new URL(process.env.TEST_DATABASE_URL);
observerUrl.searchParams.set("connection_limit", "1");
const observer = new PrismaClient({
  datasourceUrl: observerUrl.toString(),
  log: [{ level: "query", emit: "event" }],
});

const START = "2026-06-01";
const END = "2026-06-30";
const T = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
const PAGE_DEFAULT = TIME_ENTRY_PAGE_DEFAULT;

let app;
let workspace;
let foreignWorkspace;
let requests = 0;
const users = {};
const tokens = {};
const roles = {};

function get(actor, url) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.91.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function send(actor, method, url, payload) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.91.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
}

function collection() {
  return `/api/workspaces/${workspace.id}/time/entries`;
}

function entriesUrl(extra = {}, cursor) {
  const params = new URLSearchParams({ startDate: START, endDate: END });
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  if (cursor) params.set("cursor", cursor);
  return `${collection()}?${params}`;
}

function idsAround(cursor) {
  assert.match(cursor, /^[a-z0-9]+$/);
  const tail = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let i = cursor.length - 1;
  while (i > 0 && cursor[i] === "0") i -= 1;
  const lower =
    cursor.slice(0, i) + alphabet[alphabet.indexOf(cursor[i]) - 1] + "z" + tail;
  return [lower, `${cursor}0${tail}`];
}

function entryRows(prefix, count, fields) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index).padStart(4, "0")}`,
    workspaceId: workspace.id,
    hours: 1,
    ...fields(index),
  }));
}

async function expectedIds(actor, filterUserId) {
  const role = roles[actor];
  const userId = users[actor].id;
  const scoped =
    role === "ADMIN" && filterUserId
      ? filterUserId
      : role === "ADMIN"
        ? undefined
        : userId;
  const rows = await app.prisma.timeEntry.findMany({
    where: {
      workspaceId: workspace.id,
      ...timeEntryProjectWhere(workspace.id, userId),
      ...(scoped ? { userId: scoped } : {}),
      date: { gte: START, lte: END },
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

async function walk(actor, extra = {}) {
  const limit = extra.limit ?? PAGE_DEFAULT;
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const res = await get(actor, entriesUrl(extra, cursor));
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(
      body.data.length <= limit,
      `page has ${body.data.length} rows, limit ${limit}`,
    );
    if (body.data.length < limit) assert.equal(body.nextCursor, null);
    if (body.nextCursor) assert.equal(body.nextCursor, body.data.at(-1).id);
    seen.push(...body.data.map((row) => row.id));
    cursor = body.nextCursor ?? undefined;
    pages += 1;
    assert.ok(pages < 800, "pagination must terminate");
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, "a row was returned twice");
  return seen;
}

function assertPageLimited(events, limit) {
  const pages = events.filter(
    (event) =>
      event.query.includes('FROM "public"."TimeEntry"') &&
      /ORDER BY[\s\S]*"createdAt"/.test(event.query),
  );
  assert.ok(pages.length > 0, "no timesheet page query");
  for (const page of pages) {
    const match = /LIMIT \$(\d+)/.exec(page.query);
    assert.ok(match, `page query has no LIMIT: ${page.query.slice(0, 400)}`);
    assert.equal(JSON.parse(page.params)[Number(match[1]) - 1], limit + 1);
  }
}

before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID().slice(0, 20);
  for (const [actor, role] of [
    ["ADMIN", "ADMIN"],
    ["MEMBER", "MEMBER"],
    ["VIEWER", "VIEWER"],
    ["PEER", "MEMBER"],
  ]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `timesheet-${actor}-${suffix}@example.test`,
        displayName: actor,
        emailVerified: true,
      },
    });
    tokens[actor] = signAccessToken({
      sub: users[actor].id,
      email: users[actor].email,
    });
    roles[actor] = role;
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Timesheet paging",
      slug: `ts-${suffix}`,
      members: {
        create: [
          { userId: users.ADMIN.id, role: "ADMIN" },
          { userId: users.MEMBER.id, role: "MEMBER" },
          { userId: users.VIEWER.id, role: "VIEWER" },
          { userId: users.PEER.id, role: "MEMBER" },
        ],
      },
    },
  });
  foreignWorkspace = await app.prisma.workspace.create({
    data: {
      name: "Other timesheet workspace",
      slug: `tsf-${suffix}`,
      members: { create: [{ userId: users.MEMBER.id, role: "MEMBER" }] },
    },
  });
  const visible = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Visible timesheet",
      members: {
        create: [{ userId: users.MEMBER.id }, { userId: users.VIEWER.id }],
      },
    },
  });
  const status = await app.prisma.statusColumn.create({
    data: { projectId: visible.id, name: "Open" },
  });
  const task = await app.prisma.task.create({
    data: { projectId: visible.id, statusId: status.id, title: "Visible task" },
  });
  const hidden = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Hidden timesheet",
      members: { create: [{ userId: users.PEER.id }] },
    },
  });
  await app.prisma.timeEntry.createMany({
    data: [
      ...entryRows("d", 10, () => ({
        userId: users.MEMBER.id,
        date: "2026-06-14",
        createdAt: T,
      })),
      ...entryRows("e", 210, () => ({
        userId: users.MEMBER.id,
        date: "2026-06-15",
        createdAt: T,
      })).reverse(),
      ...entryRows("f", 20, (index) => ({
        userId: users.MEMBER.id,
        date: "2026-06-16",
        createdAt: new Date(T.getTime() + index * 1000),
      })),
      ...entryRows("b", 8, () => ({
        userId: users.PEER.id,
        date: "2026-06-15",
        createdAt: T,
      })),
      ...entryRows("v", 2, () => ({
        userId: users.VIEWER.id,
        date: "2026-06-15",
        createdAt: T,
      })),
      ...entryRows("x", 5, () => ({
        userId: users.MEMBER.id,
        date: "2026-05-01",
        createdAt: T,
      })),
      {
        id: "p0001",
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        date: "2026-06-16",
        hours: 2,
        projectId: visible.id,
        taskId: task.id,
        createdAt: new Date(T.getTime() + 10_500),
        description: "Visible timesheet entry",
      },
      {
        id: "g0002",
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        date: "2026-06-17",
        hours: 1,
        createdAt: T,
      },
      {
        id: "g0001",
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        date: "2026-06-17",
        hours: 1,
        createdAt: new Date(T.getTime() + 1000),
      },
      {
        id: "h0001",
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        date: "2026-06-15",
        hours: 1,
        projectId: hidden.id,
        createdAt: T,
        description: "Hidden timesheet entry",
      },
      {
        id: "o0001",
        workspaceId: foreignWorkspace.id,
        userId: users.MEMBER.id,
        date: "2026-06-15",
        hours: 4,
        createdAt: T,
      },
    ],
  });
});

after(async () => {
  try {
    if (app) {
      const ids = [workspace?.id, foreignWorkspace?.id].filter(Boolean);
      await app.prisma.timeEntry.deleteMany({
        where: { workspaceId: { in: ids } },
      });
      await app.prisma.task.deleteMany({
        where: { project: { workspaceId: { in: ids } } },
      });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((user) => user.id) } },
      });
    }
  } finally {
    await observer.$disconnect();
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("an omitted cursor returns the first page, not the whole range", async () => {
  const member = await expectedIds("MEMBER");
  assert.ok(member.length >= 200, `fixture has ${member.length} entries`);
  const first = await get("MEMBER", entriesUrl());
  assert.equal(first.statusCode, 200, first.body);
  const body = first.json();
  assert.equal(body.data.length, PAGE_DEFAULT);
  assert.ok(body.data.length < member.length);
  assert.equal(body.nextCursor, member[PAGE_DEFAULT - 1]);
  assert.deepEqual(
    body.data.map((row) => row.id),
    member.slice(0, PAGE_DEFAULT),
  );
  assert.equal(
    body.data.some(
      (row) =>
        row.id === "h0001" ||
        row.id === "b0000" ||
        row.id === "o0001" ||
        row.id === "x0000",
    ),
    false,
  );
});

test("walking every page matches the full id list for that user and range", async () => {
  const member = await expectedIds("MEMBER");
  const admin = await expectedIds("ADMIN");
  assert.equal(member.includes("h0001"), false);
  assert.equal(admin.includes("h0001"), true);
  assert.equal(member.includes("b0000"), false);
  assert.equal(admin.includes("b0000"), true);
  assert.equal(member.includes("x0000"), false);
  assert.equal(member.includes("o0001"), false);
  assert.ok(member.indexOf("d0000") < member.indexOf("e0000"));
  assert.ok(member.indexOf("e0000") < member.indexOf("e0209"));
  assert.ok(member.indexOf("e0209") < member.indexOf("f0000"));
  assert.ok(member.indexOf("g0002") < member.indexOf("g0001"));
  const tie = member.filter((id) => id.startsWith("e"));
  assert.equal(tie.length, 210);
  assert.deepEqual(tie, [...tie].sort());

  for (const limit of [1, 7, 50, 500]) {
    assert.deepEqual(
      await walk("MEMBER", { limit }),
      member,
      `member limit ${limit}`,
    );
  }
  assert.deepEqual(
    await walk("MEMBER", {}),
    member,
    "member default page size",
  );
  assert.deepEqual(
    await walk("ADMIN", { limit: 17 }),
    admin,
    "admin sees every visible entry",
  );
  assert.deepEqual(
    await walk("ADMIN", { limit: 3, userId: users.PEER.id }),
    await expectedIds("ADMIN", users.PEER.id),
    "admin user filter",
  );
  assert.deepEqual(
    await walk("MEMBER", { limit: 5, userId: users.PEER.id }),
    member,
    "non-admin ignores userId",
  );
  assert.deepEqual(
    await walk("VIEWER", { limit: 1 }),
    await expectedIds("VIEWER"),
  );

  const full = await get("MEMBER", entriesUrl({ limit: 500 }));
  assert.equal(full.json().nextCursor, null);
  const visible = full.json().data.find((row) => row.id === "p0001");
  assert.equal(visible.project.name, "Visible timesheet");
  assert.equal(visible.task.title, "Visible task");
  assert.equal(visible.user.displayName, "MEMBER");
  assert.equal(visible.hours, 2);
  const plain = full.json().data.find((row) => row.id === "e0000");
  assert.equal(plain.project, null);
  assert.equal(plain.task, null);
});

test("cursors inside a shared timestamp do not skip or repeat rows", async () => {
  const member = await expectedIds("MEMBER");
  const page = await get("MEMBER", entriesUrl({ limit: 3 }, "e0100"));
  assert.equal(page.statusCode, 200, page.body);
  assert.deepEqual(
    page.json().data.map((row) => row.id),
    ["e0101", "e0102", "e0103"],
  );
  assert.equal(page.json().nextCursor, "e0103");

  const admin = await expectedIds("ADMIN");
  const hiddenAt = admin.indexOf("h0001");
  const afterHidden = await get("ADMIN", entriesUrl({ limit: 2 }, "h0001"));
  assert.deepEqual(
    afterHidden.json().data.map((row) => row.id),
    admin.slice(hiddenAt + 1, hiddenAt + 3),
  );

  const last = await get("MEMBER", entriesUrl({ limit: 2 }, member.at(-1)));
  assert.deepEqual(last.json(), { data: [], nextCursor: null });
  for (const cursor of [
    "cmissingcursor000000000000",
    "x0000",
    "b0000",
    "h0001",
    "o0001",
  ]) {
    const res = await get("MEMBER", entriesUrl({ limit: 2 }, cursor));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { data: [], nextCursor: null }, cursor);
  }
});

test("page queries read limit + 1 rows", async () => {
  const query = { startDate: START, endDate: END, limit: 5 };
  const first = await recordQueries(observer, (client) =>
    timeEntries.listEntries(
      client,
      workspace.id,
      users.MEMBER.id,
      "MEMBER",
      query,
    ),
  );
  assertPageLimited(first.events, 5);
  assert.equal(first.result.data.length, 5);
  assert.equal(typeof first.result.nextCursor, "string");

  const next = await recordQueries(observer, (client) =>
    timeEntries.listEntries(client, workspace.id, users.MEMBER.id, "MEMBER", {
      ...query,
      cursor: first.result.nextCursor,
    }),
  );
  assertPageLimited(next.events, 5);
  const member = await expectedIds("MEMBER");
  assert.deepEqual(
    next.result.data.map((row) => row.id),
    member.slice(5, 10),
  );
});

test("rows inserted on the cursor timestamp are not skipped or repeated", async () => {
  const before = await expectedIds("MEMBER");
  const inserted = [];
  try {
    const seen = [];
    let cursor;
    let pages = 0;
    while (pages < 800) {
      const res = await get("MEMBER", entriesUrl({ limit: 2 }, cursor));
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      seen.push(...body.data.map((row) => row.id));
      cursor = body.nextCursor ?? undefined;
      pages += 1;
      if (!cursor) break;
      if (pages <= 3) {
        const row = await app.prisma.timeEntry.findUnique({
          where: { id: cursor },
          select: { date: true, createdAt: true },
        });
        const [lower, upper] = idsAround(cursor);
        await app.prisma.timeEntry.createMany({
          data: [lower, upper].map((id) => ({
            id,
            workspaceId: workspace.id,
            userId: users.MEMBER.id,
            date: row.date,
            hours: 1,
            createdAt: row.createdAt,
          })),
        });
        inserted.push(lower, upper);
      }
    }
    assert.equal(new Set(seen).size, seen.length);
    for (const id of before) assert.ok(seen.includes(id), `skipped ${id}`);
    for (const id of seen)
      assert.ok(
        before.includes(id) || inserted.includes(id),
        `unexpected ${id}`,
      );
    assert.deepEqual(
      await walk("MEMBER", { limit: 3 }),
      await expectedIds("MEMBER"),
    );
  } finally {
    if (inserted.length > 0) {
      await app.prisma.timeEntry.deleteMany({
        where: { id: { in: inserted } },
      });
    }
  }
  assert.deepEqual(await walk("MEMBER", { limit: 11 }), before);
});

test("create, update and delete of an entry are unchanged", async () => {
  const created = await send("MEMBER", "POST", collection(), {
    date: "2026-06-15",
    hours: 1.25,
    description: "paging regression",
  });
  assert.equal(created.statusCode, 201, created.body);
  const entry = created.json().data;
  assert.equal(created.json().nextCursor, undefined);
  assert.equal(entry.hours, 1.25);
  assert.equal(entry.description, "paging regression");
  assert.equal(entry.user.displayName, "MEMBER");
  const updated = await send(
    "MEMBER",
    "PATCH",
    `/api/time/entries/${entry.id}`,
    { hours: 2 },
  );
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().data.hours, 2);
  assert.equal(updated.json().nextCursor, undefined);
  const listed = await get("MEMBER", entriesUrl({ limit: 500 }));
  assert.equal(
    listed.json().data.some((row) => row.id === entry.id),
    true,
  );
  assert.equal(
    (await send("MEMBER", "DELETE", `/api/time/entries/${entry.id}`))
      .statusCode,
    204,
  );
  const after = await get("MEMBER", entriesUrl({ limit: 500 }));
  assert.equal(
    after.json().data.some((row) => row.id === entry.id),
    false,
  );
});

test("invalid cursors and page sizes are rejected", async () => {
  for (const extra of [
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { limit: "nope" },
    { cursor: "" },
    { cursor: "x".repeat(201) },
  ]) {
    const res = await get("MEMBER", entriesUrl(extra));
    assert.equal(
      res.statusCode,
      400,
      `${JSON.stringify(extra)} -> ${res.statusCode} ${res.body}`,
    );
  }
});
