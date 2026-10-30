import { useEffect, useRef } from "react";
import { isEmptyCustomFieldValue } from "@pm/shared";

export type CustomFieldInput = string | number | boolean | string[] | null;

function sameValue(a: unknown, b: unknown) {
  if (isEmptyCustomFieldValue(a) && isEmptyCustomFieldValue(b)) return true;
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

/**
 * Saves inline edits of one task's custom field. An edit is compared with the
 * latest value sent, not only the rendered one: the rendered value stays stale
 * until the task reloads, and changing A to B and quickly back to A must still
 * send A. The sent value is forgotten once the task shows it, or when its
 * request fails.
 */
export function useCustomFieldSaver(
  field: { required: boolean },
  rendered: unknown,
  send: (value: CustomFieldInput, onError: () => void) => void,
) {
  const lastSent = useRef<{ value: CustomFieldInput } | null>(null);
  useEffect(() => {
    if (lastSent.current && sameValue(lastSent.current.value, rendered)) {
      lastSent.current = null;
    }
  }, [rendered]);

  const current = () => (lastSent.current ? lastSent.current.value : rendered);
  const save = (next: CustomFieldInput) => {
    if (!shouldSaveCustomFieldValue(field, current(), next)) return false;
    const entry = { value: next };
    lastSent.current = entry;
    send(next, () => {
      if (lastSent.current === entry) lastSent.current = null;
    });
    return true;
  };
  return { save, current };
}
