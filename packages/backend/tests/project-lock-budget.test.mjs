import assert from "node:assert/strict";
import test from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test", LOG_LEVEL: "error", DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "project-lock-budget-unit-jwt", COOKIE_SECRET: "project-lock-budget-unit-cookie",
});
const { Prisma } = await import("@prisma/client");
const { withProjectOrder, ProjectBusyError } = await import("../src/utils/task-order.ts");
const canceled = () => new Prisma.PrismaClientKnownRequestError("canceled", {
  code: "P2010", clientVersion: "test", meta: { code: "57014" },
});

function fake(statement, lock, failAt) {
  const settings = [];
  let writes = 0;
  const error = canceled();
  const tx = {
    async $queryRaw(strings) {
      const sql = strings.join("?");
      if (sql.includes("pg_settings") || sql.includes("current_setting")) {
        if (failAt === "read") throw error;
        // Also support the previous helper for a meaningful before-fix run.
        return sql.includes("pg_settings")
          ? [{ name: "statement_timeout", timeoutMs: statement }, { name: "lock_timeout", timeoutMs: lock }]
          : [{ previous: `${statement}ms` }];
      }
      return [{ id: "project", archived: false }];
    },
    async $executeRaw(strings, ...values) {
      writes++;
      if ((failAt === "setup" && writes === 1) || (failAt === "restore" && writes === 2)) throw error;
      settings.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
    },
  };
  return { tx, settings, error };
}

test("project acquisition preserves each effective timeout independently and restores statement runtime", async () => {
  for (const [statement, lock, expectedStatement, expectedLock] of [
    [0, 0, 5000, 5000], [160, 0, 160, 5000], [0, 125, 5000, 125],
    [7000, 430, 5000, 430], [200, 8000, 200, 5000], [5000, 5000, 5000, 5000],
  ]) {
    const f = fake(statement, lock);
    assert.equal(await withProjectOrder(f.tx, "project", async () => "done"), "done");
    assert.deepEqual(f.settings[0].values, [`${expectedStatement}ms`, `${expectedLock}ms`], `effective settings ${statement}/${lock}`);
    assert.match(f.settings[0].sql, /set_config\('statement_timeout', \?, true\).*set_config\('lock_timeout', \?, true\)/);
    assert.deepEqual(f.settings[1], {
      sql: "SELECT set_config('statement_timeout', ?, true)", values: [`${statement}ms`],
    });
  }
});

test("setup and restore cancellations retain their original error and never run the project callback", async () => {
  for (const failAt of ["read", "setup", "restore"]) {
    const f = fake(0, 0, failAt);
    let ran = false;
    await assert.rejects(withProjectOrder(f.tx, "project", async () => { ran = true; }), (error) => {
      assert.equal(error, f.error);
      assert.equal(error instanceof ProjectBusyError, false);
      return true;
    });
    assert.equal(ran, false);
  }
});
