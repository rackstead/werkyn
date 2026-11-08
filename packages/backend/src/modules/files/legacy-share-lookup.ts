import { isLegacyFileShareToken } from "@pm/shared";

export type LegacyShareLookup =
  | { action: "pass" }
  | { action: "miss" }
  | { action: "rewrite"; where: unknown };

function tokenFilterHasLegacy(token: unknown): boolean {
  if (typeof token === "string") return isLegacyFileShareToken(token);
  if (!token || typeof token !== "object") return false;
  const filter = token as { equals?: unknown; in?: unknown };
  if (
    typeof filter.equals === "string" &&
    isLegacyFileShareToken(filter.equals)
  )
    return true;
  return (
    Array.isArray(filter.in) &&
    filter.in.some(
      (value) => typeof value === "string" && isLegacyFileShareToken(value),
    )
  );
}

/** True when this filter can only succeed by matching an 8-character token. Ignores NOT. */
function mentionsLegacyToken(where: unknown): boolean {
  if (!where || typeof where !== "object") return false;
  if (Array.isArray(where))
    return where.some((part) => mentionsLegacyToken(part));
  const record = where as { token?: unknown; AND?: unknown; OR?: unknown };
  if (tokenFilterHasLegacy(record.token)) return true;
  if (record.AND && mentionsLegacyToken(record.AND)) return true;
  if (record.OR && mentionsLegacyToken(record.OR)) return true;
  return false;
}

function scrub(where: unknown): { blocked: boolean; where: unknown } {
  if (!where || typeof where !== "object") return { blocked: false, where };
  if (Array.isArray(where)) {
    const parts = where.map((part) => scrub(part));
    if (parts.some((part) => part.blocked)) return { blocked: true, where };
    return { blocked: false, where: parts.map((part) => part.where) };
  }

  const record = where as Record<string, unknown>;
  let token = record.token;
  let tokenChanged = false;
  if (typeof token === "string") {
    if (isLegacyFileShareToken(token)) return { blocked: true, where };
  } else if (token && typeof token === "object") {
    const filter = token as { equals?: unknown; in?: unknown };
    if (
      typeof filter.equals === "string" &&
      isLegacyFileShareToken(filter.equals)
    ) {
      return { blocked: true, where };
    }
    if (Array.isArray(filter.in)) {
      const kept = filter.in.filter(
        (value) =>
          !(typeof value === "string" && isLegacyFileShareToken(value)),
      );
      if (kept.length !== filter.in.length) {
        const equals = filter.equals;
        const equalsKept =
          typeof equals === "string" && !isLegacyFileShareToken(equals);
        if (kept.length === 0 && !equalsKept) return { blocked: true, where };
        token = { ...(token as Record<string, unknown>), in: kept };
        tokenChanged = true;
      }
    }
  }

  let and = record.AND;
  let andChanged = false;
  if (and) {
    const result = scrub(and);
    if (result.blocked) return { blocked: true, where };
    if (result.where !== and) {
      and = result.where;
      andChanged = true;
    }
  }

  let or = record.OR;
  let orChanged = false;
  if (or) {
    const parts = Array.isArray(or) ? or : [or];
    const scrubbed = parts.map((part) => scrub(part));
    if (scrubbed.every((part) => part.blocked)) return { blocked: true, where };
    if (
      scrubbed.some(
        (part, index) => part.blocked || part.where !== parts[index],
      )
    ) {
      or = scrubbed.filter((part) => !part.blocked).map((part) => part.where);
      orChanged = true;
    }
  }

  if (!tokenChanged && !andChanged && !orChanged)
    return { blocked: false, where };
  return {
    blocked: false,
    where: {
      ...record,
      ...(tokenChanged ? { token } : {}),
      ...(andChanged ? { AND: and } : {}),
      ...(orChanged ? { OR: or } : {}),
    },
  };
}

/**
 * How a FileShareLink read should treat its where clause.
 * "pass" leaves the query untouched. "miss" is an unknown token.
 * "rewrite" drops 8-character values from a mixed filter.
 */
export function decideLegacyShareLookup(where: unknown): LegacyShareLookup {
  if (!mentionsLegacyToken(where)) return { action: "pass" };
  const scrubbed = scrub(where);
  if (scrubbed.blocked) return { action: "miss" };
  return { action: "rewrite", where: scrubbed.where };
}
