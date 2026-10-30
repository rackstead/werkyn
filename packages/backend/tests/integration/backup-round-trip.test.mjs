// A full export of a fixture workspace, restored into a fresh workspace over
// HTTP, compared entity by entity: counts, relationships and file bytes. It
// asserts only what the restore documents as preserved, using references that
// are valid in their own project, channel and space.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
const { BACKUP_INCLUDED_CONTENT, BACKUP_OMITTED_CONTENT, BACKUP_SCOPE } = await import("@pm/shared");

const suffix = crypto.randomUUID().slice(0, 8);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
let app, token, admin, ann, bob, source, target;
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
      await app.prisma.workspace.deleteMany({ where: { id: { in: [source?.id, target?.id].filter(Boolean) } } });
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
