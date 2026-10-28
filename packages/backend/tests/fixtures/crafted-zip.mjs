import zlib from "node:zlib";

const TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

/** CRC-32 of `bytes`, continuing from a previous `crc` value. */
export function crc32(bytes, crc = 0) {
  if (zlib.crc32) return zlib.crc32(bytes, crc);
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++)
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC-32 of `bytes` followed by zero bytes up to `length` in total. */
export function crc32ZeroPadded(bytes, length) {
  let crc = crc32(bytes);
  const zeros = Buffer.alloc(1 << 20);
  for (let left = length - bytes.length; left > 0; left -= zeros.length)
    crc = crc32(left >= zeros.length ? zeros : zeros.subarray(0, left), crc);
  return crc;
}

export const STORED = 0;
export const DEFLATED = 8;
export const UNIX_FILE = (0o100644 << 16) >>> 0;
export const UNIX_SYMLINK = (0o120777 << 16) >>> 0;

/**
 * Write a ZIP archive whose headers are taken verbatim from each entry, so a
 * test can declare sizes, checksums and attributes that disagree with the
 * bytes actually present.
 *
 * Entry fields: name, content (uncompressed bytes), method (STORED/DEFLATED),
 * and optional overrides data (raw entry bytes), size (declared uncompressed
 * size), compressedSize, crc and externalAttr.
 */
export function craftZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = entry.content ?? Buffer.alloc(0);
    const method = entry.method ?? STORED;
    const data =
      entry.data ??
      (method === DEFLATED ? zlib.deflateRawSync(content) : content);
    const crc = entry.crc ?? crc32(content);
    const size = entry.size ?? content.length;
    const compressedSize = entry.compressedSize ?? data.length;
    const flags = 0x0800; // UTF-8 names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressedSize >>> 0, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressedSize >>> 0, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.externalAttr ?? UNIX_FILE) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
