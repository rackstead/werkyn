import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import Fastify from "fastify";

if (!process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  JWT_SECRET: "health-integration-signing-key",
  COOKIE_SECRET: "health-integration-cookie-key",
});
const { buildApp } = await import("../../src/app.js");
const { default: healthPlugin } = await import("../../src/plugins/health.ts");
const migrations = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
let app, directory;

before(async () => {
  app = await buildApp();
  await app.ready();
  directory = await mkdtemp(path.join(os.tmpdir(), "werkyn-ready-"));
});

after(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("a migrated database is ready, healthy and live", async () => {
  const ready = await app.inject("/api/ready");
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json().checks, { database: "ok", migrations: "ok" });
  assert.equal(ready.json().status, "ready");

  for (const url of ["/api/live", "/api/health"]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "ok");
  }
});

test("probes are not counted against the client rate limit", async () => {
  for (let i = 0; i < 120; i += 1) {
    const url = ["/api/live", "/api/health", "/api/ready"][i % 3];
    const response = await app.inject({ url, remoteAddress: "198.51.100.7" });
    assert.equal(response.statusCode, 200, `${url} #${i}: ${response.body}`);
  }
});

test("a deployed migration missing from the database keeps the instance not ready", async () => {
  const checkout = path.join(directory, "migrations");
  await cp(migrations, checkout, { recursive: true });
  await mkdir(path.join(checkout, "29991231000000_not_applied"));
  await writeFile(path.join(checkout, "29991231000000_not_applied", "migration.sql"), "SELECT 1;\n");

  const probe = Fastify({ logger: false });
  probe.decorate("prisma", app.prisma);
  await probe.register(healthPlugin, { migrationsDir: checkout });
  try {
    const ready = await probe.inject("/api/ready");
    assert.equal(ready.statusCode, 503, ready.body);
    assert.deepEqual(ready.json().checks, { database: "ok", migrations: "pending" });
    assert.equal(ready.body.includes("not_applied"), false);
  } finally {
    await probe.close();
  }
});
