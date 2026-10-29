import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// DAT-013: custom-field values must match their field's definition (type,
// options, required) on every write, and option changes must carry stored
// values along or clear them.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "custom-field-semantics-signing-secret", COOKIE_SECRET: "custom-field-semantics-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-custom-field-semantics-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
const { PrismaClient } = await import("@prisma/client");

let app, user, token, apiKey, workspace, project;
// Its own connection, so the lock probe never waits for the app pool that the
// blocked requests hold.
let observer;
const events = [];
let requests = 0;

const send = (auth, method, url, payload) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${auth}` },
  remoteAddress: `10.83.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
});
const req = (method, url, payload) => send(token, method, url, payload);
const fieldsUrl = () => `/api/projects/${project.id}/custom-fields`;
const fieldUrl = (field) => `${fieldsUrl()}/${field.id}`;
const valueUrl = (task, field) => `/api/projects/${project.id}/tasks/${task.id}/custom-fields/${field.id}`;

function body(response, statusCode = 200) {
  assert.equal(response.statusCode, statusCode, response.body);
  return response.json();
}
const data = (response, statusCode) => body(response, statusCode).data;
const createField = async (input) => data(await req("POST", fieldsUrl(), input), 201);
const createTask = async (title) => data(await req("POST", `/api/projects/${project.id}/tasks`, { title }), 201);
const setValue = async (task, field, value, auth = token) => data(await send(auth, "PUT", valueUrl(task, field), { value }));
async function storedValue(task, field) {
  const row = await app.prisma.customFieldValue.findUnique({ where: { taskId_fieldId: { taskId: task.id, fieldId: field.id } } });
  return row ? row.value : undefined;
}
const definition = (field) => app.prisma.customField.findUnique({
  where: { id: field.id }, select: { name: true, type: true, options: true, required: true },
});
const projectValues = () => app.prisma.customFieldValue.findMany({
  where: { task: { projectId: project.id } }, orderBy: { id: "asc" },
});
const projectFields = () => app.prisma.customField.findMany({ where: { projectId: project.id }, orderBy: { id: "asc" } });

/** Every request must get a 400 naming `value`, `options` or the input, with no row changed and no event sent. */
async function assertRejected(cases, { message } = {}) {
  const [values, fields] = await Promise.all([projectValues(), projectFields()]);
  events.length = 0;
  const failures = [];
  for (const [label, send] of cases) {
    const response = await send();
    const json = response.statusCode === 400 ? response.json() : null;
    if (!json || !Array.isArray(json.details) || json.details.length === 0 || (message && !message.test(json.message))) {
      failures.push(`${label} -> ${response.statusCode} ${response.body.slice(0, 200)}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(await projectValues(), values);
  assert.deepEqual(await projectFields(), fields);
  assert.deepEqual(events, []);
}

/** Resolves once a query of this database waits for a lock, or once `pending` settles (5 s at most). */
async function waitForLockWait(pending) {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) {
    const [{ waiting }] = await observer.$queryRaw`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

before(async () => {
  observer = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
  await observer.$connect();
  app = await buildApp(); await app.ready();
  app.broadcast = (...args) => events.push(args);
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({ data: { email: `fields-${suffix}@example.test`, displayName: "Field admin", emailVerified: true } });
  token = signAccessToken({ sub: user.id, email: user.email });
  workspace = await app.prisma.workspace.create({ data: {
    name: "Custom field workspace", slug: `fields-${suffix}`, members: { create: { userId: user.id, role: "ADMIN" } },
  } });
  project = await app.prisma.project.create({ data: { workspaceId: workspace.id, name: "Fields", members: { create: { userId: user.id } } } });
  await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  apiKey = data(await req("POST", "/api/api-keys", { name: "Custom field client" }), 201).key;
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: workspace?.id } });
      await app.prisma.user.deleteMany({ where: { id: user?.id } });
    }
  } finally {
    await observer?.$disconnect();
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("values are checked against the field type and options on session and API-key requests", async () => {
  const fields = {
    text: await createField({ name: "Notes", type: "TEXT" }),
    number: await createField({ name: "Estimate", type: "NUMBER" }),
    date: await createField({ name: "Launch", type: "DATE" }),
    url: await createField({ name: "Spec", type: "URL" }),
    checkbox: await createField({ name: "Approved", type: "CHECKBOX" }),
    select: await createField({ name: "Size", type: "SELECT", options: [{ value: "S" }, { value: "M" }] }),
    multi: await createField({ name: "Platforms", type: "MULTI_SELECT", options: [{ value: "web" }, { value: "ios" }, { value: "android" }] }),
  };
  const task = await createTask("Typed values");
  const invalid = [
    ["text", 5], ["text", true], ["text", ["a"]],
    ["number", "5"], ["number", true], ["number", [1]],
    ["date", "2026-02-31"], ["date", "next week"], ["date", 20260101],
    ["url", "javascript:alert(1)"], ["url", "JavaScript:alert(document.cookie)"], ["url", "java\tscript:alert(1)"],
    ["url", "data:text/html,<script>alert(1)</script>"], ["url", "vbscript:msgbox(1)"], ["url", "ftp://example.com/file"],
    ["url", "example.com"], ["url", "//example.com"], ["url", "https://"], ["url", "https:example.com"],
    ["url", "https://exa mple.com"], ["url", " https://example.com"], ["url", "https://example.com/\njavascript:alert(1)"],
    ["url", "https:\\\\example.com"], ["url", 42],
    ["checkbox", "true"], ["checkbox", 1],
    ["select", "L"], ["select", "s"], ["select", ["S"]], ["select", 1],
    ["multi", ["web", "desktop"]], ["multi", ["web", "web"]], ["multi", "web"], ["multi", [1]],
  ];
  for (const [authName, auth] of [["session", token], ["API key", apiKey]]) {
    await assertRejected(invalid.map(([key, value]) => [
      `${authName} ${key} ${JSON.stringify(value)}`,
      () => send(auth, "PUT", valueUrl(task, fields[key]), { value }),
    ]));
  }

  // Semantic errors name the field, so a toast in the task view is actionable.
  const unsafe = body(await req("PUT", valueUrl(task, fields.url), { value: "javascript:alert(1)" }), 400);
  assert.match(unsafe.message, /"Spec" must be an http or https URL/);
  assert.deepEqual(unsafe.details, [{ field: "value", message: unsafe.message }]);
  assert.match(body(await req("PUT", valueUrl(task, fields.select), { value: "L" }), 400).message, /"Size" must be one of its options/);
  assert.match(body(await req("PUT", valueUrl(task, fields.multi), { value: ["web", "web"] }), 400).message, /"Platforms" lists an option more than once/);
  assert.match(body(await req("PUT", valueUrl(task, fields.date), { value: "2026-02-31" }), 400).message, /real calendar date/);

  const valid = [
    ["text", "Plain text", token], ["number", 0, apiKey], ["number", -2.5, token], ["date", "2028-02-29", apiKey],
    ["url", "https://example.com/spec?id=1#top", token], ["url", "HTTP://EXAMPLE.COM:8080/a", apiKey],
    ["checkbox", false, token], ["select", "M", apiKey], ["multi", ["android", "web"], token],
  ];
  for (const [key, value, auth] of valid) {
    assert.deepEqual((await setValue(task, fields[key], value, auth)).value, value, key);
    assert.deepEqual(await storedValue(task, fields[key]), value, key);
  }

  // An empty string, blank text or an empty list is no value, the same as null.
  for (const [key, empty] of [["text", ""], ["text", "   "], ["multi", []], ["url", ""], ["select", ""]]) {
    if ((await storedValue(task, fields[key])) === undefined) await setValue(task, fields[key], valid.find(([k]) => k === key)[1]);
    assert.equal(await setValue(task, fields[key], empty), null, `${key} ${JSON.stringify(empty)}`);
    assert.equal(await storedValue(task, fields[key]), undefined, key);
  }
});

test("required fields reject empty values but never block task creation", async () => {
  const team = await createField({ name: "Team", type: "SELECT", options: [{ value: "Core" }, { value: "Infra" }], required: true });
  const ticket = await createField({ name: "Ticket", type: "TEXT", required: true });
  const regions = await createField({ name: "Regions", type: "MULTI_SELECT", options: [{ value: "eu" }, { value: "us" }], required: true });
  const approved = await createField({ name: "Signed off", type: "CHECKBOX", required: true });

  // Quick add, the full create dialog, templates (and the recurrence scheduler,
  // which instantiates templates) and bulk edits carry no custom-field values,
  // so required fields start empty instead of rejecting the task.
  const quick = await createTask("Quick add");
  const full = data(await req("POST", `/api/projects/${project.id}/tasks`, { title: "Full create", priority: "HIGH", description: "x" }), 201);
  const template = data(await req("POST", `/api/projects/${project.id}/templates`, { name: "Template", title: "From template" }), 201);
  const instantiated = data(await req("POST", `/api/projects/${project.id}/templates/${template.id}/create-task`, {}), 201);
  data(await req("POST", `/api/projects/${project.id}/tasks/bulk-update`, { taskIds: [quick.id, full.id, instantiated.id], priority: "LOW" }));
  assert.equal(await app.prisma.customFieldValue.count({ where: { taskId: { in: [quick.id, full.id, instantiated.id] } } }), 0);

  // Writing an empty value to a required field is rejected, set or not.
  const emptyCases = (task) => [
    [team, null], [team, ""], [ticket, null], [ticket, "  "], [regions, []], [regions, null], [approved, null],
  ].map(([field, value]) => [`${field.name} ${JSON.stringify(value)}`, () => req("PUT", valueUrl(task, field), { value })]);
  await assertRejected(emptyCases(quick), { message: /is required/ });

  await setValue(quick, team, "Infra");
  await setValue(quick, ticket, "OPS-1");
  await setValue(quick, regions, ["us"]);
  await setValue(quick, approved, false); // false is an answer, not an empty value
  await assertRejected(emptyCases(quick), { message: /is required/ });
  assert.equal(await storedValue(quick, team), "Infra");
  assert.equal(await storedValue(quick, approved), false);

  // Making a field required later does not rewrite or reject existing tasks.
  const later = await createField({ name: "Later", type: "TEXT" });
  data(await req("PATCH", fieldUrl(later), { required: true }));
  assert.equal(await storedValue(full, later), undefined);
  await setValue(full, later, "now set");
});

test("field definitions keep select options valid and the type fixed", async () => {
  const stage = await createField({ name: "Stage", type: "SELECT", options: [{ value: "A" }, { value: "B" }] });
  const plain = await createField({ name: "Plain", type: "TEXT" });
  await assertRejected([
    ["duplicate options", () => req("POST", fieldsUrl(), { name: "Dup", type: "SELECT", options: [{ value: "A" }, { value: "A" }] })],
    ["empty options", () => req("POST", fieldsUrl(), { name: "Empty", type: "SELECT", options: [] })],
    ["missing options", () => req("POST", fieldsUrl(), { name: "None", type: "MULTI_SELECT" })],
    ["blank option", () => req("POST", fieldsUrl(), { name: "Blank", type: "SELECT", options: [{ value: "  " }] })],
    ["options on text", () => req("POST", fieldsUrl(), { name: "Text options", type: "TEXT", options: [{ value: "A" }] })],
    ["update to no options", () => req("PATCH", fieldUrl(stage), { options: [] })],
    ["update to duplicate options", () => req("PATCH", fieldUrl(stage), { options: [{ value: "A" }, { value: "B" }, { value: "A" }] })],
    ["retype select", () => req("PATCH", fieldUrl(stage), { type: "MULTI_SELECT" })],
    ["retype text", () => req("PATCH", fieldUrl(plain), { type: "NUMBER" })],
    ["options on text", () => req("PATCH", fieldUrl(plain), { options: [{ value: "A" }] })],
    ["rename without options", () => req("PATCH", fieldUrl(stage), { renameOptions: [{ from: "A", to: "C" }] })],
    ["rename unknown option", () => req("PATCH", fieldUrl(stage), { options: [{ value: "C" }], renameOptions: [{ from: "Z", to: "C" }] })],
    ["rename to missing option", () => req("PATCH", fieldUrl(stage), { options: [{ value: "C" }], renameOptions: [{ from: "A", to: "D" }] })],
    ["rename twice", () => req("PATCH", fieldUrl(stage), {
      options: [{ value: "C" }, { value: "D" }], renameOptions: [{ from: "A", to: "C" }, { from: "A", to: "D" }],
    })],
  ]);
  // Sending the unchanged type is harmless, so whole-object clients keep working.
  data(await req("PATCH", fieldUrl(plain), { type: "TEXT", name: "Plain text" }));
  assert.deepEqual(await definition(plain), { name: "Plain text", type: "TEXT", options: null, required: false });
  assert.deepEqual((await definition(stage)).options, [{ value: "A" }, { value: "B" }]);
});

test("renaming and removing options migrates or clears stored values, with an activity entry", async () => {
  const priority = await createField({ name: "Priority level", type: "SELECT", options: [{ value: "Low" }, { value: "Mid" }, { value: "High" }] });
  const tags = await createField({ name: "Tags", type: "MULTI_SELECT", options: [{ value: "red" }, { value: "green" }, { value: "blue" }] });
  const [t1, t2, t3, t4] = [await createTask("t1"), await createTask("t2"), await createTask("t3"), await createTask("t4")];
  for (const [task, level, list] of [[t1, "Mid", ["red", "green"]], [t2, "High", ["blue"]], [t3, "Low", ["green", "blue"]], [t4, null, ["red", "blue"]]]) {
    if (level) await setValue(task, priority, level);
    await setValue(task, tags, list);
  }

  events.length = 0;
  const renamed = body(await req("PATCH", fieldUrl(priority), {
    options: [{ value: "Low" }, { value: "Medium", color: "#f59e0b" }], renameOptions: [{ from: "Mid", to: "Medium" }],
  }));
  assert.deepEqual(renamed.data.options, [{ value: "Low" }, { value: "Medium", color: "#f59e0b" }]);
  assert.deepEqual(renamed.meta, { migratedValues: 1, clearedValues: 1 });
  assert.deepEqual([await storedValue(t1, priority), await storedValue(t2, priority), await storedValue(t3, priority)], ["Medium", undefined, "Low"]);
  assert.deepEqual(events.map(([, event]) => event).sort(), ["custom_field_updated", "task_updated"]);
  const logs = await app.prisma.activityLog.findMany({
    where: { action: "custom_field_changed", taskId: { in: [t1.id, t2.id] }, actorId: user.id }, orderBy: { createdAt: "desc" },
  });
  assert.deepEqual(logs.filter((l) => l.taskId === t1.id)[0].details, { fieldId: priority.id, value: "Medium", reason: "option_renamed" });
  assert.deepEqual(logs.filter((l) => l.taskId === t2.id)[0].details, { fieldId: priority.id, value: null, reason: "option_removed" });

  const recolored = body(await req("PATCH", fieldUrl(tags), {
    options: [{ value: "crimson" }, { value: "green" }], renameOptions: [{ from: "red", to: "crimson" }],
  }));
  assert.deepEqual(recolored.meta, { migratedValues: 3, clearedValues: 1 });
  assert.deepEqual(
    [await storedValue(t1, tags), await storedValue(t2, tags), await storedValue(t3, tags), await storedValue(t4, tags)],
    [["crimson", "green"], undefined, ["green"], ["crimson"]],
  );

  // Merging two options into one keeps each task's list free of duplicates.
  const merged = body(await req("PATCH", fieldUrl(tags), {
    options: [{ value: "warm" }], renameOptions: [{ from: "crimson", to: "warm" }, { from: "green", to: "warm" }],
  }));
  assert.deepEqual(merged.meta, { migratedValues: 3, clearedValues: 0 });
  assert.deepEqual([await storedValue(t1, tags), await storedValue(t3, tags), await storedValue(t4, tags)], [["warm"], ["warm"], ["warm"]]);

  // Renames apply all at once, so two options can swap names.
  const swapped = body(await req("PATCH", fieldUrl(priority), {
    options: [{ value: "Medium" }, { value: "Low" }], renameOptions: [{ from: "Low", to: "Medium" }, { from: "Medium", to: "Low" }],
  }));
  assert.deepEqual(swapped.meta, { migratedValues: 2, clearedValues: 0 });
  assert.deepEqual([await storedValue(t1, priority), await storedValue(t3, priority)], ["Low", "Medium"]);

  // Renaming the field itself, or editing options without removing any, leaves values alone.
  const unchanged = body(await req("PATCH", fieldUrl(priority), { name: "Level", options: [{ value: "Medium" }, { value: "Low" }, { value: "Extra" }] }));
  assert.deepEqual(unchanged.meta, { migratedValues: 0, clearedValues: 0 });
  assert.deepEqual([await storedValue(t1, priority), await storedValue(t3, priority)], ["Low", "Medium"]);

  // A required field still loses values whose option is removed; the task then shows it as missing.
  data(await req("PATCH", fieldUrl(priority), { required: true }));
  const removed = body(await req("PATCH", fieldUrl(priority), { options: [{ value: "Extra" }] }));
  assert.deepEqual(removed.meta, { migratedValues: 0, clearedValues: 2 });
  assert.equal(await app.prisma.customFieldValue.count({ where: { fieldId: priority.id } }), 0);

  // Deleting the field deletes every value it had.
  assert.equal((await req("DELETE", fieldUrl(tags))).statusCode, 204);
  assert.equal(await app.prisma.customFieldValue.count({ where: { fieldId: tags.id } }), 0);
});

test("a value write waits for a concurrent option change and is checked against the new options", async () => {
  const field = await createField({ name: "Race select", type: "SELECT", options: [{ value: "keep" }, { value: "drop" }] });
  const task = await createTask("Race value");
  let pending;
  await app.prisma.$transaction(async (tx) => {
    // Stand-in for an option edit that has locked the field and not yet committed.
    await tx.$queryRaw`SELECT id FROM "CustomField" WHERE id = ${field.id} FOR NO KEY UPDATE`;
    pending = req("PUT", valueUrl(task, field), { value: "drop" });
    await waitForLockWait(pending);
    await tx.customField.update({ where: { id: field.id }, data: { options: [{ value: "keep" }] } });
  });
  const response = await pending;
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().message, /must be one of its options/);
  assert.equal(await storedValue(task, field), undefined);
});

test("an option change waits for a concurrent value write and then clears it", async () => {
  const field = await createField({ name: "Race option", type: "SELECT", options: [{ value: "keep" }, { value: "drop" }] });
  const task = await createTask("Race option");
  let pending;
  await app.prisma.$transaction(async (tx) => {
    // Stand-in for a value write that has checked the old options and not yet committed.
    await tx.$queryRaw`SELECT id FROM "CustomField" WHERE id = ${field.id} FOR SHARE`;
    await tx.customFieldValue.create({ data: { taskId: task.id, fieldId: field.id, value: "drop" } });
    pending = req("PATCH", fieldUrl(field), { options: [{ value: "keep" }] });
    await waitForLockWait(pending);
  });
  const patched = body(await pending);
  assert.deepEqual(patched.meta, { migratedValues: 0, clearedValues: 1 });
  assert.equal(await storedValue(task, field), undefined);
});
