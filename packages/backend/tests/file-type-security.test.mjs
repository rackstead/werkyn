import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

test("avatar detection resolves the stable ASF-fixed file-type release in its supported major", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("package.json", import.meta.resolve("file-type")), "utf8"),
  );
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = metadata.version.split(".").map(Number);
  assert.equal(major, 21);
  assert.ok(minor > 3 || (minor === 3 && patch >= 1), metadata.version);
});

for (const [format, ext, mime] of [
  ["png", "png", "image/png"],
  ["jpeg", "jpg", "image/jpeg"],
  ["gif", "gif", "image/gif"],
  ["webp", "webp", "image/webp"],
]) {
  test(`avatar detection preserves an ordinary ${format} image`, async () => {
    const bytes = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 30, g: 60, b: 90, alpha: 1 },
      },
    })
      .toFormat(format)
      .toBuffer();
    assert.deepEqual(await fileTypeFromBuffer(bytes), { ext, mime });
  });
}

test("ordinary text and SVG do not become allowed avatar raster formats", async () => {
  for (const value of [
    "A harmless text fixture without an image signature.",
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  ]) {
    assert.equal(await fileTypeFromBuffer(Buffer.from(value)), undefined);
  }
});
