import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const multipartRequire = createRequire(require.resolve("@fastify/multipart"));
const Busboy = multipartRequire("@fastify/busboy");

test("the production multipart plugin resolves a patched stable parser in its supported major", () => {
  const { version } = multipartRequire("@fastify/busboy/package.json");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = version.split(".").map(Number);
  assert.equal(major, 3);
  assert.ok(minor > 2 || (minor === 2 && patch >= 1), version);
});

for (const length of [1, 70]) {
  test(`fragmented valid multipart fields retain Unicode at boundary length ${length}`, async () => {
    const boundary = "b".repeat(length);
    const value = "fixture snowman \u2603";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${value}\r\n--${boundary}--\r\n`,
    );
    const parser = Busboy({
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      limits: { fields: 1, fieldSize: 64 },
    });
    const fields = [];
    parser.on("field", (name, parsedValue) => fields.push([name, parsedValue]));
    const completed = once(parser, "finish");
    for (let offset = 0; offset < body.length; offset += 3) {
      parser.write(body.subarray(offset, offset + 3));
    }
    parser.end();
    await completed;
    assert.deepEqual(fields, [["description", value]]);
  });
}
