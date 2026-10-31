/** Deepest object/array nesting Prisma can write to one JSON column. */
export const MAX_JSON_STORAGE_DEPTH = 123;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// A well-formed surrogate pair is one code point with the u flag. Other C0
// characters and Unicode normalization forms are valid JSON storage text.
const UNSTORABLE = /[\u0000\p{Cs}]/u;
const INVALID_VALUE = "Must be a JSON value with finite numbers";
const INVALID_TEXT = "Contains a character that cannot be stored";
const INVALID_MEMBER =
  "Contains an object member that cannot be stored literally";

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
      if (UNSTORABLE.test(value)) return INVALID_TEXT;
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
      if (UNSTORABLE.test(key.value)) return INVALID_TEXT;
      const property = Object.getOwnPropertyDescriptor(frame.value, key.value);
      if (!property || !("value" in property)) return INVALID_VALUE;
      value = property.value;
      next = true;
      break;
    }
    if (!next) return undefined;
  }
}
