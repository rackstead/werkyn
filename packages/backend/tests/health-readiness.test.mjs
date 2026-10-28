import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "health-test-jwt",
  COOKIE_SECRET: "health-test-cookie",
});
const { default: healthPlugin } = await import("../src/plugins/health.ts");

async function appWithDatabase(prisma) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  await app.register(healthPlugin, { timeoutMs: 200 });
  await app.ready();
  return app;
}

test("liveness does not depend on the database; readiness does", async () => {
  let queries = 0;
  const app = await appWithDatabase({
    async $queryRaw() {
      queries += 1;
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=db-secret");
    },
  });
  try {
    const live = await app.inject("/api/health");
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().status, "ok");
    assert.equal(live.headers["cache-control"], "no-store");
    assert.equal(queries, 0, "liveness must not query the database");

    const ready = await app.inject("/api/ready");
    assert.equal(ready.statusCode, 503, ready.body);
    assert.equal(ready.headers["cache-control"], "no-store");
    assert.deepEqual(ready.json().checks, { database: "unavailable", migrations: "unknown" });
    assert.equal(ready.body.includes("db-secret"), false);
    assert.equal(ready.body.includes("10.0.0.5"), false);
  } finally {
    await app.close();
  }
});

test("readiness gives up on a hung database within its deadline", async () => {
  const app = await appWithDatabase({ $queryRaw: () => new Promise(() => {}) });
  try {
    const started = Date.now();
    const ready = await app.inject("/api/ready");
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().checks.database, "unavailable");
    assert.ok(Date.now() - started < 2000);
  } finally {
    await app.close();
  }
});

async function migrationsDir(names) {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "werkyn-migrations-"));
  await writeFile(path.join(dir, "migration_lock.toml"), 'provider = "postgresql"\n');
  for (const name of names) {
    await mkdir(path.join(dir, name));
    await writeFile(path.join(dir, name, "migration.sql"), "-- fixture\n");
  }
  return dir;
}

function prismaWithMigrations(rows) {
  return {
    async $queryRaw(strings) {
      return strings.join("?").includes("_prisma_migrations") ? rows : [{ "?column?": 1 }];
    },
  };
}

test("readiness reports pending and failed migrations", async () => {
  const { rm } = await import("node:fs/promises");
  const done = new Date();
  const dir = await migrationsDir(["001_init", "002_next"]);
  try {
    const cases = [
      [[{ migration_name: "001_init", finished_at: done, rolled_back_at: null }, { migration_name: "002_next", finished_at: done, rolled_back_at: null }], 200, "ok"],
      [[{ migration_name: "001_init", finished_at: done, rolled_back_at: null }], 503, "pending"],
      [[{ migration_name: "001_init", finished_at: done, rolled_back_at: null }, { migration_name: "002_next", finished_at: done, rolled_back_at: done }], 503, "pending"],
      [[{ migration_name: "001_init", finished_at: done, rolled_back_at: null }, { migration_name: "002_next", finished_at: null, rolled_back_at: null }], 503, "failed"],
    ];
    for (const [rows, status, migrations] of cases) {
      const app = Fastify({ logger: false });
      app.decorate("prisma", prismaWithMigrations(rows));
      await app.register(healthPlugin, { migrationsDir: dir });
      try {
        const ready = await app.inject("/api/ready");
        assert.equal(ready.statusCode, status, ready.body);
        assert.deepEqual(ready.json().checks, { database: "ok", migrations });
        assert.equal(ready.json().status, status === 200 ? "ready" : "not_ready");
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
