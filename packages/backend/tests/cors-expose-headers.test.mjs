import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "unit-cors-expose-headers-jwt-secret";
process.env.COOKIE_SECRET = "unit-cors-expose-headers-cookie-secret";
process.env.CORS_ORIGIN = "http://frontend.example.test";
const { default: corsPlugin } = await import("../src/plugins/cors.ts");
const { default: rateLimitPlugin } = await import("../src/plugins/rate-limit.ts");

test("a frontend on another origin can read Retry-After from a refused request", async () => {
  const app = Fastify();
  await app.register(corsPlugin);
  await app.register(rateLimitPlugin);
  app.get("/api/probe", async () => ({ ok: true }));
  await app.ready();
  try {
    const headers = { origin: "http://frontend.example.test" };
    let last;
    for (let i = 0; i < 101; i++) last = await app.inject({ method: "GET", url: "/api/probe", headers });
    assert.equal(last.statusCode, 429);
    assert.match(String(last.headers["retry-after"]), /^\d+$/);
    assert.equal(last.headers["access-control-allow-origin"], "http://frontend.example.test");
    assert.match(String(last.headers["access-control-expose-headers"]), /\bRetry-After\b/i);
  } finally {
    await app.close();
  }
});
