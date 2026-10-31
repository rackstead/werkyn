// Explicit upgrade gate; not part of the normal integration DB lifecycle.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { test } from "node:test";

if (!process.env.MIGRATION_TEST_DATABASE_URL)
  throw new Error(
    "Set MIGRATION_TEST_DATABASE_URL to an empty disposable PostgreSQL database",
  );
process.env.DATABASE_URL = process.env.MIGRATION_TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "account-link-upgrade-fixture-jwt-secret";
process.env.COOKIE_SECRET = "account-link-upgrade-fixture-cookie-secret";
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "1";
const { PrismaClient } = await import("@prisma/client");
const { buildApp } = await import("../../src/app.ts");
const { hashToken } = await import("../../src/utils/tokens.ts");
const prismaRoot = new URL("../../prisma/", import.meta.url);
const migration = "20261031120000_hash_account_link_tokens";
const packagePath = createRequire(import.meta.url).resolve("prisma/package.json");
const metadata = JSON.parse(await readFile(packagePath, "utf8"));
const cli = path.resolve(path.dirname(packagePath), metadata.bin.prisma);
const run = promisify(execFile);

test("populated previous-schema upgrade preserves account links and hashes each row once", async (t) => {
  const prisma = new PrismaClient();
  const temporary = await mkdtemp(path.join(tmpdir(), "account-link-upgrade-"));
  const rows = { reset: [], verify: [] };
  const createdAt = new Date("2026-10-01T01:02:03.456Z");
  const liveUntil = new Date(Date.now() + 3600_000);
  const expiredAt = new Date(Date.now() - 3600_000);
  const usedAt = new Date("2026-10-02T01:02:03.456Z");
  let app,
    address = 0;
  async function deploy(schema) {
    return (
      await run(
        process.execPath,
        [cli, "migrate", "deploy", "--schema", schema],
        {
          env: process.env,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
    ).stdout;
  }
  function inject(url, payload) {
    return app.inject({
      method: "POST",
      url,
      payload,
      remoteAddress: `10.48.0.${++address}`,
    });
  }
  try {
    const tables =
      await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
    assert.equal(
      tables.length,
      0,
      "requires an empty DB; never clears existing tables",
    );
    await cp(
      new URL("schema.prisma", prismaRoot),
      path.join(temporary, "schema.prisma"),
    );
    await cp(
      new URL("migrations/", prismaRoot),
      path.join(temporary, "migrations"),
      { recursive: true },
    );
    await rm(path.join(temporary, "migrations", migration), {
      recursive: true,
    });
    assert(
      (await readdir(path.join(temporary, "migrations")))
        .filter((name) => /^\d/.test(name))
        .every((name) => name < migration),
    );
    await deploy(path.join(temporary, "schema.prisma"));

    await t.test(
      "previous schema contains live, used and expired fixtures for two owners",
      async () => {
        for (let owner = 0; owner < 2; owner++) {
          const userId = `account-link-upgrade-user-${owner}`;
          await prisma.user.create({
            data: {
              id: userId,
              email: `upgrade-${owner}@example.test`,
              displayName: "Upgrade fixture",
            },
          });
          const raw = crypto.randomBytes(32).toString("hex");
          // One raw bearer equals another's digest; conversion must not guess
          // from shape or fail on a transient in-place unique-index conflict.
          const tokens = [hashToken(raw), raw, `legacy-UTF8-é-🔑-${owner}`];
          for (let i = 0; i < 3; i++) {
            const token = tokens[i];
            const reset = {
              id: `upgrade-reset-${owner}-${i}`,
              userId,
              token,
              createdAt,
              expiresAt: i === 2 ? expiredAt : liveUntil,
              usedAt: i === 1 ? usedAt : null,
            };
            const verify = {
              id: `upgrade-verify-${owner}-${i}`,
              userId,
              token,
              createdAt,
              expiresAt: i === 2 ? expiredAt : liveUntil,
            };
            rows.reset.push(reset);
            rows.verify.push(verify);
            await prisma.$executeRaw`INSERT INTO "PasswordResetToken" (id, "userId", token, "createdAt", "expiresAt", "usedAt")
            VALUES (${reset.id}, ${userId}, ${token}, ${createdAt}, ${reset.expiresAt}, ${reset.usedAt})`;
            await prisma.$executeRaw`INSERT INTO "EmailVerificationToken" (id, "userId", token, "createdAt", "expiresAt")
            VALUES (${verify.id}, ${userId}, ${token}, ${createdAt}, ${verify.expiresAt})`;
          }
        }
      },
    );
    await deploy(new URL("schema.prisma", prismaRoot).pathname);
    await t.test(
      "backfill retains identities, owners, timestamps, counts and uniqueness and removes raw columns",
      async () => {
        for (const [kind, table] of [
          ["reset", "PasswordResetToken"],
          ["verify", "EmailVerificationToken"],
        ]) {
          const actual = await prisma.$queryRawUnsafe(
            `SELECT * FROM "${table}" ORDER BY id`,
          );
          assert.equal(actual.length, rows[kind].length);
        assert(
          actual.every((row) => !Object.hasOwn(row, "token")),
          "raw bearer columns must be absent",
        );
          for (const { token, ...metadata } of rows[kind])
            assert.deepEqual(
              actual.find((row) => row.id === metadata.id),
              { ...metadata, tokenHash: hashToken(token) },
            );
          const columns =
            await prisma.$queryRaw`SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ${table}`;
          assert.equal(
            columns.some((column) => column.column_name === "token"),
            false,
          );
          const sample = actual[0];
          await assert.rejects(
            prisma.$executeRawUnsafe(
              `INSERT INTO "${table}" (id, "userId", "tokenHash", "expiresAt") VALUES ($1, $2, $3, $4)`,
              `duplicate-${kind}`,
              sample.userId,
              sample.tokenHash,
              liveUntil,
            ),
            (error) => error.meta?.code === "23505",
          );
        }
      },
    );
    await t.test("migrate deploy rerun does not double-hash", async () => {
      const before = await prisma.passwordResetToken.findMany({
        orderBy: { id: "asc" },
      });
      const verifyBefore = await prisma.emailVerificationToken.findMany({
        orderBy: { id: "asc" },
      });
      assert.match(
        await deploy(new URL("schema.prisma", prismaRoot).pathname),
        /No pending migrations/,
      );
      assert.deepEqual(
        await prisma.passwordResetToken.findMany({ orderBy: { id: "asc" } }),
        before,
      );
      assert.deepEqual(
        await prisma.emailVerificationToken.findMany({
          orderBy: { id: "asc" },
        }),
        verifyBefore,
      );
    });
    app = await buildApp();
    await app.ready();
    await t.test(
      "used and expired legacy links retain their errors",
      async () => {
        for (const row of rows.reset.filter(
          (row) => row.usedAt || row.expiresAt === expiredAt,
        )) {
          const result = await inject(
            `/api/auth/reset-password/${encodeURIComponent(row.token)}`,
            { password: "Upgrade-reset-password-123" },
          );
          assert.equal(result.statusCode, 410, result.body);
          assert.match(
            result.json().message,
            row.usedAt ? /already been used/ : /expired/,
          );
        }
        for (const row of rows.verify.filter(
          (row) => row.expiresAt === expiredAt,
        ))
          assert.equal(
            (
              await inject(
                `/api/auth/verify-email/${encodeURIComponent(row.token)}`,
              )
            ).statusCode,
            410,
          );
      },
    );
    await t.test(
      "raw legacy links redeem once for their original owner; stored digests do not redeem",
      async () => {
        for (const row of rows.reset.filter(
          (row) => !row.usedAt && row.expiresAt === liveUntil,
        )) {
          assert.equal(
            (
              await inject(`/api/auth/reset-password/${hashToken(row.token)}`, {
                password: "Upgrade-reset-password-123",
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await inject(`/api/auth/reset-password/${row.token}`, {
                password: "Upgrade-reset-password-123",
              })
            ).statusCode,
            200,
          );
          assert(
            (
              await prisma.passwordResetToken.findUniqueOrThrow({
                where: { id: row.id },
              })
            ).usedAt,
          );
          assert.equal(
            (
              await inject(`/api/auth/reset-password/${row.token}`, {
                password: "Upgrade-reset-password-123",
              })
            ).statusCode,
            410,
          );
        }
        // The live row with raw=hash(raw) has no raw-token alias of its digest.
        for (const row of rows.verify.filter((row) => row.id.endsWith("-0"))) {
          assert.equal(
            (await inject(`/api/auth/verify-email/${hashToken(row.token)}`))
              .statusCode,
            404,
          );
          const result = await inject(`/api/auth/verify-email/${row.token}`);
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.json().data.user.id, row.userId);
          assert.equal(
            (await inject(`/api/auth/verify-email/${row.token}`)).statusCode,
            404,
          );
        }
      },
    );
  } finally {
    await app?.close();
    await prisma.$disconnect();
    await rm(temporary, { recursive: true, force: true });
  }
});
