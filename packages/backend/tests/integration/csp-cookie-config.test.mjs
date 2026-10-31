import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("Set TEST_DATABASE_URL to a migrated disposable PostgreSQL database");

const database = new URL(process.env.TEST_DATABASE_URL);
database.searchParams.set("connection_limit", "5");
const childFile = fileURLToPath(new URL("../support/csp-cookie-config-child.mjs", import.meta.url));

function run(fixture) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childFile], {
      env: {
        ...process.env,
        TEST_DATABASE_URL: database.toString(),
        CSP_COOKIE_CONFIG_CASE: JSON.stringify(fixture),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const line = stdout.split("\n").find((value) => value.startsWith("CSP_COOKIE_RESULT "));
      resolve({ code, signal, timedOut, stdout, stderr, result: line ? JSON.parse(line.slice(18)) : null });
    });
  });
}

function directives(header) {
  return Object.fromEntries(header.split(";").map((value) => value.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

const cases = [
  { name: "production omitted flag", mode: "production", expected: true },
  { name: "production empty flag", mode: "production", secure: "", expected: true },
  { name: "production whitespace flag", mode: "production", secure: "   ", expected: true },
  { name: "production explicit true", mode: "production", secure: "true", expected: true },
  { name: "production explicit false keeps local HTTP", mode: "production", secure: "false", expected: false },
  { name: "development default", mode: "development", expected: false },
  { name: "development explicit true", mode: "development", secure: "true", expected: true },
  { name: "test default", mode: "test", expected: false },
  { name: "explicit secure SameSite=None", mode: "production", secure: "true", sameSite: "none", expected: true },
];

for (const fixture of cases) {
  test(`CSP matches actual cookie configuration: ${fixture.name}`, { timeout: 20_000 }, async () => {
    const child = await run(fixture);
    assert.equal(child.timedOut, false, fixture.name);
    assert.equal(child.code, 0, `${fixture.name}: ${child.stderr}`);
    const result = child.result;
    assert.ok(result, fixture.name);
    assert.deepEqual(result.status, { login: 200, live: 200, logout: 204 });
    assert.equal(result.validatedSecure, fixture.expected);
    for (const cookie of [result.loginCookie, result.clearCookie]) {
      assert.ok(cookie, "actual refresh cookie must be written/cleared");
      assert.equal(cookie.secure, fixture.expected);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.path, "/api/auth");
      assert.equal(cookie.sameSite, fixture.sameSite || "lax");
    }
    assert.equal(result.loginCsp, result.csp);
    const policy = directives(result.csp);
    assert.equal(Object.hasOwn(policy, "upgrade-insecure-requests"), result.loginCookie.secure,
      "CSP upgrade must follow the validated Secure cookie policy");
    if (fixture.expected) assert.deepEqual(policy["upgrade-insecure-requests"], []);
    assert.deepEqual(policy["default-src"], ["'self'"]);
    assert.deepEqual(policy["script-src"], ["'self'"]);
    assert.deepEqual(policy["style-src"], ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(policy["img-src"], ["'self'", "data:", "blob:"]);
    assert.deepEqual(policy["font-src"], ["'self'", "data:"]);
    assert.deepEqual(policy["connect-src"], ["'self'"]);
    assert.deepEqual(policy["frame-ancestors"], ["'self'"]);
    assert.deepEqual(policy["object-src"], ["'none'"]);
    assert.deepEqual(policy["base-uri"], ["'self'"]);
    assert.deepEqual(policy["form-action"], ["'self'"]);
    assert.deepEqual(result.headers, { nosniff: "nosniff", frame: "SAMEORIGIN" });
  });
}

for (const fixture of [
  { name: "uppercase secure flag", mode: "production", secure: "TRUE", field: "COOKIE_SECURE" },
  { name: "unknown secure flag", mode: "production", secure: "csp-invalid-flag-canary", field: "COOKIE_SECURE" },
  { name: "insecure SameSite=None", mode: "production", secure: "false", sameSite: "none", field: "COOKIE_SAMESITE" },
]) {
  test(`invalid cookie configuration fails before listening: ${fixture.name}`, { timeout: 20_000 }, async () => {
    const child = await run(fixture);
    assert.equal(child.timedOut, false);
    assert.equal(child.code, 1);
    assert.equal(child.result, null);
    assert.doesNotMatch(child.stdout, /CSP_COOKIE_LISTENING/);
    assert.match(child.stdout, /Invalid environment variables/);
    assert.ok(child.stdout.includes(fixture.field));
    assert.doesNotMatch(child.stdout + child.stderr, /csp-invalid-flag-canary/);
  });
}
