import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import {
  MiB,
  ZIP_DOCUMENTS,
  ZIP_TYPE,
  ZIP_WRITERS,
  contentTypesXml,
  countInflatedBytes,
  ooxmlEntries,
  understateUncompressedSize,
  zipWithDataDescriptors,
  zipWithLocalSizes,
} from "./fixtures/zip-documents.mjs";

test("avatar detection resolves the stable ASF- and ZIP-fixed file-type release in its supported major", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("package.json", import.meta.resolve("file-type")), "utf8"),
  );
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = metadata.version.split(".").map(Number);
  assert.equal(major, 21);
  assert.ok(minor > 3 || (minor === 3 && patch >= 2), metadata.version);
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

for (const [writer, write] of ZIP_WRITERS) {
  test(`ordinary ZIP-based documents written with ${writer} keep their detected types`, async () => {
    for (const { entries, expected } of ZIP_DOCUMENTS) {
      const bytes = await write(entries());
      assert.deepEqual(await fileTypeFromBuffer(bytes), expected, expected.ext);
      assert.doesNotMatch(expected.mime, /^image\//);
    }
  });
}

// The fixed release reads at most 1 MiB of an inflated ZIP probe entry. These
// fixtures stay small (a few KiB compressed, at most 8 MiB inflated) so the
// pre-upgrade behavior can be shown without exhausting memory.
function contentTypesVariants(uncompressedBytes) {
  const entries = ooxmlEntries("docx", contentTypesXml("docx", uncompressedBytes));
  const withSizes = zipWithLocalSizes(entries);
  return [
    ["declared size", async () => withSizes],
    [
      "understated size",
      async () => understateUncompressedSize(withSizes, "[Content_Types].xml"),
    ],
    ["data descriptor", () => zipWithDataDescriptors(entries)],
  ];
}

test("an OOXML content-types entry at the 1 MiB probe limit is still recognized", { timeout: 10_000 }, async () => {
  for (const [variant, build] of contentTypesVariants(MiB)) {
    const bytes = await build();
    const { result, inflatedBytes } = await countInflatedBytes(() =>
      fileTypeFromBuffer(bytes),
    );
    assert.equal(result?.ext, "docx", variant);
    assert.equal(inflatedBytes, MiB, variant);
  }
});

test("a content-types entry one byte over the probe limit falls back to generic ZIP", { timeout: 10_000 }, async () => {
  for (const [variant, build] of contentTypesVariants(MiB + 1)) {
    const bytes = await build();
    const { result, inflatedBytes } = await countInflatedBytes(() =>
      fileTypeFromBuffer(bytes),
    );
    assert.ok(inflatedBytes <= MiB + 256 * 1024, `${variant}: ${inflatedBytes}`);
    assert.deepEqual(result, ZIP_TYPE, variant);
  }
});

test("a small ZIP whose content-types entry inflates to 8 MiB is not fully inflated during detection", { timeout: 10_000 }, async () => {
  for (const [variant, build] of contentTypesVariants(8 * MiB)) {
    const bytes = await build();
    assert.ok(bytes.length < 16 * 1024, `${variant}: ${bytes.length}`);
    const { result, inflatedBytes } = await countInflatedBytes(() =>
      fileTypeFromBuffer(bytes),
    );
    assert.ok(inflatedBytes <= MiB + 256 * 1024, `${variant}: ${inflatedBytes}`);
    assert.deepEqual(result, ZIP_TYPE, variant);
  }
});
