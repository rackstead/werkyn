import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline, Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { ValidationError } from "../../utils/errors.js";
import {
  BACKUP_JSON_LIMITS,
  BackupJsonError,
  BackupJsonMeter,
  type BackupJsonLimits,
} from "./backup-json.js";

const MiB = 1024 * 1024;

/**
 * What one uploaded backup ZIP may ask the server to read. Werkyn's exports
 * contain `backup.json` plus one `assets/<file>` entry per embedded upload, so
 * every limit leaves wide headroom (see docs/remediation/sec-025.md).
 */
export const BACKUP_ARCHIVE_LIMITS = Object.freeze({
  /**
   * Entries, counting the parent folders each name implies. The inspection
   * keeps every name and folder in memory while it checks the archive.
   */
  maxEntries: 10_000,
  /** Raw name bytes. Exported names are "assets/" plus one stored file name. */
  maxNameBytes: 1024,
  /** Segments split on "/" or "\". Exported names have at most two. */
  maxPathSegments: 16,
  /**
   * Declared uncompressed size of one entry. `backup.json` must also fit the
   * much smaller BACKUP_JSON_LIMITS.maxBytes, checked before it is inflated.
   */
  maxEntryBytes: 512 * MiB,
  /** Declared uncompressed size of all entries; a restore inflates them all. */
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
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const DATA_DESCRIPTOR = 0x0008;
/** Compression options (bits 1-2), data descriptor (3) and UTF-8 names (11). */
const ALLOWED_FLAGS = 0x0006 | DATA_DESCRIPTOR | 0x0800;
const ZIP64_EXTRA = 0x0001;
/** The central directory is read through a window of at least this size. */
const DIRECTORY_WINDOW = MiB;

export interface BackupArchiveEntry {
  name: string;
  isDirectory: boolean;
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
  localOffset: number;
  /** Where the entry's stored or deflated bytes start. */
  dataStart: number;
}

/**
 * Random access to an archive's bytes. A staged upload is read from disk in
 * small pieces, so the archive is never held in memory as a whole.
 */
interface ArchiveSource {
  readonly size: number;
  /** Up to `length` bytes at `position`; callers stay within `size`. */
  read(position: number, length: number): Promise<Buffer>;
  /** The bytes from `start` up to, not including, `end`. */
  stream(start: number, end: number): Readable;
  close(): Promise<void>;
}

const emptyStream = () => Readable.from([], { objectMode: false });

function bufferSource(buffer: Buffer): ArchiveSource {
  return {
    size: buffer.length,
    read: async (position, length) => buffer.subarray(position, position + length),
    stream: (start, end) =>
      start === end ? emptyStream() : Readable.from([buffer.subarray(start, end)], { objectMode: false }),
    close: async () => {},
  };
}

async function fileSource(file: string): Promise<ArchiveSource> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    return {
      size,
      async read(position, length) {
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled);
      },
      // Each stream opens the file itself, so assets stay readable after the
      // inspection has closed its handle.
      stream: (start, end) =>
        start === end ? emptyStream() : createReadStream(file, { start, end: end - 1 }),
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const openSource = (input: Buffer | string) =>
  typeof input === "string" ? fileSource(input) : Promise.resolve(bufferSource(input));

/** Sequential reads below `limit` through a window of at least 1 MiB. */
function windowReader(source: ArchiveSource, limit: number) {
  let windowStart = 0;
  let window: Buffer = Buffer.alloc(0);
  return async (position: number, length: number): Promise<Buffer> => {
    if (position < windowStart || position + length > windowStart + window.length) {
      window = await source.read(
        position,
        Math.min(Math.max(length, DIRECTORY_WINDOW), limit - position),
      );
      windowStart = position;
    }
    const at = position - windowStart;
    if (at + length > window.length) throw invalid("short-read");
    return window.subarray(at, at + length);
  };
}

/**
 * Walk the end record, central directory and local headers of an archive (a
 * staged file's path, or a buffer) without inflating anything, and reject the
 * archive unless it is unambiguous, uses only the ZIP features Werkyn's
 * exports use, and fits `limits`.
 */
export async function inspectBackupArchive(
  input: Buffer | string,
  limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
): Promise<BackupArchiveEntry[]> {
  const source = await openSource(input);
  try {
    return await inspectSource(source, limits);
  } finally {
    await source.close();
  }
}

async function inspectSource(
  source: ArchiveSource,
  limits: BackupArchiveLimits,
): Promise<BackupArchiveEntry[]> {
  // Take the last end-record signature within the maximum comment length of
  // the end, and refuse a zip64 locator or another end record up to 20 bytes
  // before it: readers differ in which record they would pick.
  const size = source.size;
  const tailStart = Math.max(0, size - END_SIZE - MAX_COMMENT - 20);
  const tail = await source.read(tailStart, size - tailStart);
  if (tail.length !== size - tailStart) throw invalid("short-read");
  const u16 = (at: number) => tail.readUInt16LE(at - tailStart);
  const u32 = (at: number) => tail.readUInt32LE(at - tailStart);
  const lowest = Math.max(0, size - END_SIZE - MAX_COMMENT);
  let end = -1;
  for (let i = size - END_SIZE; i >= lowest; i--) {
    if (tail[i - tailStart] === 0x50 && u32(i) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid("no-end-record");
  for (let i = Math.max(0, end - 20); i < end; i++) {
    const signature = u32(i);
    if (signature === ZIP64_LOCATOR_SIG || signature === ZIP64_END_SIG) {
      throw invalid("zip64");
    }
    if (signature === END_SIG) throw invalid("ambiguous-end-record");
  }

  const diskNumber = u16(end + 4);
  const directoryDisk = u16(end + 6);
  const diskEntries = u16(end + 8);
  const totalEntries = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  const commentLength = u16(end + 20);
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
  if (end + END_SIZE + commentLength !== size) {
    throw invalid("trailing-data");
  }
  if (directoryOffset + directorySize !== end) {
    throw invalid("directory-extent");
  }
  if (diskEntries > limits.maxEntries) throw tooLarge("entry-count");
  if (diskEntries * CENTRAL_SIZE > directorySize) {
    throw invalid("directory-truncated");
  }

  const readDirectory = windowReader(source, end);
  const entries: BackupArchiveEntry[] = [];
  const explicitNames = new Set<string>();
  // Explicit names plus the parent folders each of them implies.
  const nodes = new Set<string>();
  const extents: Array<[start: number, end: number]> = [];
  let totalBytes = 0;
  let cursor = directoryOffset;

  for (let index = 0; index < diskEntries; index++) {
    if (cursor + CENTRAL_SIZE > end) throw invalid("directory-truncated");
    const header = await readDirectory(cursor, CENTRAL_SIZE);
    if (header.readUInt32LE(0) !== CENTRAL_SIG) throw invalid("directory-truncated");
    const flags = header.readUInt16LE(8);
    const method = header.readUInt16LE(10);
    const crc = header.readUInt32LE(16);
    const compressedSize = header.readUInt32LE(20);
    const entrySize = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const entryCommentLength = header.readUInt16LE(32);
    const startDisk = header.readUInt16LE(34);
    const localOffset = header.readUInt32LE(42);
    const nameStart = cursor + CENTRAL_SIZE;
    const recordEnd = nameStart + nameLength + extraLength + entryCommentLength;
    if (recordEnd > end) throw invalid("directory-truncated");
    cursor = recordEnd;

    if (nameLength === 0) throw invalid("empty-name");
    if (nameLength > limits.maxNameBytes) throw tooLarge("name-length");
    const variable = await readDirectory(nameStart, nameLength + extraLength);
    const rawName = variable.subarray(0, nameLength);
    let segments = 1;
    for (const byte of rawName) if (byte === 0x2f || byte === 0x5c) segments++;
    if (segments > limits.maxPathSegments) throw tooLarge("path-depth");

    if (
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk === 0xffff
    ) {
      throw invalid("zip64");
    }
    if (startDisk !== 0) throw invalid("multi-disk");
    if (flags & ~ALLOWED_FLAGS) throw invalid("unsupported-flags");
    if (method !== STORED && method !== DEFLATED) throw invalid("unsupported-method");
    if (method === STORED && compressedSize !== entrySize) throw invalid("stored-size");
    checkExtraFields(variable.subarray(nameLength));

    if (entrySize > limits.maxEntryBytes) throw tooLarge("entry-size");
    totalBytes += entrySize;
    if (totalBytes > limits.maxTotalBytes) throw tooLarge("total-size");

    // Names are decoded as UTF-8; two raw names that decode alike are refused.
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

    const dataStart = await checkLocalHeader(source, directoryOffset, {
      localOffset,
      rawName,
      flags,
      method,
      crc,
      compressedSize,
      size: entrySize,
    });
    extents.push([localOffset, dataStart + compressedSize]);
    const last = rawName[rawName.length - 1];
    entries.push({
      name,
      isDirectory: last === 0x2f || last === 0x5c,
      method,
      crc,
      size: entrySize,
      compressedSize,
      localOffset,
      dataStart,
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

/** Validate an entry's local header and return where its data starts. */
async function checkLocalHeader(
  source: ArchiveSource,
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
): Promise<number> {
  const at = entry.localOffset;
  if (at + LOCAL_SIZE > directoryOffset) throw invalid("local-header");
  // The header and, when it fits before the directory, the expected name.
  const local = await source.read(
    at,
    Math.min(LOCAL_SIZE + entry.rawName.length, directoryOffset - at),
  );
  if (local.length < LOCAL_SIZE || local.readUInt32LE(0) !== LOCAL_SIG) {
    throw invalid("local-header");
  }
  const flags = local.readUInt16LE(6);
  const nameLength = local.readUInt16LE(26);
  const extraLength = local.readUInt16LE(28);
  const dataStart = at + LOCAL_SIZE + nameLength + extraLength;
  if (dataStart + entry.compressedSize > directoryOffset) throw invalid("local-extent");
  if (flags & ~ALLOWED_FLAGS) throw invalid("unsupported-flags");
  if (
    local.readUInt16LE(8) !== entry.method ||
    nameLength !== entry.rawName.length ||
    !local.subarray(LOCAL_SIZE).equals(entry.rawName)
  ) {
    throw invalid("local-mismatch");
  }
  // Without a data descriptor a reader may trust the local checksum and
  // sizes, so they must agree with the central directory the budget used.
  if (
    !((flags | entry.flags) & DATA_DESCRIPTOR) &&
    (local.readUInt32LE(14) !== entry.crc ||
      local.readUInt32LE(18) !== entry.compressedSize ||
      local.readUInt32LE(22) !== entry.size)
  ) {
    throw invalid("local-mismatch");
  }
  return dataStart;
}

/**
 * Passes an entry's inflated bytes through, failing as soon as they exceed
 * the declared size, and at the end unless they match the declared size and
 * checksum exactly.
 */
class EntryCheck extends Transform {
  private bytes = 0;
  private crc = 0;

  constructor(private readonly entry: BackupArchiveEntry) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length;
    if (this.bytes > this.entry.size) {
      callback(invalid("size-mismatch"));
      return;
    }
    this.crc = zlib.crc32(chunk, this.crc);
    callback(null, chunk);
  }

  override _flush(callback: (error?: Error | null) => void) {
    if (this.bytes !== this.entry.size) callback(invalid("size-mismatch"));
    else if (this.crc !== this.entry.crc) callback(invalid("crc-mismatch"));
    else callback();
  }
}

/**
 * The entry's content as a stream that errors unless it inflates to exactly
 * its declared size and checksum. Inflation stops once the declared size is
 * exceeded, so a small archive cannot expand past the budget it was checked
 * against.
 */
function openEntry(source: ArchiveSource, entry: BackupArchiveEntry): Readable {
  const data = source.stream(entry.dataStart, entry.dataStart + entry.compressedSize);
  const check = new EntryCheck(entry);
  // Errors reach `check`, which the caller consumes; the callback only
  // keeps pipeline from treating them as unhandled.
  const noop = () => {};
  return entry.method === DEFLATED
    ? pipeline(data, zlib.createInflateRaw(), check, noop)
    : pipeline(data, check, noop);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function drain(stream: Readable): Promise<void> {
  for await (const _chunk of stream);
}

export const EXPORT_TOO_LARGE_MESSAGE =
  "This export would exceed the backup restore limits. Select fewer projects, channels or wiki spaces, or leave out files.";

/**
 * Counts an export's entries as `inspectBackupArchive` will, and measures its
 * `backup.json` as restore will, as each is written, so export stops as soon
 * as the archive could no longer be restored.
 */
export class BackupExportBudget {
  private readonly sizes = new Map<string, number>();
  private readonly nodes = new Set<string>();
  private totalBytes = 0;
  private json: BackupJsonMeter | undefined;

  constructor(
    private readonly limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
    private readonly jsonLimits: BackupJsonLimits = BACKUP_JSON_LIMITS,
  ) {}

  /**
   * Count the next piece of `backup.json`; throws a 400 as soon as restore
   * would refuse to parse the file, or the archive grows past its budget.
   */
  writeJson(chunk: Buffer) {
    this.json ??= new BackupJsonMeter(this.jsonLimits);
    try {
      this.json.write(chunk);
    } catch (error) {
      if (error instanceof BackupJsonError) throw new ValidationError(EXPORT_TOO_LARGE_MESSAGE);
      throw error;
    }
    this.add("backup.json", this.json.bytes);
  }

  /** Count a whole `backup.json` at once. */
  addBackupJson(json: Buffer) {
    this.writeJson(json);
  }

  /** Add or replace the entry `name`; throws a 400 once over the budget. */
  add(name: string, size: number) {
    this.totalBytes += size - (this.sizes.get(name) ?? 0);
    this.sizes.set(name, size);
    // archiver stores backslashes as forward slashes.
    const stored = name.replace(/\\/g, "/");
    this.nodes.add(stored);
    const folders = stored.split("/");
    folders.pop();
    for (let depth = 1; depth <= folders.length; depth++) {
      this.nodes.add(`${folders.slice(0, depth).join("/")}/`);
    }
    if (
      this.nodes.size > this.limits.maxEntries ||
      Buffer.byteLength(name) > this.limits.maxNameBytes ||
      name.split(/[\\/]/).length > this.limits.maxPathSegments ||
      size > this.limits.maxEntryBytes ||
      this.totalBytes > this.limits.maxTotalBytes
    ) {
      throw new ValidationError(EXPORT_TOO_LARGE_MESSAGE);
    }
  }
}

/** One embedded file of an archive, read from the archive on demand. */
export interface BackupArchiveAsset {
  /** Declared and verified uncompressed size. */
  readonly size: number;
  /** A fresh stream of the content; it errors if the bytes no longer verify. */
  open(): Readable;
  /** The whole content in memory, for small files and tests. */
  read(): Promise<Buffer>;
}

export interface BackupArchiveContents {
  jsonBuffer: Buffer;
  assets: ReadonlyMap<string, BackupArchiveAsset>;
}

/**
 * Read `backup.json` and verify every `assets/` file of a backup ZIP, given as
 * a staged file's path or as a buffer. The archive is inspected before
 * anything is inflated, and every entry read must inflate to exactly its
 * declared size and checksum, so reading stays within `limits`. Only
 * `backup.json` is held in memory; each asset is streamed from the archive
 * once to verify it, and again when the caller opens it. Every rejection is a
 * 400 with a fixed message.
 */
export async function readBackupArchive(
  input: Buffer | string,
  limits: BackupArchiveLimits = BACKUP_ARCHIVE_LIMITS,
  maxJsonBytes: number = BACKUP_JSON_LIMITS.maxBytes,
): Promise<BackupArchiveContents> {
  const source = await openSource(input);
  try {
    const inspected = await inspectSource(source, limits);
    const jsonEntry = inspected.find((entry) => entry.name === "backup.json");
    if (!jsonEntry) {
      throw new ValidationError("Invalid backup ZIP: missing backup.json");
    }
    if (jsonEntry.size > maxJsonBytes) throw tooLarge("json-size");
    try {
      const jsonBuffer = await collect(openEntry(source, jsonEntry));
      const assets = new Map<string, BackupArchiveAsset>();
      for (const entry of inspected) {
        if (!entry.name.startsWith("assets/") || entry.isDirectory) continue;
        await drain(openEntry(source, entry));
        assets.set(entry.name, {
          size: entry.size,
          open: () => openEntry(source, entry),
          read: () => collect(openEntry(source, entry)),
        });
      }
      return { jsonBuffer, assets };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      // Reading the staged file failed: a server fault, not a damaged upload.
      if (typeof (error as NodeJS.ErrnoException).syscall === "string") throw error;
      // zlib messages can describe the data; never pass them on.
      throw invalid("read-failed");
    }
  } finally {
    await source.close();
  }
}
