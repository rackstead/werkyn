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
const { env } = await import("../src/config/env.ts");
let handleError;
await errors({
  setErrorHandler(handler) {
    handleError = handler;
  },
});

function capture(
  error,
  contentType = "application/octet-stream",
  { headersSent = false, pendingDisposition = true, stageRaw = true } = {},
) {
  const headers = new Map([
    ["content-type", contentType],
    ["cache-control", "private, no-store"],
    ["content-security-policy", "sandbox"],
    ["x-content-type-options", "nosniff"],
  ]);
  const disposition = 'attachment; filename="fixture.txt"';
  if (pendingDisposition) headers.set("content-disposition", disposition);
  const rawHeaders = stageRaw
    ? new Map([...headers, ["content-disposition", disposition]])
    : new Map();
  const rawRemovals = [],
    logged = [];
  const reply = {
    headers,
    rawHeaders,
    rawRemovals,
    logged,
    raw: {
      headersSent,
      removeHeader(name) {
        assert.equal(
          headersSent,
          false,
          "Committed raw headers must stay untouched",
        );
        rawRemovals.push(name.toLowerCase());
        rawHeaders.delete(name.toLowerCase());
      },
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
  handleError(
    error,
    {
      log: {
        error(value) {
          logged.push(value);
        },
      },
    },
    reply,
  );
  return reply;
}

const cases = [
  [
    "application missing resource",
    new NotFoundError("Missing fixture"),
    404,
    {
      statusCode: 404,
      error: "Not Found",
      message: "Missing fixture",
    },
  ],
  [
    "application validation",
    new ValidationError("Invalid fixture", [
      { field: "name", message: "Required" },
    ]),
    400,
    {
      statusCode: 400,
      error: "Bad Request",
      message: "Invalid fixture",
      details: [{ field: "name", message: "Required" }],
    },
  ],
  [
    "locked resource",
    new LockedError("Locked fixture", 12),
    423,
    {
      statusCode: 423,
      error: "Locked",
      message: "Locked fixture",
    },
  ],
  [
    "Zod validation",
    new ZodError([{ code: "custom", path: ["name"], message: "Required" }]),
    400,
    {
      statusCode: 400,
      error: "Bad Request",
      message: "Validation failed",
      details: [{ field: "name", message: "Required" }],
    },
  ],
  [
    "Fastify validation",
    Object.assign(new Error("Invalid fixture"), { validation: [{}] }),
    400,
    { statusCode: 400, error: "Bad Request", message: "Invalid fixture" },
  ],
  [
    "explicit HTTP status",
    Object.assign(new Error("Slow down"), { statusCode: 429 }),
    429,
    { statusCode: 429, error: "Slow down", message: "Slow down" },
  ],
  ["unexpected error", new Error("Fixture failure"), 500],
];

for (const [name, error, status, expected] of cases) {
  test(`${name} resets a download response to JSON and preserves security headers`, () => {
    const reply = capture(error);
    assert.equal(reply.headers.get("content-type"), "application/json");
    assert.equal(reply.headers.has("content-disposition"), false);
    assert.equal(reply.rawHeaders.has("content-disposition"), false);
    assert.deepEqual(reply.rawRemovals, ["content-disposition"]);
    assert.equal(reply.statusCode, status);
    assert.equal(reply.payload.statusCode, status);
    assert.equal(reply.headers.get("cache-control"), "private, no-store");
    assert.equal(reply.headers.get("content-security-policy"), "sandbox");
    assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
    if (error instanceof LockedError)
      assert.equal(reply.headers.get("retry-after"), "12");
    if (error instanceof ValidationError)
      assert.deepEqual(reply.payload.details, error.details);
    if (expected) {
      assert.deepEqual(reply.payload, expected);
      assert.deepEqual(reply.logged, []);
    } else {
      assert.deepEqual(reply.payload, {
        statusCode: 500,
        error: "Internal Server Error",
        message: "Fixture failure",
        stack: error.stack,
      });
      assert.deepEqual(reply.logged, [error]);
    }
  });
}

test("an ordinary JSON error retains its status and body", () => {
  const reply = capture(
    new NotFoundError("Missing fixture"),
    "application/json",
    { pendingDisposition: false, stageRaw: false },
  );
  assert.equal(reply.statusCode, 404);
  assert.deepEqual(reply.payload, {
    statusCode: 404,
    error: "Not Found",
    message: "Missing fixture",
  });
});

test("a disposition staged only on raw Node response is cleared before JSON output", () => {
  const reply = capture(new NotFoundError("Missing fixture"), "image/png", {
    pendingDisposition: false,
  });
  assert.equal(reply.headers.get("content-type"), "application/json");
  assert.equal(reply.rawHeaders.has("content-disposition"), false);
  assert.deepEqual(reply.rawRemovals, ["content-disposition"]);
  assert.equal(reply.rawHeaders.get("cache-control"), "private, no-store");
  assert.equal(reply.rawHeaders.get("content-security-policy"), "sandbox");
  assert.equal(reply.rawHeaders.get("x-content-type-options"), "nosniff");
});

test("already committed raw headers are never mutated by header cleanup", () => {
  const reply = capture(
    new NotFoundError("Missing fixture"),
    "application/zip",
    {
      headersSent: true,
    },
  );
  assert.deepEqual(reply.rawRemovals, []);
  assert.equal(reply.rawHeaders.get("content-type"), "application/zip");
  assert.equal(
    reply.rawHeaders.get("content-disposition"),
    'attachment; filename="fixture.txt"',
  );
});

test("production unexpected errors retain generic redaction and server-side logging", () => {
  const previous = env.NODE_ENV;
  const error = new Error(
    "Private fixture path must stay out of the production response",
  );
  env.NODE_ENV = "production";
  try {
    const reply = capture(error);
    assert.deepEqual(reply.payload, {
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
    assert.deepEqual(reply.logged, [error]);
    assert.equal(reply.headers.get("content-type"), "application/json");
    assert.equal(reply.headers.has("content-disposition"), false);
    assert.equal(reply.rawHeaders.has("content-disposition"), false);
  } finally {
    env.NODE_ENV = previous;
  }
});

test("the fixed JSON contract handles early stream failures and preserves successful downloads", async () => {
  // An older handler stops at this safe assertion, before opening a missing
  // file stream. The real HTTP checks exercise only the corrected contract.
  const contract = capture(new Error("Fixture failure"));
  assert.equal(contract.headers.get("content-type"), "application/json");
  assert.equal(contract.headers.has("content-disposition"), false);
  assert.equal(contract.rawHeaders.has("content-disposition"), false);
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
