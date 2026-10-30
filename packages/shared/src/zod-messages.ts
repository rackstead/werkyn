import { z } from "zod";

/**
 * Zod 4 changed its default issue messages ("Required" became "Invalid input:
 * expected string, received undefined"). API validation errors return these
 * messages as `details[].message`, and the forms show them, so this keeps the
 * Zod 3 wording for every issue kind Werkyn's schemas produce. A message a
 * schema sets itself still wins; anything not listed falls back to Zod's
 * English default.
 */

/** Zod 3's name for the type of a received value. */
function receivedType(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (input instanceof Date) return "date";
  if (typeof input === "number") return Number.isNaN(input) ? "nan" : "number";
  if (input instanceof Map) return "map";
  if (input instanceof Set) return "set";
  if (typeof input === "object" && typeof (input as { then?: unknown }).then === "function") {
    return "promise";
  }
  return typeof input;
}

const quoted = (values: readonly unknown[]) =>
  values.map((value) => (typeof value === "string" ? `'${value}'` : String(value))).join(" | ");

const FORMAT_MESSAGES: Record<string, string> = {
  email: "Invalid email",
  url: "Invalid url",
  uuid: "Invalid uuid",
  guid: "Invalid uuid",
  cuid: "Invalid cuid",
  cuid2: "Invalid cuid2",
  ulid: "Invalid ulid",
  regex: "Invalid",
  datetime: "Invalid datetime",
  date: "Invalid date",
  time: "Invalid time",
  duration: "Invalid duration",
  ipv4: "Invalid ip",
  ipv6: "Invalid ip",
  base64: "Invalid base64",
  emoji: "Invalid emoji",
  nanoid: "Invalid nanoid",
};

export const zod3CompatibleMessage: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type": {
      const received = receivedType(issue.input);
      if (received === "undefined") return "Required";
      // Zod 4 refuses Infinity as a number; Zod 3 only did with `.finite()`.
      if (
        (issue.expected === "number" || issue.expected === "int") &&
        typeof issue.input === "number" &&
        !Number.isFinite(issue.input) &&
        !Number.isNaN(issue.input)
      ) {
        return "Number must be finite";
      }
      // Zod 3 reported `.int()` on a fraction as a type error with these names.
      if (issue.expected === "int" && received === "number") return "Expected integer, received float";
      const expected = issue.expected === "int" ? "integer" : issue.expected === "record" ? "object" : issue.expected;
      return `Expected ${expected}, received ${received}`;
    }
    case "invalid_value":
      // Zod 4 checks a missing enum value against the options; Zod 3 called it
      // missing. Werkyn's schemas use z.enum, not z.literal.
      if (issue.input === undefined) return "Required";
      // Zod 3 checked the type first: a non-string got a type message.
      if (typeof issue.input !== "string") return `Expected ${quoted(issue.values)}, received ${receivedType(issue.input)}`;
      return `Invalid enum value. Expected ${quoted(issue.values)}, received ${typeof issue.input === "string" ? `'${issue.input}'` : String(issue.input)}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(", ")}`;
    case "invalid_union": {
      // Since Zod 4.6.6 an array over its `.max()` stops early, and a union
      // whose options all stopped reports only this summary. Zod 3 reported
      // that option's length problem instead, so take it when it is the only one.
      const overLong = issue.errors.filter((option) =>
        option.some((inner) => inner.code === "too_big" && inner.path.length === 0),
      );
      if (overLong.length === 1) {
        const tooBig = overLong[0].find((inner) => inner.code === "too_big" && inner.path.length === 0);
        if (tooBig) return tooBig.message;
      }
      return "Invalid input";
    }
    case "invalid_format": {
      if (issue.format === "starts_with") return `Invalid input: must start with "${(issue as { prefix?: string }).prefix}"`;
      if (issue.format === "ends_with") return `Invalid input: must end with "${(issue as { suffix?: string }).suffix}"`;
      if (issue.format === "includes") return `Invalid input: must include "${(issue as { includes?: string }).includes}"`;
      return FORMAT_MESSAGES[issue.format] ?? "Invalid";
    }
    case "too_small": {
      const n = String(issue.minimum);
      if (issue.origin === "array" || issue.origin === "set") {
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "more than"} ${n} element(s)`;
      }
      if (issue.origin === "string") {
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at least" : "over"} ${n} character(s)`;
      }
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return `Number must be ${issue.exact ? "exactly equal to " : issue.inclusive ? "greater than or equal to " : "greater than "}${n}`;
      }
      return undefined;
    }
    case "too_big": {
      const n = String(issue.maximum);
      if (issue.origin === "array" || issue.origin === "set") {
        return `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "less than"} ${n} element(s)`;
      }
      if (issue.origin === "string") {
        return `String must contain ${issue.exact ? "exactly" : issue.inclusive ? "at most" : "under"} ${n} character(s)`;
      }
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") {
        return `Number must be ${issue.exact ? "exactly" : issue.inclusive ? "less than or equal to" : "less than"} ${n}`;
      }
      return undefined;
    }
    case "not_multiple_of":
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case "custom":
      return "Invalid input";
    default:
      return undefined;
  }
};

z.config({ customError: zod3CompatibleMessage });
