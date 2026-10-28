import { isDateOnly } from "@pm/shared";

/**
 * The value of an `<input type="date">` that may be saved: null when the
 * input was cleared, the date when it is a complete date the server accepts,
 * and undefined otherwise. While a year is typed, Chromium reports partial
 * years as real values (0002-03-15, 0020-03-15, 0202-03-15, then 2027-03-15),
 * and the server rejects years before 1900.
 */
export function committedDate(value: string): string | null | undefined {
  if (value === "") return null;
  return isDateOnly(value) ? value : undefined;
}
