import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import { craftZip, DEFLATED } from "../fixtures/crafted-zip.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const childEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-json-budget-integration-jwt-secret",
  COOKIE_SECRET: "backup-json-budget-integration-cookie-secret",
};
Object.assign(process.env, childEnv);
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-json-"));
const storageDir = path.join(root, "storage");
const casesDir = path.join(root, "cases");
await mkdir(storageDir);
await mkdir(casesDir);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");

const KiB = 1024;
const MiB = 1 << 20;
const TOO_LARGE = "Invalid backup file: the backup data exceeds the restore limits";
const ARCHIVE_TOO_LARGE = "Invalid backup ZIP: the archive exceeds the restore limits";
const FORMAT = "Invalid backup file format: ";
const backendDir = new URL("../..", import.meta.url);
const suffix = crypto.randomUUID().slice(0, 8);
const META = {
  version: "1.1",
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceWorkspace: { name: "Crafted", slug: "crafted" },
  userRefs: [],
};
let app, admin, token, source, target;

before(async () => {
  app = await buildApp();
  await app.ready();
  admin = await app.prisma.user.create({
    data: {
      email: `backup-json-${suffix}@example.test`,
      displayName: "Backup JSON admin",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: admin.id, email: admin.email });
  [source, target] = await Promise.all(
    ["source", "target"].map((name) =>
      app.prisma.workspace.create({
        data: {
          name: `Backup JSON ${name}`,
          slug: `backup-json-${name}-${suffix}`,
          members: { create: { userId: admin.id, role: "ADMIN" } },
        },
      }),
    ),
  );
});

after(async () => {
  // Rows are created here, not in the children, so a crashed child leaves nothing.
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [source?.id, target?.id].filter(Boolean) } },
      });
      if (admin) await app.prisma.user.deleteMany({ where: { id: admin.id } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Every file under the storage root with its digest. */
async function tree(dir = storageDir, out = new Map()) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    if (info.isDirectory()) await tree(full, out);
    else out.set(path.relative(storageDir, full), sha256(await readFile(full)));
  }
  return out;
}

async function rowCounts() {
  const where = { workspaceId: target.id };
  return {
    spaces: await app.prisma.wikiSpace.count({ where }),
    projects: await app.prisma.project.count({ where }),
    channels: await app.prisma.chatChannel.count({ where }),
  };
}

/** A valid backup with one wiki space whose single page holds `content`. */
function spaceBackup(label, content = []) {
  return {
    metadata: META,
    projects: [],
    channels: [],
    wikiSpaces: [
      { space: { name: label }, pages: [{ _originalId: "page", title: label, position: 0, content }] },
    ],
  };
}

const zipOf = (json) => craftZip([{ name: "backup.json", content: json, method: DEFLATED }]);

/**
 * Upload every case to the real preview and restore routes from a child with
 * a 1 GiB data segment and the given heap, one JSON line per response.
 */
async function runChild(name, cases, heapMiB = 256) {
  const manifest = path.join(casesDir, `${name}.manifest.json`);
  const files = [];
  for (const item of cases) {
    const file = path.join(casesDir, `${name}-${item.label}`);
    await writeFile(file, item.upload);
    files.push({
      label: item.label,
      file,
      filename: item.filename ?? "backup.zip",
      actions: item.actions ?? ["preview", "restore"],
    });
  }
  await writeFile(
    manifest,
    JSON.stringify({ workspaceId: target.id, token, cases: files }),
  );
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'ulimit -S -d 1048576 || exit 90; exec "$@"',
      "sh",
      process.execPath,
      `--max-old-space-size=${heapMiB}`,
      "--import",
      "tsx",
      "tests/integration/support/backup-upload-child.mjs",
      manifest,
    ],
    {
      cwd: backendDir,
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...childEnv, STORAGE_DIR: storageDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
  const [code, signal] = await new Promise((resolve) =>
    child.on("close", (...result) => resolve(result)),
  );
  clearTimeout(timer);
  for (const file of files) await rm(file.file, { force: true });
  assert.notEqual(code, 90, "could not set the data-segment limit");
  const lines = stdout
    .split("\n")
    .filter((line) => line.startsWith('{"label":'))
    .map((line) => JSON.parse(line));
  return {
    code,
    signal,
    stderr,
    results: new Map(lines.map((line) => [`${line.label} ${line.action}`, line])),
    lines,
  };
}

/** Assert every case got its expected status and message, then a clean exit. */
function expectResults(t, run, cases) {
  t.diagnostic(`child exit: ${run.code ?? run.signal}; ${run.lines.length} responses`);
  for (const line of run.lines)
    t.diagnostic(`${line.label} ${line.action}: ${line.statusCode} ${line.maxRssMiB} MiB`);
  for (const item of cases) {
    for (const action of item.actions ?? ["preview", "restore"]) {
      const result = run.results.get(`${item.label} ${action}`);
      assert.ok(
        result,
        `${item.label} ${action}: no response; child exited ${run.code ?? run.signal}: ${run.stderr.slice(-400)}`,
      );
      const body = JSON.stringify(result.body);
      assert.ok(!body.includes("secret"), `${item.label} ${action} echoed upload content`);
      if (item.expect === 200) {
        assert.equal(result.statusCode, 200, `${item.label} ${action}: ${body.slice(0, 300)}`);
        continue;
      }
      assert.equal(result.statusCode, 400, `${item.label} ${action}: ${body.slice(0, 300)}`);
      if (item.expect === FORMAT) {
        assert.ok(result.body.message.startsWith(FORMAT), `${item.label} ${action}: ${body.slice(0, 300)}`);
        // Validation stops after the first five problems.
        assert.ok(result.body.message.slice(FORMAT.length).split("; ").length <= 5);
      } else {
        assert.equal(result.body.message, item.expect, `${item.label} ${action}`);
      }
    }
  }
  assert.equal(run.code, 0, run.stderr.slice(-400));
}

test("amplifying backup.json uploads get a 400 and the server stays up", async (t) => {
  // R1 of the PR 88 review: `{}` elements cost about 100 bytes of heap per
  // JSON byte once validation reports each of them, and deflate about 1000:1.
  const amplify = (bytes) => {
    const head = '{"metadata":{},"projects":[';
    return Buffer.from(`${head}${"{},".repeat(Math.floor((bytes - head.length - 4) / 3))}{}]}`);
  };
  // Invalid tasks report five problems each. 750,000 of them, about 2 MiB,
  // exceed the object limit.
  const invalidTasks = Buffer.from(
    JSON.stringify({ metadata: META, projects: [{ project: { name: "p" }, tasks: [] }] }).replace(
      '"tasks":[]',
      `"tasks":[${Array(750_000).fill("{}").join(",")}]`,
    ),
  );
  const channels = Buffer.from(
    JSON.stringify({
      metadata: META,
      channels: Array.from({ length: 10 }, () => ({ channel: { type: "secret-channel-type" } })),
    }),
  );
  const legit = Buffer.from(JSON.stringify(spaceBackup(`Legit after ${suffix}`)));
  const four = amplify(4 * MiB);
  const twentyFour = amplify(24 * MiB);
  const cases = [
    { label: "zip-4mib", upload: zipOf(four), expect: TOO_LARGE },
    { label: "zip-24mib", upload: zipOf(twentyFour), expect: TOO_LARGE },
    { label: "json-24mib", upload: twentyFour, filename: "backup.json", expect: TOO_LARGE },
    { label: "zip-invalid-tasks", upload: zipOf(invalidTasks), expect: TOO_LARGE },
    { label: "json-invalid-tasks", upload: invalidTasks, filename: "backup.json", expect: TOO_LARGE },
    { label: "enum-values", upload: channels, filename: "backup.json", expect: FORMAT },
    // The same process still restores a legitimate backup afterwards.
    { label: "legit-after", upload: zipOf(legit), expect: 200 },
  ];
  // The 4 MiB case is the review's 4,235-byte reproduction.
  assert.ok(cases[0].upload.length < 8 * KiB, `${cases[0].upload.length}`);
  const before = await tree();
  const run = await runChild("amplify", cases);
  expectResults(t, run, cases);

  // Refusals wrote nothing: only the legitimate restore added a space.
  assert.deepEqual(await tree(), before);
  assert.deepEqual(await rowCounts(), { spaces: 1, projects: 0, channels: 0 });
  assert.equal(run.results.get("legit-after restore").body.data.wikiSpaces, 1);
});

const limits = () => import("../../src/modules/backup/backup-json.ts");
const unlimited = { maxBytes: Infinity, maxTokens: Infinity, maxObjects: Infinity, maxDepth: Infinity };

test("backup.json limits: exactly at each limit is accepted, one more is refused", async (t) => {
  const { BACKUP_JSON_LIMITS: L, inspectBackupJson } = await limits();
  const measure = (json) => inspectBackupJson(Buffer.from(json), unlimited);
  const label = (name) => `Limits ${name} ${suffix}`;
  const single = (name) => JSON.stringify(spaceBackup(label(name), [0]));

  // Pad a valid backup with trailing whitespace to an exact size.
  const padded = (name, bytes) => {
    const json = JSON.stringify(spaceBackup(label(name)));
    return Buffer.from(json + " ".repeat(bytes - json.length));
  };
  // Content [0,0,…] adds one token per element after the first.
  const tokens = (name, count) => {
    const zeros = Array(count - measure(single(name)).tokens + 1).fill("0").join(",");
    return Buffer.from(single(name).replace('"content":[0]', `"content":[${zeros}]`));
  };
  // Content [{},{},…] adds one object per element.
  const objects = (name, count) => {
    const empties = Array(count - measure(single(name)).objects).fill("{}").join(",");
    return Buffer.from(single(name).replace('"content":[0]', `"content":[${empties}]`));
  };
  // The page sits five levels deep, so content nests `depth - 5` arrays.
  const nested = (name, depth) => {
    const levels = depth - 5;
    return Buffer.from(
      JSON.stringify(spaceBackup(label(name), 0)).replace(
        '"content":0',
        `"content":${"[".repeat(levels)}0${"]".repeat(levels)}`,
      ),
    );
  };

  const atBytes = padded("at-bytes", L.maxBytes);
  const overBytes = padded("over-bytes", L.maxBytes + 1);
  const atTokens = tokens("at-tokens", L.maxTokens);
  const overTokens = tokens("over-tokens", L.maxTokens + 1);
  const atObjects = objects("at-objects", L.maxObjects);
  const overObjects = objects("over-objects", L.maxObjects + 1);
  const atDepth = nested("at-depth", L.maxDepth);
  const overDepth = nested("over-depth", L.maxDepth + 1);
  assert.equal(measure(atBytes).bytes, L.maxBytes);
  assert.equal(measure(atTokens).tokens, L.maxTokens);
  assert.equal(measure(overTokens).tokens, L.maxTokens + 1);
  assert.equal(measure(atObjects).objects, L.maxObjects);
  assert.equal(measure(overObjects).objects, L.maxObjects + 1);
  assert.equal(measure(atDepth).depth, L.maxDepth);
  assert.equal(measure(overDepth).depth, L.maxDepth + 1);

  // Validation stops early, but the whole file is still parsed first. These
  // are the most expensive invalid uploads the limits allow: `{}` up to the
  // object limit, then `[]` up to the token limit.
  const invalid = (head, tail) => {
    const base = measure(`${head}{}${tail}`);
    const empties = Array(1 + L.maxObjects - base.objects).fill("{}");
    const arrays = Array(Math.floor((L.maxTokens - base.tokens - 2 * (empties.length - 1)) / 2)).fill("[]");
    return Buffer.from(`${head}${empties.concat(arrays).join(",")}${tail}`);
  };
  const invalidProjects = invalid('{"metadata":{},"projects":[', "]}");
  const invalidTasks = invalid(
    `{"metadata":${JSON.stringify(META)},"projects":[{"project":{"name":"p"},"tasks":[`,
    "]}]}",
  );
  for (const json of [invalidProjects, invalidTasks]) {
    const stats = measure(json);
    assert.equal(stats.objects, L.maxObjects);
    assert.ok(stats.tokens > L.maxTokens - 2 && stats.tokens <= L.maxTokens, `${stats.tokens}`);
  }

  const cases = [
    { label: "at-bytes", upload: zipOf(atBytes), expect: 200, actions: ["preview"] },
    { label: "at-bytes-json", upload: atBytes, filename: "backup.json", expect: 200, actions: ["preview"] },
    { label: "over-bytes", upload: zipOf(overBytes), expect: ARCHIVE_TOO_LARGE },
    { label: "over-bytes-json", upload: overBytes, filename: "backup.json", expect: TOO_LARGE },
    { label: "at-tokens", upload: zipOf(atTokens), expect: 200, actions: ["preview"] },
    { label: "over-tokens", upload: zipOf(overTokens), expect: TOO_LARGE },
    { label: "at-objects", upload: zipOf(atObjects), expect: 200, actions: ["preview"] },
    { label: "over-objects", upload: zipOf(overObjects), expect: TOO_LARGE },
    { label: "at-depth", upload: zipOf(atDepth), expect: 200 },
    { label: "over-depth", upload: zipOf(overDepth), expect: TOO_LARGE },
    { label: "invalid-projects-at-limits", upload: zipOf(invalidProjects), expect: FORMAT },
    { label: "invalid-tasks-at-limits", upload: invalidTasks, filename: "backup.json", expect: FORMAT },
  ];
  const before = await rowCounts();
  const run = await runChild("limits", cases);
  expectResults(t, run, cases);
  // Only the at-depth restore wrote a row.
  const now = await rowCounts();
  assert.equal(now.spaces, before.spaces + 1);
  assert.equal(run.results.get("at-tokens preview").body.data.wikiPages, 1);
  const page = await app.prisma.wikiPage.findFirst({
    where: { space: { workspaceId: target.id, name: label("at-depth") } },
  });
  let depth = 5;
  for (let node = page.content; Array.isArray(node); node = node[0]) depth++;
  assert.equal(depth, L.maxDepth);
});

test("the most expensive accepted backup.json files preview in a 256 MiB heap", async (t) => {
  const { BACKUP_JSON_LIMITS: L, inspectBackupJson } = await limits();
  const measure = (json) => inspectBackupJson(Buffer.from(json), unlimited);
  const id = (i) => i.toString(36);
  // The bytes left over go to one string with a character above U+00FF, which
  // makes V8 store the whole text, and that string, with two bytes per character.
  const meta = () =>
    '{"version":"1.1","exportedAt":"x","sourceWorkspace":{"name":"\u0100","slug":"s"},"userRefs":[]}';
  const pad = (shell) =>
    Buffer.from(shell.replace("\u0100", `\u0100${"a".repeat(L.maxBytes - Buffer.byteLength(shell))}`));
  // As many elements as the object and token limits allow.
  const fill = (head, unit, tail) => {
    const one = measure(`[${unit(0)}]`);
    const two = measure(`[${unit(0)},${unit(1)}]`);
    const base = measure(`${head}${unit(0)}${tail}`);
    let count = 1 + Math.floor((L.maxTokens - base.tokens) / (two.tokens - one.tokens));
    const perObject = two.objects - one.objects;
    if (perObject) count = Math.min(count, 1 + Math.floor((L.maxObjects - base.objects) / perObject));
    return pad(`${head}${Array.from({ length: count }, (_, i) => unit(i)).join(",")}${tail}`);
  };
  const content = (body) =>
    pad(
      `{"metadata":${meta()},"wikiSpaces":[{"space":{"name":"s"},"pages":[{"_originalId":"p","title":"t","position":0,"content":${body}}]}]}`,
    );
  const keys = Array.from({ length: L.maxTokens / 2 - 30 }, (_, i) => `"${id(i)}":0`).join(",");
  const cases = {
    tasks: fill(
      `{"metadata":${meta()},"projects":[{"project":{"name":"p"},"tasks":[`,
      // Restore refuses repeated task ids and unknown priorities.
      (i) => `{"_originalId":"${id(i)}","title":"","priority":"NONE","position":0,"statusRef":"s"}`,
      "]}]}",
    ),
    projects: fill(`{"metadata":${meta()},"projects":[`, () => '{"project":{"name":""}}', "]}"),
    pages: fill(
      `{"metadata":${meta()},"wikiSpaces":[{"space":{"name":"s"},"pages":[`,
      // Chains of 200 pages: restore refuses trees deeper than 256 pages.
      (i) => `{"_originalId":"${id(i)}","title":"","position":0,"parentRef":${(i + 1) % 200 ? `"${id(i + 1)}"` : "null"}}`,
      "]}]}",
    ),
    // Preview answers with one mapping per user reference.
    userRefs: fill(
      '{"metadata":{"version":"1.1","exportedAt":"x","sourceWorkspace":{"name":"\u0100","slug":"s"},"userRefs":[',
      (i) => `{"originalId":"${id(i)}","email":"${id(i)}@x","displayName":"${id(i)}"}`,
      "]}}",
    ),
    // Distinct member names, all in one object.
    keys: content(`{${keys}}`),
    objects: content(
      `[${Array(L.maxObjects - 10).fill("{}").concat(Array(Math.floor(L.maxTokens / 2) - L.maxObjects - 30).fill("[]")).join(",")}]`,
    ),
    // One array of distinct strings that Zod validates element by element.
    // Validation holds a result per element until the array is done, so this
    // is the most expensive shape per token.
    assignees: fill(
      `{"metadata":${meta()},"projects":[{"project":{"name":"p"},"tasks":[{"_originalId":"t","title":"t","priority":"NONE","position":0,"statusRef":"s","assignees":[`,
      (i) => `"${id(i)}"`,
      "]}]}]}",
    ),
    labels: fill(
      `{"metadata":${meta()},"projects":[{"project":{"name":"p"},"tasks":[{"_originalId":"t","title":"t","priority":"NONE","position":0,"statusRef":"s","labels":[`,
      (i) => `"${id(i)}"`,
      "]}]}]}",
    ),
  };
  const uploads = [];
  for (const [label, json] of Object.entries(cases)) {
    const stats = measure(json);
    t.diagnostic(`${label}: ${stats.bytes} bytes, ${stats.tokens} tokens, ${stats.objects} objects`);
    assert.equal(stats.bytes, L.maxBytes, label);
    assert.ok(stats.tokens <= L.maxTokens && stats.objects <= L.maxObjects, label);
    assert.ok(stats.tokens > L.maxTokens * 0.9 || stats.objects > L.maxObjects - 5, label);
    uploads.push({ label, upload: zipOf(json), expect: 200, actions: ["preview"] });
  }
  const run = await runChild("worst", uploads);
  expectResults(t, run, uploads);
  assert.equal(run.results.get("projects preview").body.data.projects, Math.floor((L.maxObjects - 3) / 2));
});

test("a realistic large export restores byte for byte in a memory-limited server", async (t) => {
  const { BACKUP_JSON_LIMITS: L, inspectBackupJson } = await import(
    "../../src/modules/backup/backup-json.ts"
  );
  // 2 projects with 3,000 tasks, 6,000 subtasks and 3,000 comments, a channel
  // with 3,000 messages, and 2 wiki spaces with 300 pages and 600 images,
  // including SEC-009 upload names.
  const projects = [];
  for (let p = 0; p < 2; p++) {
    const project = await app.prisma.project.create({
      data: { workspaceId: source.id, name: `Large ${p} ${suffix}` },
    });
    const status = await app.prisma.statusColumn.create({
      data: { projectId: project.id, name: "Open" },
    });
    await app.prisma.task.createMany({
      data: Array.from({ length: 1500 }, (_, i) => ({
        projectId: project.id,
        statusId: status.id,
        title: `Task ${p}-${i} ${"lorem ipsum ".repeat(4)}`,
        description: `<p>${"Description text with some detail. ".repeat(6)}ü</p>`,
        position: i,
      })),
    });
    const tasks = await app.prisma.task.findMany({
      where: { projectId: project.id },
      select: { id: true },
    });
    await app.prisma.subtask.createMany({
      data: tasks.flatMap((task) => [
        { taskId: task.id, title: "Step one" },
        { taskId: task.id, title: "Step two", completed: true, position: 1 },
      ]),
    });
    await app.prisma.comment.createMany({
      data: tasks.map((task) => ({
        taskId: task.id,
        authorId: admin.id,
        body: "A comment on this task. ".repeat(4),
      })),
    });
    projects.push(project);
  }
  const channel = await app.prisma.chatChannel.create({
    data: {
      workspaceId: source.id,
      name: `large-${suffix}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
  });
  await app.prisma.chatMessage.createMany({
    data: Array.from({ length: 3000 }, (_, i) => ({
      channelId: channel.id,
      userId: admin.id,
      content: `<p>Message ${i} with a little text in it 👍</p>`,
    })),
  });
  const spaces = [];
  const sourceDigests = new Map();
  const extensions = [".png", ".jpg", ".100%25", ".p?rev", ".üml"];
  let image = 0;
  for (let s = 0; s < 2; s++) {
    const space = await app.prisma.wikiSpace.create({
      data: { workspaceId: source.id, name: `Large space ${s} ${suffix}`, slug: `large-${s}-${suffix}` },
    });
    spaces.push(space);
    for (let p = 0; p < 150; p++) {
      const content = [
        { type: "heading", props: { level: 2 }, content: [{ type: "text", text: `Section ${p}`, styles: {} }] },
        { type: "paragraph", content: [{ type: "text", text: "Page body text. ".repeat(30), styles: {} }] },
        {
          type: "bulletListItem",
          content: [{ type: "text", text: "Item", styles: {} }],
          children: [{ type: "bulletListItem", content: [{ type: "text", text: "Nested", styles: {} }] }],
        },
      ];
      for (let k = 0; k < 2; k++) {
        const bytes = crypto.randomBytes(24 * KiB);
        const stored = await app.storage.save(
          `${source.id}/uploads/wiki`,
          space.id,
          crypto.randomUUID(),
          extensions[image++ % extensions.length],
          bytes,
        );
        sourceDigests.set(`/storage/${stored}`, sha256(bytes));
        content.push({ type: "image", props: { url: `/storage/${stored}` } });
      }
      await app.prisma.wikiPage.create({
        data: { spaceId: space.id, title: `Page ${s}-${p}`, position: p, createdById: admin.id, content },
      });
    }
  }

  const exported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${source.id}/backup/export`,
    payload: {
      projects: projects.map((project) => ({ projectId: project.id })),
      channels: [{ channelId: channel.id }],
      wikiSpaces: spaces.map((space) => ({ spaceId: space.id })),
      includeFiles: true,
    },
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(exported.statusCode, 200, exported.body.slice(0, 300));
  const zip = exported.rawPayload;
  const json = new AdmZip(zip).getEntry("backup.json").getData();
  const stats = inspectBackupJson(json);
  t.diagnostic(
    `export: zip ${zip.length} bytes; backup.json ${stats.bytes} bytes, ${stats.tokens} tokens, ${stats.objects} objects, depth ${stats.depth}; ` +
      `headroom bytes ${(L.maxBytes / stats.bytes).toFixed(1)}x, tokens ${(L.maxTokens / stats.tokens).toFixed(1)}x, ` +
      `objects ${(L.maxObjects / stats.objects).toFixed(1)}x, depth ${(L.maxDepth / stats.depth).toFixed(1)}x`,
  );

  const cases = [{ label: "realistic", upload: zip, expect: 200 }];
  const run = await runChild("realistic", cases);
  expectResults(t, run, cases);
  const summary = run.results.get("realistic restore").body.data;
  assert.deepEqual(
    [summary.projects, summary.tasks, summary.subtasks, summary.comments, summary.messages, summary.wikiPages, summary.images],
    [2, 3000, 6000, 3000, 3000, 300, 600],
  );
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(run.results.get("realistic preview").body.data.images, 600);

  // Tasks, messages and every image come back byte for byte.
  const titles = (workspaceId) =>
    app.prisma.task.findMany({
      where: { project: { workspaceId, name: { startsWith: "Large " } } },
      select: { title: true, description: true },
      orderBy: { title: "asc" },
    });
  assert.deepEqual(await titles(target.id), await titles(source.id));
  const messages = (workspaceId) =>
    app.prisma.chatMessage.findMany({
      where: { channel: { workspaceId, name: `large-${suffix}` } },
      select: { content: true },
      orderBy: { content: "asc" },
    });
  assert.deepEqual(await messages(target.id), await messages(source.id));
  const pages = (workspaceId) =>
    app.prisma.wikiPage.findMany({
      where: { space: { workspaceId, name: { startsWith: "Large space" } } },
      select: { title: true, content: true },
      orderBy: { title: "asc" },
    });
  const sourcePages = await pages(source.id);
  const restoredPages = await pages(target.id);
  assert.equal(restoredPages.length, 300);
  let checked = 0;
  for (const [index, page] of restoredPages.entries()) {
    const original = sourcePages[index];
    assert.equal(page.title, original.title);
    assert.deepEqual(page.content.slice(0, 3), original.content.slice(0, 3));
    const urls = page.content.slice(3).map((block) => block.props.url);
    const originalUrls = original.content.slice(3).map((block) => block.props.url);
    assert.equal(urls.length, 2);
    for (const [k, url] of urls.entries()) {
      assert.ok(url.startsWith(`/storage/${target.id}/uploads/wiki/imports/`), url);
      const bytes = await readFile(path.join(storageDir, url.slice("/storage/".length)));
      assert.equal(sha256(bytes), sourceDigests.get(originalUrls[k]));
      checked++;
    }
  }
  assert.equal(checked, 600);
});
