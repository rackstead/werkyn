import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateCustomFieldSchema,
  MAX_CUSTOM_FIELD_OPTIONS,
  MAX_CUSTOM_FIELD_OPTION_LENGTH,
  MAX_MULTI_SELECT_VALUES,
  SetCustomFieldValueSchema,
  UpdateCustomFieldSchema,
  checkCustomFieldValue,
  customFieldOptionValues,
  isEmptyCustomFieldValue,
  isHttpUrl,
  normalizeSelectOptions,
} from "../dist/index.js";

const issues = (result) => result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
const field = (type, extra = {}) => ({ name: "Field", type, ...extra });
const select = field("SELECT", { options: [{ value: "Low" }, { value: "High", color: "#f00" }] });
const multi = field("MULTI_SELECT", { options: [{ value: "a" }, { value: "b" }, { value: "c" }] });

test("isHttpUrl accepts only absolute http(s) URLs with a host and no whitespace", () => {
  for (const url of [
    "http://example.com", "https://example.com/a/b?c=d#e", "HTTPS://EXAMPLE.COM", "https://example.com:8443",
    "https://user@example.com/", "http://[::1]/", "https://xn--bcher-kva.example/", `https://example.com/${"a".repeat(2000)}`,
  ]) {
    assert.equal(isHttpUrl(url), true, url);
  }
  for (const url of [
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", " javascript:alert(1)",
    "data:text/html,<b>x</b>", "vbscript:msgbox(1)", "file:///etc/passwd", "ftp://example.com", "mailto:a@example.com",
    "example.com", "//example.com", "/relative", "https://", "https:example.com", "https:\\\\example.com",
    "https://exa mple.com", "https://example.com/ ", " https://example.com", "https://example.com ", "https://example.com/\u0000",
    "https://example.com/\nx", "http://exa\tmple.com", `https://example.com/${"a".repeat(2100)}`, "",
  ]) {
    assert.equal(isHttpUrl(url), false, JSON.stringify(url));
  }
});

test("empty values are null, blank text and the empty list", () => {
  for (const value of [null, undefined, "", "   ", "\t", []]) assert.equal(isEmptyCustomFieldValue(value), true, JSON.stringify(value));
  for (const value of [0, false, "0", " x ", ["a"]]) assert.equal(isEmptyCustomFieldValue(value), false, JSON.stringify(value));
});

test("checkCustomFieldValue accepts each type's valid values", () => {
  const cases = [
    [field("TEXT"), "anything at all"], [field("TEXT"), "multi\nline\r\nwith\ttab"], [field("NUMBER"), 0], [field("NUMBER"), -1.5],
    [field("CHECKBOX"), false], [field("CHECKBOX"), true], [field("DATE"), "2028-02-29"], [field("URL"), "https://example.com"],
    [select, "High"], [multi, ["c", "a"]], [multi, ["b"]],
  ];
  for (const [definition, value] of cases) {
    assert.deepEqual(checkCustomFieldValue(definition, value), { ok: true, value }, `${definition.type} ${JSON.stringify(value)}`);
  }
});

test("checkCustomFieldValue names the field and the problem", () => {
  const cases = [
    [field("TEXT"), 5, "wrong_type", '"Field" must be text'],
    [field("TEXT"), "nul\u0000here", "invalid_text", '"Field" must not contain control characters other than tab and line breaks'],
    [field("TEXT"), "bell\u0007", "invalid_text", '"Field" must not contain control characters other than tab and line breaks'],
    [field("NUMBER"), "5", "wrong_type", '"Field" must be a finite number'],
    [field("NUMBER"), Infinity, "wrong_type", '"Field" must be a finite number'],
    [field("NUMBER"), Number.NaN, "wrong_type", '"Field" must be a finite number'],
    [field("CHECKBOX"), "true", "wrong_type", '"Field" must be true or false'],
    [field("DATE"), 20260101, "wrong_type", '"Field" must be a date string'],
    [field("DATE"), "2026-02-31", "invalid_date", '"Field" must be a real calendar date in YYYY-MM-DD format between 1900 and 2999'],
    [field("URL"), "javascript:alert(1)", "invalid_url", '"Field" must be an http or https URL, such as https://example.com, without spaces'],
    [field("URL"), 7, "wrong_type", '"Field" must be a URL string'],
    [select, "Medium", "unknown_option", '"Field" must be one of its options'],
    [select, "low", "unknown_option", '"Field" must be one of its options'],
    [select, ["Low"], "wrong_type", '"Field" must be one of its options'],
    [multi, "a", "wrong_type", '"Field" must be a list of its options'],
    [multi, ["a", 1], "wrong_type", '"Field" must be a list of its options'],
    [multi, ["a", "z"], "unknown_option", '"Field" must only list its options'],
    [multi, ["a", "b", "a"], "repeated_option", '"Field" lists an option more than once'],
    [field("COLOR"), "red", "wrong_type", '"Field" has an unknown field type'],
  ];
  for (const [definition, value, issue, message] of cases) {
    assert.deepEqual(checkCustomFieldValue(definition, value), { ok: false, issue, message }, `${definition.type} ${String(value)}`);
  }
});

test("empty values clear optional fields and are rejected for required ones", () => {
  for (const type of ["TEXT", "NUMBER", "DATE", "URL", "CHECKBOX", "SELECT", "MULTI_SELECT"]) {
    for (const empty of [null, "", "  ", []]) {
      assert.deepEqual(checkCustomFieldValue(field(type), empty), { ok: true, value: null }, `${type} ${JSON.stringify(empty)}`);
      assert.deepEqual(checkCustomFieldValue(field(type, { required: true }), empty), {
        ok: false, issue: "required", message: '"Field" is required',
      });
    }
  }
  // false and 0 are answers, not empty values.
  assert.deepEqual(checkCustomFieldValue(field("CHECKBOX", { required: true }), false), { ok: true, value: false });
  assert.deepEqual(checkCustomFieldValue(field("NUMBER", { required: true }), 0), { ok: true, value: 0 });
});

test("select options read from stored JSON skip malformed entries", () => {
  assert.deepEqual(customFieldOptionValues([{ value: "a" }, { value: 1 }, null, "b", { value: "c" }]), ["a", "c"]);
  assert.deepEqual(customFieldOptionValues(null), []);
  assert.deepEqual(customFieldOptionValues({ value: "a" }), []);
  assert.deepEqual(normalizeSelectOptions([{ value: "a" }, { value: "a", color: "#000" }, { value: " " }, { value: "b", color: "#fff" }, 3]), {
    options: [{ value: "a" }, { value: "b", color: "#fff" }], dropped: 3,
  });
  assert.deepEqual(normalizeSelectOptions(null), { options: [], dropped: 0 });
  assert.deepEqual(normalizeSelectOptions("a,b"), { options: [], dropped: 1 });
});

test("field definitions: select types need unique options, other types have none", () => {
  assert.deepEqual(issues(CreateCustomFieldSchema.safeParse({ name: "S", type: "SELECT" })),
    [["options", "SELECT and MULTI_SELECT fields require at least one option"]]);
  assert.deepEqual(issues(CreateCustomFieldSchema.safeParse({ name: "S", type: "MULTI_SELECT", options: [] })),
    [["options", "SELECT and MULTI_SELECT fields require at least one option"]]);
  assert.deepEqual(issues(CreateCustomFieldSchema.safeParse({ name: "S", type: "SELECT", options: [{ value: "a" }, { value: "b" }, { value: "a" }] })),
    [["options.2.value", "Option values must be unique within a field"]]);
  assert.deepEqual(issues(CreateCustomFieldSchema.safeParse({ name: "S", type: "SELECT", options: [{ value: "  " }] })),
    [["options.0.value", "Option value must not be blank"]]);
  assert.deepEqual(issues(CreateCustomFieldSchema.safeParse({ name: "T", type: "TEXT", options: [{ value: "a" }] })),
    [["options", "Only SELECT and MULTI_SELECT fields have options"]]);
  assert.equal(CreateCustomFieldSchema.safeParse({ name: "T", type: "TEXT", options: [] }).success, true);
  assert.deepEqual(CreateCustomFieldSchema.parse({ name: "S", type: "SELECT", options: [{ value: "a", color: "#123456" }] }), {
    name: "S", type: "SELECT", options: [{ value: "a", color: "#123456" }], required: false,
  });
});

test("field updates: options stay non-empty and unique, renames name a new option once", () => {
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({ options: [] })),
    [["options", "SELECT and MULTI_SELECT fields require at least one option"]]);
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({ options: [{ value: "a" }, { value: "a" }] })),
    [["options.1.value", "Option values must be unique within a field"]]);
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({ renameOptions: [{ from: "a", to: "b" }] })),
    [["renameOptions", "renameOptions requires the new options list"]]);
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({ options: [{ value: "b" }], renameOptions: [{ from: "a", to: "c" }] })),
    [["renameOptions.0.to", "A renamed option must be in the new options list"]]);
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({
    options: [{ value: "b" }, { value: "c" }], renameOptions: [{ from: "a", to: "b" }, { from: "a", to: "c" }],
  })), [["renameOptions.1.from", "Each option can be renamed only once"]]);
  assert.equal(issues(UpdateCustomFieldSchema.safeParse({ type: "DATETIME" }))[0][0], "type");
  // A swap and a merge are both valid requests.
  assert.equal(UpdateCustomFieldSchema.safeParse({
    options: [{ value: "a" }, { value: "b" }], renameOptions: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
  }).success, true);
  assert.equal(UpdateCustomFieldSchema.safeParse({
    options: [{ value: "ab" }], renameOptions: [{ from: "a", to: "ab" }, { from: "b", to: "ab" }],
  }).success, true);
  assert.equal(UpdateCustomFieldSchema.safeParse({ renameOptions: [] }).success, true);
});

test("option lists, option values and MULTI_SELECT values are capped", () => {
  assert.equal(MAX_CUSTOM_FIELD_OPTIONS, 200);
  assert.equal(MAX_CUSTOM_FIELD_OPTION_LENGTH, 100);
  assert.equal(MAX_MULTI_SELECT_VALUES, 200);
  const many = (n) => Array.from({ length: n }, (_, i) => ({ value: `option ${i}` }));
  const create = (options) => CreateCustomFieldSchema.safeParse({ name: "S", type: "MULTI_SELECT", options });
  assert.equal(create(many(200)).success, true);
  assert.deepEqual(issues(create(many(201))), [["options", "A field can have at most 200 options"]]);
  assert.equal(create([{ value: "x".repeat(100) }]).success, true);
  assert.deepEqual(issues(create([{ value: "x".repeat(101) }])), [["options.0.value", "Option values must be 100 characters or less"]]);
  assert.equal(issues(create([{ value: "x", color: "#".repeat(33) }]))[0][0], "options.0.color");

  assert.equal(UpdateCustomFieldSchema.safeParse({ options: many(200) }).success, true);
  assert.deepEqual(issues(UpdateCustomFieldSchema.safeParse({ options: many(201) })), [["options", "A field can have at most 200 options"]]);
  assert.equal(issues(UpdateCustomFieldSchema.safeParse({
    options: [{ value: "a" }], renameOptions: Array.from({ length: 201 }, (_, i) => ({ from: `o${i}`, to: "a" })),
  }))[0][0], "renameOptions");
  // An option stored before the caps can still be renamed into them.
  assert.equal(UpdateCustomFieldSchema.safeParse({ options: [{ value: "a" }], renameOptions: [{ from: "x".repeat(500), to: "a" }] }).success, true);

  const values = (n) => Array.from({ length: n }, (_, i) => `option ${i}`);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: values(200) }).success, true);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: values(201) }).success, false);
  assert.equal(SetCustomFieldValueSchema.safeParse({ value: ["x".repeat(101)] }).success, false);
  const legacy = field("MULTI_SELECT", { options: many(300) });
  assert.deepEqual(checkCustomFieldValue(legacy, values(201)), {
    ok: false, issue: "too_many_options", message: '"Field" can list at most 200 options',
  });
  assert.equal(checkCustomFieldValue(legacy, values(200)).ok, true);

  const normalized = normalizeSelectOptions(many(250));
  assert.equal(normalized.options.length, 200);
  assert.equal(normalized.dropped, 50);
});
