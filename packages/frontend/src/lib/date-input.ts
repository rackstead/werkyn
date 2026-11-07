import { isDateOnly } from "@pm/shared";

/**
 * The value of an `<input type="date">` that may be saved: null when the
 * input was cleared, the date when it is a complete date the server accepts,
 * and undefined otherwise. While a year is typed, Chromium reports partial
 * years as real values (0002-03-15, 0020-03-15, 0202-03-15, then 2027-03-15),
 * and the server rejects years before 1900.
 *
 * An input with a half-typed part (the first digit of a month typed over a
 * date, or one part deleted) also reports "", but it is not cleared: the
 * browser marks it as bad input. That is checked on `input`, or, when no input
 * is given, on the focused date input, which is the one being typed into.
 */
export function committedDate(
  value: string,
  input: HTMLInputElement | null = focusedInput(),
): string | null | undefined {
  if (value === "") return input?.validity.badInput ? undefined : null;
  return isDateOnly(value) ? value : undefined;
}

function focusedInput(): HTMLInputElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLInputElement && active.type === "date" ? active : null;
}

/** What a date input holds: nothing, a complete date, or anything else. */
export type DateInputContent =
  | { kind: "empty" }
  | { kind: "date"; date: string }
  | { kind: "incomplete" };

/**
 * Reads a date input as `committedDate` does: a part half typed or deleted,
 * or a year outside 1900–2999 (a partial year), is incomplete, not empty.
 */
export function dateInputContent(input: HTMLInputElement): DateInputContent {
  const date = committedDate(input.value, input);
  if (date === null) return { kind: "empty" };
  return date === undefined ? { kind: "incomplete" } : { kind: "date", date };
}
