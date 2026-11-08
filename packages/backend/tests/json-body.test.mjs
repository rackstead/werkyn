import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "json-body-unit-jwt-secret";
process.env.COOKIE_SECRET = "json-body-unit-cookie-secret";

const { installJsonBodyParser } = await import("../src/plugins/json-body.ts");
const { default: errors } = await import("../src/plugins/errors.ts");

const PAIR = "\uD83D\uDE00";
const STORED = "The request contains a character that cannot be stored";
const INVALID_JSON = "Body is not valid JSON but content-type is set to 'application/json'";

async function app() {
  const server = Fastify({ logger: false });
  installJsonBodyParser(server);
  await server.register(errors);
  server.post("/echo", async (request) => ({ body: request.body }));
  server.post("/ok", async () => ({ ok: true }));
  await server.ready();
  return server;
}

function post(server, payload, headers = {}) {
  return server.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json", ...headers },
    payload,
  });
}

test("a lone surrogate in a JSON body is a 400 and leaks nothing", async () => {
  const server = await app();
  const bodies = [
    '{"name":"\\uD800"}',
    '{"name":"\\uDFFF"}',
    '{"nested":["ok",{"name":"\\uDC00"}]}',
    '{"\\uD800":"ok"}',
    '"\\uD800"',
    `{"name":"${PAIR}\\uD800"}`,
  ];
  for (const payload of bodies) {
    const response = await post(server, payload);
    assert.equal(response.statusCode, 400, payload);
    assert.deepEqual(response.json(), {
      statusCode: 400,
      error: "Bad Request",
      message: STORED,
    });
    assert.doesNotMatch(response.body, /prisma|SELECT |INSERT |hex escape|stack|\\uD800/i);
  }
  await server.close();
});

test("a well-formed surrogate pair and ordinary JSON are returned unchanged", async () => {
  const server = await app();
  for (const payload of [
    '{"name":"\\uD83D\\uDE00"}',
    `{"name":${JSON.stringify(PAIR)}}`,
    '{"name":"plain","items":[1,true,null]}',
    `"${PAIR}"`,
    "null",
    "0",
  ]) {
    const response = await post(server, payload);
    assert.equal(response.statusCode, 200, `${payload}: ${response.body}`);
  }
  const escaped = await post(server, '{"name":"\\\\uD800"}');
  assert.equal(escaped.statusCode, 200, escaped.body);
  assert.equal(escaped.json().body.name, "\\uD800");
  const paired = await post(server, '{"name":"\\uD83D\\uDE00"}');
  assert.equal(paired.json().body.name, PAIR);
  await server.close();
});

test("NUL stays in the parsed body", async () => {
  const server = await app();
  const response = await post(server, '{"name":"a\\u0000b"}');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().body.name, "a\u0000b");
  await server.close();
});

test("invalid and empty JSON stay 400", async () => {
  const server = await app();
  const invalid = await post(server, "{");
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().message, INVALID_JSON);
  const empty = await post(server, "");
  assert.equal(empty.statusCode, 400);
  assert.match(empty.json().message, /cannot be empty/);
  const proto = await post(server, '{"__proto__":{"admin":true}}');
  assert.equal(proto.statusCode, 400, proto.body);
  assert.equal(proto.json().message, INVALID_JSON);
  const constructor = await post(server, '{"constructor":{"prototype":{"admin":true}}}');
  assert.equal(constructor.statusCode, 400, constructor.body);
  const named = await post(server, '{"constructor":"Widget"}');
  assert.equal(named.statusCode, 200, named.body);
  assert.equal(named.json().body.constructor, "Widget");
  await server.close();
});

test("a charset on application/json still uses the JSON parser", async () => {
  const server = await app();
  const good = await post(server, '{"name":"\\uD83D\\uDE00"}', {
    "content-type": "application/json; charset=utf-8",
  });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().body.name, PAIR);
  const bad = await post(server, '{"name":"\\uD800"}', {
    "content-type": "application/json; charset=utf-8",
  });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().message, STORED);
  await server.close();
});

test("a deep JSON body is refused or accepted without a stack overflow", async () => {
  const server = await app();
  const depth = 20_000;
  const bad = `${"[".repeat(depth)}"\\uDFFF"${"]".repeat(depth)}`;
  const refused = await server.inject({
    method: "POST",
    url: "/ok",
    headers: { "content-type": "application/json" },
    payload: bad,
  });
  assert.equal(refused.statusCode, 400, refused.body.slice(0, 200));
  assert.equal(refused.json().message, STORED);
  const good = `${"[".repeat(depth)}null${"]".repeat(depth)}`;
  const accepted = await server.inject({
    method: "POST",
    url: "/ok",
    headers: { "content-type": "application/json" },
    payload: good,
  });
  assert.equal(accepted.statusCode, 200, accepted.body.slice(0, 200));
  await server.close();
});
