import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateOptionValue, optionTargets } from "../src/modules/custom-fields/custom-field-options.ts";
import { planCustomFieldRestore } from "../src/modules/backup/custom-field-restore.ts";
import { classifyFieldOptions, classifyStoredValue } from "../src/scripts/custom-field-value-report.ts";

const options = (...values) => values.map((value) => ({ value }));

test("SELECT values follow renames, stay when kept and clear when removed", () => {
  const targets = optionTargets(options("Low", "Medium"), [{ from: "Mid", to: "Medium" }]);
  assert.deepEqual(migrateOptionValue("SELECT", "Mid", targets), { action: "update", value: "Medium", reason: "option_renamed" });
  assert.deepEqual(migrateOptionValue("SELECT", "Low", targets), { action: "keep" });
  assert.deepEqual(migrateOptionValue("SELECT", "High", targets), { action: "clear", reason: "option_removed" });
  // Values of another shape are not this migration's to interpret.
  assert.deepEqual(migrateOptionValue("SELECT", 3, targets), { action: "keep" });
  assert.deepEqual(migrateOptionValue("SELECT", ["Low"], targets), { action: "keep" });
});

test("renames apply at once: options can swap names or merge", () => {
  const swap = optionTargets(options("A", "B"), [{ from: "A", to: "B" }, { from: "B", to: "A" }]);
  assert.deepEqual(migrateOptionValue("SELECT", "A", swap), { action: "update", value: "B", reason: "option_renamed" });
  assert.deepEqual(migrateOptionValue("SELECT", "B", swap), { action: "update", value: "A", reason: "option_renamed" });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["A", "B"], swap), { action: "update", value: ["B", "A"], reason: "option_renamed" });

  const merge = optionTargets(options("AB"), [{ from: "A", to: "AB" }, { from: "B", to: "AB" }]);
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["A", "B"], merge), { action: "update", value: ["AB"], reason: "option_renamed" });
});

test("MULTI_SELECT lists keep order, drop removed options and repeats, and clear when nothing is left", () => {
  const targets = optionTargets(options("crimson", "green"), [{ from: "red", to: "crimson" }]);
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["red", "green"], targets), {
    action: "update", value: ["crimson", "green"], reason: "option_renamed",
  });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["green", "blue"], targets), {
    action: "update", value: ["green"], reason: "option_removed",
  });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["green", "green"], targets), {
    action: "update", value: ["green"], reason: "option_renamed",
  });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["blue"], targets), { action: "clear", reason: "option_removed" });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", ["green"], targets), { action: "keep" });
  assert.deepEqual(migrateOptionValue("MULTI_SELECT", "green", targets), { action: "keep" });
  assert.deepEqual(migrateOptionValue("TEXT", "red", targets), { action: "keep" });
});

const backupTask = (customFieldValues, id = "t") => ({
  _originalId: id, title: "T", priority: "NONE", position: 0, statusRef: "s", assignees: [], labels: [],
  subtasks: [], dependencies: [], comments: [], activityLogs: [], customFieldValues,
});
const backupProject = (customFields, customFieldValues, tasks = [backupTask(customFieldValues)]) => ({
  project: { name: "P" }, statuses: [], labels: [], members: [], attachments: [], customFields, tasks,
});

test("restore planning keeps valid values once and reports what it dropped", () => {
  const plan = planCustomFieldRestore(backupProject([
    { _originalId: "n", name: "Num", type: "NUMBER", options: [{ value: "x" }], required: true, position: 0 },
    { _originalId: "m", name: "Multi", type: "MULTI_SELECT", options: [{ value: "a" }, { value: "a" }], required: false, position: 1 },
  ], [
    { fieldRef: "n", value: "" },
    { fieldRef: "n", value: 4 },
    { fieldRef: "m", value: ["a"] },
    { fieldRef: "unknown", value: 1 },
  ]));
  assert.deepEqual(plan.fields.map((f) => [f.originalId, f.type, f.options, f.required]), [
    ["n", "NUMBER", undefined, true], ["m", "MULTI_SELECT", [{ value: "a" }], false],
  ]);
  // The empty value is no value; the second value for "n" repeats the task's field.
  assert.deepEqual([...plan.values.values()], [[{ fieldRef: "m", value: ["a"] }]]);
  assert.deepEqual(plan.warnings, [
    'Custom field "Multi" in project "P": dropped 1 malformed or repeated option(s)',
    'Custom field "Num" in project "P": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
  ]);
});

test("restore planning keeps each task entry's values, even when task IDs repeat", () => {
  const first = backupTask([{ fieldRef: "x", value: "first" }], "same");
  const second = backupTask([{ fieldRef: "x", value: "second" }, { fieldRef: "y", value: "nul\u0000" }], "same");
  const plan = planCustomFieldRestore(backupProject([
    { _originalId: "x", name: "Text", type: "TEXT", options: null, required: false, position: 0 },
    { _originalId: "y", name: "Other", type: "TEXT", options: null, required: false, position: 1 },
  ], [], [first, second]));
  assert.deepEqual(plan.values.get(first), [{ fieldRef: "x", value: "first" }]);
  assert.deepEqual(plan.values.get(second), [{ fieldRef: "x", value: "second" }]);
  assert.deepEqual(plan.warnings, [
    'Custom field "Other" in project "P": skipped 1 value(s) that do not match the field\'s type or options, or repeat a task\'s value',
  ]);
});

test("the report proposes delete or dedupe for stored values and an options repair for fields", () => {
  const multi = { type: "MULTI_SELECT", options: options("x", "y") };
  assert.equal(classifyStoredValue(multi, ["x"]), null);
  assert.deepEqual(classifyStoredValue(multi, ["x", "x"]), { key: "custom_field_value_repeated", repair: "dedupe" });
  assert.deepEqual(classifyStoredValue(multi, ["z"]), { key: "custom_field_value_option", repair: "delete" });
  assert.deepEqual(classifyStoredValue(multi, []), { key: "custom_field_value_empty", repair: "delete" });
  assert.deepEqual(classifyStoredValue({ type: "URL", options: null }, "data:text/html,x"), { key: "custom_field_value_url", repair: "delete" });
  assert.deepEqual(classifyStoredValue({ type: "DATE", options: null }, "2026-13-01"), { key: "custom_field_value_date", repair: "delete" });
  assert.deepEqual(classifyStoredValue({ type: "CHECKBOX", options: null }, "yes"), { key: "custom_field_value_type", repair: "delete" });
  assert.deepEqual(classifyStoredValue({ type: "TEXT", options: null }, "a\u0001b"), { key: "custom_field_value_text", repair: "strip" });

  assert.equal(classifyFieldOptions(multi), null);
  assert.equal(classifyFieldOptions({ type: "SELECT", options: options("x", "x") }), "rewrite_options");
  assert.equal(classifyFieldOptions({ type: "SELECT", options: [{ value: "x" }, { label: "y" }] }), "rewrite_options");
  assert.equal(classifyFieldOptions({ type: "SELECT", options: [] }), "add_options");
  assert.equal(classifyFieldOptions({ type: "SELECT", options: null }), "add_options");
  assert.equal(classifyFieldOptions({ type: "TEXT", options: options("x") }), "drop_options");
  assert.equal(classifyFieldOptions({ type: "TEXT", options: [] }), null);
  assert.equal(classifyFieldOptions({ type: "TEXT", options: null }), null);
});
