import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import Fastify from "fastify";

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/unused",
  JWT_SECRET: "log-redaction-test-jwt",
  COOKIE_SECRET: "log-redaction-test-cookie",
});
const { getLoggerConfig } = await import("../src/plugins/logger.ts");

const SECRET = "s3cr3t-value-that-must-not-be-logged";

function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => lines.join("") };
}

async function appWithCapturedLogs() {
  const sink = capture();
  const app = Fastify({ logger: { ...getLoggerConfig(), stream: sink.stream } });
  app.get("/api/workspaces/:wid/files/:fid/download", async () => ({ ok: true }));
  app.post("/api/auth/reset-password/:token", async () => ({ ok: true }));
  app.get("/api/public/files/:token", async () => ({ ok: true }));
  app.get("/api/invites/:token", async () => ({ ok: true }));
  app.get("/api/explode", async (request) => {
    request.log.error(
      {
        headers: { authorization: `Bearer ${SECRET}`, cookie: `refreshToken=${SECRET}` },
        body: { email: "user@example.com", password: SECRET, token: SECRET },
      },
      "handler failure context",
    );
    return { ok: true };
  });
  await app.ready();
  return { app, sink };
}

test("request URLs in access logs never contain credentials or link tokens", async () => {
  const { app, sink } = await appWithCapturedLogs();
  try {
    const urls = [
      `/api/workspaces/w1/files/f1/download?inline=true&token=${SECRET}`,
      `/api/public/files/${SECRET}`,
      `/api/invites/${SECRET}`,
      `/reset-password/${SECRET}`,
      `/verify-email/${SECRET}?invite=${SECRET}`,
      `/share/files/${SECRET}`,
      `/dex/callback?code=${SECRET}&state=${SECRET}`,
      `/api/auth/oidc/callback?state=${SECRET}&code=${SECRET}`,
    ];
    for (const url of urls) await app.inject({ method: "GET", url });
    await app.inject({ method: "POST", url: `/api/auth/reset-password/${SECRET}`, payload: { password: SECRET } });
    await app.inject({
      method: "GET",
      url: "/api/workspaces/w1/files/f1/download",
      headers: { authorization: `Bearer ${SECRET}`, cookie: `refreshToken=${SECRET}`, "x-api-key": SECRET },
    });
    const logged = sink.text();
    assert.match(logged, /incoming request/);
    assert.equal(logged.includes(SECRET), false, logged);
    // Non-secret context stays readable for operators.
    assert.match(logged, /download\?inline=true&token=\[REDACTED\]/);
    assert.match(logged, /\/api\/public\/files\/\[REDACTED\]/);
    assert.match(logged, /\/reset-password\/\[REDACTED\]/);
  } finally {
    await app.close();
  }
});

test("structured log fields with credentials are censored", async () => {
  const { app, sink } = await appWithCapturedLogs();
  try {
    await app.inject({ method: "GET", url: "/api/explode" });
    const logged = sink.text();
    assert.match(logged, /handler failure context/);
    assert.match(logged, /user@example\.com/);
    assert.equal(logged.includes(SECRET), false, logged);
  } finally {
    await app.close();
  }
});

test("standalone logger shares the same redaction policy", async () => {
  const sink = capture();
  const { createLogger } = await import("../src/utils/logger.ts");
  const log = createLogger(sink.stream);
  log.error({ err: new Error(`request to /api/invites/${SECRET} failed`), smtp: { pass: SECRET } }, `GET /verify-email/${SECRET}?token=${SECRET}`);
  log.warn(`link https://werkyn.example.com/reset-password/${SECRET} expired`);
  const logged = sink.text();
  assert.match(logged, /\/verify-email\/\[REDACTED\]/);
  assert.match(logged, /https:\/\/werkyn\.example\.com\/reset-password\/\[REDACTED\] expired/);
  assert.equal(logged.includes(SECRET), false, logged);
});
