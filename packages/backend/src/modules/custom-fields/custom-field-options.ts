import type { RenameOptionInput, SelectOption } from "@pm/shared";

/**
 * What an options edit does to stored SELECT and MULTI_SELECT values.
 *
 * Stored values name options by value. An edit decides the fate of each
 * option the field had before it: kept (the same value), renamed (the new
 * value) or removed (null). Renames apply all at once, so two options can swap
 * names and several options can merge into one.
 *
 * Only values that name an option this edit renamed or removed change. A value
 * that names no option of the field (stored before values were checked) is
 * left alone, so an edit that only adds options rewrites nothing; the
 * custom-field value report lists such values.
 */
export type OptionTargets = ReadonlyMap<string, string | null>;

export function optionTargets(
  previous: readonly string[],
  options: readonly SelectOption[],
  renames: readonly RenameOptionInput[] = [],
): OptionTargets {
  const kept = new Set(options.map((option) => option.value));
  const renamed = new Map(renames.map((rename) => [rename.from, rename.to]));
  const targets = new Map<string, string | null>();
  for (const value of previous) {
    targets.set(value, renamed.get(value) ?? (kept.has(value) ? value : null));
  }
  return targets;
}

export type OptionValueChange =
  | { action: "keep" }
  | { action: "update"; value: string | unknown[]; reason: "option_renamed" | "option_removed" }
  | { action: "clear"; reason: "option_removed" };

/** True when the edit renames or removes `item`. */
function affected(item: unknown, targets: OptionTargets): boolean {
  return typeof item === "string" && targets.has(item) && targets.get(item) !== item;
}

/**
 * The change an options edit makes to one stored value. Linear in the length
 * of the value. Values of another shape than the field type are left alone.
 */
export function migrateOptionValue(
  fieldType: string,
  stored: unknown,
  targets: OptionTargets,
): OptionValueChange {
  if (fieldType === "SELECT") {
    if (!affected(stored, targets)) return { action: "keep" };
    const target = targets.get(stored as string)!;
    return target === null
      ? { action: "clear", reason: "option_removed" }
      : { action: "update", value: target, reason: "option_renamed" };
  }

  if (fieldType === "MULTI_SELECT") {
    if (!Array.isArray(stored) || !stored.some((item) => affected(item, targets))) {
      return { action: "keep" };
    }
    // The list is rewritten: map renamed options, drop removed ones, keep
    // everything else as it was, and list each option once.
    const next: unknown[] = [];
    const seen = new Set<unknown>();
    let removed = false;
    for (const item of stored) {
      let mapped: unknown = item;
      if (typeof item === "string" && targets.has(item)) {
        mapped = targets.get(item);
        if (mapped === null) {
          removed = true;
          continue;
        }
      }
      if (seen.has(mapped)) continue;
      seen.add(mapped);
      next.push(mapped);
    }
    if (next.length === 0) return { action: "clear", reason: "option_removed" };
    return { action: "update", value: next, reason: removed ? "option_removed" : "option_renamed" };
  }

  return { action: "keep" };
}
