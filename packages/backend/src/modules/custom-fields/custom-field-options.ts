import type { RenameOptionInput, SelectOption } from "@pm/shared";

/**
 * What an options edit does to stored SELECT and MULTI_SELECT values.
 *
 * Stored values name options by value. After an edit, each stored option
 * value either follows its rename, stays (the option is kept), or is removed
 * (the option is gone). Renames apply all at once, so two options can swap
 * names and several options can merge into one.
 */
export type OptionTargets = ReadonlyMap<string, string>;

export function optionTargets(
  options: readonly SelectOption[],
  renames: readonly RenameOptionInput[] = [],
): OptionTargets {
  const targets = new Map<string, string>();
  for (const option of options) targets.set(option.value, option.value);
  // A rename wins over a kept option of the same value (a swap).
  for (const rename of renames) targets.set(rename.from, rename.to);
  return targets;
}

export type OptionValueChange =
  | { action: "keep" }
  | { action: "update"; value: string | string[]; reason: "option_renamed" | "option_removed" }
  | { action: "clear"; reason: "option_removed" };

/**
 * The change an options edit makes to one stored value. Values of another
 * shape than the field type (written before values were checked) are left
 * alone; the custom-field value report lists them.
 */
export function migrateOptionValue(
  fieldType: string,
  stored: unknown,
  targets: OptionTargets,
): OptionValueChange {
  if (fieldType === "SELECT") {
    if (typeof stored !== "string") return { action: "keep" };
    const target = targets.get(stored);
    if (target === undefined) return { action: "clear", reason: "option_removed" };
    return target === stored ? { action: "keep" } : { action: "update", value: target, reason: "option_renamed" };
  }

  if (fieldType === "MULTI_SELECT") {
    if (!Array.isArray(stored)) return { action: "keep" };
    const next: string[] = [];
    let removed = false;
    for (const item of stored) {
      const target = typeof item === "string" ? targets.get(item) : undefined;
      if (target === undefined) {
        removed = true;
      } else if (!next.includes(target)) {
        next.push(target);
      }
    }
    if (next.length === 0) return { action: "clear", reason: "option_removed" };
    const unchanged = next.length === stored.length && next.every((item, index) => item === stored[index]);
    if (unchanged) return { action: "keep" };
    return { action: "update", value: next, reason: removed ? "option_removed" : "option_renamed" };
  }

  return { action: "keep" };
}
