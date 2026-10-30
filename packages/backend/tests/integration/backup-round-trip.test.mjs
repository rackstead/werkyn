// A full export of a fixture workspace, restored into a fresh workspace over
// HTTP, compared entity by entity: counts, relationships and file bytes. It
// asserts only what the restore documents as preserved, using references that
// are valid in their own project, channel and space.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "backup-round-trip-integration-jwt-secret",
  COOKIE_SECRET: "backup-round-trip-integration-cookie-secret",
});
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-backup-round-trip-"));
const storageDir = path.join(root, "storage");
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const { readBackupArchive } = await import("../../src/modules/backup/backup-archive.ts");
const { exportBackup } = await import("../../src/modules/backup/backup.service.ts");
const { BACKUP_INCLUDED_CONTENT, BACKUP_OMITTED_CONTENT, BACKUP_SCOPE, BackupExportRequestSchema } =
  await import("@pm/shared");

const suffix = crypto.randomUUID().slice(0, 8);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let app, token, admin, ann, bob, source, target;
/** Further workspaces the consistency tests create; removed at the end. */
const extraWorkspaces = [];
const fixture = {};
let requests = 0;

function inject(method, url, payload, headers = {}) {
  return app.inject({
    method,
    url,
    payload,
    headers: { authorization: `Bearer ${token}`, ...headers },
    remoteAddress: `127.0.5.${1 + (++requests % 200)}`,
  });
}

function upload(workspaceId, action, zip) {
  const boundary = `round-trip-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return inject("POST", `/api/workspaces/${workspaceId}/backup/${action}`, payload, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  });
}

/** Sessions of this database left inside a transaction. */
const openTransactions = async () =>
  Number(
    (
      await app.prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%'`
    )[0].n,
  );

const stagedFiles = async () =>
  (await readdir(path.join(storageDir, ".tmp", "backup")).catch(() => [])).filter((name) =>
    name.endsWith(".part"),
  );

before(async () => {
  app = await buildApp();
  await app.ready();
  const user = (name) =>
    app.prisma.user.create({
      data: { email: `${name}-${suffix}@example.test`, displayName: `${name} ${suffix}`, emailVerified: true },
    });
  [admin, ann, bob] = [await user("admin"), await user("ann"), await user("bob")];
  token = signAccessToken({ sub: admin.id, email: admin.email });
  // Everyone belongs to both workspaces, so every user reference maps back.
  const workspace = (name) =>
    app.prisma.workspace.create({
      data: {
        name: `Round trip ${name}`,
        slug: `round-trip-${name}-${suffix}`,
        members: {
          create: [
            { userId: admin.id, role: "ADMIN" },
            { userId: ann.id, role: "MEMBER" },
            { userId: bob.id, role: "MEMBER" },
          ],
        },
      },
    });
  source = await workspace("source");
  target = await workspace("target");

  // ─── Project ───
  const project = await app.prisma.project.create({
    data: {
      workspaceId: source.id,
      name: `Launch ${suffix}`,
      description: "Everything for the launch",
      color: "#336699",
      icon: "rocket",
      members: { create: [{ userId: ann.id }, { userId: bob.id }] },
    },
  });
  const todo = await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "To do", color: "#999999", position: 0 },
  });
  const done = await app.prisma.statusColumn.create({
    data: { projectId: project.id, name: "Done", color: "#00aa00", position: 1, isCompletion: true },
  });
  const bug = await app.prisma.label.create({ data: { projectId: project.id, name: "bug", color: "#ff0000" } });
  const feature = await app.prisma.label.create({
    data: { projectId: project.id, name: "feature", color: "#0000ff" },
  });
  const notes = await app.prisma.customField.create({
    data: { projectId: project.id, name: "Notes", type: "TEXT", position: 0 },
  });
  const points = await app.prisma.customField.create({
    data: { projectId: project.id, name: "Points", type: "NUMBER", position: 1 },
  });
  const size = await app.prisma.customField.create({
    data: {
      projectId: project.id,
      name: "Size",
      type: "SELECT",
      position: 2,
      options: [{ value: "S", color: "#00ff00" }, { value: "M", color: "#ffff00" }],
    },
  });
  const first = await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: todo.id,
      title: "Write the plan",
      description: "<p>Plan <strong>everything</strong> ü</p>",
      priority: "HIGH",
      position: 0,
      dueDate: "2026-12-01",
      startDate: "2026-11-15",
      assignees: { create: [{ userId: ann.id }, { userId: bob.id }] },
      labels: { create: [{ labelId: bug.id }, { labelId: feature.id }] },
      subtasks: {
        create: [
          { title: "Outline", completed: true, position: 0, assigneeId: bob.id, dueDate: "2026-11-20" },
          { title: "Review", completed: false, position: 1 },
        ],
      },
      customFieldValues: {
        create: [
          { fieldId: notes.id, value: "Keep it short" },
          { fieldId: points.id, value: 5 },
          { fieldId: size.id, value: "M" },
        ],
      },
      comments: {
        create: [
          { authorId: ann.id, body: "<p>First thought</p>" },
          { authorId: bob.id, body: "<p>Second thought</p>" },
        ],
      },
      activities: { create: [{ actorId: ann.id, action: "task.created", details: { via: "fixture" } }] },
    },
  });
  await app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: done.id,
      title: "Ship it",
      priority: "URGENT",
      position: 1,
      labels: { create: [{ labelId: feature.id }] },
      blockedBy: { create: [{ blockingTaskId: first.id }] },
    },
  });
  await app.prisma.task.create({
    data: { projectId: project.id, statusId: todo.id, title: "Tidy up", priority: "LOW", position: 2 },
  });
  fixture.project = project;

  // ─── Channel ───
  const channel = await app.prisma.chatChannel.create({
    data: {
      workspaceId: source.id,
      name: `launch-${suffix}`,
      description: "Launch chatter",
      type: "PUBLIC",
      createdById: ann.id,
      members: { create: [{ userId: ann.id }, { userId: bob.id }] },
    },
  });
  const hello = await app.prisma.chatMessage.create({
    data: { channelId: channel.id, userId: ann.id, content: "<p>Hello</p>", createdAt: new Date(Date.now() - 3000) },
  });
  await app.prisma.chatMessage.create({
    data: {
      channelId: channel.id,
      userId: bob.id,
      content: "<p>Hi back</p>",
      parentId: hello.id,
      createdAt: new Date(Date.now() - 2000),
    },
  });
  await app.prisma.chatMessage.create({
    data: {
      channelId: channel.id,
      userId: bob.id,
      content: "<p>deleted</p>",
      deletedAt: new Date(),
      createdAt: new Date(Date.now() - 1000),
    },
  });
  await app.prisma.chatReaction.create({ data: { messageId: hello.id, userId: bob.id, emoji: "👍" } });
  fixture.channel = channel;

  // ─── Wiki with embedded images ───
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `Handbook ${suffix}`, slug: `handbook-${suffix}`, description: "How we work" },
  });
  fixture.images = {
    "photo.png": crypto.randomBytes(300 * 1024),
    "notes.txt": Buffer.alloc(64 * 1024, "werkyn "),
  };
  fixture.urls = {};
  for (const [name, bytes] of Object.entries(fixture.images)) {
    const stored = await app.storage.save(
      `${source.id}/uploads/wiki`,
      space.id,
      crypto.randomUUID(),
      path.extname(name),
      bytes,
    );
    fixture.urls[name] = `/storage/${stored}`;
  }
  const rootPage = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Start here",
      icon: "📘",
      position: 0,
      createdById: ann.id,
      content: Object.values(fixture.urls).map((url) => ({ type: "image", props: { url } })),
    },
  });
  const child = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      parentId: rootPage.id,
      title: "Process",
      position: 0,
      createdById: bob.id,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Step by step" }] }],
      comments: {
        create: [
          { authorId: ann.id, body: "Clarify this", highlightId: "h-1", resolved: true },
          { authorId: bob.id, body: "Done", highlightId: "h-2" },
        ],
      },
    },
  });
  await app.prisma.wikiPage.create({
    data: { spaceId: space.id, parentId: child.id, title: "Details", position: 0, createdById: ann.id },
  });
  fixture.space = space;
});

after(async () => {
  try {
    if (app) {
      await app.prisma.workspace.deleteMany({
        where: { id: { in: [source?.id, target?.id, ...extraWorkspaces].filter(Boolean) } },
      });
      await app.prisma.user.deleteMany({ where: { id: { in: [admin, ann, bob].filter(Boolean).map((u) => u.id) } } });
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Everything the backup documents as preserved, by name instead of ID. */
async function snapshot(workspaceId) {
  const email = (user) => user?.email.replace(`-${suffix}`, "") ?? null;
  const projects = await app.prisma.project.findMany({
    where: { workspaceId },
    include: {
      members: { include: { user: true } },
      statuses: { orderBy: { position: "asc" } },
      labels: { orderBy: { name: "asc" } },
      customFields: { orderBy: { position: "asc" } },
      tasks: {
        orderBy: { position: "asc" },
        include: {
          status: true,
          assignees: { include: { user: true } },
          labels: { include: { label: true } },
          subtasks: { orderBy: { position: "asc" }, include: { assignee: true } },
          customFieldValues: { include: { field: true } },
          blockedBy: { include: { blockingTask: true } },
          comments: { orderBy: { body: "asc" }, include: { author: true } },
          activities: { include: { actor: true } },
        },
      },
    },
  });
  const channels = await app.prisma.chatChannel.findMany({
    where: { workspaceId },
    include: {
      members: { include: { user: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: { user: true, parent: true, reactions: { include: { user: true } } },
      },
    },
  });
  const spaces = await app.prisma.wikiSpace.findMany({
    where: { workspaceId },
    include: {
      pages: {
        orderBy: { title: "asc" },
        include: { parent: true, createdBy: true, comments: { orderBy: { body: "asc" }, include: { author: true } } },
      },
    },
  });
  return {
    projects: projects.map((p) => ({
      name: p.name,
      description: p.description,
      color: p.color,
      icon: p.icon,
      members: p.members.map((m) => email(m.user)).sort(),
      statuses: p.statuses.map((s) => [s.name, s.color, s.isCompletion]),
      labels: p.labels.map((l) => [l.name, l.color]),
      customFields: p.customFields.map((f) => [f.name, f.type, f.options ?? null]),
      tasks: p.tasks.map((t) => ({
        title: t.title,
        description: t.description,
        priority: t.priority,
        dueDate: t.dueDate,
        startDate: t.startDate,
        status: t.status.name,
        assignees: t.assignees.map((a) => email(a.user)).sort(),
        labels: t.labels.map((l) => l.label.name).sort(),
        subtasks: t.subtasks.map((s) => [s.title, s.completed, email(s.assignee), s.dueDate]),
        customFieldValues: t.customFieldValues.map((v) => [v.field.name, v.value]).sort(),
        blockedBy: t.blockedBy.map((d) => d.blockingTask.title),
        comments: t.comments.map((c) => [c.body, email(c.author)]),
        activities: t.activities.map((a) => [a.action, a.details, email(a.actor)]),
      })),
    })),
    channels: channels.map((c) => ({
      name: c.name,
      description: c.description,
      type: c.type,
      members: c.members.map((m) => email(m.user)).sort(),
      messages: c.messages.map((m) => ({
        content: m.content,
        author: email(m.user),
        parent: m.parent?.content ?? null,
        reactions: m.reactions.map((r) => [r.emoji, email(r.user)]),
      })),
    })),
    spaces: spaces.map((s) => ({
      name: s.name,
      description: s.description,
      pages: s.pages.map((p) => ({
        title: p.title,
        icon: p.icon,
        parent: p.parent?.title ?? null,
        createdBy: email(p.createdBy),
        comments: p.comments.map((c) => [c.body, email(c.author), c.highlightId, c.resolved]),
      })),
    })),
  };
}

test("a full export restores into a fresh workspace with the same content, links and file bytes", async () => {
  const exported = await inject("POST", `/api/workspaces/${source.id}/backup/export`, {
    projects: [{ projectId: fixture.project.id, includeActivityLogs: true }],
    channels: [{ channelId: fixture.channel.id }],
    wikiSpaces: [{ spaceId: fixture.space.id }],
    includeFiles: true,
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.headers["content-type"], "application/zip");
  const zip = exported.rawPayload;
  assert.equal(Number(exported.headers["content-length"]), zip.length);
  assert.deepEqual(await stagedFiles(), [], "the export's staged archive is gone");

  // The archive: backup.json with the completeness manifest, and each image.
  const contents = await readBackupArchive(zip);
  const backup = JSON.parse(contents.jsonBuffer.toString());
  assert.equal(backup.metadata.scope, BACKUP_SCOPE);
  assert.deepEqual(backup.metadata.included, BACKUP_INCLUDED_CONTENT.map((item) => item.key));
  assert.deepEqual(backup.metadata.omitted, BACKUP_OMITTED_CONTENT.map((item) => item.key));
  assert.deepEqual(
    backup.metadata.userRefs.map((ref) => ref.email).sort(),
    [admin, ann, bob].filter((u) => u !== admin).map((u) => u.email).sort(),
  );
  // backup.json is formatted as before: two-space indentation.
  assert.equal(contents.jsonBuffer.toString(), JSON.stringify(backup, null, 2));
  assert.equal(contents.assets.size, 2);
  const archived = new Map();
  for (const [name, asset] of contents.assets) archived.set(sha256(await asset.read()), name);
  for (const bytes of Object.values(fixture.images)) assert.ok(archived.has(sha256(bytes)));

  const preview = await upload(target.id, "preview", zip);
  assert.equal(preview.statusCode, 200, preview.body);
  const restored = await upload(target.id, "restore", zip);
  assert.equal(restored.statusCode, 200, restored.body);
  const summary = restored.json().data;
  // Preview counts agree with what the restore did.
  assert.deepEqual(
    { ...preview.json().data, warnings: undefined },
    { ...summary, warnings: undefined },
  );
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(
    {
      projects: summary.projects,
      statuses: summary.statuses,
      labels: summary.labels,
      customFields: summary.customFields,
      tasks: summary.tasks,
      subtasks: summary.subtasks,
      comments: summary.comments,
      activityLogs: summary.activityLogs,
      channels: summary.channels,
      messages: summary.messages,
      reactions: summary.reactions,
      wikiSpaces: summary.wikiSpaces,
      wikiPages: summary.wikiPages,
      wikiComments: summary.wikiComments,
      images: summary.images,
    },
    {
      projects: 1,
      statuses: 2,
      labels: 2,
      customFields: 3,
      tasks: 3,
      subtasks: 2,
      comments: 2,
      activityLogs: 1,
      channels: 1,
      messages: 2,
      reactions: 1,
      wikiSpaces: 1,
      wikiPages: 3,
      wikiComments: 2,
      images: 2,
    },
  );
  assert.deepEqual(await stagedFiles(), [], "the restore's staged upload is gone");

  // Entity by entity, the fresh workspace holds what the source held. The
  // deleted message is not exported.
  const [before, after] = [await snapshot(source.id), await snapshot(target.id)];
  before.channels[0].messages = before.channels[0].messages.filter((m) => m.content !== "<p>deleted</p>");
  // Restore behaviour, not export: the restoring admin joins each channel.
  assert.ok(after.channels[0].members.includes("admin@example.test"));
  after.channels[0].members = after.channels[0].members.filter((m) => m !== "admin@example.test");
  assert.deepEqual(after, before);

  // Every restored image matches its source bytes.
  const [space] = await app.prisma.wikiSpace.findMany({
    where: { workspaceId: target.id },
    include: { pages: { where: { title: "Start here" } } },
  });
  const urls = space.pages[0].content.map((block) => block.props.url);
  assert.equal(urls.length, 2);
  for (const [index, name] of Object.keys(fixture.images).entries()) {
    assert.ok(urls[index].startsWith(`/storage/${target.id}/uploads/wiki/imports/`), urls[index]);
    const bytes = await readFile(path.join(storageDir, urls[index].slice("/storage/".length)));
    assert.equal(sha256(bytes), sha256(fixture.images[name]), name);
  }
});

test("an export whose client has gone stops and leaves no file", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportBackup(
      app.prisma,
      source.id,
      { projects: [{ projectId: fixture.project.id, includeTasks: true }], channels: [], wikiSpaces: [], includeFiles: true },
      app.storage,
      admin.id,
      undefined,
      undefined,
      { signal: controller.signal },
    ),
    { statusCode: 400, message: "The backup request was cancelled" },
  );
  assert.deepEqual(await stagedFiles(), []);
});

/**
 * A client whose `model.findMany` runs `hook.before(args)` and
 * `hook.after(rows, args, client)` around each call, whether the export reads
 * through the client itself or through a transaction it opens on it.
 */
function hooked(model, hook) {
  const wrap = (client, isRoot) => {
    const delegate = new Proxy(client[model], {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "findMany") return typeof value === "function" ? value.bind(target) : value;
        return async (args) => {
          await hook.before?.(args, client);
          const rows = await value.call(target, args);
          await hook.after?.(rows, args, client);
          return rows;
        };
      },
    });
    return new Proxy(client, {
      get(target, prop) {
        if (prop === model) return delegate;
        if (prop === "$transaction" && isRoot)
          return (fn, options) => target.$transaction((tx) => fn(wrap(tx, false)), options);
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return wrap(app.prisma, true);
}

async function freshWorkspace(name) {
  const workspace = await app.prisma.workspace.create({
    data: {
      name,
      slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${crypto.randomUUID().slice(0, 8)}`,
      members: { create: [{ userId: admin.id, role: "ADMIN" }] },
    },
  });
  extraWorkspaces.push(workspace.id);
  return workspace;
}

/** A project of tasks created one second apart, so batches split them in order. */
async function orderedProject(workspaceId, titles) {
  const project = await app.prisma.project.create({
    data: { workspaceId, name: `Ordered ${crypto.randomUUID().slice(0, 6)}`, members: { create: [{ userId: admin.id }] } },
  });
  const status = await app.prisma.statusColumn.create({ data: { projectId: project.id, name: "Open", position: 0 } });
  const start = Date.now() - 60_000;
  const tasks = [];
  for (const [i, title] of titles.entries()) {
    tasks.push(
      await app.prisma.task.create({
        data: { projectId: project.id, statusId: status.id, title, position: i, createdAt: new Date(start + i * 1000) },
      }),
    );
  }
  return { project, status, tasks };
}

/** Export with batches of 2 through `prisma`, then preview and restore the archive in a fresh workspace. */
async function exportThenRestore(prisma, workspaceId, request) {
  const { file } = await exportBackup(
    prisma,
    workspaceId,
    BackupExportRequestSchema.parse(request),
    app.storage,
    admin.id,
    undefined,
    undefined,
    { batchSize: 2 },
  );
  let zip;
  try {
    zip = await readFile(file.path);
  } finally {
    await file.dispose();
  }
  const backup = JSON.parse((await readBackupArchive(zip)).jsonBuffer.toString());
  const into = await freshWorkspace("Restored copy");
  const preview = await upload(into.id, "preview", zip);
  const restored = await upload(into.id, "restore", zip);
  return { backup, into, preview, restored };
}

/** Preview and restore succeed, agree, and warn about nothing. */
function assertCleanRestore({ preview, restored }) {
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.deepEqual(restored.json().data.warnings, []);
  assert.deepEqual({ ...preview.json().data, warnings: [] }, { ...restored.json().data, warnings: [] });
}

test("an export reads one read-only repeatable-read snapshot and always closes it", async () => {
  const { project } = await orderedProject(source.id, ["S1", "S2", "S3"]);
  const seen = [];
  const prisma = hooked("task", {
    async after(rows, args, client) {
      if (seen.length > 0) return;
      const [isolation] = await client.$queryRaw`SHOW transaction_isolation`;
      const [readOnly] = await client.$queryRaw`SHOW transaction_read_only`;
      seen.push(isolation.transaction_isolation, readOnly.transaction_read_only);
    },
  });
  const request = { projects: [{ projectId: project.id }] };
  const { backup } = await exportThenRestore(prisma, source.id, request);
  assert.deepEqual(seen, ["repeatable read", "on"]);
  assert.equal(backup.projects[0].tasks.length, 3);

  // Over the limits, cancelled, or failing: the snapshot is rolled back and
  // the partial archive removed.
  const parsed = BackupExportRequestSchema.parse(request);
  await assert.rejects(
    exportBackup(app.prisma, source.id, parsed, app.storage, admin.id, undefined, {
      maxBytes: 100,
      maxTokens: 1e9,
      maxObjects: 1e9,
      maxDepth: 1e9,
    }),
    { statusCode: 400 },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportBackup(app.prisma, source.id, parsed, app.storage, admin.id, undefined, undefined, { signal: controller.signal }),
    { message: "The backup request was cancelled" },
  );
  const failing = hooked("task", {
    after() {
      throw new Error("simulated database failure");
    },
  });
  await assert.rejects(
    exportBackup(failing, source.id, parsed, app.storage, admin.id),
    /simulated database failure/,
  );
  assert.equal(await openTransactions(), 0);
  assert.deepEqual(await stagedFiles(), []);
});

test("rows deleted between export batches never cut the rest of a list short", async () => {
  const { project, tasks } = await orderedProject(source.id, ["Paged 1", "Paged 2", "Paged 3", "Paged 4", "Paged 5"]);
  // The last row of the first batch is deleted before the next batch is read.
  let deleted;
  const prisma = hooked("task", {
    async after(rows, args) {
      if (deleted || args?.where?.projectId !== project.id || rows.length !== 2) return;
      deleted = rows[1].title;
      await app.prisma.task.delete({ where: { id: rows[1].id } });
    },
  });
  const { backup } = await exportThenRestore(prisma, source.id, { projects: [{ projectId: project.id }] });
  assert.equal(deleted, "Paged 2");
  assert.equal(tasks.length, 5);
  // The snapshot still holds the deleted row, and every later one.
  assert.deepEqual(
    backup.projects[0].tasks.map((t) => t.title),
    ["Paged 1", "Paged 2", "Paged 3", "Paged 4", "Paged 5"],
  );
});

test("a dependency reversed during the export is exported as it was, without a cycle", async () => {
  const workspace = await freshWorkspace("Dependency flip");
  const { project, tasks: [t1, , t3] } = await orderedProject(workspace.id, ["T1", "T2", "T3", "T4"]);
  const added = await inject("POST", `/api/tasks/${t1.id}/dependencies`, { blockingTaskId: t3.id });
  assert.equal(added.statusCode, 201, added.body);
  // After T1 and T2 are read: remove "T3 blocks T1", add "T1 blocks T3".
  let edited = false;
  const prisma = hooked("task", {
    async after(rows) {
      if (edited || rows.length !== 2 || rows[0].id !== t1.id) return;
      edited = true;
      const dependency = await app.prisma.taskDependency.findFirst({ where: { blockedTaskId: t1.id } });
      const removed = await inject("DELETE", `/api/tasks/${t1.id}/dependencies/${dependency.id}`);
      assert.ok(removed.statusCode < 300, removed.body);
      const reversed = await inject("POST", `/api/tasks/${t3.id}/dependencies`, { blockingTaskId: t1.id });
      assert.equal(reversed.statusCode, 201, reversed.body);
    },
  });
  const result = await exportThenRestore(prisma, workspace.id, { projects: [{ projectId: project.id }] });
  assert.ok(edited);
  const exported = result.backup.projects[0].tasks;
  const title = (id) => exported.find((t) => t._originalId === id)?.title;
  assert.deepEqual(
    exported.flatMap((t) => t.dependencies.map((d) => `${t.title}<-${title(d.blockingTaskRef)}`)),
    ["T1<-T3"],
  );
  assertCleanRestore(result);
  const restored = await app.prisma.taskDependency.findMany({
    where: { blockedTask: { project: { workspaceId: result.into.id } } },
    include: { blockedTask: true, blockingTask: true },
  });
  assert.deepEqual(restored.map((d) => `${d.blockedTask.title}<-${d.blockingTask.title}`), ["T1<-T3"]);
});

test("a status created and a task moved into it during the export are left out together", async () => {
  const workspace = await freshWorkspace("Status move");
  const { project, tasks } = await orderedProject(workspace.id, ["T1", "T2", "T3", "T4"]);
  let edited = false;
  const prisma = hooked("task", {
    async after(rows) {
      if (edited || rows.length !== 2 || rows[0].id !== tasks[0].id) return;
      edited = true;
      const status = await inject("POST", `/api/projects/${project.id}/statuses`, { name: "Review", color: "#123456" });
      assert.ok(status.statusCode < 300, status.body);
      const moved = await inject("PATCH", `/api/tasks/${tasks[3].id}/move`, {
        statusId: status.json().data.id,
        position: 0,
      });
      assert.ok(moved.statusCode < 300, moved.body);
    },
  });
  const result = await exportThenRestore(prisma, workspace.id, { projects: [{ projectId: project.id }] });
  assert.ok(edited);
  const [exported] = result.backup.projects;
  assert.deepEqual(exported.statuses.map((s) => s.name), ["Open"]);
  assert.equal(exported.tasks.length, 4);
  for (const task of exported.tasks) assert.equal(task.statusRef, exported.statuses[0]._originalId, task.title);
  assertCleanRestore(result);
  assert.equal(result.restored.json().data.tasks, 4);
});

test("wiki pages re-parented during the export are exported as they were, without a cycle", async () => {
  const workspace = await freshWorkspace("Wiki move");
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "Moves", slug: `moves-${crypto.randomUUID().slice(0, 8)}` },
  });
  const start = Date.now() - 60_000;
  const page = (title, at, parentId) =>
    app.prisma.wikiPage.create({
      data: { spaceId: space.id, title, position: at, parentId, createdById: admin.id, createdAt: new Date(start + at * 1000) },
    });
  // P3 is a root and P1 sits under it; P1 and P2 are read first.
  const p3 = await page("P3", 3, null);
  const p1 = await page("P1", 1, p3.id);
  await page("P2", 2, null);
  await page("P4", 4, null);
  let edited = false;
  const prisma = hooked("wikiPage", {
    async after(rows) {
      if (edited || rows.length !== 2 || rows[0].id !== p1.id) return;
      edited = true;
      const up = await inject("PATCH", `/api/wiki/pages/${p1.id}/move`, { parentId: null, position: 5 });
      assert.ok(up.statusCode < 300, up.body);
      const down = await inject("PATCH", `/api/wiki/pages/${p3.id}/move`, { parentId: p1.id, position: 0 });
      assert.ok(down.statusCode < 300, down.body);
    },
  });
  const result = await exportThenRestore(prisma, workspace.id, {
    wikiSpaces: [{ spaceId: space.id }],
    includeFiles: false,
  });
  assert.ok(edited);
  const pages = result.backup.wikiSpaces[0].pages;
  const parent = (p) => pages.find((other) => other._originalId === p.parentRef)?.title ?? null;
  assert.deepEqual(
    Object.fromEntries(pages.map((p) => [p.title, parent(p)])),
    { P1: "P3", P2: null, P3: null, P4: null },
  );
  assertCleanRestore(result);
});

test("a wiki page moved to another space during the export is exported once", async () => {
  const workspace = await freshWorkspace("Space move");
  const spaces = [];
  for (const name of ["S1", "S2"]) {
    spaces.push(
      await app.prisma.wikiSpace.create({
        data: { workspaceId: workspace.id, name, slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}` },
      }),
    );
  }
  const start = Date.now() - 60_000;
  const a = await app.prisma.wikiPage.create({
    data: { spaceId: spaces[0].id, title: "A", position: 0, createdById: admin.id, createdAt: new Date(start) },
  });
  await app.prisma.wikiPage.create({
    data: { spaceId: spaces[1].id, title: "B", position: 0, createdById: admin.id, createdAt: new Date(start + 1000) },
  });
  // After S1 is read and before S2 is: move A into S2.
  let edited = false;
  const prisma = hooked("wikiPage", {
    async before(args) {
      if (edited || args?.where?.spaceId !== spaces[1].id) return;
      edited = true;
      const moved = await inject("PATCH", `/api/wiki/pages/${a.id}/move`, { spaceId: spaces[1].id, parentId: null, position: 1 });
      assert.ok(moved.statusCode < 300, moved.body);
    },
  });
  const result = await exportThenRestore(prisma, workspace.id, {
    wikiSpaces: spaces.map((s) => ({ spaceId: s.id })),
    includeFiles: false,
  });
  assert.ok(edited);
  assert.deepEqual(
    result.backup.wikiSpaces.map((s) => `${s.space.name}:${s.pages.map((p) => p.title).join(",")}`),
    ["S1:A", "S2:B"],
  );
  assertCleanRestore(result);
  assert.equal(result.restored.json().data.wikiPages, 2);
});

test("a wiki page edited while images are copied is exported as it was when the export began", async () => {
  const space = await app.prisma.wikiSpace.create({
    data: { workspaceId: source.id, name: `Changing ${suffix}`, slug: `changing-${suffix}` },
  });
  const stored = [];
  for (const name of ["first", "added"]) {
    stored.push(
      `/storage/${await app.storage.save(`${source.id}/uploads/wiki`, space.id, crypto.randomUUID(), ".png", Buffer.from(name))}`,
    );
  }
  const page = await app.prisma.wikiPage.create({
    data: {
      spaceId: space.id,
      title: "Changing page",
      createdById: admin.id,
      content: [{ type: "image", props: { url: stored[0] } }],
    },
  });
  // While the first image is copied, someone embeds a second one.
  let edited = false;
  const storage = Object.create(app.storage);
  storage.openReadStream = async (storagePath) => {
    if (!edited) {
      edited = true;
      await app.prisma.wikiPage.update({
        where: { id: page.id },
        data: { content: stored.map((url) => ({ type: "image", props: { url } })) },
      });
    }
    return app.storage.openReadStream(storagePath);
  };
  const request = { projects: [], channels: [], wikiSpaces: [{ spaceId: space.id }], includeFiles: true };
  const { file } = await exportBackup(app.prisma, source.id, request, storage, admin.id);
  try {
    assert.ok(edited);
    const contents = await readBackupArchive(file.path);
    const backup = JSON.parse(contents.jsonBuffer.toString());
    const urls = backup.wikiSpaces[0].pages[0].content.map((block) => block.props.url);
    assert.equal(urls.length, 1, "the page as it was");
    assert.ok(contents.assets.has(urls[0]), urls[0]);
    assert.equal((await contents.assets.get(urls[0]).read()).toString(), "first");
  } finally {
    await file.dispose();
  }
});

test("an export needs one database connection, images included", { timeout: 60_000 }, async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "5");
  const single = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const request = BackupExportRequestSchema.parse({ wikiSpaces: [{ spaceId: fixture.space.id }], includeFiles: true });
    const { file } = await exportBackup(single, source.id, request, app.storage, admin.id);
    try {
      const contents = await readBackupArchive(file.path);
      assert.equal(contents.assets.size, 2);
    } finally {
      await file.dispose();
    }
  } finally {
    await single.$disconnect();
  }
});

test("a stalled image read is cut off by a client abort or the deadline", { timeout: 60_000 }, async () => {
  const { EXPORT_TOO_SLOW_MESSAGE } = await import("../../src/modules/backup/backup.service.ts");
  // Storage that opens each image and then never delivers a byte.
  const streams = [];
  const storage = Object.create(app.storage);
  storage.openReadStream = async () => {
    const stream = new Readable({ read() {} });
    streams.push(stream);
    return stream;
  };
  const request = BackupExportRequestSchema.parse({ wikiSpaces: [{ spaceId: fixture.space.id }], includeFiles: true });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  let started = Date.now();
  await assert.rejects(
    exportBackup(app.prisma, source.id, request, storage, admin.id, undefined, undefined, { signal: controller.signal }),
    { message: "The backup request was cancelled" },
  );
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);

  started = Date.now();
  await assert.rejects(
    exportBackup(app.prisma, source.id, request, storage, admin.id, undefined, undefined, { timeoutMs: 500 }),
    { statusCode: 409, message: EXPORT_TOO_SLOW_MESSAGE },
  );
  assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);

  assert.equal(streams.length, 2);
  for (const stream of streams) assert.ok(stream.destroyed, "the stalled read was destroyed");
  assert.equal(await openTransactions(), 0);
  assert.deepEqual(await stagedFiles(), []);
});
