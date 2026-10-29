import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// DAT-013: backup restore applies the API's custom-field rules (preview and
// restore agree), and a read-only report finds values stored before the rules.

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "test", LOG_LEVEL: "error",
  JWT_SECRET: "custom-field-restore-signing-secret", COOKIE_SECRET: "custom-field-restore-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-custom-field-restore-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.js");
const { previewRestore, executeRestore } = await import("../../src/modules/backup/restore.service.js");
const { findCustomFieldIssues } = await import("../../src/scripts/custom-field-value-report.js");

let app, admin, target, audited, clean;
const suffix = crypto.randomUUID().slice(0, 20);

const backupTask = (customFieldValues, title = "Restored task") => ({
  _originalId: "task", title, priority: "NONE", position: 0, statusRef: "status", customFieldValues,
});

function backup(customFields, customFieldValues, tasks = [backupTask(customFieldValues)]) {
  return Buffer.from(JSON.stringify({
    metadata: { version: "1.1", exportedAt: new Date().toISOString(), sourceWorkspace: { name: "Source", slug: "source" }, userRefs: [] },
    projects: [{
      project: { name: "Restored fields" },
      statuses: [{ _originalId: "status", name: "Open", color: null, position: 0, isCompletion: false }],
      customFields,
      tasks,
    }],
    channels: [],
    wikiSpaces: [],
  }));
}

before(async () => {
  app = await buildApp(); await app.ready();
  admin = await app.prisma.user.create({ data: { email: `restore-fields-${suffix}@example.test`, displayName: "Restore admin", emailVerified: true } });
  [target, audited, clean] = await Promise.all(["target", "audited", "clean"].map((name) => app.prisma.workspace.create({ data: {
    name: `Custom field ${name}`, slug: `cf-${name}-${suffix}`, members: { create: { userId: admin.id, role: "ADMIN" } },
  } })));
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: [target?.id, audited?.id, clean?.id].filter(Boolean) } } });
      await app.prisma.user.deleteMany({ where: { id: admin?.id } });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("restore keeps valid custom fields and values, drops the rest, and preview warns the same", async () => {
  const file = backup([
    // Exports write options: null for fields without options.
    { _originalId: "f-text", name: "Notes", type: "TEXT", options: null, required: false, position: 0 },
    { _originalId: "f-url", name: "Spec", type: "URL", options: null, required: false, position: 1 },
    { _originalId: "f-select", name: "Size", type: "SELECT", required: true, position: 2,
      options: [{ value: "S" }, { value: "S", color: "#ff0000" }, { value: "M", color: "#00ff00" }, { value: 5 }, "junk", { value: " " }] },
    { _originalId: "f-multi", name: "Tags", type: "MULTI_SELECT", options: [{ value: "a" }, { value: "b" }], required: false, position: 3 },
    { _originalId: "f-date", name: "Launch", type: "DATE", options: [{ value: "ignored" }], required: false, position: 4 },
  ], [
    { fieldRef: "f-text", value: "kept" },
    { fieldRef: "f-text", value: "a second value for the same field" },
    { fieldRef: "f-url", value: "javascript:alert(1)" },
    { fieldRef: "f-select", value: "M" },
    { fieldRef: "f-multi", value: ["a", "zzz"] },
    { fieldRef: "f-date", value: "2026-02-31" },
    { fieldRef: "missing-field", value: "skipped silently, as before" },
  ]);

  const preview = await previewRestore(app.prisma, target.id, admin.id, file);
  const fieldWarnings = (warnings) => warnings.filter((w) => w.startsWith("Custom field"));
  assert.deepEqual(fieldWarnings(preview.warnings), [
    'Custom field "Size" in project "Restored fields": dropped 4 malformed or repeated option(s)',
    'Custom field "Notes" in project "Restored fields": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
    'Custom field "Spec" in project "Restored fields": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
    'Custom field "Tags" in project "Restored fields": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
    'Custom field "Launch" in project "Restored fields": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
  ]);
  assert.equal(await app.prisma.project.count({ where: { workspaceId: target.id } }), 0);

  const summary = await executeRestore(app.prisma, target.id, admin.id, file);
  assert.deepEqual(fieldWarnings(summary.warnings), fieldWarnings(preview.warnings));
  assert.equal(summary.customFields, preview.customFields);
  const fields = await app.prisma.customField.findMany({
    where: { project: { workspaceId: target.id } }, orderBy: { position: "asc" },
    select: { name: true, type: true, options: true, required: true, values: { select: { value: true } } },
  });
  assert.deepEqual(fields, [
    { name: "Notes", type: "TEXT", options: null, required: false, values: [{ value: "kept" }] },
    { name: "Spec", type: "URL", options: null, required: false, values: [] },
    { name: "Size", type: "SELECT", options: [{ value: "S" }, { value: "M", color: "#00ff00" }], required: true, values: [{ value: "M" }] },
    { name: "Tags", type: "MULTI_SELECT", options: [{ value: "a" }, { value: "b" }], required: false, values: [] },
    { name: "Launch", type: "DATE", options: null, required: false, values: [] },
  ]);
});

test("restore keeps each task's own values when task IDs repeat, and skips text PostgreSQL cannot store", async () => {
  const file = backup([{ _originalId: "f", name: "Code", type: "TEXT", options: null, required: false, position: 0 }], null, [
    backupTask([{ fieldRef: "f", value: "first" }], "First"),
    backupTask([{ fieldRef: "f", value: "second" }], "Second"),
    backupTask([{ fieldRef: "f", value: "nul\u0000byte" }], "Third"),
  ]);
  const warning = 'Custom field "Code" in project "Restored fields": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value';
  assert.ok((await previewRestore(app.prisma, target.id, admin.id, file)).warnings.includes(warning));
  const summary = await executeRestore(app.prisma, target.id, admin.id, file);
  assert.ok(summary.warnings.includes(warning));
  const tasks = await app.prisma.task.findMany({
    where: { project: { workspaceId: target.id }, title: { in: ["First", "Second", "Third"] } },
    orderBy: { title: "asc" }, select: { title: true, customFieldValues: { select: { value: true } } },
  });
  assert.deepEqual(tasks, [
    { title: "First", customFieldValues: [{ value: "first" }] },
    { title: "Second", customFieldValues: [{ value: "second" }] },
    { title: "Third", customFieldValues: [] },
  ]);
});

test("a backup with an unknown custom-field type is rejected by preview and restore alike", async () => {
  const file = backup([{ _originalId: "f", name: "Odd", type: "COLOR", options: null, required: false, position: 0 }], []);
  for (const run of [previewRestore, executeRestore]) {
    await assert.rejects(run(app.prisma, target.id, admin.id, file), (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /custom field "Odd" .* has an unknown type/);
      return true;
    });
  }
});

test("the custom-field report lists stored values the API now rejects, by id, without writing", async () => {
  const project = await app.prisma.project.create({ data: { workspaceId: audited.id, name: "Audited" } });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  const task = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Legacy", position: 0 } });
  const other = await app.prisma.task.create({ data: { projectId: project.id, statusId: status.id, title: "Legacy 2", position: 1 } });
  const field = (name, type, options) => app.prisma.customField.create({ data: { projectId: project.id, name, type, options } });
  const f = {
    text: await field("Text", "TEXT"),
    note: await field("Note", "TEXT"),
    textWithOptions: await field("Text with options", "TEXT", [{ value: "x" }]),
    date: await field("Date", "DATE"),
    url: await field("Url", "URL"),
    number: await field("Number", "NUMBER"),
    select: await field("Select", "SELECT", [{ value: "A" }, { value: "B" }]),
    multi: await field("Multi", "MULTI_SELECT", [{ value: "x" }, { value: "y" }]),
    repeated: await field("Repeated options", "SELECT", [{ value: "A" }, { value: "A" }]),
    empty: await field("No options", "MULTI_SELECT", []),
  };
  const value = (taskId, fieldId, v) => app.prisma.customFieldValue.create({ data: { taskId, fieldId, value: v } });
  const rows = {
    empty: await value(task.id, f.text.id, ""),
    valid: await value(other.id, f.text.id, "fine"),
    date: await value(task.id, f.date.id, "2026-02-30"),
    url: await value(task.id, f.url.id, "javascript:alert(document.cookie)"),
    type: await value(task.id, f.number.id, "12"),
    option: await value(task.id, f.select.id, "C"),
    validSelect: await value(other.id, f.select.id, "B"),
    repeated: await value(task.id, f.multi.id, ["x", "x"]),
    control: await value(task.id, f.note.id, "bell\u0007"),
  };

  const before = await app.prisma.customFieldValue.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } });
  const report = await findCustomFieldIssues(app.prisma, { workspaceId: audited.id });
  assert.equal(report.readOnly, true);
  const byKey = Object.fromEntries(report.issues.map((issue) => [issue.key, issue]));
  const sample = (row, repair) => ({ id: row.id, taskId: row.taskId, fieldId: row.fieldId, projectId: project.id, repair });
  assert.deepEqual(byKey.custom_field_value_empty.samples, [sample(rows.empty, "delete")]);
  assert.deepEqual(byKey.custom_field_value_date.samples, [sample(rows.date, "delete")]);
  assert.deepEqual(byKey.custom_field_value_url.samples, [sample(rows.url, "delete")]);
  assert.deepEqual(byKey.custom_field_value_type.samples, [sample(rows.type, "delete")]);
  assert.deepEqual(byKey.custom_field_value_option.samples, [sample(rows.option, "delete")]);
  assert.deepEqual(byKey.custom_field_value_repeated.samples, [sample(rows.repeated, "dedupe")]);
  assert.deepEqual(byKey.custom_field_value_text.samples, [sample(rows.control, "strip")]);
  assert.deepEqual(
    byKey.custom_field_options.samples.map((s) => [s.id, s.repair]).sort(),
    [[f.textWithOptions.id, "drop_options"], [f.repeated.id, "rewrite_options"], [f.empty.id, "add_options"]].sort(),
  );
  for (const issue of report.issues) assert.equal(issue.count, issue.samples.length, issue.key);
  // IDs and reason codes only: no stored value or name reaches the output.
  assert.doesNotMatch(JSON.stringify(report.issues.map((issue) => issue.samples)), /javascript|2026-02-30|fine|Legacy|Select/);
  assert.deepEqual(await app.prisma.customFieldValue.findMany({ where: { task: { projectId: project.id } }, orderBy: { id: "asc" } }), before);

  const cleanReport = await findCustomFieldIssues(app.prisma, { workspaceId: clean.id });
  assert.deepEqual(cleanReport.issues.filter((issue) => issue.count > 0), []);
});
