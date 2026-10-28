import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "time-report-rates-test-signing-secret", COOKIE_SECRET: "time-report-rates-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-time-report-rates-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

let app, workspace, project;
const users = {}, tokens = {}, entries = {};
let requests = 0;
const req = (actor, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` },
  remoteAddress: `10.71.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
});
const reportUrl = () => `/api/workspaces/${workspace.id}/time/reports`;

async function setRate(actor, body) {
  const response = await req("ADMIN", "POST", `/api/workspaces/${workspace.id}/time/rates/${users[actor].id}`, body);
  assert.equal(response.statusCode, 200, response.body);
}
async function logTime(actor, name, body) {
  const response = await req(actor, "POST", `/api/workspaces/${workspace.id}/time/entries`, {
    projectId: project.id, billable: true, ...body, description: name,
  });
  assert.equal(response.statusCode, 201, response.body);
  entries[name] = response.json().data.id;
}
async function report(query) {
  const response = await req("ADMIN", "GET", `${reportUrl()}?${new URLSearchParams(query)}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}
function entriesById(data) {
  return new Map(data.groups.flatMap((group) => group.entries).map((entry) => [entry.id, entry]));
}
function priced(entry) {
  return { rate: entry.rate, currency: entry.currency, cost: entry.cost };
}

before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 20);
  for (const actor of ["ADMIN", "ALICE", "BOB", "CARLA", "DAN", "EVE"]) {
    users[actor] = await app.prisma.user.create({ data: {
      email: `time-rates-${actor}-${suffix}@example.test`, displayName: actor, emailVerified: true,
    } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Time report rates", slug: `trates-${suffix}`, members: { create: [
    { userId: users.ADMIN.id, role: "ADMIN" }, { userId: users.ALICE.id, role: "MEMBER" },
    { userId: users.BOB.id, role: "MEMBER" }, { userId: users.CARLA.id, role: "MEMBER" },
    { userId: users.DAN.id, role: "MEMBER" }, { userId: users.EVE.id, role: "MEMBER" },
  ] } } });
  project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: "Rated work",
    members: { create: ["ALICE", "BOB", "CARLA", "DAN"].map((actor) => ({ userId: users[actor].id })) },
  } });

  // ALICE: USD rate changes inside January, plus a rate that only starts after every entry.
  await setRate("ALICE", { rate: 10, currency: "USD", effectiveFrom: "2025-12-01" });
  await setRate("ALICE", { rate: 20, currency: "USD", effectiveFrom: "2026-01-15" });
  await setRate("ALICE", { rate: 50, currency: "USD", effectiveFrom: "2026-03-01" });
  // BOB: no rate before 2026-01-20.
  await setRate("BOB", { rate: 30, currency: "USD", effectiveFrom: "2026-01-20" });
  // CARLA: a different currency.
  await setRate("CARLA", { rate: 100, currency: "EUR", effectiveFrom: "2026-01-01" });

  await logTime("ALICE", "alice-before-change", { date: "2026-01-10", hours: 1 });
  await logTime("ALICE", "alice-change-day", { date: "2026-01-15", hours: 1.5 });
  await logTime("ALICE", "alice-after-change", { date: "2026-01-31", hours: 2 });
  await logTime("ALICE", "alice-non-billable", { date: "2026-01-12", hours: 3, billable: false });
  await logTime("ALICE", "alice-february", { date: "2026-02-10", hours: 1 });
  await logTime("BOB", "bob-unrated", { date: "2026-01-05", hours: 4 });
  await logTime("BOB", "bob-rated", { date: "2026-01-25", hours: 1 });
  await logTime("CARLA", "carla-euro", { date: "2026-01-20", hours: 0.5 });
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.timeEntry.deleteMany({ where: { workspaceId: workspace.id } });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

test("each entry is priced at the latest rate effective on its own date", async () => {
  const data = await report({ startDate: "2026-01-01", endDate: "2026-01-31", userIds: users.ALICE.id });
  const byId = entriesById(data);
  assert.deepEqual(priced(byId.get(entries["alice-before-change"])), { rate: 10, currency: "USD", cost: 10 });
  assert.deepEqual(priced(byId.get(entries["alice-change-day"])), { rate: 20, currency: "USD", cost: 30 }, "same-day boundary");
  assert.deepEqual(priced(byId.get(entries["alice-after-change"])), { rate: 20, currency: "USD", cost: 40 });
  assert.deepEqual(priced(byId.get(entries["alice-non-billable"])), { rate: 10, currency: "USD", cost: 0 });
  assert.equal(data.summary.totalCost, 80);
  assert.equal(data.summary.currency, "USD");
  assert.deepEqual(data.summary.costByCurrency, [{ currency: "USD", amount: 80 }]);
  assert.equal(data.summary.unratedBillableHours, 0);
  assert.equal(data.summary.totalHours, 7.5);
});

test("entry cost does not depend on the selected report end date or future rates", async () => {
  const narrow = entriesById(await report({ startDate: "2026-01-01", endDate: "2026-01-14", userIds: users.ALICE.id }));
  const wide = entriesById(await report({ startDate: "2026-01-01", endDate: "2026-12-31", userIds: users.ALICE.id }));
  for (const name of ["alice-before-change", "alice-non-billable"]) {
    assert.deepEqual(priced(narrow.get(entries[name])), priced(wide.get(entries[name])), name);
  }
  // The 2026-03-01 rate exists before the wide report end date but after every entry.
  assert.deepEqual(priced(wide.get(entries["alice-february"])), { rate: 20, currency: "USD", cost: 20 });
  assert.deepEqual(priced(narrow.get(entries["alice-before-change"])), { rate: 10, currency: "USD", cost: 10 });
});

test("entries without an effective rate are left unpriced and reported as unrated hours", async () => {
  const data = await report({ startDate: "2026-01-01", endDate: "2026-01-31", userIds: users.BOB.id });
  const byId = entriesById(data);
  assert.deepEqual(priced(byId.get(entries["bob-unrated"])), { rate: null, currency: null, cost: null });
  assert.deepEqual(priced(byId.get(entries["bob-rated"])), { rate: 30, currency: "USD", cost: 30 });
  assert.equal(data.summary.totalCost, 30);
  assert.equal(data.summary.currency, "USD");
  assert.equal(data.summary.unratedBillableHours, 4);
  const [group] = data.groups;
  assert.equal(group.unratedBillableHours, 4);
  assert.equal(group.billableHours, 5);

  const onlyUnrated = await report({ startDate: "2026-01-01", endDate: "2026-01-10", userIds: users.BOB.id });
  assert.equal(onlyUnrated.summary.totalCost, 0);
  assert.equal(onlyUnrated.summary.currency, null);
  assert.deepEqual(onlyUnrated.summary.costByCurrency, []);
  assert.equal(onlyUnrated.summary.unratedBillableHours, 4);
});

test("totals in different currencies are kept apart instead of being added together", async () => {
  const data = await report({ startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "project" });
  const byId = entriesById(data);
  assert.deepEqual(priced(byId.get(entries["carla-euro"])), { rate: 100, currency: "EUR", cost: 50 });
  assert.equal(data.summary.totalCost, null);
  assert.equal(data.summary.currency, null);
  assert.deepEqual(data.summary.costByCurrency, [
    { currency: "EUR", amount: 50 }, { currency: "USD", amount: 110 },
  ]);
  assert.equal(data.summary.unratedBillableHours, 4);
  const [group] = data.groups;
  assert.equal(group.label, project.name);
  assert.equal(group.totalCost, null);
  assert.deepEqual(group.costByCurrency, data.summary.costByCurrency);

  const byUser = await report({ startDate: "2026-01-01", endDate: "2026-01-31", groupBy: "user" });
  const carla = byUser.groups.find((group) => group.key === users.CARLA.id);
  assert.equal(carla.totalCost, 50);
  assert.equal(carla.currency, "EUR");
  const alice = byUser.groups.find((group) => group.key === users.ALICE.id);
  assert.equal(alice.totalCost, 80);
  assert.equal(alice.currency, "USD");

  const byDate = await report({ startDate: "2026-01-20", endDate: "2026-01-20", groupBy: "date" });
  assert.deepEqual(byDate.groups.map((group) => [group.key, group.totalCost, group.currency]), [["2026-01-20", 50, "EUR"]]);
});

test("billable filter and CSV export use the same per-entry rate and currency", async () => {
  const nonBillable = await report({ startDate: "2026-01-01", endDate: "2026-01-31", billable: "false" });
  assert.deepEqual(nonBillable.summary.costByCurrency, []);
  assert.equal(nonBillable.summary.totalCost, 0);

  const response = await req("ADMIN", "GET", `${reportUrl()}/export?startDate=2026-01-01&endDate=2026-01-31`);
  assert.equal(response.statusCode, 200, response.body);
  const lines = response.body.trim().split(/\r?\n/);
  assert.match(lines[0], /^\uFEFF?"?Date"?,"?User"?,"?Project"?,"?Task"?,"?Hours"?,"?Billable"?,"?Rate"?,"?Currency"?,"?Cost"?,"?Description"?$/);
  // Fixture values contain no commas, quotes or line breaks, so a plain split is exact here.
  const row = (name) => lines.find((line) => line.endsWith(`"${name}"`))?.split(",");
  const cells = (name) => row(name).slice(6, 9).map((cell) => cell.replace(/^"|"$/g, ""));
  assert.deepEqual(cells("alice-before-change"), ["10.00", "USD", "10.00"]);
  assert.deepEqual(cells("alice-after-change"), ["20.00", "USD", "40.00"]);
  assert.deepEqual(cells("carla-euro"), ["100.00", "EUR", "50.00"]);
  assert.deepEqual(cells("bob-unrated"), ["", "", ""]);
});

test("rate and report routes keep their admin-only boundary", async () => {
  for (const actor of ["ALICE", "BOB"]) {
    assert.equal((await req(actor, "GET", `${reportUrl()}?startDate=2026-01-01&endDate=2026-01-31`)).statusCode, 403);
    assert.equal((await req(actor, "GET", `${reportUrl()}/export?startDate=2026-01-01&endDate=2026-01-31`)).statusCode, 403);
    assert.equal((await req(actor, "POST", `/api/workspaces/${workspace.id}/time/rates/${users[actor].id}`, { rate: 999 })).statusCode, 403);
  }
});

test("a new rate keeps the member's currency unless a valid currency code is supplied", async () => {
  // A future-dated rate in another currency does not decide today's currency.
  await setRate("EVE", { rate: 9, currency: "EUR", effectiveFrom: "2099-01-01" });
  await setRate("EVE", { rate: 5 });
  await setRate("DAN", { rate: 40, currency: "chf", effectiveFrom: "2026-01-01" });
  await setRate("DAN", { rate: 45, effectiveFrom: "2026-02-01" });
  const stored = (actor) => app.prisma.userRate.findMany({
    where: { workspaceId: workspace.id, userId: users[actor].id }, orderBy: { effectiveFrom: "asc" },
  }).then((rows) => rows.map((row) => [row.effectiveFrom, row.rate, row.currency]));
  assert.deepEqual((await stored("EVE")).map(([, rate, currency]) => [rate, currency]), [[5, "USD"], [9, "EUR"]]);
  assert.deepEqual(await stored("DAN"), [["2026-01-01", 40, "CHF"], ["2026-02-01", 45, "CHF"]]);
  for (const currency of ["U$D", "EURO", "12", ""]) {
    const response = await req("ADMIN", "POST", `/api/workspaces/${workspace.id}/time/rates/${users.DAN.id}`, {
      rate: 1, currency, effectiveFrom: "2026-03-01",
    });
    assert.equal(response.statusCode, 400, `${currency}: ${response.body}`);
  }
  assert.equal((await stored("DAN")).length, 2);

  // A legacy lower-case row shares the upper-case bucket instead of becoming a second currency.
  await app.prisma.userRate.create({ data: {
    workspaceId: workspace.id, userId: users.DAN.id, rate: 50, currency: "chf", effectiveFrom: "2026-02-10",
  } });
  await logTime("DAN", "dan-before-legacy", { date: "2026-02-05", hours: 1 });
  await logTime("DAN", "dan-legacy", { date: "2026-02-12", hours: 1 });
  const data = await report({ startDate: "2026-02-01", endDate: "2026-02-28", userIds: users.DAN.id });
  const byId = entriesById(data);
  assert.deepEqual(priced(byId.get(entries["dan-before-legacy"])), { rate: 45, currency: "CHF", cost: 45 });
  assert.deepEqual(priced(byId.get(entries["dan-legacy"])), { rate: 50, currency: "CHF", cost: 50 });
  assert.deepEqual(data.summary.costByCurrency, [{ currency: "CHF", amount: 95 }]);
  assert.equal(data.summary.totalCost, 95);
  assert.equal(data.summary.currency, "CHF");
});
