import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const pluginRequire = createRequire(require.resolve("@fastify/multipart"));

test("the production multipart parser includes the metadata security release", () => {
  const { version } = pluginRequire("@fastify/busboy/package.json");
  assert.match(version, /^3\.\d+\.\d+$/);
  const [, minor, patch] = version.split(".").map(Number);
  assert.ok(minor > 2 || (minor === 2 && patch >= 2), version);
});

test("ASCII and Unicode filenames retain metadata, fallback behavior and bytes", async () => {
  const app = require("fastify")();
  app.register(require("@fastify/multipart"), {
    limits: { files: 1, fileSize: 1024 },
  });
  app.post("/fixture", async (request) => {
    const part = await request.file();
    return {
      fieldname: part.fieldname,
      filename: part.filename,
      mimetype: part.mimetype,
      bytes: (await part.toBuffer()).toString("base64"),
    };
  });
  try {
    await app.ready();
    const content = Buffer.from("bounded fixture \u2603");
    for (const [parameters, filename] of [
      ['filename="quarterly report.txt"', "quarterly report.txt"],
      ['filename="snowman-\u2603.txt"', "snowman-\u2603.txt"],
      [
        "filename=\"fallback.txt\"; filename*=UTF-8''snowman-%E2%98%83.txt",
        "fallback.txt",
      ],
    ]) {
      const boundary = "metadata-fixture";
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="document"; ${parameters}\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/fixture",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), {
        fieldname: "document",
        filename,
        mimetype: "text/plain",
        bytes: content.toString("base64"),
      });
    }
  } finally {
    await app.close();
  }
});
