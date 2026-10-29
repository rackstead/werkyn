import assert from "node:assert/strict";
import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, test } from "node:test";
import AdmZip from "adm-zip";
import {
  craftZip,
  crc32,
  crc32ZeroPadded,
  DEFLATED,
  STORED,
  UNIX_SYMLINK,
} from "../fixtures/crafted-zip.mjs";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-zip-restore-integration-jwt-secret",
  COOKIE_SECRET: "backup-zip-restore-integration-cookie-secret",
});
// Storage lives next to an "outside" directory so any write that escapes the
// storage root, or the upload staging area within it, shows up in one walk.
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-zip-"));
const storageDir = path.join(root, "storage");
const outsideDir = path.join(root, "outside");
await mkdir(storageDir);
await mkdir(outsideDir);
await writeFile(path.join(outsideDir, "sentinel.txt"), "unchanged");
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { exportBackup } = await import("../../src/modules/backup/backup.service.ts");
const { BACKUP_ARCHIVE_LIMITS, EXPORT_TOO_LARGE_MESSAGE, inspectBackupArchive, readBackupArchive } =
  await import("../../src/modules/backup/backup-archive.ts");

const suffix = crypto.randomUUID().slice(0, 8);
const MiB = 1 << 20;
let app, admin, token, source, target, crafted;
let requests = 0;

function inject(method, url, payload, headers = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}`, ...headers },
    remoteAddress: `127.0.3.${1 + (++requests % 200)}`,
  });
}

function upload(workspaceId, action, zip, filename = "backup.zip") {
  const boundary = `zip-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return inject(
    "POST",
    `/api/workspaces/${workspaceId}/backup/${action}`,
    payload,
    { "content-type": `multipart/form-data; boundary=${boundary}` },
  );
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Every path under the test root with its type, size and content digest. */
async function tree(dir = root, out = new Map()) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    const rel = path.relative(root, full);
    if (info.isDirectory()) {
      out.set(rel, "dir");
      await tree(full, out);
    } else {
      out.set(
        rel,
        info.isFile()
          ? `file:${info.size}:${sha256(await readFile(full))}`
          : `other:${info.mode.toString(8)}`,
      );
    }
  }
  return out;
}

/** Paths added since `before`; existing paths must be untouched. */
async function added(before) {
  const now = await tree();
  for (const [rel, value] of before) assert.equal(now.get(rel), value, rel);
  return [...now.keys()].filter((rel) => !before.has(rel) && now.get(rel) !== "dir");
}

const importsDir = (workspaceId) =>
  path.join("storage", workspaceId, "uploads", "wiki", "imports");
const STAGED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/;

function backupJson(label, urls = []) {
  return Buffer.from(
    JSON.stringify({
      metadata: {
        version: "1.1",
        exportedAt: new Date().toISOString(),
        sourceWorkspace: { name: "Crafted", slug: "crafted" },
        userRefs: [],
      },
      projects: [],
      channels: [],
      wikiSpaces: [
        {
          space: { name: label },
          pages: [
            {
              _originalId: "page",
              title: label,
              position: 0,
              content: urls.map((url) => ({ type: "image", props: { url } })),
            },
          ],
        },
      ],
    }),
  );
}

const spaces = (label) =>
  app.prisma.wikiSpace.findMany({
    where: { workspaceId: crafted.id, name: label },
    include: { pages: true },
  });

before(async () => {
  app = await buildApp();
  await app.ready();
  admin = await app.prisma.user.create({
    data: {
      email: `backup-zip-${suffix}@example.test`,
      displayName: "Backup admin",
      emailVerified: true,
    },
  });
  token = signAccessToken({ sub: admin.id, email: admin.email });
  [source, target, crafted] = await Promise.all(
    ["source", "target", "crafted"].map((name) =>
      app.prisma.workspace.create({
        data: {
          name: `Backup ZIP ${name}`,
          slug: `backup-zip-${name}-${suffix}`,
          members: { create: { userId: admin.id, role: "ADMIN" } },
        },
      }),
    ),
  );
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [source?.id, target?.id, crafted?.id].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({ where: { id: admin?.id } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("export then restore keeps tasks, wiki pages and asset bytes", async () => {
  const project = await app.prisma.project.create({
    data: { workspaceId: source.id, name: `Round trip ${suffix}` },
  });
  const status = await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "Open" },
  });
  const first = await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: status.id,
      title: "First task",
      description: "<p>Plain <strong>text</strong> ü</p>",
      position: 0,
    },
  });
  await app.prisma.subtask.create({
    data: { taskId: first.id, title: "Nested step", completed: true },
  });
  await app.prisma.task.create({
    data: { projectId: project.id, statusId: status.id, title: "Second task", position: 1 },
  });

  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `Round trip wiki ${suffix}`, slug: `rt-${suffix}` },
  });
  // Incompressible, highly compressible and empty assets exercise the
  // STORED/DEFLATE paths and the zero-size entry.
  const assets = {
    "photo.png": crypto.randomBytes(256 * 1024),
    "pattern.bin": Buffer.alloc(MiB, "werkyn backup "),
    "empty.txt": Buffer.alloc(0),
  };
  const urls = {};
  for (const [name, bytes] of Object.entries(assets)) {
    const stored = await app.storage.save(
      `${source.id}/uploads/wiki`,
      space.id,
      path.parse(name).name,
      path.extname(name),
      bytes,
    );
    urls[name] = `/storage/${stored}`;
  }
  const parent = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Parent page",
      createdById: admin.id,
      content: Object.values(urls).map((url) => ({ type: "image", props: { url } })),
    },
  });
  await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      parentId: parent.id,
      title: "Child page",
      position: 1,
      createdById: admin.id,
      content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }],
    },
  });

  const exported = await inject("POST", `/api/workspaces/${source.id}/backup/export`, {
    projects: [{ projectId: project.id }],
    wikiSpaces: [{ spaceId: space.id }],
    includeFiles: true,
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const zip = exported.rawPayload;
  assert.deepEqual(
    new AdmZip(zip).getEntries().map((e) => e.entryName).sort(),
    ["assets/empty.txt", "assets/pattern.bin", "assets/photo.png", "backup.json"],
  );

  const preview = await upload(target.id, "preview", zip);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().data.images, 3);

  const before = await tree();
  const restored = await upload(target.id, "restore", zip);
  assert.equal(restored.statusCode, 200, restored.body);
  const summary = restored.json().data;
  assert.equal(summary.projects, 1);
  assert.equal(summary.tasks, 2);
  assert.equal(summary.subtasks, 1);
  assert.equal(summary.wikiSpaces, 1);
  assert.equal(summary.wikiPages, 2);
  assert.equal(summary.images, 3);
  assert.deepEqual(summary.warnings, []);

  const newFiles = await added(before);
  assert.equal(newFiles.length, 3);
  for (const rel of newFiles) {
    assert.equal(path.dirname(rel), importsDir(target.id));
    assert.match(path.basename(rel), STAGED);
  }

  const tasks = await app.prisma.task.findMany({
    where: { project: { workspaceId: target.id, name: project.name } },
    include: { subtasks: true },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    tasks.map((t) => [t.title, t.description, t.subtasks.map((s) => [s.title, s.completed])]),
    [
      ["First task", "<p>Plain <strong>text</strong> ü</p>", [["Nested step", true]]],
      ["Second task", null, []],
    ],
  );

  const pages = await app.prisma.wikiPage.findMany({
    where: { space: { workspaceId: target.id, name: space.name } },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(pages.map((p) => p.title), ["Parent page", "Child page"]);
  assert.equal(pages[1].parentId, pages[0].id);
  assert.deepEqual(pages[1].content, [
    { type: "paragraph", content: [{ type: "text", text: "child" }] },
  ]);
  const restoredUrls = pages[0].content.map((block) => block.props.url);
  assert.equal(restoredUrls.length, 3);
  for (const [index, name] of Object.keys(assets).entries()) {
    const url = restoredUrls[index];
    assert.ok(url.startsWith(`/storage/${target.id}/uploads/wiki/imports/`), url);
    assert.equal(path.extname(url), path.extname(name));
    const bytes = await readFile(path.join(storageDir, url.slice("/storage/".length)));
    assert.equal(sha256(bytes), sha256(assets[name]), name);
  }
});

test("entry names with parent segments, absolute paths or backslashes never pick a storage path", async () => {
  const label = `Traversal ${suffix}`;
  const names = {
    dotdot: "assets/../../outside/dotdot.png",
    backslash: "assets/..\\..\\outside\\backslash.png",
    dotted: "assets/./nested/../dotted.png",
    escape: "../outside/escape.png",
    absolute: path.join(outsideDir, "absolute.png"),
  };
  const bytes = Object.fromEntries(
    Object.keys(names).map((key) => [key, Buffer.from(`payload ${key}`)]),
  );
  const zip = craftZip([
    { name: "backup.json", content: backupJson(label, Object.values(names)) },
    ...Object.entries(names).map(([key, name]) => ({
      name,
      content: bytes[key],
      method: key === "dotted" ? DEFLATED : STORED,
    })),
  ]);
  const before = await tree();
  const response = await upload(crafted.id, "restore", zip);
  assert.equal(response.statusCode, 200, response.body);
  // Only entries under assets/ are imported, each under a generated name.
  assert.equal(response.json().data.images, 3);
  const newFiles = await added(before);
  assert.equal(newFiles.length, 3);
  const contents = [];
  for (const rel of newFiles) {
    assert.equal(path.dirname(rel), importsDir(crafted.id));
    assert.match(path.basename(rel), STAGED);
    contents.push((await readFile(path.join(root, rel))).toString());
  }
  assert.deepEqual(contents.sort(), ["payload backslash", "payload dotdot", "payload dotted"]);
  assert.deepEqual(await readdir(outsideDir), ["sentinel.txt"]);
  const [space] = await spaces(label);
  const restoredUrls = space.pages[0].content.map((block) => block.props.url);
  for (const key of ["dotdot", "backslash", "dotted"])
    assert.ok(restoredUrls[Object.keys(names).indexOf(key)].startsWith(`/storage/${crafted.id}/uploads/wiki/imports/`));
  // Names outside assets/ are left as inert text.
  assert.deepEqual(restoredUrls.slice(3), [names.escape, names.absolute]);
});

test("symlink entries are imported as inert bytes, never followed or created", async () => {
  const label = `Symlink ${suffix}`;
  const zip = craftZip([
    { name: "backup.json", content: backupJson(label, ["assets/link.png"]) },
    {
      name: "assets/link.png",
      content: Buffer.from("/etc/passwd"),
      externalAttr: UNIX_SYMLINK,
    },
  ]);
  const before = await tree();
  const response = await upload(crafted.id, "restore", zip);
  assert.equal(response.statusCode, 200, response.body);
  const newFiles = await added(before);
  assert.equal(newFiles.length, 1);
  const full = path.join(root, newFiles[0]);
  assert.ok((await lstat(full)).isFile());
  assert.equal((await readFile(full)).toString(), "/etc/passwd");
});

const ARCHIVE_INVALID = "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features";
const ARCHIVE_TOO_LARGE = "Invalid backup ZIP: the archive exceeds the restore limits";

/** Rejected archives get a 400 from preview and restore with no side effect. */
async function assertRejected(label, zip, message = ARCHIVE_INVALID) {
  const before = await tree();
  for (const action of ["preview", "restore"]) {
    const response = await upload(crafted.id, action, zip);
    assert.equal(response.statusCode, 400, `${label} ${action}: ${response.body}`);
    assert.equal(response.json().message, message, `${label} ${action}`);
  }
  assert.deepEqual(await added(before), [], label);
  assert.equal(
    await app.prisma.wikiSpace.count({
      where: { workspaceId: crafted.id, name: { startsWith: label } },
    }),
    0,
    label,
  );
}

test("duplicate entry names are rejected before any write", async () => {
  const label = `Duplicate ${suffix}`;
  await assertRejected(
    `${label} json`,
    craftZip([
      { name: "backup.json", content: backupJson(`${label} json first`) },
      { name: "backup.json", content: backupJson(`${label} json second`) },
    ]),
  );
  await assertRejected(
    `${label} asset`,
    craftZip([
      { name: "backup.json", content: backupJson(`${label} asset`, ["assets/dup.png"]) },
      { name: "assets/dup.png", content: Buffer.from("first") },
      { name: "assets/dup.png", content: Buffer.from("second") },
    ]),
  );
});

test("declared sizes never allocate more than the stored bytes", async () => {
  // This checksum covers the declared size of zero padding, so it only
  // matches when a reader allocates the declared size before checking it.
  const label = `Declared size ${suffix}`;
  const content = Buffer.from("hello");
  const size = 64 * MiB;
  await assertRejected(
    label,
    craftZip([
      { name: "backup.json", content: backupJson(label, ["assets/huge.png"]) },
      { name: "assets/huge.png", content, size, crc: crc32ZeroPadded(content, size) },
    ]),
  );

  // A 4 GiB declaration over honest bytes exceeds the restore budget, so it
  // is refused before anything is inflated.
  const honest = `${label} honest`;
  await assertRejected(
    honest,
    craftZip([
      { name: "backup.json", content: backupJson(honest, ["assets/deflated.png"]) },
      { name: "assets/deflated.png", content, method: DEFLATED, size: 0xfffffffe },
    ]),
    ARCHIVE_TOO_LARGE,
  );
});

test("a declared size of zero does not lift the decompression cap", async () => {
  const label = `Zero size ${suffix}`;
  const bomb = zlib.deflateRawSync(Buffer.alloc(16 * MiB));
  await assertRejected(
    label,
    craftZip([
      { name: "backup.json", content: backupJson(label, ["assets/bomb.png"]) },
      { name: "assets/bomb.png", method: DEFLATED, data: bomb, size: 0, crc: crc32(Buffer.alloc(0)) },
    ]),
  );
});

test("checksum mismatches and truncated entries are rejected", async () => {
  const label = `Integrity ${suffix}`;
  const json = (name) => ({ name: "backup.json", content: backupJson(`${label} ${name}`, ["assets/x.png"]) });
  const content = Buffer.from("asset bytes that fail their checksum");
  for (const [name, entry] of Object.entries({
    stored: { content, crc: crc32(content) ^ 1 },
    deflated: { content, method: DEFLATED, crc: crc32(content) ^ 1 },
    truncated: { content, compressedSize: content.length + 4096 },
  })) {
    await assertRejected(`${label} ${name}`, craftZip([json(name), { name: "assets/x.png", ...entry }]));
  }
  const corrupt = backupJson(`${label} json`);
  await assertRejected(
    `${label} json`,
    craftZip([{ name: "backup.json", content: corrupt, crc: crc32(corrupt) ^ 1 }]),
  );
});

test("export refuses an archive that restore would refuse", async () => {
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `Budget wiki ${suffix}`, slug: `budget-${suffix}` },
  });
  const urls = [];
  for (const size of [1000, 2000]) {
    const stored = await app.storage.save(
      `${source.id}/uploads/wiki`,
      space.id,
      crypto.randomUUID(),
      ".png",
      crypto.randomBytes(size),
    );
    urls.push(`/storage/${stored}`);
  }
  await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Budget page",
      createdById: admin.id,
      content: urls.map((url) => ({ type: "image", props: { url } })),
    },
  });
  const request = { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true };
  const exportWith = (limits) =>
    exportBackup(app.prisma, source.id, request, app.storage, admin.id, { ...BACKUP_ARCHIVE_LIMITS, ...limits });

  const { zipBuffer } = await exportWith({});
  const entries = inspectBackupArchive(zipBuffer);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const tooLarge = { statusCode: 400, message: EXPORT_TOO_LARGE_MESSAGE };

  // Exactly at the limits the export succeeds and restores under them.
  const exact = { maxTotalBytes: total, maxEntries: 4, maxEntryBytes: Math.max(...entries.map((e) => e.size)) };
  const fitting = await exportWith(exact);
  assert.equal(readBackupArchive(fitting.zipBuffer, { ...BACKUP_ARCHIVE_LIMITS, ...exact }).assets.size, 2);

  await assert.rejects(exportWith({ maxTotalBytes: total - 1 }), tooLarge);
  // backup.json, the implied assets/ folder and two files are four entries.
  await assert.rejects(exportWith({ maxEntries: 3 }), tooLarge);
  assert.ok(entries.find((e) => e.name === "backup.json").size < 1999);
  await assert.rejects(exportWith({ maxEntryBytes: 1999 }), tooLarge);
  await assert.rejects(exportWith({ maxNameBytes: entries[1].name.length - 1 }), tooLarge);
});

test("export refuses a backup.json that restore would refuse to parse", async () => {
  const { BACKUP_JSON_LIMITS, inspectBackupJson } = await import(
    "../../src/modules/backup/backup-json.ts"
  );
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `JSON budget wiki ${suffix}`, slug: `json-budget-${suffix}` },
  });
  // A list nested twenty levels deep, as the editor stores it.
  let content = [{ type: "paragraph", content: [{ type: "text", text: "deepest", styles: {} }] }];
  for (let level = 0; level < 20; level++)
    content = [{ type: "bulletListItem", content: [{ type: "text", text: `level ${level}` }], children: content }];
  await app.prisma.wikiPage.create({
    data: { spaceId: space.id, title: "JSON budget page", createdById: admin.id, content },
  });
  const request = { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true };
  const exportWith = (jsonLimits) =>
    exportBackup(app.prisma, source.id, request, app.storage, admin.id, BACKUP_ARCHIVE_LIMITS, {
      ...BACKUP_JSON_LIMITS,
      ...jsonLimits,
    });

  const stats = inspectBackupJson(readBackupArchive((await exportWith({})).zipBuffer).jsonBuffer);
  assert.ok(stats.depth > 40, `${stats.depth}`);
  const exact = {
    maxBytes: stats.bytes,
    maxTokens: stats.tokens,
    maxObjects: stats.objects,
    maxDepth: stats.depth,
  };
  // Exactly at the limits the export succeeds and its backup.json fits them;
  // one byte, token, object or level less refuses it.
  const fitting = await exportWith(exact);
  assert.deepEqual(inspectBackupJson(readBackupArchive(fitting.zipBuffer).jsonBuffer, exact), stats);
  const tooLarge = { statusCode: 400, message: EXPORT_TOO_LARGE_MESSAGE };
  for (const key of Object.keys(exact))
    await assert.rejects(exportWith({ [key]: exact[key] - 1 }), tooLarge, key);
});
