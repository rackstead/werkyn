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
    const raw = Buffer.concat(chunks);
    forwarded.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      raw,
      body: raw.toString("utf8"),
    });
    if (req.url.startsWith("/dex/auth/ldap/login")) {
      res.writeHead(303, { location: "/dex/approval?req=fixture" });
      res.end();
      return;
    }
    if (req.url.startsWith("/dex/auth")) {
      res.writeHead(302, {
        location: "/dex/auth/local?req=fixture",
        "set-cookie": "dex_session=fixture; Path=/dex; HttpOnly",
      });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "x-dex-fixture": "1",
    });
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
const { env } = await import("../src/config/env.ts");
const { default: errorPlugin } = await import("../src/plugins/errors.ts");
const { default: dexProxy } = await import("../src/plugins/dex-proxy.ts");
const { dexManager } = await import("../src/services/dex-manager.ts");

let dexRunning = true;
Object.defineProperty(dexManager, "isRunning", {
  configurable: true,
  get: () => dexRunning,
});

let app, port;

// Mirrors the order buildApp() registers these plugins in.
async function listen() {
  const instance = Fastify();
  await instance.register(errorPlugin);
  await instance.register(dexProxy);
  await instance.listen({ host: "127.0.0.1", port: 0 });
  return instance;
}

before(async () => {
  app = await listen();
  port = app.server.address().port;
});

after(async () => {
  await app?.close();
  dex.closeAllConnections();
  await new Promise((resolve) => dex.close(resolve));
});

// node:http keeps caller-supplied Connection headers, unlike fetch.
function send(method, path, headers = {}, body, targetPort = port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method,
        path,
        headers,
        agent: false,
      },
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
  const response = await send(
    "GET",
    "/dex/auth?client_id=werkyn&state=fixture-state",
    {
      authorization: "Bearer werkyn-access-token",
      cookie: "dex_session=previous",
      connection: "keep-alive, x-hop-only, authorization",
      "x-hop-only": "1",
      "x-end-to-end": "kept",
    },
  );

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
  assert.doesNotMatch(
    seen.headers.connection ?? "",
    /x-hop-only|authorization/i,
  );
  assert.equal(seen.headers.cookie, "dex_session=previous");
  assert.equal(seen.headers["x-end-to-end"], "kept");
});

test("the bare /dex path and JSON request bodies are forwarded intact", async () => {
  forwarded.length = 0;
  const root = await send("GET", "/dex", {
    authorization: "Bearer werkyn-access-token",
  });
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
  // The body is forwarded as sent, not parsed and re-serialized.
  assert.equal(post.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(
    Number(post.headers["content-length"]),
    Buffer.byteLength(payload),
  );
  assert.equal(post.body, payload);
});

test("Dex login form posts reach Dex byte for byte", async () => {
  forwarded.length = 0;
  const form =
    "login=fixture%40example.test&password=p%26ss+w%C3%B6rd%21&remember=on&login=second";
  const response = await send(
    "POST",
    "/dex/auth/ldap/login?back=&state=fixture-state",
    {
      authorization: "Bearer werkyn-access-token",
      cookie: "dex_session=previous",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(form),
    },
    form,
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/dex/approval?req=fixture");
  assert.equal(forwarded.length, 1);
  const [seen] = forwarded;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/dex/auth/ldap/login?back=&state=fixture-state");
  assert.equal(
    seen.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(Number(seen.headers["content-length"]), Buffer.byteLength(form));
  assert.equal(seen.body, form);
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers.cookie, "dex_session=previous");
});

test("bodies with any content type are forwarded unchanged instead of failing", async () => {
  const binary = Buffer.from([0, 1, 2, 0xfe, 0xff, 0x0d, 0x0a]);
  const cases = [
    ["application/json; foo", Buffer.from('{"login":"fixture"}')],
    ["application/json;", Buffer.from('{"login":"fixture"}')],
    [
      "application/x-www-form-urlencoded; charset=UTF-8",
      Buffer.from("a=1&b=%E2%9C%93"),
    ],
    ["text/plain", Buffer.from("plain text")],
    ["application/octet-stream", binary],
    [
      "multipart/form-data; boundary=x",
      Buffer.from("--x\r\n\r\nfield\r\n--x--\r\n"),
    ],
    [undefined, binary],
  ];
  for (const [contentType, body] of cases) {
    forwarded.length = 0;
    const headers = { "content-length": body.length };
    if (contentType) headers["content-type"] = contentType;
    const response = await send("POST", "/dex/token", headers, body);
    assert.equal(response.status, 200, `${contentType}: ${response.body}`);
    assert.equal(forwarded.length, 1, String(contentType));
    assert.ok(forwarded[0].raw.equals(body), String(contentType));
    if (contentType)
      assert.equal(forwarded[0].headers["content-type"], contentType);
  }
});

test("oversized bodies are refused before reaching Dex", async () => {
  forwarded.length = 0;
  const body = Buffer.alloc(1024 * 1024 + 1, 0x61);
  const response = await send(
    "POST",
    "/dex/token",
    {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": body.length,
    },
    body,
  );
  assert.equal(response.status, 413);
  assert.equal(forwarded.length, 0);
});

test("malformed percent-escapes in the request target are a client error", async () => {
  forwarded.length = 0;
  for (const path of [
    "/dex/auth?a=%zz",
    "/dex/auth?state=%E0%A4%A",
    "/dex/auth?state=%C0",
    "/dex?x=%",
  ]) {
    const response = await send("GET", path);
    assert.equal(response.status, 400, `${path}: ${response.body}`);
  }
  const posted = await send(
    "POST",
    "/dex/auth/ldap/login?req=%zz",
    {
      "content-type": "application/x-www-form-urlencoded",
    },
    "login=a",
  );
  assert.equal(posted.status, 400);
  assert.equal(forwarded.length, 0);
});

test("a Dex that refuses connections is reported as a bad gateway", async () => {
  const closed = http.createServer();
  closed.listen(0, "127.0.0.1");
  await once(closed, "listening");
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  const originalPort = env.DEX_INTERNAL_PORT;
  env.DEX_INTERNAL_PORT = closedPort;
  let unreachable;
  try {
    unreachable = await listen();
  } finally {
    env.DEX_INTERNAL_PORT = originalPort;
  }
  try {
    const target = unreachable.server.address().port;
    for (const [method, headers, body] of [
      ["GET", {}, undefined],
      [
        "POST",
        { "content-type": "application/x-www-form-urlencoded" },
        "login=a&password=b",
      ],
    ]) {
      const response = await send(
        method,
        "/dex/auth?client_id=werkyn",
        headers,
        body,
        target,
      );
      assert.equal(response.status, 502, response.body);
      assert.deepEqual(JSON.parse(response.body), {
        error: "SSO service is unavailable",
      });
    }
  } finally {
    await unreachable.close();
  }
});

test("requests are refused without contacting Dex while it is stopped", async () => {
  forwarded.length = 0;
  dexRunning = false;
  try {
    for (const path of ["/dex", "/dex/auth?client_id=werkyn"]) {
      const response = await send("GET", path);
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.body), {
        error: "SSO service is not running",
      });
    }
  } finally {
    dexRunning = true;
  }
  assert.equal(forwarded.length, 0);
});
