import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseCsv, values } from "../fixtures/rfc4180.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "rounded-report-owned-signing-secret", COOKIE_SECRET: "rounded-report-owned-cookie-secret",
});
const storage = await mkdtemp(path.join(os.tmpdir(), "werkyn-rounded-report-"));
process.env.STORAGE_DIR = storage;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const facts = [];
function record(name, value) {
  facts.push({ name, ...value });
  if (process.env.TIME_COST_FACTS) writeFileSync(process.env.TIME_COST_FACTS, JSON.stringify(facts, null, 2) + "\n");
}
let app, workspace, foreignWorkspace, project;
const users = {}, tokens = {}, ids = {};
let requests = 0;
const actors = ["ADMIN", "MEMBER", "FOREIGN", "USD", "TIE", "BELOW", "ABOVE", "JPY", "KWD", "CLF", "HISTORY", "NONE", "ZERO", "LEGACY", "HUGE", "AGGREGATE"];
const request = (actor, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` },
  remoteAddress: `10.179.${Math.floor(++requests / 200)}.${requests % 200 + 1}`,
});
const url = () => `/api/workspaces/${workspace.id}/time/reports`;
function query(selected, extra = {}) {
  return new URLSearchParams({ startDate: "2026-01-01", endDate: "2026-01-31", userIds: selected.map((name) => users[name].id).join(","), ...extra });
}
async function rate(actor, amount, currency, date = "2026-01-01") {
  const response = await request("ADMIN", "POST", `/api/workspaces/${workspace.id}/time/rates/${users[actor].id}`, { rate: amount, currency, effectiveFrom: date });
  assert.equal(response.statusCode, 200, response.body);
}
async function entry(actor, name, hours, date = "2026-01-10", billable = true) {
  const response = await request(actor, "POST", `/api/workspaces/${workspace.id}/time/entries`, { date, hours, billable, projectId: project.id, description: name });
  assert.equal(response.statusCode, 201, response.body);
  ids[name] = response.json().data.id;
}
async function read(selected, extra = {}) {
  const response = await request("ADMIN", "GET", `${url()}?${query(selected, extra)}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}
async function csv(selected) {
  const response = await request("ADMIN", "GET", `${url()}/export?${query(selected)}`);
  assert.equal(response.statusCode, 200, response.body);
  return values(parseCsv(response.body.replace(/^\uFEFF/, ""))).slice(1);
}
const rows = (report) => report.groups.flatMap((group) => group.entries);
const semanticBuckets = (buckets) => buckets.map(({ currency, amount }) => ({ currency, amount }));
async function stored(selected) {
  const userId = { in: selected.map((name) => users[name].id) };
  return {
    rates: await app.prisma.userRate.findMany({ where: { workspaceId: workspace.id, userId }, orderBy: [{ userId: "asc" }, { effectiveFrom: "asc" }] }),
    entries: await app.prisma.timeEntry.findMany({ where: { workspaceId: workspace.id, userId }, orderBy: { id: "asc" } }),
  };
}

before(async () => {
  app = await buildApp(); await app.ready(); app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 16);
  for (const actor of actors) {
    users[actor] = await app.prisma.user.create({ data: { email: `rounded-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  }
  workspace = await app.prisma.workspace.create({ data: {
    name: "Rounded report owned", slug: `rounded-${suffix}`,
    members: { create: actors.filter((actor) => actor !== "FOREIGN").map((actor) => ({ userId: users[actor].id, role: actor === "ADMIN" ? "ADMIN" : "MEMBER" })) },
  } });
  foreignWorkspace = await app.prisma.workspace.create({ data: { name: "Rounded foreign owned", slug: `rounded-foreign-${suffix}`, members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } } } });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Rounded costs", members: { create: actors.filter((actor) => actor !== "FOREIGN").map((actor) => ({ userId: users[actor].id })) } } });
  for (const [actor, amount, currency] of [["USD", 33.33, "USD"], ["TIE", 1.005, "USD"], ["BELOW", 1.0049, "USD"], ["ABOVE", 1.0051, "USD"], ["JPY", 1.5, "JPY"], ["KWD", 1.2345, "KWD"], ["CLF", 1.23445, "CLF"], ["ZERO", 0, "JPY"]]) await rate(actor, amount, currency);
  for (let i = 1; i <= 3; i++) await entry("USD", `usd-${i}`, 0.1, `2026-01-0${i}`);
  for (const actor of ["TIE", "BELOW", "ABOVE", "JPY", "KWD", "CLF", "ZERO"]) await entry(actor, actor.toLowerCase(), 1);
  await rate("HISTORY", 10, "USD"); await rate("HISTORY", 20, "EUR", "2026-01-15"); await rate("HISTORY", 999, "GBP", "2026-03-01");
  await entry("HISTORY", "history-before", 1, "2026-01-14"); await entry("HISTORY", "history-on", 1, "2026-01-15");
  await entry("NONE", "missing", 3); await entry("NONE", "nonbillable", 2, "2026-01-11", false);
  await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: users.LEGACY.id, rate: 50, currency: "chf", effectiveFrom: "2026-01-01" } });
  await entry("LEGACY", "legacy-lower", 1);
  for (const [actor, amount, hours, count] of [["HUGE", 1e308, 24, 1], ["AGGREGATE", 4e13, 1, 3]]) {
    // These finite legacy values are deliberately beyond today's write cap.
    const rejected = await request("ADMIN", "POST", `/api/workspaces/${workspace.id}/time/rates/${users[actor].id}`, { rate: amount, currency: "USD", effectiveFrom: "2026-01-01" });
    assert.equal(rejected.statusCode, 400, rejected.body);
    await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: users[actor].id, rate: amount, currency: "USD", effectiveFrom: "2026-01-01" } });
    for (let i = 1; i <= count; i++) await entry(actor, `${actor}-${i}`, hours, `2026-01-0${i}`);
  }
  record("owned-fixture-ready", { users: actors.length, entries: Object.keys(ids).length });
});

after(async () => {
  try {
    if (app && workspace) await app.prisma.workspace.deleteMany({ where: { id: { in: [workspace.id, foreignWorkspace?.id].filter(Boolean) } } });
    if (app) await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
  } finally { await app?.close(); await rm(storage, { recursive: true, force: true }); record("owned-cleanup-settled", {}); }
});

test("rounded USD rows are the same amounts summed by every grouping and exported", async () => {
  const reports = await Promise.all(["user", "project", "date"].map((groupBy) => read(["USD"], { groupBy })));
  const exported = await csv(["USD"]);
  const narrow = await read(["USD"], { endDate: "2026-01-01" });
  record("usd-row-sums", { reports, exported, narrow });
  for (const report of reports) {
    assert.deepEqual(rows(report).map((row) => row.cost), [3.33, 3.33, 3.33]);
    assert.equal(report.summary.totalCost, 9.99);
    assert.deepEqual(semanticBuckets(report.summary.costByCurrency), [{ currency: "USD", amount: 9.99 }]);
    for (const group of report.groups) assert.equal(group.totalCost, group.entries.length === 3 ? 9.99 : 3.33);
  }
  assert.deepEqual(exported.map((row) => row[8]), ["3.33", "3.33", "3.33"]);
  assert.equal(rows(narrow)[0].cost, 3.33);
});

test("USD decimal ties round away from zero before returning row costs", async () => {
  const report = await read(["TIE", "BELOW", "ABOVE"]); const exported = await csv(["TIE", "BELOW", "ABOVE"]);
  record("usd-decimal-ties", { report, exported });
  const costs = Object.fromEntries(rows(report).map((row) => [row.userName, row.cost]));
  assert.deepEqual(costs, { TIE: 1.01, BELOW: 1, ABOVE: 1.01 });
  assert.equal(report.summary.totalCost, 3.02);
});

for (const [actor, expected, digits, text] of [["JPY", 2, 0, "2"], ["KWD", 1.235, 3, "1.235"], ["CLF", 1.2345, 4, "1.2345"]]) {
  test(`${actor} row, total and CSV use ${digits} currency fraction digits`, async () => {
    const report = await read([actor]); const exported = await csv([actor]);
    record(`${actor}-precision`, { report, exported });
    assert.equal(rows(report)[0].cost, expected);
    assert.equal(report.summary.totalCost, expected);
    assert.equal(exported[0][8], text);
    assert.equal(rows(report)[0].costFractionDigits, digits);
    assert.equal(report.summary.costByCurrency[0].fractionDigits, digits);
  });
}

test("historical mixed, lowercase, zero, missing and nonbillable semantics remain", async () => {
  const report = await read(["HISTORY", "NONE", "ZERO", "LEGACY"]);
  record("retained-cost-semantics", { report });
  const byId = new Map(rows(report).map((row) => [row.id, row]));
  assert.equal(byId.get(ids["history-before"]).cost, 10); assert.equal(byId.get(ids["history-on"]).cost, 20);
  assert.equal(byId.get(ids.missing).cost, null); assert.equal(byId.get(ids.nonbillable).cost, 0);
  assert.equal(byId.get(ids["legacy-lower"]).currency, "CHF");
  assert.deepEqual(semanticBuckets(report.summary.costByCurrency), [{ currency: "CHF", amount: 50 }, { currency: "EUR", amount: 20 }, { currency: "JPY", amount: 0 }, { currency: "USD", amount: 10 }]);
  assert.equal(report.summary.totalCost, null); assert.equal(report.summary.currency, null); assert.equal(report.summary.unratedBillableHours, 3);
});

test("empty reports and member or foreign report boundaries remain", async () => {
  const report = await read(["USD"], { startDate: "2027-01-01", endDate: "2027-01-31" });
  const denials = [];
  for (const actor of ["MEMBER", "FOREIGN"]) for (const suffix of ["", "/export"]) denials.push((await request(actor, "GET", `${url()}${suffix}?${query(["USD"])}`)).statusCode);
  record("retained-empty-boundaries", { report, denials });
  assert.equal(report.summary.totalCost, 0); assert.equal(report.summary.currency, null); assert.deepEqual(report.summary.costByCurrency, []); assert.deepEqual(report.groups, []);
  assert.deepEqual(denials, [403, 403, 403, 403]);
});

for (const [actor, title] of [["HUGE", "unrepresentable row"], ["AGGREGATE", "unrepresentable aggregate of individually safe rows"]]) {
  test(`${title} refuses both report and CSV without changing stored inputs`, async () => {
    const beforeRows = await stored([actor]);
    const report = await request("ADMIN", "GET", `${url()}?${query([actor])}`);
    const exported = await request("ADMIN", "GET", `${url()}/export?${query([actor])}`);
    const afterRows = await stored([actor]);
    record(`${actor}-representability`, { reportStatus: report.statusCode, report: report.json(), csvStatus: exported.statusCode, csv: exported.body, unchanged: JSON.stringify(beforeRows) === JSON.stringify(afterRows) });
    assert.deepEqual(afterRows, beforeRows);
    assert.equal(report.statusCode, 400, report.body);
    assert.equal(exported.statusCode, 400, exported.body);
  });
}

for (const currency of ["ZZZ", "1$X"]) {
  test(`stored ${currency} currency retains its two-digit report and CSV fallback`, async () => {
    const actor = `FALLBACK-${currency}`;
    users[actor] = await app.prisma.user.create({ data: {
      email: `rounded-fallback-${crypto.randomUUID()}@example.test`, displayName: actor, emailVerified: true,
    } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
    await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: users[actor].id, role: "MEMBER" } });
    await app.prisma.projectMember.create({ data: { projectId: project.id, userId: users[actor].id } });
    await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: users[actor].id,
      rate: 1.005, currency, effectiveFrom: "2026-01-01" } });
    await entry(actor, actor, 1);
    const report = await read([actor]); const exported = await csv([actor]);
    record(`${currency}-fallback`, { report, exported });
    assert.equal(rows(report)[0].cost, 1.01);
    assert.equal(rows(report)[0].costFractionDigits, 2);
    assert.deepEqual(report.summary.costByCurrency, [{ currency, amount: 1.01, fractionDigits: 2 }]);
    assert.equal(exported[0][8], "1.01");
    const saved = await stored([actor]);
    assert.equal(saved.rates[0].currency, currency); assert.equal(saved.rates[0].rate, 1.005);
  });
}
