import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ZodError } from "zod";
import { LocalStorageProvider } from "../src/services/storage.ts";
import {
  LockedError,
  NotFoundError,
  ValidationError,
} from "../src/utils/errors.ts";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://unused:unused@127.0.0.1:1/unit_test";
process.env.JWT_SECRET = "unit-error-response-jwt-secret";
process.env.COOKIE_SECRET = "unit-error-response-cookie-secret";
const { default: errors } = await import("../src/plugins/errors.ts");
let handleError;
await errors({
  setErrorHandler(handler) {
    handleError = handler;
  },
});

function capture(error, contentType = "application/octet-stream") {
  const headers = new Map([
    ["content-type", contentType],
    ["content-disposition", 'attachment; filename="fixture.txt"'],
    ["cache-control", "private, no-store"],
    ["content-security-policy", "sandbox"],
    ["x-content-type-options", "nosniff"],
  ]);
  const reply = {
    headers,
    raw: {
      headersSent: false,
      removeHeader() {},
    },
    type(value) {
      headers.set("content-type", value);
      return this;
    },
    header(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.payload = value;
      return this;
    },
  };
  // Capture the real error handler's response without serializing a binary body,
  // opening a listener or exercising a failing live stream.
  handleError(error, { log: { error() {} } }, reply);
  return reply;
}

const cases = [
  ["application missing resource", new NotFoundError("Missing fixture"), 404],
  [
    "application validation",
    new ValidationError("Invalid fixture", [
      { field: "name", message: "Required" },
    ]),
    400,
  ],
  ["locked resource", new LockedError("Locked fixture", 12), 423],
  [
    "Zod validation",
    new ZodError([{ code: "custom", path: ["name"], message: "Required" }]),
    400,
  ],
  [
    "Fastify validation",
    Object.assign(new Error("Invalid fixture"), { validation: [{}] }),
    400,
  ],
  [
    "explicit HTTP status",
    Object.assign(new Error("Slow down"), { statusCode: 429 }),
    429,
  ],
  ["unexpected error", new Error("Fixture failure"), 500],
];

for (const [name, error, status] of cases) {
  test(`${name} resets a download response to JSON and preserves security headers`, () => {
    const reply = capture(error);
    assert.equal(reply.headers.get("content-type"), "application/json");
    assert.equal(reply.headers.has("content-disposition"), false);
    assert.equal(reply.statusCode, status);
    assert.equal(reply.payload.statusCode, status);
    assert.equal(reply.headers.get("cache-control"), "private, no-store");
    assert.equal(reply.headers.get("content-security-policy"), "sandbox");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    if (error instanceof LockedError)
      assert.equal(reply.headers.get("retry-after"), "12");
    if (error instanceof ValidationError)
      assert.deepEqual(reply.payload.details, error.details);
  });
}

test("an ordinary JSON error retains its status and body", () => {
  const reply = capture(
    new NotFoundError("Missing fixture"),
    "application/json",
  );
  assert.equal(reply.statusCode, 404);
  assert.deepEqual(reply.payload, {
    statusCode: 404,
    error: "Not Found",
    message: "Missing fixture",
  });
});

test("the fixed JSON contract handles early stream failures and preserves successful downloads", async () => {
  // An older handler stops at this safe assertion, before opening a missing
  // file stream. The real HTTP checks exercise only the corrected contract.
  assert.equal(
    capture(new Error("Fixture failure")).headers.get("content-type"),
    "application/json",
  );
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "werkyn-error-response-"),
  );
  const storage = new LocalStorageProvider(directory);
  const app = Fastify({ logger: false });
  try {
    const bytes = Buffer.from("A harmless successful file fixture.");
    const saved = await storage.save("fixtures", "own", "file", ".txt", bytes);
    await app.register(errors);
    app.get("/healthy", () => ({ healthy: true }));
    for (const [name, mime, disposition] of [
      ["file", "application/octet-stream", "attachment"],
      ["inline", "image/png", "inline"],
      ["archive", "application/zip", "attachment"],
    ]) {
      app.get(`/missing-${name}`, (_request, reply) =>
        reply
          .type(mime)
          .header(
            "Content-Disposition",
            `${disposition}; filename="fixture.txt"`,
          )
          .header("Cache-Control", "private, no-store")
          .header("Content-Security-Policy", "sandbox")
          .header("X-Content-Type-Options", "nosniff")
          .send(storage.readStream("absent.txt")),
      );
    }
    app.get("/file", (_request, reply) =>
      reply
        .type("application/octet-stream")
        .header("Content-Disposition", 'attachment; filename="fixture.txt"')
        .send(storage.readStream(saved)),
    );
    for (const name of ["file", "inline", "archive"]) {
      const response = await app.inject(`/missing-${name}`);
      assert.equal(response.statusCode, 500);
      assert.match(response.headers["content-type"], /^application\/json/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.equal(response.json().statusCode, 500);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.equal(response.headers["content-security-policy"], "sandbox");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.deepEqual((await app.inject("/healthy")).json(), {
        healthy: true,
      });
    }
    const response = await app.inject("/file");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, bytes);
    assert.equal(response.headers["content-type"], "application/octet-stream");
    assert.equal(
      response.headers["content-disposition"],
      'attachment; filename="fixture.txt"',
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
