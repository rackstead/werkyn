import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guard = await import("../prisma/seed-guard.ts");
const empty = { users: 0, seedUsers: 0, workspaces: 0, seedWorkspaces: 0 };
const seeded = { users: 5, seedUsers: 5, workspaces: 2, seedWorkspaces: 2 };

test("production is refused before the database is touched", () => {
  assert.match(guard.environmentRefusal("production"), /production/);
  for (const mode of [undefined, "", "development", "test"]) {
    assert.equal(guard.environmentRefusal(mode), undefined);
  }
});

test("only an empty database is seeded and existing seed data is kept unless forced", () => {
  assert.deepEqual(guard.decideSeed(empty, false), { action: "seed" });
  assert.deepEqual(guard.decideSeed(empty, true), { action: "seed" });
  assert.equal(guard.decideSeed(seeded, false).action, "skip");
  assert.deepEqual(guard.decideSeed(seeded, true), { action: "reseed" });
  assert.deepEqual(guard.decideSeed({ ...empty, users: 1, seedUsers: 1 }, true), { action: "reseed" });
});

test("data the seed did not create is never mixed with or deleted by the seed", () => {
  for (const inventory of [
    { ...empty, users: 1 },
    { ...seeded, users: 6 },
    { ...empty, workspaces: 1 },
    { ...seeded, workspaces: 3 },
  ]) {
    for (const force of [false, true]) {
      const decision = guard.decideSeed(inventory, force);
      assert.equal(decision.action, "refuse", JSON.stringify({ inventory, force }));
      assert.match(decision.reason, /did not create/);
    }
  }
});

test("seed identities match the accounts and workspaces the script creates", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../prisma/seed.ts", import.meta.url), "utf8");
  const emails = [...source.matchAll(/email: "([^"]+@test\.com)"/g)].map((match) => match[1]);
  const slugs = [...source.matchAll(/data: \{ name: "[^"]+", slug: "([^"]+)" \}/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(emails)].sort(), [...guard.SEED_USER_EMAILS].sort());
  assert.deepEqual(slugs.sort(), [...guard.SEED_WORKSPACE_SLUGS].sort());
});

test("the seed script exits non-zero in production without connecting", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: "postgresql://seed:seed@127.0.0.1:1/unreachable" },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Seed refused/);
  assert.doesNotMatch(result.stdout + result.stderr, /Can't reach|Creating users/);
});
