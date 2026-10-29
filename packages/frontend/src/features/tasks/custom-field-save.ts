import { isEmptyCustomFieldValue } from "@pm/shared";

export type CustomFieldInput = string | number | boolean | string[] | null;

function sameValue(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

/**
 * Whether an inline custom-field edit should be sent. Nothing is sent when the
 * value did not change, when an empty field is left empty, or when a required
 * field is emptied: the API rejects clearing a required field, so the editor
 * shows the stored value again instead of reporting an error.
 */
export function shouldSaveCustomFieldValue(
  field: { required: boolean },
  current: unknown,
  next: CustomFieldInput,
): boolean {
  if (isEmptyCustomFieldValue(next)) {
    return !field.required && !isEmptyCustomFieldValue(current);
  }
  return !sameValue(current, next);
}
