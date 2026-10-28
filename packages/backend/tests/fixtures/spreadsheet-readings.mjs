// Models of how readers other than a comma-separated RFC 4180 parser split an
// exported CSV document into cells, used to check that no reading starts a
// cell with a formula. Independent of the encoder under test.
//
// - "quote-aware" follows LibreOffice's CSV import: a field is quoted only if
//   its first character is a quote (doubled quotes inside are literal), text
//   after a closing quote is appended, and line breaks outside quotes end the
//   record.
// - "line-split" ignores quotes entirely: it splits records at every line
//   break (as str.splitlines-style readers do) and fields at every separator.
const LINE_BREAK = /\r\n|[\n\x0B\x0C\r\x1C-\x1E\x85\u{2028}\u{2029}]/u;

export const READINGS = [
  ...[[","], [";"], ["\t"], [",", ";", "\t"]].flatMap((separators) => [
    { name: `quote-aware ${JSON.stringify(separators.join(""))}`, separators, quoteAware: true },
    { name: `line-split ${JSON.stringify(separators.join(""))}`, separators, quoteAware: false },
  ]),
];

function readQuoteAware(text, separators) {
  const cells = [];
  let i = 0;
  while (i < text.length) {
    let value = "";
    if (text[i] === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
    }
    while (i < text.length && !separators.includes(text[i]) && text[i] !== "\r" && text[i] !== "\n") {
      value += text[i];
      i += 1;
    }
    cells.push(value);
    if (separators.includes(text[i])) {
      i += 1;
      if (i === text.length) cells.push("");
    } else if (text.startsWith("\r\n", i)) i += 2;
    else i += 1;
  }
  return cells;
}

/** Every cell a reader with these settings would produce from the document. */
export function cellsUnder(text, { separators, quoteAware }) {
  if (quoteAware) return readQuoteAware(text, separators);
  const split = new RegExp(`[${separators.map((s) => (s === "\t" ? "\\t" : s)).join("")}]`);
  return text.split(LINE_BREAK).flatMap((line) => line.split(split));
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
// After any blanks, control or format characters and quotes, the first
// character is one a spreadsheet reads as the start of a formula. An
// apostrophe first is the text marker, so it makes the cell inert.
const FORMULA_LEAD = /^[\s\p{Cc}\p{Cf}"]*[=+\-@\u{FF1D}\u{FF0B}\u{FF0D}\u{FF20}]/u;

export function formulaLike(cell) {
  return !PLAIN_NUMBER.test(cell) && FORMULA_LEAD.test(cell);
}
