import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "contract-validation-test-signing-secret", COOKIE_SECRET: "contract-validation-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-contract-validation-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { Prisma } = await import("@prisma/client");

let app, user, token, workspace, project, status, template;
let requests = 0;
const headers = () => ({ authorization: `Bearer ${token}` });
const remoteAddress = () => `10.73.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`;
const req = (method, url, payload) => app.inject({ method, url, payload, headers: headers(), remoteAddress: remoteAddress() });
// Sends the body text as-is, so numbers such as 1e400 reach the JSON parser unchanged.
const rawJson = (method, url, body) => app.inject({
  method, url, payload: body, headers: { ...headers(), "content-type": "application/json" }, remoteAddress: remoteAddress(),
});

// Text a client must never see in an error response.
const INTERNALS = /prisma|invocation|\.ts:\d|node_modules|invalid byte sequence|ConnectorError|stack|secret-internal/i;

function assertRejected(response, field) {
  assert.equal(response.statusCode, 400, response.body);
  const body = response.json();
  assert.equal(body.message, "Validation failed", response.body);
  if (field) assert.ok(body.details.some((detail) => detail.field === field), `${field}: ${response.body}`);
  assert.doesNotMatch(response.body, INTERNALS);
}
// Runs every case and reports all that are not rejected, instead of stopping at the first.
async function expectAllRejected(cases) {
  const failures = [];
  for (const [label, send, field] of cases) {
    const response = await send();
    try {
      assertRejected(response, field);
    } catch {
      failures.push(`${label} -> ${response.statusCode} ${response.body.slice(0, 160)}`);
    }
  }
  assert.deepEqual(failures, []);
}
function assertStatus(response, statusCode) {
  assert.equal(response.statusCode, statusCode, response.body);
  return response.json().data;
}

const entriesUrl = () => `/api/workspaces/${workspace.id}/time/entries`;
const reportUrl = (query) => `/api/workspaces/${workspace.id}/time/reports?${new URLSearchParams(query)}`;
const exportUrl = (query) => `/api/workspaces/${workspace.id}/time/reports/export?${new URLSearchParams(query)}`;
const rateUrl = () => `/api/workspaces/${workspace.id}/time/rates/${user.id}`;
const recurringUrl = (id = "") => `/api/projects/${project.id}/recurring${id ? `/${id}` : ""}`;

before(async () => {
  app = await buildApp();
  // Test-only routes that throw the Prisma error classes the error handler must translate.
  const clientVersion = Prisma.prismaVersion.client;
  const known = (code) => new Prisma.PrismaClientKnownRequestError(
    `secret-internal ${code} at /srv/app/src/modules/x.ts:12 invocation`,
    { code, clientVersion, meta: { target: ["secret-internal-column"] } },
  );
  app.get("/__contract/prisma/:kind", async (request) => {
    const { kind } = request.params;
    if (kind === "unknown") {
      throw new Prisma.PrismaClientUnknownRequestError("secret-internal ConnectorError invocation", { clientVersion });
    }
    if (kind === "validation") {
      throw new Prisma.PrismaClientValidationError("secret-internal Argument `rate`: invocation", { clientVersion });
    }
    throw known(kind);
  });
  await app.ready();
  app.broadcast = () => {};

  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({ data: {
    email: `contract-${suffix}@example.test`, displayName: "Contract fixture", emailVerified: true,
  } });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({ data: {
    name: "Contract fixture", slug: `contract-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } },
  } });
  project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: "Contract fixture", members: { create: { userId: user.id } },
  } });
  status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  template = await app.prisma.taskTemplate.create({ data: { projectId: project.id, name: "Weekly report", title: "Weekly report" } });
});

after(async () => {
  if (workspace) {
    await app.prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
  }
  if (user) await app.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await app?.close();
  await rm(storageDir, { recursive: true, force: true });
});

// ─── DAT-016: date-only fields ──────────────────────────────────────────

const IMPOSSIBLE_DATES = [
  "2026-02-31", "2027-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-10",
  "2026-01-00", "2026-01-32", "0099-01-12", "0000-01-01", "1899-12-31", "3000-01-01", "2026-1-01", "2026-03-01\n",
];
const REAL_DATES = ["2028-02-29", "2000-02-29", "1900-01-01", "2999-12-31", "2026-12-31", "2026-01-31"];

test("time entry dates must be real calendar dates between 1900 and 2999", async () => {
  await expectAllRejected(IMPOSSIBLE_DATES.map((date) => [
    date, () => req("POST", entriesUrl(), { date, hours: 1, projectId: project.id }), "date",
  ]));
  for (const date of REAL_DATES) {
    const entry = assertStatus(await req("POST", entriesUrl(), { date, hours: 1, projectId: project.id }), 201);
    assert.equal(entry.date, date);
    assert.equal((await req("DELETE", `/api/time/entries/${entry.id}`)).statusCode, 204);
  }
});

test("every date-only input rejects impossible and ancient dates", async () => {
  const task = assertStatus(await req("POST", `/api/projects/${project.id}/tasks`, { title: "Dated", statusId: status.id }), 201);
  const entry = assertStatus(await req("POST", entriesUrl(), { date: "2026-03-15", hours: 1, projectId: project.id }), 201);
  const recurring = assertStatus(await req("POST", recurringUrl(), {
    templateId: template.id, frequency: "DAILY", startDate: "2026-03-15",
  }), 201);

  for (const bad of ["2026-02-31", "0099-01-12"]) {
    await expectAllRejected([
      [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "x", dueDate: bad }), "dueDate"],
      [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "x", startDate: bad }), "startDate"],
      [() => req("PATCH", `/api/tasks/${task.id}`, { dueDate: bad }), "dueDate"],
      [() => req("PATCH", `/api/tasks/${task.id}`, { startDate: bad }), "startDate"],
      [() => req("POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [task.id], dueDate: bad }), "dueDate"],
      [() => req("POST", `/api/tasks/${task.id}/subtasks`, { title: "x", dueDate: bad }), "dueDate"],
      [() => req("POST", `/api/projects/${project.id}/templates/${template.id}/create-task`, { dueDate: bad }), "dueDate"],
      [() => req("PATCH", `/api/time/entries/${entry.id}`, { date: bad }), "date"],
      [() => req("POST", rateUrl(), { rate: 10, effectiveFrom: bad }), "effectiveFrom"],
      [() => req("GET", `${entriesUrl()}?startDate=${bad}&endDate=2026-12-31`), "startDate"],
      [() => req("GET", reportUrl({ startDate: "2026-01-01", endDate: bad })), "endDate"],
      [() => req("GET", exportUrl({ startDate: bad, endDate: "2026-12-31" })), "startDate"],
      [() => req("GET", `/api/projects/${project.id}/tasks?dueBefore=${bad}`), "dueBefore"],
      [() => req("POST", recurringUrl(), { templateId: template.id, frequency: "DAILY", startDate: bad }), "startDate"],
      [() => req("POST", recurringUrl(), { templateId: template.id, frequency: "DAILY", startDate: "2026-03-15", endDate: bad }), "endDate"],
      [() => req("PATCH", recurringUrl(recurring.id), { endDate: bad }), "endDate"],
    ].map(([send, field]) => [`${field} ${bad} ${send.toString().slice(12, 60)}`, send, field]));
  }

  // The same inputs with real dates are accepted.
  assertStatus(await req("PATCH", `/api/tasks/${task.id}`, { dueDate: "2028-02-29", startDate: "2028-02-01" }), 200);
  assertStatus(await req("POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [task.id], dueDate: "2026-04-30" }), 200);
  assertStatus(await req("POST", `/api/tasks/${task.id}/subtasks`, { title: "x", dueDate: "2026-04-30" }), 201);
  assertStatus(await req("POST", `/api/projects/${project.id}/templates/${template.id}/create-task`, { dueDate: "2026-06-30" }), 201);
  assertStatus(await req("PATCH", `/api/time/entries/${entry.id}`, { date: "2026-02-28" }), 200);
  assertStatus(await req("GET", reportUrl({ startDate: "2026-01-01", endDate: "2026-12-31" })), 200);
  assertStatus(await req("GET", `/api/projects/${project.id}/tasks?dueBefore=2028-02-29`), 200);
  assertStatus(await req("PATCH", recurringUrl(recurring.id), { endDate: "2026-12-31" }), 200);
  assert.equal(await (await req("GET", exportUrl({ startDate: "2026-01-01", endDate: "2026-12-31" }))).statusCode, 200);
});

test("custom field DATE values follow the same calendar-date contract", async () => {
  const task = assertStatus(await req("POST", `/api/projects/${project.id}/tasks`, { title: "Custom date" }), 201);
  const field = assertStatus(await req("POST", `/api/projects/${project.id}/custom-fields`, { name: "Launch", type: "DATE" }), 201);
  const url = `/api/projects/${project.id}/tasks/${task.id}/custom-fields/${field.id}`;
  for (const value of ["2026-02-31", "0202-03-15", "2026-3-1", "2026-03-01\n"]) {
    const response = await req("PUT", url, { value });
    assert.equal(response.statusCode, 400, `${JSON.stringify(value)}: ${response.body}`);
    assert.match(response.json().message, /real calendar date/);
  }
  assertStatus(await req("PUT", url, { value: "2028-02-29" }), 200);
  assertStatus(await req("PUT", url, { value: null }), 200);
});

// ─── DAT-017: recurrence edits ─────────────────────────────────────────

test("recurrence edits keep the day each frequency requires", async () => {
  const create = async (body) => assertStatus(await req("POST", recurringUrl(), {
    templateId: template.id, startDate: "2026-03-02", ...body,
  }), 201);
  const daily = await create({ frequency: "DAILY" });
  const weekly = await create({ frequency: "WEEKLY", dayOfWeek: 3 });
  const monthly = await create({ frequency: "MONTHLY", dayOfMonth: 15 });

  // Create already requires the day; edits must not lose it either.
  await expectAllRejected([
    ["create MONTHLY without day", () => req("POST", recurringUrl(), { templateId: template.id, startDate: "2026-03-02", frequency: "MONTHLY" }), "dayOfMonth"],
    ["DAILY -> MONTHLY", () => req("PATCH", recurringUrl(daily.id), { frequency: "MONTHLY" }), "dayOfMonth"],
    ["DAILY -> WEEKLY", () => req("PATCH", recurringUrl(daily.id), { frequency: "WEEKLY" }), "dayOfWeek"],
    ["DAILY -> BIWEEKLY day null", () => req("PATCH", recurringUrl(daily.id), { frequency: "BIWEEKLY", dayOfWeek: null }), "dayOfWeek"],
    ["WEEKLY -> MONTHLY", () => req("PATCH", recurringUrl(weekly.id), { frequency: "MONTHLY" }), "dayOfMonth"],
    ["WEEKLY clear dayOfWeek", () => req("PATCH", recurringUrl(weekly.id), { dayOfWeek: null }), "dayOfWeek"],
    ["MONTHLY clear dayOfMonth", () => req("PATCH", recurringUrl(monthly.id), { dayOfMonth: null }), "dayOfMonth"],
    ["MONTHLY -> WEEKLY", () => req("PATCH", recurringUrl(monthly.id), { frequency: "WEEKLY", dayOfMonth: null }), "dayOfWeek"],
  ]);

  const stored = await app.prisma.recurringTaskConfig.findMany({
    where: { id: { in: [daily.id, weekly.id, monthly.id] } }, orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(stored.map((row) => [row.frequency, row.dayOfWeek, row.dayOfMonth]), [
    ["DAILY", null, null], ["WEEKLY", 3, null], ["MONTHLY", null, 15],
  ]);

  // Equivalent valid edits: the day is sent, or the stored row already has it.
  let row = assertStatus(await req("PATCH", recurringUrl(weekly.id), { frequency: "BIWEEKLY" }), 200);
  assert.deepEqual([row.frequency, row.dayOfWeek], ["BIWEEKLY", 3]);
  row = assertStatus(await req("PATCH", recurringUrl(daily.id), { frequency: "MONTHLY", dayOfMonth: 10 }), 200);
  assert.deepEqual([row.frequency, row.dayOfMonth], ["MONTHLY", 10]);
  row = assertStatus(await req("PATCH", recurringUrl(monthly.id), { frequency: "DAILY", dayOfMonth: null }), 200);
  assert.deepEqual([row.frequency, row.dayOfMonth], ["DAILY", null]);
  row = assertStatus(await req("PATCH", recurringUrl(monthly.id), { dayOfWeek: null }), 200);
  row = assertStatus(await req("PATCH", recurringUrl(weekly.id), { frequency: "WEEKLY", dayOfWeek: 5 }), 200);
  assert.deepEqual([row.frequency, row.dayOfWeek], ["WEEKLY", 5]);

  // A row saved before this check without its day can still be paused, and
  // supplying the day repairs it.
  const legacy = await app.prisma.recurringTaskConfig.create({ data: {
    projectId: project.id, templateId: template.id, frequency: "MONTHLY", startDate: "2026-03-02", nextRunDate: "2026-04-01",
  } });
  row = assertStatus(await req("PATCH", recurringUrl(legacy.id), { isActive: false }), 200);
  assert.equal(row.isActive, false);
  assertRejected(await req("PATCH", recurringUrl(legacy.id), { frequency: "MONTHLY" }), "dayOfMonth");
  row = assertStatus(await req("PATCH", recurringUrl(legacy.id), { dayOfMonth: 20 }), 200);
  assert.equal(row.dayOfMonth, 20);
});

// ─── SEC-020: text and number limits ───────────────────────────────────

test("text inputs reject NUL and control characters with a 400", async () => {
  const task = assertStatus(await req("POST", `/api/projects/${project.id}/tasks`, { title: "Plain" }), 201);
  const entry = assertStatus(await req("POST", entriesUrl(), { date: "2026-03-16", hours: 1, projectId: project.id }), 201);
  await expectAllRejected([
    [() => req("PATCH", "/api/users/me", { displayName: "Ann\u0000Lee" }), "displayName"],
    [() => req("PATCH", "/api/users/me", { jobTitle: "Ops\u0007" }), "jobTitle"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "T\u0000" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "two\nlines" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "trailing\n" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "\n" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "esc \u001b[31m" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/tasks`, { title: "ok", description: "<p>x\u0000</p>" }), "description"],
    [() => req("PATCH", `/api/tasks/${task.id}`, { description: "<p>\u0000</p>" }), "description"],
    [() => req("PATCH", `/api/tasks/${task.id}`, { title: "\u0000" }), "title"],
    [() => req("POST", entriesUrl(), { date: "2026-03-16", hours: 1, description: "bad\u0000" }), "description"],
    [() => req("PATCH", `/api/time/entries/${entry.id}`, { description: "form\u000cfeed" }), "description"],
    [() => req("POST", `/api/workspaces/${workspace.id}/projects`, { name: "P\u0000" }), "name"],
    [() => req("POST", `/api/tasks/${task.id}/subtasks`, { title: "S\u0000" }), "title"],
    [() => req("POST", `/api/projects/${project.id}/templates`, { name: "N", title: "T", subtasks: [{ title: "x\u0000" }] }), "subtasks.0.title"],
    [() => req("GET", `/api/projects/${project.id}/tasks?search=%00`), "search"],
  ].map(([send, field]) => [`${field} ${send.toString().slice(12, 70)}`, send, field]));

  // Printable text, tabs and (where text is multi-line) line breaks still work.
  const ok = assertStatus(await req("POST", `/api/projects/${project.id}/tasks`, {
    title: "Tab\tseparated Zoë 李", description: "<p>line one</p>\n<p>line\ttwo</p>\r\n",
  }), 201);
  assert.equal(ok.title, "Tab\tseparated Zoë 李");
  assert.equal(assertStatus(await req("PATCH", "/api/users/me", { displayName: "Zoë Lee" }), 200).displayName, "Zoë Lee");
  assertStatus(await req("PATCH", `/api/time/entries/${entry.id}`, { description: "first line\nsecond line" }), 200);
  assert.equal(await (await req("GET", exportUrl({ startDate: "2026-01-01", endDate: "2026-12-31" }))).statusCode, 200);
});

test("numeric inputs must be finite and inside sane bounds", async () => {
  const task = assertStatus(await req("POST", `/api/projects/${project.id}/tasks`, { title: "Movable", statusId: status.id }), 201);
  const entry = assertStatus(await req("POST", entriesUrl(), { date: "2026-03-17", hours: 1, projectId: project.id }), 201);
  await expectAllRejected([
    [() => rawJson("POST", rateUrl(), '{"rate": 1e400, "currency": "USD"}'), "rate"],
    [() => rawJson("POST", rateUrl(), '{"rate": -1e400}'), "rate"],
    [() => req("POST", rateUrl(), { rate: 1e12 }), "rate"],
    [() => rawJson("POST", entriesUrl(), `{"date": "2026-03-17", "hours": 1e400}`), "hours"],
    [() => rawJson("PATCH", `/api/time/entries/${entry.id}`, '{"hours": 1e400}'), "hours"],
    [() => req("PATCH", `/api/tasks/${task.id}/move`, { statusId: status.id, position: 1e300 }), "position"],
    [() => req("POST", `/api/projects/${project.id}/templates`, { name: "N", title: "T", dueOffset: 1e300 }), "dueOffset"],
    [() => req("GET", `/api/projects/${project.id}/tasks?page=1e300`), "page"],
  ].map(([send, field]) => [`${field} ${send.toString().slice(12, 80)}`, send, field]));

  assert.equal(assertStatus(await req("POST", rateUrl(), { rate: 250.75, currency: "EUR", effectiveFrom: "2026-03-01" }), 200).rate, 250.75);
  assertStatus(await req("PATCH", `/api/tasks/${task.id}/move`, { statusId: status.id, position: 0 }), 200);
  assertStatus(await req("POST", `/api/projects/${project.id}/templates`, { name: "N", title: "T", dueOffset: 30 }), 201);
  assertStatus(await req("GET", `/api/projects/${project.id}/tasks?page=2`), 200);
});

// ─── SEC-020: error handler ────────────────────────────────────────────

test("database errors map to generic client errors without Prisma internals", async () => {
  // A wiki page body is free-form JSON; PostgreSQL cannot store U+0000 in jsonb.
  const space = assertStatus(await req("POST", `/api/workspaces/${workspace.id}/wiki/spaces`, { name: "Space" }), 201);
  const nulContent = await req("POST", `/api/wiki/spaces/${space.id}/pages`, {
    title: "Page", content: { type: "doc", content: [{ type: "text", text: "a\u0000b" }] },
  });
  const outcomes = { wikiNulContent: [nulContent.statusCode, INTERNALS.test(nulContent.body)] };
  const expected = { wikiNulContent: [400, false] };

  const mapped = { P2002: 409, P2003: 409, P2025: 404, P2000: 400, P2023: 500, validation: 500, unknown: 500 };
  for (const [kind, statusCode] of Object.entries(mapped)) {
    const response = await req("GET", `/__contract/prisma/${kind}`);
    outcomes[kind] = [response.statusCode, INTERNALS.test(response.body), Object.keys(response.json()).sort().join()];
    expected[kind] = [statusCode, false, "error,message,statusCode"];
  }
  assert.deepEqual(outcomes, expected);
});

// ─── SEC-020: legacy non-finite rows ───────────────────────────────────

test("time reports skip legacy non-finite hours and treat non-finite rates as unrated", async () => {
  const other = await app.prisma.user.create({ data: {
    email: `contract-legacy-${crypto.randomUUID()}@example.test`, displayName: "Legacy member", emailVerified: true,
  } });
  try {
    await app.prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: other.id, role: "MEMBER" } });
    await app.prisma.projectMember.create({ data: { projectId: project.id, userId: other.id } });
    await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: other.id, rate: 100, currency: "USD", effectiveFrom: "2027-05-01" } });
    const legacyRate = await app.prisma.userRate.create({ data: { workspaceId: workspace.id, userId: other.id, rate: 1, currency: "USD", effectiveFrom: "2027-05-10" } });
    const make = (date, hours, description) => app.prisma.timeEntry.create({ data: {
      workspaceId: workspace.id, userId: other.id, projectId: project.id, date, hours, billable: true, description,
    } });
    await make("2027-05-04", 2, "finite");
    const nan = await make("2027-05-05", 1, "nan");
    const inf = await make("2027-05-06", 1, "inf");
    const negInf = await make("2027-05-07", 1, "neg-inf");
    await make("2027-05-12", 1.5, "after-bad-rate");
    await app.prisma.$executeRaw`UPDATE "TimeEntry" SET hours = 'NaN'::float8 WHERE id = ${nan.id}`;
    await app.prisma.$executeRaw`UPDATE "TimeEntry" SET hours = 'Infinity'::float8 WHERE id = ${inf.id}`;
    await app.prisma.$executeRaw`UPDATE "TimeEntry" SET hours = '-Infinity'::float8 WHERE id = ${negInf.id}`;
    await app.prisma.$executeRaw`UPDATE "UserRate" SET rate = 'NaN'::float8 WHERE id = ${legacyRate.id}`;

    const query = { startDate: "2027-05-01", endDate: "2027-05-31", userIds: other.id };
    for (const groupBy of ["user", "project", "date"]) {
      const data = assertStatus(await req("GET", reportUrl({ ...query, groupBy })), 200);
      const entries = data.groups.flatMap((group) => group.entries);
      assert.deepEqual(entries.map((e) => [e.description, e.hours, e.rate, e.cost]), [
        ["finite", 2, 100, 200], ["after-bad-rate", 1.5, null, null],
      ], groupBy);
      assert.equal(data.summary.totalHours, 3.5);
      assert.equal(data.summary.skippedEntries, 3);
      assert.equal(data.summary.unratedBillableHours, 1.5);
      assert.deepEqual(data.summary.costByCurrency, [{ currency: "USD", amount: 200 }]);
    }
    const csv = await req("GET", exportUrl(query));
    assert.equal(csv.statusCode, 200, csv.body);
    assert.equal(csv.headers["x-skipped-entries"], "3");
    const rows = csv.body.replace(/^﻿/, "").trim().split("\r\n");
    assert.equal(rows.length, 3, csv.body);
    assert.doesNotMatch(csv.body, /NaN|Infinity/);
  } finally {
    await app.prisma.timeEntry.deleteMany({ where: { userId: other.id } });
    await app.prisma.userRate.deleteMany({ where: { userId: other.id } });
    await app.prisma.user.delete({ where: { id: other.id } }).catch(() => {});
  }
});
