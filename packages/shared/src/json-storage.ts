/** Deepest object/array nesting Prisma can write to one JSON column. */
export const MAX_JSON_STORAGE_DEPTH = 123;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// A well-formed surrogate pair is one code point with the u flag, so \p{Cs}
// matches only an unpaired half. Other C0 characters and Unicode
// normalization forms are valid JSON storage text. U+0000 is unstorable on
// its own and is not an unpaired surrogate.
const UNPAIRED_SURROGATE = /\p{Cs}/u;
const INVALID_VALUE = "Must be a JSON value with finite numbers";
const INVALID_TEXT = "Contains a character that cannot be stored";
const INVALID_MEMBER =
  "Contains an object member that cannot be stored literally";

/** True when `value` contains an unpaired UTF-16 surrogate. */
export function hasUnpairedSurrogate(value: string): boolean {
  return UNPAIRED_SURROGATE.test(value);
}

function hasUnstorableText(value: string): boolean {
  return value.includes("\u0000") || hasUnpairedSurrogate(value);
}

/**
 * True when a string or object member name in `value` has an unpaired
 * surrogate. U+0000 is ignored. Data properties only: accessors are not
 * invoked. The walk is iterative so nesting cannot overflow the call stack.
 */
export function jsonValueHasUnpairedSurrogate(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (hasUnpairedSurrogate(current)) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        const property = Object.getOwnPropertyDescriptor(
          current,
          String(index),
        );
        if (property && "value" in property) stack.push(property.value);
      }
      continue;
    }
    for (const key of Object.keys(current)) {
      if (hasUnpairedSurrogate(key)) return true;
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property && "value" in property) stack.push(property.value);
    }
  }
  return false;
}

/**
 * The locked Prisma serializer copies ordinary object members into `{}` and
 * interprets an enabled raw-parameter marker before copying. Refuse those
 * object shapes instead of losing or replacing literal JSON. Arrays serialize
 * their elements first. Descriptors never invoke a marker accessor.
 */
export function hasUnstorableJsonMembers(value: object): boolean {
  if (Array.isArray(value)) return false;
  if (Object.hasOwn(value, "__proto__")) return true;
  const marker = Object.getOwnPropertyDescriptor(
    value,
    "__prismaRawParameters__",
  );
  return (
    marker !== undefined && (!("value" in marker) || marker.value === true)
  );
}

function* memberKeys(value: object): Generator<string> {
  // Prisma enumerates inherited members too. A missing own descriptor below
  // refuses those instead of accepting JSON different from what it writes.
  for (const key in value) yield key;
}

interface Frame {
  value: object;
  keys: Iterator<string>;
}

function* arrayKeys(length: number): Generator<string> {
  for (let i = 0; i < length; i++) yield String(i);
}

/**
 * Returns one fixed, content-free problem, or undefined for storable JSON.
 * Scalars have depth zero; every object and array adds one. The bounded DFS
 * keeps no value clone or width-sized work queue. JS key enumeration may
 * buffer an object's keys. The active path detects cycles while allowing
 * repeated noncyclic references, which JSON serialization duplicates.
 * Descriptors keep validation from invoking accessors or toJSON methods.
 */
export function jsonStorageIssue(
  value: unknown,
  maxDepth = MAX_JSON_STORAGE_DEPTH,
): string | undefined {
  const stack: Frame[] = [];
  const active = new WeakSet<object>();
  for (;;) {
    if (value !== null && typeof value === "object") {
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return INVALID_VALUE;
      if (hasUnstorableJsonMembers(value)) return INVALID_MEMBER;
      if (stack.length >= maxDepth)
        return `Must be nested at most ${maxDepth} levels deep`;
      if (active.has(value)) return "Must not contain a cycle";
      if (Object.getOwnPropertySymbols(value).length > 0) return INVALID_VALUE;
      const toJSON = Object.getOwnPropertyDescriptor(value, "toJSON");
      if (
        toJSON &&
        (!("value" in toJSON) || typeof toJSON.value === "function")
      )
        return INVALID_VALUE;
      active.add(value);
      stack.push({
        value,
        keys: Array.isArray(value)
          ? arrayKeys(value.length)
          : memberKeys(value),
      });
    } else if (typeof value === "string") {
      if (hasUnstorableText(value)) return INVALID_TEXT;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return INVALID_VALUE;
    } else if (value !== null && typeof value !== "boolean") {
      return INVALID_VALUE;
    }

    let next = false;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const key = frame.keys.next();
      if (key.done) {
        active.delete(frame.value);
        stack.pop();
        continue;
      }
      if (hasUnstorableText(key.value)) return INVALID_TEXT;
      const property = Object.getOwnPropertyDescriptor(frame.value, key.value);
      if (!property || !("value" in property)) return INVALID_VALUE;
      value = property.value;
      next = true;
      break;
    }
    if (!next) return undefined;
  }
}
