import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const dockerAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

function resolveCompose(overrides = {}) {
  const cleanEnv = { ...process.env };
  for (const name of ["POSTGRES_PASSWORD", "JWT_SECRET", "COOKIE_SECRET", "COOKIE_SECURE", "FRONTEND_URL", "CORS_ORIGIN", "COMPOSE_FILE", "COMPOSE_ENV_FILES"]) {
    delete cleanEnv[name];
  }
  return spawnSync("docker", ["compose", "--env-file", "/dev/null", "config", "--format", "json"], {
    cwd: root,
    env: { ...cleanEnv, ...overrides },
    encoding: "utf8",
  });
}

const secrets = () => Object.fromEntries(["POSTGRES_PASSWORD", "JWT_SECRET", "COOKIE_SECRET"].map(name => [name, randomBytes(32).toString("hex")]));

test("Compose refuses each missing operator secret", { skip: !dockerAvailable && "Docker Compose is not installed" }, () => {
  for (const name of ["POSTGRES_PASSWORD", "JWT_SECRET", "COOKIE_SECRET"]) {
    const supplied = secrets();
    delete supplied[name];
    const result = resolveCompose(supplied);
    assert.notEqual(result.status, 0, `missing ${name} must fail before startup`);
    assert.ok(result.stderr.includes(name));
    for (const value of Object.values(supplied)) assert.equal(result.stderr.includes(value), false);
  }
});

test("Compose passes independent secrets and binds PostgreSQL to loopback", { skip: !dockerAvailable && "Docker Compose is not installed" }, () => {
  const supplied = secrets();
  const result = resolveCompose(supplied);
  assert.equal(result.status, 0, "valid operator configuration must resolve");
  const { services, volumes } = JSON.parse(result.stdout);
  assert.ok(services.werkyn.environment.JWT_SECRET === supplied.JWT_SECRET);
  assert.ok(services.werkyn.environment.COOKIE_SECRET === supplied.COOKIE_SECRET);
  const db = new URL(services.werkyn.environment.DATABASE_URL);
  assert.ok(db.password === supplied.POSTGRES_PASSWORD);
  assert.ok(services.postgres.environment.POSTGRES_PASSWORD === supplied.POSTGRES_PASSWORD);
  assert.equal(db.hostname, "postgres");
  assert.equal(services.postgres.ports.length, 1);
  assert.equal(services.postgres.ports[0].host_ip, "127.0.0.1");
  assert.equal(String(services.werkyn.environment.COOKIE_SECURE), "false");
  assert.ok(volumes.pgdata, "preserve the existing database volume");
});

test("Compose supports explicit HTTPS cookie and origin settings", { skip: !dockerAvailable && "Docker Compose is not installed" }, () => {
  const result = resolveCompose({ ...secrets(), COOKIE_SECURE: "true", FRONTEND_URL: "https://work.example.com", CORS_ORIGIN: "https://work.example.com" });
  assert.equal(result.status, 0);
  const env = JSON.parse(result.stdout).services.werkyn.environment;
  assert.equal(String(env.COOKIE_SECURE), "true");
  assert.equal(env.FRONTEND_URL, "https://work.example.com");
  assert.equal(env.CORS_ORIGIN, "https://work.example.com");
});
