import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function validateSecrets(jwt, cookie, mode = "production") {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "await import('./src/config/env.ts')"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env, NODE_ENV: mode, DATABASE_URL: "postgresql://unused/unused",
      JWT_SECRET: jwt, COOKIE_SECRET: cookie, LOG_LEVEL: "error",
    },
    encoding: "utf8",
  });
}

test("production refuses short and published sample signing secrets", () => {
  const valid = "a-unique-test-secret-32-characters-long";
  for (const [jwt, cookie] of [
    ["short", valid], [valid, "short"],
    ["change-me-to-a-secure-random-string-at-least-32-chars", valid],
    [valid, "change-me-to-another-secure-random-string"],
    ["your-secret-key-min-32-chars-in-production", valid],
  ]) {
    const result = validateSecrets(jwt, cookie);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /unique random secret/);
    assert.equal(result.stdout.includes(jwt), false, "never print rejected secret");
  }
});

test("production accepts operator secrets and tests can use short local values", () => {
  assert.equal(validateSecrets("random-test-jwt-32-characters-long", "random-test-cookie-32-characters-long").status, 0);
  assert.equal(validateSecrets("test", "test", "test").status, 0);
});

test("published signing key cannot mint tokens for an operator-configured instance", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import jwt from 'jsonwebtoken';
    const { verifyAccessToken, signAccessToken } = await import('./src/utils/tokens.ts');
    const payload = { sub: 'disposable-user', email: 'audit@example.invalid' };
    const forged = jwt.sign(payload, 'change-me-to-a-secure-random-string-at-least-32-chars');
    assert.throws(() => verifyAccessToken(forged));
    assert.equal(verifyAccessToken(signAccessToken(payload)).sub, payload.sub);
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "postgresql://unused/unused", JWT_SECRET: "operator-test-jwt-key-at-least-32-characters", COOKIE_SECRET: "operator-test-cookie-key-at-least-32-characters", LOG_LEVEL: "error" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
