import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { BackupFileSchema } from "@pm/shared";
import { z } from "zod";

const { BACKUP_JSON_LIMITS, BACKUP_VALIDATION_BATCH_VALUES, inspectBackupJson, parseBackupJson } =
  await import("../src/modules/backup/backup-json.ts");

const backendDir = new URL("..", import.meta.url);
const scratch = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-validation-"));
after(() => rm(scratch, { recursive: true, force: true }));

const FORMAT = "Invalid backup file format: ";
const META = {
  version: "1.1",
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceWorkspace: { name: "Crafted", slug: "crafted" },
  userRefs: [],
};
const unlimited = { maxBytes: Infinity, maxTokens: Infinity, maxObjects: Infinity, maxDepth: Infinity };

/** Deterministic PRNG (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A valid backup large enough that validation walks it in several pieces:
 * long userRefs, a project with hundreds of tasks, one task with a long
 * assignee list, a busy channel and a page with large content.
 */
function makeBackup(rand) {
  const id = (prefix, i) => `${prefix}-${i}`;
  const users = Array.from({ length: 300 }, (_, i) => ({ originalId: id("u", i), email: `u${i}@example.test`, displayName: `User ${i}` }));
  const task = (i) => ({
    _originalId: id("t", i),
    title: `Task ${i}`,
    description: i % 3 ? `<p>Body ${i}</p>` : null,
    priority: "MEDIUM",
    position: i,
    dueDate: i % 4 ? null : "2026-02-01",
    statusRef: "s-1",
    createdByRef: id("u", i % 300),
    assignees: [id("u", i % 300)],
    labels: i % 2 ? ["l-1"] : [],
    subtasks: Array.from({ length: i % 3 }, (_, j) => ({ _originalId: `st-${i}-${j}`, title: "Sub", completed: j % 2 === 0, position: j })),
    customFieldValues: i % 5 ? [] : [{ fieldRef: "cf-1", value: { nested: [1, 2, { x: i }] } }],
    dependencies: i > 0 && i % 7 === 0 ? [{ blockingTaskRef: id("t", i - 1) }] : [],
    comments: Array.from({ length: i % 2 }, (_, j) => ({ _originalId: `c-${i}-${j}`, body: "Comment", authorRef: null, createdAt: META.exportedAt })),
    activityLogs: [],
  });
  const tasks = Array.from({ length: 260 + Math.floor(rand() * 40) }, (_, i) => task(i));
  tasks[17].assignees = Array.from({ length: 700 }, (_, i) => id("u", i % 300));
  const messages = Array.from({ length: 350 }, (_, i) => ({
    _originalId: id("m", i),
    content: `Message ${i}`,
    userRef: id("u", i % 300),
    parentRef: i % 10 === 1 ? id("m", i - 1) : null,
    createdAt: META.exportedAt,
    reactions: i % 4 ? [] : [{ userRef: id("u", 1), emoji: "👍" }],
  }));
  const bigContent = Array.from({ length: 400 }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `Line ${i}`, styles: {} }] }));
  return {
    metadata: { ...META, userRefs: users },
    projects: [
      {
        project: { name: "Main", description: null, color: "#336699", icon: null },
        statuses: [{ _originalId: "s-1", name: "To Do", color: null, position: 0, isCompletion: false }],
        labels: [{ _originalId: "l-1", name: "Bug", color: "#ff0000" }],
        customFields: [{ _originalId: "cf-1", name: "Size", type: "TEXT", options: null, required: false, position: 0 }],
        members: [{ userRef: "u-1" }],
        tasks,
        attachments: [],
      },
      { project: { name: "Small" }, tasks: [task(1000)] },
    ],
    channels: [{ channel: { name: "general", description: null, type: "PUBLIC" }, members: [{ userRef: "u-1" }], messages }],
    wikiSpaces: [
      {
        space: { name: "Docs", description: null, icon: null },
        pages: [
          { _originalId: "p-1", title: "Big", content: bigContent, position: 0, comments: [] },
          { _originalId: "p-2", title: "Child", content: null, position: 1, parentRef: "p-1", comments: [{ _originalId: "wc-1", body: "Note", highlightId: "h1", createdAt: META.exportedAt }] },
        ],
      },
    ],
  };
}

/** Every path to a value inside `value`. */
function paths(value, prefix = [], out = []) {
  out.push(prefix);
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) paths(child, [...prefix, key], out);
  }
  return out;
}

function mutate(doc, rand, count) {
  const all = paths(doc).filter((p) => p.length > 0);
  for (let n = 0; n < count; n++) {
    const target = all[Math.floor(rand() * all.length)];
    let parent = doc;
    for (const key of target.slice(0, -1)) parent = parent?.[key];
    if (parent === null || typeof parent !== "object") continue;
    const key = target.at(-1);
    const choice = Math.floor(rand() * 7);
    if (choice === 0 && !Array.isArray(parent)) delete parent[key];
    else parent[key] = [null, 7, "text", {}, [], true, "NOT-AN-ENUM"][choice];
  }
  return doc;
}

/**
 * What a single full Zod parse reports. Independent of parseBackupJson's error
 * map: the parse uses only the shared default wording, and the two messages
 * that would quote the upload are rewritten here from the finished issues.
 */
function reference(text) {
  const raw = JSON.parse(text);
  const result = BackupFileSchema.safeParse(raw, { reportInput: true });
  if (result.success) return { data: result.data };
  const message = (issue) => {
    if (issue.code === "invalid_value" && typeof issue.input === "string") return issue.message.replace(/, received '[\s\S]*'$/, "");
    if (issue.code === "unrecognized_keys") return "Unrecognized key(s) in object";
    return issue.message;
  };
  return { message: FORMAT + result.error.issues.slice(0, 5).map(message).join("; ") };
}

function bounded(text) {
  try {
    return { data: parseBackupJson(Buffer.from(text), unlimited) };
  } catch (error) {
    assert.equal(error.statusCode, 400, error.message);
    return { message: error.message };
  }
}

test("bounded validation reports what a full parse reports, in the same order", () => {
  const rand = random(20261030);
  const base = JSON.stringify(makeBackup(rand));
  // The fixture is large enough that validation splits it.
  assert.ok(inspectBackupJson(Buffer.from(base), unlimited).tokens > 20 * BACKUP_VALIDATION_BATCH_VALUES);
  const valid = bounded(base);
  assert.deepEqual(valid, reference(base));
  let invalid = 0;
  for (let i = 0; i < 300; i++) {
    const text = JSON.stringify(mutate(JSON.parse(base), rand, 1 + Math.floor(rand() * 12)));
    const expected = reference(text);
    assert.deepEqual(bounded(text), expected, `mutation ${i}`);
    if (expected.message) invalid++;
  }
  assert.ok(invalid > 200, `${invalid} of 300 mutations were invalid`);
});

test("enum problems read as on Zod 3 and never quote the upload", () => {
  const meta = (version) => JSON.stringify({ metadata: { ...META, version }, channels: [{ channel: { type: "secret-type" } }] });
  assert.equal(
    bounded(meta(5)).message,
    `${FORMAT}Expected '1.0' | '1.1', received number; Invalid enum value. Expected 'PUBLIC' | 'PRIVATE'`,
  );
  assert.equal(
    bounded(meta(null)).message,
    `${FORMAT}Expected '1.0' | '1.1', received null; Invalid enum value. Expected 'PUBLIC' | 'PRIVATE'`,
  );
  assert.equal(
    bounded(meta("secret-version")).message,
    `${FORMAT}Invalid enum value. Expected '1.0' | '1.1'; Invalid enum value. Expected 'PUBLIC' | 'PRIVATE'`,
  );
  assert.equal(bounded(JSON.stringify({ metadata: { ...META, version: undefined } })).message, `${FORMAT}Required`);
});

test("a custom field value without `value` is accepted whether the entry is small or walked", () => {
  const task = (entry) => ({ _originalId: "t", title: "t", priority: "LOW", position: 0, statusRef: "s", customFieldValues: [entry] });
  const doc = (entry, extra = []) => JSON.stringify({ metadata: META, projects: [{ project: { name: "p" }, tasks: [task(entry), ...extra] }] });
  const small = { fieldRef: "cf" };
  const walked = { fieldRef: "cf", junk: Array(BACKUP_VALIDATION_BATCH_VALUES + 100).fill(0) };
  for (const entry of [small, walked]) {
    const { data } = bounded(doc(entry));
    assert.deepEqual(data.projects[0].tasks[0].customFieldValues, [{ fieldRef: "cf" }]);
    assert.deepEqual(bounded(doc(entry)), reference(doc(entry)));
    // A later problem is still the first reported, the same for both sizes.
    const bad = { ...task({ fieldRef: "cf", value: 1 }), title: 5 };
    assert.equal(bounded(doc(entry, [bad])).message, `${FORMAT}Expected string, received number`);
  }
});

test("defaults are applied and unknown keys stripped as before", () => {
  const text = JSON.stringify({
    metadata: META,
    extra: { secret: 1 },
    projects: [{ project: { name: "p", extra: 1 }, tasks: [{ _originalId: "t", title: "t", priority: "LOW", position: 0, statusRef: "s", dependencies: [{ blockingTaskRef: "x" }] }] }],
  });
  assert.deepEqual(bounded(text), reference(text));
  const { data } = bounded(text);
  assert.deepEqual(data.projects[0].tasks[0].dependencies, [{ blockingTaskRef: "x", type: "blocks" }]);
  assert.equal("extra" in data, false);
});

/** Run the guarded child under a 1 GiB data-segment limit and a small heap. */
function runLimited(files, heapMiB, mode = "guarded") {
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      'ulimit -S -d 1048576 || exit 90; exec "$@"',
      "sh",
      process.execPath,
      `--max-old-space-size=${heapMiB}`,
      "--import",
      "tsx",
      "tests/fixtures/backup-json-child.mjs",
      mode,
      ...files,
    ],
    { cwd: backendDir, encoding: "utf8", timeout: 180_000 },
  );
  assert.notEqual(result.status, 90, "could not set the data-segment limit");
  const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, lines };
}

test("invalid files at the limits are refused with five problems in a 64 MiB heap, wherever the bad values sit", async () => {
  const L = BACKUP_JSON_LIMITS;
  // `{}` up to the object limit, then `[]` up to the token limit, inside `build`.
  const most = (build, filler = "{}") => {
    const base = inspectBackupJson(Buffer.from(build([filler])), unlimited);
    const objects = filler === "{}" ? Array(1 + L.maxObjects - base.objects).fill("{}") : [];
    const tokensLeft = L.maxTokens - base.tokens - 2 * Math.max(objects.length - 1, 0);
    const rest = Array(Math.floor(tokensLeft / (filler === "{}" ? 2 : 1))).fill(filler === "{}" ? "[]" : filler);
    return build(objects.concat(rest));
  };
  const meta = JSON.stringify(META);
  const project = (inner) => `{"metadata":${meta},"projects":[{"project":{"name":"p"},${inner}}]}`;
  const task = '{"_originalId":"t","title":"t","priority":"LOW","position":0,"statusRef":"s"';
  const cases = {
    projects: most((e) => `{"metadata":{},"projects":[${e.join(",")}]}`),
    tasks: most((e) => project(`"tasks":[${e.join(",")}]`)),
    subtasks: most((e) => project(`"tasks":[${task},"subtasks":[${e.join(",")}]}]`)),
    // One task with a million numbers where strings belong: one issue per number.
    assignees: most((e) => project(`"tasks":[${task},"assignees":[${e.join(",")}]}]`), "0"),
    userRefs: most((e) => `{"metadata":{"version":"1.1","exportedAt":"x","sourceWorkspace":{"name":"n","slug":"s"},"userRefs":[${e.join(",")}]}}`),
    messages: most((e) => `{"metadata":${meta},"channels":[{"channel":{"type":"PUBLIC"},"messages":[${e.join(",")}]}]}`),
    pages: most((e) => `{"metadata":${meta},"wikiSpaces":[{"space":{"name":"s"},"pages":[${e.join(",")}]}]}`),
  };
  const files = [];
  for (const [label, text] of Object.entries(cases)) {
    const stats = inspectBackupJson(Buffer.from(text));
    assert.ok(stats.tokens > L.maxTokens * 0.99, `${label}: ${stats.tokens} tokens`);
    files.push(path.join(scratch, `${label}.json`));
    await writeFile(files.at(-1), text);
  }
  const run = runLimited(files, 64);
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  assert.equal(run.lines.length, files.length);
  for (const [i, line] of run.lines.entries()) {
    const label = Object.keys(cases)[i];
    assert.equal(line.statusCode, 400, `${label}: ${line.message}`);
    assert.ok(line.message.startsWith(FORMAT), `${label}: ${line.message}`);
    assert.equal(line.message.slice(FORMAT.length).split("; ").length, 5, `${label}: ${line.message}`);
    assert.ok(line.ms < 15_000, `${label} took ${line.ms} ms`);
  }
  // One whole-file Zod parse of the same kind of file does not fit that heap.
  const whole = runLimited([files[Object.keys(cases).indexOf("assignees")]], 64, "unguarded");
  assert.notEqual(whole.status, 0);
  assert.deepEqual(whole.lines, []);
  assert.match(whole.stderr, /heap out of memory/);
});

test("BackupFileSchema uses only constructs the bounded walk understands", () => {
  // The walk splits z.object (unknown keys stripped) and z.array without length
  // checks, and unwraps .optional(), .nullable() and .default(). Anything else
  // (refinements, transforms, unions, records, strict or catchall objects,
  // array bounds) would be validated whole, so a large value of that kind could
  // again build an issue per element. Extend the walk before the schema.
  const leaves = [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodEnum, z.ZodUnknown];
  const problems = [];
  const visit = (schema, at) => {
    if (schema instanceof z.ZodDefault) return visit(schema.removeDefault(), at);
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return visit(schema.unwrap(), at);
    if (schema instanceof z.ZodArray) {
      if (schema.def.checks?.length) problems.push(`${at}: array check`);
      return visit(schema.element, `${at}[]`);
    }
    if (schema instanceof z.ZodObject) {
      if (schema.def.catchall !== undefined) problems.push(`${at}: object is not in strip mode`);
      if (schema.def.checks?.length) problems.push(`${at}: object refinement`);
      for (const [key, field] of Object.entries(schema.shape)) {
        // Zod 4 requires a key whose schema is a bare z.unknown(), and the walk
        // cannot see an absent key, so such a field must be .optional().
        if (field instanceof z.ZodUnknown) problems.push(`${at ? `${at}.` : ""}${key}: required unknown`);
        visit(field, at ? `${at}.${key}` : key);
      }
      return;
    }
    if (!leaves.some((type) => schema instanceof type)) problems.push(`${at}: ${schema.constructor.name}`);
  };
  visit(BackupFileSchema, "");
  assert.deepEqual(problems, []);
  // The guard itself notices what it should.
  const probe = (schema) => {
    problems.length = 0;
    visit(schema, "x");
    return problems.length;
  };
  assert.equal(probe(z.object({ a: z.string() }).superRefine(() => {})), 1);
  assert.equal(probe(z.object({ a: z.string() }).strict()), 1);
  assert.equal(probe(z.array(z.string()).max(5)), 1);
  assert.equal(probe(z.object({ a: z.union([z.string(), z.number()]) })), 1);
  assert.equal(probe(z.object({ a: z.record(z.string(), z.string()) })), 1);
  assert.equal(probe(z.object({ a: z.unknown() })), 1);
  assert.equal(probe(z.object({ a: z.unknown().optional() })), 0);
});

/** In-process best-of-three timings, so CI load affects both sides alike. */
function fastest(fn) {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    try {
      fn();
    } catch {
      // Refusals are timed too.
    }
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test("an object with half a million keys is counted once, however deep the walk goes", () => {
  // The largest object the token limit allows, as an unknown key of a subtask:
  // the walk passes it on the way to the task fields. Counting its keys again
  // for each walked ancestor made validation take 5x the time of JSON.parse.
  const L = BACKUP_JSON_LIMITS;
  const giant = `{${Array.from({ length: Math.floor(L.maxTokens / 2) - 80 }, (_, i) => `"${i.toString(36)}":0`).join(",")}}`;
  const sub = `{"zzz":${giant},"_originalId":"s","title":"t","completed":false,"position":0}`;
  const task = `{"subtasks":[${sub}],"_originalId":"t","title":"t","priority":"LOW","position":0,"statusRef":"s"}`;
  const valid = Buffer.from(`{"projects":[{"tasks":[${task}],"project":{"name":"p"}}],"metadata":${JSON.stringify(META)}}`);
  inspectBackupJson(valid);
  assert.equal(parseBackupJson(valid).projects[0].tasks[0].subtasks[0].title, "t");
  const parse = fastest(() => JSON.parse(valid.toString("utf-8")));
  const validate = fastest(() => parseBackupJson(valid));
  // About 1.7x here; 5.5x before the counts were kept per parse.
  assert.ok(validate < 3 * parse + 50, `validation took ${validate.toFixed(0)} ms, JSON.parse ${parse.toFixed(0)} ms`);
  assert.ok(validate < 5_000, `validation took ${validate.toFixed(0)} ms`);
});
