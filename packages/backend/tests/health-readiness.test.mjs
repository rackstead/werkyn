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

async function appWithDatabase(prisma, options = {}) {
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma);
  await app.register(healthPlugin, { timeoutMs: 200, ...options });
  await app.ready();
  return app;
}

test("liveness does not depend on the database; health and readiness do", async () => {
  let queries = 0;
  const app = await appWithDatabase({
    async $queryRaw() {
      queries += 1;
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=db-secret");
    },
  });
  try {
    const live = await app.inject("/api/live");
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().status, "ok");
    assert.equal(live.headers["cache-control"], "no-store");
    assert.equal(queries, 0, "liveness must not query the database");

    // Existing monitors of /api/health keep their database signal.
    const health = await app.inject("/api/health");
    assert.equal(health.statusCode, 503, health.body);
    assert.equal(health.json().status, "unavailable");
    assert.equal(health.headers["cache-control"], "no-store");

    const ready = await app.inject("/api/ready");
    assert.equal(ready.statusCode, 503, ready.body);
    assert.equal(ready.headers["cache-control"], "no-store");
    assert.deepEqual(ready.json().checks, { database: "unavailable", migrations: "unknown" });
    for (const body of [health.body, ready.body]) {
      assert.equal(body.includes("db-secret"), false);
      assert.equal(body.includes("10.0.0.5"), false);
    }
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

test("one deadline covers the whole evaluation, not each query", async () => {
  const dir = await migrationsDir(["001_init"]);
  // The first query uses most of the budget and the second never answers.
  const app = await appWithDatabase(
    {
      $queryRaw(strings) {
        if (strings.join("?").includes("_prisma_migrations")) return new Promise(() => {});
        return new Promise((resolve) => setTimeout(() => resolve([{}]), 150));
      },
    },
    { migrationsDir: dir, timeoutMs: 250 },
  );
  try {
    const started = Date.now();
    const ready = await app.inject("/api/ready");
    const elapsed = Date.now() - started;
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json().checks, { database: "ok", migrations: "unknown" });
    assert.ok(elapsed < 450, `took ${elapsed}ms with a 250ms deadline`);
  } finally {
    await app.close();
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  }
});

test("concurrent probes share one evaluation and reuse it briefly", async () => {
  const dir = await migrationsDir(["001_init"]);
  let queries = 0;
  const app = await appWithDatabase(
    {
      async $queryRaw(strings) {
        queries += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return strings.join("?").includes("_prisma_migrations")
          ? [{ migration_name: "001_init", finished_at: new Date(), rolled_back_at: null }]
          : [{}];
      },
    },
    { migrationsDir: dir, cacheMs: 60_000 },
  );
  try {
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => app.inject(i % 2 ? "/api/ready" : "/api/health")),
    );
    assert.ok(responses.every((response) => response.statusCode === 200));
    assert.equal(queries, 2, "one SELECT 1 and one migration query for 50 probes");
    await app.inject("/api/ready");
    assert.equal(queries, 2, "a fresh result is reused");
  } finally {
    await app.close();
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
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
