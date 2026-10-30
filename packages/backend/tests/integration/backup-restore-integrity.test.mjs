import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { craftZip } from "../fixtures/crafted-zip.mjs";

// B03: backup restore is all-or-nothing, validates every reference before it
// writes, and preview reports exactly what restore does.

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const childEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-restore-integrity-jwt-secret",
  COOKIE_SECRET: "backup-restore-integrity-cookie-secret",
};
Object.assign(process.env, childEnv);
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-restore-integrity-"));
const storageDir = path.join(root, "storage");
await mkdir(storageDir);
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { graphLimits } = await import("../../src/utils/graph-limits.ts");
const { processBlobCleanup } = await import("../../src/services/blob-cleanup.ts");
const { backupStagingDir, sweepBackupStaging } = await import("../../src/modules/backup/backup-staging.ts");

const backendDir = new URL("../..", import.meta.url);
const suffix = crypto.randomUUID().slice(0, 8);
const CREATED = "2026-01-02T03:04:05.000Z";
let app, admin, member, outsider, token;
const workspaces = [];
let requests = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  [admin, member, outsider] = await Promise.all(
    ["admin", "member", "outsider"].map((name) =>
      app.prisma.user.create({
        data: {
          email: `restore-${name}-${suffix}@example.test`,
          displayName: `Restore ${name}`,
          emailVerified: true,
        },
      }),
    ),
  );
  token = signAccessToken({ sub: admin.id, email: admin.email });
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await app.prisma.user.deleteMany({
        where: { id: { in: [admin, member, outsider].filter(Boolean).map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** A workspace where `admin` is an ADMIN and `member` a MEMBER. */
async function workspace(label) {
  const ws = await app.prisma.workspace.create({
    data: {
      name: `Restore ${label}`,
      slug: `restore-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`,
      members: {
        create: [
          { userId: admin.id, role: "ADMIN" },
          { userId: member.id, role: "MEMBER" },
        ],
      },
    },
  });
  workspaces.push(ws.id);
  return ws;
}

const ref = (user) => `src-${user.id}`;

function backup({ projects = [], channels = [], wikiSpaces = [], userRefs, version = "1.1" } = {}) {
  return {
    metadata: {
      version,
      exportedAt: CREATED,
      sourceWorkspace: { name: "Source", slug: "source" },
      userRefs:
        userRefs ??
        [admin, member, outsider].map((u) => ({
          originalId: ref(u),
          email: u.email,
          displayName: u.displayName,
        })),
    },
    projects,
    channels,
    wikiSpaces,
  };
}

const project = (name, parts = {}) => ({
  project: { name },
  statuses: [{ _originalId: "open", name: "Open", position: 0, isCompletion: false }],
  ...parts,
});
const task = (id, parts = {}) => ({
  _originalId: id,
  title: `Task ${id}`,
  priority: "NONE",
  position: 0,
  statusRef: "open",
  ...parts,
});
const page = (id, parts = {}) => ({ _originalId: id, title: `Page ${id}`, position: 0, ...parts });

/** Upload as backup.json, or as a ZIP when `assets` (name → bytes) is given. */
function upload(workspaceId, action, file, assets) {
  const json = Buffer.isBuffer(file) ? file : Buffer.from(JSON.stringify(file));
  const content = assets
    ? craftZip([
        { name: "backup.json", content: json },
        ...Object.entries(assets).map(([name, bytes]) => ({ name, content: bytes })),
      ])
    : json;
  const filename = assets ? "backup.zip" : "backup.json";
  const boundary = `restore-${crypto.randomUUID()}`;
  return app.inject({
    method: "POST",
    url: `/api/workspaces/${workspaceId}/backup/${action}`,
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    remoteAddress: `127.0.5.${1 + (++requests % 200)}`,
  });
}

/** Restore-written rows of one workspace, per table. */
const ROW_QUERIES = {
  projects: `SELECT count(*) FROM "Project" WHERE "workspaceId" = $1`,
  statuses: `SELECT count(*) FROM "StatusColumn" x JOIN "Project" p ON p.id = x."projectId" WHERE p."workspaceId" = $1`,
  labels: `SELECT count(*) FROM "Label" x JOIN "Project" p ON p.id = x."projectId" WHERE p."workspaceId" = $1`,
  customFields: `SELECT count(*) FROM "CustomField" x JOIN "Project" p ON p.id = x."projectId" WHERE p."workspaceId" = $1`,
  projectMembers: `SELECT count(*) FROM "ProjectMember" x JOIN "Project" p ON p.id = x."projectId" WHERE p."workspaceId" = $1`,
  tasks: `SELECT count(*) FROM "Task" x JOIN "Project" p ON p.id = x."projectId" WHERE p."workspaceId" = $1`,
  taskAssignees: `SELECT count(*) FROM "TaskAssignee" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  taskLabels: `SELECT count(*) FROM "TaskLabel" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  subtasks: `SELECT count(*) FROM "Subtask" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  customFieldValues: `SELECT count(*) FROM "CustomFieldValue" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  comments: `SELECT count(*) FROM "Comment" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  activityLogs: `SELECT count(*) FROM "ActivityLog" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  dependencies: `SELECT count(*) FROM "TaskDependency" x JOIN "Task" t ON t.id = x."blockedTaskId" JOIN "Project" p ON p.id = t."projectId" WHERE p."workspaceId" = $1`,
  channels: `SELECT count(*) FROM "ChatChannel" WHERE "workspaceId" = $1`,
  channelMembers: `SELECT count(*) FROM "ChatChannelMember" x JOIN "ChatChannel" c ON c.id = x."channelId" WHERE c."workspaceId" = $1`,
  messages: `SELECT count(*) FROM "ChatMessage" x JOIN "ChatChannel" c ON c.id = x."channelId" WHERE c."workspaceId" = $1`,
  reactions: `SELECT count(*) FROM "ChatReaction" x JOIN "ChatMessage" m ON m.id = x."messageId" JOIN "ChatChannel" c ON c.id = m."channelId" WHERE c."workspaceId" = $1`,
  wikiSpaces: `SELECT count(*) FROM "WikiSpace" WHERE "workspaceId" = $1`,
  wikiPages: `SELECT count(*) FROM "WikiPage" x JOIN "WikiSpace" s ON s.id = x."spaceId" WHERE s."workspaceId" = $1`,
  wikiComments: `SELECT count(*) FROM "WikiPageComment" x JOIN "WikiPage" w ON w.id = x."pageId" JOIN "WikiSpace" s ON s.id = w."spaceId" WHERE s."workspaceId" = $1`,
};

async function rows(workspaceId) {
  const counts = {};
  for (const [key, query] of Object.entries(ROW_QUERIES)) {
    const [result] = await app.prisma.$queryRawUnsafe(`SELECT (${query})::int AS n`, workspaceId);
    counts[key] = result.n;
  }
  return counts;
}

/** Summary counts in the shape of `rows`. */
const SUMMARY_KEYS = {
  projects: "projects",
  statuses: "statuses",
  labels: "labels",
  customFields: "customFields",
  tasks: "tasks",
  subtasks: "subtasks",
  comments: "comments",
  activityLogs: "activityLogs",
  channels: "channels",
  messages: "messages",
  reactions: "reactions",
  wikiSpaces: "wikiSpaces",
  wikiPages: "wikiPages",
  wikiComments: "wikiComments",
};
function assertRowsMatchSummary(before, now, summary, label) {
  for (const [key, field] of Object.entries(SUMMARY_KEYS))
    assert.equal(now[key] - before[key], summary[field], `${label}: ${key}`);
}

/** Every file under the storage root. */
async function files(dir = storageDir, out = []) {
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await lstat(full)).isDirectory()) await files(full, out);
    else out.push(path.relative(storageDir, full));
  }
  return out.sort();
}

const queued = (workspaceId) =>
  app.prisma.$queryRaw`
    SELECT "storagePath", "attempts", "availableAt" > CURRENT_TIMESTAMP + interval '50 minutes' AS "later"
    FROM "BlobCleanup" WHERE "storagePath" LIKE ${`${workspaceId}/%`} ORDER BY "storagePath"`;

/** Preview and restore both refuse `file` with `message`, and nothing is written. */
async function assertRefused(workspaceId, file, message, assets) {
  const beforeRows = await rows(workspaceId);
  const beforeFiles = await files();
  for (const action of ["preview", "restore"]) {
    const response = await upload(workspaceId, action, file, assets);
    assert.equal(response.statusCode, 400, `${message} ${action}: ${response.body}`);
    assert.equal(response.json().message, message, action);
  }
  assert.deepEqual(await rows(workspaceId), beforeRows, message);
  assert.deepEqual(await files(), beforeFiles, message);
  assert.deepEqual(await queued(workspaceId), [], message);
}

/** Preview, then restore; both must answer the same summary. */
async function previewAndRestore(workspaceId, file, assets) {
  const preview = await upload(workspaceId, "preview", file, assets);
  assert.equal(preview.statusCode, 200, preview.body);
  const before = await rows(workspaceId);
  const restored = await upload(workspaceId, "restore", file, assets);
  assert.equal(restored.statusCode, 200, restored.body);
  const summary = restored.json().data;
  assert.deepEqual(summary, preview.json().data, "preview and restore summaries differ");
  assertRowsMatchSummary(before, await rows(workspaceId), summary, "rows written");
  return summary;
}

// ─── All-or-nothing ─────────────────────────────────────

/** Projects, a channel and a wiki with a page that uses two archive files. */
function wideBackup(tag, extraPages = []) {
  return backup({
    projects: [
      project(`Wide ${tag}`, {
        labels: [{ _originalId: "l", name: "Bug", color: "#ff0000" }],
        tasks: [
          task("a", {
            labels: ["l"],
            subtasks: [{ _originalId: "s", title: "Step", completed: false, position: 0 }],
            comments: [{ _originalId: "c", body: "Comment", authorRef: ref(admin), createdAt: CREATED }],
          }),
          task("b", { position: 1, dependencies: [{ blockingTaskRef: "a" }] }),
        ],
      }),
    ],
    channels: [
      {
        channel: { name: `wide-${tag}`, type: "PUBLIC" },
        messages: [{ _originalId: "m", content: "Hello", userRef: ref(admin), createdAt: CREATED }],
      },
    ],
    wikiSpaces: [
      {
        space: { name: `Wide ${tag}` },
        pages: [
          page("p", {
            content: [
              { type: "image", props: { url: "assets/one.png" } },
              { type: "image", props: { url: "assets/two.png" } },
            ],
          }),
          ...extraPages,
        ],
      },
    ],
  });
}
const WIDE_ASSETS = { "assets/one.png": Buffer.from("one"), "assets/two.png": Buffer.from("two") };

test("a file that cannot be stored fails the whole restore and leaves nothing behind", async () => {
  const ws = await workspace("asset failure");
  const beforeRows = await rows(ws.id);
  const beforeFiles = await files();
  const saveStream = app.storage.saveStream;
  let calls = 0;
  app.storage.saveStream = async (...args) => {
    if (++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return saveStream.apply(app.storage, args);
  };
  let response;
  try {
    response = await upload(ws.id, "restore", wideBackup("asset"), WIDE_ASSETS);
  } finally {
    app.storage.saveStream = saveStream;
  }
  assert.equal(calls, 2);
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(await rows(ws.id), beforeRows);
  assert.deepEqual(await files(), beforeFiles);
  assert.deepEqual(await queued(ws.id), []);
});

test("a database failure late in the restore rolls back every row and removes the written files", async () => {
  const ws = await workspace("late failure");
  const marker = `fail-restore-${suffix}`;
  await app.prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION restore_integrity_fail() RETURNS trigger AS $$
    BEGIN
      IF NEW.body = '${marker}' THEN RAISE EXCEPTION 'injected restore failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await app.prisma.$executeRawUnsafe(`
    CREATE TRIGGER restore_integrity_fail BEFORE INSERT ON "WikiPageComment"
    FOR EACH ROW EXECUTE FUNCTION restore_integrity_fail()`);
  const failing = wideBackup("late", [
    page("q", {
      position: 1,
      comments: [{ _originalId: "wc", body: marker, highlightId: "h", createdAt: CREATED }],
    }),
  ]);
  try {
    const beforeRows = await rows(ws.id);
    const beforeFiles = await files();
    const response = await upload(ws.id, "restore", failing, WIDE_ASSETS);
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(await rows(ws.id), beforeRows);
    assert.deepEqual(await files(), beforeFiles);
    assert.deepEqual(await queued(ws.id), []);

    // When removing the files fails too, they stay queued and the cleanup
    // worker removes them later.
    const remove = app.storage.delete;
    app.storage.delete = async () => {
      throw new Error("storage offline");
    };
    try {
      const again = await upload(ws.id, "restore", failing, WIDE_ASSETS);
      assert.equal(again.statusCode, 500, again.body);
    } finally {
      app.storage.delete = remove;
    }
    assert.deepEqual(await rows(ws.id), beforeRows);
    const left = (await files()).filter((f) => !beforeFiles.includes(f));
    assert.equal(left.length, 2);
    const rowsLeft = await queued(ws.id);
    assert.deepEqual(rowsLeft.map((r) => r.storagePath), left);
    await app.prisma.$executeRaw`
      UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP
      WHERE "storagePath" = ANY(${left}::text[])`;
    const result = await processBlobCleanup(app.prisma, app.storage, { paths: left });
    assert.equal(result.deleted, 2);
    assert.deepEqual(await files(), beforeFiles);
    assert.deepEqual(await queued(ws.id), []);
  } finally {
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS restore_integrity_fail ON "WikiPageComment"`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS restore_integrity_fail()`);
  }

  // The same backup without the failing comment restores completely.
  const summary = await previewAndRestore(ws.id, wideBackup("late"), WIDE_ASSETS);
  assert.equal(summary.images, 2);
  assert.deepEqual(await queued(ws.id), []);
});

test("a crash after the files were written leaves them queued for removal", async () => {
  const ws = await workspace("crash");
  const casesDir = await mkdtemp(path.join(root, "crash-"));
  const file = path.join(casesDir, "backup.zip");
  await writeFile(
    file,
    craftZip([
      { name: "backup.json", content: Buffer.from(JSON.stringify(wideBackup("crash"))) },
      ...Object.entries(WIDE_ASSETS).map(([name, content]) => ({ name, content })),
    ]),
  );
  const manifest = path.join(casesDir, "manifest.json");
  await writeFile(manifest, JSON.stringify({ workspaceId: ws.id, token, file }));
  const beforeFiles = await files();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "tests/integration/support/restore-crash-child.mjs", manifest],
    {
      cwd: backendDir,
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), ...childEnv, STORAGE_DIR: storageDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [code] = await new Promise((resolve) => child.on("close", (...result) => resolve(result)));
  assert.equal(code, 7, output.slice(-500));

  // The crashed upload stays staged until the next start sweeps it.
  const staging = path.relative(storageDir, backupStagingDir(storageDir));
  const left = (await files()).filter((f) => !beforeFiles.includes(f));
  const written = left.filter((f) => !f.startsWith(`${staging}${path.sep}`));
  assert.equal(left.length - written.length, 1);
  assert.equal(await sweepBackupStaging(undefined, backupStagingDir(storageDir)), 1);
  assert.equal(written.length, 2);
  for (const f of written) assert.equal(path.dirname(f), path.join(ws.id, "uploads", "wiki", "imports"));
  assert.deepEqual(await queued(ws.id), written.map((storagePath) => ({ storagePath, attempts: 0, later: true })));
  assert.equal((await rows(ws.id)).wikiPages, 0);

  // Once the grace period is over, the cleanup worker removes them.
  await app.prisma.$executeRaw`
    UPDATE "BlobCleanup" SET "availableAt" = CURRENT_TIMESTAMP
    WHERE "storagePath" = ANY(${written}::text[])`;
  await processBlobCleanup(app.prisma, app.storage, { paths: written });
  assert.deepEqual(await files(), beforeFiles);
  assert.deepEqual(await queued(ws.id), []);
});

test("archive files that no page uses are not written", async () => {
  const ws = await workspace("unused files");
  const beforeFiles = await files();
  const summary = await previewAndRestore(ws.id, wideBackup("unused"), {
    ...WIDE_ASSETS,
    "assets/unused.png": Buffer.from("unused"),
    "assets/also-unused.txt": Buffer.from("unused too"),
  });
  assert.equal(summary.images, 2);
  assert.ok(
    summary.warnings.includes("2 file(s) in the archive are not used by any wiki page and were not restored"),
    summary.warnings.join("\n"),
  );
  assert.equal((await files()).filter((f) => !beforeFiles.includes(f)).length, 2);
});

test("a page keeps the file it names when another archive path is a prefix of it", async () => {
  for (const [index, names] of [
    ["assets/pic", "assets/pic.png"],
    ["assets/pic.png", "assets/pic"],
  ].entries()) {
    const ws = await workspace(`overlap ${index}`);
    const file = backup({
      wikiSpaces: [
        { space: { name: `Overlap ${index}` }, pages: [page("p", { content: [{ type: "image", props: { url: "assets/pic.png" } }] })] },
      ],
    });
    const assets = Object.fromEntries(names.map((name) => [name, Buffer.from(`bytes of ${name}`)]));
    const summary = await previewAndRestore(ws.id, file, assets);
    assert.equal(summary.images, 1);
    assert.ok(summary.warnings.includes("1 file(s) in the archive are not used by any wiki page and were not restored"));
    const [restored] = await app.prisma.wikiPage.findMany({
      where: { space: { workspaceId: ws.id } },
      select: { content: true },
    });
    const url = restored.content[0].props.url;
    assert.match(url, new RegExp(`^/storage/${ws.id}/uploads/wiki/imports/[0-9a-f-]{36}\\.png$`));
    assert.equal((await app.storage.read(url.slice("/storage/".length))).toString(), "bytes of assets/pic.png");
  }
});

// ─── References ─────────────────────────────────────────

/** Two projects and two channels whose rows point at each other. */
function crossBackup(tag) {
  return backup({
    projects: [
      {
        project: { name: `Alpha ${tag}`, color: "#111111" },
        statuses: [
          { _originalId: "sA-open", name: "Open", position: 0, isCompletion: false },
          { _originalId: "sA-done", name: "Done", position: 1, isCompletion: true },
        ],
        labels: [{ _originalId: "lA", name: "Bug", color: "#ff0000" }],
        customFields: [
          { _originalId: "fA", name: "Notes", type: "TEXT", options: null, required: false, position: 0 },
        ],
        members: [{ userRef: ref(member) }],
        tasks: [
          task("tA-1", {
            title: "Alpha one",
            priority: "HIGH",
            statusRef: "sA-open",
            assignees: [ref(member)],
            labels: ["lA"],
            customFieldValues: [{ fieldRef: "fA", value: "alpha" }],
            subtasks: [{ _originalId: "stA", title: "Step", completed: false, position: 0, assigneeRef: ref(member) }],
            comments: [{ _originalId: "cA", body: "Hello", authorRef: ref(member), createdAt: CREATED }],
            activityLogs: [
              { _originalId: "aA", action: "created", details: { from: null }, actorRef: ref(admin), createdAt: CREATED },
            ],
          }),
          task("tA-2", {
            title: "Alpha two",
            position: 1,
            statusRef: "sA-done",
            dependencies: [{ blockingTaskRef: "tA-1" }],
          }),
        ],
      },
      {
        project: { name: `Beta ${tag}` },
        statuses: [{ _originalId: "sB", name: "Todo", position: 0, isCompletion: false }],
        labels: [{ _originalId: "lB", name: "UI", color: "#00ff00" }],
        customFields: [
          { _originalId: "fB", name: "Size", type: "SELECT", options: [{ value: "S" }, { value: "M" }], required: false, position: 0 },
        ],
        tasks: [
          task("tB-1", {
            title: "Beta one",
            statusRef: "sA-open",
            assignees: [ref(member), ref(admin), ref(admin), ref(outsider)],
            labels: ["lA", "lB", "lB"],
            dependencies: [{ blockingTaskRef: "tA-1" }, { blockingTaskRef: "tB-2" }, { blockingTaskRef: "tB-2" }],
            customFieldValues: [
              { fieldRef: "fA", value: "foreign" },
              { fieldRef: "fB", value: "M" },
            ],
            subtasks: [{ _originalId: "stB", title: "Sub", completed: true, position: 0, assigneeRef: ref(member) }],
          }),
          task("tB-2", { title: "Beta two", priority: "URGENT", position: 1, statusRef: "gone" }),
        ],
      },
    ],
    channels: [
      {
        channel: { name: `general-${tag}`, type: "PUBLIC" },
        members: [{ userRef: ref(member) }, { userRef: ref(member) }],
        messages: [
          {
            _originalId: "m1",
            content: "Hi",
            userRef: ref(member),
            createdAt: CREATED,
            reactions: [
              { userRef: ref(admin), emoji: "👍" },
              { userRef: ref(admin), emoji: "👍" },
              { userRef: ref(outsider), emoji: "🎉" },
            ],
          },
        ],
      },
      {
        channel: { name: `random-${tag}`, type: "PRIVATE" },
        messages: [
          { _originalId: "m2", content: "Reply elsewhere", userRef: ref(outsider), parentRef: "m1", createdAt: CREATED },
          { _originalId: "m3", content: "Thread reply", userRef: ref(admin), parentRef: "m2", createdAt: CREATED },
          { _originalId: "m4", content: "Reply to a later message", userRef: ref(admin), parentRef: "m5", createdAt: CREATED },
          { _originalId: "m5", content: "Later", userRef: ref(admin), createdAt: CREATED },
        ],
      },
    ],
    wikiSpaces: [
      {
        space: { name: `Handbook ${tag}` },
        pages: [
          page("p1", {
            title: "Root",
            content: [{ type: "image", props: { url: "assets/pic.png" } }],
            comments: [
              { _originalId: "wc1", body: "Nice", authorRef: ref(member), highlightId: "h1", selectionStart: null, createdAt: CREATED },
            ],
          }),
          page("p2", { title: "Child", parentRef: "p1", content: [{ type: "paragraph", content: [] }] }),
          page("p3", { title: "Orphan", parentRef: "gone-page" }),
        ],
      },
    ],
  });
}

test("references outside their project, channel or space are dropped with warnings that preview reports too", async () => {
  const ws = await workspace("cross");
  const tag = `x${suffix}`;
  const summary = await previewAndRestore(ws.id, crossBackup(tag), {
    "assets/pic.png": Buffer.from("png"),
    "assets/unused.png": Buffer.from("unused"),
  });
  const { warnings, userMappings, ...counts } = summary;
  assert.deepEqual(counts, {
    projects: 2,
    statuses: 3,
    labels: 2,
    customFields: 2,
    tasks: 4,
    subtasks: 2,
    comments: 1,
    activityLogs: 1,
    channels: 2,
    messages: 5,
    reactions: 1,
    wikiSpaces: 1,
    wikiPages: 3,
    wikiComments: 1,
    images: 1,
  });
  assert.equal(userMappings.length, 3);
  assert.deepEqual(warnings, [
    `User "${outsider.displayName}" (${outsider.email}) not found in workspace — references will use fallback or be skipped`,
    `Project "Beta ${tag}": skipped 1 custom field value(s) that refer to a field of another project`,
    `Project "Beta ${tag}": 2 task(s) refer to a status column that is not in the project and were placed in the first column`,
    `Project "Beta ${tag}": skipped 1 assignment(s) of users who would have no access to the project (the backup lists no members for this project)`,
    `Project "Beta ${tag}": skipped 1 task label(s) that are not labels of the project`,
    `Project "Beta ${tag}": cleared 1 subtask assignee(s) who would have no access to the project (the backup lists no members for this project)`,
    `Project "Beta ${tag}": skipped 1 dependenc(ies) on tasks that are not in the project`,
    `Channel "random-${tag}": restored 2 repl(ies) without their thread because the parent message is not an earlier message of the channel`,
    `Skipped parent link for wiki page "Orphan" — parent ref gone-page not found`,
    `Wiki space "Handbook ${tag}": renumbered the pages of 1 parent(s) with repeated or invalid positions`,
    "1 file(s) in the archive are not used by any wiki page and were not restored",
  ]);

  // Nothing restored points across a project, channel or space boundary.
  const [crossing] = await app.prisma.$queryRaw`
    SELECT
      (SELECT count(*) FROM "Task" t JOIN "Project" p ON p.id = t."projectId" JOIN "StatusColumn" s ON s.id = t."statusId"
        WHERE p."workspaceId" = ${ws.id} AND s."projectId" <> t."projectId")::int AS "statuses",
      (SELECT count(*) FROM "TaskLabel" x JOIN "Task" t ON t.id = x."taskId" JOIN "Label" l ON l.id = x."labelId" JOIN "Project" p ON p.id = t."projectId"
        WHERE p."workspaceId" = ${ws.id} AND l."projectId" <> t."projectId")::int AS "labels",
      (SELECT count(*) FROM "TaskDependency" d JOIN "Task" a ON a.id = d."blockedTaskId" JOIN "Task" b ON b.id = d."blockingTaskId" JOIN "Project" p ON p.id = a."projectId"
        WHERE p."workspaceId" = ${ws.id} AND a."projectId" <> b."projectId")::int AS "dependencies",
      (SELECT count(*) FROM "CustomFieldValue" v JOIN "Task" t ON t.id = v."taskId" JOIN "CustomField" f ON f.id = v."fieldId" JOIN "Project" p ON p.id = t."projectId"
        WHERE p."workspaceId" = ${ws.id} AND f."projectId" <> t."projectId")::int AS "values",
      (SELECT count(*) FROM "TaskAssignee" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId"
        WHERE p."workspaceId" = ${ws.id}
          AND NOT EXISTS (SELECT 1 FROM "WorkspaceMember" w WHERE w."workspaceId" = p."workspaceId" AND w."userId" = x."userId" AND w.role = 'ADMIN')
          AND NOT EXISTS (SELECT 1 FROM "ProjectMember" m WHERE m."projectId" = p.id AND m."userId" = x."userId"))::int AS "assignees",
      (SELECT count(*) FROM "Subtask" x JOIN "Task" t ON t.id = x."taskId" JOIN "Project" p ON p.id = t."projectId"
        WHERE p."workspaceId" = ${ws.id} AND x."assigneeId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "WorkspaceMember" w WHERE w."workspaceId" = p."workspaceId" AND w."userId" = x."assigneeId" AND w.role = 'ADMIN')
          AND NOT EXISTS (SELECT 1 FROM "ProjectMember" m WHERE m."projectId" = p.id AND m."userId" = x."assigneeId"))::int AS "subtaskAssignees",
      (SELECT count(*) FROM "ChatMessage" m JOIN "ChatMessage" parent ON parent.id = m."parentId" JOIN "ChatChannel" c ON c.id = m."channelId"
        WHERE c."workspaceId" = ${ws.id} AND parent."channelId" <> m."channelId")::int AS "replies",
      (SELECT count(*) FROM "WikiPage" w JOIN "WikiPage" parent ON parent.id = w."parentId" JOIN "WikiSpace" s ON s.id = w."spaceId"
        WHERE s."workspaceId" = ${ws.id} AND parent."spaceId" <> w."spaceId")::int AS "pages"`;
  assert.deepEqual(crossing, {
    statuses: 0,
    labels: 0,
    dependencies: 0,
    values: 0,
    assignees: 0,
    subtaskAssignees: 0,
    replies: 0,
    pages: 0,
  });

  const beta = await app.prisma.task.findMany({
    where: { project: { workspaceId: ws.id, name: `Beta ${tag}` } },
    orderBy: { position: "asc" },
    select: {
      title: true,
      position: true,
      priority: true,
      status: { select: { name: true } },
      labels: { select: { label: { select: { name: true } } } },
      blockedBy: { select: { blockingTask: { select: { title: true } } } },
      customFieldValues: { select: { value: true, field: { select: { name: true } } } },
      assignees: { select: { userId: true } },
      subtasks: { select: { title: true, assigneeId: true } },
    },
  });
  assert.deepEqual(beta, [
    {
      title: "Beta one",
      position: 0,
      priority: "NONE",
      status: { name: "Todo" },
      labels: [{ label: { name: "UI" } }],
      blockedBy: [{ blockingTask: { title: "Beta two" } }],
      customFieldValues: [{ value: "M", field: { name: "Size" } }],
      assignees: [{ userId: admin.id }],
      subtasks: [{ title: "Sub", assigneeId: null }],
    },
    {
      title: "Beta two",
      position: 1,
      priority: "URGENT",
      status: { name: "Todo" },
      labels: [],
      blockedBy: [],
      customFieldValues: [],
      assignees: [],
      subtasks: [],
    },
  ]);
  const alpha = await app.prisma.task.findFirst({
    where: { project: { workspaceId: ws.id, name: `Alpha ${tag}` }, title: "Alpha one" },
    select: {
      assignees: { select: { userId: true } },
      subtasks: { select: { assigneeId: true } },
      comments: { select: { authorId: true, createdAt: true } },
    },
  });
  assert.deepEqual(alpha, {
    assignees: [{ userId: member.id }],
    subtasks: [{ assigneeId: member.id }],
    comments: [{ authorId: member.id, createdAt: new Date(CREATED) }],
  });

  const messages = await app.prisma.chatMessage.findMany({
    where: { channel: { workspaceId: ws.id } },
    orderBy: { content: "asc" },
    select: { content: true, userId: true, parent: { select: { content: true } } },
  });
  assert.deepEqual(messages, [
    { content: "Hi", userId: member.id, parent: null },
    { content: "Later", userId: admin.id, parent: null },
    { content: "Reply elsewhere", userId: admin.id, parent: null },
    { content: "Reply to a later message", userId: admin.id, parent: null },
    { content: "Thread reply", userId: admin.id, parent: { content: "Reply elsewhere" } },
  ]);
  const channelMembers = await app.prisma.chatChannelMember.findMany({
    where: { channel: { workspaceId: ws.id } },
    select: { userId: true, channel: { select: { name: true } } },
  });
  assert.deepEqual(
    channelMembers.map((m) => `${m.channel.name}:${m.userId === admin.id ? "admin" : "member"}`).sort(),
    [`general-${tag}:admin`, `general-${tag}:member`, `random-${tag}:admin`],
  );
  const pages = await app.prisma.wikiPage.findMany({
    where: { space: { workspaceId: ws.id } },
    orderBy: { title: "asc" },
    select: { title: true, position: true, parent: { select: { title: true } } },
  });
  assert.deepEqual(pages, [
    { title: "Child", position: 0, parent: { title: "Root" } },
    { title: "Orphan", position: 1, parent: null },
    { title: "Root", position: 0, parent: null },
  ]);
});

test("backups that restore could only write in part are refused by preview and restore before any write", async () => {
  const ws = await workspace("refusals");
  const withTasks = (tasks, parts) => backup({ projects: [project("Refused", { tasks, ...parts })] });
  const cases = [
    ["Invalid backup file: task ids in project 1 are not unique", withTasks([task("t"), task("t", { position: 1 })])],
    [
      "Invalid backup file: status ids in project 1 are not unique",
      withTasks([], {
        statuses: [
          { _originalId: "s", name: "A", position: 0, isCompletion: false },
          { _originalId: "s", name: "B", position: 1, isCompletion: false },
        ],
      }),
    ],
    [
      "Invalid backup file: label ids in project 1 are not unique",
      withTasks([], {
        labels: [
          { _originalId: "l", name: "A", color: "#000000" },
          { _originalId: "l", name: "B", color: "#000000" },
        ],
      }),
    ],
    [
      "Invalid backup file: custom field ids in project 1 are not unique",
      withTasks([], {
        customFields: [
          { _originalId: "f", name: "A", type: "TEXT", required: false, position: 0 },
          { _originalId: "f", name: "B", type: "TEXT", required: false, position: 1 },
        ],
      }),
    ],
    [
      "Invalid backup file: subtask ids in project 1 are not unique",
      withTasks([
        task("t", { subtasks: [{ _originalId: "s", title: "A", completed: false, position: 0 }] }),
        task("u", { subtasks: [{ _originalId: "s", title: "B", completed: false, position: 0 }] }),
      ]),
    ],
    [
      "Invalid backup file: user reference ids are not unique",
      backup({
        userRefs: [
          { originalId: "u", email: admin.email, displayName: "A" },
          { originalId: "u", email: member.email, displayName: "B" },
        ],
      }),
    ],
    [
      "Invalid backup file: message ids in channel 1 are not unique",
      backup({
        channels: [
          {
            channel: { name: "dup", type: "PUBLIC" },
            messages: [
              { _originalId: "m", content: "a", userRef: ref(admin), createdAt: CREATED },
              { _originalId: "m", content: "b", userRef: ref(admin), createdAt: CREATED },
            ],
          },
        ],
      }),
    ],
    [
      "Invalid backup file: wiki comment ids in wiki space 1 are not unique",
      backup({
        wikiSpaces: [
          {
            space: { name: "Dup comments" },
            pages: [
              page("p", {
                comments: [
                  { _originalId: "c", body: "a", highlightId: "h", createdAt: CREATED },
                  { _originalId: "c", body: "b", highlightId: "h", createdAt: CREATED },
                ],
              }),
            ],
          },
        ],
      }),
    ],
    [
      "Invalid backup file: task dependencies in project 1 form a cycle",
      withTasks([
        task("a", { dependencies: [{ blockingTaskRef: "b" }] }),
        task("b", { position: 1, dependencies: [{ blockingTaskRef: "a" }] }),
      ]),
    ],
    [
      "Invalid backup file: task dependencies in project 1 form a cycle",
      withTasks([
        task("a", { dependencies: [{ blockingTaskRef: "c" }] }),
        task("b", { position: 1, dependencies: [{ blockingTaskRef: "a" }] }),
        task("c", { position: 2, dependencies: [{ blockingTaskRef: "b" }, { blockingTaskRef: "elsewhere" }] }),
      ]),
    ],
    [
      "Invalid backup file: task dependencies in project 1 form a cycle",
      withTasks([task("a", { dependencies: [{ blockingTaskRef: "a" }] })]),
    ],
    [
      "Invalid backup file: a task title in project 1 contains a character that cannot be stored",
      withTasks([task("t", { title: "nul\u0000byte" })]),
    ],
    [
      "Invalid backup file: a label name in project 1 is longer than 100 characters",
      withTasks([], { labels: [{ _originalId: "l", name: "é".repeat(101), color: "#000000" }] }),
    ],
    [
      "Invalid backup file: the name of project 1 is longer than 255 characters",
      backup({ projects: [project("p".repeat(256))] }),
    ],
    [
      "Invalid backup file: a task priority in project 1 is not valid",
      withTasks([task("t", { priority: "CRITICAL" })]),
    ],
    [
      "Invalid backup file: a comment date in project 1 is not a valid date",
      withTasks([task("t", { comments: [{ _originalId: "c", body: "x", createdAt: "yesterday" }] })]),
    ],
    [
      "Invalid backup file: a message date in channel 1 is not a valid date",
      backup({
        channels: [
          {
            channel: { name: "dates", type: "PUBLIC" },
            messages: [{ _originalId: "m", content: "a", userRef: ref(admin), createdAt: "+275760-09-13T00:00:00.000Z" }],
          },
        ],
      }),
    ],
    [
      "Invalid backup file: the content of a page in wiki space 1 contains a character that cannot be stored",
      backup({ wikiSpaces: [{ space: { name: "Surrogate" }, pages: [page("p", { content: [{ text: "half \ud800 pair" }] })] }] }),
    ],
    [
      "Invalid backup file: an activity entry in project 1 contains a character that cannot be stored",
      withTasks([
        task("t", {
          activityLogs: [{ _originalId: "a", action: "x", details: { "key\u0000": 1 }, createdAt: CREATED }],
        }),
      ]),
    ],
  ];
  for (const [message, file] of cases) await assertRefused(ws.id, file, message);
});

/** Content nested `levels` objects and arrays deep. */
function nested(levels) {
  let value = "deepest";
  for (let i = 0; i < levels; i++) value = i % 2 ? { children: value } : [value];
  return value;
}

test("wiki content and page trees deeper than restore can store are refused with a 400", async () => {
  const ws = await workspace("depth");
  const space = (pages) => backup({ wikiSpaces: [{ space: { name: `Depth ${suffix}` }, pages }] });
  // The backup.json limits let page content nest at most 123 levels: the
  // deepest a single-row insert stores. A batched insert holds 122.
  for (const levels of [122, 123]) {
    const accepted = await previewAndRestore(ws.id, space([page(`p${levels}`, { content: nested(levels) })]));
    assert.equal(accepted.wikiPages, 1);
    const stored = await app.prisma.wikiPage.findFirst({
      where: { space: { workspaceId: ws.id }, title: `Page p${levels}` },
      select: { content: true },
    });
    assert.deepEqual(stored.content, nested(levels));
  }
  await assertRefused(
    ws.id,
    space([page("p", { content: nested(124) })]),
    "Invalid backup file: the backup data exceeds the restore limits",
  );
  const chain = (length) =>
    Array.from({ length }, (_, i) => page(`c${i}`, { parentRef: i ? `c${i - 1}` : null }));
  const saved = graphLimits.maxDepth;
  graphLimits.maxDepth = 4;
  try {
    await assertRefused(
      ws.id,
      space(chain(5)),
      "Invalid backup file: wiki pages in wiki space 1 are nested more than 4 levels deep",
    );
    const fits = await previewAndRestore(ws.id, space(chain(4)));
    assert.equal(fits.wikiPages, 4);
  } finally {
    graphLimits.maxDepth = saved;
  }

  // Restore applies the same limit itself, whatever the file limits are.
  const { validateBackup: validate } = await import("../../src/modules/backup/restore-validation.ts");
  const { BackupFileSchema } = await import("@pm/shared");
  const validateBackup = (file) => validate(BackupFileSchema.parse(file));
  assert.throws(
    () => validateBackup(space([page("p", { content: nested(124) })])),
    { statusCode: 400, message: "Invalid backup file: the content of a page in wiki space 1 is nested more than 123 levels deep" },
  );
  assert.throws(
    () =>
      validateBackup(
        backup({
          projects: [
            project("Deep activity", {
              tasks: [task("t", { activityLogs: [{ _originalId: "a", action: "x", details: nested(124), createdAt: CREATED }] })],
            }),
          ],
        }),
      ),
    { statusCode: 400, message: "Invalid backup file: an activity entry in project 1 is nested more than 123 levels deep" },
  );
  validateBackup(space([page("p", { content: nested(123) })]));
});

test("repeated names, positions and references are restored once, as documented", async () => {
  const ws = await workspace("repairs");
  const file = backup({
    projects: [
      project(`Repairs ${suffix}`, {
        statuses: [
          { _originalId: "s1", name: "First", position: 1, isCompletion: true },
          { _originalId: "s2", name: "Second", position: 1, isCompletion: true },
          { _originalId: "s3", name: "Third", position: 2.5, isCompletion: false },
        ],
        labels: [
          { _originalId: "l1", name: "Bug", color: "#000001" },
          { _originalId: "l2", name: "Bug", color: "#000002" },
          { _originalId: "l3", name: "Bug (2)", color: "#000003" },
        ],
        customFields: [
          { _originalId: "f1", name: "Size", type: "TEXT", required: false, position: 0 },
          { _originalId: "f2", name: "Size", type: "NUMBER", required: false, position: 0 },
        ],
        members: [{ userRef: ref(member) }, { userRef: ref(member) }],
        tasks: [
          task("t1", { statusRef: "s1", position: 0, labels: ["l1", "l2", "l2"], assignees: [ref(member), ref(member)] }),
          task("t2", { statusRef: "s1", position: 0, dueDate: "2026-02-31", startDate: "2026-02-28" }),
          task("t3", {
            statusRef: "s1",
            position: -1,
            customFieldValues: [
              { fieldRef: "f1", value: "text" },
              { fieldRef: "f2", value: 7 },
            ],
          }),
          task("t4", {
            statusRef: "s1",
            position: 3e9,
            subtasks: [
              { _originalId: "x1", title: "B", completed: false, position: 5 },
              { _originalId: "x2", title: "A", completed: false, position: 5 },
            ],
          }),
          task("t5", { statusRef: "s2", position: 7 }),
        ],
      }),
    ],
  });
  const summary = await previewAndRestore(ws.id, file);
  const name = `Repairs ${suffix}`;
  assert.deepEqual(summary.warnings, [
    `User "${outsider.displayName}" (${outsider.email}) not found in workspace — references will use fallback or be skipped`,
    `Project "${name}": renumbered status columns with repeated or invalid positions`,
    `Project "${name}": 1 extra completion column(s) were restored as regular columns`,
    `Project "${name}": 1 repeated label name(s) were restored with a numbered suffix, such as "Bug (3)"`,
    `Project "${name}": 1 repeated custom field name(s) were restored with a numbered suffix, such as "Size (2)"`,
    `Project "${name}": renumbered custom fields with repeated or invalid positions`,
    `Project "${name}": renumbered tasks in 1 column(s) with repeated or invalid positions`,
    `Project "${name}": renumbered the subtasks of 1 task(s) with repeated or invalid positions`,
    `Project "${name}": skipped 1 due or start date(s) that are not valid YYYY-MM-DD dates`,
  ]);
  const restored = await app.prisma.project.findFirst({
    where: { workspaceId: ws.id, name },
    select: {
      members: { select: { userId: true } },
      statuses: { orderBy: { position: "asc" }, select: { name: true, position: true, isCompletion: true } },
      labels: { orderBy: { color: "asc" }, select: { name: true } },
      customFields: { orderBy: { position: "asc" }, select: { name: true, type: true, position: true } },
      tasks: {
        orderBy: [{ statusId: "asc" }, { position: "asc" }],
        select: {
          title: true,
          position: true,
          dueDate: true,
          startDate: true,
          status: { select: { name: true } },
          labels: { select: { label: { select: { name: true } } } },
          assignees: { select: { userId: true } },
          subtasks: { orderBy: { position: "asc" }, select: { title: true, position: true } },
          customFieldValues: { select: { value: true } },
        },
      },
    },
  });
  assert.deepEqual(restored.members, [{ userId: member.id }]);
  assert.deepEqual(restored.statuses, [
    { name: "First", position: 0, isCompletion: true },
    { name: "Second", position: 1, isCompletion: false },
    { name: "Third", position: 2, isCompletion: false },
  ]);
  assert.deepEqual(restored.labels.map((l) => l.name), ["Bug", "Bug (3)", "Bug (2)"]);
  assert.deepEqual(restored.customFields, [
    { name: "Size", type: "TEXT", position: 0 },
    { name: "Size (2)", type: "NUMBER", position: 1 },
  ]);
  const byTitle = Object.fromEntries(restored.tasks.map((t) => [t.title, t]));
  assert.deepEqual(
    ["Task t3", "Task t1", "Task t2", "Task t4"].map((t) => [t, byTitle[t].status.name, byTitle[t].position]),
    [
      ["Task t3", "First", 0],
      ["Task t1", "First", 1],
      ["Task t2", "First", 2],
      ["Task t4", "First", 3],
    ],
  );
  assert.deepEqual([byTitle["Task t5"].status.name, byTitle["Task t5"].position], ["Second", 7]);
  assert.deepEqual(byTitle["Task t1"].labels.map((l) => l.label.name).sort(), ["Bug", "Bug (3)"]);
  assert.deepEqual(byTitle["Task t1"].assignees, [{ userId: member.id }]);
  assert.deepEqual([byTitle["Task t2"].dueDate, byTitle["Task t2"].startDate], [null, "2026-02-28"]);
  assert.deepEqual(byTitle["Task t3"].customFieldValues.map((v) => v.value).sort(), [7, "text"].sort());
  assert.deepEqual(byTitle["Task t4"].subtasks, [
    { title: "B", position: 0 },
    { title: "A", position: 1 },
  ]);
});

test("many repeated label, custom-field and space names preview in linear time", async () => {
  const ws = await workspace("many names");
  await app.prisma.wikiSpace.create({ data: { workspaceId: ws.id, name: "Taken", slug: "many", position: 0 } });
  const labels = 50_000;
  const spaces = 20_000;
  const file = backup({
    projects: [
      project(`Many ${suffix}`, {
        labels: Array.from({ length: labels }, (_, i) => ({ _originalId: `l${i}`, name: "Bug", color: "#000000" })),
        customFields: Array.from({ length: 2_000 }, (_, i) => ({
          _originalId: `f${i}`,
          name: `${"x".repeat(95)}${i % 2 ? "a" : "b"}`,
          type: "TEXT",
          required: false,
          position: i,
        })),
      }),
    ],
    wikiSpaces: Array.from({ length: spaces }, () => ({ space: { name: "Many" } })),
  });
  const started = performance.now();
  const response = await upload(ws.id, "preview", file);
  const ms = performance.now() - started;
  assert.equal(response.statusCode, 200, response.body);
  const summary = response.json().data;
  assert.deepEqual([summary.labels, summary.customFields, summary.wikiSpaces], [labels, 2_000, spaces]);
  assert.ok(
    summary.warnings.includes(
      `Project "Many ${suffix}": ${labels - 1} repeated label name(s) were restored with a numbered suffix, such as "Bug (2)"`,
    ),
    summary.warnings.join("\n"),
  );
  // About 1 s here; the quadratic repair took over a minute for these counts.
  assert.ok(ms < 10_000, `preview took ${Math.round(ms)} ms`);
});

test("restores never touch existing rows and pick free wiki slugs", async () => {
  const ws = await workspace("collisions");
  const existingProject = await app.prisma.project.create({
    data: { workspaceId: ws.id, name: `Collide ${suffix}` },
  });
  const existingStatus = await app.prisma.statusColumn.create({
    data: { projectId: existingProject.id, name: "Existing" },
  });
  const existingTask = await app.prisma.task.create({
    data: { projectId: existingProject.id, statusId: existingStatus.id, title: "Existing task" },
  });
  await app.prisma.wikiSpace.create({
    data: { workspaceId: ws.id, name: "Existing", slug: `handbook-${suffix}`, position: 4 },
  });
  const existing = async () => ({
    project: await app.prisma.project.findUnique({ where: { id: existingProject.id } }),
    status: await app.prisma.statusColumn.findUnique({ where: { id: existingStatus.id } }),
    task: await app.prisma.task.findUnique({ where: { id: existingTask.id } }),
  });
  const before = await existing();

  // The backup reuses the IDs of the rows already in the workspace.
  const file = backup({
    projects: [
      {
        project: { name: `Collide ${suffix}` },
        statuses: [{ _originalId: existingStatus.id, name: "Restored", position: 0, isCompletion: false }],
        tasks: [task(existingTask.id, { title: "Restored task", statusRef: existingStatus.id })],
      },
    ],
    wikiSpaces: [
      { space: { name: `Handbook ${suffix}` }, pages: [page(existingTask.id)] },
      { space: { name: `Handbook ${suffix}` }, pages: [page(existingTask.id)] },
    ],
  });
  for (let round = 0; round < 2; round++) await previewAndRestore(ws.id, file);

  assert.deepEqual(await existing(), before);
  const projects = await app.prisma.project.findMany({
    where: { workspaceId: ws.id },
    select: { id: true, name: true, tasks: { select: { id: true, title: true, statusId: true } } },
  });
  assert.equal(projects.length, 3);
  assert.ok(projects.every((p) => p.name === `Collide ${suffix}`));
  const ids = projects.flatMap((p) => [p.id, ...p.tasks.flatMap((t) => [t.id, t.statusId])]);
  assert.equal(new Set(ids).size, ids.length);
  const spaces = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: ws.id },
    orderBy: { position: "asc" },
    select: { slug: true, position: true },
  });
  assert.deepEqual(spaces, [
    { slug: `handbook-${suffix}`, position: 4 },
    { slug: `handbook-${suffix}-2`, position: 5 },
    { slug: `handbook-${suffix}-3`, position: 6 },
    { slug: `handbook-${suffix}-4`, position: 7 },
    { slug: `handbook-${suffix}-5`, position: 8 },
  ]);
});

test("an export restores into a fresh workspace with the same rows, links and files, and preview agrees", async () => {
  const source = await workspace("round trip source");
  const target = await workspace("round trip target");
  const p = await app.prisma.project.create({
    data: {
      workspaceId: source.id,
      name: `Round trip ${suffix}`,
      members: { create: [{ userId: member.id }] },
    },
  });
  const columns = [];
  for (const [i, name] of ["Todo", "Doing", "Done"].entries())
    columns.push(
      await app.prisma.statusColumn.create({
        data: { projectId: p.id, name, position: i, isCompletion: name === "Done" },
      }),
    );
  const bug = await app.prisma.label.create({ data: { projectId: p.id, name: "Bug", color: "#ff0000" } });
  const size = await app.prisma.customField.create({
    data: { projectId: p.id, name: "Size", type: "SELECT", options: [{ value: "S" }, { value: "L" }], position: 0 },
  });
  const tasks = [];
  for (let i = 0; i < 6; i++)
    tasks.push(
      await app.prisma.task.create({
        data: {
          projectId: p.id,
          statusId: columns[i % 3].id,
          title: `Task ${i}`,
          position: Math.floor(i / 3),
          priority: ["NONE", "LOW", "HIGH"][i % 3],
          dueDate: i % 2 ? "2026-11-0" + (i + 1) : null,
          assignees: { create: [{ userId: i % 2 ? member.id : admin.id }] },
          labels: i % 2 ? { create: [{ labelId: bug.id }] } : undefined,
          subtasks: { create: [{ title: `Step ${i}`, position: 0, assigneeId: member.id }] },
          comments: { create: [{ body: `Comment ${i}`, authorId: member.id }] },
          activities: { create: [{ action: "created", actorId: admin.id, details: { title: `Task ${i}` } }] },
          customFieldValues: { create: [{ fieldId: size.id, value: i % 2 ? "S" : "L" }] },
        },
      }),
    );
  for (let i = 1; i < 6; i++)
    await app.prisma.taskDependency.create({
      data: { blockedTaskId: tasks[i].id, blockingTaskId: tasks[i - 1].id },
    });
  const channel = await app.prisma.chatChannel.create({
    data: {
      workspaceId: source.id,
      name: `round-${suffix}`,
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
    },
  });
  const parent = await app.prisma.chatMessage.create({
    data: { channelId: channel.id, userId: member.id, content: "Question", createdAt: new Date(CREATED) },
  });
  await app.prisma.chatMessage.create({
    data: {
      channelId: channel.id,
      userId: admin.id,
      content: "Answer",
      parentId: parent.id,
      createdAt: new Date(Date.parse(CREATED) + 1000),
      reactions: { create: [{ userId: member.id, emoji: "👍" }] },
    },
  });
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `Round trip wiki ${suffix}`, slug: `round-trip-${suffix}` },
  });
  const stored = await app.storage.save(`${source.id}/uploads/wiki`, space.id, "diagram", ".png", Buffer.from("diagram bytes"));
  const rootPage = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Root",
      createdById: admin.id,
      content: [{ type: "image", props: { url: `/storage/${stored}` } }],
      comments: { create: [{ authorId: member.id, body: "Looks good", highlightId: "h1" }] },
    },
  });
  await app.prisma.wikiPage.create({
    data: { spaceId: space.id, parentId: rootPage.id, title: "Child", createdById: member.id, position: 0, content: null },
  });

  const exported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${source.id}/backup/export`,
    payload: {
      projects: [{ projectId: p.id, includeActivityLogs: true }],
      channels: [{ channelId: channel.id }],
      wikiSpaces: [{ spaceId: space.id }],
      includeFiles: true,
    },
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: "127.0.6.1",
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const zip = exported.rawPayload;
  const boundary = `rt-${crypto.randomUUID()}`;
  const send = (action) =>
    app.inject({
      method: "POST",
      url: `/api/workspaces/${target.id}/backup/${action}`,
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
        zip,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
      remoteAddress: `127.0.6.${2 + (++requests % 200)}`,
    });
  const preview = await send("preview");
  assert.equal(preview.statusCode, 200, preview.body);
  const before = await rows(target.id);
  const restored = await send("restore");
  assert.equal(restored.statusCode, 200, restored.body);
  const summary = restored.json().data;
  assert.deepEqual(summary, preview.json().data);
  assert.deepEqual(summary.warnings, []);
  const after = await rows(target.id);
  assertRowsMatchSummary(before, after, summary, "round trip");
  assert.deepEqual(after, await rows(source.id));

  // Relationships, compared by name.
  const describe = async (workspaceId) => {
    const t = await app.prisma.task.findMany({
      where: { project: { workspaceId } },
      orderBy: { title: "asc" },
      select: {
        title: true,
        position: true,
        priority: true,
        dueDate: true,
        status: { select: { name: true, position: true, isCompletion: true } },
        labels: { select: { label: { select: { name: true, color: true } } } },
        assignees: { select: { userId: true } },
        blockedBy: { select: { blockingTask: { select: { title: true } } } },
        subtasks: { select: { title: true, assigneeId: true } },
        comments: { select: { body: true, authorId: true } },
        activities: { select: { action: true, actorId: true, details: true } },
        customFieldValues: { select: { value: true, field: { select: { name: true, options: true } } } },
      },
    });
    const m = await app.prisma.chatMessage.findMany({
      where: { channel: { workspaceId } },
      orderBy: { createdAt: "asc" },
      select: { content: true, userId: true, createdAt: true, parent: { select: { content: true } }, reactions: { select: { userId: true, emoji: true } } },
    });
    const w = await app.prisma.wikiPage.findMany({
      where: { space: { workspaceId } },
      orderBy: { title: "asc" },
      select: { title: true, createdById: true, parent: { select: { title: true } }, comments: { select: { body: true, authorId: true } } },
    });
    return { t, m, w };
  };
  assert.deepEqual(await describe(target.id), await describe(source.id));
  const [restoredRoot] = await app.prisma.wikiPage.findMany({
    where: { space: { workspaceId: target.id }, title: "Root" },
    select: { content: true },
  });
  const url = restoredRoot.content[0].props.url;
  assert.ok(url.startsWith(`/storage/${target.id}/uploads/wiki/imports/`), url);
  assert.equal(
    (await app.storage.read(url.slice("/storage/".length))).toString(),
    "diagram bytes",
  );
  assert.equal(summary.images, 1);
});

test("a version 1.0 backup from the first export format still restores", async () => {
  const ws = await workspace("legacy");
  // The shape the first export (version 1.0) wrote: plain JSON, no wiki,
  // nulls for unset values and fields this version no longer reads.
  const legacy = {
    metadata: {
      version: "1.0",
      exportedAt: "2026-02-25T00:21:27.000Z",
      sourceWorkspace: { name: "Old", slug: "old" },
      userRefs: [{ originalId: "old-admin", email: admin.email.toUpperCase(), displayName: "Old admin" }],
    },
    projects: [
      {
        project: { name: `Legacy ${suffix}`, description: null, color: "#6366f1", icon: null },
        statuses: [
          { _originalId: "ls1", name: "To Do", color: "#94a3b8", position: 0, isCompletion: false },
          { _originalId: "ls2", name: "Done", color: "#22c55e", position: 2, isCompletion: true },
        ],
        labels: [{ _originalId: "ll1", name: "Bug", color: "#6366f1" }],
        customFields: [{ _originalId: "lf1", name: "Notes", type: "TEXT", options: null, required: false, position: 0 }],
        members: [{ userRef: "old-admin" }],
        tasks: [
          {
            _originalId: "lt1",
            title: "Legacy task",
            description: "<p>Old</p>",
            priority: "MEDIUM",
            position: 0,
            dueDate: "2026-03-01",
            startDate: null,
            statusRef: "ls1",
            createdByRef: null,
            assignees: ["old-admin"],
            labels: ["ll1"],
            subtasks: [{ _originalId: "lst1", title: "Old step", completed: false, position: 0, assigneeRef: null, dueDate: null }],
            customFieldValues: [{ fieldRef: "lf1", value: "kept" }],
            dependencies: [],
            comments: [{ _originalId: "lc1", body: "Old comment", authorRef: "old-admin", createdAt: "2026-02-20T10:00:00.000Z" }],
            activityLogs: [{ _originalId: "la1", action: "created", details: null, actorRef: "old-admin", createdAt: "2026-02-20T10:00:00.000Z" }],
          },
          {
            _originalId: "lt2",
            title: "Blocked",
            description: null,
            priority: "NONE",
            position: 0,
            dueDate: null,
            startDate: null,
            statusRef: "ls2",
            createdByRef: null,
            assignees: [],
            labels: [],
            subtasks: [],
            customFieldValues: [],
            dependencies: [{ blockingTaskRef: "lt1", type: "blocks" }],
            comments: [],
            activityLogs: [],
          },
        ],
        attachments: [],
      },
    ],
    channels: [
      {
        channel: { name: `legacy-${suffix}`, description: null, type: "PUBLIC" },
        members: [{ userRef: "old-admin" }],
        messages: [
          { _originalId: "lm1", content: "Old message", userRef: "old-admin", parentRef: null, createdAt: "2026-02-20T10:00:00.000Z", reactions: [] },
        ],
      },
    ],
  };
  const summary = await previewAndRestore(ws.id, legacy);
  const { warnings, userMappings, ...counts } = summary;
  assert.deepEqual(warnings, []);
  assert.deepEqual(userMappings, [
    { originalEmail: admin.email.toUpperCase(), originalName: "Old admin", mappedUserId: admin.id, mappedName: admin.displayName },
  ]);
  assert.deepEqual(counts, {
    projects: 1,
    statuses: 2,
    labels: 1,
    customFields: 1,
    tasks: 2,
    subtasks: 1,
    comments: 1,
    activityLogs: 1,
    channels: 1,
    messages: 1,
    reactions: 0,
    wikiSpaces: 0,
    wikiPages: 0,
    wikiComments: 0,
    images: 0,
  });
  const restored = await app.prisma.task.findMany({
    where: { project: { workspaceId: ws.id } },
    orderBy: { title: "asc" },
    select: {
      title: true,
      dueDate: true,
      status: { select: { name: true } },
      assignees: { select: { userId: true } },
      blockedBy: { select: { blockingTask: { select: { title: true } } } },
      activities: { select: { details: true, actorId: true } },
    },
  });
  assert.deepEqual(restored, [
    { title: "Blocked", dueDate: null, status: { name: "Done" }, assignees: [], blockedBy: [{ blockingTask: { title: "Legacy task" } }], activities: [] },
    {
      title: "Legacy task",
      dueDate: "2026-03-01",
      status: { name: "To Do" },
      assignees: [{ userId: admin.id }],
      blockedBy: [],
      activities: [{ details: null, actorId: admin.id }],
    },
  ]);

  // Version 1.1 pages without content and comments without a selection.
  const pages = await previewAndRestore(
    ws.id,
    backup({
      wikiSpaces: [
        {
          space: { name: `Legacy wiki ${suffix}`, description: null, icon: null },
          pages: [
            page("lp", {
              content: null,
              icon: null,
              parentRef: null,
              createdByRef: null,
              comments: [{ _originalId: "lpc", body: "Old", authorRef: null, resolved: true, highlightId: "h", selectionStart: null, selectionEnd: null, createdAt: CREATED }],
            }),
          ],
        },
      ],
    }),
  );
  assert.deepEqual([pages.wikiPages, pages.wikiComments], [1, 1]);
});
