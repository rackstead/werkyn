/**
 * CSV encoding for spreadsheet exports: RFC 4180 framing plus CSV injection
 * (formula) neutralisation following OWASP's CSV Injection guidance.
 *
 * - Text cells are always wrapped in double quotes with embedded quotes
 *   doubled, so commas, quotes, CR and LF inside a value never split a cell or
 *   a record, and a spreadsheet using another list separator still sees one
 *   cell.
 * - A text cell whose first non-blank character a spreadsheet would read as
 *   the start of a formula (= + - @, or the full-width forms some locales
 *   accept), or that starts with a tab, CR or LF, is prefixed with an
 *   apostrophe. Quoting alone does not stop spreadsheets evaluating formulas.
 *   The apostrophe is part of the exported text.
 * - Number and date cells come only from csvDecimal and csvIsoDate and are
 *   written bare, so numeric columns (including negative values) and dates
 *   keep their type.
 * - Records end with CRLF and the document starts with a UTF-8 byte order
 *   mark so spreadsheet applications decode non-ASCII text as UTF-8.
 */

const CSV_RECORD_BREAK = "\r\n";
const UTF8_BOM = "\uFEFF";

const FORMULA_START =
  /^(?:[\t\r\n]|[\s\p{Cc}\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/u;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A number or date written unquoted so spreadsheets keep its type. Only the
 * factories below create one, from values that cannot start a formula.
 */
export class CsvBareValue {
  private constructor(readonly text: string) {}

  /** A decimal cell, e.g. hours or money, with fixed fraction digits. */
  static decimal(value: number, fractionDigits = 2): CsvBareValue {
    if (!Number.isFinite(value)) {
      throw new RangeError("CSV numbers must be finite");
    }
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
  const text = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return `"${text.replace(/"/g, '""')}"`;
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
