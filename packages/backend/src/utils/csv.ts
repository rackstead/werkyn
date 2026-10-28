/**
 * CSV encoding for spreadsheet exports: RFC 4180 framing plus CSV injection
 * (formula) neutralisation following OWASP's CSV Injection guidance.
 *
 * - Text cells are always wrapped in double quotes with embedded quotes
 *   doubled, so a comma-separated, quote-aware reader keeps commas, quotes,
 *   CR and LF inside the cell.
 * - Readers do not all read the file that way. A spreadsheet using `;` or tab
 *   as its list separator, or a reader that splits lines first, starts a new
 *   cell after any `,` `;` tab or line break inside a text value, with the
 *   quotes as literal text. So formula neutralisation applies to every such
 *   segment, not only the start of the cell: wherever a segment's first
 *   character, after blanks, invisible characters and quotes, is one a
 *   spreadsheet reads as the start of a formula (= + - @ or their full-width
 *   forms), a guard is inserted at the segment start. A cell that starts with
 *   a tab, CR or LF is also guarded at its start.
 * - The guard is a tab followed by an apostrophe. Under a comma or semicolon
 *   reading the cell starts with the tab, OWASP's Excel-resistant marker,
 *   which stays in the value Excel re-saves; whitespace-trimming consumers
 *   still find the apostrophe. Under a tab reading the guard's tab splits the
 *   cell and the new cell starts with the apostrophe, which spreadsheets read
 *   as text. Both characters are part of the exported text.
 * - Number and date cells come only from csvDecimal and csvIsoDate and are
 *   written bare, so numeric columns (including negative values) and dates
 *   keep their type. A non-finite number becomes an empty cell, as it does in
 *   JSON.
 * - Records end with CRLF and the document starts with a UTF-8 byte order
 *   mark so spreadsheet applications decode non-ASCII text as UTF-8.
 */

const CSV_RECORD_BREAK = "\r\n";
const UTF8_BOM = "\u{FEFF}";

const FORMULA_GUARD = "\t'";
// Characters after which some reader may start a new cell or record: field
// separators and line breaks (including those str.splitlines-style readers use).
const SEGMENT_BREAK = String.raw`,;\t\n\x0B\x0C\r\x1C-\x1E\x85\u{2028}\u{2029}`;
// What may precede a formula character without making it inert: blanks,
// other control and format characters, and quotes.
const SEGMENT_SKIP = String.raw`\p{Zs}\p{Cf}\x00-\x08\x0E-\x1B\x1F\x7F-\x84\x86-\x9F"'`;
const FORMULA_CHAR = String.raw`=+\-@\u{FF1D}\u{FF0B}\u{FF0D}\u{FF20}`;
const UNSAFE_SEGMENT = new RegExp(
  String.raw`(^|[${SEGMENT_BREAK}])(?=[${SEGMENT_SKIP}]*[${FORMULA_CHAR}])`,
  "gu",
);
const LEADING_BREAK = /^[\t\r\n]/;

/** Insert the guard at every segment start that would read as a formula. */
function neutraliseFormulas(text: string): string {
  const guarded = text.replace(
    UNSAFE_SEGMENT,
    (_match, segmentBreak: string) => segmentBreak + FORMULA_GUARD,
  );
  return LEADING_BREAK.test(text) ? FORMULA_GUARD + guarded : guarded;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A number or date written unquoted so spreadsheets keep its type. Only the
 * factories below create one, from values that cannot start a formula.
 */
export class CsvBareValue {
  private constructor(readonly text: string) {}

  /**
   * A decimal cell, e.g. hours or money, with fixed fraction digits. A
   * non-finite value (an overflowing cost) is an empty cell, not an error.
   */
  static decimal(value: number, fractionDigits = 2): CsvCell {
    if (!Number.isFinite(value)) return null;
    return new CsvBareValue(value.toFixed(fractionDigits));
  }

  /** A YYYY-MM-DD date cell; any other value is exported as text. */
  static isoDate(value: string): CsvCell {
    return ISO_DATE.test(value) ? new CsvBareValue(value) : value;
  }
}

export const csvDecimal = CsvBareValue.decimal;
export const csvIsoDate = CsvBareValue.isoDate;

/** Strings are text cells; null and undefined become empty cells. */
export type CsvCell = string | CsvBareValue | null | undefined;

export function encodeCsvCell(cell: CsvCell): string {
  if (cell instanceof CsvBareValue) return cell.text;
  if (cell === null || cell === undefined || cell === "") return "";
  return `"${neutraliseFormulas(cell).replace(/"/g, '""')}"`;
}

export function encodeCsvRecord(cells: readonly CsvCell[]): string {
  return cells.map(encodeCsvCell).join(",");
}

/** A complete CSV document: BOM, a header record, data records, CRLF after each record. */
export function encodeCsv(
  header: readonly string[],
  records: Iterable<readonly CsvCell[]>,
): string {
  const lines = [encodeCsvRecord(header)];
  for (const record of records) {
    if (record.length !== header.length) {
      throw new RangeError("CSV record length does not match the header");
    }
    lines.push(encodeCsvRecord(record));
  }
  return UTF8_BOM + lines.join(CSV_RECORD_BREAK) + CSV_RECORD_BREAK;
}
