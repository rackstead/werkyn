import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error(
    "Set TEST_DATABASE_URL to a migrated disposable PostgreSQL DB",
  );
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "attachment-integration-jwt-secret",
  COOKIE_SECRET: "attachment-integration-cookie-secret",
});
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-attachments-"));
process.env.STORAGE_DIR = storageDir;
const { buildApp } = await import("../../src/app.ts");
const { signAccessToken } = await import("../../src/utils/tokens.ts");
const service =
  await import("../../src/modules/attachments/attachments.service.ts");
let app, workspace, foreign, task, hiddenTask, foreignTask, comment, own, peer;
const users = {},
  tokens = {};
let requests = 0;
const effects = { reads: 0, writes: 0, deletes: 0, events: 0 };
const base = (wid = workspace.id) => `/api/workspaces/${wid}`;
const ctx = (actor, workspaceRole = "ADMIN", workspaceId = workspace.id) => ({
  workspaceId,
  userId: users[actor].id,
  workspaceRole,
});
const req = (actor, method, suffix, payload, wid) =>
  app.inject({
    method,
    url: base(wid) + suffix,
    payload,
    headers: { authorization: `Bearer ${tokens[actor]}` },
    remoteAddress: `10.81.${Math.floor(++requests / 250)}.${(requests % 250) + 1}`,
  });
const targetQuery = (target = task, entityType = "task") =>
  `/attachments?entityType=${entityType}&entityId=${target.id}`;
const denied = (response) => {
  assert([403, 404].includes(response.statusCode), response.body);
  assert(!response.body.includes("Route "), response.body);
};
async function makeFile(actor = "MEMBER", data = {}) {
  const workspaceId = data.workspaceId ?? workspace.id;
  const storagePath = data.isFolder
    ? null
    : await app.storage.save(
        `${workspaceId}/files`,
        users[actor].id,
        crypto.randomUUID(),
        ".txt",
        Buffer.from(`bytes-${actor}`),
      );
  return app.prisma.file.create({
    data: {
      workspaceId,
      name: `Attachment ${crypto.randomUUID()}.txt`,
      mimeType: "text/plain",
      size: 12,
      storagePath,
      ownerId: users[actor].id,
      uploadedById: users[actor].id,
      ...data,
    },
  });
}
async function makeTask(workspaceId, actors) {
  const project = await app.prisma.project.create({
    data: {
      workspaceId,
      name: "Attachment access project",
      members: { create: actors.map((actor) => ({ userId: users[actor].id })) },
    },
  });
  const status = await app.prisma.statusColumn.create({
    data: {
      projectId: project.id,
      name: "Open",
    },
  });
  return app.prisma.task.create({
    data: {
      projectId: project.id,
      statusId: status.id,
      title: "Attachment access task",
    },
  });
}
before(async () => {
  app = await buildApp();
  await app.ready();
  const suffix = crypto.randomUUID();
  for (const actor of ["ADMIN", "MEMBER", "PEER", "VIEWER", "FOREIGN"]) {
    users[actor] = await app.prisma.user.create({
      data: {
        email: `attachment-${actor}-${suffix}@example.test`,
        displayName: actor,
        emailVerified: true,
      },
    });
    tokens[actor] = signAccessToken({
      sub: users[actor].id,
      email: users[actor].email,
    });
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Attachment access audit",
      slug: `attachment-${suffix}`,
      members: {
        create: ["ADMIN", "MEMBER", "PEER", "VIEWER"].map((actor) => ({
          userId: users[actor].id,
          role:
            actor === "ADMIN"
              ? "ADMIN"
              : actor === "VIEWER"
                ? "VIEWER"
                : "MEMBER",
        })),
      },
    },
  });
  foreign = await app.prisma.workspace.create({
    data: {
      name: "Attachment access foreign",
      slug: `att-f-${suffix}`,
      members: { create: { userId: users.FOREIGN.id, role: "ADMIN" } },
    },
  });
  task = await makeTask(workspace.id, ["MEMBER", "PEER", "VIEWER"]);
  hiddenTask = await makeTask(workspace.id, ["PEER"]);
  foreignTask = await makeTask(foreign.id, ["FOREIGN"]);
  comment = await app.prisma.comment.create({
    data: {
      taskId: task.id,
      authorId: users.PEER.id,
      body: "Attach here",
    },
  });
  own = await makeFile();
  peer = await makeFile("PEER");
  for (const [name, kind] of [
    ["read", "reads"],
    ["readStream", "reads"],
    ["save", "writes"],
    ["saveStream", "writes"],
    ["delete", "deletes"],
  ]) {
    const original = app.storage[name].bind(app.storage);
    app.storage[name] = (...args) => {
      effects[kind]++;
      return original(...args);
    };
  }
  app.broadcastToUser = app.broadcastToWorkspace = () => {
    effects.events++;
  };
});
after(async () => {
  try {
    if (app) {
      const ids = [workspace?.id, foreign?.id].filter(Boolean);
      await app.prisma.task.deleteMany({
        where: { project: { workspaceId: { in: ids } } },
      });
      await app.prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      await app.prisma.user.deleteMany({
        where: { id: { in: Object.values(users).map((u) => u.id) } },
      });
    }
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});
async function state() {
  const workspaceId = { in: [workspace.id, foreign.id] };
  return {
    attachments: await app.prisma.attachment.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    }),
    files: await app.prisma.file.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    }),
    shares: await app.prisma.fileShare.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
    }),
    links: await app.prisma.fileShareLink.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      include: { files: true },
    }),
    notifications: await app.prisma.notification.count(),
    effects: { ...effects },
  };
}
async function deniedUnchanged(actor, operations, wid) {
  const snapshot = await state();
  for (const [method, suffix, payload] of operations) {
    denied(await req(actor, method, suffix, payload, wid));
    assert.deepEqual(await state(), snapshot);
  }
}
async function list(actor, target = task, entityType = "task") {
  const response = await req(actor, "GET", targetQuery(target, entityType));
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data;
}
async function link(actor, file, target = task, entityType = "task") {
  const snapshot = await state();
  const response = await req(actor, "POST", "/attachments/link", {
    entityType,
    entityId: target.id,
    fileId: file.id,
  });
  assert.equal(response.statusCode, 201, response.body);
  const current = await state();
  assert.equal(current.attachments.length, snapshot.attachments.length + 1);
  assert.deepEqual(
    { ...current, attachments: [] },
    { ...snapshot, attachments: [] },
  );
  assert.equal(response.json().data.uploadedById, users[actor].id);
  return response.json().data;
}
async function download(actor, attachment, expected) {
  const response = await req(
    actor,
    "GET",
    `/attachments/${attachment.id}/download`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body, expected);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.match(response.headers["content-disposition"], /^attachment;/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
}
async function grant(file, actor = "MEMBER", issuer = "PEER") {
  // Ordinary current grants, independent of project or task authority.
  return app.prisma.fileShare.create({
    data: {
      workspaceId: workspace.id,
      fileId: file.id,
      sharedById: users[issuer].id,
      sharedWithId: users[actor].id,
    },
  });
}
async function rawAttachment(file, target = task, data = {}) {
  return app.prisma.attachment.create({
    data: {
      workspaceId: workspace.id,
      entityType: "task",
      entityId: target.id,
      uploadedById: users.MEMBER.id,
      fileId: file?.id ?? null,
      name: file?.name ?? "Cached private name",
      mimeType: "text/plain",
      size: 12,
      storagePath: file?.storagePath ?? "cached/private/source.txt",
      ...data,
    },
  });
}

test("linking a file requires source read authority before attachment or storage effects", async () => {
  await deniedUnchanged("MEMBER", [
    [
      "POST",
      "/attachments/link",
      {
        entityType: "task",
        entityId: task.id,
        fileId: peer.id,
      },
    ],
  ]);
});

test("unassigned discussion participants can link readable files to tasks and comments without changing sources", async () => {
  assert.equal(
    await app.prisma.taskAssignee.count({ where: { taskId: task.id } }),
    0,
  );
  for (const [target, type] of [
    [task, "task"],
    [comment, "comment"],
  ]) {
    const attachment = await link("MEMBER", own, target, type);
    assert(
      (await list("MEMBER", target, type)).some(
        (row) => row.id === attachment.id,
      ),
    );
    await download("MEMBER", attachment, "bytes-MEMBER");
  }
});

test("typed targets reject hidden, foreign and missing entities without row or storage effects", async () => {
  const hiddenComment = await app.prisma.comment.create({
    data: {
      taskId: hiddenTask.id,
      authorId: users.PEER.id,
      body: "Hidden comment",
    },
  });
  const foreignComment = await app.prisma.comment.create({
    data: {
      taskId: foreignTask.id,
      authorId: users.FOREIGN.id,
      body: "Foreign comment",
    },
  });
  for (const [entityType, entityId] of [
    ["task", hiddenTask.id],
    ["task", foreignTask.id],
    ["task", crypto.randomUUID()],
    ["comment", hiddenComment.id],
    ["comment", foreignComment.id],
    ["comment", crypto.randomUUID()],
  ])
    await deniedUnchanged("MEMBER", [
      [
        "POST",
        "/attachments/link",
        {
          entityType,
          entityId,
          fileId: own.id,
        },
      ],
      ["GET", targetQuery({ id: entityId }, entityType)],
    ]);
  await deniedUnchanged("ADMIN", [
    [
      "POST",
      "/attachments/link",
      {
        entityType: "task",
        entityId: foreignTask.id,
        fileId: own.id,
      },
    ],
  ]);
});

test("task and comment ID collisions use only their declared target type", async () => {
  const idA = crypto.randomUUID(),
    idB = crypto.randomUUID();
  const publicTask = await app.prisma.task.create({
    data: {
      id: idA,
      projectId: task.projectId,
      statusId: task.statusId,
      title: "Public collision",
    },
  });
  const privateComment = await app.prisma.comment.create({
    data: {
      id: idA,
      taskId: hiddenTask.id,
      authorId: users.PEER.id,
      body: "Private collision",
    },
  });
  const privateTask = await app.prisma.task.create({
    data: {
      id: idB,
      projectId: hiddenTask.projectId,
      statusId: hiddenTask.statusId,
      title: "Private collision",
    },
  });
  const publicComment = await app.prisma.comment.create({
    data: {
      id: idB,
      taskId: task.id,
      authorId: users.PEER.id,
      body: "Public collision",
    },
  });
  for (const [target, type] of [
    [privateTask, "task"],
    [privateComment, "comment"],
  ]) {
    const attachment = await rawAttachment(own, target, { entityType: type });
    await deniedUnchanged("MEMBER", [
      [
        "POST",
        "/attachments/link",
        { entityType: type, entityId: target.id, fileId: own.id },
      ],
      ["GET", targetQuery(target, type)],
      ["GET", `/attachments/${attachment.id}/download`],
      ["DELETE", `/attachments/${attachment.id}`],
    ]);
  }
  await link("MEMBER", own, publicTask);
  await link("MEMBER", own, publicComment, "comment");
});

test("source ownership does not grant access to a hidden attachment target", async () => {
  const file = await makeFile();
  await grant(file, "PEER", "MEMBER");
  const attachment = await link("PEER", file, hiddenTask);
  for (const actor of ["MEMBER", "VIEWER"])
    await deniedUnchanged(actor, [
      ["GET", targetQuery(hiddenTask)],
      ["GET", `/attachments/${attachment.id}/download`],
      ["DELETE", `/attachments/${attachment.id}`],
    ]);
  await download("ADMIN", attachment, "bytes-MEMBER");
  assert.equal(
    (await req("ADMIN", "DELETE", `/attachments/${attachment.id}`)).statusCode,
    204,
  );
});

test("current project membership is rechecked on every attachment operation", async () => {
  const target = await makeTask(workspace.id, ["MEMBER"]);
  const attachment = await link("MEMBER", own, target);
  const membership = await app.prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId: target.projectId,
        userId: users.MEMBER.id,
      },
    },
  });
  await app.prisma.projectMember.delete({ where: { id: membership.id } });
  await deniedUnchanged("MEMBER", [
    ["GET", targetQuery(target)],
    ["GET", `/attachments/${attachment.id}/download`],
    ["DELETE", `/attachments/${attachment.id}`],
    [
      "POST",
      "/attachments/link",
      { entityType: "task", entityId: target.id, fileId: own.id },
    ],
  ]);
  const snapshot = await state();
  await assert.rejects(
    service.deleteAttachment(
      app.prisma,
      workspace.id,
      attachment.id,
      ctx("MEMBER"),
    ),
    /project/,
  );
  assert.deepEqual(await state(), snapshot);
});

test("explicit source grants permit linked reads but grant no project or source write rights", async () => {
  const file = await makeFile("PEER");
  await grant(file);
  const attachment = await link("MEMBER", file);
  await download("MEMBER", attachment, "bytes-PEER");
  assert((await list("MEMBER")).some((row) => row.id === attachment.id));
  await deniedUnchanged("MEMBER", [
    ["PATCH", `/files/${file.id}`, { name: "Denied" }],
    [
      "POST",
      "/attachments/link",
      { entityType: "task", entityId: hiddenTask.id, fileId: file.id },
    ],
  ]);
  await app.prisma.fileShare.delete({
    where: {
      fileId_sharedWithId: {
        fileId: file.id,
        sharedWithId: users.MEMBER.id,
      },
    },
  });
  const snapshot = await state();
  assert(!(await list("MEMBER")).some((row) => row.id === attachment.id));
  assert.deepEqual(await state(), snapshot);
  await deniedUnchanged("MEMBER", [
    ["GET", `/attachments/${attachment.id}/download`],
    [
      "POST",
      "/attachments/link",
      { entityType: "task", entityId: task.id, fileId: file.id },
    ],
  ]);
  // Target-authorized uploaders may remove a stale link without source rights.
  const beforeDelete = await state();
  assert.equal(
    (await req("MEMBER", "DELETE", `/attachments/${attachment.id}`)).statusCode,
    204,
  );
  const afterDelete = await state();
  assert.equal(
    afterDelete.attachments.length,
    beforeDelete.attachments.length - 1,
  );
  assert.deepEqual(
    { ...afterDelete, attachments: [] },
    { ...beforeDelete, attachments: [] },
  );
});

async function teamSource(viaGroup = false) {
  const root = await makeFile("ADMIN", { isFolder: true, ownerId: null });
  const folder = await app.prisma.teamFolder.create({
    data: {
      workspaceId: workspace.id,
      folderId: root.id,
      name: "Attachment source team",
      ...(viaGroup ? {} : { members: { create: { userId: users.MEMBER.id } } }),
    },
  });
  const group = viaGroup
    ? await app.prisma.group.create({
        data: {
          workspaceId: workspace.id,
          name: crypto.randomUUID(),
          members: { create: { userId: users.MEMBER.id } },
          teamFolderGroups: { create: { teamFolderId: folder.id } },
        },
      })
    : null;
  const file = await makeFile("ADMIN", {
    parentId: root.id,
    teamFolderId: folder.id,
    ownerId: null,
  });
  return { root, folder, group, file };
}
for (const viaGroup of [false, true])
  test(`${viaGroup ? "group" : "direct"} source membership permits attachments and revocation removes current reads`, async () => {
    const { file, folder, group } = await teamSource(viaGroup);
    const attachment = await link("MEMBER", file, comment, "comment");
    await download("MEMBER", attachment, "bytes-ADMIN");
    if (viaGroup)
      await app.prisma.groupMember.deleteMany({
        where: {
          groupId: group.id,
          userId: users.MEMBER.id,
        },
      });
    else
      await app.prisma.teamFolderMember.deleteMany({
        where: {
          teamFolderId: folder.id,
          userId: users.MEMBER.id,
        },
      });
    const snapshot = await state();
    assert(
      !(await list("MEMBER", comment, "comment")).some(
        (row) => row.id === attachment.id,
      ),
    );
    assert.deepEqual(await state(), snapshot);
    await deniedUnchanged("MEMBER", [
      ["GET", `/attachments/${attachment.id}/download`],
    ]);
    await grant(file, "MEMBER", "ADMIN");
    await download("MEMBER", attachment, "bytes-ADMIN");
  });

test("folder grants and independently owned source copies retain their lawful attachment behavior", async () => {
  const folder = await makeFile("PEER", { isFolder: true });
  const source = await makeFile("PEER", { parentId: folder.id });
  await grant(folder);
  const linked = await link("MEMBER", source);
  const beforeCopy = await app.prisma.file.findUnique({
    where: { id: source.id },
  });
  const response = await req("MEMBER", "POST", `/files/${source.id}/copy`, {
    parentId: null,
  });
  assert.equal(response.statusCode, 201, response.body);
  const copy = response.json().data;
  assert.equal(copy.ownerId, users.MEMBER.id);
  assert.notEqual(copy.storagePath, source.storagePath);
  const copied = await link("MEMBER", copy);
  await app.prisma.fileShare.deleteMany({ where: { fileId: folder.id } });
  await deniedUnchanged("MEMBER", [
    ["GET", `/attachments/${linked.id}/download`],
  ]);
  await download("MEMBER", copied, "bytes-PEER");
  assert.deepEqual(
    await app.prisma.file.findUnique({ where: { id: source.id } }),
    beforeCopy,
  );
});

test("VIEWER reads require both authorities and stale ADMIN context cannot enable writes", async () => {
  const file = await makeFile("PEER");
  await grant(file, "VIEWER");
  const attachment = await link("PEER", file);
  await download("VIEWER", attachment, "bytes-PEER");
  assert((await list("VIEWER")).some((row) => row.id === attachment.id));
  await deniedUnchanged("VIEWER", [
    [
      "POST",
      "/attachments/link",
      { entityType: "task", entityId: task.id, fileId: file.id },
    ],
    ["DELETE", `/attachments/${attachment.id}`],
  ]);
  const snapshot = await state();
  await assert.rejects(
    service.linkAttachment(
      app.prisma,
      workspace.id,
      users.VIEWER.id,
      {
        entityType: "task",
        entityId: task.id,
        fileId: file.id,
      },
      ctx("VIEWER"),
    ),
    /Read-only/,
  );
  await assert.rejects(
    service.deleteAttachment(
      app.prisma,
      workspace.id,
      attachment.id,
      ctx("VIEWER"),
    ),
    /Read-only/,
  );
  assert.deepEqual(await state(), snapshot);
});

test("delete requires the current uploader or local admin rather than a supplied role", async () => {
  const attachment = await link("PEER", peer);
  await deniedUnchanged("MEMBER", [
    ["DELETE", `/attachments/${attachment.id}`],
  ]);
  const snapshot = await state();
  await assert.rejects(
    service.deleteAttachment(
      app.prisma,
      workspace.id,
      attachment.id,
      ctx("MEMBER"),
    ),
    /uploader/,
  );
  assert.deepEqual(await state(), snapshot);
  await app.prisma.projectMember.create({
    data: { projectId: task.projectId, userId: users.ADMIN.id },
  });
  await app.prisma.workspaceMember.update({
    where: {
      userId_workspaceId: {
        userId: users.ADMIN.id,
        workspaceId: workspace.id,
      },
    },
    data: { role: "MEMBER" },
  });
  try {
    const lowered = await state();
    await assert.rejects(
      service.deleteAttachment(
        app.prisma,
        workspace.id,
        attachment.id,
        ctx("ADMIN"),
      ),
      /uploader/,
    );
    assert.deepEqual(await state(), lowered);
  } finally {
    await app.prisma.workspaceMember.update({
      where: {
        userId_workspaceId: {
          userId: users.ADMIN.id,
          workspaceId: workspace.id,
        },
      },
      data: { role: "ADMIN" },
    });
  }
  const before = { ...effects };
  await service.deleteAttachment(
    app.prisma,
    workspace.id,
    attachment.id,
    ctx("ADMIN", "VIEWER"),
  );
  assert.deepEqual(effects, before);
});

test("removed workspace membership overrides retained project and source grants on HTTP and direct callers", async () => {
  const file = await makeFile("PEER");
  await grant(file);
  const attachment = await link("MEMBER", file);
  await app.prisma.workspaceMember.delete({
    where: {
      userId_workspaceId: {
        userId: users.MEMBER.id,
        workspaceId: workspace.id,
      },
    },
  });
  try {
    await deniedUnchanged("MEMBER", [
      ["GET", targetQuery()],
      ["GET", `/attachments/${attachment.id}/download`],
      ["DELETE", `/attachments/${attachment.id}`],
      [
        "POST",
        "/attachments/link",
        { entityType: "task", entityId: task.id, fileId: file.id },
      ],
    ]);
    const snapshot = await state();
    for (const action of [
      () =>
        service.listAttachments(
          app.prisma,
          workspace.id,
          { entityType: "task", entityId: task.id },
          ctx("MEMBER"),
        ),
      () =>
        service.downloadAttachment(
          app.storage,
          app.prisma,
          workspace.id,
          attachment.id,
          ctx("MEMBER"),
        ),
      () =>
        service.deleteAttachment(
          app.prisma,
          workspace.id,
          attachment.id,
          ctx("MEMBER"),
        ),
      () =>
        service.linkAttachment(
          app.prisma,
          workspace.id,
          users.MEMBER.id,
          { entityType: "task", entityId: task.id, fileId: file.id },
          ctx("MEMBER"),
        ),
    ])
      await assert.rejects(action(), /workspace/);
    assert.deepEqual(await state(), snapshot);
  } finally {
    await app.prisma.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: users.MEMBER.id,
        role: "MEMBER",
      },
    });
  }
});

test("caller identity and actual target workspace cannot be substituted through service context", async () => {
  const snapshot = await state();
  await assert.rejects(
    service.linkAttachment(
      app.prisma,
      workspace.id,
      users.PEER.id,
      {
        entityType: "task",
        entityId: task.id,
        fileId: own.id,
      },
      ctx("MEMBER"),
    ),
    /author mismatch/,
  );
  assert.deepEqual(await state(), snapshot);
  await app.prisma.workspaceMember.create({
    data: {
      workspaceId: foreign.id,
      userId: users.ADMIN.id,
      role: "ADMIN",
    },
  });
  const foreignFile = await makeFile("FOREIGN", { workspaceId: foreign.id });
  await deniedUnchanged("ADMIN", [
    [
      "POST",
      "/attachments/link",
      {
        entityType: "task",
        entityId: foreignTask.id,
        fileId: own.id,
      },
    ],
    [
      "POST",
      "/attachments/link",
      {
        entityType: "task",
        entityId: task.id,
        fileId: foreignFile.id,
      },
    ],
  ]);
  const foreignAttachment = await rawAttachment(foreignFile, foreignTask, {
    workspaceId: foreign.id,
    uploadedById: users.FOREIGN.id,
  });
  await deniedUnchanged("ADMIN", [
    ["GET", `/attachments/${foreignAttachment.id}/download`],
    ["DELETE", `/attachments/${foreignAttachment.id}`],
  ]);
  // A stale ctx.workspaceId cannot override the service's URL workspace argument.
  const after = await state();
  await assert.rejects(
    service.listAttachments(
      app.prisma,
      workspace.id,
      {
        entityType: "task",
        entityId: foreignTask.id,
      },
      ctx("ADMIN", "ADMIN", foreign.id),
    ),
    /target not found/,
  );
  assert.deepEqual(await state(), after);
});

test("SetNull and legacy null sources show only generic unavailable rows and return intentional404", async () => {
  const file = await makeFile();
  const attachment = await link("MEMBER", file);
  await app.prisma.file.delete({ where: { id: file.id } });
  const legacy = await rawAttachment(null, task, {
    name: "Legacy hidden name",
    storagePath: "foreign/cached/private.txt",
    size: 999,
  });
  const snapshot = await state();
  const rows = (await list("PEER")).filter((row) =>
    [attachment.id, legacy.id].includes(row.id),
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.name, "Unavailable file");
    assert.equal(row.storagePath, "");
    assert.equal(row.mimeType, "application/octet-stream");
    assert.equal(row.size, 0);
    assert.equal(row.fileId, null);
    assert.equal(row.file, null);
  }
  assert(!JSON.stringify(rows).includes(file.name));
  assert(!JSON.stringify(rows).includes(file.storagePath));
  assert(!JSON.stringify(rows).includes("Legacy hidden name"));
  for (const row of rows) {
    const response = await req(
      "MEMBER",
      "GET",
      `/attachments/${row.id}/download`,
    );
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.deepEqual(await state(), snapshot);
  for (const row of rows)
    assert.equal(
      (await req("MEMBER", "DELETE", `/attachments/${row.id}`)).statusCode,
      204,
    );
});

test("trashed, folder and missing-path sources are excluded before content, cached metadata or new links", async () => {
  for (const data of [
    { trashedAt: new Date() },
    { isFolder: true },
    { storagePath: null },
    { storagePath: "" },
  ]) {
    const file = await makeFile("MEMBER", data);
    const attachment = await rawAttachment(file, task, {
      name: "Unreadable cached sentinel",
      storagePath: "foreign/cached/sentinel.txt",
    });
    const snapshot = await state();
    const rows = await list("MEMBER");
    assert(!rows.some((row) => row.id === attachment.id));
    assert(!JSON.stringify(rows).includes("Unreadable cached sentinel"));
    assert(!JSON.stringify(rows).includes("foreign/cached/sentinel.txt"));
    assert.deepEqual(await state(), snapshot);
    await deniedUnchanged("MEMBER", [
      ["GET", `/attachments/${attachment.id}/download`],
      [
        "POST",
        "/attachments/link",
        {
          entityType: "task",
          entityId: task.id,
          fileId: file.id,
        },
      ],
    ]);
  }
});

test("readable attachment projections and download names follow the current source instead of its stale cache", async () => {
  const file = await makeFile();
  const attachment = await link("MEMBER", file);
  await app.prisma.attachment.update({
    where: { id: attachment.id },
    data: {
      name: "Cached forbidden name",
      mimeType: "cached/private",
      size: 999,
      storagePath: "foreign/cached/forbidden.txt",
    },
  });
  await app.prisma.file.update({
    where: { id: file.id },
    data: { name: "Current readable name.txt" },
  });
  const snapshot = await state();
  const row = (await list("MEMBER")).find(
    (value) => value.id === attachment.id,
  );
  assert.equal(row.name, "Current readable name.txt");
  assert.equal(row.mimeType, file.mimeType);
  assert.equal(row.size, 12);
  assert.equal(row.storagePath, file.storagePath);
  assert(!JSON.stringify(row).includes("Cached forbidden"));
  assert(!JSON.stringify(row).includes("foreign/cached/forbidden.txt"));
  assert.deepEqual(await state(), snapshot);
  const response = await req(
    "MEMBER",
    "GET",
    `/attachments/${attachment.id}/download`,
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body, "bytes-MEMBER");
  assert(
    response.headers["content-disposition"].includes(
      "Current readable name.txt",
    ),
  );
  assert(!response.headers["content-disposition"].includes("Cached forbidden"));
});

test("deleted task/comment targets deny all attachment operations even for current local admins", async () => {
  for (const type of ["task", "comment"]) {
    const targetTask = await makeTask(workspace.id, ["MEMBER"]);
    const target =
      type === "task"
        ? targetTask
        : await app.prisma.comment.create({
            data: {
              taskId: targetTask.id,
              authorId: users.MEMBER.id,
              body: "Delete target",
            },
          });
    const attachment = await link("MEMBER", own, target, type);
    if (type === "task")
      await app.prisma.task.delete({ where: { id: target.id } });
    else await app.prisma.comment.delete({ where: { id: target.id } });
    await deniedUnchanged("ADMIN", [
      ["GET", targetQuery(target, type)],
      ["GET", `/attachments/${attachment.id}/download`],
      ["DELETE", `/attachments/${attachment.id}`],
      [
        "POST",
        "/attachments/link",
        { entityType: type, entityId: target.id, fileId: own.id },
      ],
    ]);
  }
});

test("unsupported legacy entity types never resolve an arbitrary stored ID", async () => {
  const attachment = await rawAttachment(own, task, { entityType: "message" });
  await deniedUnchanged("ADMIN", [
    ["GET", `/attachments/${attachment.id}/download`],
    ["DELETE", `/attachments/${attachment.id}`],
  ]);
  const snapshot = await state();
  for (const action of [
    () =>
      service.listAttachments(
        app.prisma,
        workspace.id,
        { entityType: "message", entityId: task.id },
        ctx("ADMIN"),
      ),
    () =>
      service.linkAttachment(
        app.prisma,
        workspace.id,
        users.ADMIN.id,
        { entityType: "message", entityId: task.id, fileId: own.id },
        ctx("ADMIN"),
      ),
  ])
    await assert.rejects(action(), /target not found/);
  const response = await req("ADMIN", "POST", "/attachments/link", {
    entityType: "message",
    entityId: task.id,
    fileId: own.id,
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(await state(), snapshot);
});

test("malformed team source roots fail the same attachment read and list policy even for ADMIN", async () => {
  for (const rootData of [
    { isFolder: false },
    { isFolder: true, trashedAt: new Date() },
    { isFolder: true, workspaceId: foreign.id },
  ]) {
    const root = await makeFile("ADMIN", { ownerId: null, ...rootData });
    const folder = await app.prisma.teamFolder.create({
      data: {
        workspaceId: workspace.id,
        folderId: root.id,
        name: "Invalid attachment team",
      },
    });
    const file = await makeFile("ADMIN", {
      teamFolderId: folder.id,
      ownerId: null,
    });
    await grant(file, "MEMBER", "ADMIN");
    const attachment = await rawAttachment(file);
    for (const actor of ["MEMBER", "ADMIN"]) {
      const snapshot = await state();
      assert(!(await list(actor)).some((row) => row.id === attachment.id));
      assert.deepEqual(await state(), snapshot);
      await deniedUnchanged(actor, [
        ["GET", `/attachments/${attachment.id}/download`],
        [
          "POST",
          "/attachments/link",
          {
            entityType: "task",
            entityId: task.id,
            fileId: file.id,
          },
        ],
      ]);
    }
  }
});

test("attachment download aliases keep octet-stream attachment headers for harmless document/media fixtures", async () => {
  for (const mimeType of [
    "text/html",
    "image/svg+xml",
    "application/pdf",
    "image/png",
  ]) {
    const file = await makeFile("MEMBER", {
      mimeType,
      name: 'quoted "name".txt',
    });
    const attachment = await link("MEMBER", file);
    for (const query of ["", "?inline=true", "?inline=false&download=false"]) {
      const response = await req(
        "MEMBER",
        "GET",
        `/attachments/${attachment.id}/download${query}`,
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body, "bytes-MEMBER");
      assert.equal(
        response.headers["content-type"],
        "application/octet-stream",
      );
      assert.match(response.headers["content-disposition"], /^attachment;/);
      assert(
        response.headers["content-disposition"].includes(
          encodeURIComponent(file.name),
        ),
      );
      assert.equal(response.headers["x-content-type-options"], "nosniff");
    }
  }
});
