import { z } from "zod";

// ─── Calendar dates ─────────────────────────────────────
//
// Due dates, time entry dates, schedule dates and rate start dates are
// calendar dates sent and stored as YYYY-MM-DD, without a time of day. The
// shape alone is not enough: date arithmetic rolls "2026-02-31" over to March
// 3, and Date.UTC reads years 0000-0099 as 1900-1999. Every date-only input
// must name a real day in the supported year range.

export const DATE_ONLY_MIN_YEAR = 1900;
export const DATE_ONLY_MAX_YEAR = 2999;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a real YYYY-MM-DD calendar date in the supported year range. */
export function isDateOnly(value: string): boolean {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < DATE_ONLY_MIN_YEAR || year > DATE_ONLY_MAX_YEAR) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  // Day 0 of the following month is the last day of this one.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A date-only string; `field` names the input in the error message. */
export function dateOnly(field = "Date") {
  return z.string().refine(isDateOnly, {
    message: `${field} must be a real calendar date in YYYY-MM-DD format between ${DATE_ONLY_MIN_YEAR} and ${DATE_ONLY_MAX_YEAR}`,
  });
}

// ─── Text ───────────────────────────────────────────────
//
// PostgreSQL text cannot store U+0000, so a NUL character used to reach the
// database and fail there. The other C0 control characters have no place in
// names or descriptions either. Single-line text (names, titles, search
// terms) allows TAB only; multi-line text (descriptions, comment bodies) also
// allows line feed and carriage return.

const SINGLE_LINE_TEXT = /^[^\u0000-\u0008\u000A-\u001F]*$/;
const MULTILINE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;

export function singleLineText() {
  return z.string().regex(SINGLE_LINE_TEXT, "Must not contain line breaks or control characters");
}

export function multilineText() {
  return z.string().regex(MULTILINE_TEXT, "Must not contain control characters");
}

/** True when `value` is acceptable to multilineText(). */
export function isMultilineText(value: string): boolean {
  return MULTILINE_TEXT.test(value);
}

// The characters MULTILINE_TEXT rejects, and the two of them that stand for a
// break: vertical tab (a manual line break in Word) and form feed (a page break).
const MULTILINE_DISALLOWED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const BREAK_CONTROLS = /[\u000B\u000C]/g;

/**
 * Makes text acceptable to multilineText(): vertical tab and form feed become
 * `breakWith`, and the other rejected control characters are removed.
 */
export function stripDisallowedControlCharacters(value: string, breakWith = "\n"): string {
  return value.replace(BREAK_CONTROLS, breakWith).replace(MULTILINE_DISALLOWED, "");
}

// ─── Datetimes ──────────────────────────────────────────

const DATETIME_WITH_SECONDS = z.iso.datetime();
const DATETIME_TO_THE_MINUTE = z.iso.datetime({ precision: -1 });

/**
 * An ISO 8601 UTC datetime (`…Z`) with optional seconds and fractions, as Zod
 * 3's `.datetime()` accepted. Zod 4's default requires the seconds.
 */
export function isoDateTime() {
  return z
    .string()
    .refine(
      (value) => DATETIME_WITH_SECONDS.safeParse(value).success || DATETIME_TO_THE_MINUTE.safeParse(value).success,
      "Invalid datetime",
    );
}

// ─── Numbers ────────────────────────────────────────────

/** The largest value a PostgreSQL integer column holds; positions and counts stay within it. */
export const INT32_MAX = 2_147_483_647;


// Query parameters arrive as strings. Boolean("false") is true, so coercion
// cannot be used for boolean filters.
export const QueryBooleanSchema = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(INT32_MAX).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationInput = z.infer<typeof PaginationSchema>;

export const IdParamSchema = z.object({
  id: z.string().min(1),
});
export type IdParam = z.infer<typeof IdParamSchema>;

export const SearchSchema = z.object({
  search: singleLineText().optional(),
});
export type SearchInput = z.infer<typeof SearchSchema>;

export const WorkspaceSearchSchema = z.object({
  q: singleLineText().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type WorkspaceSearchInput = z.infer<typeof WorkspaceSearchSchema>;
