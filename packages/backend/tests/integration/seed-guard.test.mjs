import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
const email = `seed-guard-${crypto.randomUUID()}@example.test`;
let fixture;

function seed(extra) {
  return spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
    cwd: new URL("../..", import.meta.url),
    env: { PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: "development", ...extra },
    encoding: "utf8",
    timeout: 120_000,
  });
}

async function snapshot() {
  const [users, workspaces, seedUser] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.user.findUnique({ where: { email: "alice@test.com" } }),
  ]);
  return { users, workspaces, seedUser: Boolean(seedUser) };
}

before(async () => {
  assert.equal(await prisma.user.count({ where: { email: "alice@test.com" } }), 0, "test database already contains seed data");
  fixture = await prisma.user.create({ data: { email, displayName: "Existing account", emailVerified: true } });
});

after(async () => {
  try {
    if (fixture) await prisma.user.deleteMany({ where: { id: fixture.id } });
  } finally {
    await prisma.$disconnect();
  }
});

test("seeding a database with existing accounts is refused, with or without SEED_FORCE", async () => {
  const initial = await snapshot();
  for (const extra of [{}, { SEED_FORCE: "true" }]) {
    const result = seed(extra);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Seed refused/);
    assert.equal(result.stderr.includes(email), false, "never print other accounts");
    assert.deepEqual(await snapshot(), initial);
    assert.ok(await prisma.user.findUnique({ where: { id: fixture.id } }), "SEED_FORCE deleted an existing account");
  }
});

test("production is refused against a real database without writing", async () => {
  const initial = await snapshot();
  const result = seed({ NODE_ENV: "production", SEED_FORCE: "true" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /production/);
  assert.deepEqual(await snapshot(), initial);
});
