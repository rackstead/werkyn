import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const {
  BACKUP_JSON_LIMITS,
  BACKUP_JSON_TOO_LARGE_MESSAGE,
  BackupJsonError,
  inspectBackupJson,
  parseBackupJson,
} = await import("../src/modules/backup/backup-json.ts");

const backendDir = new URL("..", import.meta.url);
const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-json-"));
after(() => rm(scratch, { recursive: true, force: true }));

const unlimited = { maxBytes: Infinity, maxTokens: Infinity, maxDepth: Infinity };
const measure = (text) => inspectBackupJson(Buffer.from(text), unlimited);
const META = {
  version: "1.1",
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceWorkspace: { name: "Crafted", slug: "crafted" },
  userRefs: [],
};
const FORMAT = "Invalid backup file format: ";
/** `{"metadata":{},"projects":[{},{},…]}` with `count` elements. */
const emptyProjects = (count) =>
  `{"metadata":{},"projects":[${Array(count).fill("{}").join(",")}]}`;
/** Tasks missing every required field report five problems each. */
const emptyTasks = (count) =>
  `{"metadata":${JSON.stringify(META)},"projects":[{"project":{"name":"p"},"tasks":[${Array(count).fill("{}").join(",")}]}]}`;

/** Values and member names in a parsed document, and its empty containers. */
function census(value, out = { nodes: 1, empty: 0 }) {
  if (value === null || typeof value !== "object") return out;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) out.empty++;
  // An object member is a name and a value.
  out.nodes += Array.isArray(value) ? children.length : children.length * 2;
  for (const child of children) census(child, out);
  return out;
}

test("tokens bound the values and member names JSON.parse creates", () => {
  assert.deepEqual(measure("0"), { bytes: 1, tokens: 1, depth: 0 });
  assert.deepEqual(measure(" [ ] "), { bytes: 5, tokens: 2, depth: 1 });
  assert.deepEqual(measure('{"a":[1,2,{"b":null}]}'), { bytes: 22, tokens: 8, depth: 3 });
  // Structural characters inside strings, escaped quotes and backslashes, and
  // multi-byte UTF-8 are all string content.
  const text = '["{[,:]}\\"[","\\\\","ü{\\u0022,","[\\\\\\"]"]';
  assert.equal(JSON.parse(text).length, 4);
  assert.deepEqual(measure(text), { bytes: Buffer.byteLength(text), tokens: 5, depth: 1 });

  // Exactly the values and names plus one per empty container.
  const samples = [
    JSON.stringify({ metadata: META, projects: [], wikiSpaces: [{ space: { name: "s" }, pages: [{}] }] }),
    JSON.stringify([[[[]]], {}, { a: { b: [1, "x", true, null, { c: [] }] } }], null, 2),
    JSON.stringify({ "k,:{": ["v]}", { '"q"': "\\" }], e: {} }),
  ];
  for (const sample of samples) {
    const { nodes, empty } = census(JSON.parse(sample));
    assert.equal(measure(sample).tokens, nodes + empty, sample);
  }
});

test("each limit is inclusive and refuses one more with a fixed message", () => {
  const assertTooLarge = (text, reason, limits) =>
    assert.throws(
      () => parseBackupJson(Buffer.from(text), limits),
      (error) => {
        assert.ok(error instanceof BackupJsonError, String(error));
        assert.equal(error.statusCode, 400);
        assert.equal(error.reason, reason);
        assert.equal(error.message, BACKUP_JSON_TOO_LARGE_MESSAGE);
        return true;
      },
    );
  const json = JSON.stringify({ metadata: META, wikiSpaces: [{ space: { name: "s" }, pages: [] }] });
  const stats = measure(json);
  assert.deepEqual(stats, { bytes: json.length, tokens: 26, depth: 4 });
  const exact = { maxBytes: stats.bytes, maxTokens: stats.tokens, maxDepth: stats.depth };
  assert.equal(parseBackupJson(Buffer.from(json), exact).wikiSpaces.length, 1);
  assertTooLarge(json, "json-size", { ...exact, maxBytes: stats.bytes - 1 });
  assertTooLarge(json, "json-tokens", { ...exact, maxTokens: stats.tokens - 1 });
  assertTooLarge(json, "json-depth", { ...exact, maxDepth: stats.depth - 1 });

  // The defaults, at and over each limit.
  const L = BACKUP_JSON_LIMITS;
  const valid = JSON.stringify({ metadata: META });
  parseBackupJson(Buffer.from(valid + " ".repeat(L.maxBytes - valid.length)));
  assertTooLarge(valid + " ".repeat(L.maxBytes - valid.length + 1), "json-size");
  const zeros = (count) => `[${Array(count).fill("0").join(",")}]`;
  assert.equal(measure(zeros(L.maxTokens - 1)).tokens, L.maxTokens);
  assert.throws(() => parseBackupJson(Buffer.from(zeros(L.maxTokens - 1))), { message: /^Invalid backup file format: / });
  assertTooLarge(zeros(L.maxTokens), "json-tokens");
  const nested = (depth) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
  assert.throws(() => parseBackupJson(Buffer.from(nested(L.maxDepth))), { message: /^Invalid backup file format: / });
  assertTooLarge(nested(L.maxDepth + 1), "json-depth");
});

test("validation stops after five problems and never quotes the upload", () => {
  const parse = (text) => {
    try {
      parseBackupJson(Buffer.from(text));
    } catch (error) {
      assert.equal(error.statusCode, 400);
      return error.message;
    }
    assert.fail("accepted");
  };
  const started = Date.now();
  for (const text of [emptyProjects(500_000), emptyTasks(500_000)]) {
    const message = parse(text);
    assert.ok(message.startsWith(FORMAT), message);
    assert.deepEqual(message.slice(FORMAT.length).split("; "), Array(5).fill("Required"));
  }
  assert.ok(Date.now() - started < 10_000);

  const channels = JSON.stringify({
    metadata: { ...META, version: "secret-version" },
    channels: [{ channel: { type: "secret-type" } }],
  });
  assert.equal(
    parse(channels),
    `${FORMAT}Invalid enum value. Expected '1.0' | '1.1'; Invalid enum value. Expected 'PUBLIC' | 'PRIVATE'`,
  );
  assert.equal(parse('{"metadata":'), "Invalid JSON file");
  const backup = parseBackupJson(Buffer.from(JSON.stringify({ metadata: META })));
  assert.deepEqual(backup, { metadata: META, projects: [], channels: [], wikiSpaces: [] });
});

test("ZIP restore and export apply the same backup.json limits", async () => {
  const {
    ARCHIVE_TOO_LARGE_MESSAGE,
    BACKUP_ARCHIVE_LIMITS,
    BackupArchiveError,
    BackupExportBudget,
    EXPORT_TOO_LARGE_MESSAGE,
    readBackupArchive,
  } = await import("../src/modules/backup/backup-archive.ts");
  const { craftZip, DEFLATED } = await import("./fixtures/crafted-zip.mjs");
  const json = Buffer.from(JSON.stringify({ metadata: META, projects: [] }, null, 2));
  const zip = (size) => craftZip([{ name: "backup.json", content: json, method: DEFLATED, size }]);
  const jsonTooLarge = (error) =>
    error instanceof BackupArchiveError &&
    error.reason === "json-size" &&
    error.message === ARCHIVE_TOO_LARGE_MESSAGE;

  assert.ok(readBackupArchive(zip(), BACKUP_ARCHIVE_LIMITS, json.length).jsonBuffer.equals(json));
  assert.throws(() => readBackupArchive(zip(), BACKUP_ARCHIVE_LIMITS, json.length - 1), jsonTooLarge);
  // The declared size is refused before anything is inflated; inflating this
  // entry would otherwise fail on its size.
  assert.throws(() => readBackupArchive(zip(BACKUP_JSON_LIMITS.maxBytes + 1)), jsonTooLarge);

  // Export refuses exactly what restore would refuse.
  const stats = measure(json);
  const exact = { maxBytes: stats.bytes, maxTokens: stats.tokens, maxDepth: stats.depth };
  new BackupExportBudget(BACKUP_ARCHIVE_LIMITS, exact).addBackupJson(json);
  for (const key of Object.keys(exact)) {
    assert.throws(
      () => new BackupExportBudget(BACKUP_ARCHIVE_LIMITS, { ...exact, [key]: exact[key] - 1 }).addBackupJson(json),
      { statusCode: 400, message: EXPORT_TOO_LARGE_MESSAGE },
      key,
    );
  }
  // backup.json still counts against the archive budget.
  assert.throws(
    () => new BackupExportBudget({ ...BACKUP_ARCHIVE_LIMITS, maxTotalBytes: json.length - 1 }).addBackupJson(json),
    { statusCode: 400, message: EXPORT_TOO_LARGE_MESSAGE },
  );
});

/** Run the child under a 1 GiB data-segment limit and a 128 MiB heap. */
function runLimited(mode, files) {
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      'ulimit -S -d 1048576 || exit 90; exec "$@"',
      "sh",
      process.execPath,
      "--max-old-space-size=128",
      "--import",
      "tsx",
      "tests/fixtures/backup-json-child.mjs",
      mode,
      ...files,
    ],
    { cwd: backendDir, encoding: "utf8", timeout: 120_000 },
  );
  assert.notEqual(result.status, 90, "could not set the data-segment limit");
  const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, lines };
}

test("backup files that abort an unguarded parse are refused in a memory-limited process", async () => {
  const L = BACKUP_JSON_LIMITS;
  // As many `{}` elements (two tokens each) as the token limit lets through.
  const most = (build) => build(1 + Math.floor((L.maxTokens - measure(build(1)).tokens) / 2));
  const cases = {
    // The review's 4 MiB reproduction, about 4 KB once deflated.
    amplify: emptyProjects(Math.floor((4 << 20) / 3)),
    // The most expensive invalid documents the token limit lets through.
    projects: most(emptyProjects),
    tasks: most(emptyTasks),
  };
  const files = {};
  for (const [label, text] of Object.entries(cases)) {
    files[label] = path.join(scratch, `${label}.json`);
    await writeFile(files[label], text);
  }
  for (const text of [cases.projects, cases.tasks])
    assert.ok(measure(text).tokens > L.maxTokens - 2 && measure(text).tokens <= L.maxTokens);

  const guarded = runLimited("guarded", Object.values(files));
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.deepEqual(
    guarded.lines.map((line) => [line.statusCode, line.reason ?? line.message.slice(0, FORMAT.length)]),
    [
      [400, "json-tokens"],
      [400, FORMAT],
      [400, FORMAT],
    ],
  );

  // The same heap aborts the process that validates every element.
  const unguarded = runLimited("unguarded", [files.tasks]);
  assert.notEqual(unguarded.status, 0);
  assert.deepEqual(unguarded.lines, []);
  assert.match(unguarded.stderr, /heap out of memory/);
});
