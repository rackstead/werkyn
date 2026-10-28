import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, test } from "node:test";
import Fastify from "fastify";

// A stand-in for the embedded Dex process: it records what the proxy forwards.
const forwarded = [];
const dex = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    forwarded.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (req.url.startsWith("/dex/auth")) {
      res.writeHead(302, {
        location: "/dex/auth/local?req=fixture",
        "set-cookie": "dex_session=fixture; Path=/dex; HttpOnly",
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-dex-fixture": "1" });
    res.end(JSON.stringify({ upstream: "dex", url: req.url }));
  });
});
dex.listen(0, "127.0.0.1");
await once(dex, "listening");

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unit_test",
  JWT_SECRET: "unit-dex-proxy-jwt-secret",
  COOKIE_SECRET: "unit-dex-proxy-cookie-secret",
  DEX_INTERNAL_PORT: String(dex.address().port),
});
const { default: dexProxy } = await import("../src/plugins/dex-proxy.ts");
const { dexManager } = await import("../src/services/dex-manager.ts");

let dexRunning = true;
Object.defineProperty(dexManager, "isRunning", {
  configurable: true,
  get: () => dexRunning,
});

let app, port;

before(async () => {
  app = Fastify();
  await app.register(dexProxy);
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = app.server.address().port;
});

after(async () => {
  await app?.close();
  dex.closeAllConnections();
  await new Promise((resolve) => dex.close(resolve));
});

// node:http keeps caller-supplied Connection headers, unlike fetch.
function send(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("Dex browser requests reach Dex without Werkyn credentials or hop-by-hop headers", async () => {
  forwarded.length = 0;
  const response = await send("GET", "/dex/auth?client_id=werkyn&state=fixture-state", {
    authorization: "Bearer werkyn-access-token",
    cookie: "dex_session=previous",
    connection: "keep-alive, x-hop-only, authorization",
    "x-hop-only": "1",
    "x-end-to-end": "kept",
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/dex/auth/local?req=fixture");
  assert.deepEqual(response.headers["set-cookie"], [
    "dex_session=fixture; Path=/dex; HttpOnly",
  ]);

  assert.equal(forwarded.length, 1);
  const [seen] = forwarded;
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/dex/auth?client_id=werkyn&state=fixture-state");
  assert.equal(seen.headers.host, `127.0.0.1:${dex.address().port}`);
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers["x-hop-only"], undefined);
  assert.doesNotMatch(seen.headers.connection ?? "", /x-hop-only|authorization/i);
  assert.equal(seen.headers.cookie, "dex_session=previous");
  assert.equal(seen.headers["x-end-to-end"], "kept");
});

test("the bare /dex path and JSON request bodies are forwarded intact", async () => {
  forwarded.length = 0;
  const root = await send("GET", "/dex", { authorization: "Bearer werkyn-access-token" });
  assert.equal(root.status, 200);
  assert.equal(root.headers["x-dex-fixture"], "1");
  assert.deepEqual(JSON.parse(root.body), { upstream: "dex", url: "/dex" });

  const payload = JSON.stringify({ login: "fixture", remember: true });
  const posted = await send(
    "POST",
    "/dex/approval?req=fixture",
    {
      authorization: "Bearer werkyn-access-token",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    },
    payload,
  );
  assert.equal(posted.status, 200);

  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].url, "/dex");
  assert.equal(forwarded[0].headers.authorization, undefined);
  const [, post] = forwarded;
  assert.equal(post.method, "POST");
  assert.equal(post.url, "/dex/approval?req=fixture");
  assert.equal(post.headers.authorization, undefined);
  // reply-from re-serializes the JSON body Fastify parsed and sends the bare
  // media type, dropping the client's charset parameter.
  assert.equal(post.headers["content-type"], "application/json");
  assert.equal(Number(post.headers["content-length"]), Buffer.byteLength(post.body));
  assert.deepEqual(JSON.parse(post.body), { login: "fixture", remember: true });
});

test("requests are refused without contacting Dex while it is stopped", async () => {
  forwarded.length = 0;
  dexRunning = false;
  try {
    for (const path of ["/dex", "/dex/auth?client_id=werkyn"]) {
      const response = await send("GET", path);
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.body), { error: "SSO service is not running" });
    }
  } finally {
    dexRunning = true;
  }
  assert.equal(forwarded.length, 0);
});
