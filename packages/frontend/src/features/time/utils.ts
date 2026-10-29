import { isDateOnly } from "@pm/shared";

// Week utilities — weeks start on Monday.
//
// Time entry dates are calendar dates (YYYY-MM-DD) in the user's own time
// zone. Dates here are local: build them with local fields and read them back
// with local fields, never through toISOString(), which converts to UTC and
// moves local midnight to the previous day east of UTC.

export function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function getSunday(monday: Date): Date {
  const d = new Date(monday);
  d.setDate(d.getDate() + 6);
  return d;
}

/** The local calendar date of `date` as YYYY-MM-DD. */
export function formatDateISO(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight of a YYYY-MM-DD calendar date, or null if it is not one. */
export function parseDateISO(value: string): Date | null {
  if (!isDateOnly(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function parseWeekParam(week?: string): Date {
  const d = week ? parseDateISO(week) : null;
  return getMonday(d ?? new Date());
}

export function getWeekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

export function formatShortDate(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  const day = date.getDate();
  return `${weekday} ${day}`;
}

export function formatMonthRange(monday: Date, sunday: Date): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const start = monday.toLocaleDateString("en-US", opts);
  const end = sunday.toLocaleDateString("en-US", { ...opts, year: "numeric" });
  return `${start} – ${end}`;
}

/** Get first day of current month as YYYY-MM-DD */
export function getMonthStart(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Get last day of current month as YYYY-MM-DD */
export function getMonthEnd(date: Date): string {
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return formatDateISO(last);
}
