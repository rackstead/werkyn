import { BackupFileSchema, type BackupFile } from "@pm/shared";
import type { ZodErrorMap, ZodIssueOptionalMessage } from "zod";
import { ValidationError } from "../../utils/errors.js";

const MiB = 1024 * 1024;

/**
 * What one `backup.json` may ask the server to parse. JSON.parse and schema
 * validation cost heap per value and per object, not just per byte, so all
 * three are limited. Together the limits keep the most expensive file they
 * accept within a 224 MiB heap, including the app, which leaves at least
 * 32 MiB of a 256 MiB heap free. Each leaves headroom over a large realistic
 * export (see docs/remediation/sec-028.md).
 */
export const BACKUP_JSON_LIMITS = Object.freeze({
  /**
   * UTF-8 bytes. The largest measured export was 16.6 MiB. Text with any
   * character above U+00FF costs two bytes of heap per character, twice over.
   */
  maxBytes: 24 * MiB,
  /**
   * `{`, `[`, `,` and `:` outside strings, plus one. This is an upper bound on
   * the values and member names JSON.parse can create. Exports average 22 to
   * 24 bytes per token, so 24 MiB of export holds about 1.1 million. One array
   * of strings that validation checks element by element is the most
   * expensive use of tokens.
   */
  maxTokens: 1_100_000,
  /**
   * `{` outside strings. A validated object is the most expensive value.
   * Exports average about 300 bytes per object; a file of minimal objects
   * would otherwise fit hundreds of thousands into the token limit.
   */
  maxObjects: 150_000,
  /**
   * Nesting of objects and arrays. Exports nest about 12 deep. The database
   * layer stores at most 123 levels in one JSON column, which puts a wiki
   * page's content at 128 here, so a deeper file could not be restored anyway.
   */
  maxDepth: 128,
});

export interface BackupJsonLimits {
  maxBytes: number;
  maxTokens: number;
  maxObjects: number;
  maxDepth: number;
}

export interface BackupJsonStats {
  bytes: number;
  tokens: number;
  objects: number;
  depth: number;
}

export const BACKUP_JSON_TOO_LARGE_MESSAGE =
  "Invalid backup file: the backup data exceeds the restore limits";

/** A refused `backup.json`. `reason` is a fixed code for logs, never file text. */
export class BackupJsonError extends ValidationError {
  constructor(readonly reason: string) {
    super(BACKUP_JSON_TOO_LARGE_MESSAGE);
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const OPEN_ARRAY = 0x5b;
const CLOSE_OBJECT = 0x7d;
const CLOSE_ARRAY = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

/**
 * Measures `backup.json` as it is written, chunk by chunk, and throws as soon
 * as it exceeds `limits`. Export uses it to stop before building a file that
 * restore would refuse; `inspectBackupJson` uses it for a whole file, so both
 * count the same way.
 */
export class BackupJsonMeter {
  private bytesSeen = 0;
  private tokens = 1;
  private objects = 0;
  private depth = 0;
  private maxDepth = 0;
  private inString = false;
  private escaped = false;

  constructor(private readonly limits: BackupJsonLimits = BACKUP_JSON_LIMITS) {}

  get bytes() {
    return this.bytesSeen;
  }

  /**
   * Count `chunk`. Multi-byte UTF-8 never contains an ASCII byte, so
   * structural characters are found on the raw bytes, and a chunk may end
   * anywhere, even inside a character or an escape.
   */
  write(chunk: Buffer): this {
    const { limits } = this;
    this.bytesSeen += chunk.length;
    if (this.bytesSeen > limits.maxBytes) throw new BackupJsonError("json-size");
    let { tokens, objects, depth, maxDepth, inString, escaped } = this;
    try {
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
          continue;
        }
        switch (byte) {
          case QUOTE:
            inString = true;
            break;
          case OPEN_OBJECT:
          case OPEN_ARRAY:
            if (byte === OPEN_OBJECT && ++objects > limits.maxObjects) {
              throw new BackupJsonError("json-objects");
            }
            if (++depth > maxDepth) {
              maxDepth = depth;
              if (maxDepth > limits.maxDepth) throw new BackupJsonError("json-depth");
            }
            if (++tokens > limits.maxTokens) throw new BackupJsonError("json-tokens");
            break;
          case CLOSE_OBJECT:
          case CLOSE_ARRAY:
            depth--;
            break;
          case COMMA:
          case COLON:
            if (++tokens > limits.maxTokens) throw new BackupJsonError("json-tokens");
            break;
        }
      }
    } finally {
      this.tokens = tokens;
      this.objects = objects;
      this.depth = depth;
      this.maxDepth = maxDepth;
      this.inString = inString;
      this.escaped = escaped;
    }
    return this;
  }

  get stats(): BackupJsonStats {
    return {
      bytes: this.bytesSeen,
      tokens: this.tokens,
      objects: this.objects,
      depth: this.maxDepth,
    };
  }
}

/**
 * Measure `json` in one pass without allocating, and refuse it before
 * JSON.parse if it exceeds `limits`. Text that is not valid JSON is left for
 * JSON.parse to reject; the counts still bound what it could allocate before
 * it fails.
 */
export function inspectBackupJson(
  json: Buffer,
  limits: BackupJsonLimits = BACKUP_JSON_LIMITS,
): BackupJsonStats {
  if (json.length > limits.maxBytes) throw new BackupJsonError("json-size");
  return new BackupJsonMeter(limits).write(json).stats;
}

/** Problems quoted in the response; validation stops once it has this many. */
const MAX_REPORTED_ISSUES = 5;

class IssueLimitReached extends Error {}

/** Zod's message, minus the uploaded value or keys it would otherwise quote. */
function issueMessage(issue: ZodIssueOptionalMessage, defaultError: string) {
  if (issue.code === "invalid_enum_value") {
    return `Invalid enum value. Expected ${issue.options.map((o) => `'${String(o)}'`).join(" | ")}`;
  }
  if (issue.code === "unrecognized_keys") return "Unrecognized key(s) in object";
  return defaultError;
}

/**
 * Parse and validate an uploaded `backup.json` within `limits`. Validation
 * stops at the fifth problem: Zod otherwise builds an issue for every invalid
 * element, about 100 bytes of heap per byte of a file like `[{},{},…]`.
 * BackupFileSchema sets no custom messages, so every issue reaches the error
 * map below.
 */
export function parseBackupJson(
  json: Buffer,
  limits: BackupJsonLimits = BACKUP_JSON_LIMITS,
): BackupFile {
  inspectBackupJson(json, limits);
  let raw: unknown;
  try {
    raw = JSON.parse(json.toString("utf-8"));
  } catch {
    throw new ValidationError("Invalid JSON file");
  }

  const messages: string[] = [];
  const errorMap: ZodErrorMap = (issue, ctx) => {
    const message = issueMessage(issue, ctx.defaultError);
    messages.push(message);
    if (messages.length >= MAX_REPORTED_ISSUES) throw new IssueLimitReached();
    return { message };
  };
  let result: ReturnType<typeof BackupFileSchema.safeParse> | undefined;
  try {
    result = BackupFileSchema.safeParse(raw, { errorMap });
  } catch (error) {
    if (!(error instanceof IssueLimitReached)) throw error;
  }
  if (result?.success) return result.data;
  if (messages.length === 0 && result) {
    messages.push(
      ...result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => issue.message),
    );
  }
  throw new ValidationError(`Invalid backup file format: ${messages.join("; ")}`);
}
