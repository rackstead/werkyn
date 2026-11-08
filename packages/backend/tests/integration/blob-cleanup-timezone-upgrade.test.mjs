import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to disposable PostgreSQL");
const { PrismaClient } = await import("@prisma/client");
const run = promisify(execFile);
const migration = await readFile(new URL("../../prisma/migrations/20261108120000_blob_cleanup_absolute_timestamps/migration.sql", import.meta.url), "utf8");
const packagePath = createRequire(import.meta.url).resolve("prisma/package.json");
const cli = path.resolve(path.dirname(packagePath), JSON.parse(await readFile(packagePath, "utf8")).bin.prisma);
const schemaFile = new URL("../../prisma/schema.prisma", import.meta.url).pathname;

async function legacyFixture(body, { missingCreatedAt = false } = {}) {
  const schema = `blob_tz_${crypto.randomBytes(8).toString("hex")}`;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  const control = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  url.searchParams.set("schema", schema);
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "blob-tz-upgrade-"));
  try {
    await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await client.$executeRawUnsafe(`CREATE TABLE "BlobCleanup" (
      "storagePath" TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      ${missingCreatedAt ? "" : ', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP'}
    )`);
    await client.$executeRawUnsafe('CREATE INDEX "BlobCleanup_availableAt_idx" ON "BlobCleanup" ("availableAt")');
    const migrate = async (zone) => {
      // The supported upgrade stops application workers. Discard this
      // fixture's prepared statements before changing their result types.
      await client.$disconnect();
      const file = path.join(temporary, "upgrade.sql");
      await writeFile(file, `SET TIME ZONE '${zone}';\n${migration}`);
      try {
        const result = await run(process.execPath, [cli, "db", "execute", "--schema", schemaFile, "--file", file], {
          env: { ...process.env, DATABASE_URL: url.toString() }, maxBuffer: 4 * 1024 * 1024,
        });
        return { ok: true, output: result.stdout + result.stderr };
      } catch (error) {
        return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };
    await body(client, migrate);
  } finally {
    await client.$disconnect();
    await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await control.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
}

test("populated legacy cleanup timestamps migrate as UTC regardless of the migration session zone", async (t) => {
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Kathmandu"]) {
    await t.test(zone, () => legacyFixture(async (client, migrate) => {
      await client.$executeRawUnsafe(`INSERT INTO "BlobCleanup" ("storagePath", attempts, "lastError", "availableAt", "createdAt") VALUES
        ('legacy-due', 0, NULL, '2026-11-01 01:15:00.123', '2026-10-31 23:30:00.456'),
        ('legacy-lease', 2, 'retained fixture', '2026-11-01 08:15:00.789', '2026-10-31 23:30:00.456'),
        ('legacy-retry', 5, 'retry fixture', '2026-03-08 02:30:00.012', '2026-03-08 01:30:00.345')`);
      const before = await client.blobCleanup.findMany({ orderBy: { storagePath: "asc" } });
      const result = await migrate(zone);
      assert.equal(result.ok, true, result.output);
      assert.deepEqual(await client.blobCleanup.findMany({ orderBy: { storagePath: "asc" } }), before,
        "legacy values keep their explicit UTC interpretation, attempts, errors and paths");
      const columns = await client.$queryRaw`SELECT column_name, data_type, datetime_precision, column_default
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'BlobCleanup'
          AND column_name IN ('availableAt', 'createdAt') ORDER BY column_name`;
      assert.equal(columns.length, 2);
      for (const column of columns) {
        assert.equal(column.data_type, "timestamp with time zone");
        assert.equal(column.datetime_precision, 3);
        assert.equal(column.column_default, "CURRENT_TIMESTAMP");
      }
      const indexes = await client.$queryRaw`SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = 'BlobCleanup_availableAt_idx'`;
      assert.equal(indexes.length, 1);
      assert.match(indexes[0].indexdef, /\("availableAt"\)/);
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
        const [written] = await tx.$queryRaw`INSERT INTO "BlobCleanup" ("storagePath") VALUES ('new-default')
          RETURNING "availableAt" = CURRENT_TIMESTAMP::timestamptz(3) AS "dueNow",
            "createdAt" = CURRENT_TIMESTAMP::timestamptz(3) AS "createdNow"`;
        assert.deepEqual(written, { dueNow: true, createdNow: true });
      });
    }));
  }
});

test("a refused cleanup timestamp migration leaves the legacy column and populated row unchanged", async () => {
  await legacyFixture(async (client, migrate) => {
    await client.$executeRawUnsafe(`INSERT INTO "BlobCleanup" ("storagePath", "availableAt") VALUES ('legacy-row', '2026-11-01 01:15:00.123')`);
    const snapshot = () => client.$queryRaw`SELECT "storagePath", "availableAt"::text AS value,
      pg_typeof("availableAt")::text AS type FROM "BlobCleanup"`;
    const before = await snapshot();
    const result = await migrate("America/Los_Angeles");
    assert.equal(result.ok, false);
    assert.match(result.output, /createdAt/);
    assert.deepEqual(await snapshot(), before);
  }, { missingCreatedAt: true });
});
