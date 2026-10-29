import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, test } from "node:test";
import archiver from "archiver";
import {
  craftZip,
  crc32,
  DEFLATED,
  storedLocalRecord,
  zip64Extra,
} from "./fixtures/crafted-zip.mjs";

const {
  ARCHIVE_INVALID_MESSAGE,
  ARCHIVE_TOO_LARGE_MESSAGE,
  BACKUP_ARCHIVE_LIMITS,
  BackupArchiveError,
  BackupExportBudget,
  EXPORT_TOO_LARGE_MESSAGE,
  inspectBackupArchive,
  readBackupArchive,
} = await import("../src/modules/backup/backup-archive.ts");

const MiB = 1 << 20;
const backendDir = new URL("..", import.meta.url);
const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-archive-"));
after(() => rm(scratch, { recursive: true, force: true }));

const json = (content = '{"metadata":{}}') => ({
  name: "backup.json",
  content: Buffer.from(content),
});
const asset = (name, content = Buffer.from("asset bytes")) => ({
  name: `assets/${name}`,
  content,
});

/** Assert that reading `zip` is refused with `reason` and a fixed message. */
function assertRefused(zip, reason, { overBudget = false, limits } = {}) {
  assert.throws(
    () => readBackupArchive(zip, limits),
    (error) => {
      assert.ok(error instanceof BackupArchiveError, String(error));
      assert.equal(error.statusCode, 400);
      assert.equal(error.reason, reason);
      assert.equal(
        error.message,
        overBudget ? ARCHIVE_TOO_LARGE_MESSAGE : ARCHIVE_INVALID_MESSAGE,
      );
      return true;
    },
  );
}

/** Build a ZIP with archiver exactly as backup.service.ts packages an export. */
function archiverZip(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, data] of entries) archive.append(data, { name });
    archive.finalize();
  });
}

test("the documented restore budget", () => {
  assert.deepEqual({ ...BACKUP_ARCHIVE_LIMITS }, {
    maxEntries: 10_000,
    maxNameBytes: 1024,
    maxPathSegments: 16,
    maxEntryBytes: 512 * MiB,
    maxTotalBytes: 1024 * MiB,
  });
  assert.ok(Object.isFrozen(BACKUP_ARCHIVE_LIMITS));
});

test("an export-shaped archiver ZIP is read byte for byte", async () => {
  // Stored file names are a UUID plus the upload's own extension, including
  // literal percent, query and fragment characters and non-ASCII text.
  const id = () => crypto.randomUUID();
  const assets = new Map([
    [`assets/${id()}.png`, crypto.randomBytes(256 * 1024)],
    [`assets/${id()}.bin`, Buffer.alloc(MiB, "werkyn backup ")],
    [`assets/${id()}.txt`, Buffer.alloc(0)],
    [`assets/${id()}.100%`, Buffer.from("percent")],
    [`assets/${id()}.100%25`, Buffer.from("encoded percent")],
    [`assets/${id()}.p%2f`, Buffer.from("encoded slash")],
    [`assets/${id()}.p?rev#tag`, Buffer.from("query and fragment")],
    [`assets/${id()}.üml`, Buffer.from("café")],
  ]);
  const jsonText = JSON.stringify({ metadata: { version: "1.1" }, assets: [...assets.keys()] }, null, 2);
  const zip = await archiverZip([["backup.json", jsonText], ...assets]);

  const entries = inspectBackupArchive(zip);
  assert.deepEqual(entries.map((e) => e.name), ["backup.json", ...assets.keys()]);
  const { jsonBuffer, assets: read } = readBackupArchive(zip);
  assert.equal(jsonBuffer.toString(), jsonText);
  assert.deepEqual([...read.keys()], [...assets.keys()]);
  for (const [name, bytes] of assets) assert.ok(read.get(name).equals(bytes), name);
});

test("folders, directory entries and a valid archive comment are accepted", () => {
  const zip = craftZip(
    [json(), { name: "assets/" }, asset("a.png"), { name: "notes/readme.txt", content: Buffer.from("x") }],
    { comment: Buffer.from("made by hand") },
  );
  const { assets } = readBackupArchive(zip);
  assert.deepEqual([...assets.keys()], ["assets/a.png"]);
});

test("entry count includes the parent folders adm-zip creates", () => {
  // backup.json + assets/ + n files: n = 9,998 is exactly 10,000 entries.
  const files = (n) =>
    Array.from({ length: n }, (_, i) => ({ name: `assets/${i}`, content: Buffer.from("x") }));
  const atLimit = craftZip([json(), ...files(9_998)]);
  assert.equal(readBackupArchive(atLimit).assets.size, 9_998);
  assertRefused(craftZip([json(), ...files(9_999)]), "entry-count", { overBudget: true });

  // Every distinct folder costs as much as a file.
  const limits = { ...BACKUP_ARCHIVE_LIMITS, maxEntries: 5 };
  const nested = [json(), { name: "a/b/c/x", content: Buffer.from("x") }];
  assert.equal(inspectBackupArchive(craftZip(nested), limits).length, 2);
  assertRefused(
    craftZip([...nested, { name: "a/y", content: Buffer.from("y") }]),
    "entry-count",
    { overBudget: true, limits },
  );
});

test("an end record declaring too many entries is refused before the walk", () => {
  assertRefused(
    craftZip([json()], { entryCount: BACKUP_ARCHIVE_LIMITS.maxEntries + 1 }),
    "entry-count",
    { overBudget: true },
  );
});

test("entry names are limited to 1,024 bytes and 16 path segments", () => {
  const named = (name) => craftZip([json(), { name, content: Buffer.from("x") }]);
  const longest = `assets/${"é".repeat(508)}x`; // 7 + 1,016 + 1 bytes
  assert.equal(Buffer.byteLength(longest), 1024);
  assert.equal(readBackupArchive(named(longest)).assets.size, 1);
  assertRefused(named(`${longest}y`), "name-length", { overBudget: true });

  const deepest = `assets/${"d/".repeat(14)}x.png`;
  assert.equal(deepest.split("/").length, 16);
  assert.equal(readBackupArchive(named(deepest)).assets.size, 1);
  assertRefused(named(`assets/${"d/".repeat(15)}x.png`), "path-depth", { overBudget: true });
  // Backslashes count as separators too.
  assertRefused(named(`assets/${"d\\".repeat(15)}x.png`), "path-depth", { overBudget: true });
});

test("declared sizes are budgeted per entry and in total before reading", () => {
  const content = Buffer.from("hello");
  const declaring = (...sizes) =>
    craftZip([
      json(),
      ...sizes.map((size, i) => ({ ...asset(`${i}.png`, content), method: DEFLATED, size })),
    ]);
  const { maxEntryBytes, maxTotalBytes } = BACKUP_ARCHIVE_LIMITS;
  assertRefused(declaring(maxEntryBytes + 1), "entry-size", { overBudget: true });
  assertRefused(declaring(0xfffffffe), "entry-size", { overBudget: true });
  assertRefused(declaring(400 * MiB, 400 * MiB, 400 * MiB), "total-size", { overBudget: true });
  assert.ok(400 * MiB * 2 < maxTotalBytes);
  assertRefused(
    craftZip([{ ...json(), method: DEFLATED, size: maxEntryBytes + 1 }]),
    "entry-size",
    { overBudget: true },
  );

  // Exact boundaries with real bytes under smaller limits.
  const limits = { ...BACKUP_ARCHIVE_LIMITS, maxEntryBytes: 1000, maxTotalBytes: 1500 };
  const bytes = (n) => crypto.randomBytes(n);
  const zip = (...sizes) =>
    craftZip([{ name: "backup.json", content: Buffer.from("{}") }, ...sizes.map((n, i) => asset(`${i}`, bytes(n)))]);
  assert.equal(readBackupArchive(zip(998), limits).assets.size, 1);
  assertRefused(zip(999), "entry-size", { overBudget: true, limits: { ...limits, maxEntryBytes: 998 } });
  assert.equal(readBackupArchive(zip(1000, 498), limits).assets.size, 2);
  assertRefused(zip(1000, 499), "total-size", { overBudget: true, limits });
});

test("every entry must inflate to exactly its declared size", () => {
  const content = Buffer.from("honest bytes");
  // Declared larger than the data: the budget was checked against a lie.
  assertRefused(
    craftZip([json(), { ...asset("a.png", content), method: DEFLATED, size: 1000 }]),
    "size-mismatch",
  );
  assertRefused(
    craftZip([json(), { ...asset("a.png", content), compressedSize: 0, data: Buffer.alloc(0), size: content.length }]),
    "stored-size",
  );
  assertRefused(
    craftZip([json(), { ...asset("a.png", content), size: content.length - 1 }]),
    "stored-size",
  );
  // A declared size of zero still caps inflation.
  assertRefused(
    craftZip([json(), { ...asset("a.png", Buffer.alloc(MiB)), method: DEFLATED, size: 0, crc: 0 }]),
    "read-failed",
  );
});

test("inflation stops at the declared size", (t) => {
  const outputs = [];
  const original = zlib.inflateRawSync;
  t.mock.method(zlib, "inflateRawSync", (data, options) => {
    try {
      const out = original(data, options);
      outputs.push({ limit: options?.maxOutputLength, length: out.length });
      return out;
    } catch (error) {
      outputs.push({ limit: options?.maxOutputLength, error: error.code });
      throw error;
    }
  });
  const bomb = Buffer.alloc(64 * MiB);
  assertRefused(
    craftZip([
      json(),
      { ...asset("bomb.png", bomb), method: DEFLATED, size: 1024, crc: crc32(bomb.subarray(0, 1024)) },
    ]),
    "read-failed",
  );
  assert.deepEqual(outputs, [{ limit: 1024, error: "ERR_BUFFER_TOO_LARGE" }]);
});

test("duplicate names are refused, including names that decode alike", () => {
  assertRefused(craftZip([json(), json()]), "duplicate-name");
  assertRefused(craftZip([json(), asset("dup.png"), asset("dup.png")]), "duplicate-name");
  assertRefused(
    craftZip([
      json(),
      { rawName: Buffer.from([0x61, 0x2f, 0xff]), content: Buffer.from("1") },
      { rawName: Buffer.from([0x61, 0x2f, 0xfe]), content: Buffer.from("2") },
    ]),
    "duplicate-name",
  );
  // Case variants stay distinct, as they did before.
  assert.equal(readBackupArchive(craftZip([json(), asset("X.png"), asset("x.png")])).assets.size, 2);
});

test("truncated or inconsistent directories are refused", () => {
  const good = craftZip([json(), asset("a.png"), asset("b.png")]);
  const endAt = good.length - 22;
  const directorySize = good.readUInt32LE(endAt + 12);
  const directoryOffset = good.readUInt32LE(endAt + 16);
  const entries = [json(), asset("a.png"), asset("b.png")];

  assertRefused(Buffer.alloc(0), "no-end-record");
  assertRefused(good.subarray(0, 40), "no-end-record");
  assertRefused(good.subarray(0, good.length - 1), "no-end-record");
  assertRefused(craftZip(entries, { entryCount: 4 }), "directory-truncated");
  assertRefused(craftZip(entries, { entryCount: 2 }), "directory-extent");
  assertRefused(craftZip(entries, { directorySize: directorySize - 1 }), "directory-extent");
  assertRefused(craftZip(entries, { directoryOffset: directoryOffset + 1 }), "directory-extent");
  // The end record is intact but the directory before it was cut short.
  const cut = Buffer.concat([good.subarray(0, endAt - 10), good.subarray(endAt)]);
  assertRefused(cut, "directory-extent");
  const badSignature = Buffer.from(good);
  badSignature.writeUInt32LE(0x02014b51, directoryOffset);
  assertRefused(badSignature, "directory-truncated");
  assertRefused(craftZip(entries, { trailing: Buffer.from("junk") }), "trailing-data");
  // A second end record just before the real one would change adm-zip's choice.
  assertRefused(
    craftZip([json(), { name: "assets/x-PK\u0005\u0006", content: Buffer.from("x") }]),
    "ambiguous-end-record",
  );
  // A legacy JSON body uploaded under a .zip name is not an archive.
  assertRefused(Buffer.from('{"metadata":{}}'), "no-end-record");
});

test("zip64, encrypted, multi-disk and unsupported entries are refused", () => {
  const content = Buffer.from("hello");
  const one = (entry, options) => craftZip([json(), { ...asset("a.png", content), ...entry }], options);
  assertRefused(one({ extra: zip64Extra(content.length, content.length) }), "zip64");
  assertRefused(one({ size: 0xffffffff, compressedSize: 0xffffffff, data: content }), "zip64");
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  assertRefused(one({}, { beforeEnd: locator }), "zip64");
  assertRefused(one({ flags: 0x0801 }), "unsupported-flags");
  assertRefused(one({ flags: 0x0841 }), "unsupported-flags");
  assertRefused(one({ localFlags: 0x0801 }), "unsupported-flags");
  assertRefused(one({ method: 12, data: content }), "unsupported-method");
  assertRefused(one({ method: 99, data: content }), "unsupported-method");
  const malformedExtra = Buffer.from([0x55, 0x54, 0x09, 0x00, 0x01]);
  assertRefused(one({ extra: malformedExtra }), "extra-field");
  // Other extra fields (here an extended timestamp) are fine.
  const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0]);
  assert.equal(readBackupArchive(one({ extra: timestamp })).assets.size, 1);
});

test("local headers must agree with the central directory", () => {
  const content = Buffer.from("hello");
  const one = (entry) => craftZip([json(), { ...asset("a.png", content), ...entry }]);
  assertRefused(one({ localName: "assets/b.png" }), "local-mismatch");
  assertRefused(one({ localMethod: DEFLATED }), "local-mismatch");
  assertRefused(one({ localCrc: crc32(content) ^ 1 }), "local-mismatch");
  assertRefused(one({ localSize: 4 }), "local-mismatch");
  // With a data descriptor the local values are placeholders.
  const described = one({
    flags: 0x0808,
    method: DEFLATED,
    localCrc: 0,
    localSize: 0,
    localCompressedSize: 0,
  });
  assert.ok(readBackupArchive(described).assets.get("assets/a.png").equals(content));
  assertRefused(one({ compressedSize: 1 << 20 }), "stored-size");
  assertRefused(one({ method: DEFLATED, compressedSize: 1 << 20 }), "local-extent");
});

test("entries may not share bytes", () => {
  // The first entry's data holds a complete local record for the second, so
  // the archive declares the same bytes twice.
  const inner = Buffer.from("inner bytes");
  const record = storedLocalRecord("assets/b.png", inner);
  const outerName = "assets/a.png";
  const zip = craftZip([
    { name: outerName, content: record },
    { name: "assets/b.png", content: inner, localOffset: 30 + outerName.length },
    json(),
  ]);
  assertRefused(zip, "overlapping-entries");
});

test("rejections never quote entry names or adm-zip messages", () => {
  const name = "assets/secret-☃-name.png";
  const content = Buffer.from("checksum fails");
  for (const zip of [
    craftZip([json(), { name, content, crc: crc32(content) ^ 1 }]),
    craftZip([json(), { name, content, method: DEFLATED, crc: crc32(content) ^ 1 }]),
    craftZip([json(), { name, content }, { name, content }]),
  ]) {
    assert.throws(
      () => readBackupArchive(zip),
      (error) => {
        assert.ok(error instanceof BackupArchiveError);
        assert.ok(!error.message.includes("secret"), error.message);
        assert.ok(!error.reason.includes("secret"), error.reason);
        return true;
      },
    );
  }
  assert.throws(() => readBackupArchive(craftZip([asset("a.png")])), {
    statusCode: 400,
    message: "Invalid backup ZIP: missing backup.json",
  });
});

test("the export budget counts entries the way the restore inspection does", () => {
  const tooLarge = { statusCode: 400, message: EXPORT_TOO_LARGE_MESSAGE };
  const counted = new BackupExportBudget({ ...BACKUP_ARCHIVE_LIMITS, maxEntries: 4 });
  for (const name of ["backup.json", "assets/a.png", "assets/a.png", "assets/b.png"]) counted.add(name, 1);
  // backup.json, assets/, a.png and b.png are four entries.
  assert.throws(() => counted.add("assets/c.png", 1), tooLarge);

  const sized = new BackupExportBudget({ ...BACKUP_ARCHIVE_LIMITS, maxTotalBytes: 100 });
  sized.add("backup.json", 40);
  sized.add("assets/a.png", 30);
  // The same name again replaces its size instead of adding to it.
  sized.add("assets/a.png", 30);
  sized.add("assets/b.png", 30);
  assert.throws(() => sized.add("assets/b.png", 31), tooLarge);

  const limits = { ...BACKUP_ARCHIVE_LIMITS, maxEntryBytes: 10 };
  assert.throws(() => new BackupExportBudget(limits).add("assets/x", 11), tooLarge);
  assert.throws(() => new BackupExportBudget().add(`assets/${"x".repeat(1018)}`, 1), tooLarge);
  // archiver stores a backslash as a folder separator.
  assert.throws(() => new BackupExportBudget().add(`assets/${"d\\".repeat(15)}x`, 1), tooLarge);
});

/** Run the child under a 1 GiB data-segment limit and a 256 MiB heap. */
function runLimited(mode, files) {
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      'ulimit -S -d 1048576 || exit 90; exec "$@"',
      "sh",
      process.execPath,
      "--max-old-space-size=256",
      "--import",
      "tsx",
      "tests/fixtures/backup-archive-child.mjs",
      mode,
      ...files,
    ],
    { cwd: backendDir, encoding: "utf8", timeout: 120_000 },
  );
  assert.notEqual(result.status, 90, "could not set the data-segment limit");
  const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, lines };
}

test("archives that crash an unguarded parse are refused inside a memory-limited process", async () => {
  const hello = Buffer.from("hello");
  const cases = {
    // ~120 KB: one name nested 30,000 levels deep.
    deep: craftZip([json(), { name: `assets/${"d/".repeat(30_000)}deep.png`, content: hello }]),
    deepOutsideAssets: craftZip([json(), { name: `${"d/".repeat(30_000)}x`, content: hello }]),
    // ~2 MB: 20,000 one-byte entries.
    many: craftZip([
      json(),
      ...Array.from({ length: 20_000 }, (_, i) => ({ name: `junk/${i}.txt`, content: Buffer.from("x") })),
    ]),
    // 3,400 entries, each with three new folders: 13,600 entries for adm-zip.
    folders: craftZip([
      json(),
      ...Array.from({ length: 3_400 }, (_, i) => ({ name: `f${i}/a/b/x`, content: Buffer.from("x") })),
    ]),
  };
  const files = {};
  for (const [label, zip] of Object.entries(cases)) {
    files[label] = path.join(scratch, `${label}.zip`);
    await writeFile(files[label], zip);
  }
  assert.ok(cases.deep.length < 130_000);

  const guarded = runLimited("guarded", Object.values(files));
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.lines.length, Object.keys(files).length);
  for (const line of guarded.lines) {
    assert.equal(line.ok, false, line.file);
    assert.equal(line.statusCode, 400, line.file);
    assert.equal(line.message, ARCHIVE_TOO_LARGE_MESSAGE, line.file);
    assert.ok(line.maxRssMiB < 300, `${line.file}: ${line.maxRssMiB} MiB`);
  }
  assert.deepEqual(
    guarded.lines.map((line) => line.reason),
    ["name-length", "name-length", "entry-count", "entry-count"],
  );

  // The same limits abort the process that parses the deep name directly.
  const unguarded = runLimited("unguarded", [files.deep]);
  assert.notEqual(unguarded.status, 0);
  assert.deepEqual(unguarded.lines, []);
});
