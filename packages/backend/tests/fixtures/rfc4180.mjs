// A strict RFC 4180 reader used to check exported CSV independently of the
// encoder: records end with CRLF, fields are separated by commas, quoted
// fields may contain commas, CR, LF and doubled quotes, and anything else
// (a bare quote or line break inside an unquoted field, text after a closing
// quote, an unterminated quoted field) is rejected.
export function parseCsv(text) {
  const records = [];
  let record = [];
  let i = 0;
  const fail = (message) => {
    throw new SyntaxError(`${message} at offset ${i}`);
  };
  const endField = () => {
    if (text.startsWith("\r\n", i)) {
      records.push(record);
      record = [];
      i += 2;
      return true;
    }
    if (text[i] === ",") {
      i += 1;
      if (i === text.length) fail("field missing after separator");
      return true;
    }
    if (i === text.length) {
      fail("record not terminated by CRLF");
    }
    return false;
  };
  while (i < text.length) {
    if (text[i] === '"') {
      let value = "";
      i += 1;
      for (;;) {
        if (i >= text.length) fail("unterminated quoted field");
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      record.push({ value, quoted: true });
      if (!endField()) fail("unexpected text after closing quote");
    } else {
      let value = "";
      while (i < text.length && text[i] !== "," && text[i] !== "\r") {
        if (text[i] === '"' || text[i] === "\n") fail("quote or line break in unquoted field");
        value += text[i];
        i += 1;
      }
      if (text[i] === "\r" && text[i + 1] !== "\n") fail("bare CR in unquoted field");
      record.push({ value, quoted: false });
      if (!endField()) fail("unexpected character");
    }
  }
  if (record.length > 0) fail("record not terminated by CRLF");
  const width = records[0]?.length;
  for (const [index, row] of records.entries()) {
    if (row.length !== width) throw new SyntaxError(`record ${index} has ${row.length} fields, expected ${width}`);
  }
  return records;
}

export const values = (records) => records.map((row) => row.map((field) => field.value));
