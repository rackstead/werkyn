import crypto from "node:crypto";
import http from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixture = JSON.parse(process.env.CSP_COOKIE_CONFIG_CASE);
const suffix = crypto.randomUUID();
const root = path.join(process.env.TMPDIR || os.tmpdir(), `werkyn-csp-${suffix}`);
const storage = path.join(root, "storage");
const previousCwd = process.cwd();
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: fixture.mode,
  LOG_LEVEL: "error",
  JWT_SECRET: "csp-cookie-config-signing-fixture-".repeat(2),
  COOKIE_SECRET: "csp-cookie-config-cookie-fixture-".repeat(2),
  COOKIE_DOMAIN: "",
  COOKIE_SAMESITE: fixture.sameSite || "lax",
  FRONTEND_URL: fixture.secure === "false" ? "http://localhost:3000" : "https://csp.example.test",
  CORS_ORIGIN: "http://localhost:3000",
  STORAGE_DIR: storage,
});
delete process.env.COOKIE_SECURE;
if (fixture.secure !== undefined) process.env.COOKIE_SECURE = fixture.secure;

let app;
let user;
let result;
let stage = "configuration";

function request(port, target, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: target,
      method: data === undefined && target === "/api/live" ? "GET" : "POST",
      agent: false,
      headers: body === undefined ? headers : {
        ...headers,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("CSP fixture request timed out")));
    req.end(body);
  });
}

function cookieFlags(response) {
  const cookie = response.headers["set-cookie"]?.find((value) => value.startsWith("refresh_token="));
  if (!cookie) return null;
  const attributes = cookie.split(";").slice(1).map((value) => value.trim().toLowerCase());
  return {
    secure: attributes.includes("secure"),
    httpOnly: attributes.includes("httponly"),
    path: attributes.find((value) => value.startsWith("path="))?.slice(5),
    sameSite: attributes.find((value) => value.startsWith("samesite="))?.slice(9),
  };
}

try {
  const { env } = await import("../../src/config/env.js");
  stage = "application";
  const { buildApp } = await import("../../src/app.js");
  const { default: bcrypt } = await import("bcrypt");
  await mkdir(storage, { recursive: true });
  const frontend = path.join(root, "packages/frontend/dist");
  await mkdir(frontend, { recursive: true });
  await writeFile(path.join(frontend, "index.html"), "<!doctype html><title>CSP configuration fixture</title>");
  process.chdir(root);
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  process.stdout.write("CSP_COOKIE_LISTENING\n");
  const port = app.server.address().port;
  stage = "fixture-user";
  const email = `csp-config-${suffix}@example.test`;
  const password = "Csp fixture password!123";
  user = await app.prisma.user.create({
    data: {
      email,
      displayName: "CSP cookie fixture",
      emailVerified: true,
      passwordHash: await bcrypt.hash(password, 4),
    },
    select: { id: true },
  });
  stage = "http";
  const login = await request(port, "/api/auth/login", { email, password });
  const live = await request(port, "/api/live");
  const accessToken = JSON.parse(login.body).data?.accessToken;
  const cookie = login.headers["set-cookie"]?.find((value) => value.startsWith("refresh_token="))?.split(";")[0];
  const logout = await request(port, "/api/auth/logout", undefined, {
    authorization: `Bearer ${accessToken}`,
    ...(cookie ? { cookie } : {}),
  });
  result = {
    name: fixture.name,
    validatedSecure: env.COOKIE_SECURE,
    status: { login: login.status, live: live.status, logout: logout.status },
    loginCookie: cookieFlags(login),
    clearCookie: cookieFlags(logout),
    csp: live.headers["content-security-policy"],
    loginCsp: login.headers["content-security-policy"],
    headers: {
      nosniff: live.headers["x-content-type-options"],
      frame: live.headers["x-frame-options"],
    },
  };
} catch (error) {
  process.stderr.write(`CSP_COOKIE_FIXTURE_ERROR ${JSON.stringify({
    name: fixture.name,
    stage,
    nameOfError: error?.name,
    code: error?.code,
  })}\n`);
  process.exitCode = 1;
} finally {
  try {
    if (user) await app.prisma.user.deleteMany({ where: { id: user.id } });
  } finally {
    await app?.close();
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}
if (result && !process.exitCode) process.stdout.write(`CSP_COOKIE_RESULT ${JSON.stringify(result)}\n`);
