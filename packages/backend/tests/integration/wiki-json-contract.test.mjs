import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to migrated disposable PostgreSQL");
const storageDir = await mkdtemp(path.join(os.tmpdir(), "werkyn-wiki-json-"));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "wiki-json-contract-jwt-secret",
  COOKIE_SECRET: "wiki-json-contract-cookie-secret",
  STORAGE_DIR: storageDir,
});
const { buildApp } = await import("../../src/app.ts");
const { createApiKey } =
  await import("../../src/modules/api-keys/api-keys.service.ts");
const { inspectBackupJson, parseBackupJson } =
  await import("../../src/modules/backup/backup-json.ts");
const { validateBackup } =
  await import("../../src/modules/backup/restore-validation.ts");
const { backupConcurrency } =
  await import("../../src/modules/backup/backup-concurrency.ts");
const suffix = crypto.randomUUID();
const events = [];
let app, port, workspace, space, actor, other, outsider;
let requests = 0;
const keys = new Map();

function nested(levels, kind = "object") {
  let value = "leaf";
  for (let i = 0; i < levels; i++)
    value =
      kind === "array" || (kind === "mixed" && i % 2)
        ? [value]
        : { child: value };
  return value;
}

before(async () => {
  app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
  app.broadcastToWorkspace = (...event) => events.push(event);
  app.broadcastToUser = (...event) => events.push(event);
  for (const name of ["actor", "other", "outsider"]) {
    const user = await app.prisma.user.create({
      data: {
        email: `wiki-json-${name}-${suffix}@example.test`,
        displayName: name,
        emailVerified: true,
      },
    });
    keys.set(
      user.id,
      (
        await createApiKey(app.prisma, user.id, {
          name: "JSON test",
          expiresInDays: null,
        })
      ).key,
    );
    if (name === "actor") actor = user;
    else if (name === "other") other = user;
    else outsider = user;
  }
  workspace = await app.prisma.workspace.create({
    data: {
      name: "Wiki JSON",
      slug: `wiki-json-${suffix}`,
      members: {
        create: [
          { userId: actor.id, role: "ADMIN" },
          { userId: other.id, role: "MEMBER" },
        ],
      },
    },
  });
  space = await app.prisma.wikiSpace.create({
    data: { workspaceId: workspace.id, name: "JSON", slug: `json-${suffix}` },
  });
});

after(async () => {
  try {
    if (workspace)
      await app.prisma.workspace.delete({ where: { id: workspace.id } });
    if (keys.size)
      await app.prisma.user.deleteMany({
        where: { id: { in: [...keys.keys()] } },
      });
  } finally {
    await app?.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

/** Actual loopback HTTP, with a separate rate-limit bucket for every request. */
function request(method, url, data, user = actor, headers = {}) {
  const payload =
    data === undefined
      ? undefined
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api${url}`,
        method,
        localAddress: `127.93.${Math.floor(++requests / 250)}.${1 + (requests % 250)}`,
        headers: {
          authorization: `Bearer ${keys.get(user.id)}`,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function result(response, expected) {
  assert.equal(response.status, expected, response.body);
  return response.body ? JSON.parse(response.body) : undefined;
}

async function create(content = [{ type: "paragraph", content: [] }]) {
  return result(
    await request("POST", `/wiki/spaces/${space.id}/pages`, {
      title: "JSON page",
      content,
    }),
    201,
  ).data;
}

async function state(pageId) {
  return {
    page: pageId
      ? await app.prisma.wikiPage.findUnique({ where: { id: pageId } })
      : null,
    spaces: await app.prisma.wikiSpace.count({
      where: { workspaceId: workspace.id },
    }),
    pages: await app.prisma.wikiPage.count({
      where: { space: { workspaceId: workspace.id } },
    }),
    projects: await app.prisma.project.count({
      where: { workspaceId: workspace.id },
    }),
    versions: await app.prisma.wikiPageVersion.count({
      where: { page: { spaceId: space.id } },
    }),
    comments: await app.prisma.wikiPageComment.count({
      where: { page: { spaceId: space.id } },
    }),
    activity: await app.prisma.activityLog.count({
      where: { task: { project: { workspaceId: workspace.id } } },
    }),
    notifications: await app.prisma.notification.count({
      where: { userId: { in: [...keys.keys()] } },
    }),
    events: events.length,
    files: await storedFiles(),
    admission: backupConcurrency.usage,
  };
}

async function storedFiles(dir = storageDir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await storedFiles(file)));
    else
      files.push({
        path: path.relative(storageDir, file),
        hash: crypto
          .createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function upload(action, file) {
  const boundary = `wiki-json-${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.json"\r\nContent-Type: application/json\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request(
    "POST",
    `/workspaces/${workspace.id}/backup/${action}`,
    payload,
    actor,
    { "content-type": `multipart/form-data; boundary=${boundary}` },
  );
}

async function refused(method, url, data, field, pageId) {
  const before = await state(pageId);
  const response = await request(method, url, data);
  const after = await state(pageId);
  if (process.env.WIKI_JSON_OBSERVE)
    console.log(
      JSON.stringify({
        method,
        url,
        status: response.status,
        changed: Object.keys(before).filter(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        ),
      }),
    );
  assert.deepEqual(
    after,
    before,
    `Refused write must have no effects: HTTP ${response.status}`,
  );
  const body = result(response, 400);
  assert.ok(
    body.details?.some((detail) => detail.field === field),
    response.body,
  );
  assert.doesNotMatch(
    response.body,
    /Prisma|recursion|SELECT|INSERT|UPDATE|stack|leaf|secret/,
  );
}

for (const kind of ["object", "array", "mixed"]) {
  test(`content at 123 ${kind} levels can be created, saved, snapshotted and restored`, async () => {
    const content = nested(123, kind);
    const page = await create(content);
    assert.deepEqual(page.content, content);
    const version = result(
      await request("POST", `/wiki/pages/${page.id}/versions`, {
        name: "At limit",
      }),
      201,
    ).data;
    const saved = result(
      await request("PATCH", `/wiki/pages/${page.id}`, {
        content,
        expectedRevision: 0,
      }),
      200,
    ).data;
    assert.equal(saved.revision, 1);
    const restored = result(
      await request("POST", `/wiki/versions/${version.id}/restore`),
      200,
    ).data;
    assert.equal(restored.revision, 2);
    assert.deepEqual(restored.content, content);
  });

  test(`create refuses content at 124 ${kind} levels without side effects`, async () => {
    await refused(
      "POST",
      `/wiki/spaces/${space.id}/pages`,
      { title: "Rejected", content: nested(124, kind) },
      "content",
    );
  });
  test(`update refuses content at 124 ${kind} levels without side effects`, async () => {
    const page = await create();
    await refused(
      "PATCH",
      `/wiki/pages/${page.id}`,
      { content: nested(124, kind), expectedRevision: 0 },
      "content",
      page.id,
    );
  });
}

test("comment selections at 121 levels fit the backup envelope; 122 levels are refused", async () => {
  const page = await create();
  for (const kind of ["object", "array", "mixed"]) {
    for (const field of ["selectionStart", "selectionEnd"]) {
      const value = nested(121, kind);
      const comment = result(
        await request("POST", `/wiki/pages/${page.id}/comments`, {
          body: "Selection",
          highlightId: "h",
          [field]: value,
        }),
        201,
      ).data;
      assert.deepEqual(comment[field], value);
      await refused(
        "POST",
        `/wiki/pages/${page.id}/comments`,
        {
          body: `Mention @[${other.id}]`,
          highlightId: "h",
          [field]: nested(122, kind),
        },
        field,
        page.id,
      );
    }
  }
});

test("unrepresentable string values and member names have field errors before writes", async (t) => {
  const page = await create();
  for (const bad of ["secret\u0000", "secret\ud800", "secret\udfff"]) {
    for (const value of [{ nested: [bad] }, { nested: { [bad]: "value" } }]) {
      await t.test(`create ${JSON.stringify(value)}`, () =>
        refused(
          "POST",
          `/wiki/spaces/${space.id}/pages`,
          { title: "Invalid", content: value },
          "content",
        ),
      );
      await t.test(`update ${JSON.stringify(value)}`, () =>
        refused(
          "PATCH",
          `/wiki/pages/${page.id}`,
          { content: value },
          "content",
          page.id,
        ),
      );
      for (const field of ["selectionStart", "selectionEnd"])
        await t.test(`${field} ${JSON.stringify(value)}`, () =>
          refused(
            "POST",
            `/wiki/pages/${page.id}/comments`,
            {
              body: "Invalid selection",
              highlightId: "h",
              [field]: value,
            },
            field,
            page.id,
          ),
        );
    }
  }
});

test("JSON numeric overflow is refused before create, update or comment writes", async () => {
  const page = await create();
  await refused(
    "POST",
    `/wiki/spaces/${space.id}/pages`,
    Buffer.from('{"title":"Overflow","content":1e400}'),
    "content",
  );
  await refused(
    "PATCH",
    `/wiki/pages/${page.id}`,
    Buffer.from('{"content":-1e400}'),
    "content",
    page.id,
  );
  await refused(
    "POST",
    `/wiki/pages/${page.id}/comments`,
    Buffer.from('{"body":"Overflow","highlightId":"h","selectionStart":1e400}'),
    "selectionStart",
    page.id,
  );
});

test("editor JSON, Unicode, primitives, null and omitted fields keep their meaning", async () => {
  const content = [
    {
      id: "block",
      type: "paragraph",
      props: { color: "default" },
      content: [{ type: "text", text: "Zoë 李 😀\n\t\u000b", styles: {} }],
      children: [],
    },
  ];
  for (const value of [content, "", 0, false, true, "😀", null]) {
    const page = await create(value);
    assert.deepEqual(page.content, value);
  }
  const page = await create("kept");
  const omitted = result(
    await request("PATCH", `/wiki/pages/${page.id}`, { title: "Renamed" }),
    200,
  ).data;
  assert.equal(omitted.content, "kept");
  const cleared = result(
    await request("PATCH", `/wiki/pages/${page.id}`, { content: null }),
    200,
  ).data;
  assert.equal(cleared.content, null);
  if (process.env.WIKI_JSON_OBSERVE)
    console.log(
      JSON.stringify({
        nullUpdate: await app.prisma
          .$queryRaw`SELECT "content" IS NULL AS "sqlNull", "content" = 'null'::jsonb AS "jsonNull" FROM "WikiPage" WHERE "id" = ${page.id}`,
      }),
    );
  for (const value of [null, 0, false, "", "😀", { anchor: 1 }]) {
    const comment = result(
      await request("POST", `/wiki/pages/${page.id}/comments`, {
        body: "Comment",
        highlightId: "h",
        selectionStart: value,
        selectionEnd: value,
      }),
      201,
    ).data;
    assert.deepEqual(comment.selectionStart, value);
    assert.deepEqual(comment.selectionEnd, value);
  }
});

test("practical wide arrays and objects round trip without an editor format restriction", async () => {
  const content = {
    rows: Array.from({ length: 5_000 }, (_, i) => ({
      text: `Row ${i}`,
      count: i,
    })),
    fields: Object.fromEntries(
      Array.from({ length: 5_000 }, (_, i) => [`field${i}`, i]),
    ),
  };
  const page = await create(content);
  assert.deepEqual(page.content, content);
  assert.deepEqual(
    result(await request("GET", `/wiki/pages/${page.id}`), 200).data.content,
    content,
  );
});

test("unsupported legacy page snapshots refuse without changing history", async () => {
  const page = await create();
  const legacy = JSON.stringify(nested(124));
  await app.prisma
    .$executeRaw`UPDATE "WikiPage" SET "content" = ${legacy}::jsonb WHERE "id" = ${page.id}`;
  await refused(
    "POST",
    `/wiki/pages/${page.id}/versions`,
    { name: "Legacy" },
    "content",
    page.id,
  );
  assert.deepEqual(
    result(await request("GET", `/wiki/pages/${page.id}`), 200).data.content,
    nested(124),
  );
});

test("replacing a legacy page refuses if the preceding snapshot cannot be stored", async () => {
  const page = await create();
  const legacy = JSON.stringify(nested(124));
  await app.prisma
    .$executeRaw`UPDATE "WikiPage" SET "content" = ${legacy}::jsonb WHERE "id" = ${page.id}`;
  await refused(
    "PATCH",
    `/wiki/pages/${page.id}`,
    { content: "new", expectedRevision: 0 },
    "content",
    page.id,
  );
});

test("unsupported historical restore refuses without changing the page or history", async () => {
  const legacy = JSON.stringify(nested(124));
  const ordinary = await create("current");
  const version = result(
    await request("POST", `/wiki/pages/${ordinary.id}/versions`, {
      name: "Historical",
    }),
    201,
  ).data;
  await app.prisma
    .$executeRaw`UPDATE "WikiPageVersion" SET "content" = ${legacy}::jsonb WHERE "id" = ${version.id}`;
  await refused(
    "POST",
    `/wiki/versions/${version.id}/restore`,
    undefined,
    "content",
    ordinary.id,
  );
  assert.deepEqual(
    result(await request("GET", `/wiki/versions/${version.id}`), 200).data
      .content,
    nested(124),
  );
});

test("body edits and a throttled metadata edit retain legacy JSON they do not write", async () => {
  const page = await create("initial");
  result(
    await request("PATCH", `/wiki/pages/${page.id}`, { title: "First" }),
    200,
  );
  const legacy = JSON.stringify(nested(124));
  await app.prisma
    .$executeRaw`UPDATE "WikiPage" SET "content" = ${legacy}::jsonb WHERE "id" = ${page.id}`;
  const before = await state(page.id);
  const edited = result(
    await request("PATCH", `/wiki/pages/${page.id}`, { title: "Second" }),
    200,
  ).data;
  assert.deepEqual(edited.content, nested(124));
  assert.equal(edited.revision, 2);
  assert.equal((await state(page.id)).versions, before.versions);

  const comment = result(
    await request("POST", `/wiki/pages/${page.id}/comments`, {
      body: "Before",
      highlightId: "h",
      selectionStart: 1,
    }),
    201,
  ).data;
  const selection = JSON.stringify(nested(122));
  await app.prisma
    .$executeRaw`UPDATE "WikiPageComment" SET "selectionStart" = ${selection}::jsonb WHERE "id" = ${comment.id}`;
  const updated = result(
    await request("PATCH", `/wiki/comments/${comment.id}`, { body: "After" }),
    200,
  ).data;
  assert.equal(updated.body, "After");
  assert.deepEqual(updated.selectionStart, nested(122));
});

for (const kind of ["SQL", "JSON"])
  test(`${kind} null snapshot restores empty content and records the replaced content atomically`, async () => {
    const page = await create(null);
    const [created] = await app.prisma
      .$queryRaw`SELECT "content" IS NULL AS "sqlNull" FROM "WikiPage" WHERE "id" = ${page.id}`;
    assert.equal(created.sqlNull, true);
    const version = result(
      await request("POST", `/wiki/pages/${page.id}/versions`, {
        name: "Null",
      }),
      201,
    ).data;
    assert.equal(version.content, null);
    if (kind === "JSON")
      await app.prisma
        .$executeRaw`UPDATE "WikiPageVersion" SET "content" = 'null'::jsonb WHERE "id" = ${version.id}`;
    const [storedVersion] = await app.prisma
      .$queryRaw`SELECT "content" IS NULL AS "sqlNull" FROM "WikiPageVersion" WHERE "id" = ${version.id}`;
    assert.equal(storedVersion.sqlNull, kind === "SQL");
    result(
      await request("PATCH", `/wiki/pages/${page.id}`, { content: "current" }),
      200,
    );
    const before = await state(page.id);
    const restored = result(
      await request("POST", `/wiki/versions/${version.id}/restore`),
      200,
    ).data;
    if (process.env.WIKI_JSON_OBSERVE)
      console.log(
        JSON.stringify({
          nullSnapshot: kind,
          restoredContent: restored.content,
          revision: restored.revision,
        }),
      );
    assert.equal(restored.content, null);
    assert.equal(restored.revision, 2);
    const after = await state(page.id);
    assert.equal(after.versions, before.versions + 1);
    assert.equal(after.events, before.events + 1);
    assert.deepEqual(events.at(-1)[2].page.content, null);
    assert.equal(events.at(-1)[2].page.revision, 2);
    const replaced = await app.prisma.wikiPageVersion.findFirst({
      where: { pageId: page.id },
      orderBy: { versionNumber: "desc" },
    });
    assert.equal(replaced.content, "current");
    result(
      await request("PATCH", `/wiki/pages/${page.id}`, {
        content: "stale",
        expectedRevision: 1,
      }),
      409,
    );
    assert.deepEqual(await state(page.id), after);
    result(
      await request("POST", `/wiki/pages/${page.id}/lock`, undefined, other),
      200,
    );
    const locked = await state(page.id);
    assert.equal(
      result(await request("POST", `/wiki/versions/${version.id}/restore`), 409)
        .code,
      "EDIT_LOCKED",
    );
    assert.deepEqual(await state(page.id), locked);
  });

test("valid content still respects revisions, edit locks and workspace access", async () => {
  const page = await create();
  result(
    await request("PATCH", `/wiki/pages/${page.id}`, {
      content: "updated",
      expectedRevision: 0,
    }),
    200,
  );
  const before = await state(page.id);
  assert.equal(
    result(
      await request("PATCH", `/wiki/pages/${page.id}`, {
        content: "stale",
        expectedRevision: 0,
      }),
      409,
    ).code,
    "REVISION_CONFLICT",
  );
  result(
    await request("POST", `/wiki/pages/${page.id}/lock`, undefined, other),
    200,
  );
  const locked = await state(page.id);
  assert.equal(
    result(
      await request("PATCH", `/wiki/pages/${page.id}`, {
        content: "locked",
        expectedRevision: 1,
      }),
      409,
    ).code,
    "EDIT_LOCKED",
  );
  assert.deepEqual(await state(page.id), locked);
  const foreign = await request(
    "PATCH",
    `/wiki/pages/${page.id}`,
    { content: "foreign" },
    outsider,
  );
  assert.ok([403, 404].includes(foreign.status), foreign.body);
  assert.deepEqual((await state(page.id)).page, before.page);
});

test("the backup depth meter agrees with both field limits and their next levels", () => {
  const backup = (content, selectionStart) => ({
    metadata: {
      version: "1.1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      sourceWorkspace: { name: "s", slug: "s" },
      userRefs: [],
    },
    wikiSpaces: [
      {
        space: { name: "s" },
        pages: [
          {
            _originalId: "p",
            title: "p",
            position: 0,
            content,
            comments: [
              {
                _originalId: "c",
                body: "c",
                highlightId: "h",
                selectionStart,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    ],
  });
  const accepted = Buffer.from(
    JSON.stringify(backup(nested(123), nested(121))),
  );
  assert.equal(inspectBackupJson(accepted).depth, 128);
  const parsed = parseBackupJson(accepted);
  validateBackup(parsed);
  assert.deepEqual(parsed.wikiSpaces[0].pages[0].content, nested(123));
  for (const file of [backup(nested(124), null), backup(null, nested(122))])
    assert.throws(() => inspectBackupJson(Buffer.from(JSON.stringify(file))), {
      statusCode: 400,
    });
});

test("backup numeric overflow is refused in preview and restore before rows, files or events", async (t) => {
  const date = "2026-01-01T00:00:00.000Z";
  const base = () => ({
    metadata: {
      version: "1.1",
      exportedAt: date,
      sourceWorkspace: { name: "s", slug: "s" },
      userRefs: [],
    },
    wikiSpaces: [
      {
        space: { name: "Finite" },
        pages: [
          {
            _originalId: "p",
            title: "Finite page",
            position: 0,
            content: { number: 1 },
            comments: [
              {
                _originalId: "c",
                body: "c",
                highlightId: "h",
                selectionStart: 1,
                selectionEnd: 2,
                createdAt: date,
              },
            ],
          },
        ],
      },
    ],
  });
  const good = Buffer.from(JSON.stringify(base()));
  const files = [];
  for (const field of ["content", "selectionStart", "selectionEnd"]) {
    const file = base();
    const page = file.wikiSpaces[0].pages[0];
    if (field === "content") page.content = { number: "overflow_marker" };
    else page.comments[0][field] = "overflow_marker";
    files.push([
      field,
      Buffer.from(JSON.stringify(file).replace('"overflow_marker"', "1e999")),
    ]);
  }
  const activity = base();
  activity.projects = [
    {
      project: { name: "Activity" },
      statuses: [
        { _originalId: "s", name: "Open", position: 0, isCompletion: false },
      ],
      tasks: [
        {
          _originalId: "t",
          title: "t",
          priority: "NONE",
          position: 0,
          statusRef: "s",
          activityLogs: [
            {
              _originalId: "a",
              action: "created",
              details: { number: "overflow_marker" },
              createdAt: date,
            },
          ],
        },
      ],
    },
  ];
  files.push([
    "activity details",
    Buffer.from(
      JSON.stringify(activity).replace('"overflow_marker"', "-1e999"),
    ),
  ]);
  for (const [field, file] of files) {
    for (const action of ["preview", "restore"]) {
      await t.test(`${field} ${action}`, async () => {
        const before = await state();
        const response = await upload(action, file);
        const after = await state();
        if (process.env.WIKI_JSON_OBSERVE)
          console.log(
            JSON.stringify({
              backupField: field,
              action,
              status: response.status,
              changed: Object.keys(before).filter(
                (key) =>
                  JSON.stringify(before[key]) !== JSON.stringify(after[key]),
              ),
            }),
          );
        assert.deepEqual(
          after,
          before,
          `Backup must have no effects: HTTP ${response.status}`,
        );
        const body = result(response, 400);
        assert.match(
          body.message,
          /^Invalid backup file: .*non-finite number$/,
        );
        assert.doesNotMatch(
          response.body,
          /overflow_marker|Prisma|Infinity|1e999/,
        );
        result(await upload("preview", good), 200);
        assert.deepEqual(
          await state(),
          before,
          "admission is released and valid preview has no effects",
        );
      });
    }
  }
});
