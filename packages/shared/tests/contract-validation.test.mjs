import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateRecurringSchema,
  CreateTaskSchema,
  CreateTimeEntrySchema,
  SetCustomFieldValueSchema,
  SetUserRateSchema,
  UpdateRecurringSchema,
  UpdateUserSchema,
  dateOnly,
  isDateOnly,
  multilineText,
  singleLineText,
} from "../dist/index.js";

test("isDateOnly accepts only real calendar dates between 1900 and 2999", () => {
  for (const date of ["1900-01-01", "2000-02-29", "2024-02-29", "2026-01-31", "2026-04-30", "2026-12-31", "2999-12-31"]) {
    assert.equal(isDateOnly(date), true, date);
  }
  for (const date of [
    "2026-02-29", "2026-02-31", "1900-02-29", "2100-02-29", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31",
    "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32", "0000-01-01", "0099-01-12", "1899-12-31", "3000-01-01",
    "2026-1-01", "2026-01-1", "26-01-01", "2026/01/01", "2026-01-01T00:00:00Z", " 2026-01-01", "2026-01-01\n", "",
  ]) {
    assert.equal(isDateOnly(date), false, JSON.stringify(date));
  }
  assert.equal(dateOnly("Due date").safeParse("2026-02-31").error.issues[0].message,
    "Due date must be a real calendar date in YYYY-MM-DD format between 1900 and 2999");
});

test("single-line text allows tab; multi-line text also allows line breaks; neither allows other C0 controls", () => {
  const single = singleLineText();
  const multi = multilineText();
  for (const ok of ["plain", "Zoë 李 🙂", "tab\tseparated", ""]) {
    assert.equal(single.safeParse(ok).success, true, ok);
    assert.equal(multi.safeParse(ok).success, true, ok);
  }
  for (const lineBreak of ["a\nb", "a\rb", "a\r\nb"]) {
    assert.equal(single.safeParse(lineBreak).success, false, JSON.stringify(lineBreak));
    assert.equal(multi.safeParse(lineBreak).success, true, JSON.stringify(lineBreak));
  }
  for (let code = 0; code < 0x20; code += 1) {
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    const value = `a${String.fromCharCode(code)}b`;
    assert.equal(single.safeParse(value).success, false, `U+${code.toString(16)}`);
    assert.equal(multi.safeParse(value).success, false, `U+${code.toString(16)}`);
  }
  // Printable characters beyond C0 (DEL and above) are left alone.
  assert.equal(single.safeParse("a\u007fb c d").success, true);
});

test("schemas apply the text, date and number rules to their fields", () => {
  assert.equal(CreateTaskSchema.safeParse({ title: "T\u0000" }).success, false);
  assert.equal(CreateTaskSchema.safeParse({ title: "T", description: "<p>a</p>\n<p>b</p>" }).success, true);
  assert.equal(CreateTaskSchema.safeParse({ title: "T", dueDate: "2027-02-29" }).success, false);
  assert.equal(UpdateUserSchema.safeParse({ displayName: "A\u0000" }).success, false);
  assert.equal(CreateTimeEntrySchema.safeParse({ date: "2026-02-28", hours: Infinity }).success, false);
  assert.equal(SetUserRateSchema.safeParse({ rate: Infinity }).success, false);
  assert.equal(SetUserRateSchema.safeParse({ rate: 1e9 }).success, true);
  assert.equal(SetUserRateSchema.safeParse({ rate: 1e9 + 1 }).success, false);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: Infinity }).success, false);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: "multi\nline" }).success, true);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: ["a\u0000"] }).success, false);
});

test("recurrence create and update require the day the frequency needs", () => {
  const base = { templateId: "t", startDate: "2026-03-02" };
  assert.deepEqual(
    CreateRecurringSchema.safeParse({ ...base, frequency: "MONTHLY" }).error.issues.map((i) => [i.path.join("."), i.message]),
    [["dayOfMonth", "dayOfMonth is required for MONTHLY"]],
  );
  assert.deepEqual(
    CreateRecurringSchema.safeParse({ ...base, frequency: "BIWEEKLY" }).error.issues.map((i) => i.path.join(".")),
    ["dayOfWeek"],
  );
  assert.equal(CreateRecurringSchema.safeParse({ ...base, frequency: "DAILY" }).success, true);

  // Explicitly clearing the day a new frequency needs is rejected; omitting it
  // is left to the stored row (checked by the server).
  assert.equal(UpdateRecurringSchema.safeParse({ frequency: "WEEKLY", dayOfWeek: null }).success, false);
  assert.equal(UpdateRecurringSchema.safeParse({ frequency: "MONTHLY", dayOfMonth: null }).success, false);
  assert.equal(UpdateRecurringSchema.safeParse({ frequency: "MONTHLY" }).success, true);
  assert.equal(UpdateRecurringSchema.safeParse({ frequency: "DAILY", dayOfWeek: null, dayOfMonth: null }).success, true);
  assert.equal(UpdateRecurringSchema.safeParse({ endDate: "2026-02-30" }).success, false);
});
