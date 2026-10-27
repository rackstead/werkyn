import assert from "node:assert/strict";
import { validateHeaderValue } from "node:http";
import test from "node:test";
import { formatContentDisposition } from "../src/utils/content-disposition.ts";

function parameters(header) {
  assert.doesNotThrow(() => validateHeaderValue("Content-Disposition", header));
  assert.match(header, /^[\x20-\x7e]+$/);
  const match = header.match(
    /^(attachment|inline); filename="([^"\\]*)"; filename\*=UTF-8''(.*)$/,
  );
  assert(match, header);
  assert.match(match[3], /^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})*$/);
  return {
    type: match[1],
    fallback: match[2],
    name: decodeURIComponent(match[3]),
  };
}

test("a raw Unicode fallback fails caught Node validation while the formatter preserves its name", () => {
  assert.throws(
    () =>
      validateHeaderValue(
        "Content-Disposition",
        'attachment; filename="資料.txt"',
      ),
    { code: "ERR_INVALID_CHAR" },
  );
  assert.deepEqual(parameters(formatContentDisposition("資料.txt")), {
    type: "attachment",
    fallback: "__.txt",
    name: "資料.txt",
  });
});

test("ordinary ASCII and spaces remain intact and inline stays an explicit caller choice", () => {
  assert.equal(
    formatContentDisposition("quarterly report.txt"),
    "attachment; filename=\"quarterly report.txt\"; filename*=UTF-8''quarterly%20report.txt",
  );
  assert.deepEqual(
    parameters(formatContentDisposition("photo.png", "inline")),
    {
      type: "inline",
      fallback: "photo.png",
      name: "photo.png",
    },
  );
});

test("quotes, backslashes and percent escapes get an unambiguous fallback and exact extended value", () => {
  for (const [name, fallback] of [
    ['quoted "name".txt', "quoted _name_.txt"],
    ["literal%20name.txt", "literal_20name.txt"],
    ["back\\slash.txt", "back_slash.txt"],
    ["O'Brien (draft)*.txt", "O'Brien (draft)*.txt"],
  ])
    assert.deepEqual(parameters(formatContentDisposition(name)), {
      type: "attachment",
      fallback,
      name,
    });
  assert.equal(
    formatContentDisposition("O'Brien (draft)*.txt").split("filename*=")[1],
    "UTF-8''O%27Brien%20%28draft%29%2A.txt",
  );
});

test("Unicode code points and combining text round-trip without normalization or data mutation", () => {
  for (const name of [
    "café.txt",
    "emoji-📄.txt",
    "e\u0301.txt",
    "資料 résumé.txt",
  ]) {
    assert.equal(parameters(formatContentDisposition(name)).name, name);
  }
});

test("bounded nonprinting and malformed legacy strings produce valid header values without throwing", () => {
  for (const name of [
    "line\nname.txt",
    "tab\tname.txt",
    "nul\0name.txt",
    "del\x7fname.txt",
    "lone-\ud800.txt",
    "",
  ]) {
    const result = parameters(formatContentDisposition(name));
    assert.equal(result.name, Buffer.from(name, "utf8").toString("utf8"));
    assert(result.fallback.length > 0);
  }
});
