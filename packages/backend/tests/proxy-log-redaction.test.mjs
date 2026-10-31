import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";

const seen = [];
const upstream = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    seen.push({
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    if (request.url.startsWith("/dex/disconnect")) {
      request.socket.destroy();
      return;
    }
    response.writeHead(request.url.startsWith("/dex/rejected") ? 500 : 200, {
      "content-type": "text/plain",
      "x-upstream-context": "retained",
    });
    response.end("fixture response");
  });
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");

Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "debug",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
  JWT_SECRET: "proxy-log-test-jwt",
  COOKIE_SECRET: "proxy-log-test-cookie",
  DEX_INTERNAL_PORT: String(upstream.address().port),
});
const { getLoggerConfig } = await import("../src/plugins/logger.ts");
const { createLogger } = await import("../src/utils/logger.ts");
const { dexManager } = await import("../src/services/dex-manager.ts");
const { default: dexProxy } = await import("../src/plugins/dex-proxy.ts");
Object.defineProperty(dexManager, "isRunning", {
  configurable: true,
  get: () => true,
});

function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    text: () => lines.join(""),
    records: () => lines.join("").trim().split("\n").map(JSON.parse),
  };
}

test.after(async () => {
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});

test("actual Dex proxy redacts structured source while forwarding the exact target, body and allowed headers", async () => {
  const sink = capture();
  const app = Fastify({
    logger: { ...getLoggerConfig(), stream: sink.stream },
  });
  await app.register(dexProxy);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const secrets = [];
  const cases = [
    ["/dex/auth", "state", "nonce", "code_challenge"],
    ["/dex/auth/mock", "state", "nonce", "code_challenge"],
    ["/dex/callback", "code", "state", "session_state"],
    ["/dex/token", "access_token", "refresh_token", "client_secret"],
    ["/dex/rejected", "%63%6F%64%65", "StAtE", "n%6Fnce"],
    ["/dex/disconnect", "token", "CoDe", "state"],
  ];
  try {
    for (const [index, [path, ...names]] of cases.entries()) {
      const credentials = names.map((name, item) => {
        const value = `c05-proxy-${index}-${item}-private%2Bbytes`;
        secrets.push(value, decodeURIComponent(value));
        return `${name}=${value}`;
      });
      const target = `${path}?client_id=werkyn&scope=openid%20email&${credentials.join("&")}&safe=keep%2Bexact`;
      const body = Buffer.from(
        `login=fixture%40example.test&password=c05-form-private%26bytes&state=${index}`,
      );
      const cookie = "dex_session=c05-cookie-private";
      secrets.push("c05-form-private", "c05-cookie-private");
      const response = await new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: app.server.address().port,
            path: target,
            method: "POST",
            agent: false,
            headers: {
              "content-type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "content-length": body.length,
              cookie,
              "x-correlation-fixture": `c05-${index}`,
            },
          },
          (incoming) => {
            incoming.resume();
            incoming.on("end", () => resolve(incoming));
          },
        );
        request.setTimeout(5000, () =>
          request.destroy(new Error("loopback proxy timed out")),
        );
        request.on("error", reject);
        request.end(body);
      });
      assert.equal(
        response.statusCode,
        path === "/dex/disconnect" ? 502 : path === "/dex/rejected" ? 500 : 200,
      );
      const forwarded = seen.at(-1);
      assert.equal(forwarded.url, target);
      assert.deepEqual(forwarded.body, body);
      assert.equal(forwarded.headers.cookie, cookie);
      assert.equal(
        forwarded.headers["content-type"],
        "application/x-www-form-urlencoded; charset=UTF-8",
      );
      assert.equal(Number(forwarded.headers["content-length"]), body.length);
      assert.equal(forwarded.headers["x-correlation-fixture"], `c05-${index}`);
    }
    const records = sink.records();
    const sources = records.filter(
      (record) => record.msg === "fetching from remote server",
    );
    assert.equal(sources.length, cases.length);
    const proof = {
      fixture:
        "actual dex-proxy plugin, loopback-only HTTP server, getLoggerConfig JSON capture",
      sourceRecords: sources.map((record) => {
        const [path, query] = record.source.split("?");
        const parameters = [...new URLSearchParams(query)];
        return {
          path,
          rawSensitiveFields: parameters
            .filter(([, value]) => value.startsWith("c05-proxy-"))
            .map(([name]) => name),
          redactedFields: parameters
            .filter(([, value]) => value === "[REDACTED]")
            .map(([name]) => name),
          requestIdPresent: typeof record.reqId === "string",
        };
      }),
      upstreamExactTargetsBodiesAndAllowedHeaders: cases.length,
      upstream500AndDisconnected502: true,
      rawSyntheticValuesInLogs: [...new Set(secrets)].filter((value) =>
        sink.text().includes(value),
      ).length,
      fixtureValuesOmitted: true,
    };
    if (process.env.PROXY_LOG_PROOF)
      await writeFile(
        process.env.PROXY_LOG_PROOF,
        JSON.stringify(proof, null, 2) + "\n",
      );
    for (const record of sources) {
      assert.ok(record.reqId);
      assert.match(record.source, /client_id=werkyn&scope=openid%20email/);
      assert.match(record.source, /safe=keep%2Bexact$/);
      assert.match(record.source, /\[REDACTED\]/);
    }
    assert.ok(
      records.some(
        (record) =>
          record.msg === "response errored" &&
          record.err?.message &&
          record.err?.stack,
      ),
    );
    assert.ok(
      records.some((record) => record.req?.url?.includes("code=[REDACTED]")),
    );
    assert.ok(
      records.some(
        (record) =>
          record.msg === "request completed" && record.res?.statusCode === 502,
      ),
    );
    for (const value of secrets)
      assert.equal(
        sink.text().includes(value),
        false,
        `raw fixture value in logs: ${value}`,
      );
  } finally {
    await app.close();
  }
});

test("structured URL siblings and messages share redaction at every level without mutating callers", () => {
  const sink = capture();
  process.env.LOG_LEVEL = "trace";
  const log = createLogger(sink.stream);
  process.env.LOG_LEVEL = "debug";
  const urls = [
    "/api/auth/reset-password/c05-reset-private?view=keep",
    "/api/invites/c05-invite-private?view=keep",
    "https://werkyn.example/api/public/files/c05-public-private?view=keep",
    "/api/public/wiki/c05-wiki-private?view=keep",
    "/api/auth/oidc/callback?%63ode=c05-code-private&StAtE=c05-state-private&view=keep",
  ];
  const shared = Object.freeze({ count: 3 });
  for (const [index, level] of [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ].entries()) {
    const url = urls[index % urls.length];
    const context = Object.freeze({
      source: url,
      url,
      previewUrl: url,
      msg: `fetch ${url}`,
      message: `fetch ${url}`,
      shared,
      requestId: `context-${index}`,
    });
    log[level](context);
    assert.equal(context.source, url);
    assert.equal(context.url, url);
    assert.equal(context.previewUrl, url);
    assert.equal(context.msg, `fetch ${url}`);
    assert.equal(context.message, `fetch ${url}`);
    assert.equal(context.shared, shared);
  }
  const error = Object.assign(
    new Error("GET /dex/callback?code=c05-error-private&view=keep"),
    {
      source: "/dex/auth?state=c05-error-state-private&view=keep",
      url: "/api/invites/c05-error-invite-private?view=keep",
      code: "UPSTREAM_FAILURE",
      statusCode: 502,
    },
  );
  const original = {
    message: error.message,
    stack: error.stack,
    source: error.source,
    url: error.url,
  };
  log.error({ err: error, source: error.source }, "gateway failed");
  log.error(error);
  assert.deepEqual(
    {
      message: error.message,
      stack: error.stack,
      source: error.source,
      url: error.url,
    },
    original,
  );
  const records = sink.records();
  assert.deepEqual(
    records.slice(0, 6).map((record) => record.level),
    [10, 20, 30, 40, 50, 60],
  );
  for (const record of records.slice(0, 6)) {
    assert.equal(record.shared.count, 3);
    assert.ok(record.requestId.startsWith("context-"));
    for (const field of ["source", "url", "previewUrl", "msg", "message"]) {
      assert.match(record[field], /view=keep/);
      assert.match(record[field], /\[REDACTED\]/);
    }
  }
  assert.equal(records.at(-1).err.code, "UPSTREAM_FAILURE");
  assert.equal(records.at(-1).err.statusCode, 502);
  assert.match(records.at(-1).err.stack, /Error: GET/);
  assert.doesNotMatch(sink.text(), /c05-[\w-]+-private/);
});

test("an undefined structured message keeps the error fallback redacted and defined messages selected", () => {
  const sink = capture();
  const log = createLogger(sink.stream);
  const error = new Error(
    "GET /api/auth/oidc/callback?code=c05-undefined-private&view=keep",
  );
  const message = error.message;
  const stack = error.stack;
  const context = Object.freeze({
    err: error,
    msg: undefined,
    requestId: "undefined-message-context",
  });
  log.error(context);
  log.error({ err: error, msg: "explicit context" });
  log.error({ err: error, msg: null });
  log.error(context, "explicit argument");
  const records = sink.records();
  assert.deepEqual(
    records.map((record) => record.msg),
    [
      "GET /api/auth/oidc/callback?code=[REDACTED]&view=keep",
      "explicit context",
      null,
      "explicit argument",
    ],
  );
  assert.equal(records[0].requestId, "undefined-message-context");
  assert.equal(context.err, error);
  assert.equal(context.msg, undefined);
  assert.equal(error.message, message);
  assert.equal(error.stack, stack);
  for (const record of records) {
    assert.equal(record.err.type, "Error");
    assert.match(record.err.stack, /Error: GET/);
  }
  assert.doesNotMatch(sink.text(), /c05-undefined-private/);
});

test("development pretty transports retain safe context and redact standalone and Fastify URL fields", async () => {
  const script = `
    import Fastify from 'fastify';
    const { createLogger } = await import('./src/utils/logger.ts');
    const { getLoggerConfig } = await import('./src/plugins/logger.ts');
    const log = createLogger();
    log.info({ source: '/dex/auth?nonce=c05-dev-private&safe=keep' }, 'standalone context');
    const app = Fastify({ logger: getLoggerConfig() });
    app.get('/fixture', async (request) => {
      request.log.warn({ source: '/dex/callback?code=c05-dev-private&safe=keep', previewUrl: '/invite/c05-dev-private?view=keep' }, 'request context');
      return { ok: true };
    });
    await app.inject('/fixture?state=c05-dev-private&view=keep');
    await app.close();
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NODE_ENV: "development" },
      timeout: 15000,
    },
  );
  assert.doesNotMatch(stdout + stderr, /c05-dev-private/);
  assert.match(stdout, /standalone context/);
  assert.match(stdout, /request context/);
  assert.match(stdout, /safe=keep/);
  assert.match(stdout, /\[REDACTED\]/);
});
