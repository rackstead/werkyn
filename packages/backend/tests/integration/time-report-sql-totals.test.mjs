// Report totals must match the per-entry rounded sum, including past entryLimit,
// without the database returning every matching entry to add them up.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { roundedCostUnits, reportMoneyNumber } from "../../src/modules/time/report-money.ts";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "report-sql-totals-signing-secret",
  COOKIE_SECRET: "report-sql-totals-cookie-secret",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-report-sql-totals-"));
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

let app;
let workspace;
let project;
const users = {};
const tokens = {};
let requests = 0;
const ENTRY_COUNT = 2000;
const ENTRY_LIMIT = 20;

function sqlText(query) {
  if (Array.isArray(query)) return query.join(" ");
  if (query && typeof query === "object" && Array.isArray(query.strings)) return query.strings.join(" ");
  return "";
}

const request = (method, url) => app.inject({
  method,
  url,
  headers: { authorization: `Bearer ${tokens.ADMIN}` },
  remoteAddress: `10.188.${Math.floor(++requests / 200)}.${requests % 200 + 1}`,
});

before(async () => {
  app = await buildApp();
  await app.ready();
  app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 8);
  for (const name of ["ADMIN", "USD", "EUR"]) {
    users[name] = await app.prisma.user.create({
      data: { email: `sql-totals-${name}-${suffix}@example.test`, displayName: name, emailVerified: true },
    });
    tokens[name] = signAccessToken({ sub: users[name].id, email: users[name].email });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "SQL totals",
      slug: `sql-totals-${suffix}`,
      members: { create: ["ADMIN", "USD", "EUR"].map((name) => ({ userId: users[name].id, role: name === "ADMIN" ? "ADMIN" : "MEMBER" })) },
    },
  });
  project = await app.prisma.project.create({
    data: {
      workspaceId: workspace.id,
      name: "SQL totals",
      members: { create: ["ADMIN", "USD", "EUR"].map((name) => ({ userId: users[name].id })) },
    },
  });
  // 1.005 rounds to 1.01 on each entry. Rounding the summed product once yields 2010, not 2020.
  await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: users.USD.id, rate: 1.005, currency: "USD", effectiveFrom: "2026-01-01" } });
  await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: users.EUR.id, rate: 1.005, currency: "EUR", effectiveFrom: "2026-01-01" } });
  await app.prisma.timeEntry.createMany({
    data: [
      ...Array.from({ length: ENTRY_COUNT }, (_, i) => ({
        workspaceId: workspace.id,
        userId: users.USD.id,
        projectId: project.id,
        date: "2026-01-15",
        hours: 1,
        billable: true,
        description: `usd ${i}`,
      })),
      { workspaceId: workspace.id, userId: users.EUR.id, projectId: project.id, date: "2026-01-16", hours: 1, billable: true, description: "eur 1" },
      { workspaceId: workspace.id, userId: users.EUR.id, projectId: project.id, date: "2026-01-16", hours: 1, billable: true, description: "eur 2" },
    ],
  });
});

after(async () => {
  try {
    if (app && workspace) await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (app) await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
  } finally {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  }
});

test("sql totals match per-entry rounding past entryLimit without loading every entry", async () => {
  const once = reportMoneyNumber(roundedCostUnits(ENTRY_COUNT, 1.005, 2), 2);
  const perEntryUnits = roundedCostUnits(1, 1.005, 2) * BigInt(ENTRY_COUNT);
  const perEntry = reportMoneyNumber(perEntryUnits, 2);
  assert.equal(once, 2010);
  assert.equal(perEntry, 2020);
  assert.notEqual(once, perEntry);

  const stored = await app.prisma.timeEntry.findMany({
    where: { workspaceId: workspace.id, userId: users.USD.id },
    select: { hours: true },
  });
  let units = 0n;
  const rate = (await app.prisma.userRate.findFirstOrThrow({ where: { userId: users.USD.id } })).rate;
  for (const row of stored) units += roundedCostUnits(row.hours, rate, 2);
  assert.equal(reportMoneyNumber(units, 2), perEntry);

  const originalFindMany = app.prisma.timeEntry.findMany.bind(app.prisma.timeEntry);
  const originalQueryRaw = app.prisma.$queryRaw.bind(app.prisma);
  const originalTransaction = app.prisma.$transaction.bind(app.prisma);
  let hoursLoaded = 0;
  const totalQueries = [];
  const watchRaw = (raw) => async (query, ...rest) => {
    const started = performance.now();
    const rows = await raw(query, ...rest);
    const text = sqlText(query);
    if (text.includes("report-totals")) {
      totalQueries.push({ rows: Array.isArray(rows) ? rows.length : null, ms: performance.now() - started });
    }
    return rows;
  };
  app.prisma.timeEntry.findMany = async (args) => {
    const rows = await originalFindMany(args);
    if (args?.select?.hours && args?.select?.billable) hoursLoaded += rows.length;
    return rows;
  };
  app.prisma.$queryRaw = watchRaw(originalQueryRaw);
  app.prisma.$transaction = (fn, options) => originalTransaction(async (tx) => {
    const raw = tx.$queryRaw.bind(tx);
    tx.$queryRaw = watchRaw(raw);
    return fn(tx);
  }, options);

  try {
    const response = await request("GET", `/api/workspaces/${workspace.id}/time/reports?startDate=2026-01-01&endDate=2026-01-31&entryLimit=${ENTRY_LIMIT}`);
    assert.equal(response.statusCode, 200, response.body);
    const report = response.json().data;
    const usd = report.groups.find((group) => group.key === users.USD.id);
    const eur = report.groups.find((group) => group.key === users.EUR.id);
    assert.ok(usd);
    assert.equal(usd.entries.length, ENTRY_LIMIT);
    assert.equal(usd.entryCount, ENTRY_COUNT);
    assert.equal(usd.totalCost, perEntry);
    assert.equal(eur.totalCost, 2.02);
    assert.equal(report.summary.totalCost, null);
    assert.deepEqual(report.summary.costByCurrency, [
      { currency: "EUR", amount: 2.02, fractionDigits: 2 },
      { currency: "USD", amount: perEntry, fractionDigits: 2 },
    ]);
    assert.ok(totalQueries.length >= 1, "report totals did not run as a SQL aggregate");
    const largest = Math.max(...totalQueries.map((query) => query.rows));
    assert.ok(largest < ENTRY_COUNT, `total query returned ${largest} rows for ${ENTRY_COUNT} entries`);
    assert.ok(hoursLoaded < ENTRY_COUNT, `report loaded ${hoursLoaded} entry rows`);
    assert.ok(usd.entries.every((entry) => entry.cost === 1.01));
  } finally {
    app.prisma.timeEntry.findMany = originalFindMany;
    app.prisma.$queryRaw = originalQueryRaw;
    app.prisma.$transaction = originalTransaction;
  }
});

test("an empty range totals zero and the csv lists every rounded entry", async () => {
  const empty = await request("GET", `/api/workspaces/${workspace.id}/time/reports?startDate=2027-01-01&endDate=2027-01-31&entryLimit=0`);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.json().data.summary.totalCost, 0);
  assert.equal(empty.json().data.summary.currency, null);
  assert.deepEqual(empty.json().data.summary.costByCurrency, []);
  assert.deepEqual(empty.json().data.groups, []);

  const exported = await request("GET", `/api/workspaces/${workspace.id}/time/reports/export?startDate=2026-01-01&endDate=2026-01-31&userIds=${users.USD.id}`);
  assert.equal(exported.statusCode, 200, exported.body);
  const lines = exported.body.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  assert.equal(lines.length, ENTRY_COUNT + 1);
  assert.equal(lines[1].split(",")[8].replaceAll('"', ""), "1.01");
  assert.equal(lines.at(-1).split(",")[8].replaceAll('"', ""), "1.01");
});
