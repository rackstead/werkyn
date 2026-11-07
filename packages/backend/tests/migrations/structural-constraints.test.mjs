// Explicit upgrade gate for the R35 constraint migrations
// (docs/remediation/r35-constraints.md); not part of the normal integration DB
// lifecycle. Requires an empty disposable database: it builds a legacy and then
// a clean fixture in its current schema (the URL's `schema`, CI runs it in
// public and in another schema), recreating that schema in between and at the
// end.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { test } from "node:test";

if (!process.env.MIGRATION_TEST_DATABASE_URL)
  throw new Error("Set MIGRATION_TEST_DATABASE_URL to an empty disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.MIGRATION_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
const { PrismaClient } = await import("@prisma/client");
const { findReferenceIntegrityIssues } = await import("../../src/scripts/reference-integrity-report.ts");

const FIRST = "20261106120000_reference_integrity_constraints";
const SECOND = "20261106120100_value_range_constraints";
const PINNED = "20261106140000_pin_trigger_search_path";
const TRIGGER_FUNCTIONS = [
  "check_custom_field_value_project", "check_task_dependency_project", "check_task_label_project", "refuse_project_change",
];
const BLOB_TRIGGER_FUNCTIONS = [
  "delete_entity_attachments", "enqueue_attachment_blob_cleanup", "enqueue_file_blob_cleanup",
];
const prismaRoot = new URL("../../prisma/", import.meta.url);
const packagePath = createRequire(import.meta.url).resolve("prisma/package.json");
const cli = path.resolve(path.dirname(packagePath), JSON.parse(await readFile(packagePath, "utf8")).bin.prisma);
const run = promisify(execFile);

async function prismaCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], {
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output: stdout + stderr };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** A copy of the Prisma directory holding only the migrations before `before`. */
async function migrationsBefore(root, before) {
  const dir = await mkdtemp(path.join(root, "prisma-"));
  await cp(new URL("schema.prisma", prismaRoot), path.join(dir, "schema.prisma"));
  await cp(new URL("migrations/", prismaRoot), path.join(dir, "migrations"), { recursive: true });
  for (const name of await readdir(path.join(dir, "migrations")))
    if (/^\d/.test(name) && name >= before) await rm(path.join(dir, "migrations", name), { recursive: true });
  return path.join(dir, "schema.prisma");
}
const currentSchema = new URL("schema.prisma", prismaRoot).pathname;

// ─── Fixture rows (raw SQL, as stored by an older version) ──────────────

const sql = (db, text) => db.$executeRawUnsafe(text);
const list = (values) => values.map((v) => `(${v})`).join(",\n");

/** Rows that satisfy every rule: two workspaces, three projects. */
async function insertCleanRows(db) {
  await sql(db, `INSERT INTO "User" (id, email, "displayName", "updatedAt") VALUES
    ('u1', 'u1@example.test', 'One', now()), ('u2', 'u2@example.test', 'Two', now())`);
  await sql(db, `INSERT INTO "Workspace" (id, name, slug, "updatedAt") VALUES
    ('w1', 'W1', 'w1', now()), ('w2', 'W2', 'w2', now())`);
  await sql(db, `INSERT INTO "WorkspaceMember" (id, "userId", "workspaceId", role) VALUES
    ('wm1', 'u1', 'w1', 'ADMIN'), ('wm2', 'u1', 'w2', 'ADMIN'), ('wm3', 'u2', 'w1', 'MEMBER')`);
  await sql(db, `INSERT INTO "Project" (id, "workspaceId", name, "updatedAt") VALUES
    ('p1', 'w1', 'P1', now()), ('p2', 'w1', 'P2', now()), ('p3', 'w2', 'P3', now())`);
  await sql(db, `INSERT INTO "StatusColumn" (id, "projectId", name, position) VALUES
    ('s1', 'p1', 'To do', 0), ('s1b', 'p1', 'Done', 1), ('s2', 'p2', 'To do', 0), ('s3', 'p3', 'To do', 0)`);
  await sql(db, `INSERT INTO "Label" (id, "projectId", name) VALUES ('l1', 'p1', 'L1'), ('l2', 'p2', 'L2')`);
  await sql(db, `INSERT INTO "CustomField" (id, "projectId", name, type, position, "updatedAt") VALUES
    ('f1', 'p1', 'F1', 'TEXT', 0, now()), ('f2', 'p2', 'F2', 'TEXT', 0, now())`);
  await sql(db, `INSERT INTO "Task" (id, "projectId", "statusId", title, position, "updatedAt") VALUES
    ('t1', 'p1', 's1', 'T1', 0, now()), ('t2', 'p1', 's1', 'T2', 1, now()),
    ('t3', 'p2', 's2', 'T3', 0, now()), ('t4', 'p3', 's3', 'T4', 0, now())`);
  await sql(db, `INSERT INTO "TaskLabel" (id, "taskId", "labelId") VALUES ('tl1', 't1', 'l1'), ('tl3', 't3', 'l2')`);
  await sql(db, `INSERT INTO "CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('v1', 't1', 'f1', '"text"'), ('v3', 't3', 'f2', '"x"')`);
  await sql(db, `INSERT INTO "TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('d1', 't1', 't2')`);
  await sql(db, `INSERT INTO "Subtask" (id, "taskId", title, position, "updatedAt") VALUES ('st1', 't1', 'S1', 0, now())`);
  await sql(db, `INSERT INTO "TaskTemplate" (id, "projectId", name, title, "dueOffset", "updatedAt") VALUES
    ('tt1', 'p1', 'TT1', 'TT1', 0, now()), ('tt2', 'p2', 'TT2', 'TT2', 3650, now()), ('tt3', 'p1', 'TT3', 'TT3', NULL, now())`);
  await sql(db, `INSERT INTO "RecurringTaskConfig" (id, "projectId", "templateId", frequency, "dayOfWeek", "dayOfMonth", "startDate", "nextRunDate", "updatedAt") VALUES
    ('rc1', 'p1', 'tt1', 'DAILY', NULL, NULL, '2026-01-01', '2026-01-02', now()),
    ('rc2', 'p1', 'tt1', 'WEEKLY', 6, NULL, '2026-01-01', '2026-01-03', now()),
    ('rc3', 'p2', 'tt2', 'MONTHLY', NULL, 31, '2026-01-01', '2026-01-31', now())`);
  await sql(db, `INSERT INTO "TimeEntry" (id, "workspaceId", "userId", "taskId", "projectId", date, hours, "updatedAt") VALUES
    ('e1', 'w1', 'u1', 't1', 'p1', '2026-01-01', 0.01, now()),
    ('e2', 'w1', 'u1', NULL, 'p2', '2026-01-01', 24, now()),
    ('e3', 'w1', 'u2', 't3', 'p2', '2026-01-01', 1.5, now()),
    ('e4', 'w2', 'u1', 't4', 'p3', '2026-01-01', 2, now()),
    ('e5', 'w1', 'u1', NULL, NULL, '2026-01-01', 3, now())`);
  await sql(db, `INSERT INTO "UserRate" (id, "workspaceId", "userId", rate, "effectiveFrom", "updatedAt") VALUES
    ('r1', 'w1', 'u1', 0, '2026-01-01', now()), ('r2', 'w1', 'u1', 1000000000, '2026-02-01', now())`);
  await sql(db, `INSERT INTO "WikiSpace" (id, "workspaceId", name, slug, position, "updatedAt") VALUES ('ws1', 'w1', 'WS1', 'ws1', 0, now())`);
  await sql(db, `INSERT INTO "WikiPage" (id, "spaceId", title, position, "createdById", "updatedAt") VALUES ('wp1', 'ws1', 'WP1', 0, 'u1', now())`);
}

const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`);

/** Rows breaking each rule of the first migration, by rule: [table, ids]. */
async function insertReferenceViolations(db) {
  const wrongStatus = ids("bad-task-", 12);
  await sql(db, `INSERT INTO "Task" (id, "projectId", "statusId", title, position, "updatedAt") VALUES
    ${list(wrongStatus.map((id, i) => `'${id}', 'p1', 's2', 'Wrong column', ${i}, now()`))}`);
  await sql(db, `INSERT INTO "RecurringTaskConfig" (id, "projectId", "templateId", frequency, "startDate", "nextRunDate", "updatedAt") VALUES
    ('bad-rc', 'p1', 'tt2', 'DAILY', '2026-01-01', '2026-01-02', now())`);
  await sql(db, `INSERT INTO "TimeEntry" (id, "workspaceId", "userId", "taskId", "projectId", date, hours, "updatedAt") VALUES
    ('bad-e-ws', 'w2', 'u1', NULL, 'p1', '2026-01-01', 1, now()),
    ('bad-e-task', 'w1', 'u1', 't3', 'p1', '2026-01-01', 1, now())`);
  await sql(db, `INSERT INTO "TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES
    ('bad-d-cross', 't1', 't3'), ('bad-d-self', 't2', 't2')`);
  await sql(db, `INSERT INTO "TaskLabel" (id, "taskId", "labelId") VALUES ('bad-tl', 't1', 'l2')`);
  await sql(db, `INSERT INTO "CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('bad-v', 't1', 'f2', '"y"')`);
  return {
    task_status_project: ["Task", wrongStatus],
    recurring_template_project: ["RecurringTaskConfig", ["bad-rc"]],
    time_entry_workspace: ["TimeEntry", ["bad-e-ws"]],
    time_entry_task_project: ["TimeEntry", ["bad-e-task"]],
    task_dependency_project: ["TaskDependency", ["bad-d-cross", "bad-d-self"]],
    task_label_project: ["TaskLabel", ["bad-tl"]],
    custom_field_value_project: ["CustomFieldValue", ["bad-v"]],
  };
}

async function repairReferenceViolations(db, found) {
  for (const [table, rows] of Object.values(found))
    await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = ANY($1::text[])`, rows);
}

/** Rows breaking each rule of the second migration: [rule, table, ids]. */
async function insertValueViolations(db) {
  await sql(db, `INSERT INTO "TimeEntry" (id, "workspaceId", "userId", date, hours, "updatedAt") VALUES
    ('bad-h-zero', 'w1', 'u1', '2026-01-01', 0, now()), ('bad-h-big', 'w1', 'u1', '2026-01-01', 24.5, now()),
    ('bad-h-nan', 'w1', 'u1', '2026-01-01', 'NaN', now()), ('bad-h-inf', 'w1', 'u1', '2026-01-01', '-Infinity', now())`);
  await sql(db, `INSERT INTO "UserRate" (id, "workspaceId", "userId", rate, "effectiveFrom", "updatedAt") VALUES
    ('bad-rate-neg', 'w1', 'u2', -1, '2026-01-01', now()), ('bad-rate-inf', 'w1', 'u2', 'Infinity', '2026-02-01', now()),
    ('bad-rate-nan', 'w1', 'u2', 'NaN', '2026-03-01', now()), ('legacy-rate-big', 'w1', 'u2', 1e308, '2026-04-01', now())`);
  await sql(db, `INSERT INTO "TaskTemplate" (id, "projectId", name, title, "dueOffset", "updatedAt") VALUES
    ('bad-tt-neg', 'p1', 'B1', 'B1', -1, now()), ('bad-tt-big', 'p1', 'B2', 'B2', 3651, now())`);
  await sql(db, `INSERT INTO "RecurringTaskConfig" (id, "projectId", "templateId", frequency, "dayOfWeek", "dayOfMonth", "startDate", "nextRunDate", "updatedAt") VALUES
    ('bad-rc-dow', 'p1', 'tt1', 'WEEKLY', 7, NULL, '2026-01-01', '2026-01-02', now()),
    ('bad-rc-dom', 'p1', 'tt1', 'MONTHLY', NULL, 0, '2026-01-01', '2026-01-02', now()),
    ('bad-rc-weekly', 'p1', 'tt1', 'BIWEEKLY', NULL, NULL, '2026-01-01', '2026-01-02', now()),
    ('bad-rc-monthly', 'p1', 'tt1', 'MONTHLY', 3, NULL, '2026-01-01', '2026-01-02', now())`);
  await sql(db, `INSERT INTO "Task" (id, "projectId", "statusId", title, position, "updatedAt") VALUES ('bad-pos-task', 'p1', 's1', 'N', -1, now())`);
  await sql(db, `INSERT INTO "StatusColumn" (id, "projectId", name, position) VALUES ('bad-pos-status', 'p1', 'N', -2)`);
  await sql(db, `INSERT INTO "CustomField" (id, "projectId", name, type, position, "updatedAt") VALUES ('bad-pos-field', 'p1', 'N', 'TEXT', -1, now())`);
  await sql(db, `INSERT INTO "Subtask" (id, "taskId", title, position, "updatedAt") VALUES ('bad-pos-subtask', 't1', 'N', -1, now())`);
  await sql(db, `INSERT INTO "WikiSpace" (id, "workspaceId", name, slug, position, "updatedAt") VALUES ('bad-pos-space', 'w1', 'N', 'n', -1, now())`);
  await sql(db, `INSERT INTO "WikiPage" (id, "spaceId", title, position, "createdById", "updatedAt") VALUES ('bad-pos-page', 'ws1', 'N', -1, 'u1', now())`);
  return [
    ["time_entry_hours", "TimeEntry", ["bad-h-zero", "bad-h-big", "bad-h-nan", "bad-h-inf"]],
    ["user_rate_finite", "UserRate", ["bad-rate-neg", "bad-rate-inf", "bad-rate-nan"]],
    ["template_due_offset", "TaskTemplate", ["bad-tt-neg", "bad-tt-big"]],
    ["recurring_day_range", "RecurringTaskConfig", ["bad-rc-dow", "bad-rc-dom"]],
    ["recurring_required_day", "RecurringTaskConfig", ["bad-rc-weekly", "bad-rc-monthly"]],
    ["position_non_negative", "Task", ["bad-pos-task"]],
    ["position_non_negative", "StatusColumn", ["bad-pos-status"]],
    ["position_non_negative", "CustomField", ["bad-pos-field"]],
    ["position_non_negative", "Subtask", ["bad-pos-subtask"]],
    ["position_non_negative", "WikiSpace", ["bad-pos-space"]],
    ["position_non_negative", "WikiPage", ["bad-pos-page"]],
  ];
}

// ─── Snapshots ─────────────────────────────────────────

const TABLES = [
  "User", "Workspace", "WorkspaceMember", "Project", "StatusColumn", "Label", "CustomField", "Task",
  "TaskLabel", "CustomFieldValue", "TaskDependency", "Subtask", "TaskTemplate", "RecurringTaskConfig",
  "TimeEntry", "UserRate", "WikiSpace", "WikiPage",
];

/** Every row of the fixture tables, as text. */
async function dataSnapshot(db) {
  const snapshot = {};
  for (const table of TABLES)
    snapshot[table] = (
      await db.$queryRawUnsafe(`SELECT t::text AS row FROM "${table}" t ORDER BY id`)
    ).map((r) => r.row);
  return snapshot;
}

/** Constraints, indexes, triggers and functions of the fixture schema. */
async function catalogSnapshot(db) {
  const [constraints, indexes, triggers, functions] = await Promise.all([
    db.$queryRaw`SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(c.oid) AS def,
        convalidated AS valid, condeferrable AS deferrable, condeferred AS deferred
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = current_schema() ORDER BY 1, 2`,
    db.$queryRaw`SELECT tablename AS tbl, indexname AS name, indexdef AS def FROM pg_indexes
      WHERE schemaname = current_schema() ORDER BY 1, 2`,
    db.$queryRaw`SELECT tgrelid::regclass::text AS tbl, tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND NOT t.tgisinternal ORDER BY 1, 2`,
    db.$queryRaw`SELECT proname AS name, proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = current_schema() ORDER BY 1`,
  ]);
  return { constraints, indexes, triggers, functions };
}

/**
 * The rows of the migrations this gate covers: the two R35 migrations and the
 * search path pin after them. Later migrations are not part of it.
 */
async function migrationRows(db) {
  return db.$queryRaw`SELECT migration_name AS name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
    FROM _prisma_migrations WHERE migration_name IN (${FIRST}, ${SECOND}, ${PINNED}) ORDER BY started_at`;
}

/** The precheck names the rule, its row count and its first ten IDs. */
function assertReported(output, key, table, rows) {
  const line = output.split("\n").find((l) => l.includes(`${key}: ${rows.length} row(s) in "${table}"`));
  assert(line, `${key} on ${table} is reported with its count:\n${output}`);
  const first = [...rows].sort().slice(0, 10).join(", ");
  assert(line.trimEnd().endsWith(`first IDs: ${first}`), `${key} lists the first ten IDs ${first}:\n${line}`);
}

// ─── Raw writes after the migration ─────────────────────────

/**
 * Runs `text` and returns the database error it fails with. Deferred keys are
 * checked right after the statement (SET CONSTRAINTS ALL IMMEDIATE) so their
 * error carries its SQLSTATE; commit-time refusal is tested separately.
 * `setup` statements run first in the same transaction, which is rolled back
 * if the database accepts `text`.
 */
async function refusal(db, text, setup = []) {
  const accepted = new Error("accepted");
  try {
    await db.$transaction(async (tx) => {
      for (const statement of setup) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(text);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      throw accepted;
    });
  } catch (error) {
    if (error !== accepted) return { code: error.meta?.code, message: String(error.meta?.message ?? error.message) };
  }
  assert.fail(`expected the database to refuse: ${text}`);
}
async function assertRefused(db, text, code, constraint, setup = []) {
  const error = await refusal(db, text, setup);
  assert.equal(error.code, code, `${text}\n${error.message}`);
  assert(error.message.includes(`"${constraint}"`), `${text} names ${constraint}: ${error.message}`);
}
/** Runs `text` in a transaction that is rolled back, so the fixture stays as it was. */
async function assertAccepted(db, text, setup = []) {
  const rollback = new Error("rollback");
  await assert.rejects(
    db.$transaction(async (tx) => {
      for (const statement of setup) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(text);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      throw rollback;
    }),
    (error) => error === rollback,
    text,
  );
}

test("R35 constraint migrations refuse legacy rows with a report and apply to clean data", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "r35-constraints-"));
  const db = new PrismaClient();
  // One database, the legacy fixture first and then the clean one.
  const legacy = db;
  const clean = db;
  let started = false;
  /** Drops everything in the current schema (the fixture's own database). */
  const reset = async () => {
    const [{ schema }] = await db.$queryRaw`SELECT current_schema() AS schema`;
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$disconnect();
  };
  try {
    const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
    assert.equal(tables.length, 0, "requires an empty DB; never clears existing tables");
    started = true;
    const previous = await migrationsBefore(temporary, FIRST);
    const withFirstOnly = await migrationsBefore(temporary, SECOND);
    const deployed = await prismaCli(["migrate", "deploy", "--schema", previous]);
    assert(deployed.ok, deployed.output);

    let referenceRows, valueRows;
    /** The database error part of Prisma's output, for the test log. */
    const databaseError = (output) => output.slice(output.indexOf("Database error:"), output.indexOf("DbError {")).trim();

    /**
     * Each migration runs as one transaction (Prisma sends the file as one
     * multi-statement query; LOCK TABLE outside a transaction block would
     * fail). An object that already exists under the name the migration's
     * last statement creates makes that statement fail after every other
     * one has run; nothing they created may remain.
     */
    async function assertLateFailureLeavesNothing(st, { schema, migration, conflict, drop, failure }) {
      for (const statement of conflict) await legacy.$executeRawUnsafe(statement);
      const catalog = await catalogSnapshot(legacy);
      const data = await dataSnapshot(legacy);
      const deploy = await prismaCli(["migrate", "deploy", "--schema", schema]);
      assert.equal(deploy.ok, false, deploy.output);
      st.diagnostic(databaseError(deploy.output));
      assert.match(deploy.output, new RegExp(`Migration name: ${migration}`));
      assert.match(deploy.output, failure);
      assert.deepEqual(await catalogSnapshot(legacy), catalog);
      assert.deepEqual(await dataSnapshot(legacy), data);
      for (const statement of drop) await legacy.$executeRawUnsafe(statement);
      assert((await prismaCli(["migrate", "resolve", "--rolled-back", migration, "--schema", currentSchema])).ok);
    }

    await t.test("legacy fixture: the first migration refuses, reports every rule and changes nothing", async (st) => {
      await insertCleanRows(legacy);
      referenceRows = await insertReferenceViolations(legacy);
      valueRows = await insertValueViolations(legacy);
      const catalog = await catalogSnapshot(legacy);
      const data = await dataSnapshot(legacy);

      const deploy = await prismaCli(["migrate", "deploy", "--schema", currentSchema]);
      assert.equal(deploy.ok, false, deploy.output);
      assert.match(deploy.output, /P3018/);
      st.diagnostic(databaseError(deploy.output));
      assert.match(deploy.output, new RegExp(`Migration ${FIRST} changed nothing: 7 rule\\(s\\) have stored rows`));
      for (const [key, [table, rows]] of Object.entries(referenceRows)) assertReported(deploy.output, key, table, rows);
      // Twelve rows, of which the first ten are listed.
      assert.match(deploy.output, /task_status_project: 12 row\(s\)/);
      assert(!deploy.output.includes("bad-task-10"), "only the first ten IDs are listed");
      for (const text of [
        "dist/scripts/reference-integrity-report.js",
        "docs/remediation/dat-005.md",
        `prisma migrate resolve --rolled-back ${FIRST}`,
      ])
        assert(deploy.output.includes(text), `${text} in\n${deploy.output}`);
      // The second migration never ran.
      assert(!deploy.output.includes("time_entry_hours"), deploy.output);

      assert.deepEqual(await catalogSnapshot(legacy), catalog);
      assert.deepEqual(await dataSnapshot(legacy), data);
      assert.deepEqual(await migrationRows(legacy), [{ name: FIRST, finished: false, rolledBack: false }]);
      // Later deploys stop until the failure is resolved.
      const again = await prismaCli(["migrate", "deploy", "--schema", currentSchema]);
      assert.equal(again.ok, false);
      assert.match(again.output, /P3009/);
    });

    await t.test("the report the message names lists the same rows", async () => {
      const { issues } = await findReferenceIntegrityIssues(legacy, { sampleLimit: 100 });
      for (const [key, [, rows]] of Object.entries(referenceRows)) {
        const issue = issues.find((i) => i.key === key);
        const reported = issue.samples.map((s) => s.id);
        for (const id of rows) assert(reported.includes(id), `${key} report lists ${id}`);
      }
    });

    await t.test("with those rows repaired, a failure at the first migration's last statement leaves nothing behind", async (st) => {
      await repairReferenceViolations(legacy, referenceRows);
      assert((await prismaCli(["migrate", "resolve", "--rolled-back", FIRST, "--schema", currentSchema])).ok);
      // Its indexes, keys, check, functions and other triggers come first.
      await assertLateFailureLeavesNothing(st, {
        schema: withFirstOnly,
        migration: FIRST,
        conflict: [
          `CREATE FUNCTION r35_fixture_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`,
          `CREATE TRIGGER "CustomField_projectId_fixed" AFTER UPDATE ON "CustomField" FOR EACH ROW EXECUTE FUNCTION r35_fixture_noop()`,
        ],
        drop: [`DROP TRIGGER "CustomField_projectId_fixed" ON "CustomField"`, "DROP FUNCTION r35_fixture_noop()"],
        failure: /trigger "CustomField_projectId_fixed" for relation "CustomField" already exists/,
      });
    });

    await t.test("then the first applies and the second refuses and reports", async (st) => {
      const first = await prismaCli(["migrate", "deploy", "--schema", withFirstOnly]);
      assert(first.ok, first.output);
      const catalog = await catalogSnapshot(legacy);
      const data = await dataSnapshot(legacy);

      const deploy = await prismaCli(["migrate", "deploy", "--schema", currentSchema]);
      assert.equal(deploy.ok, false, deploy.output);
      assert.match(deploy.output, /P3018/);
      st.diagnostic(databaseError(deploy.output));
      assert.match(deploy.output, new RegExp(`Migration ${SECOND} changed nothing: 11 rule\\(s\\) have stored rows`));
      for (const [key, table, rows] of valueRows) assertReported(deploy.output, key, table, rows);
      for (const text of ["docs/remediation/r35-constraints.md", `prisma migrate resolve --rolled-back ${SECOND}`])
        assert(deploy.output.includes(text), `${text} in\n${deploy.output}`);
      assert.deepEqual(await catalogSnapshot(legacy), catalog);
      assert.deepEqual(await dataSnapshot(legacy), data);
    });

    await t.test("with every row repaired, a failure at the second migration's last statement leaves nothing behind", async (st) => {
      for (const [, table, rows] of valueRows)
        await legacy.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id = ANY($1::text[])`, rows);
      assert((await prismaCli(["migrate", "resolve", "--rolled-back", SECOND, "--schema", currentSchema])).ok);
      // Its fifteen other checks come first.
      await assertLateFailureLeavesNothing(st, {
        schema: currentSchema,
        migration: SECOND,
        conflict: [`ALTER TABLE "WikiPage" ADD CONSTRAINT "WikiPage_position_non_negative" CHECK ("position" >= 0)`],
        drop: [`ALTER TABLE "WikiPage" DROP CONSTRAINT "WikiPage_position_non_negative"`],
        failure: /constraint "WikiPage_position_non_negative" for relation "WikiPage" already exists/,
      });
    });

    await t.test("then both migrations apply, and the search path pin after them", async () => {
      const deploy = await prismaCli(["migrate", "deploy", "--schema", currentSchema]);
      assert(deploy.ok, deploy.output);
      const rows = await migrationRows(legacy);
      assert.deepEqual(rows.filter((r) => r.finished).map((r) => r.name), [FIRST, SECOND, PINNED]);
    });

    let cleanCatalog, legacyCatalog;
    await t.test("a clean populated fixture migrates with its rows unchanged", async () => {
      legacyCatalog = await catalogSnapshot(legacy);
      await reset();
      const deployed = await prismaCli(["migrate", "deploy", "--schema", previous]);
      assert(deployed.ok, deployed.output);
      await insertCleanRows(clean);
      const data = await dataSnapshot(clean);
      const deploy = await prismaCli(["migrate", "deploy", "--schema", currentSchema]);
      assert(deploy.ok, deploy.output);
      assert.deepEqual(await dataSnapshot(clean), data);
      assert.match((await prismaCli(["migrate", "deploy", "--schema", currentSchema])).output, /No pending migrations/);
      // Prisma sees no drift between the migrated database and schema.prisma.
      const drift = await prismaCli([
        "migrate", "diff", "--from-url", process.env.DATABASE_URL, "--to-schema-datamodel", currentSchema, "--exit-code",
      ]);
      assert(drift.ok, drift.output);

      cleanCatalog = await catalogSnapshot(clean);
      const constraint = (name) => cleanCatalog.constraints.find((c) => c.name === name);
      for (const name of [
        "Task_statusId_projectId_fkey", "RecurringTaskConfig_templateId_projectId_fkey",
        "TimeEntry_taskId_projectId_fkey", "TimeEntry_projectId_workspaceId_fkey", "TaskDependency_not_self",
        "TimeEntry_hours_range", "UserRate_rate_finite", "TaskTemplate_dueOffset_range",
        "RecurringTaskConfig_dayOfWeek_range", "RecurringTaskConfig_dayOfMonth_range", "RecurringTaskConfig_required_day",
        "Task_position_non_negative", "StatusColumn_position_non_negative", "CustomField_position_non_negative",
        "Subtask_position_non_negative", "WikiSpace_position_non_negative", "WikiPage_position_non_negative",
      ])
        assert.equal(constraint(name)?.valid, true, `${name} exists and is validated`);
      // The single-column keys stay, with their delete behavior.
      assert.match(constraint("Task_statusId_fkey").def, /ON DELETE RESTRICT/);
      assert.match(constraint("RecurringTaskConfig_templateId_fkey").def, /ON DELETE CASCADE/);
      for (const name of ["TimeEntry_taskId_projectId_fkey", "TimeEntry_projectId_workspaceId_fkey"])
        assert.deepEqual([constraint(name).deferrable, constraint(name).deferred], [true, true], name);
      assert.match(constraint("Task_statusId_projectId_fkey").def, /ON UPDATE RESTRICT ON DELETE RESTRICT/);
      assert.match(constraint("RecurringTaskConfig_templateId_projectId_fkey").def, /ON UPDATE RESTRICT ON DELETE CASCADE/);
      assert.deepEqual(
        cleanCatalog.triggers.filter((tr) => /same_project|projectId_fixed/.test(tr.name)).map((tr) => tr.name).sort(),
        ["CustomFieldValue_same_project_insert", "CustomFieldValue_same_project_update", "CustomField_projectId_fixed",
          "Label_projectId_fixed", "TaskDependency_same_project_insert", "TaskDependency_same_project_update",
          "TaskLabel_same_project_insert", "TaskLabel_same_project_update", "Task_projectId_fixed"],
      );
      // Both upgrade paths produced the same schema.
      assert.deepEqual(legacyCatalog, cleanCatalog);
    });

    await t.test("after the migration the database refuses every rule's violation through raw SQL", async () => {
      const FK = "23503";
      const CHECK = "23514";
      const time = (id, ws, task, project, hours = "1") =>
        `INSERT INTO "TimeEntry" (id, "workspaceId", "userId", "taskId", "projectId", date, hours, "updatedAt")
         VALUES ('${id}', '${ws}', 'u1', ${task ? `'${task}'` : "NULL"}, ${project ? `'${project}'` : "NULL"}, '2026-01-01', ${hours}, now())`;
      const schedule = (id, template, frequency, dow, dom, project = "p1") =>
        `INSERT INTO "RecurringTaskConfig" (id, "projectId", "templateId", frequency, "dayOfWeek", "dayOfMonth", "startDate", "nextRunDate", "updatedAt")
         VALUES ('${id}', '${project}', '${template}', '${frequency}', ${dow}, ${dom}, '2026-01-01', '2026-01-02', now())`;
      const cases = [
        // task_status_project
        [`INSERT INTO "Task" (id, "projectId", "statusId", title, "updatedAt") VALUES ('x', 'p1', 's2', 'X', now())`, FK, "Task_statusId_projectId_fkey"],
        [`UPDATE "Task" SET "statusId" = 's3' WHERE id = 't1'`, FK, "Task_statusId_projectId_fkey"],
        [`UPDATE "StatusColumn" SET "projectId" = 'p2' WHERE id = 's1'`, FK, "Task_statusId_projectId_fkey"],
        // recurring_template_project
        [schedule("x", "tt2", "DAILY", "NULL", "NULL"), FK, "RecurringTaskConfig_templateId_projectId_fkey"],
        [`UPDATE "RecurringTaskConfig" SET "templateId" = 'tt2' WHERE id = 'rc1'`, FK, "RecurringTaskConfig_templateId_projectId_fkey"],
        [`UPDATE "TaskTemplate" SET "projectId" = 'p2' WHERE id = 'tt1'`, FK, "RecurringTaskConfig_templateId_projectId_fkey"],
        // time_entry_workspace and time_entry_task_project (checked at commit)
        [time("x", "w2", null, "p1"), FK, "TimeEntry_projectId_workspaceId_fkey"],
        [time("x", "w1", "t3", "p1"), FK, "TimeEntry_taskId_projectId_fkey"],
        [`UPDATE "TimeEntry" SET "projectId" = 'p2' WHERE id = 'e1'`, FK, "TimeEntry_taskId_projectId_fkey"],
        [`UPDATE "TimeEntry" SET "workspaceId" = 'w2' WHERE id = 'e2'`, FK, "TimeEntry_projectId_workspaceId_fkey"],
        [`UPDATE "Project" SET "workspaceId" = 'w2' WHERE id = 'p2'`, FK, "TimeEntry_projectId_workspaceId_fkey"],
        // task_dependency_project
        [`INSERT INTO "TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('x', 't1', 't1')`, CHECK, "TaskDependency_not_self"],
        [`INSERT INTO "TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('x', 't1', 't3')`, CHECK, "TaskDependency_same_project"],
        [`UPDATE "TaskDependency" SET "blockingTaskId" = 't4' WHERE id = 'd1'`, CHECK, "TaskDependency_same_project"],
        // task_label_project
        [`INSERT INTO "TaskLabel" (id, "taskId", "labelId") VALUES ('x', 't2', 'l2')`, CHECK, "TaskLabel_same_project"],
        [`UPDATE "TaskLabel" SET "labelId" = 'l2' WHERE id = 'tl1'`, CHECK, "TaskLabel_same_project"],
        // custom_field_value_project
        [`INSERT INTO "CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('x', 't2', 'f2', '"z"')`, CHECK, "CustomFieldValue_same_project"],
        [`UPDATE "CustomFieldValue" SET "taskId" = 't3' WHERE id = 'v1'`, CHECK, "CustomFieldValue_same_project"],
        // fixed projects
        [`UPDATE "Task" SET "projectId" = 'p2', "statusId" = 's2' WHERE id = 't2'`, CHECK, "Task_projectId_fixed"],
        [`UPDATE "Label" SET "projectId" = 'p2', name = 'moved' WHERE id = 'l1'`, CHECK, "Label_projectId_fixed"],
        [`UPDATE "CustomField" SET "projectId" = 'p2', name = 'moved' WHERE id = 'f1'`, CHECK, "CustomField_projectId_fixed"],
        // value ranges
        [time("x", "w1", null, null, "0"), CHECK, "TimeEntry_hours_range"],
        [time("x", "w1", null, null, "24.01"), CHECK, "TimeEntry_hours_range"],
        [time("x", "w1", null, null, "'NaN'"), CHECK, "TimeEntry_hours_range"],
        [time("x", "w1", null, null, "'Infinity'"), CHECK, "TimeEntry_hours_range"],
        [`UPDATE "UserRate" SET rate = -0.01 WHERE id = 'r1'`, CHECK, "UserRate_rate_finite"],
        [`UPDATE "UserRate" SET rate = 'NaN' WHERE id = 'r1'`, CHECK, "UserRate_rate_finite"],
        [`UPDATE "UserRate" SET rate = 'Infinity' WHERE id = 'r1'`, CHECK, "UserRate_rate_finite"],
        [`UPDATE "UserRate" SET rate = '-Infinity' WHERE id = 'r1'`, CHECK, "UserRate_rate_finite"],
        [`UPDATE "TaskTemplate" SET "dueOffset" = -1 WHERE id = 'tt1'`, CHECK, "TaskTemplate_dueOffset_range"],
        [`UPDATE "TaskTemplate" SET "dueOffset" = 3651 WHERE id = 'tt1'`, CHECK, "TaskTemplate_dueOffset_range"],
        [schedule("x", "tt1", "WEEKLY", "7", "NULL"), CHECK, "RecurringTaskConfig_dayOfWeek_range"],
        [schedule("x", "tt1", "WEEKLY", "-1", "NULL"), CHECK, "RecurringTaskConfig_dayOfWeek_range"],
        [schedule("x", "tt1", "MONTHLY", "NULL", "0"), CHECK, "RecurringTaskConfig_dayOfMonth_range"],
        [schedule("x", "tt1", "MONTHLY", "NULL", "32"), CHECK, "RecurringTaskConfig_dayOfMonth_range"],
        [schedule("x", "tt1", "WEEKLY", "NULL", "NULL"), CHECK, "RecurringTaskConfig_required_day"],
        [schedule("x", "tt1", "BIWEEKLY", "NULL", "5"), CHECK, "RecurringTaskConfig_required_day"],
        [schedule("x", "tt1", "MONTHLY", "2", "NULL"), CHECK, "RecurringTaskConfig_required_day"],
        [`UPDATE "RecurringTaskConfig" SET frequency = 'MONTHLY' WHERE id = 'rc2'`, CHECK, "RecurringTaskConfig_required_day"],
        [`UPDATE "RecurringTaskConfig" SET "dayOfWeek" = NULL WHERE id = 'rc2'`, CHECK, "RecurringTaskConfig_required_day"],
        ...["Task", "StatusColumn", "CustomField", "Subtask", "WikiSpace", "WikiPage"].map((table) => [
          `UPDATE "${table}" SET position = -1 WHERE id = (SELECT min(id) FROM "${table}")`, CHECK, `${table}_position_non_negative`,
        ]),
      ];
      for (const [text, code, constraint] of cases) await assertRefused(clean, text, code, constraint);
      // Without SET CONSTRAINTS the deferred keys refuse the write when it commits.
      for (const [text, constraint] of [
        [time("x-commit", "w2", null, "p1"), "TimeEntry_projectId_workspaceId_fkey"],
        [time("x-commit", "w1", "t3", "p1"), "TimeEntry_taskId_projectId_fkey"],
      ]) {
        await assert.rejects(clean.$executeRawUnsafe(text), (error) => String(error.message).includes(constraint), text);
        await assert.rejects(
          clean.$transaction([clean.$executeRawUnsafe(text)]),
          (error) => String(error.message).includes(constraint),
          text,
        );
        assert.equal(await clean.timeEntry.count({ where: { id: "x-commit" } }), 0);
      }
      // The refusals left the fixture as it was.
      assert.deepEqual(await catalogSnapshot(clean), cleanCatalog);

      for (const text of [
        `INSERT INTO "Task" (id, "projectId", "statusId", title, "updatedAt") VALUES ('x', 'p1', 's1b', 'X', now())`,
        `UPDATE "Task" SET "statusId" = 's1b', title = 'renamed' WHERE id = 't1'`,
        `UPDATE "Task" SET "projectId" = 'p1' WHERE id = 't1'`,
        schedule("x", "tt3", "MONTHLY", "NULL", "1"),
        schedule("x", "tt1", "WEEKLY", "0", "NULL"),
        `UPDATE "RecurringTaskConfig" SET frequency = 'DAILY', "dayOfWeek" = NULL WHERE id = 'rc2'`,
        time("x", "w1", "t2", "p1", "24"),
        time("x", "w1", "t2", null, "0.01"),
        time("x", "w2", null, "p3"),
        `INSERT INTO "TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('x', 't2', 't1')`,
        `INSERT INTO "TaskLabel" (id, "taskId", "labelId") VALUES ('x', 't2', 'l1')`,
        `INSERT INTO "CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('x', 't2', 'f1', '"ok"')`,
        `UPDATE "Label" SET name = 'renamed' WHERE id = 'l1'`,
        `UPDATE "TaskTemplate" SET "dueOffset" = NULL WHERE id = 'tt1'`,
        `UPDATE "UserRate" SET rate = 1000000000 WHERE id = 'r1'`,
        // Finite rates above today's write cap stay readable as legacy rows.
        `UPDATE "UserRate" SET rate = 1e308 WHERE id = 'r1'`,
      ])
        await assertAccepted(clean, text);
    });

    await t.test("the trigger functions read their own schema's tables whatever the caller's search path", async (st) => {
      const [{ quoted }] = await clean.$queryRaw`SELECT quote_ident(current_schema()) AS quoted`;
      st.diagnostic(`schema ${quoted}`);
      await st.test("each runs with the schema the migrations ran in, then pg_temp", () => {
        assert.deepEqual(
          cleanCatalog.functions.filter((f) => TRIGGER_FUNCTIONS.includes(f.name)),
          TRIGGER_FUNCTIONS.map((name) => ({ name, config: [`search_path=${quoted}, pg_temp`] })),
        );
      });
      const situations = {
        // Temporary tables come first on a default search path; empty ones
        // named like the tables the checks read must not hide a violation.
        "temporary tables named Task, Label and CustomField": ["Task", "Label", "CustomField"].map(
          (name) => `CREATE TEMP TABLE "${name}" (id text, "projectId" text) ON COMMIT DROP`),
        // pg_restore writes with an empty search path.
        "an empty search path, as pg_restore sets": ["SELECT set_config('search_path', '', true)"],
      };
      for (const [situation, setup] of Object.entries(situations))
        await st.test(situation, async () => {
          for (const [text, constraint] of [
            [`INSERT INTO ${quoted}."TaskLabel" (id, "taskId", "labelId") VALUES ('x', 't2', 'l2')`, "TaskLabel_same_project"],
            [`INSERT INTO ${quoted}."CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('x', 't2', 'f2', '"z"')`, "CustomFieldValue_same_project"],
            [`INSERT INTO ${quoted}."TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('x', 't1', 't3')`, "TaskDependency_same_project"],
            [`UPDATE ${quoted}."Label" SET "projectId" = 'p2' WHERE id = 'l1'`, "Label_projectId_fixed"],
          ])
            await assertRefused(clean, text, "23514", constraint, setup);
          for (const text of [
            `INSERT INTO ${quoted}."TaskLabel" (id, "taskId", "labelId") VALUES ('x', 't2', 'l1')`,
            `INSERT INTO ${quoted}."CustomFieldValue" (id, "taskId", "fieldId", value) VALUES ('x', 't2', 'f1', '"ok"')`,
            `INSERT INTO ${quoted}."TaskDependency" (id, "blockedTaskId", "blockingTaskId") VALUES ('x', 't2', 't1')`,
          ])
            await assertAccepted(clean, text, setup);
        });
      assert.deepEqual(await catalogSnapshot(clean), cleanCatalog);
    });

    await t.test("the project guard resolves concatenation in pg_catalog", async () => {
      const [{ quoted }] = await clean.$queryRaw`SELECT quote_ident(current_schema()) AS quoted`;
      await assertRefused(clean, `UPDATE ${quoted}."Label" SET "projectId" = 'p2' WHERE id = 'l1'`,
        "23514", "Label_projectId_fixed", [
          `CREATE FUNCTION ${quoted}.fixture_name_concat(name, text) RETURNS text LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'schema name concatenation operator was called'; END; $$`,
          `CREATE OPERATOR ${quoted}.|| (FUNCTION = ${quoted}.fixture_name_concat, LEFTARG = name, RIGHTARG = text)`,
        ]);
    });

    await t.test("blob cleanup reads its own schema and uses the built-in text comparison", async (st) => {
      const [{ quoted }] = await clean.$queryRaw`SELECT quote_ident(current_schema()) AS quoted`;
      await st.test("cleanup functions run in the migration schema, then pg_temp", () => {
        assert.deepEqual(
          cleanCatalog.functions.filter((f) => BLOB_TRIGGER_FUNCTIONS.includes(f.name)),
          BLOB_TRIGGER_FUNCTIONS.map((name) => ({ name, config: [`search_path=${quoted}, pg_temp`] })),
        );
      });
      const situations = {
        "temporary Attachment and BlobCleanup tables": [
          `CREATE TEMP TABLE "Attachment" (LIKE ${quoted}."Attachment" INCLUDING ALL) ON COMMIT DROP`,
          `CREATE TEMP TABLE "BlobCleanup" (LIKE ${quoted}."BlobCleanup" INCLUDING ALL) ON COMMIT DROP`,
        ],
        "an empty caller search path": ["SELECT set_config('search_path', '', true)"],
        "a schema operator with an exact varchar/text match": [
          `CREATE FUNCTION ${quoted}.fixture_varchar_equal(varchar, text) RETURNS boolean LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'schema varchar comparison operator was called'; END; $$`,
          `CREATE OPERATOR ${quoted}.= (FUNCTION = ${quoted}.fixture_varchar_equal, LEFTARG = varchar, RIGHTARG = text)`,
        ],
      };
      for (const [situation, setup] of Object.entries(situations))
        await st.test(situation, async () => {
          const rollback = new Error("rollback cleanup fixture");
          await assert.rejects(clean.$transaction(async (tx) => {
            await sql(tx, `INSERT INTO ${quoted}."Task" (id, "projectId", "statusId", title, "updatedAt")
              VALUES ('cleanup-task', 'p1', 's1', 'Cleanup', now())`);
            await sql(tx, `INSERT INTO ${quoted}."Comment" (id, "taskId", "authorId", body, "updatedAt")
              VALUES ('cleanup-comment', 'cleanup-task', 'u1', 'Cleanup', now())`);
            await sql(tx, `INSERT INTO ${quoted}."File" (id, "workspaceId", name, "uploadedById", "storagePath", "thumbnailPath", "updatedAt")
              VALUES ('cleanup-file', 'w1', 'Cleanup', 'u1', 'cleanup/original', 'cleanup/thumbnail', now())`);
            await sql(tx, `INSERT INTO ${quoted}."Attachment" (id, "workspaceId", "entityType", "entityId", name, "mimeType", "storagePath", "uploadedById", "fileId") VALUES
              ('cleanup-task-a', 'w1', 'task', 'cleanup-task', 'Task', 'text/plain', 'cleanup/task', 'u1', NULL),
              ('cleanup-comment-a', 'w1', 'comment', 'cleanup-comment', 'Comment', 'text/plain', 'cleanup/comment', 'u1', NULL),
              ('cleanup-linked-a', 'w1', 'task', 'cleanup-task', 'Linked', 'text/plain', 'cleanup/original', 'u1', 'cleanup-file')`);
            for (const statement of setup) await sql(tx, statement);

            await sql(tx, `DELETE FROM ${quoted}."Task" WHERE id = 'cleanup-task'`);
            assert.equal((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${quoted}."Attachment"
              WHERE id IN ('cleanup-task-a', 'cleanup-comment-a', 'cleanup-linked-a')`))[0].n, 0);
            const queued = async () => (await tx.$queryRawUnsafe(`SELECT "storagePath" FROM ${quoted}."BlobCleanup"
              WHERE "storagePath" LIKE 'cleanup/%' ORDER BY "storagePath"`)).map((r) => r.storagePath);
            // Linked attachments leave their live Drive file's blob alone.
            assert.deepEqual(await queued(), ["cleanup/comment", "cleanup/task"]);
            await sql(tx, `UPDATE ${quoted}."File" SET "storagePath" = 'cleanup/replacement' WHERE id = 'cleanup-file'`);
            await sql(tx, `DELETE FROM ${quoted}."File" WHERE id = 'cleanup-file'`);
            assert.deepEqual(await queued(), [
              "cleanup/comment", "cleanup/original", "cleanup/replacement", "cleanup/task", "cleanup/thumbnail",
            ]);
            if (situation.startsWith("temporary")) {
              assert.equal((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_temp."BlobCleanup"`))[0].n, 0);
            }
            throw rollback;
          }), (error) => error === rollback);
        });
      assert.deepEqual(await catalogSnapshot(clean), cleanCatalog);
    });

    await t.test("deleting tasks, projects, columns, templates and workspaces keeps its behavior", async () => {
      // A task with time entries: the entry keeps its project and loses the task.
      await clean.task.delete({ where: { id: "t1" } });
      assert.deepEqual(
        await clean.timeEntry.findUnique({ where: { id: "e1" }, select: { taskId: true, projectId: true } }),
        { taskId: null, projectId: "p1" },
      );
      // A project with tasks and time entries: both references are cleared.
      await clean.project.delete({ where: { id: "p2" } });
      for (const id of ["e2", "e3"])
        assert.deepEqual(
          await clean.timeEntry.findUnique({ where: { id }, select: { taskId: true, projectId: true } }),
          { taskId: null, projectId: null },
        );
      // A column that still has tasks cannot be deleted; a template takes its schedules along.
      await assert.rejects(clean.statusColumn.delete({ where: { id: "s1" } }), (error) => error.code === "P2003");
      await clean.taskTemplate.delete({ where: { id: "tt1" } });
      assert.equal(await clean.recurringTaskConfig.count({ where: { templateId: "tt1" } }), 0);
      // A whole workspace.
      await clean.workspace.delete({ where: { id: "w2" } });
      assert.equal(await clean.timeEntry.count({ where: { id: "e4" } }), 0);
      await clean.workspace.delete({ where: { id: "w1" } });
      assert.equal(await clean.task.count(), 0);
    });
  } finally {
    if (started) await reset();
    await db.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
