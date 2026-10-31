import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a migrated, disposable PostgreSQL database");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "error";
process.env.JWT_SECRET = "frontend-static-fixture-signing-secret-".repeat(2);
process.env.COOKIE_SECRET = "frontend-static-fixture-cookie-secret-".repeat(2);
process.env.COOKIE_SECURE = "false";
const root = await mkdtemp(path.join(os.tmpdir(), "werkyn-frontend-static-"));
const dist = path.join(root, "packages/frontend/dist");
process.env.STORAGE_DIR = path.join(root, "storage");
const originalCwd = process.cwd();
const index = "<!doctype html><html><body>frontend static fixture</body></html>";
const files = new Map([
  ["index.html", index],
  ["assets/app-AbCd1234.js", "export const marker = 'public compiled script';"],
  ["assets/theme-BcDe2345.css", "body { color: navy; }"],
  ["assets/font-CdEf3456.woff2", "public font fixture"],
  ["assets/runtime.js", "export const marker = 'unhashed public script';"],
  ["assets/nested/index.html", "<html>nested public document</html>"],
  ["assets/document-DeFg4567.html", "<html>fingerprint-like document</html>"],
  ["assets/directory-EfGh5678.js/index.html", "<html>document in a fingerprint-like directory</html>"],
  ["favicon.ico", "public icon fixture"],
  ["robots.txt", "User-agent: *\nDisallow:\n"],
  ["api/not-a-file.js", "benign frontend fixture must not shadow an API miss"],
  ["ASSETS/unpackaged-AbCd1234.js", "public file outside the packaged asset namespace"],
  ["assets/progress.100%", "public file with a literal percent in its name"],
]);
const { buildApp } = await import("../../src/app.js");
const { signAccessToken } = await import("../../src/utils/tokens.js");
let app, port, user, workspace, token;

async function request(target, { method = "GET", ip = "127.0.0.81", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: target, method, localAddress: ip, headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`Local request timed out: ${target}`)));
    req.end();
  });
}

before(async () => {
  for (const [name, body] of files) {
    const full = path.join(dist, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  process.chdir(root);
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = app.server.address().port;
  const suffix = crypto.randomUUID().slice(0, 20);
  user = await app.prisma.user.create({
    data: { email: `frontend-static-${suffix}@example.test`, displayName: "Static fixture", emailVerified: true },
  });
  workspace = await app.prisma.workspace.create({
    data: { name: "Static fixture", slug: `frontend-static-${suffix}`, members: { create: { userId: user.id, role: "MEMBER" } } },
  });
  token = signAccessToken({ sub: user.id, email: user.email });
  const upload = path.join(process.env.STORAGE_DIR, workspace.id, "uploads", "fixture.js");
  await mkdir(path.dirname(upload), { recursive: true });
  await writeFile(upload, "uploaded benign fixture");
});

after(async () => {
  try {
    if (workspace) await app.prisma.workspace.deleteMany({ where: { id: workspace.id } });
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("public frontend requests neither spend nor obey the API rate-limit bucket", async () => {
  const ip = "127.0.0.82";
  let first;
  for (let n = 0; n < 120; n++) {
    const target = ["/assets/app-AbCd1234.js?version=1", "/index.html", "/workspace/project", "/"][n % 4];
    const response = await request(target, { ip, method: n % 2 ? "HEAD" : "GET" });
    assert.equal(response.statusCode, 200, `frontend request ${n}: ${target}`);
    if (n === 0) first = response;
  }
  assert.equal(first.headers["x-ratelimit-limit"], undefined);
  for (let n = 0; n < 100; n++) {
    const response = await request("/api/health", { ip });
    assert.equal(response.statusCode, 200, `API request ${n}: ${response.body}`);
    assert.equal(Number(response.headers["x-ratelimit-remaining"]), 99 - n);
  }
  const refused = await request("/api/health", { ip });
  assert.equal(refused.statusCode, 429);
  assert.ok(Number(refused.headers["retry-after"]) > 0);
  assert.equal((await request("/assets/app-AbCd1234.js", { ip })).statusCode, 200);
  assert.equal((await request("/workspace/project", { ip })).statusCode, 200);
});

test("only fingerprinted build assets get long immutable caching, including HEAD, ranges and 304", async () => {
  for (const target of ["/assets/app-AbCd1234.js", "/assets/theme-BcDe2345.css", "/assets/font-CdEf3456.woff2"]) {
    const response = await request(target);
    assert.equal(response.statusCode, 200, target);
    assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(response.body, files.get(target.slice(1)));
    const head = await request(`${target}?v=ignored`, { method: "HEAD" });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers["cache-control"], response.headers["cache-control"]);
    assert.equal(head.body, "");
    const conditional = await request(target, { headers: { "if-none-match": response.headers.etag } });
    assert.equal(conditional.statusCode, 304);
    assert.equal(conditional.headers["cache-control"], response.headers["cache-control"]);
    assert.equal(conditional.body, "");
  }
  const partial = await request("/assets/app-AbCd1234.js", { headers: { range: "bytes=0-5" } });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.body, files.get("assets/app-AbCd1234.js").slice(0, 6));
  assert.equal(partial.headers["cache-control"], "public, max-age=31536000, immutable");
});

test("HTML, SPA documents and unhashed public files must revalidate", async () => {
  for (const target of ["/", "/index.html", "/workspace/project?view=list", "/assets/runtime.js", "/favicon.ico", "/robots.txt", "/assets/nested/", "/assets/document-DeFg4567.html", "/assets/directory-EfGh5678.js", "/ASSETS/unpackaged-AbCd1234.js", "/assets/progress.100%25"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(target, { method });
      assert.equal(response.statusCode, 200, `${method} ${target}`);
      assert.equal(response.headers["cache-control"], "public, max-age=0, must-revalidate", `${method} ${target}`);
      assert.doesNotMatch(response.headers["cache-control"], /immutable/);
      if (method === "GET" && response.headers.etag) {
        const conditional = await request(target, { headers: { "if-none-match": response.headers.etag } });
        assert.equal(conditional.statusCode, 304, target);
        assert.equal(conditional.headers["cache-control"], "public, max-age=0, must-revalidate", target);
      }
    }
  }
});

test("missing build files are uncached 404s rather than an HTML success", async () => {
  for (const target of ["/assets/missing-AbCd1234.js", "/assets/missing.css?v=1", "/assets/", "/assets", "/missing.js", "/missing.ico"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(target, { method });
      assert.equal(response.statusCode, 404, `${method} ${target}`);
      assert.match(response.headers["content-type"], /^application\/json/);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.ok(!response.body.includes(index));
    }
  }
});

test("API namespaces and route-specific authentication limits stay protected", async () => {
  const ip = "127.0.0.83";
  for (let n = 0; n < 10; n++) {
    const response = await request("/api/auth/login?asset=/assets/app-AbCd1234.js", { ip, method: "POST" });
    assert.equal(response.statusCode, 400, `login request ${n}: ${response.body}`);
  }
  assert.equal((await request("/api/auth/login", { ip, method: "POST" })).statusCode, 429);
  for (const [target, status] of [["/api/no-such-route", 404], ["/api/not-a-file.js", 404], ["/api", 404], ["/dex/missing", 503], ["/storage/missing", 404], ["/uploads/missing", 404]]) {
    const response = await request(target, { ip: "127.0.0.84" });
    assert.equal(response.statusCode, status, target);
    assert.ok(!response.body.includes(index), target);
    assert.ok(!response.body.includes("must not shadow"), target);
    assert.equal(Number(response.headers["x-ratelimit-limit"]), 100, target);
  }
});

test("noncanonical targets never gain the frontend exemption or immutable caching", async () => {
  for (const target of ["/assets/../index.html", "/assets/%2e%2e/index.html", "/assets//app-AbCd1234.js", "/%61pi/no-such-route", "/%73torage/missing"]) {
    const response = await request(target, { ip: "127.0.0.86" });
    assert.ok([400, 403, 404].includes(response.statusCode), `${target}: ${response.statusCode}`);
    assert.ok(!response.body.includes(index), target);
    assert.doesNotMatch(response.headers["cache-control"] ?? "", /immutable/, target);
    if (response.headers["x-ratelimit-limit"] !== undefined) {
      assert.equal(Number(response.headers["x-ratelimit-limit"]), 100, target);
    }
  }
});

test("a literal percent filename serves through one encoded pass while a malformed raw target stays rejected", async () => {
  const malformed = await request("/assets/progress.100%", { ip: "127.0.0.87" });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes(files.get("assets/progress.100%")));
  for (const method of ["GET", "HEAD"]) {
    const encoded = await request("/assets/progress.100%25", { method, ip: "127.0.0.87" });
    assert.equal(encoded.statusCode, 200, method);
    assert.equal(encoded.body, method === "HEAD" ? "" : files.get("assets/progress.100%"));
    assert.doesNotMatch(encoded.headers["cache-control"] ?? "", /immutable/);
  }
});

test("workspace uploads keep membership checks, no-store and untrusted-content headers", async () => {
  const target = `/storage/${workspace.id}/uploads/fixture.js`;
  const denied = await request(target, { ip: "127.0.0.85" });
  assert.equal(denied.statusCode, 401);
  assert.equal(Number(denied.headers["x-ratelimit-limit"]), 100);
  const response = await request(target, { ip: "127.0.0.85", headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "uploaded benign fixture");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(response.headers["content-security-policy"], /sandbox/);
  assert.match(response.headers["content-type"], /^application\/octet-stream/);
  assert.match(response.headers["content-disposition"], /^attachment/);
  await app.prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id, userId: user.id } });
  assert.equal((await request(target, { ip: "127.0.0.85", headers: { authorization: `Bearer ${token}` } })).statusCode, 403);
  assert.equal(await readFile(path.join(process.env.STORAGE_DIR, workspace.id, "uploads/fixture.js"), "utf8"), "uploaded benign fixture");
});
