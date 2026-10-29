import AdmZip from "adm-zip";
import { ValidationError } from "../../utils/errors.js";

const MiB = 1024 * 1024;

/**
 * What one uploaded backup ZIP may ask the server to hold. Werkyn's exports
 * contain `backup.json` plus one `assets/<file>` entry per embedded upload, so
 * every limit leaves wide headroom (see docs/remediation/sec-025.md).
 */
export const BACKUP_ARCHIVE_LIMITS = Object.freeze({
  /**
   * Entries, counting the parent folders adm-zip creates for each name. adm-zip
   * keeps roughly 9 KiB of heap per entry or folder.
   */
  maxEntries: 10_000,
  /** Raw name bytes. Exported names are "assets/" plus one stored file name. */
  maxNameBytes: 1024,
  /** Segments split on "/" or "\". Exported names have at most two. */
  maxPathSegments: 16,
  /** Declared uncompressed size of one entry; V8 cannot parse a longer JSON text. */
  maxEntryBytes: 512 * MiB,
  /** Declared uncompressed size of all entries; a restore holds them in memory. */
  maxTotalBytes: 1024 * MiB,
});

export type BackupArchiveLimits = typeof BACKUP_ARCHIVE_LIMITS;

export const ARCHIVE_INVALID_MESSAGE =
  "Invalid backup ZIP: the archive is damaged or uses unsupported ZIP features";
export const ARCHIVE_TOO_LARGE_MESSAGE =
  "Invalid backup ZIP: the archive exceeds the restore limits";

/** A rejected archive. `reason` is a fixed code for logs, never archive text. */
export class BackupArchiveError extends ValidationError {
  constructor(
    readonly reason: string,
    overBudget = false,
  ) {
    super(overBudget ? ARCHIVE_TOO_LARGE_MESSAGE : ARCHIVE_INVALID_MESSAGE);
  }
}

const invalid = (reason: string) => new BackupArchiveError(reason);
const tooLarge = (reason: string) => new BackupArchiveError(reason, true);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const ZIP64_END_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const END_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const STORED = 0;
const DEFLATED = 8;
const DATA_DESCRIPTOR = 0x0008;
/** Compression options (bits 1-2), data descriptor (3) and UTF-8 names (11). */
const ALLOWED_FLAGS = 0x0006 | DATA_DESCRIPTOR | 0x0800;
const ZIP64_EXTRA = 0x0001;

export interface BackupArchiveEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  size: number;
  compressedSize: number;
  localOffset: number;
}

/**
 * Walk the end record, central directory and local headers without inflating
 * anything, and reject the archive unless it is unambiguous, uses only the ZIP
 * features Werkyn's exports use, and fits `limits`. The checks follow the way
 * adm-zip locates and reads the same records, so it sees the same entries.
 */
export function inspectBackupArchive(
  buffer: Buffer,
  limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
): BackupArchiveEntry[] {
  // adm-zip takes the last end-record signature within the maximum comment
  // length of the end, then looks up to 20 bytes earlier for a zip64 locator
  // or another end record. Refuse anything that would change its choice.
  const lowest = Math.max(0, buffer.length - END_SIZE - 0xffff);
  let end = -1;
  for (let i = buffer.length - END_SIZE; i >= lowest; i--) {
    if (buffer[i] === 0x50 && buffer.readUInt32LE(i) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid("no-end-record");
  for (let i = Math.max(0, end - 20); i < end; i++) {
    const signature = buffer.readUInt32LE(i);
    if (signature === ZIP64_LOCATOR_SIG || signature === ZIP64_END_SIG) {
      throw invalid("zip64");
    }
    if (signature === END_SIG) throw invalid("ambiguous-end-record");
  }

  const diskNumber = buffer.readUInt16LE(end + 4);
  const directoryDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8);
  const totalEntries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const commentLength = buffer.readUInt16LE(end + 20);
  if (
    diskEntries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw invalid("zip64");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) {
    throw invalid("multi-disk");
  }
  if (end + END_SIZE + commentLength !== buffer.length) {
    throw invalid("trailing-data");
  }
  if (directoryOffset + directorySize !== end) {
    throw invalid("directory-extent");
  }
  if (diskEntries > limits.maxEntries) throw tooLarge("entry-count");
  if (diskEntries * CENTRAL_SIZE > directorySize) {
    throw invalid("directory-truncated");
  }

  const entries: BackupArchiveEntry[] = [];
  const explicitNames = new Set<string>();
  // Explicit names plus the parent folders adm-zip adds for each of them.
  const nodes = new Set<string>();
  const extents: Array<[start: number, end: number]> = [];
  let totalBytes = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < diskEntries; index++) {
    if (cursor + CENTRAL_SIZE > end || buffer.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw invalid("directory-truncated");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const recordEnd = extraStart + extraLength + entryCommentLength;
    if (recordEnd > end) throw invalid("directory-truncated");
    cursor = recordEnd;

    if (nameLength === 0) throw invalid("empty-name");
    if (nameLength > limits.maxNameBytes) throw tooLarge("name-length");
    const rawName = buffer.subarray(nameStart, extraStart);
    let segments = 1;
    for (const byte of rawName) if (byte === 0x2f || byte === 0x5c) segments++;
    if (segments > limits.maxPathSegments) throw tooLarge("path-depth");

    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk === 0xffff
    ) {
      throw invalid("zip64");
    }
    if (startDisk !== 0) throw invalid("multi-disk");
    if (flags & ~ALLOWED_FLAGS) throw invalid("unsupported-flags");
    if (method !== STORED && method !== DEFLATED) throw invalid("unsupported-method");
    if (method === STORED && compressedSize !== size) throw invalid("stored-size");
    checkExtraFields(buffer.subarray(extraStart, extraStart + extraLength));

    if (size > limits.maxEntryBytes) throw tooLarge("entry-size");
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) throw tooLarge("total-size");

    // adm-zip decodes every name as UTF-8 and refuses a repeated decoded name.
    const name = rawName.toString("utf8");
    if (explicitNames.has(name)) throw invalid("duplicate-name");
    explicitNames.add(name);
    nodes.add(name);
    const folders = name.split("/");
    folders.pop();
    for (let depth = 1; depth <= folders.length; depth++) {
      nodes.add(`${folders.slice(0, depth).join("/")}/`);
    }
    if (nodes.size > limits.maxEntries) throw tooLarge("entry-count");

    const dataEnd = checkLocalHeader(buffer, directoryOffset, {
      localOffset,
      rawName,
      flags,
      method,
      crc,
      compressedSize,
      size,
    });
    extents.push([localOffset, dataEnd]);
    const last = rawName[rawName.length - 1];
    entries.push({
      name,
      isDirectory: last === 0x2f || last === 0x5c,
      method,
      size,
      compressedSize,
      localOffset,
    });
  }
  if (cursor !== end) throw invalid("directory-extent");

  // Entries that share bytes let a small archive declare the same data twice.
  extents.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < extents.length; i++) {
    if (extents[i][0] < extents[i - 1][1]) throw invalid("overlapping-entries");
  }
  return entries;
}

/** Extra fields must be well formed and must not carry zip64 sizes. */
function checkExtraFields(extra: Buffer) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw invalid("extra-field");
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (offset + 4 + length > extra.length) throw invalid("extra-field");
    if (id === ZIP64_EXTRA) throw invalid("zip64");
    offset += 4 + length;
  }
}

/** Validate an entry's local header and return the end of its data. */
function checkLocalHeader(
  buffer: Buffer,
  directoryOffset: number,
  entry: {
    localOffset: number;
    rawName: Buffer;
    flags: number;
    method: number;
    crc: number;
    compressedSize: number;
    size: number;
  },
): number {
  const at = entry.localOffset;
  if (at + LOCAL_SIZE > directoryOffset || buffer.readUInt32LE(at) !== LOCAL_SIG) {
    throw invalid("local-header");
  }
  const flags = buffer.readUInt16LE(at + 6);
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const nameStart = at + LOCAL_SIZE;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryOffset) throw invalid("local-extent");
  if (flags & ~ALLOWED_FLAGS) throw invalid("unsupported-flags");
  if (
    buffer.readUInt16LE(at + 8) !== entry.method ||
    !buffer.subarray(nameStart, nameStart + nameLength).equals(entry.rawName)
  ) {
    throw invalid("local-mismatch");
  }
  // Without a data descriptor adm-zip checks the local checksum, so it must
  // agree with the central directory that the size checks above relied on.
  if (
    !((flags | entry.flags) & DATA_DESCRIPTOR) &&
    (buffer.readUInt32LE(at + 14) !== entry.crc ||
      buffer.readUInt32LE(at + 18) !== entry.compressedSize ||
      buffer.readUInt32LE(at + 22) !== entry.size)
  ) {
    throw invalid("local-mismatch");
  }
  return dataEnd;
}

export interface BackupArchiveContents {
  jsonBuffer: Buffer;
  assets: Map<string, Buffer>;
}

/**
 * Read `backup.json` and every `assets/` file from an uploaded backup ZIP.
 * The archive is inspected before adm-zip parses it, and each entry must
 * inflate to exactly its declared size, so reading stays within `limits`.
 * Every rejection is a 400 with a fixed message.
 */
export function readBackupArchive(
  buffer: Buffer,
  limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
): BackupArchiveContents {
  const inspected = inspectBackupArchive(buffer, limits);
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    // Both readers must agree on every entry before any data is read.
    if (
      entries.length !== inspected.length ||
      entries.some(
        (entry, index) =>
          entry.entryName !== inspected[index].name ||
          entry.header.size !== inspected[index].size ||
          entry.header.compressedSize !== inspected[index].compressedSize ||
          entry.header.offset !== inspected[index].localOffset,
      )
    ) {
      throw invalid("reader-mismatch");
    }

    let readBytes = 0;
    // adm-zip stops inflating at the declared size; a shorter result is a lie
    // about the size that the budget was checked against.
    const read = (index: number) => {
      const data = entries[index].getData();
      if (data.length !== inspected[index].size) throw invalid("size-mismatch");
      readBytes += data.length;
      if (readBytes > limits.maxTotalBytes) throw tooLarge("total-size");
      return data;
    };

    const jsonIndex = inspected.findIndex((entry) => entry.name === "backup.json");
    if (jsonIndex < 0) {
      throw new ValidationError("Invalid backup ZIP: missing backup.json");
    }
    const jsonBuffer = read(jsonIndex);
    const assets = new Map<string, Buffer>();
    inspected.forEach((entry, index) => {
      if (entry.name.startsWith("assets/") && !entry.isDirectory) {
        assets.set(entry.name, read(index));
      }
    });
    return { jsonBuffer, assets };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // adm-zip and zlib messages can quote entry names; never pass them on.
    throw invalid("read-failed");
  }
}
