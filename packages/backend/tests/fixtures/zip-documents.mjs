import { PassThrough } from "node:stream";
import AdmZip from "adm-zip";
import archiver from "archiver";

// Small, harmless ZIP-based documents for content detection tests. Each format can
// be written with sizes in its local headers (AdmZip) or with trailing data
// descriptors (archiver, like streaming writers and Werkyn's own ZIP downloads).

export const MiB = 1024 * 1024;

export const ZIP_TYPE = { ext: "zip", mime: "application/zip" };

const OOXML = {
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    part: "word/document.xml",
    body: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Werkyn</w:t></w:r></w:p></w:body></w:document>',
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    part: "xl/workbook.xml",
    body: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    part: "ppt/presentation.xml",
    body: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  },
};

// The content-types entry may be padded with trailing XML whitespace to reach an
// exact uncompressed size; whitespace deflates to a few bytes per KiB.
export function contentTypesXml(format, padToBytes = 0) {
  const { mime, part } = OOXML[format];
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/${part}" ContentType="${mime}.main+xml"/>` +
    "</Types>";
  return Buffer.concat([
    Buffer.from(xml),
    Buffer.alloc(Math.max(0, padToBytes - Buffer.byteLength(xml)), 0x20),
  ]);
}

export function ooxmlEntries(format, contentTypes = contentTypesXml(format)) {
  const { part, body } = OOXML[format];
  return [
    ["[Content_Types].xml", contentTypes],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`,
    ],
    [part, body],
  ];
}

export const ZIP_DOCUMENTS = [
  ...Object.entries(OOXML).map(([ext, { mime }]) => ({
    ext,
    expected: { ext, mime },
    entries: () => ooxmlEntries(ext),
  })),
  {
    ext: "odt",
    expected: { ext: "odt", mime: "application/vnd.oasis.opendocument.text" },
    entries: () => [
      ["mimetype", "application/vnd.oasis.opendocument.text", { store: true }],
      [
        "content.xml",
        '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
      ],
      [
        "META-INF/manifest.xml",
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
      ],
    ],
  },
  {
    ext: "zip",
    expected: ZIP_TYPE,
    entries: () => [
      ["notes/readme.txt", "A harmless archive entry.\n"],
      ["notes/data.csv", "name,value\nwerkyn,1\n"],
    ],
  },
];

export function zipWithLocalSizes(entries) {
  const zip = new AdmZip();
  for (const [name, content, options] of entries) {
    zip.addFile(name, Buffer.from(content));
    if (options?.store) zip.getEntry(name).header.method = 0;
  }
  return zip.toBuffer();
}

export async function zipWithDataDescriptors(entries) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  for (const [name, content, options] of entries) {
    archive.append(Buffer.from(content), {
      name,
      store: Boolean(options?.store),
      date: new Date("2026-01-01T00:00:00Z"),
    });
  }
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}

export const ZIP_WRITERS = [
  ["local-header sizes", zipWithLocalSizes],
  ["data descriptors", zipWithDataDescriptors],
];

function localHeaderOffset(zip, entryName) {
  for (let offset = 0; offset + 30 <= zip.length; ) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) break;
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    if (zip.toString("utf8", offset + 30, offset + 30 + nameLength) === entryName) {
      return offset;
    }
    offset += 30 + nameLength + extraLength + compressedSize;
  }
  throw new Error(`No local header for ${entryName}`);
}

// Rewrites one local header so it declares a one-byte uncompressed size while its
// deflated data still expands to the real size.
export function understateUncompressedSize(zip, entryName) {
  const copy = Buffer.from(zip);
  copy.writeUInt32LE(1, localHeaderOffset(copy, entryName) + 22);
  return copy;
}

// Detection inflates ZIP entries through the global DecompressionStream; count
// every inflated byte it produces while `action` runs.
export async function countInflatedBytes(action) {
  const Original = globalThis.DecompressionStream;
  let inflatedBytes = 0;
  globalThis.DecompressionStream = class CountingDecompressionStream {
    constructor(format) {
      const inner = new Original(format);
      this.writable = inner.writable;
      this.readable = inner.readable.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            inflatedBytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
    }
  };
  try {
    const result = await action();
    return { result, inflatedBytes };
  } finally {
    globalThis.DecompressionStream = Original;
  }
}
