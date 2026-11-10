import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { getUnreadCount, listNotifications } from "../../src/modules/notifications/notifications.service.ts";
import { recordQueries } from "./support/query-events.mjs";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const prisma = new PrismaClient({ log: [{ level: "query", emit: "event" }] });
const suffix = crypto.randomBytes(4).toString("hex");
const userId = `nvu-${suffix}`;
const workspaceId = `nvw-${suffix}`;
const readProject = `nvpr-${suffix}`;
const hideProject = `nvph-${suffix}`;
const indexName = `Task_nvplan_${suffix}_idx`;

function taskScans(explained) {
  const found = [];
  const walk = (node) => {
    if (node["Relation Name"] === "Task") {
      found.push({
        node: node["Node Type"],
        index: node["Index Name"] ?? null,
        rows: node["Actual Rows"],
        loops: node["Actual Loops"],
      });
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(explained[0]["QUERY PLAN"][0].Plan);
  return found;
}

function assertPointLookup(scans, label) {
  assert.ok(scans.length > 0, `${label} did not look up a task`);
  for (const scan of scans) {
    assert.notEqual(scan.node, "Seq Scan", `${label} scanned Task`);
    assert.ok(scan.rows <= 1, `${label} read ${scan.rows} task rows in one pass`);
    assert.ok(scan.loops < 100, `${label} repeated the task lookup ${scan.loops} times`);
  }
}

before(async () => {
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexName}"`);
  await prisma.$executeRaw`
    INSERT INTO "User" (id, email, "displayName", "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${`nv-${suffix}@example.test`}, 'Visibility plan', true, now(), now())`;
  await prisma.$executeRaw`
    INSERT INTO "Workspace" (id, name, slug, "createdAt", "updatedAt")
    VALUES (${workspaceId}, 'Visibility plan', ${`nv-${suffix}`}, now(), now())`;
  await prisma.$executeRaw`
    INSERT INTO "WorkspaceMember" (id, "userId", "workspaceId", role)
    VALUES (${`nvm-${suffix}`}, ${userId}, ${workspaceId}, 'MEMBER'::"WorkspaceRole")`;
  await prisma.$executeRaw`
    INSERT INTO "Project" (id, "workspaceId", name, "createdAt", "updatedAt") VALUES
      (${readProject}, ${workspaceId}, 'Readable', now(), now()),
      (${hideProject}, ${workspaceId}, 'Hidden', now(), now())`;
  await prisma.$executeRaw`
    INSERT INTO "ProjectMember" (id, "projectId", "userId")
    VALUES (${`nvpm-${suffix}`}, ${readProject}, ${userId})`;
  await prisma.$executeRaw`
    INSERT INTO "StatusColumn" (id, "projectId", name, position) VALUES
      (${`nvsr-${suffix}`}, ${readProject}, 'Open', 0),
      (${`nvsh-${suffix}`}, ${hideProject}, 'Open', 0)`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Task" (id, "projectId", "statusId", title, position, "createdAt", "updatedAt")
    SELECT '${readProject}-' || lpad(i::text, 5, '0'), '${readProject}', 'nvsr-${suffix}', 'Readable', i, now(), now()
    FROM generate_series(1, 8000) AS i`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Task" (id, "projectId", "statusId", title, position, "createdAt", "updatedAt")
    SELECT '${hideProject}-' || lpad(i::text, 5, '0'), '${hideProject}', 'nvsh-${suffix}', 'Hidden', i, now(), now()
    FROM generate_series(1, 2000) AS i`);
  // Large enough that, without the OFFSET 0 fence, the page plan scans Task
  // instead of looking up the ids on the page.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Notification" (id, "userId", type, title, read, data, "createdAt")
    SELECT
      'nvb-${suffix}-' || lpad(i::text, 5, '0'),
      '${userId}',
      'TASK_ASSIGNED',
      'Bulk',
      false,
      CASE i % 4
        WHEN 0 THEN jsonb_build_object(
          'taskId', '${readProject}-' || lpad(((i % 8000) + 1)::text, 5, '0'),
          'projectId', '${readProject}')
        WHEN 1 THEN jsonb_build_object(
          'taskId', '${hideProject}-' || lpad(((i % 2000) + 1)::text, 5, '0'),
          'projectId', '${hideProject}')
        WHEN 2 THEN jsonb_build_object(
          'taskId', '${readProject}-' || lpad(((i % 8000) + 1)::text, 5, '0'))
        ELSE jsonb_build_object('projectId', '${readProject}')
      END,
      timestamp '2024-01-01 00:00:00+00' + (i || ' seconds')::interval
    FROM generate_series(1, 60000) AS i`);
  const samples = [
    ["s8", false, { taskId: `${readProject}-00001`, projectId: readProject }],
    ["s7", false, { taskId: `${hideProject}-00001`, projectId: hideProject }],
    ["s6", false, { taskId: `${readProject}-00002` }],
    ["s5", false, { taskId: "missing-task", projectId: readProject }],
    ["s4", false, { taskId: `${readProject}-00003`, projectId: hideProject }],
    ["s3", false, { projectId: readProject }],
    ["s2", false, {}],
    ["s1", true, { taskId: `${readProject}-00004`, projectId: readProject }],
  ];
  for (let i = 0; i < samples.length; i++) {
    const [id, read, data] = samples[i];
    await prisma.notification.create({
      data: {
        id: `nvs-${suffix}-${id}`,
        userId,
        type: "TASK_ASSIGNED",
        title: id,
        read,
        data,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, samples.length - i)),
      },
    });
  }
  await prisma.$executeRawUnsafe('ANALYZE "Task", "Notification", "Project", "ProjectMember", "WorkspaceMember"');
});

after(async () => {
  try {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexName}"`);
    // Status columns restrict deletes while tasks still reference them, so the
    // tasks go before the workspace cascade.
    await prisma.task.deleteMany({ where: { projectId: { in: [readProject, hideProject] } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  } finally {
    await prisma.$disconnect();
  }
});

async function oraclePage(cursorId) {
  const cursor = cursorId
    ? await prisma.$queryRaw`SELECT "createdAt", id FROM "Notification" WHERE id = ${cursorId}`
    : null;
  const rows = cursor
    ? await prisma.$queryRaw`
        SELECT n.id FROM "Notification" n
        WHERE n."userId" = ${userId}
          AND (n."createdAt", n.id) < (${cursor[0].createdAt}, ${cursor[0].id})
          AND (n.data->>'projectId' IS NULL OR n.data->>'projectId' = ${readProject})
          AND (
            n.data->>'taskId' IS NULL
            OR EXISTS (
              SELECT 1 FROM "Task" t
              WHERE t.id = n.data->>'taskId' AND t."projectId" = ${readProject}
            )
          )
        ORDER BY n."createdAt" DESC, n.id DESC
        LIMIT 20`
    : await prisma.$queryRaw`
        SELECT n.id FROM "Notification" n
        WHERE n."userId" = ${userId}
          AND (n.data->>'projectId' IS NULL OR n.data->>'projectId' = ${readProject})
          AND (
            n.data->>'taskId' IS NULL
            OR EXISTS (
              SELECT 1 FROM "Task" t
              WHERE t.id = n.data->>'taskId' AND t."projectId" = ${readProject}
            )
          )
        ORDER BY n."createdAt" DESC, n.id DESC
        LIMIT 20`;
  return rows.map((row) => row.id);
}

test("notification pages stay on per-row task lookups when a project task-id index exists", { timeout: 180_000 }, async () => {
  const expectedFirst = await oraclePage();
  const [{ count: expectedUnread }] = await prisma.$queryRaw`
    SELECT count(*)::int AS count FROM "Notification" n
    WHERE n."userId" = ${userId} AND n.read = false
      AND (n.data->>'projectId' IS NULL OR n.data->>'projectId' = ${readProject})
      AND (
        n.data->>'taskId' IS NULL
        OR EXISTS (
          SELECT 1 FROM "Task" t
          WHERE t.id = n.data->>'taskId' AND t."projectId" = ${readProject}
        )
      )`;
  assert.equal(expectedFirst[0], `nvs-${suffix}-s8`);
  assert.ok(!expectedFirst.includes(`nvs-${suffix}-s7`));
  assert.ok(!expectedFirst.includes(`nvs-${suffix}-s5`));
  assert.ok(!expectedFirst.includes(`nvs-${suffix}-s4`));

  async function measure(label) {
    const listed = await recordQueries(prisma, (db) => listNotifications(db, userId, { limit: 20 }));
    const event = listed.events.find((entry) => entry.query.includes('FROM "Notification"'));
    assert.ok(event, "list query");
    const ids = listed.result.data.map((row) => row.id);
    const second = await listNotifications(prisma, userId, { limit: 20, cursor: listed.result.nextCursor });
    const unread = await getUnreadCount(prisma, userId);
    assert.deepEqual(ids, expectedFirst, label);
    assert.deepEqual(second.data.map((row) => row.id), await oraclePage(ids.at(-1)), label);
    assert.equal(unread, expectedUnread, label);
    assert.match(event.query, /OFFSET 0/);
    const params = JSON.parse(event.params);
    const fenced = taskScans(await prisma.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${event.query}`,
      ...params,
    ));
    console.log(JSON.stringify({ label, ids, unread, fenced }));
    assertPointLookup(fenced, label);
    return { ids, unread };
  }

  const without = await measure("without index");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX "${indexName}" ON "Task" ("projectId", "archived", "position", "createdAt", "id")`,
  );
  await prisma.$executeRawUnsafe('ANALYZE "Task"');
  const withIndex = await measure("with index");
  assert.deepEqual(withIndex.ids, without.ids);
  assert.equal(withIndex.unread, without.unread);
});
