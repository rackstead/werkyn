import { BackupFileSchema, type BackupFile } from "@pm/shared";
import { z } from "zod";
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
 * Measure `json` in one pass without allocating, and refuse it before
 * JSON.parse if it exceeds `limits`. Multi-byte UTF-8 never contains an ASCII
 * byte, so structural characters are found on the raw bytes. Text that is not
 * valid JSON is left for JSON.parse to reject; the counts still bound what it
 * could allocate before it fails.
 */
export function inspectBackupJson(
  json: Buffer,
  limits: BackupJsonLimits = BACKUP_JSON_LIMITS,
): BackupJsonStats {
  if (json.length > limits.maxBytes) throw new BackupJsonError("json-size");
  let tokens = 1;
  let objects = 0;
  let depth = 0;
  let maxDepth = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const byte = json[i];
    if (inString) {
      if (byte === BACKSLASH) i++;
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
  return { bytes: json.length, tokens, objects, depth: maxDepth };
}

/** Problems quoted in the response; validation stops once it has this many. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Values (objects, arrays and scalars) one Zod call may traverse. Zod builds
 * every issue of a call before it returns, so this bounds the issues that can
 * exist at once: at most one per missing required field of each element, for
 * example 512 empty attachments x 7 required fields = 3,584. A value Zod does
 * not traverse is still handed over whole: `z.unknown()` content, and a value
 * of the wrong kind, which gets a single type issue.
 */
export const BACKUP_VALIDATION_BATCH_VALUES = 512;

/**
 * Messages that would quote the upload are replaced; every other issue keeps
 * the shared default wording (see @pm/shared `zod3CompatibleMessage`).
 */
const error: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === "invalid_value") {
    if (issue.input === undefined) return "Required";
    return `Invalid enum value. Expected ${issue.values.map((o) => `'${String(o)}'`).join(" | ")}`;
  }
  if (issue.code === "unrecognized_keys") return "Unrecognized key(s) in object";
  return undefined;
};

type Schema = z.ZodType;

/** One validation: problems found so far, and the values counted per container. */
interface Walk {
  messages: string[];
  max: number;
  /**
   * Each object's or array's value count (itself included), capped at
   * BACKUP_VALIDATION_BATCH_VALUES + 1. `for…in` lists every key of an object
   * before the first iteration, so counting an object with hundreds of
   * thousands of keys again for each ancestor would repeat that work; each is
   * counted once per parse.
   */
  counts: WeakMap<object, number>;
}

/** How many values `value` holds, or BACKUP_VALIDATION_BATCH_VALUES + 1 once it has more. */
function size(value: unknown, walk: Walk): number {
  if (value === null || typeof value !== "object") return 1;
  const known = walk.counts.get(value);
  if (known !== undefined) return known;
  const limit = BACKUP_VALIDATION_BATCH_VALUES;
  let total = 1;
  if (Array.isArray(value)) {
    for (const item of value) {
      total += size(item, walk);
      if (total > limit) break;
    }
  } else {
    for (const key in value) {
      total += size((value as Record<string, unknown>)[key], walk);
      if (total > limit) break;
    }
  }
  const capped = Math.min(total, limit + 1);
  walk.counts.set(value, capped);
  return capped;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validates `value` against `schema` so that no Zod call traverses more than
 * BACKUP_VALIDATION_BATCH_VALUES values, and stops once `walk.messages` holds
 * `walk.max` problems. Zod builds every issue of a call before returning and
 * runs error maps only once it has them all (Zod 4), so a cap inside one call
 * cannot bound memory; bounding what each call traverses does. Objects and arrays
 * too large for one call are walked here through the public schema API
 * (`shape`, `element`, `unwrap`, `removeDefault`): the parts of `z.object`
 * (unknown keys stripped), `z.array`, `.optional()`, `.nullable()` and
 * `.default()` that BackupFileSchema uses. Anything else is validated whole.
 * Problems are found in the order a full parse reports them.
 */
function collectIssues(schema: Schema, value: unknown, walk: Walk): void {
  if (walk.messages.length >= walk.max) return;
  for (;;) {
    if (schema instanceof z.ZodDefault) {
      if (value === undefined) return;
      schema = schema.removeDefault() as Schema;
    } else if (schema instanceof z.ZodOptional) {
      if (value === undefined) return;
      schema = schema.unwrap() as Schema;
    } else if (schema instanceof z.ZodNullable) {
      if (value === null) return;
      schema = schema.unwrap() as Schema;
    } else {
      break;
    }
  }
  if (schema instanceof z.ZodArray && Array.isArray(value)) {
    collectItemIssues(schema.element as Schema, value, walk);
    return;
  }
  if (
    schema instanceof z.ZodObject &&
    isPlainObject(value) &&
    size(value, walk) > BACKUP_VALIDATION_BATCH_VALUES
  ) {
    for (const [key, field] of Object.entries(schema.shape as Record<string, Schema>)) {
      collectIssues(field, value[key], walk);
      if (walk.messages.length >= walk.max) return;
    }
    return;
  }
  // A scalar, a small object or array, or a value Zod does not traverse
  // (`z.unknown()`, or the wrong kind of value, which gets one issue).
  report(schema.safeParse(value, { error }), walk);
}

/** Array elements in batches; an element too large for a batch is walked alone. */
function collectItemIssues(element: Schema, items: unknown[], walk: Walk): void {
  const batchSchema = z.array(element);
  let batch: unknown[] = [];
  let batchValues = 0;
  const flush = () => {
    if (batch.length > 0) report(batchSchema.safeParse(batch, { error }), walk);
    batch = [];
    batchValues = 0;
  };
  for (const item of items) {
    if (walk.messages.length >= walk.max) return;
    const values = size(item, walk);
    if (values > BACKUP_VALIDATION_BATCH_VALUES) {
      flush();
      collectIssues(element, item, walk);
      continue;
    }
    if (batchValues + values > BACKUP_VALIDATION_BATCH_VALUES) flush();
    batch.push(item);
    batchValues += values;
  }
  if (walk.messages.length < walk.max) flush();
}

function report(result: { success: boolean; error?: z.ZodError }, walk: Walk) {
  if (result.success || !result.error) return;
  for (const issue of result.error.issues) {
    if (walk.messages.length >= walk.max) return;
    walk.messages.push(issue.message);
  }
}

/**
 * Parse and validate an uploaded `backup.json` within `limits`. Validation
 * stops at the fifth problem and never lets one Zod call traverse more than
 * BACKUP_VALIDATION_BATCH_VALUES values, so a file of many invalid elements
 * (Zod builds an issue for each, about 100 bytes of heap per byte of a file
 * like `[{},{},…]`) costs at most a few thousand issues at a time, whatever
 * Zod version runs. Only a file without problems gets the full parse that
 * applies defaults. BackupFileSchema sets no custom messages, so every issue gets the
 * error map's message, which never quotes the upload.
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

  const walk: Walk = { messages: [], max: MAX_REPORTED_ISSUES, counts: new WeakMap() };
  collectIssues(BackupFileSchema, raw, walk);
  const { messages } = walk;
  if (messages.length === 0) {
    // Every value already passed in bounded pieces, so this finds no element
    // problems; it builds the result with defaults applied.
    const result = BackupFileSchema.safeParse(raw, { error });
    if (result.success) return result.data;
    report(result, walk);
  }
  throw new ValidationError(`Invalid backup file format: ${messages.join("; ")}`);
}
