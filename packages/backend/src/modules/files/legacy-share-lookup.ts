import { isLegacyFileShareToken } from "@pm/shared";

export type LegacyShareLookup =
  | { action: "pass" }
  | { action: "miss" }
  | { action: "rewrite"; where: unknown };

type Scrub = { blocked: boolean; where: unknown; changed: boolean };

function combine(parts: boolean[], op: "and" | "or"): boolean {
  if (parts.length === 0) return false;
  return op === "and" ? parts.some(Boolean) : parts.every(Boolean);
}

/** True when every matching row would have to carry an 8-character token. */
function requiresWhere(where: unknown, negated: boolean): boolean {
  if (!where || typeof where !== "object") return false;
  if (Array.isArray(where)) {
    return combine(
      where.map((part) => requiresWhere(part, negated)),
      negated ? "or" : "and",
    );
  }
  const record = where as Record<string, unknown>;
  const parts: boolean[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "AND") parts.push(requiresWhere(value, negated));
    else if (key === "OR") {
      const list = Array.isArray(value) ? value : [value];
      parts.push(
        combine(
          list.map((part) => requiresWhere(part, negated)),
          negated ? "and" : "or",
        ),
      );
    } else if (key === "NOT") {
      if (Array.isArray(value)) {
        // NOT: [A, B] is (NOT A) AND (NOT B).
        parts.push(
          combine(
            value.map((part) => requiresWhere(part, !negated)),
            negated ? "or" : "and",
          ),
        );
      } else parts.push(requiresWhere(value, !negated));
    } else if (key === "token") parts.push(requiresToken(value, negated));
    else parts.push(false);
  }
  return combine(parts, negated ? "or" : "and");
}

function requiresToken(token: unknown, negated: boolean): boolean {
  if (typeof token === "string") return !negated && isLegacyFileShareToken(token);
  if (!token || typeof token !== "object" || Array.isArray(token)) return false;
  const filter = token as Record<string, unknown>;
  const parts: boolean[] = [];
  if ("equals" in filter) parts.push(requiresToken(filter.equals, negated));
  if (Array.isArray(filter.in)) {
    const values = filter.in.filter((value) => typeof value === "string");
    const allLegacy =
      values.length > 0 &&
      values.length === filter.in.length &&
      values.every((value) => isLegacyFileShareToken(value));
    parts.push(!negated && allLegacy);
  }
  if ("not" in filter) parts.push(requiresToken(filter.not, !negated));
  if (Array.isArray(filter.notIn)) {
    const values = filter.notIn.filter((value) => typeof value === "string");
    const allLegacy =
      values.length > 0 &&
      values.length === filter.notIn.length &&
      values.every((value) => isLegacyFileShareToken(value));
    parts.push(negated && allLegacy);
  }
  return combine(parts, negated ? "or" : "and");
}

function scrubToken(
  token: unknown,
  negated: boolean,
): { blocked: boolean; token: unknown; changed: boolean } {
  if (typeof token === "string") {
    return !negated && isLegacyFileShareToken(token)
      ? { blocked: true, token, changed: false }
      : { blocked: false, token, changed: false };
  }
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    return { blocked: false, token, changed: false };
  }
  const filter = token as Record<string, unknown>;
  if ("equals" in filter) {
    const equals = scrubToken(filter.equals, negated);
    if (equals.blocked) return { blocked: true, token, changed: false };
  }
  if ("not" in filter) {
    const inner = scrubToken(filter.not, !negated);
    if (inner.blocked) return { blocked: true, token, changed: false };
    if (inner.changed) {
      return {
        blocked: false,
        token: { ...filter, not: inner.token },
        changed: true,
      };
    }
  }
  if (!negated && Array.isArray(filter.in)) {
    const kept = filter.in.filter(
      (value) => !(typeof value === "string" && isLegacyFileShareToken(value)),
    );
    if (kept.length !== filter.in.length) {
      const equalsKept =
        typeof filter.equals === "string" && !isLegacyFileShareToken(filter.equals);
      if (kept.length === 0 && !equalsKept) {
        return { blocked: true, token, changed: false };
      }
      return {
        blocked: false,
        token: { ...filter, in: kept },
        changed: true,
      };
    }
  }
  return { blocked: false, token, changed: false };
}

function scrub(where: unknown, negated: boolean): Scrub {
  if (!where || typeof where !== "object") {
    return { blocked: false, where, changed: false };
  }
  if (Array.isArray(where)) {
    const parts = where.map((part) => scrub(part, negated));
    if (!negated && parts.some((part) => part.blocked)) {
      return { blocked: true, where, changed: false };
    }
    if (negated && parts.length > 0 && parts.every((part) => part.blocked)) {
      return { blocked: true, where, changed: false };
    }
    const kept = negated ? parts.filter((part) => !part.blocked) : parts;
    const changed = kept.length !== parts.length || kept.some((part) => part.changed);
    if (!changed) return { blocked: false, where, changed: false };
    return {
      blocked: false,
      where: kept.map((part) => part.where),
      changed: true,
    };
  }

  const record = where as Record<string, unknown>;
  let blocked = false;
  let changed = false;
  const next: Record<string, unknown> = { ...record };

  if ("token" in record) {
    const token = scrubToken(record.token, negated);
    if (token.blocked) blocked = true;
    else if (token.changed) {
      next.token = token.token;
      changed = true;
    }
  }
  if ("NOT" in record) {
    const inner = record.NOT;
    if (Array.isArray(inner)) {
      const parts = inner.map((part) => scrub(part, !negated));
      if (parts.some((part) => part.blocked)) blocked = true;
      else if (parts.some((part) => part.changed)) {
        next.NOT = parts.map((part) => part.where);
        changed = true;
      }
    } else {
      const part = scrub(inner, !negated);
      // NOT of a refused clause is still refused: NOT NOT token=legacy must miss.
      if (part.blocked) blocked = true;
      else if (part.changed) {
        next.NOT = part.where;
        changed = true;
      }
    }
  }
  for (const key of ["AND", "OR"] as const) {
    if (!(key in record)) continue;
    const list = Array.isArray(record[key]) ? (record[key] as unknown[]) : [record[key]];
    const parts = list.map((part) => scrub(part, negated));
    const asOr = key === "OR" ? !negated : negated;
    if (asOr) {
      if (parts.every((part) => part.blocked)) blocked = true;
      else if (parts.some((part, index) => part.blocked || part.where !== list[index])) {
        next[key] = parts.filter((part) => !part.blocked).map((part) => part.where);
        changed = true;
      }
    } else if (parts.some((part) => part.blocked)) blocked = true;
    else if (parts.some((part) => part.changed)) {
      next[key] = Array.isArray(record[key])
        ? parts.map((part) => part.where)
        : parts[0]?.where;
      changed = true;
    }
  }

  if (blocked) return { blocked: true, where, changed: false };
  if (!changed) return { blocked: false, where, changed: false };
  return { blocked: false, where: next, changed: true };
}

/**
 * How a FileShareLink read should treat its where clause.
 * "pass" leaves the query untouched. "miss" is an unknown token.
 * "rewrite" drops 8-character values from a mixed filter.
 * NOT is boolean: a single negation does not select the token, and NOT NOT does.
 */
export function decideLegacyShareLookup(where: unknown): LegacyShareLookup {
  if (requiresWhere(where, false)) return { action: "miss" };
  const scrubbed = scrub(where, false);
  if (scrubbed.blocked) return { action: "miss" };
  if (!scrubbed.changed) return { action: "pass" };
  return { action: "rewrite", where: scrubbed.where };
}

const SHARE_LINK_RELATIONS = new Set([
  "shareLink",
  "fileShareLinks",
  "fileShareLinksCreated",
]);

function applyShareWhere(where: unknown): { where: unknown; changed: boolean } {
  const decision = decideLegacyShareLookup(where);
  if (decision.action === "miss") return { where: { id: "" }, changed: true };
  if (decision.action === "rewrite") return { where: decision.where, changed: true };
  const nested = scrubNestedValue(where);
  return nested.changed
    ? { where: nested.value, changed: true }
    : { where, changed: false };
}

function applyRelation(
  key: string,
  child: Record<string, unknown>,
): { value: unknown; changed: boolean } {
  if (key === "shareLink") {
    if ("is" in child || "isNot" in child) {
      let changed = false;
      const next = { ...child };
      for (const slot of ["is", "isNot"] as const) {
        if (!(slot in child)) continue;
        const applied = applyShareWhere(child[slot]);
        if (applied.changed) {
          next[slot] = applied.where;
          changed = true;
        }
      }
      return { value: changed ? next : child, changed };
    }
    const applied = applyShareWhere(child);
    return { value: applied.where, changed: applied.changed };
  }
  let changed = false;
  const next = { ...child };
  for (const slot of ["some", "every", "none", "where"] as const) {
    if (!(slot in child)) continue;
    const applied = applyShareWhere(child[slot]);
    if (applied.changed) {
      next[slot] = applied.where;
      changed = true;
    }
  }
  return { value: changed ? next : child, changed };
}

function scrubNestedValue(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object") return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = scrubNestedValue(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (
      SHARE_LINK_RELATIONS.has(key) &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      const applied = applyRelation(key, child as Record<string, unknown>);
      next[key] = applied.value;
      changed ||= applied.changed;
      continue;
    }
    const inner = scrubNestedValue(child);
    next[key] = inner.value;
    changed ||= inner.changed;
  }
  return changed ? { value: next, changed } : { value, changed: false };
}

/** Relation filters that carry a FileShareLink token, on any parent read. */
export function scrubNestedShareLinkArgs(args: unknown): {
  args: unknown;
  changed: boolean;
} {
  const result = scrubNestedValue(args);
  return { args: result.value, changed: result.changed };
}
